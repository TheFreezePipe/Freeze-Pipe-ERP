-- Offer lift is planner-entered (owner decision 2026-09-10: "follow the
-- industry professionals" — SAP IBP / Dynamics style: the planner types the
-- promotion lift; the history estimate is a reference beside the field).
--
-- Consequence for the expansion view: uplift_pct and gift_units come ONLY
-- from the planner columns (expected_uplift_pct / planner_gift_units). The
-- derived_* columns stay on mkt_offers as the system estimate for post-sale
-- scoring, but never stand in for a number nobody entered.

CREATE OR REPLACE VIEW public.mkt_offer_sku_expansion
WITH (security_invoker = true) AS
SELECT o.id AS offer_id,
       s.id AS sale_id,
       s.name AS sale_name,
       s.starts_at,
       s.ends_at,
       s.annual_recurring,
       s.approval_status,
       o.scope,
       x.sku_id,
       CASE WHEN x.role = 'gift' THEN NULL ELSE COALESCE(x.percent_off, o.percent_off) END AS percent_off,
       CASE WHEN x.role = 'gift' THEN NULL ELSE COALESCE(x.dollar_off, o.dollar_off) END AS dollar_off,
       CASE WHEN x.role = 'gift' THEN NULL ELSE o.expected_uplift_pct END AS uplift_pct,
       CASE WHEN x.role = 'gift' THEN NULL ELSE COALESCE(o.effective_discount_pct, x.percent_off, o.percent_off) END AS effective_discount_pct,
       x.role,
       o.get_qty,
       o.expected_orders,
       s.early_access_starts_at,
       CASE WHEN x.role = 'gift' THEN o.planner_gift_units END AS gift_units
FROM public.mkt_offers o
JOIN public.mkt_sales s ON s.id = o.sale_id
JOIN LATERAL (
  SELECT ps.id AS sku_id, NULL::numeric AS percent_off, NULL::numeric AS dollar_off, 'member'::text AS role
    FROM public.product_skus ps
   WHERE o.scope = 'sitewide' AND ps.is_active
  UNION ALL
  SELECT ps.id, NULL::numeric, NULL::numeric, 'member'
    FROM public.product_skus ps
   WHERE o.scope = 'category' AND ps.is_active AND ps.display_category = o.category
  UNION ALL
  SELECT os.sku_id, os.percent_off, os.dollar_off, 'member'
    FROM public.mkt_offer_skus os
   WHERE o.scope = 'sku_set' AND os.offer_id = o.id
  UNION ALL
  -- the gift: one row whatever the qualifier scope is
  SELECT o.free_item_sku_id, NULL::numeric, NULL::numeric, 'gift'
   WHERE o.free_item_sku_id IS NOT NULL
) x ON true;

COMMENT ON VIEW public.mkt_offer_sku_expansion IS
  'Resolves every offer to concrete SKUs. role=member: qualifier/discounted SKU by scope (sitewide->active catalog, category->display_category, sku_set->mkt_offer_skus); uplift_pct = the planner-entered expected_uplift_pct (NULL when none was entered). role=gift: the offer''s free_item_sku_id (any scope; no discount depth; excluded from lift); gift_units = planner_gift_units (NULL when none was entered). early_access_starts_at: the sale''s EA open, when set.';

COMMENT ON COLUMN public.mkt_offers.expected_uplift_pct IS
  'Planner-entered lift % (required by the dialog). derived_lift_pct holds the history estimate shown beside it.';
COMMENT ON COLUMN public.mkt_offers.planner_gift_units IS
  'Gift units for planning = planner orders x attach x qty, or a typed cap. derived_gift_units holds the history estimate.';
