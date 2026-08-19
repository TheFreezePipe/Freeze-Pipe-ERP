-- Owner review 2026-08-19: (1) an Owner field is noise for a three-person PD
-- team — drop it from the Good Ideas → Ready to Begin gate (column stays;
-- created_by still records who made the card); (2) MSRP is NOT a prerequisite
-- for China Working — it is decided at Ready for Confirmation with the margin;
-- (3) target cost removed altogether (the quote is the number that matters).
-- Mirrors src/lib/marketing/pd.ts.
CREATE OR REPLACE FUNCTION public.fn_pd_gate_missing(p_project_id uuid, p_to_stage text)
RETURNS text[]
LANGUAGE plpgsql STABLE
SET search_path TO 'public'
AS $$
DECLARE
  p        mkt_pd_projects%ROWTYPE;
  missing  text[] := '{}';
  branded  boolean;
BEGIN
  SELECT * INTO p FROM mkt_pd_projects WHERE id = p_project_id;
  IF NOT FOUND THEN RETURN ARRAY['project not found']; END IF;
  branded := coalesce(p.display_category, '') <> 'Accessories';

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
      NULL;
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
