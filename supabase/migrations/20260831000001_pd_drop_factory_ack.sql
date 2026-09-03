-- =============================================================
-- PD: drop the factory-ack gate; rename the confirmation stage label
-- =============================================================
-- Owner 2026-08-31: "Factory ack" (the date the factory acknowledged the
-- change requests on an approved-with-changes sample) is not part of how
-- Freeze Pipe works. An approved-with-changes verdict now counts as
-- approved outright. The column stays (harmless, unused).
--
-- Stage label: "Ready for Confirmation" → "Confirmed, Ready to Order".
-- The stage key (ready_for_confirmation) is unchanged everywhere.

UPDATE public.mkt_pd_stage_config
   SET label = 'Confirmed, Ready to Order'
 WHERE stage = 'ready_for_confirmation';

CREATE OR REPLACE FUNCTION public.fn_pd_gate_missing(p_project_id uuid, p_to_stage text)
RETURNS text[]
LANGUAGE plpgsql STABLE
SET search_path TO 'public'
AS $$
DECLARE
  p        mkt_pd_projects%ROWTYPE;
  missing  text[] := '{}';
  branded  boolean;
  last_rd  mkt_pd_samples%ROWTYPE;
  n_photos int;
BEGIN
  SELECT * INTO p FROM mkt_pd_projects WHERE id = p_project_id;
  IF NOT FOUND THEN RETURN ARRAY['project not found']; END IF;
  branded := coalesce(p.display_category, '') <> 'Accessories';
  SELECT * INTO last_rd FROM mkt_pd_samples WHERE project_id = p_project_id ORDER BY round_no DESC LIMIT 1;

  CASE p_to_stage
    WHEN 'purgatory', 'good_ideas', 'halted' THEN
      NULL;
    WHEN 'ready_to_begin' THEN
      IF p.display_category IS NULL THEN missing := array_append(missing, 'display_category'); END IF;
      IF coalesce(p.hypothesis,'') = '' THEN missing := array_append(missing, 'hypothesis'); END IF;
      IF p.target_launch_date IS NULL THEN missing := array_append(missing, 'target_launch_date'); END IF;
    WHEN 'china_working' THEN
      IF p.supplier_id IS NULL THEN missing := array_append(missing, 'supplier_id'); END IF;
      IF p.spec_sent_at IS NULL THEN missing := array_append(missing, 'spec_sent_at'); END IF;
    WHEN 'prototype_sent' THEN
      IF last_rd.id IS NULL OR last_rd.received_at IS NULL THEN
        missing := array_append(missing, 'sample_received');
      END IF;
    WHEN 'ready_for_confirmation' THEN
      IF p.quoted_unit_cost IS NULL THEN missing := array_append(missing, 'quoted_unit_cost'); END IF;
      IF p.moq_qty IS NULL THEN missing := array_append(missing, 'moq_qty'); END IF;
      IF p.quoted_lead_days IS NULL THEN missing := array_append(missing, 'quoted_lead_days'); END IF;
      IF coalesce(p.packaging,'') = '' THEN missing := array_append(missing, 'packaging'); END IF;
      IF branded THEN
        IF coalesce(p.logo_placement,'') = '' THEN missing := array_append(missing, 'logo_placement'); END IF;
        IF coalesce(p.koozie,'') = '' THEN missing := array_append(missing, 'koozie'); END IF;
        IF coalesce(p.insert_cards,'') = '' THEN missing := array_append(missing, 'insert_cards'); END IF;
      END IF;
      -- sample evidence: an approved-family verdict (remote or in hand) + a photo
      IF last_rd.id IS NULL
         OR last_rd.verdict IS NULL
         OR last_rd.verdict NOT IN ('approved','approved_with_changes') THEN
        missing := array_append(missing, 'sample_verdict');
      END IF;
      IF last_rd.id IS NOT NULL THEN
        SELECT count(*) INTO n_photos FROM mkt_pd_sample_photos WHERE sample_id = last_rd.id;
        IF n_photos = 0 THEN missing := array_append(missing, 'sample_photo'); END IF;
      ELSE
        missing := array_append(missing, 'sample_photo');
      END IF;
      IF p.msrp IS NULL THEN missing := array_append(missing, 'msrp'); END IF;
      IF p.category IS NULL THEN missing := array_append(missing, 'category'); END IF;
      IF p.carton_qty IS NULL THEN missing := array_append(missing, 'carton_qty'); END IF;
      IF NOT p.cost_basis_confirmed THEN missing := array_append(missing, 'cost_basis'); END IF;
      IF coalesce(p.sku_code,'') = '' THEN missing := array_append(missing, 'sku_code'); END IF;
      IF p.linked_sku_id IS NULL THEN missing := array_append(missing, 'product_created'); END IF;
    WHEN 'ordered' THEN
      IF p.linked_sku_id IS NULL THEN missing := array_append(missing, 'product_created'); END IF;
      IF p.linked_factory_order_id IS NULL THEN missing := array_append(missing, 'factory_order'); END IF;
    ELSE
      missing := array_append(missing, 'unknown stage ' || p_to_stage);
  END CASE;
  RETURN missing;
END $$;
