-- ============================================================================
-- Launches: one product, one row (migration B of the 2026-09-30 plan)
-- ============================================================================
-- INCIDENT (2026-09-29, "Northern Lights Studio drop", launch 308629af).
-- The owner built the launch in the launch form by picking three SKUs
-- (S04-BW20DNA, S04-NB2, S04-NB6, limited 300/200/200). The form sends every
-- SKU pick as a PLAIN member (pd_project_id null) and rpc_save_launch never
-- asked whether a product-development card owns the SKU, so three plain rows
-- were written. Fifteen minutes later the PD board's "Attach to launch" sent
-- the drop's two board cards - "Q4 Studio - BW20" (HALTED since 08-20) and
-- "Q4 Studio - BW20DNA" (ordered) - to rpc_pd_attach_launch, which accepted
-- any stage: BW20DNA claimed its plain row (rule b), but BW20 got a fourth,
-- SKU-less planned row. NB2 and NB6 never attached because their cards had
-- been archived on 09-22 by the first-receipt arrival rule (2 samples of 200;
-- fixed by 20260930000001) and archived cards are not on the board. Result:
-- four rows for three products, a halted product counted everywhere, two
-- ordered products with no link to their cards, and no Activity entry for
-- the attach that moved BW20DNA's target from 11-05 to 11-16.
--
-- OWNER DECISIONS 2026-09-30: (1) the arrival rule shipped (migration A);
-- (2) NB2 and NB6 are restored to Ordered and attached to the launch (the
-- cleanup script, run separately); (3) stopping (halting) a card removes it
-- from its launch and deletes its product line; (4) products are judged by
-- sea timing.
--
-- RULES IMPLEMENTED HERE (server side only; the UI follows separately)
--
-- R1 One product, one row. rpc_save_launch:
--    * members may carry pd_project_id (the new form sends it for a SKU pick
--      that belongs to a card); step (0) attaches those cards as before;
--    * BACKSTOP: after the plain-SKU upsert, every plain SKU row whose SKU is
--      NEW to the launch in this save (it had no row, card or plain, before
--      the save) is linked to its card when that card is NOT archived and NOT
--      halted, is unattached or already on this launch, is not named in
--      detach_pd_project_ids, and has never been removed from this launch
--      (no 'launch_moved' event via detach/halt/form/revive for this launch).
--      The link goes through rpc_pd_attach_launch (rule b claims the row, the
--      card's date follows the launch, an Activity event is written).
--      mkt_pd_projects_linked_sku_unique guarantees at most one card per SKU.
--      Archived cards are never auto-linked: a restock launch of an old SKU
--      stays a plain row.
--    * p_launch->'detach_pd_project_ids' (the X on a card row in the form) is
--      processed LAST through the unified detach rule (via 'form'), so a
--      detached card's SKU cannot be re-linked by the backstop on the same
--      save (its SKU was on the launch before the save, so it is not NEW).
--    * the rev-3 legacy handling stays: a planned-name entry that repeats a
--      card row's name updates that row; legacy rename in place unchanged.
--
-- R2 rpc_pd_attach_launch:
--    * cards in stage 'halted' are skipped and returned as
--      skipped:[{id, name, reason:'halted'}] (attached count excludes them);
--    * archived cards MAY attach: their member row is claimed/inserted and
--      the card gets linked_launch_id only - target_launch_date and
--      launch_date_override are left untouched, and the card's factory order
--      is NOT copied onto the row (an old arrived card attached to a restock
--      would otherwise make the restock look ordered);
--    * every card whose linked_launch_id or target_launch_date changed gets a
--      mkt_pd_stage_events row: from=to=stage, outcome 'launch_moved', meta
--      {launch_id, old_date, new_date, via:'attach', from_launch_id?, member};
--    * rows the card still holds on other launches: deleted unless they have
--      actuals (then kept as plain rows) - the unified rule, no FO exception.
--
-- R3 Unified detach: fn_pd_detach_member(card, launch, via) clears the card's
--    linked_launch_id and override, DELETES its member row(s) unless a row
--    has actuals (actual_first_30d_units or sold_out_at set), in which case
--    the row stays as a plain row (pd_project_id NULL, factory_order_id
--    kept), and writes one 'launch_moved' event with old_date = new_date and
--    meta.via. launch NULL means "wherever the card is". Used by
--    rpc_pd_detach_launch (via 'detach'), rpc_save_launch for
--    detach_pd_project_ids (via 'form') and rpc_pd_move when a halted card
--    that is still attached (pre-migration state) is revived (via 'revive',
--    see R8). The row rule itself lives in fn_pd_release_member_rows so the
--    halt trigger below applies the identical rule.
--    HALT is enforced by a trigger, not only by rpc_pd_kill: RLS lets every
--    internal user write mkt_pd_projects.stage directly, so
--    trg_pd_halt_detaches (BEFORE UPDATE OF stage, WHEN the card enters
--    'halted') clears linked_launch_id/override on NEW, releases the member
--    rows through fn_pd_release_member_rows and writes the 'launch_moved'
--    event via 'halt' (from=to='halted', old_date = new_date). rpc_pd_kill
--    therefore only sets the stage (after writing its 'kill' event) and
--    reports what the trigger did from the card's pre-halt state. A halted
--    card is never on a launch, whoever wrote the stage.
--    Why the FO exception went: a kept plain row keeps the product counted
--    on the launch, which is exactly the incident.
--
-- R4 Guards. fn_pd_launch_date_guard: an archived card is frozen on every
--    UPDATE whether or not it is attached - NEW.target_launch_date := OLD
--    and NEW.launch_date_override := OLD (so a direct write cannot leave an
--    archived card reading "overridden" while its date cannot move) - and
--    the "unattached => override false" rule still runs after the freeze, so
--    ON DELETE SET NULL from a deleted launch passes
--    mkt_pd_projects_override_needs_launch even for an archived, overridden
--    card. fn_pd_follow_launch: archived and halted cards never move with the
--    launch; meta.via = 'follow'. rpc_pd_set_launch_override (the card
--    sheet's "own date / launch date" switch) refuses archived cards with
--    {ok:false, error:'archived'} and writes a 'launch_moved' event via
--    'override' (meta.override = the new flag) whenever the date or the flag
--    changed, so the Activity feed covers date changes made from the card.
--
-- R5 rpc_pd_link_sku(p_project_id, p_sku_id): admin/manager. Links a card
--    that has no linked_sku_id to an EXISTING SKU (refused when another card
--    owns the SKU - the unique constraint - or the SKU does not exist), sets
--    sku_code. If the card is attached and its launch carries a plain row for
--    that SKU, the two merge: the plain row becomes the card's row (its
--    planner inputs win; the card's placeholder fills the blanks) and the
--    placeholder is removed. Otherwise the card's placeholder takes the SKU.
--    Writes one event, outcome 'link_sku' (CHECK widened below), meta
--    {sku_id, sku, launch_id, merged_member_id, member}.
--
-- R6 rpc_pd_mark_arrived(p_project_id, p_note): admin/manager. An Ordered,
--    unarchived card is archived as arrived by hand: archived_at now(),
--    archive_reason 'arrived', event outcome 'archive' reason 'arrived' meta
--    {manual:true, note}. The launch link, date and override are untouched.
--
-- R7 rpc_daily_report: the launch "sku_count" is member rows minus rows whose
--    card is halted (the one definition of "product"). Everything else in
--    the report is verbatim.
--
-- R8 Reviving a halted card (rpc_pd_move from 'halted') brings it back
--    UNATTACHED. Today's code left linked_launch_id alone; since halting now
--    detaches, only cards halted before this migration can still be attached
--    while halted - those are detached on revive (via 'revive').
--
-- Also: the stage-event outcome CHECK gains 'link_sku' (every existing value
-- kept). A small event writer, fn_pd_launch_moved_event, keeps the meta
-- shape identical across attach / detach / halt / follow / override.
--
-- Owners, SECURITY DEFINER/INVOKER and search_path of every replaced function
-- are preserved (all owned by postgres; rpc_daily_report and
-- fn_pd_follow_launch are SECURITY DEFINER, the RPCs and the guards are
-- SECURITY INVOKER so RLS still applies underneath the explicit checks);
-- grants are restated. The only trigger DDL is one CREATE OR REPLACE TRIGGER
-- (trg_pd_halt_detaches, new; PostgreSQL 14+ syntax, live is 17); the two
-- existing triggers are untouched and nothing is dropped. The file applies
-- twice without error. lock_timeout makes the brief constraint swap and the
-- trigger creation fail fast instead of queueing behind live traffic.
--
-- KNOWN GAPS, left alone on purpose:
--   * rpc_daily_report keeps its live ACL (EXECUTE for anon, authenticated,
--     service_role - Supabase's default privileges; the only caller is the
--     daily-report edge function with the service-role key). Tightening it
--     is a separate decision: 20260930000003_daily_report_grants.sql revokes
--     anon/authenticated/PUBLIC and is applied on its own go, after this file,
--     so a re-run of this file cannot re-grant them.
--   * RLS (mkt_pd_projects_write = jwt_is_internal()) still lets a non-admin
--     internal user write stage directly, bypassing rpc_pd_kill's admin gate.
--     The halt trigger makes such a write detach correctly; the gate itself
--     is pre-existing RLS posture and not changed here.
-- ============================================================================

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 0. Outcome vocabulary: every existing value + 'link_sku'
-- ---------------------------------------------------------------------------
ALTER TABLE public.mkt_pd_stage_events DROP CONSTRAINT IF EXISTS mkt_pd_stage_events_outcome_check;
ALTER TABLE public.mkt_pd_stage_events ADD CONSTRAINT mkt_pd_stage_events_outcome_check
  CHECK (outcome = ANY (ARRAY['advance'::text, 'recycle'::text, 'kill'::text, 'revive'::text,
                              'archive'::text, 'link_fo'::text, 'launch_moved'::text, 'restore'::text,
                              'link_sku'::text]));

-- ---------------------------------------------------------------------------
-- 1. Event writer: one meta shape for every launch link change
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_pd_launch_moved_event(
  p_project_id uuid, p_stage text, p_launch_id uuid,
  p_old_date date, p_new_date date, p_via text, p_extra jsonb DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql SECURITY INVOKER
SET search_path TO 'public'
AS $$
DECLARE v_id uuid;
BEGIN
  INSERT INTO mkt_pd_stage_events (project_id, from_stage, to_stage, outcome, decided_by, meta)
  VALUES (p_project_id, p_stage, p_stage, 'launch_moved',
          COALESCE(auth.uid(), '00000000-0000-0000-0000-000000000001'::uuid),
          jsonb_build_object('launch_id', p_launch_id,
                             'old_date',  p_old_date,
                             'new_date',  p_new_date,
                             'via',       p_via)
          || COALESCE(p_extra, '{}'::jsonb))
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Unified detach rule (R3)
-- ---------------------------------------------------------------------------
-- 2a. The row rule on its own: the card's member rows on the named launch
--     (everywhere when none is named) are deleted unless they carry actuals,
--     then kept as plain rows. No gate here (RLS already governs the caller;
--     the halt trigger runs it for postgres/service_role writers too).
--     Returns {deleted, released, launch_id, member}.
CREATE OR REPLACE FUNCTION public.fn_pd_release_member_rows(p_project_id uuid, p_launch_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER
SET search_path TO 'public'
AS $$
DECLARE
  v_del    int := 0;
  v_rel    int := 0;
  v_del_l  uuid[];
  v_rel_l  uuid[];
BEGIN
  WITH d AS (
    DELETE FROM mkt_launch_skus
     WHERE pd_project_id = p_project_id
       AND (p_launch_id IS NULL OR launch_id = p_launch_id)
       AND actual_first_30d_units IS NULL AND sold_out_at IS NULL
    RETURNING launch_id)
  SELECT count(*), array_agg(launch_id) INTO v_del, v_del_l FROM d;
  WITH r AS (
    UPDATE mkt_launch_skus SET pd_project_id = NULL
     WHERE pd_project_id = p_project_id
       AND (p_launch_id IS NULL OR launch_id = p_launch_id)
    RETURNING launch_id)
  SELECT count(*), array_agg(launch_id) INTO v_rel, v_rel_l FROM r;

  RETURN jsonb_build_object('deleted', v_del, 'released', v_rel,
                            'launch_id', COALESCE(p_launch_id, v_del_l[1], v_rel_l[1]),
                            'member', CASE WHEN v_del > 0 THEN 'deleted'
                                           WHEN v_rel > 0 THEN 'released'
                                           ELSE 'none' END);
END $$;

-- 2b. The full rule for a card that is not being halted right now.
CREATE OR REPLACE FUNCTION public.fn_pd_detach_member(p_project_id uuid, p_launch_id uuid, p_via text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER
SET search_path TO 'public'
AS $$
DECLARE
  p            mkt_pd_projects%ROWTYPE;
  v_cleared    boolean := false;
  v_rows       jsonb;
  v_event_l    uuid;
  v_event_id   uuid;
BEGIN
  IF NOT public.jwt_is_internal() THEN
    RAISE EXCEPTION 'internal_only';
  END IF;
  SELECT * INTO p FROM mkt_pd_projects WHERE id = p_project_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found'); END IF;

  -- the card keeps its current date as its own; the guard forces override off
  IF p.linked_launch_id IS NOT NULL
     AND (p_launch_id IS NULL OR p.linked_launch_id = p_launch_id) THEN
    UPDATE mkt_pd_projects
       SET linked_launch_id = NULL, launch_date_override = false
     WHERE id = p_project_id;
    v_cleared := true;
  END IF;

  v_rows := public.fn_pd_release_member_rows(p_project_id, p_launch_id);

  IF v_cleared OR (v_rows->>'deleted')::int + (v_rows->>'released')::int > 0 THEN
    v_event_l := COALESCE(CASE WHEN v_cleared THEN p.linked_launch_id END,
                          (v_rows->>'launch_id')::uuid);
    v_event_id := public.fn_pd_launch_moved_event(
      p_project_id, p.stage, v_event_l, p.target_launch_date, p.target_launch_date, p_via,
      jsonb_build_object('member', v_rows->>'member'));
  END IF;

  RETURN jsonb_build_object('ok', true,
                            'launch_id', v_event_l,
                            'target_launch_date', p.target_launch_date,
                            'unlinked', v_cleared,
                            'member', v_rows->>'member',
                            'event_id', v_event_id);
END $$;

-- 2c. Halt trigger: a card entering 'halted' leaves its launch, whoever
--     writes the stage (rpc_pd_kill or a direct UPDATE allowed by RLS). NEW
--     is edited in place (an UPDATE of the same row from a BEFORE trigger is
--     an error in PostgreSQL), the rows go through 2a, and the event is the
--     same 'launch_moved' via 'halt' as before: from=to='halted', old_date =
--     new_date, meta.member. Nothing happens for a card that is not on a
--     launch. Setting NEW.launch_date_override := false here is required:
--     trg_pd_launch_date_guard does not fire for an UPDATE that lists only
--     stage, and the CHECK needs override off once linked_launch_id is NULL.
CREATE OR REPLACE FUNCTION public.fn_pd_halt_detaches()
RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER
SET search_path TO 'public'
AS $$
DECLARE
  v_rows jsonb;
BEGIN
  IF OLD.linked_launch_id IS NULL
     AND NOT EXISTS (SELECT 1 FROM mkt_launch_skus WHERE pd_project_id = NEW.id) THEN
    RETURN NEW;
  END IF;
  NEW.linked_launch_id     := NULL;
  NEW.launch_date_override := false;
  v_rows := public.fn_pd_release_member_rows(NEW.id, NULL);
  PERFORM public.fn_pd_launch_moved_event(
    NEW.id, NEW.stage,
    COALESCE(OLD.linked_launch_id, (v_rows->>'launch_id')::uuid),
    OLD.target_launch_date, OLD.target_launch_date, 'halt',
    jsonb_build_object('member', v_rows->>'member'));
  RETURN NEW;
END $$;

CREATE OR REPLACE TRIGGER trg_pd_halt_detaches
  BEFORE UPDATE OF stage ON public.mkt_pd_projects
  FOR EACH ROW
  WHEN (NEW.stage = 'halted' AND OLD.stage IS DISTINCT FROM 'halted')
  EXECUTE FUNCTION public.fn_pd_halt_detaches();

-- ---------------------------------------------------------------------------
-- 3. Date guard (R4): archived cards are frozen, unattached => override off
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_pd_launch_date_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_l date;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.archived_at IS NOT NULL THEN
    -- archived (arrived): date and override flag are frozen whatever the
    -- writer sent, attached or not. The link itself may still change
    -- (attach / detach / launch deleted).
    NEW.target_launch_date   := OLD.target_launch_date;
    NEW.launch_date_override := OLD.launch_date_override;
  END IF;

  IF NEW.linked_launch_id IS NULL THEN
    -- unattached: override is meaningless. This runs for archived cards too
    -- (after the freeze), so a launch DELETE (FK ON DELETE SET NULL) passes
    -- the CHECK.
    NEW.launch_date_override := false;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.archived_at IS NOT NULL THEN
    RETURN NEW;   -- frozen above; nothing follows the launch
  END IF;

  SELECT launch_date INTO v_l FROM mkt_launches WHERE id = NEW.linked_launch_id;
  IF v_l IS NULL THEN
    -- undated launch: nothing to snap to, the card keeps whatever date it
    -- has. The typing rule still applies, so a typed date is not silently
    -- replaced when the launch gets a date later.
    IF TG_OP = 'UPDATE' THEN
      IF NEW.target_launch_date IS NULL THEN
        NEW.launch_date_override := false;                  -- cleared = follow
      ELSIF NEW.linked_launch_id IS NOT DISTINCT FROM OLD.linked_launch_id
            AND NOT OLD.launch_date_override                -- was following (not a switch-off)
            AND NOT NEW.launch_date_override
            AND NEW.target_launch_date IS DISTINCT FROM OLD.target_launch_date THEN
        NEW.launch_date_override := true;                   -- typed its own date
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NOT NEW.launch_date_override OR NEW.target_launch_date IS NULL THEN
      NEW.launch_date_override := false;
      NEW.target_launch_date := v_l;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.target_launch_date IS NULL THEN
    -- an attached card always has a chain: clearing the date means "follow"
    NEW.launch_date_override := false;
    NEW.target_launch_date := v_l;
  ELSIF NEW.linked_launch_id IS DISTINCT FROM OLD.linked_launch_id
     OR (OLD.launch_date_override AND NOT NEW.launch_date_override) THEN
    -- newly attached, or the override was switched off: follow the launch
    IF NOT NEW.launch_date_override THEN
      NEW.target_launch_date := v_l;
    END IF;
  ELSIF NOT NEW.launch_date_override AND NEW.target_launch_date IS DISTINCT FROM v_l THEN
    -- a following card got its own date typed in: it is now overridden
    NEW.launch_date_override := true;
  ELSIF NEW.launch_date_override AND OLD.launch_date_override
        AND NEW.target_launch_date IS DISTINCT FROM OLD.target_launch_date
        AND NEW.target_launch_date = v_l THEN
    -- the launch date was typed back: follows again
    NEW.launch_date_override := false;
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------
-- 4. Follow trigger (R4): archived and halted cards never move; via 'follow'
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_pd_follow_launch()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT id, stage, target_launch_date
      FROM mkt_pd_projects
     WHERE linked_launch_id = NEW.id
       AND NOT launch_date_override
       AND archived_at IS NULL
       AND stage <> 'halted'
       AND target_launch_date IS DISTINCT FROM NEW.launch_date
     ORDER BY created_at
     FOR UPDATE
  LOOP
    UPDATE mkt_pd_projects SET target_launch_date = NEW.launch_date WHERE id = r.id;
    PERFORM public.fn_pd_launch_moved_event(r.id, r.stage, NEW.id, r.target_launch_date, NEW.launch_date, 'follow');
  END LOOP;
  RETURN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- 5. Attach (R2): skip halted, archived keep their date, one event per change
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_pd_attach_launch(p_project_ids uuid[], p_launch_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER
SET search_path TO 'public'
AS $$
DECLARE
  l         mkt_launches%ROWTYPE;
  p         mkt_pd_projects%ROWTYPE;   -- card before
  q         mkt_pd_projects%ROWTYPE;   -- card after
  v_ids     uuid[];
  v_pid     uuid;
  v_member  uuid;
  v_how     text;
  v_old_nm  text;
  v_missing uuid[];
  v_live    boolean;
  v_fo      uuid;
  v_n       int := 0;
  v_cards   jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
BEGIN
  IF NOT public.jwt_is_internal() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'internal_only');
  END IF;
  IF p_launch_id IS NULL OR coalesce(cardinality(p_project_ids), 0) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'nothing_to_attach');
  END IF;

  SELECT * INTO l FROM mkt_launches WHERE id = p_launch_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'launch_not_found'); END IF;

  -- distinct ids, first-seen order
  SELECT array_agg(id ORDER BY ord) INTO v_ids
    FROM (SELECT u.id, min(u.ord) AS ord
            FROM unnest(p_project_ids) WITH ORDINALITY AS u(id, ord)
           WHERE u.id IS NOT NULL
           GROUP BY u.id) s;
  SELECT array_agg(i) INTO v_missing
    FROM unnest(v_ids) AS i
   WHERE NOT EXISTS (SELECT 1 FROM mkt_pd_projects WHERE id = i);
  IF v_missing IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'project_not_found', 'missing', to_jsonb(v_missing));
  END IF;

  FOREACH v_pid IN ARRAY v_ids LOOP
    SELECT * INTO p FROM mkt_pd_projects WHERE id = v_pid FOR UPDATE;

    -- a stopped card is never on a launch
    IF p.stage = 'halted' THEN
      v_skipped := v_skipped || jsonb_build_object('id', v_pid, 'name', p.name, 'reason', 'halted');
      CONTINUE;
    END IF;

    v_live := p.archived_at IS NULL;
    v_fo   := CASE WHEN v_live THEN p.linked_factory_order_id END;  -- archived: FO stays on the card only

    IF v_live THEN
      UPDATE mkt_pd_projects
         SET linked_launch_id     = p_launch_id,
             launch_date_override = false,
             target_launch_date   = COALESCE(l.launch_date, target_launch_date)
       WHERE id = v_pid;
    ELSE
      -- archived (arrived): the link only; date and override untouched
      -- (the guard freezes the date for every writer anyway)
      UPDATE mkt_pd_projects SET linked_launch_id = p_launch_id WHERE id = v_pid;
    END IF;
    SELECT * INTO q FROM mkt_pd_projects WHERE id = v_pid;

    v_member := NULL; v_how := NULL; v_old_nm := NULL;

    -- a. already a member of this launch
    SELECT id INTO v_member FROM mkt_launch_skus
     WHERE launch_id = p_launch_id AND pd_project_id = v_pid;
    IF v_member IS NOT NULL THEN v_how := 'kept'; END IF;

    -- b. a plain row already carrying the card's promoted SKU
    IF v_member IS NULL AND p.linked_sku_id IS NOT NULL THEN
      SELECT id INTO v_member FROM mkt_launch_skus
       WHERE launch_id = p_launch_id AND sku_id = p.linked_sku_id AND pd_project_id IS NULL
       FOR UPDATE;
      IF v_member IS NOT NULL THEN
        v_how := 'claimed_sku';
        UPDATE mkt_launch_skus
           SET pd_project_id = v_pid,
               factory_order_id = COALESCE(factory_order_id, v_fo)
         WHERE id = v_member;
      END IF;
    END IF;

    -- c. a placeholder named like the drop or the card
    IF v_member IS NULL THEN
      SELECT id, planned_name INTO v_member, v_old_nm FROM mkt_launch_skus
       WHERE launch_id = p_launch_id AND sku_id IS NULL AND pd_project_id IS NULL
         AND lower(btrim(planned_name)) IN (lower(btrim(p.drop_tag)), lower(btrim(p.name)))
       ORDER BY sort_order, created_at
       LIMIT 1
       FOR UPDATE;
      IF v_member IS NOT NULL THEN
        v_how := 'claimed_placeholder';
        UPDATE mkt_launch_skus
           SET pd_project_id    = v_pid,
               sku_id           = p.linked_sku_id,
               planned_name     = CASE WHEN p.linked_sku_id IS NULL THEN p.name END,
               factory_order_id = COALESCE(factory_order_id, v_fo)
         WHERE id = v_member;
      END IF;
    END IF;

    -- d. move the card's row from its previous launch (no actuals yet)
    IF v_member IS NULL THEN
      SELECT id INTO v_member FROM mkt_launch_skus
       WHERE pd_project_id = v_pid AND launch_id <> p_launch_id
         AND actual_first_30d_units IS NULL AND sold_out_at IS NULL
       ORDER BY updated_at DESC
       LIMIT 1
       FOR UPDATE;
      IF v_member IS NOT NULL THEN
        v_how := 'moved';
        UPDATE mkt_launch_skus
           SET launch_id  = p_launch_id,
               sort_order = (SELECT coalesce(max(sort_order) + 1, 0) FROM mkt_launch_skus WHERE launch_id = p_launch_id),
               factory_order_id = COALESCE(factory_order_id, v_fo)
         WHERE id = v_member;
      END IF;
    END IF;

    -- e. new row
    IF v_member IS NULL THEN
      v_how := 'inserted';
      INSERT INTO mkt_launch_skus (launch_id, sku_id, planned_name, pd_project_id, factory_order_id, sort_order)
      VALUES (p_launch_id,
              p.linked_sku_id,
              CASE WHEN p.linked_sku_id IS NULL THEN p.name END,
              v_pid,
              v_fo,
              (SELECT coalesce(max(sort_order) + 1, 0) FROM mkt_launch_skus WHERE launch_id = p_launch_id))
      RETURNING id INTO v_member;
    END IF;

    -- release whatever the card still holds on other launches (unified rule:
    -- gone unless the row has actuals, then it stays as a plain row)
    DELETE FROM mkt_launch_skus
     WHERE pd_project_id = v_pid AND launch_id <> p_launch_id
       AND actual_first_30d_units IS NULL AND sold_out_at IS NULL;
    UPDATE mkt_launch_skus SET pd_project_id = NULL
     WHERE pd_project_id = v_pid AND launch_id <> p_launch_id;

    -- Activity: one entry whenever the launch or the date changed
    IF q.linked_launch_id IS DISTINCT FROM p.linked_launch_id
       OR q.target_launch_date IS DISTINCT FROM p.target_launch_date THEN
      PERFORM public.fn_pd_launch_moved_event(
        v_pid, p.stage, p_launch_id, p.target_launch_date, q.target_launch_date, 'attach',
        jsonb_strip_nulls(jsonb_build_object('from_launch_id', p.linked_launch_id, 'member', v_how)));
    END IF;

    v_n := v_n + 1;
    v_cards := v_cards || jsonb_build_object(
      'project_id', v_pid, 'member_id', v_member, 'member', v_how,
      'replaced', v_old_nm,
      'from_launch_id', p.linked_launch_id,
      'old_target', p.target_launch_date,
      'new_target', q.target_launch_date,
      'archived', NOT v_live);
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'attached', v_n, 'launch_id', p_launch_id,
                            'launch_date', l.launch_date, 'cards', v_cards, 'skipped', v_skipped);
END $$;

-- ---------------------------------------------------------------------------
-- 6. Detach RPC (R3, via 'detach')
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_pd_detach_launch(p_project_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER
SET search_path TO 'public'
AS $$
DECLARE
  p     mkt_pd_projects%ROWTYPE;
  v_res jsonb;
BEGIN
  IF NOT public.jwt_is_internal() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'internal_only');
  END IF;
  SELECT * INTO p FROM mkt_pd_projects WHERE id = p_project_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found'); END IF;
  IF p.linked_launch_id IS NULL
     AND NOT EXISTS (SELECT 1 FROM mkt_launch_skus WHERE pd_project_id = p_project_id) THEN
    RETURN jsonb_build_object('ok', true, 'noop', true);
  END IF;

  v_res := public.fn_pd_detach_member(p_project_id, NULL, 'detach');

  RETURN jsonb_build_object('ok', true, 'launch_id', p.linked_launch_id,
                            'target_launch_date', p.target_launch_date,
                            'member', v_res->>'member');
END $$;

-- ---------------------------------------------------------------------------
-- 6b. Own date / launch date switch (R4): archived cards refused, Activity
--     entry via 'override' (replaces the 20260928000001 body; SECURITY
--     INVOKER, internal gate as before)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_pd_set_launch_override(p_project_id uuid, p_override boolean, p_date date DEFAULT NULL::date)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  p mkt_pd_projects%ROWTYPE;   -- before
  q mkt_pd_projects%ROWTYPE;   -- after
BEGIN
  IF NOT public.jwt_is_internal() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'internal_only');
  END IF;
  IF p_override IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'override_required'); END IF;
  SELECT * INTO p FROM mkt_pd_projects WHERE id = p_project_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found'); END IF;
  IF p.linked_launch_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'not_attached'); END IF;
  IF p.archived_at IS NOT NULL THEN
    -- arrived: the date is frozen (guard), so the switch has nothing to do
    RETURN jsonb_build_object('ok', false, 'error', 'archived', 'archive_reason', p.archive_reason);
  END IF;

  IF p_override THEN
    UPDATE mkt_pd_projects
       SET launch_date_override = true,
           target_launch_date   = COALESCE(p_date, target_launch_date)
     WHERE id = p_project_id;
  ELSE
    UPDATE mkt_pd_projects
       SET launch_date_override = false,
           target_launch_date   = COALESCE((SELECT launch_date FROM mkt_launches WHERE id = p.linked_launch_id),
                                           target_launch_date)
     WHERE id = p_project_id;
  END IF;

  SELECT * INTO q FROM mkt_pd_projects WHERE id = p_project_id;
  IF q.target_launch_date IS DISTINCT FROM p.target_launch_date
     OR q.launch_date_override IS DISTINCT FROM p.launch_date_override THEN
    PERFORM public.fn_pd_launch_moved_event(
      p_project_id, p.stage, p.linked_launch_id, p.target_launch_date, q.target_launch_date, 'override',
      jsonb_build_object('override', q.launch_date_override));
  END IF;

  RETURN jsonb_build_object('ok', true, 'launch_date_override', q.launch_date_override,
                            'target_launch_date', q.target_launch_date);
