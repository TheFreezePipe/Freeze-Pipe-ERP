-- =============================================================
-- Migration: fix shipstation_unmatched_boxes false positives
-- =============================================================
-- The original view flagged forward shipped orders that had no
-- shipstation_box transaction. But the forward-only seed marked all
-- already-shipped orders as handled WITHOUT writing a transaction, so
-- same-day shipments (seeded, not decremented) showed up as "not in the
-- catalog" even when their box size clearly exists.
--
-- Correct definition: a dimension is "not in the catalog" only when NO box
-- material matches it (by sorted L×W×H). Key the view on catalog-match,
-- independent of whether a transaction was written or the order was seeded.
-- =============================================================

CREATE OR REPLACE VIEW public.shipstation_unmatched_boxes AS
SELECT
  k.dims_key,
  count(*)         AS shipments,
  max(s.ship_date) AS last_shipped
FROM (
  SELECT
    o.id,
    o.ship_date,
    round((o.raw_payload->'dimensions'->>'length')::numeric)::int AS l,
    round((o.raw_payload->'dimensions'->>'width')::numeric)::int  AS w,
    round((o.raw_payload->'dimensions'->>'height')::numeric)::int AS h
  FROM public.shipstation_orders o
  WHERE o.order_status = 'shipped'
    AND o.raw_payload->'dimensions'->>'length' IS NOT NULL
    AND o.raw_payload->'dimensions'->>'width'  IS NOT NULL
    AND o.raw_payload->'dimensions'->>'height' IS NOT NULL
    AND COALESCE(o.ship_date, o.order_date) >= DATE '2026-06-09'
    -- Only genuinely-uncataloged sizes: no box material matches these dims.
    AND NOT EXISTS (
      SELECT 1 FROM public.materials m
       WHERE m.dim_length_in IS NOT NULL
         AND m.dim_width_in  IS NOT NULL
         AND m.dim_height_in IS NOT NULL
         AND ARRAY(
               SELECT d FROM unnest(ARRAY[
                 round(m.dim_length_in)::int,
                 round(m.dim_width_in)::int,
                 round(m.dim_height_in)::int
               ]) AS d ORDER BY d DESC
             ) = ARRAY(
               SELECT d FROM unnest(ARRAY[
                 round((o.raw_payload->'dimensions'->>'length')::numeric)::int,
                 round((o.raw_payload->'dimensions'->>'width')::numeric)::int,
                 round((o.raw_payload->'dimensions'->>'height')::numeric)::int
               ]) AS d ORDER BY d DESC
             )
    )
) s
CROSS JOIN LATERAL (
  SELECT array_to_string(
    ARRAY(SELECT d FROM unnest(ARRAY[s.l, s.w, s.h]) AS d ORDER BY d DESC), 'x'
  ) AS dims_key
) k
GROUP BY k.dims_key
ORDER BY count(*) DESC;

GRANT SELECT ON public.shipstation_unmatched_boxes TO authenticated;
