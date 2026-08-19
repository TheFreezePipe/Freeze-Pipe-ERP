-- ============================================================================
-- Product Development board — Phase 1 (plan §2.4.1, locked with owner 2026-08-19)
-- ============================================================================
-- Kanban feeder for Launches. Cards = products in development; stages are the
-- owner's eight (purgatory … ordered + halted); gates are computed from typed
-- fields by fn_pd_gate_missing and enforced inside rpc_pd_move; every move is
-- an append-only stage event; notes carry occurred_on separately from
-- created_at so back-dated notes stay honest.
--
-- Phase 1 scope: tables + config + gate fn + move/kill/archive/reorder/promote
-- RPCs. Samples/photos (Phase 2) and the Ordered-detection trigger + launch
-- drafting (Phase 3) come later; Phase 1 "Ordered" is a manual FO link.

-- ---------------------------------------------------------------------------
-- Admin check (admin-only decisions: stage moves, kills, promotion)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.jwt_is_admin()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1 FROM profiles
     WHERE id = auth.uid() AND is_active = true AND role = 'admin'
  )
$$;

-- ---------------------------------------------------------------------------
-- Stage config (expected days per stage; no WIP limits — owner decision)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.mkt_pd_stage_config (
  stage          text PRIMARY KEY,
  sort_order     int  NOT NULL,
  expected_days  int,                -- NULL for rails (purgatory/halted)
  label          text NOT NULL
);
INSERT INTO public.mkt_pd_stage_config (stage, sort_order, expected_days, label) VALUES
  ('purgatory',              0, NULL, 'Purgatory'),
  ('good_ideas',             1, 30,   'Good Ideas'),
  ('ready_to_begin',         2, 14,   'Ready to Begin'),
  ('china_working',          3, 21,   'China Working'),
  ('prototype_sent',         4, 14,   'Prototype Sent'),
  ('ready_for_confirmation', 5, 7,    'Ready for Confirmation'),
  ('ordered',                6, NULL, 'Ordered'),
  ('halted',                 7, NULL, 'Halted')
ON CONFLICT (stage) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Projects (the cards)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.mkt_pd_projects (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  text NOT NULL,
  hypothesis            text,
  stage                 text NOT NULL DEFAULT 'good_ideas'
                          REFERENCES public.mkt_pd_stage_config(stage),
  sort_index            int  NOT NULL DEFAULT 0,
  stage_entered_at      timestamptz NOT NULL DEFAULT now(),
  owner_id              uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  next_action           varchar(60),
  drop_tag              text,                       -- groups cards into one studio drop
  -- target + deadline chain input
  target_launch_date    date,
  -- product record (progressively filled; promoted into product_skus at RFC)
  display_category      text,
  category              text CHECK (category IN ('fillable','non_fillable')),
  sku_code              text,
  msrp                  numeric,                    -- target retail → committed MSRP at RFC
  carton_qty            int,
  comparable_sku_id     uuid REFERENCES public.product_skus(id) ON DELETE SET NULL,
  -- spec (packaging always; logo/koozie/inserts waived for Accessories)
  packaging             text,
  logo_placement        text,
  koozie                text,
  insert_cards          text,
  spec_sent_at          date,
  -- factory
  supplier_id           uuid REFERENCES public.suppliers(id) ON DELETE SET NULL,
  target_unit_cost      numeric,
  quoted_unit_cost      numeric,
  moq_qty               int,
  quoted_lead_days      int,
  -- confirmed cost basis for the RFC margin gate (seeded from comparable SKU,
  -- confirmed per-field; jsonb so the set can grow without migrations)
  cost_basis            jsonb,
  cost_basis_confirmed  boolean NOT NULL DEFAULT false,
  -- links filled by promotion / ordering
  linked_sku_id         uuid REFERENCES public.product_skus(id) ON DELETE SET NULL,
  linked_factory_order_id uuid REFERENCES public.factory_orders(id) ON DELETE SET NULL,
  linked_launch_id      uuid REFERENCES public.mkt_launches(id) ON DELETE SET NULL,
  promise               jsonb,                      -- snapshot at Ordered
  ordered_at            timestamptz,
  -- lifecycle
  last_reviewed_at      timestamptz,                -- purgatory clock
  archived_at           timestamptz,
  archive_reason        text,
  created_by            uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mkt_pd_projects_linked_sku_unique UNIQUE (linked_sku_id),
  CONSTRAINT mkt_pd_projects_linked_launch_unique UNIQUE (linked_launch_id)
);
CREATE INDEX IF NOT EXISTS mkt_pd_projects_stage_idx ON public.mkt_pd_projects (stage, sort_index);
CREATE INDEX IF NOT EXISTS mkt_pd_projects_sku_code_idx ON public.mkt_pd_projects (sku_code) WHERE sku_code IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Stage events (append-only)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.mkt_pd_stage_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES public.mkt_pd_projects(id) ON DELETE CASCADE,
  from_stage  text,
  to_stage    text,
  outcome     text NOT NULL CHECK (outcome IN ('advance','recycle','kill','revive','archive','link_fo')),
  reason      text,
  decided_by  uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  decided_at  timestamptz NOT NULL DEFAULT now(),
  meta        jsonb,
  CONSTRAINT mkt_pd_stage_events_reason_chk CHECK (
    outcome NOT IN ('recycle','kill','revive','archive') OR length(coalesce(reason,'')) > 0
  )
);
CREATE INDEX IF NOT EXISTS mkt_pd_stage_events_project_idx ON public.mkt_pd_stage_events (project_id, decided_at DESC);