END $function$;

-- ---------------------------------------------------------------------------
-- 7. Halt detaches (R3, via 'halt' - done by trg_pd_halt_detaches when the
--    stage is written); revive comes back unattached (R8)
--    (replace 20260819000001 bodies; SECURITY INVOKER, admin gate as before)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_pd_kill(p_project_id uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  p        mkt_pd_projects%ROWTYPE;
  v_on     boolean;
  v_launch uuid;
  v_member text;
BEGIN
  IF NOT public.jwt_is_admin() THEN RETURN jsonb_build_object('ok', false, 'error', 'admin_only'); END IF;
  IF coalesce(p_reason,'') = '' THEN RETURN jsonb_build_object('ok', false, 'error', 'reason_required'); END IF;
  SELECT * INTO p FROM mkt_pd_projects WHERE id = p_project_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found'); END IF;
  IF p.stage = 'halted' THEN RETURN jsonb_build_object('ok', true, 'noop', true); END IF;

  -- what the halt trigger is about to do, read before it does it (same rule
  -- as fn_pd_release_member_rows: deleted unless a row has actuals)
  SELECT count(*) > 0,
         COALESCE(p.linked_launch_id, (array_agg(launch_id ORDER BY updated_at DESC))[1]),
         CASE WHEN count(*) FILTER (WHERE actual_first_30d_units IS NULL AND sold_out_at IS NULL) > 0 THEN 'deleted'
              WHEN count(*) > 0 THEN 'released'
              ELSE 'none' END
    INTO v_on, v_launch, v_member
    FROM mkt_launch_skus WHERE pd_project_id = p_project_id;
  v_on := v_on OR p.linked_launch_id IS NOT NULL;

  INSERT INTO mkt_pd_stage_events (project_id, from_stage, to_stage, outcome, reason, decided_by)
  VALUES (p_project_id, p.stage, 'halted', 'kill', p_reason, auth.uid());
  -- a stopped card is never on a launch: trg_pd_halt_detaches takes it off
  -- the launch, deletes its product line and writes the 'halt' event
  UPDATE mkt_pd_projects SET stage = 'halted', stage_entered_at = now() WHERE id = p_project_id;

  IF v_on THEN
    RETURN jsonb_build_object('ok', true, 'detached', true,
                              'launch_id', v_launch, 'member', v_member);
  END IF;
  RETURN jsonb_build_object('ok', true);
END $function$;

CREATE OR REPLACE FUNCTION public.rpc_pd_move(p_project_id uuid, p_to_stage text, p_reason text DEFAULT NULL::text, p_override jsonb DEFAULT NULL::jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
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

  -- a revived card comes back unattached; only a card halted before halting
  -- detached (pre-migration state) can still be on a launch here
  IF v_out = 'revive'
     AND (p.linked_launch_id IS NOT NULL
          OR EXISTS (SELECT 1 FROM mkt_launch_skus WHERE pd_project_id = p_project_id)) THEN
    PERFORM public.fn_pd_detach_member(p_project_id, NULL, 'revive');
  END IF;

  RETURN jsonb_build_object('ok', true, 'outcome', v_out, 'from', p.stage, 'to', p_to_stage);
END $function$;

-- ---------------------------------------------------------------------------
-- 8. rpc_save_launch (R1): pd_project_id honoured, backstop for NEW SKUs,
--    detach_pd_project_ids processed last (replaces 20260928000001 body;
--    SECURITY INVOKER as before)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_save_launch(p_id uuid, p_launch jsonb, p_members jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_id       uuid;
  v_cards    uuid[];
  v_auto     uuid[];
  v_detach   uuid[] := '{}';
  v_pid      uuid;
  v_res      jsonb;
  v_pre      uuid[];     -- member row ids in the order the form loaded them
  v_pre_skus uuid[];     -- SKUs on the launch before this save (card or plain)
  v_legacy   boolean;    -- payload carries no pd_project_id (form not updated yet)
BEGIN
  IF p_id IS NULL THEN
    -- created_by omitted → column default auth.uid() fills it.
    INSERT INTO mkt_launches (kind, name, launch_date, early_access_date, inventory_ready_by, preorder, notes)
    VALUES (
      COALESCE(p_launch->>'kind', 'launch'),
      p_launch->>'name',
      (p_launch->>'launch_date')::date,
      (p_launch->>'early_access_date')::date,
      (p_launch->>'inventory_ready_by')::date,
      COALESCE((p_launch->>'preorder')::boolean, false),
      p_launch->>'notes'
    )
    RETURNING id INTO v_id;
  ELSE
    v_id := p_id;
    -- a launch_date change fires trg_pd_follow_launch (following cards move)
    UPDATE mkt_launches SET
      kind               = COALESCE(p_launch->>'kind', kind),
      name               = COALESCE(p_launch->>'name', name),
      launch_date        = CASE WHEN p_launch ? 'launch_date'        THEN (p_launch->>'launch_date')::date        ELSE launch_date END,
      early_access_date  = CASE WHEN p_launch ? 'early_access_date'  THEN (p_launch->>'early_access_date')::date  ELSE early_access_date END,
      inventory_ready_by = CASE WHEN p_launch ? 'inventory_ready_by' THEN (p_launch->>'inventory_ready_by')::date ELSE inventory_ready_by END,
      preorder           = CASE WHEN p_launch ? 'preorder'           THEN (p_launch->>'preorder')::boolean        ELSE preorder END,
      notes              = CASE WHEN p_launch ? 'notes'              THEN p_launch->>'notes'                      ELSE notes END,
      updated_at         = now()
    WHERE id = v_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'launch % not found', v_id;
    END IF;
  END IF;

  -- Cards the form removed with the X on a card row (processed last, see (e)).
  IF jsonb_typeof(p_launch->'detach_pd_project_ids') = 'array' THEN
    SELECT COALESCE(array_agg(DISTINCT x::uuid), '{}') INTO v_detach
      FROM jsonb_array_elements_text(p_launch->'detach_pd_project_ids') AS t(x)
     WHERE x IS NOT NULL;
  END IF;

  -- p_members NULL → members untouched (e.g. a calendar drag that only
  -- shifts dates). A provided array (even empty) reconciles membership.
  IF p_members IS NOT NULL THEN
    -- Pre-save order (LaunchFormDialog sorts rows by sort_order and sends
    -- them back by position), taken before anything below rewrites it.
    SELECT array_agg(id ORDER BY sort_order, created_at, id) INTO v_pre
      FROM mkt_launch_skus WHERE launch_id = v_id;
    -- SKUs already on the launch: never eligible for the backstop (a2).
    SELECT array_agg(sku_id) INTO v_pre_skus
      FROM mkt_launch_skus WHERE launch_id = v_id AND sku_id IS NOT NULL;
    v_legacy := NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_members) e
                             WHERE (e->>'pd_project_id') IS NOT NULL);

    -- (0) Card-backed members (pd_project_id set). Cards not yet on this
    -- launch are attached (same rules as the PD board's attach; halted cards
    -- are skipped there and get no row); then the planner inputs + position
    -- are written onto each card's row. Card rows are never deleted here —
    -- only the detach rule (e) removes them.
    SELECT array_agg(s.pid ORDER BY s.ord) INTO v_cards
      FROM (SELECT (m->>'pd_project_id')::uuid AS pid, min(ord) AS ord
              FROM jsonb_array_elements(p_members) WITH ORDINALITY AS t(m, ord)
             WHERE (m->>'pd_project_id') IS NOT NULL
             GROUP BY 1) s
     WHERE NOT (s.pid = ANY (v_detach))
       AND NOT EXISTS (SELECT 1 FROM mkt_launch_skus k
                        WHERE k.launch_id = v_id AND k.pd_project_id = s.pid);
    IF v_cards IS NOT NULL THEN
      v_res := public.rpc_pd_attach_launch(v_cards, v_id);
      IF NOT coalesce((v_res->>'ok')::boolean, false) THEN
        RAISE EXCEPTION 'attach to launch % failed: %', v_id, v_res->>'error';
      END IF;
    END IF;

    UPDATE mkt_launch_skus k SET
      expected_first_30d_units = c.expected,
      limited_qty              = c.limited,
      planner_confidence       = c.confidence,
      sort_order               = c.pos,
      updated_at               = now()
    FROM (SELECT DISTINCT ON ((m->>'pd_project_id')::uuid)
                 (m->>'pd_project_id')::uuid           AS pid,
                 (m->>'expected_first_30d_units')::int AS expected,
                 (m->>'limited_qty')::int              AS limited,
                 (m->>'planner_confidence')::int       AS confidence,
                 (ord - 1)::int                        AS pos
            FROM jsonb_array_elements(p_members) WITH ORDINALITY AS t(m, ord)
           WHERE (m->>'pd_project_id') IS NOT NULL
           ORDER BY (m->>'pd_project_id')::uuid, ord) c
    WHERE k.launch_id = v_id AND k.pd_project_id = c.pid;

    -- (a) Upsert real-SKU members; ON CONFLICT preserves the outcome columns
    -- (they are simply not in the SET list). sort_order uses the member's
    -- global position in the array so real + planned rows stay in order.
    -- An entry that names a card-backed row's SKU without pd_project_id
    -- lands on that row through the conflict target (pd_project_id kept).
    INSERT INTO mkt_launch_skus (
      launch_id, sku_id, planned_name, expected_first_30d_units,
      limited_qty, planner_confidence, sort_order
    )
    SELECT v_id,
           (m->>'sku_id')::uuid,
           m->>'planned_name',
           (m->>'expected_first_30d_units')::int,
           (m->>'limited_qty')::int,
           (m->>'planner_confidence')::int,
           (ord - 1)::int
    FROM jsonb_array_elements(p_members) WITH ORDINALITY AS t(m, ord)
    WHERE (m->>'sku_id') IS NOT NULL
      AND (m->>'pd_project_id') IS NULL
    ON CONFLICT (launch_id, sku_id) WHERE sku_id IS NOT NULL
    DO UPDATE SET
      planned_name             = EXCLUDED.planned_name,
      expected_first_30d_units = EXCLUDED.expected_first_30d_units,
      limited_qty              = EXCLUDED.limited_qty,
      planner_confidence       = EXCLUDED.planner_confidence,
      sort_order               = EXCLUDED.sort_order,
      updated_at               = now();

    -- (b) Drop plain real-SKU members no longer in the incoming set (NOT IN
    -- over a NULL-free subquery; empty array → removes all plain real-SKU
    -- members). Card-backed rows are skipped.
    DELETE FROM mkt_launch_skus k
    WHERE k.launch_id = v_id
      AND k.sku_id IS NOT NULL
      AND k.pd_project_id IS NULL
      AND k.sku_id NOT IN (
        SELECT (m->>'sku_id')::uuid
        FROM jsonb_array_elements(p_members) AS m
        WHERE (m->>'sku_id') IS NOT NULL
      );

    -- (a2) BACKSTOP - one product, one row. A plain SKU row whose SKU is NEW
    -- to the launch in this save is linked to the card that owns the SKU
    -- (mkt_pd_projects_linked_sku_unique: at most one) when that card is
    -- live (not archived, not halted), unattached or already on this launch,
    -- not being detached in this payload, and was never removed from this
    -- launch. rpc_pd_attach_launch rule b claims the row, the card's date
    -- follows the launch and an Activity entry is written. Archived cards
    -- are never auto-linked (a restock of an old SKU stays plain).
    SELECT array_agg(c.id ORDER BY k.sort_order, k.created_at) INTO v_auto
      FROM mkt_launch_skus k
      JOIN mkt_pd_projects c ON c.linked_sku_id = k.sku_id
     WHERE k.launch_id = v_id
       AND k.pd_project_id IS NULL
       AND k.sku_id IS NOT NULL
       AND NOT (k.sku_id = ANY (COALESCE(v_pre_skus, '{}'::uuid[])))
       AND c.archived_at IS NULL
       AND c.stage <> 'halted'
       AND (c.linked_launch_id IS NULL OR c.linked_launch_id = v_id)
       AND NOT (c.id = ANY (v_detach))
       AND NOT EXISTS (SELECT 1 FROM mkt_pd_stage_events e
                        WHERE e.project_id = c.id
                          AND e.outcome = 'launch_moved'
                          AND e.meta->>'launch_id' = v_id::text
                          AND e.meta->>'via' IN ('detach', 'halt', 'form', 'revive'));
    IF v_auto IS NOT NULL THEN
      v_res := public.rpc_pd_attach_launch(v_auto, v_id);
      IF NOT coalesce((v_res->>'ok')::boolean, false) THEN
        RAISE EXCEPTION 'auto-link on launch % failed: %', v_id, v_res->>'error';
      END IF;
    END IF;

    -- (c) Plain planned-name-only rows carry no outcomes → replace wholesale.
    -- A planned-name entry echoing a card-backed row's name (a form that
    -- does not send pd_project_id) updates that row instead of duplicating.
    UPDATE mkt_launch_skus k SET
      expected_first_30d_units = c.expected,
      limited_qty              = c.limited,
      planner_confidence       = c.confidence,
      sort_order               = c.pos,
      updated_at               = now()
    FROM (SELECT DISTINCT ON (lower(btrim(m->>'planned_name')))
                 lower(btrim(m->>'planned_name'))      AS nm,
                 (m->>'expected_first_30d_units')::int AS expected,
                 (m->>'limited_qty')::int              AS limited,
                 (m->>'planner_confidence')::int       AS confidence,
                 (ord - 1)::int                        AS pos
            FROM jsonb_array_elements(p_members) WITH ORDINALITY AS t(m, ord)
           WHERE (m->>'sku_id') IS NULL AND (m->>'pd_project_id') IS NULL
           ORDER BY lower(btrim(m->>'planned_name')), ord) c
    WHERE k.launch_id = v_id AND k.pd_project_id IS NOT NULL AND k.sku_id IS NULL
      AND lower(btrim(k.planned_name)) = c.nm;

    -- (c2) Legacy rename in place. The current form lets the user edit a
    -- card row's working name inline and sends no pd_project_id. An entry
    -- whose name is new to this launch (no card row and no plain row carries
    -- it) at the exact position the form loaded a card row that the payload
    -- no longer names is that card row renamed: the row takes the typed
    -- name + inputs (the INSERT below then skips the entry). Anything less
    -- certain falls through to the plain-row path unchanged.
    IF v_legacy AND v_pre IS NOT NULL THEN
      UPDATE mkt_launch_skus k SET
        planned_name             = c.nm,
        expected_first_30d_units = c.expected,
        limited_qty              = c.limited,
        planner_confidence       = c.confidence,
        sort_order               = c.pos,
        updated_at               = now()
      FROM (SELECT m->>'planned_name'                     AS nm,
                   (m->>'expected_first_30d_units')::int AS expected,
                   (m->>'limited_qty')::int              AS limited,
                   (m->>'planner_confidence')::int       AS confidence,
                   (ord - 1)::int                        AS pos
              FROM jsonb_array_elements(p_members) WITH ORDINALITY AS t(m, ord)
             WHERE (m->>'sku_id') IS NULL
               AND btrim(coalesce(m->>'planned_name', '')) <> ''
               AND NOT EXISTS (SELECT 1 FROM mkt_launch_skus o
                                WHERE o.launch_id = v_id AND o.sku_id IS NULL
                                  AND lower(btrim(o.planned_name)) = lower(btrim(m->>'planned_name')))) c
      WHERE k.launch_id = v_id AND k.pd_project_id IS NOT NULL AND k.sku_id IS NULL
        AND array_position(v_pre, k.id) = c.pos + 1
        AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_members) e
                         WHERE (e->>'sku_id') IS NULL
                           AND lower(btrim(e->>'planned_name')) = lower(btrim(k.planned_name)));
    END IF;

    DELETE FROM mkt_launch_skus WHERE launch_id = v_id AND sku_id IS NULL AND pd_project_id IS NULL;
    INSERT INTO mkt_launch_skus (
      launch_id, sku_id, planned_name, expected_first_30d_units,
      limited_qty, planner_confidence, sort_order
    )
    SELECT v_id, NULL, m->>'planned_name',
           (m->>'expected_first_30d_units')::int,
           (m->>'limited_qty')::int,
           (m->>'planner_confidence')::int,
           (ord - 1)::int
    FROM jsonb_array_elements(p_members) WITH ORDINALITY AS t(m, ord)
    WHERE (m->>'sku_id') IS NULL
      AND (m->>'pd_project_id') IS NULL
      AND NOT EXISTS (SELECT 1 FROM mkt_launch_skus k
                       WHERE k.launch_id = v_id AND k.pd_project_id IS NOT NULL AND k.sku_id IS NULL
                         AND lower(btrim(k.planned_name)) = lower(btrim(m->>'planned_name')));
  END IF;

  -- (e) Cards removed with the X on a card row: off this launch through the
  -- unified detach rule (row deleted unless it has actuals). Runs last so
  -- (b) cannot delete a kept plain row with actuals and (a2) cannot re-link.
  -- Absence from the payload never detaches.
  FOREACH v_pid IN ARRAY v_detach LOOP
    IF EXISTS (SELECT 1 FROM mkt_pd_projects c WHERE c.id = v_pid
                  AND (c.linked_launch_id = v_id
                       OR EXISTS (SELECT 1 FROM mkt_launch_skus k
                                   WHERE k.launch_id = v_id AND k.pd_project_id = v_pid))) THEN
      PERFORM public.fn_pd_detach_member(v_pid, v_id, 'form');
    END IF;
  END LOOP;

  RETURN v_id;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 9. New card actions (R5, R6): admin/manager, SECURITY INVOKER
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_pd_link_sku(p_project_id uuid, p_sku_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER
SET search_path TO 'public'
AS $$
DECLARE
  p        mkt_pd_projects%ROWTYPE;
  s        product_skus%ROWTYPE;
  v_owner  uuid;
  v_plain  mkt_launch_skus%ROWTYPE;
  v_ph     mkt_launch_skus%ROWTYPE;
  v_member uuid;
  v_how    text := 'none';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM profiles
                  WHERE id = auth.uid() AND is_active AND role IN ('admin', 'manager')) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'admin_or_manager_required');
  END IF;
  IF p_sku_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'sku_required'); END IF;

  SELECT * INTO p FROM mkt_pd_projects WHERE id = p_project_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found'); END IF;
  IF p.linked_sku_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'already_linked', 'sku_id', p.linked_sku_id);
  END IF;
  SELECT * INTO s FROM product_skus WHERE id = p_sku_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'sku_not_found'); END IF;
  SELECT id INTO v_owner FROM mkt_pd_projects WHERE linked_sku_id = p_sku_id AND id <> p_project_id;
  IF v_owner IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'sku_owned_by_other_card', 'owner_project_id', v_owner);
  END IF;

  UPDATE mkt_pd_projects SET linked_sku_id = p_sku_id, sku_code = s.sku WHERE id = p_project_id;

  IF p.linked_launch_id IS NOT NULL THEN
    SELECT * INTO v_ph FROM mkt_launch_skus
     WHERE launch_id = p.linked_launch_id AND pd_project_id = p_project_id
     FOR UPDATE;
    SELECT * INTO v_plain FROM mkt_launch_skus
     WHERE launch_id = p.linked_launch_id AND sku_id = p_sku_id AND pd_project_id IS NULL
     FOR UPDATE;

    IF v_plain.id IS NOT NULL THEN
      -- merge: the plain row becomes the card's row (its planner inputs win,
      -- the placeholder fills the blanks); the placeholder goes
      IF v_ph.id IS NOT NULL THEN
        DELETE FROM mkt_launch_skus WHERE id = v_ph.id;
      END IF;
      UPDATE mkt_launch_skus
         SET pd_project_id            = p_project_id,
             planned_name             = NULL,
             expected_first_30d_units = COALESCE(expected_first_30d_units, v_ph.expected_first_30d_units),
             limited_qty              = COALESCE(limited_qty, v_ph.limited_qty),
             planner_confidence       = COALESCE(planner_confidence, v_ph.planner_confidence),
             factory_order_id         = COALESCE(factory_order_id, v_ph.factory_order_id, p.linked_factory_order_id),
             updated_at               = now()
       WHERE id = v_plain.id;
      v_member := v_plain.id; v_how := 'merged';
    ELSIF v_ph.id IS NOT NULL AND v_ph.sku_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM mkt_launch_skus o
                           WHERE o.launch_id = v_ph.launch_id AND o.sku_id = p_sku_id) THEN
      -- the card's placeholder now names the real SKU
      UPDATE mkt_launch_skus
         SET sku_id = p_sku_id, planned_name = NULL, updated_at = now()
       WHERE id = v_ph.id;
      v_member := v_ph.id; v_how := 'placeholder_promoted';
    ELSIF v_ph.id IS NOT NULL THEN
      v_member := v_ph.id; v_how := 'kept';
    END IF;
  END IF;

  INSERT INTO mkt_pd_stage_events (project_id, from_stage, to_stage, outcome, decided_by, meta)
  VALUES (p_project_id, p.stage, p.stage, 'link_sku', auth.uid(),
          jsonb_strip_nulls(jsonb_build_object(
            'sku_id', p_sku_id, 'sku', s.sku,
            'launch_id', p.linked_launch_id,
            'merged_member_id', CASE WHEN v_how = 'merged' THEN v_member END,
            'member', v_how)));

  RETURN jsonb_build_object('ok', true, 'sku_id', p_sku_id, 'sku', s.sku,
                            'launch_id', p.linked_launch_id, 'member_id', v_member, 'member', v_how);
