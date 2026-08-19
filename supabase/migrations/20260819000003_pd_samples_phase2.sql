-- ============================================================================
-- Product Development board — Phase 2: sample rounds + photos (plan §2.4.1)
-- ============================================================================
-- Rounds are the truth of a physical product in development. Each round:
-- requested → ETA → in hand → verdict (+ photos). Verdicts drive the China
-- loop automatically: in hand moves the card to Prototype Sent; revise /
-- rejected recycles it to China Working and opens round N+1; an approved
-- pre-production round is the golden sample (badge; the PO reference).
-- Photos live in a private Storage bucket (first Storage use in the app).
-- Gates gain their Phase-2 rules: Prototype Sent needs a received round;
-- Ready for Confirmation needs an approved verdict + at least one photo.

-- ---------------------------------------------------------------------------
-- Sample rounds
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.mkt_pd_samples (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id               uuid NOT NULL REFERENCES public.mkt_pd_projects(id) ON DELETE CASCADE,
  round_no                 int  NOT NULL CHECK (round_no > 0),
  sample_type              text NOT NULL DEFAULT 'prototype'
                             CHECK (sample_type IN ('prototype','pre_production','first_off')),
  requested_at             date NOT NULL DEFAULT current_date,
  factory_eta              date,
  tracking_no              text,
  received_at              date,
  verdict                  text CHECK (verdict IN ('approved','approved_with_changes','revise','rejected')),
  verdict_notes            text,
  verdict_by               uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  verdict_at               timestamptz,
  feedback_sent_at         date,
  factory_acknowledged_at  date,
  is_golden                boolean NOT NULL DEFAULT false,
  created_by               uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mkt_pd_samples_round_unique UNIQUE (project_id, round_no),
  CONSTRAINT mkt_pd_samples_verdict_needs_receipt CHECK (verdict IS NULL OR received_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS mkt_pd_samples_project_idx ON public.mkt_pd_samples (project_id, round_no DESC);
-- one golden per project
CREATE UNIQUE INDEX IF NOT EXISTS mkt_pd_samples_one_golden
  ON public.mkt_pd_samples (project_id) WHERE is_golden;

DROP TRIGGER IF EXISTS mkt_pd_samples_touch ON public.mkt_pd_samples;
CREATE TRIGGER mkt_pd_samples_touch BEFORE UPDATE ON public.mkt_pd_samples
  FOR EACH ROW EXECUTE FUNCTION public.mkt_touch_updated_at();

-- ---------------------------------------------------------------------------
-- Photos (metadata; bytes live in Storage bucket pd-samples)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.mkt_pd_sample_photos (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sample_id     uuid NOT NULL REFERENCES public.mkt_pd_samples(id) ON DELETE CASCADE,
  storage_path  text NOT NULL UNIQUE,       -- {project_id}/{sample_id}/{uuid}.jpg
  caption       text,
  sort_order    int  NOT NULL DEFAULT 0,
  created_by    uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mkt_pd_sample_photos_sample_idx ON public.mkt_pd_sample_photos (sample_id, sort_order);

-- ---------------------------------------------------------------------------
-- Golden sample pointer on the card (convenience for the FO / promote views)
-- ---------------------------------------------------------------------------
ALTER TABLE public.mkt_pd_projects
  ADD COLUMN IF NOT EXISTS golden_sample_id uuid REFERENCES public.mkt_pd_samples(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- RLS (same shape as the Phase-1 tables: internal read/write)
-- ---------------------------------------------------------------------------
ALTER TABLE public.mkt_pd_samples       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mkt_pd_sample_photos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS mkt_pd_samples_rw ON public.mkt_pd_samples;
CREATE POLICY mkt_pd_samples_rw ON public.mkt_pd_samples FOR ALL TO authenticated
  USING (public.jwt_is_internal()) WITH CHECK (public.jwt_is_internal());
DROP POLICY IF EXISTS mkt_pd_sample_photos_rw ON public.mkt_pd_sample_photos;
CREATE POLICY mkt_pd_sample_photos_rw ON public.mkt_pd_sample_photos FOR ALL TO authenticated
  USING (public.jwt_is_internal()) WITH CHECK (public.jwt_is_internal());

-- ---------------------------------------------------------------------------
-- Storage bucket: private; internal users read/write under their path.
-- (Bucket row insert is idempotent; policies scoped to this bucket only.)
-- ---------------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('pd-samples', 'pd-samples', false, 8388608, ARRAY['image/jpeg','image/png','image/webp'])
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS pd_samples_read ON storage.objects;
CREATE POLICY pd_samples_read ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'pd-samples' AND public.jwt_is_internal());
DROP POLICY IF EXISTS pd_samples_insert ON storage.objects;
CREATE POLICY pd_samples_insert ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'pd-samples' AND public.jwt_is_internal());
DROP POLICY IF EXISTS pd_samples_delete ON storage.objects;
CREATE POLICY pd_samples_delete ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'pd-samples' AND public.jwt_is_internal());

-- ---------------------------------------------------------------------------
-- Gate function: Phase-2 rules added (Prototype Sent needs a received round;
-- RFC needs an approved-family verdict with factory ack when "with changes",
-- plus at least one photo on that round).
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
      -- sample evidence
      IF last_rd.id IS NULL
         OR last_rd.verdict IS NULL
         OR last_rd.verdict NOT IN ('approved','approved_with_changes')
         OR (last_rd.verdict = 'approved_with_changes' AND last_rd.factory_acknowledged_at IS NULL) THEN
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

-- ---------------------------------------------------------------------------
-- Sample save: create/update a round + the auto-moves. Internal users can log
-- rounds; the auto-moves are system consequences of the data, so they bypass
-- the admin check deliberately (the verdict IS the decision, and anyone
-- logging a verdict on a received sample is acting on the China loop).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_pd_sample_save(p_project_id uuid, p_sample jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER
SET search_path TO 'public'
AS $$
DECLARE
  p         mkt_pd_projects%ROWTYPE;
  rd        mkt_pd_samples%ROWTYPE;
  v_id      uuid := nullif(p_sample->>'id','')::uuid;
  v_round   int;
  v_verdict text := nullif(p_sample->>'verdict','');
  v_moved   text := NULL;
  v_next_id uuid;
  v_verdict_set boolean := false;
BEGIN
  IF NOT public.jwt_is_internal() THEN RETURN jsonb_build_object('ok', false, 'error', 'internal_only'); END IF;
  SELECT * INTO p FROM mkt_pd_projects WHERE id = p_project_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found'); END IF;

  IF v_id IS NULL THEN
    -- new round: next number (a brand-new round can't carry a verdict)
    IF v_verdict IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'verdict_needs_receipt'); END IF;
    SELECT coalesce(max(round_no),0)+1 INTO v_round FROM mkt_pd_samples WHERE project_id = p_project_id;
    INSERT INTO mkt_pd_samples (project_id, round_no, sample_type, requested_at, factory_eta, tracking_no, created_by)
    VALUES (p_project_id, v_round,
            coalesce(nullif(p_sample->>'sample_type',''), 'prototype'),
            coalesce(nullif(p_sample->>'requested_at','')::date, current_date),
            nullif(p_sample->>'factory_eta','')::date,
            nullif(p_sample->>'tracking_no',''),
            auth.uid())
    RETURNING * INTO rd;
  ELSE
    SELECT * INTO rd FROM mkt_pd_samples WHERE id = v_id AND project_id = p_project_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'round_not_found'); END IF;
    UPDATE mkt_pd_samples SET
      sample_type             = coalesce(nullif(p_sample->>'sample_type',''), sample_type),
      requested_at            = coalesce(nullif(p_sample->>'requested_at','')::date, requested_at),
      factory_eta             = CASE WHEN p_sample ? 'factory_eta' THEN nullif(p_sample->>'factory_eta','')::date ELSE factory_eta END,
      tracking_no             = CASE WHEN p_sample ? 'tracking_no' THEN nullif(p_sample->>'tracking_no','') ELSE tracking_no END,
      received_at             = CASE WHEN p_sample ? 'received_at' THEN nullif(p_sample->>'received_at','')::date ELSE received_at END,
      feedback_sent_at        = CASE WHEN p_sample ? 'feedback_sent_at' THEN nullif(p_sample->>'feedback_sent_at','')::date ELSE feedback_sent_at END,
      factory_acknowledged_at = CASE WHEN p_sample ? 'factory_acknowledged_at' THEN nullif(p_sample->>'factory_acknowledged_at','')::date ELSE factory_acknowledged_at END,
      verdict_notes           = CASE WHEN p_sample ? 'verdict_notes' THEN nullif(p_sample->>'verdict_notes','') ELSE verdict_notes END
    WHERE id = v_id
    RETURNING * INTO rd;

    -- verdict (only set once; requires receipt)
    IF v_verdict IS NOT NULL AND rd.verdict IS NULL THEN
      IF rd.received_at IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'verdict_needs_receipt');
      END IF;
      UPDATE mkt_pd_samples SET verdict = v_verdict, verdict_by = auth.uid(), verdict_at = now()
       WHERE id = v_id RETURNING * INTO rd;
      v_verdict_set := true;
      -- approved pre-production round = golden sample
      IF v_verdict IN ('approved') AND rd.sample_type = 'pre_production' THEN
        UPDATE mkt_pd_samples SET is_golden = false WHERE project_id = p_project_id AND is_golden;
        UPDATE mkt_pd_samples SET is_golden = true WHERE id = v_id RETURNING * INTO rd;
        UPDATE mkt_pd_projects SET golden_sample_id = v_id WHERE id = p_project_id;
      END IF;
    END IF;
  END IF;

  -- Auto-move 1: first receipt while in China Working → Prototype Sent
  IF rd.received_at IS NOT NULL AND p.stage = 'china_working' THEN
    UPDATE mkt_pd_projects SET stage = 'prototype_sent', stage_entered_at = now(), sort_index = 0 WHERE id = p_project_id;
    INSERT INTO mkt_pd_stage_events (project_id, from_stage, to_stage, outcome, decided_by, meta)
    VALUES (p_project_id, 'china_working', 'prototype_sent', 'advance', auth.uid(),
            jsonb_build_object('auto', 'sample_received', 'sample_id', rd.id));
    v_moved := 'prototype_sent';
    p.stage := 'prototype_sent';
  END IF;

  -- Auto-move 2: a revise / rejected verdict logged just now → recycle to
  -- China Working + open the next round (unless a later open round exists).
  IF v_verdict_set AND rd.verdict IN ('revise','rejected') AND p.stage IN ('prototype_sent','ready_for_confirmation') THEN
    UPDATE mkt_pd_projects SET stage = 'china_working', stage_entered_at = now(), sort_index = 0 WHERE id = p_project_id;
    INSERT INTO mkt_pd_stage_events (project_id, from_stage, to_stage, outcome, reason, decided_by, meta)
    VALUES (p_project_id, p.stage, 'china_working', 'recycle',
            coalesce(rd.verdict_notes, rd.verdict || ' — round ' || rd.round_no),
            auth.uid(), jsonb_build_object('auto', 'verdict', 'sample_id', rd.id));
    SELECT id INTO v_next_id FROM mkt_pd_samples
     WHERE project_id = p_project_id AND round_no > rd.round_no AND verdict IS NULL
     ORDER BY round_no LIMIT 1;
    IF v_next_id IS NULL THEN
      SELECT coalesce(max(round_no),0)+1 INTO v_round FROM mkt_pd_samples WHERE project_id = p_project_id;
      INSERT INTO mkt_pd_samples (project_id, round_no, sample_type, requested_at, created_by)
      VALUES (p_project_id, v_round, rd.sample_type, current_date, auth.uid())
      RETURNING id INTO v_next_id;
    END IF;
    v_moved := 'china_working';
  END IF;

  RETURN jsonb_build_object('ok', true, 'sample_id', rd.id, 'round_no', rd.round_no,
                            'moved_to', v_moved, 'next_round_id', v_next_id);
END $$;

GRANT EXECUTE ON FUNCTION public.rpc_pd_sample_save(uuid, jsonb) TO authenticated;