CREATE OR REPLACE FUNCTION public.mkt_pd_events_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'mkt_pd_stage_events is append-only';
END $$;
DROP TRIGGER IF EXISTS mkt_pd_stage_events_immutable ON public.mkt_pd_stage_events;
CREATE TRIGGER mkt_pd_stage_events_immutable
  BEFORE UPDATE OR DELETE ON public.mkt_pd_stage_events
  FOR EACH ROW EXECUTE FUNCTION public.mkt_pd_events_immutable();

-- ---------------------------------------------------------------------------
-- Notes (back-datable: occurred_on is the date the note is ABOUT)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.mkt_pd_notes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES public.mkt_pd_projects(id) ON DELETE CASCADE,
  body         text NOT NULL CHECK (length(body) > 0),
  occurred_on  date NOT NULL DEFAULT current_date,
  created_by   uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mkt_pd_notes_not_future CHECK (occurred_on <= current_date)
);
CREATE INDEX IF NOT EXISTS mkt_pd_notes_project_idx ON public.mkt_pd_notes (project_id, occurred_on DESC);

-- ---------------------------------------------------------------------------
-- Launch ↔ card link (the plan's genealogy seam)
-- ---------------------------------------------------------------------------
ALTER TABLE public.mkt_launches
  ADD COLUMN IF NOT EXISTS pd_project_id uuid REFERENCES public.mkt_pd_projects(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- updated_at touch (reuse the marketing trigger fn)
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS mkt_pd_projects_touch ON public.mkt_pd_projects;
CREATE TRIGGER mkt_pd_projects_touch BEFORE UPDATE ON public.mkt_pd_projects
  FOR EACH ROW EXECUTE FUNCTION public.mkt_touch_updated_at();

-- ---------------------------------------------------------------------------
-- RLS: read = authenticated internal; field edits + notes = internal; stage
-- decisions go through admin-checked RPCs (the RPCs are SECURITY INVOKER, so
-- the table policy must allow the UPDATE; the admin check lives in the RPC).
-- ---------------------------------------------------------------------------
ALTER TABLE public.mkt_pd_projects     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mkt_pd_stage_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mkt_pd_notes        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mkt_pd_stage_config ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS mkt_pd_projects_read ON public.mkt_pd_projects;
CREATE POLICY mkt_pd_projects_read ON public.mkt_pd_projects FOR SELECT TO authenticated USING (public.jwt_is_internal());
DROP POLICY IF EXISTS mkt_pd_projects_write ON public.mkt_pd_projects;
CREATE POLICY mkt_pd_projects_write ON public.mkt_pd_projects FOR ALL TO authenticated
  USING (public.jwt_is_internal()) WITH CHECK (public.jwt_is_internal());

DROP POLICY IF EXISTS mkt_pd_stage_events_read ON public.mkt_pd_stage_events;
CREATE POLICY mkt_pd_stage_events_read ON public.mkt_pd_stage_events FOR SELECT TO authenticated USING (public.jwt_is_internal());
DROP POLICY IF EXISTS mkt_pd_stage_events_insert ON public.mkt_pd_stage_events;
CREATE POLICY mkt_pd_stage_events_insert ON public.mkt_pd_stage_events FOR INSERT TO authenticated WITH CHECK (public.jwt_is_internal());

DROP POLICY IF EXISTS mkt_pd_notes_read ON public.mkt_pd_notes;
CREATE POLICY mkt_pd_notes_read ON public.mkt_pd_notes FOR SELECT TO authenticated USING (public.jwt_is_internal());
DROP POLICY IF EXISTS mkt_pd_notes_insert ON public.mkt_pd_notes;
CREATE POLICY mkt_pd_notes_insert ON public.mkt_pd_notes FOR INSERT TO authenticated WITH CHECK (public.jwt_is_internal());

DROP POLICY IF EXISTS mkt_pd_stage_config_read ON public.mkt_pd_stage_config;
CREATE POLICY mkt_pd_stage_config_read ON public.mkt_pd_stage_config FOR SELECT TO authenticated USING (true);

-- ---------------------------------------------------------------------------
-- Gate function: what's missing to move a card INTO p_to_stage. Single source
-- of truth — the UI renders red fields from the same list.
-- ---------------------------------------------------------------------------
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
      NULL; -- no gate
    WHEN 'ready_to_begin' THEN
      IF p.owner_id IS NULL THEN missing := array_append(missing, 'owner'); END IF;
      IF p.display_category IS NULL THEN missing := array_append(missing, 'display_category'); END IF;
      IF coalesce(p.hypothesis,'') = '' THEN missing := array_append(missing, 'hypothesis'); END IF;
      IF p.target_launch_date IS NULL THEN missing := array_append(missing, 'target_launch_date'); END IF;
    WHEN 'china_working' THEN
      IF p.supplier_id IS NULL THEN missing := array_append(missing, 'supplier_id'); END IF;
      IF p.target_unit_cost IS NULL THEN missing := array_append(missing, 'target_unit_cost'); END IF;
      IF p.msrp IS NULL THEN missing := array_append(missing, 'msrp'); END IF;
      IF p.spec_sent_at IS NULL THEN missing := array_append(missing, 'spec_sent_at'); END IF;
    WHEN 'prototype_sent' THEN
      NULL; -- Phase 2: requires a sample round received; Phase 1 = manual
    WHEN 'ready_for_confirmation' THEN
      -- factory
      IF p.quoted_unit_cost IS NULL THEN missing := array_append(missing, 'quoted_unit_cost'); END IF;
      IF p.moq_qty IS NULL THEN missing := array_append(missing, 'moq_qty'); END IF;
      IF p.quoted_lead_days IS NULL THEN missing := array_append(missing, 'quoted_lead_days'); END IF;
      -- spec
      IF coalesce(p.packaging,'') = '' THEN missing := array_append(missing, 'packaging'); END IF;
      IF branded THEN
        IF coalesce(p.logo_placement,'') = '' THEN missing := array_append(missing, 'logo_placement'); END IF;
        IF coalesce(p.koozie,'') = '' THEN missing := array_append(missing, 'koozie'); END IF;
        IF coalesce(p.insert_cards,'') = '' THEN missing := array_append(missing, 'insert_cards'); END IF;
      END IF;
      -- MSRP + confirmed cost basis (margin decided before ordering)
      IF p.msrp IS NULL THEN missing := array_append(missing, 'msrp'); END IF;
      IF p.category IS NULL THEN missing := array_append(missing, 'category'); END IF;
      IF p.carton_qty IS NULL THEN missing := array_append(missing, 'carton_qty'); END IF;
      IF NOT p.cost_basis_confirmed THEN missing := array_append(missing, 'cost_basis'); END IF;
      -- the product itself (promotion happens inside the move)
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

-- ---------------------------------------------------------------------------
-- Move (advance / recycle), kill, revive, archive — admin only
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_pd_move(
  p_project_id uuid, p_to_stage text, p_reason text DEFAULT NULL, p_override jsonb DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER
SET search_path TO 'public'
AS $$
DECLARE
  p        mkt_pd_projects%ROWTYPE;
  v_from   int; v_to int;
  v_out    text;
  v_miss   text[];
BEGIN
  IF NOT public.jwt_is_admin() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'admin_only');
  END IF;
  SELECT * INTO p FROM mkt_pd_projects WHERE id = p_project_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found'); END IF;
  IF p.stage = p_to_stage THEN RETURN jsonb_build_object('ok', true, 'noop', true); END IF;
  IF p_to_stage IN ('halted') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'use_rpc_pd_kill');
  END IF;

  SELECT sort_order INTO v_from FROM mkt_pd_stage_config WHERE stage = p.stage;
  SELECT sort_order INTO v_to   FROM mkt_pd_stage_config WHERE stage = p_to_stage;
  IF v_to IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'unknown_stage'); END IF;

  IF p.stage = 'halted' THEN
    v_out := 'revive';
  ELSIF v_to > v_from THEN
    v_out := 'advance';
  ELSE
    v_out := 'recycle';
  END IF;

  IF v_out IN ('recycle','revive') AND coalesce(p_reason,'') = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'reason_required');
  END IF;

  IF v_out = 'advance' THEN
    v_miss := public.fn_pd_gate_missing(p_project_id, p_to_stage);
    IF array_length(v_miss, 1) > 0 THEN
      RETURN jsonb_build_object('ok', false, 'error', 'gate_blocked', 'missing', to_jsonb(v_miss));
    END IF;
  END IF;

  UPDATE mkt_pd_projects
     SET stage = p_to_stage,
         stage_entered_at = now(),
         sort_index = 0,
         archived_at = CASE WHEN p_to_stage <> 'purgatory' THEN NULL ELSE archived_at END
   WHERE id = p_project_id;

  INSERT INTO mkt_pd_stage_events (project_id, from_stage, to_stage, outcome, reason, decided_by, meta)
  VALUES (p_project_id, p.stage, p_to_stage, v_out, nullif(p_reason,''), auth.uid(), p_override);

  RETURN jsonb_build_object('ok', true, 'outcome', v_out, 'from', p.stage, 'to', p_to_stage);