END $$;

CREATE OR REPLACE FUNCTION public.rpc_pd_mark_arrived(p_project_id uuid, p_note text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER
SET search_path TO 'public'
AS $$
DECLARE p mkt_pd_projects%ROWTYPE;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM profiles
                  WHERE id = auth.uid() AND is_active AND role IN ('admin', 'manager')) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'admin_or_manager_required');
  END IF;
  SELECT * INTO p FROM mkt_pd_projects WHERE id = p_project_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found'); END IF;
  IF p.archived_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'already_archived', 'archive_reason', p.archive_reason);
  END IF;
  IF p.stage <> 'ordered' THEN RETURN jsonb_build_object('ok', false, 'error', 'not_ordered', 'stage', p.stage); END IF;

  -- only the archive columns: launch link, date and override stay as they are
  UPDATE mkt_pd_projects SET archived_at = now(), archive_reason = 'arrived' WHERE id = p_project_id;
  INSERT INTO mkt_pd_stage_events (project_id, from_stage, to_stage, outcome, reason, decided_by, meta)
  VALUES (p_project_id, 'ordered', NULL, 'archive', 'arrived', auth.uid(),
          jsonb_strip_nulls(jsonb_build_object('manual', true, 'note', nullif(btrim(p_note), ''))));
  RETURN jsonb_build_object('ok', true, 'launch_id', p.linked_launch_id);
