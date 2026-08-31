-- =============================================================
-- PD samples: verdicts without receipt ("remote" approval)
-- =============================================================
-- Owner 2026-08-28: in a time crunch a round gets approved from factory
-- photos/video before (or instead of) the sample physically arriving —
-- that decision must be recordable, and recorded AS remote so an in-hand
-- sign-off and a photos-only sign-off are never confused in history.
--
--   - the verdict-needs-receipt CHECK is dropped
--   - a verdict logged while received_at is empty stamps verdict_remote
--   - a revise/rejected verdict now ALWAYS opens the next round (before,
--     only the prototype_sent/RFC recycle path did; a remote revise while
--     still in China Working previously left no round to iterate on)
--
-- Gates are unchanged: RFC still needs an approved-family verdict + a
-- photo on the newest round; Prototype Sent still means physically
-- received (a remote-approved card skips it — drag straight to RFC).

ALTER TABLE public.mkt_pd_samples DROP CONSTRAINT IF EXISTS mkt_pd_samples_verdict_needs_receipt;
ALTER TABLE public.mkt_pd_samples ADD COLUMN IF NOT EXISTS verdict_remote boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.mkt_pd_samples.verdict_remote IS
  'Verdict was logged before any receipt — decided from factory photos/video, not an in-hand sample.';

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
    IF v_verdict IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'verdict_needs_round'); END IF;
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

    -- verdict (only set once). No receipt required: a verdict logged
    -- before any receipt is recorded as remote (owner 2026-08-28).
    IF v_verdict IS NOT NULL AND rd.verdict IS NULL THEN
      UPDATE mkt_pd_samples
         SET verdict = v_verdict, verdict_by = auth.uid(), verdict_at = now(),
             verdict_remote = (rd.received_at IS NULL)
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
  -- China Working (when past it) and open the next round (unless a later
  -- open round exists). A remote revise while still in China Working
  -- doesn't move the card but still opens the next round.
  IF v_verdict_set AND rd.verdict IN ('revise','rejected') THEN
    IF p.stage IN ('prototype_sent','ready_for_confirmation') THEN
      UPDATE mkt_pd_projects SET stage = 'china_working', stage_entered_at = now(), sort_index = 0 WHERE id = p_project_id;
      INSERT INTO mkt_pd_stage_events (project_id, from_stage, to_stage, outcome, reason, decided_by, meta)
      VALUES (p_project_id, p.stage, 'china_working', 'recycle',
              coalesce(rd.verdict_notes, rd.verdict || ' — round ' || rd.round_no),
              auth.uid(), jsonb_build_object('auto', 'verdict', 'sample_id', rd.id));
      v_moved := 'china_working';
    END IF;
    IF p.stage IN ('china_working','prototype_sent','ready_for_confirmation') THEN
      SELECT id INTO v_next_id FROM mkt_pd_samples
       WHERE project_id = p_project_id AND round_no > rd.round_no AND verdict IS NULL
       ORDER BY round_no LIMIT 1;
      IF v_next_id IS NULL THEN
        SELECT coalesce(max(round_no),0)+1 INTO v_round FROM mkt_pd_samples WHERE project_id = p_project_id;
        INSERT INTO mkt_pd_samples (project_id, round_no, sample_type, requested_at, created_by)
        VALUES (p_project_id, v_round, rd.sample_type, current_date, auth.uid())
        RETURNING id INTO v_next_id;
      END IF;
    END IF;
  END IF;

  RETURN jsonb_build_object('ok', true, 'sample_id', rd.id, 'round_no', rd.round_no,
                            'moved_to', v_moved, 'next_round_id', v_next_id);
END $$;

GRANT EXECUTE ON FUNCTION public.rpc_pd_sample_save(uuid, jsonb) TO authenticated;