END $$;

CREATE OR REPLACE FUNCTION public.rpc_pd_kill(p_project_id uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER
SET search_path TO 'public'
AS $$
DECLARE p mkt_pd_projects%ROWTYPE;
BEGIN
  IF NOT public.jwt_is_admin() THEN RETURN jsonb_build_object('ok', false, 'error', 'admin_only'); END IF;
  IF coalesce(p_reason,'') = '' THEN RETURN jsonb_build_object('ok', false, 'error', 'reason_required'); END IF;
  SELECT * INTO p FROM mkt_pd_projects WHERE id = p_project_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found'); END IF;
  IF p.stage = 'halted' THEN RETURN jsonb_build_object('ok', true, 'noop', true); END IF;
  UPDATE mkt_pd_projects SET stage = 'halted', stage_entered_at = now() WHERE id = p_project_id;
  INSERT INTO mkt_pd_stage_events (project_id, from_stage, to_stage, outcome, reason, decided_by)
  VALUES (p_project_id, p.stage, 'halted', 'kill', p_reason, auth.uid());
  RETURN jsonb_build_object('ok', true);
END $$;

-- Purgatory-only exit for "logged, never worked" ideas (keeps Halted honest)
CREATE OR REPLACE FUNCTION public.rpc_pd_archive(p_project_id uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER
SET search_path TO 'public'
AS $$
DECLARE p mkt_pd_projects%ROWTYPE;
BEGIN
  IF NOT public.jwt_is_admin() THEN RETURN jsonb_build_object('ok', false, 'error', 'admin_only'); END IF;
  IF coalesce(p_reason,'') = '' THEN RETURN jsonb_build_object('ok', false, 'error', 'reason_required'); END IF;
  SELECT * INTO p FROM mkt_pd_projects WHERE id = p_project_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found'); END IF;
  IF p.stage <> 'purgatory' THEN RETURN jsonb_build_object('ok', false, 'error', 'archive_is_purgatory_only'); END IF;
  UPDATE mkt_pd_projects SET archived_at = now(), archive_reason = p_reason WHERE id = p_project_id;
  INSERT INTO mkt_pd_stage_events (project_id, from_stage, to_stage, outcome, reason, decided_by)
  VALUES (p_project_id, 'purgatory', NULL, 'archive', p_reason, auth.uid());
  RETURN jsonb_build_object('ok', true);
END $$;

-- Within-lane ordering
CREATE OR REPLACE FUNCTION public.rpc_pd_reorder(p_project_id uuid, p_sort_index int)
RETURNS void
LANGUAGE sql SECURITY INVOKER
SET search_path TO 'public'
AS $$
  UPDATE mkt_pd_projects SET sort_index = p_sort_index WHERE id = p_project_id;
$$;

-- Phase 1 Ordered: manual link to an existing factory order (the detection
-- trigger replaces this in Phase 3). Snapshots the promise.
CREATE OR REPLACE FUNCTION public.rpc_pd_link_factory_order(p_project_id uuid, p_factory_order_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER
SET search_path TO 'public'
AS $$
DECLARE p mkt_pd_projects%ROWTYPE;
BEGIN
  IF NOT public.jwt_is_admin() THEN RETURN jsonb_build_object('ok', false, 'error', 'admin_only'); END IF;
  SELECT * INTO p FROM mkt_pd_projects WHERE id = p_project_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found'); END IF;
  IF p.linked_sku_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'product_not_created'); END IF;
  IF NOT EXISTS (SELECT 1 FROM factory_orders WHERE id = p_factory_order_id) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'factory_order_not_found');
  END IF;
  UPDATE mkt_pd_projects
     SET linked_factory_order_id = p_factory_order_id,
         stage = 'ordered', stage_entered_at = now(), ordered_at = now(),
         promise = jsonb_build_object(
           'target_launch_date', p.target_launch_date,
           'msrp', p.msrp, 'quoted_unit_cost', p.quoted_unit_cost,
           'moq_qty', p.moq_qty, 'ordered_at', now())
   WHERE id = p_project_id;
  INSERT INTO mkt_pd_stage_events (project_id, from_stage, to_stage, outcome, decided_by, meta)
  VALUES (p_project_id, p.stage, 'ordered', 'link_fo', auth.uid(),
          jsonb_build_object('factory_order_id', p_factory_order_id));
  RETURN jsonb_build_object('ok', true);
END $$;

-- ---------------------------------------------------------------------------
-- Promotion: card → product_skus + sku_economics, in one transaction.
-- Called from the RFC move sheet after the SKU Costs dialog collected the
-- product fields. Admin only. Idempotent on linked_sku_id.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_pd_promote_product(p_project_id uuid, p_product jsonb)
RETURNS jsonb
-- SECURITY DEFINER: writes product_skus + sku_economics + audit_logs in one
-- transaction; the admin gate is jwt_is_admin() on the first line.
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  p        mkt_pd_projects%ROWTYPE;
  v_sku_id uuid;
  cb       jsonb;
  v_supplier_code text;
BEGIN
  IF NOT public.jwt_is_admin() THEN RETURN jsonb_build_object('ok', false, 'error', 'admin_only'); END IF;
  SELECT * INTO p FROM mkt_pd_projects WHERE id = p_project_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found'); END IF;
  IF p.linked_sku_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'sku_id', p.linked_sku_id, 'already', true);
  END IF;
  IF NOT p.cost_basis_confirmed OR p.msrp IS NULL OR p.quoted_unit_cost IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'margin_not_confirmed');
  END IF;
  IF coalesce(p_product->>'sku','') = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'sku_required');
  END IF;
  IF EXISTS (SELECT 1 FROM product_skus WHERE sku = p_product->>'sku') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'sku_exists');
  END IF;

  INSERT INTO product_skus (sku, product_name, category, display_category, retail_price,
                            standard_quantity_per_carton, upc_code, abc_classification,
                            monthly_demand, is_active)
  VALUES (p_product->>'sku',
          coalesce(p_product->>'product_name', p.name),
          coalesce(p_product->>'category', p.category, 'non_fillable'),
          coalesce(p_product->>'display_category', p.display_category),
          coalesce((p_product->>'retail_price')::numeric, p.msrp),
          coalesce((p_product->>'standard_quantity_per_carton')::int, p.carton_qty),
          nullif(p_product->>'upc_code',''),
          nullif(p_product->>'abc_classification',''),
          nullif(p_product->>'monthly_demand','')::int,
          false)  -- inactive until arrival (owner decision)
  RETURNING id INTO v_sku_id;

  -- economics row from the confirmed cost basis; raw cost lands on the
  -- supplier that quoted it
  cb := coalesce(p.cost_basis, '{}'::jsonb);
  SELECT code INTO v_supplier_code FROM suppliers WHERE id = p.supplier_id;
  INSERT INTO sku_economics (sku_id,
      pct_from_nancy, pct_from_yx, nancy_raw_cost, yx_raw_cost,
      pct_sea, pct_air, sea_freight_cost_per_unit, air_freight_cost_per_unit,
      glycerin_cost_us, labor_cost_us, packing_material_cost, packing_labor_cost,
      shipping_cost, credit_card_fees, pct_manufactured_us, pct_manufactured_cn)
  VALUES (v_sku_id,
      CASE WHEN v_supplier_code = 'NANCY' THEN 100 ELSE 0 END,
      CASE WHEN v_supplier_code = 'YX'    THEN 100 ELSE 0 END,
      CASE WHEN v_supplier_code = 'NANCY' THEN p.quoted_unit_cost ELSE 0 END,
      CASE WHEN v_supplier_code = 'YX'    THEN p.quoted_unit_cost ELSE 0 END,
      coalesce((cb->>'pct_sea')::numeric, 100), coalesce((cb->>'pct_air')::numeric, 0),
      coalesce((cb->>'sea_freight_cost_per_unit')::numeric, 0), coalesce((cb->>'air_freight_cost_per_unit')::numeric, 0),
      coalesce((cb->>'glycerin_cost_us')::numeric, 0), coalesce((cb->>'labor_cost_us')::numeric, 0),
      coalesce((cb->>'packing_material_cost')::numeric, 0), coalesce((cb->>'packing_labor_cost')::numeric, 0),
      coalesce((cb->>'shipping_cost')::numeric, 0), coalesce((cb->>'credit_card_fees')::numeric, 0),
      100, 0);

  UPDATE mkt_pd_projects SET linked_sku_id = v_sku_id, sku_code = p_product->>'sku' WHERE id = p_project_id;
  INSERT INTO audit_logs (actor_id, action, target_table, target_id, details)
  VALUES (auth.uid(), 'pd.product_promoted', 'product_skus', v_sku_id,
          jsonb_build_object('project_id', p_project_id, 'sku', p_product->>'sku'));
  RETURN jsonb_build_object('ok', true, 'sku_id', v_sku_id);
END $$;

GRANT EXECUTE ON FUNCTION public.fn_pd_gate_missing(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_pd_move(uuid, text, text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_pd_kill(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_pd_archive(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_pd_reorder(uuid, int) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_pd_link_factory_order(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_pd_promote_product(uuid, jsonb) TO authenticated;