END $$;

-- ---------------------------------------------------------------------------
-- 10. rpc_daily_report (R7): launch product count excludes halted-card rows
--     (replaces 20260827000008 body verbatim except sku_count; SECURITY
--     DEFINER, search_path public, auth as before)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_daily_report()
 RETURNS jsonb
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
WITH d AS (
  SELECT (now() AT TIME ZONE 'America/New_York')::date AS today,
         ((now() AT TIME ZONE 'America/New_York')::date - 1) AS yday
),
sold AS (
  SELECT sd.sku_id, SUM(sd.units)::int AS units
  FROM sales_daily sd, d
  WHERE sd.sale_date = d.yday
  GROUP BY sd.sku_id
),
avg30 AS (
  SELECT sd.sku_id, SUM(sd.units)::numeric / 30 AS avg_daily
  FROM sales_daily sd, d
  WHERE sd.sale_date >= d.yday - 30 AND sd.sale_date < d.yday
  GROUP BY sd.sku_id
),
sales_rows AS (
  SELECT ps.sku, ps.product_name, sold.units,
         ROUND(COALESCE(avg30.avg_daily, 0), 1) AS avg_daily,
         CASE
           WHEN COALESCE(avg30.avg_daily, 0) >= 1 AND sold.units >= 2 * avg30.avg_daily THEN 'above'
           WHEN COALESCE(avg30.avg_daily, 0) >= 1 AND sold.units <= 0.5 * avg30.avg_daily THEN 'below'
           ELSE NULL
         END AS flag
  FROM sold
  JOIN product_skus ps ON ps.id = sold.sku_id
  LEFT JOIN avg30 ON avg30.sku_id = sold.sku_id
  WHERE COALESCE(ps.display_category, '') NOT IN ('Bases', 'Coils')
),
incoming_rows AS (
  SELECT fs.shipment_number, fs.carrier_name, fs.freight_type, fs.eta,
         (fs.eta - (SELECT today FROM d)) AS days_out,
         COALESCE(
           jsonb_agg(jsonb_build_object('sku', COALESCE(ps.sku, fli.custom_description), 'name', ps.product_name,
                     'qty', GREATEST(fli.quantity - fli.quantity_received, 0))
                     ORDER BY ps.sku)
           FILTER (WHERE fli.id IS NOT NULL AND GREATEST(fli.quantity - fli.quantity_received, 0) > 0
                   AND COALESCE(ps.display_category, '') NOT IN ('Bases', 'Coils')),
           '[]'::jsonb
         ) AS items
  FROM freight_shipments fs
  LEFT JOIN freight_line_items fli ON fli.freight_shipment_id = fs.id
  LEFT JOIN product_skus ps ON ps.id = fli.sku_id
  WHERE fs.status = 'tracking'
  GROUP BY fs.id, fs.shipment_number, fs.carrier_name, fs.freight_type, fs.eta
  HAVING count(*) FILTER (WHERE fli.id IS NOT NULL AND GREATEST(fli.quantity - fli.quantity_received, 0) > 0
                          AND COALESCE(ps.display_category, '') NOT IN ('Bases', 'Coils')) > 0
),
eff AS (
  SELECT ps.id AS sku_id, ps.sku, ps.product_name,
         COALESCE(
           CASE ov.mode
             WHEN 'manual'   THEN ov.monthly_demand
             WHEN 'trailing' THEN COALESCE(ps.monthly_demand, 0)
             WHEN 'forecast' THEN COALESCE(f.forecast_30d, ps.monthly_demand, 0)
           END,
           CASE WHEN COALESCE(f.forecast_30d, 0) >= 60 THEN f.forecast_30d
                ELSE COALESCE(ps.monthly_demand, 0) END
         ) AS monthly_demand
  FROM product_skus ps
  LEFT JOIN sku_forecasts f ON f.sku_id = ps.id
  LEFT JOIN demand_overrides ov ON ov.sku_id = ps.id
  WHERE ps.is_active
    AND COALESCE(ps.display_category, '') NOT IN ('Bases', 'Coils')
),
wh AS (
  SELECT il.sku_id,
    (COALESCE(il.warehouse_raw, 0) + COALESCE(il.warehouse_prefilled_raw, 0)
     + COALESCE(il.warehouse_in_production, 0) + COALESCE(il.warehouse_finished, 0)
     + COALESCE(il.warehouse_other, 0)) AS wh_units
  FROM inventory_levels il
),
transit AS (
  -- Remaining units only, statusless: received units are already on-hand.
  SELECT fli.sku_id, SUM(GREATEST(fli.quantity - fli.quantity_received, 0))::int AS units,
         MIN(fs.eta) AS next_eta
  FROM freight_line_items fli
  JOIN freight_shipments fs ON fs.id = fli.freight_shipment_id
  WHERE fli.sku_id IS NOT NULL
    AND fli.quantity > fli.quantity_received
  GROUP BY fli.sku_id
),
recv_out AS (
  -- Shipments sitting partially received >= 7 days since first check-in.
  SELECT fs.shipment_number,
         ((SELECT today FROM d) - MIN((fr.received_at AT TIME ZONE 'America/New_York')::date))::int AS days_outstanding,
         (SELECT SUM(g.received_cartons)::int FROM freight_carton_groups g WHERE g.freight_shipment_id = fs.id) AS cartons_received,
         (SELECT SUM(g.carton_qty)::int FROM freight_carton_groups g WHERE g.freight_shipment_id = fs.id) AS cartons_total,
         SUM(fli.quantity_received)::int AS units_received,
         SUM(fli.quantity)::int AS units_total,
         fs.carrier_pieces_delivered AS carrier_delivered,
         fs.carrier_pieces_total AS carrier_total,
         fs.carrier_last_piece_event_at::date AS carrier_last_movement
  FROM freight_shipments fs
  JOIN freight_line_items fli ON fli.freight_shipment_id = fs.id AND fli.sku_id IS NOT NULL
  JOIN freight_receipts fr ON fr.freight_shipment_id = fs.id
  WHERE fs.receipt_confirmed_at IS NULL
  GROUP BY fs.id, fs.shipment_number
  HAVING SUM(fli.quantity_received) > 0
     AND ((SELECT today FROM d) - MIN((fr.received_at AT TIME ZONE 'America/New_York')::date)) >= 7
),
low_rows AS (
  SELECT eff.sku, eff.product_name,
         GREATEST(COALESCE(wh.wh_units, 0), 0) AS wh_units,
         eff.monthly_demand,
         ROUND(GREATEST(COALESCE(wh.wh_units, 0), 0) / (eff.monthly_demand / 30.0), 1) AS dos_days,
         COALESCE(transit.units, 0) AS in_transit, transit.next_eta
  FROM eff
  JOIN wh ON wh.sku_id = eff.sku_id
  LEFT JOIN transit ON transit.sku_id = eff.sku_id
  WHERE eff.monthly_demand > 0
    AND (COALESCE(wh.wh_units, 0) / (eff.monthly_demand / 30.0)) <= 7
)
SELECT jsonb_build_object(
  'report_date', (SELECT yday FROM d),
  'generated_at', now(),
  'recipients', COALESCE(
    (SELECT jsonb_agg(u.email ORDER BY u.email)
     FROM profiles p JOIN auth.users u ON u.id = p.id
     WHERE p.role = 'admin' AND p.is_active AND u.email IS NOT NULL),
    '[]'::jsonb),
  'sales', COALESCE((SELECT jsonb_agg(to_jsonb(sr) ORDER BY sr.units DESC) FROM sales_rows sr), '[]'::jsonb),
  'sales_totals', (SELECT jsonb_build_object(
     'units', COALESCE(SUM(units), 0),
     'sku_count', COUNT(*)) FROM sales_rows),
  'incoming', COALESCE((SELECT jsonb_agg(to_jsonb(ir) ORDER BY ir.eta NULLS LAST) FROM incoming_rows ir), '[]'::jsonb),
  'receiving_outstanding', COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.days_outstanding DESC) FROM recv_out r), '[]'::jsonb),
  'marketing', jsonb_build_object(
    'sales', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'name', ms.name, 'starts_at', ms.starts_at::date, 'ends_at', ms.ends_at::date,
        'early_access', ms.early_access_starts_at::date,
        'approval', ms.approval_status,
        'sku_count', (SELECT count(DISTINCT e.sku_id) FROM mkt_offer_sku_expansion e WHERE e.sale_id = ms.id)
      ) ORDER BY ms.starts_at)
      FROM mkt_sales ms
      WHERE COALESCE(ms.early_access_starts_at, ms.starts_at)::date <= (SELECT today FROM d) + 14 AND ms.ends_at::date >= (SELECT today FROM d)), '[]'::jsonb),
    'launches', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'name', ml.name, 'kind', ml.kind, 'launch_date', ml.launch_date,
        'early_access', ml.early_access_date, 'approval', ml.approval_status,
        -- one definition of "product": member rows minus rows whose card is halted
        'sku_count', (SELECT count(*)
                        FROM mkt_launch_skus k
                        LEFT JOIN mkt_pd_projects c ON c.id = k.pd_project_id
                       WHERE k.launch_id = ml.id
                         AND (c.id IS NULL OR c.stage <> 'halted'))
      ) ORDER BY ml.launch_date)
      FROM mkt_launches ml
      WHERE ml.launch_date >= (SELECT today FROM d)
        AND COALESCE(ml.early_access_date, ml.launch_date) <= (SELECT today FROM d) + 14), '[]'::jsonb),
    'broadcasts', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'name', mb.name, 'channel', mb.channel, 'scheduled_at', mb.scheduled_at::date
      ) ORDER BY mb.scheduled_at)
      FROM mkt_broadcasts mb
      WHERE mb.scheduled_at::date BETWEEN (SELECT today FROM d) AND (SELECT today FROM d) + 14), '[]'::jsonb),
    'awaiting_confirmation', COALESCE((
      SELECT jsonb_agg(t.x ORDER BY t.x->>'date') FROM (
        SELECT jsonb_build_object('type', 'sale', 'name', ms.name, 'date', ms.starts_at::date) AS x
          FROM mkt_sales ms WHERE ms.approval_status = 'proposed' AND ms.ends_at::date >= (SELECT today FROM d)
        UNION ALL
        SELECT jsonb_build_object('type', 'launch', 'name', ml.name, 'date', ml.launch_date)
          FROM mkt_launches ml WHERE ml.approval_status = 'proposed' AND ml.launch_date >= (SELECT today FROM d)
      ) t), '[]'::jsonb)
  ),
  'low_stock', COALESCE((SELECT jsonb_agg(to_jsonb(lr) ORDER BY lr.dos_days ASC) FROM low_rows lr), '[]'::jsonb)
);
$function$;

-- ---------------------------------------------------------------------------
-- 11. Grants (restated for replaced functions; new ones at the same level)
-- ---------------------------------------------------------------------------
GRANT EXECUTE ON FUNCTION public.rpc_save_launch(uuid, jsonb, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_pd_attach_launch(uuid[], uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_pd_detach_launch(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_pd_kill(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_pd_move(uuid, text, text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_pd_set_launch_override(uuid, boolean, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_pd_link_sku(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_pd_mark_arrived(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_pd_detach_member(uuid, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_pd_release_member_rows(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_pd_launch_moved_event(uuid, text, uuid, date, date, text, jsonb) TO authenticated;
-- live ACL restated, not tightened: see KNOWN GAPS / 20260930000003
GRANT EXECUTE ON FUNCTION public.rpc_daily_report() TO anon, authenticated, service_role;
