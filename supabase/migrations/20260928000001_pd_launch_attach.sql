-- ============================================================================
-- PD cards attach to launches: many cards ride one launch (owner-approved
-- design 2026-09-28, mockup pd-launch-link-mockup.html)
-- ============================================================================
-- WHAT CHANGES AND WHY
--
-- A launch (mkt_launches) is the parent and the only date authority. Any
-- number of product-development cards (mkt_pd_projects) attach to ONE launch
-- through mkt_pd_projects.linked_launch_id (a studio drop is four cards on
-- one launch). An attached card FOLLOWS its launch by default: the database
-- keeps its target_launch_date equal to the launch's launch_date, so every
-- existing reader of target_launch_date (Ready-to-Begin gate, promise
-- snapshot, risk dot, board counts) keeps working without change.
--
-- 1. mkt_pd_projects
--    - The UNIQUE on linked_launch_id is dropped (it allowed one card per
--      launch); a plain partial index replaces it for lookups.
--    - launch_date_override boolean: attached but keeps its own date. A CHECK
--      makes it meaningless-and-false on unattached cards.
--    - trg_pd_launch_date_guard (BEFORE INSERT/UPDATE of the three date
--      columns) is what makes "the database keeps it equal" true for EVERY
--      writer, including the card sheet's direct table update:
--        * attaching (linked_launch_id changes) or switching the override
--          off snaps the card to the launch date;
--        * typing a different date on a following card flips it to
--          overridden (the UI rule "committing a value <> launch date sets
--          the override");
--        * typing the launch date back on an overridden card clears the
--          override;
--        * clearing the date on a card attached to a dated launch snaps it
--          back to the launch date (an attached card always has a chain);
--        * unattached => override forced false (this is also what lets the
--          FK ON DELETE SET NULL run when a launch is deleted: cards become
--          unattached with their last date frozen).
--      A launch with no launch_date never overwrites a card's date, and the
--      same typing rule holds there: a date typed on a following card of an
--      undated launch flips it to overridden (so it is not silently replaced
--      once the launch gets a date); clearing it means "follow" again. An
--      explicit override switch-off is respected.
--
-- 2. mkt_launch_skus.pd_project_id (FK ON DELETE SET NULL, partial UNIQUE per
--    launch): launch members stay a separate table (the demand/outcome
--    record). Each attached card has exactly one member row on its launch.
--
-- 3. trg_pd_follow_launch (AFTER UPDATE OF launch_date ON mkt_launches):
--    when a launch's date moves, EVERY following attached card moves with it
--    -- ordered and halted cards included (owner decision 2, so a launch
--    pulled earlier immediately shows whether the order still lands).
--    Overridden cards never move. Each moved card gets one append-only
--    mkt_pd_stage_events row: from_stage = to_stage = its current stage,
--    outcome 'launch_moved' (the outcome CHECK is widened below), meta
--    {launch_id, old_date, new_date}. A launch date set to NULL moves nobody.
--    SECURITY DEFINER (like the other PD triggers) so the follow happens
--    whoever moved the launch.
--
-- 4. rpc_pd_attach_launch(p_project_ids uuid[], p_launch_id uuid)
--    rpc_pd_detach_launch(p_project_id uuid)
--    rpc_pd_set_launch_override(p_project_id uuid, p_override boolean,
--                               p_date date default null)
--    Internal tier (jwt_is_internal: admin/manager/user), the same tier as
--    today's drop_tag / target_launch_date edits, which are direct table
--    updates under the mkt_pd_projects_write RLS policy. SECURITY INVOKER,
--    so that RLS still applies underneath the explicit check.
--    Attach, per card, in array order:
--      - card: linked_launch_id = launch, launch_date_override = false,
--        target_launch_date = launch_date (kept as-is if the launch has no
--        date yet);
--      - member row, first match wins:
--          a. the card already has a row on this launch -> kept;
--          b. a plain row (pd_project_id NULL) on this launch carrying the
--             card's promoted SKU -> claimed;
--          c. a placeholder (sku_id NULL, pd_project_id NULL) whose
--             planned_name case-insensitively equals the card's drop_tag or
--             name -> claimed (earliest sort_order; renamed to the card, or
--             given the card's SKU when promoted);
--          d. the card's row on its previous launch, when that row has no
--             actuals (actual_first_30d_units, sold_out_at NULL) -> moved
--             (planner inputs and factory_order_id travel with it);
--          e. otherwise a new row is appended (sku_id = card.linked_sku_id
--             when promoted, else planned_name = card.name;
--             factory_order_id = card.linked_factory_order_id);
--      - any row the card still has on another launch is released by the
--        detach rule below.
--    Detach: card keeps its current date as its own (linked_launch_id NULL,
--    override false). Its member row is DELETED when actual_first_30d_units,
--    sold_out_at and factory_order_id are all NULL, otherwise only
--    pd_project_id is cleared (the row stays as a plain member record).
--    Override on: keep (or set, when p_date is given) the card's own date.
--    Override off: snap back to the launch date.
--
-- 5. rpc_save_launch (the only launch/member writer; replaces
--    20260827000007_early_access.sql): members may carry pd_project_id.
--      (0) card-backed members not yet on this launch are attached through
--          rpc_pd_attach_launch (create-launch-from-drop is one
--          transaction), then their planner inputs + sort order are written
--          onto the card's row;
--      (a)/(b) real-SKU upsert/delete now skip card-backed rows;
--      (c) only plain planned-name rows (sku_id NULL AND pd_project_id NULL)
--          are replaced wholesale. A planned-name entry that echoes a
--          card-backed row's name (a form that does not send pd_project_id
--          yet) updates that row instead of inserting a duplicate.
--          Legacy rename in place (payload carries no pd_project_id at all):
--          an entry whose working name is new to the launch and that sits at
--          the exact position the form loaded a card row the payload no
--          longer names is that card row renamed -- the row takes the typed
--          name and inputs, no duplicate plain row is created.
--    Card-backed rows are therefore never deleted by a launch edit; only
--    rpc_pd_detach_launch (or deleting the launch/card) removes them.
--
-- 6. rpc_pd_promote_product (replaces 20260827000001): after the card gets
--    its SKU, its member row flips sku_id = new SKU, planned_name NULL (so
--    use-marketing-signals counts the drop as demand).
--    fn_pd_detect_order (replaces 20260827000004) and the manual
--    rpc_pd_link_factory_order (replaces 20260819000001): the card's member
--    row gets factory_order_id when it is empty.
--
-- 7. Owner decision 1: ONE standard buffer -- goods in the warehouse 20 days
--    before a launch. The form default and the PD chain buffer are frontend
--    constants (changed separately). Here: upcoming launches
--    (launch_date >= current_date) whose inventory_ready_by is exactly the
--    old untouched default earliest(early_access_date, launch_date) - 21 move
--    to earliest - 20. Custom values and NULLs are left alone. One NOTICE per
--    change. (Changing inventory_ready_by does not fire the follow trigger.)
--
-- NOT changed: mkt_launches.pd_project_id stays nullable and unused (it
-- cannot hold a four-card drop; not repurposed). fn_pd_gate_missing and the
-- promise snapshot are untouched (they read target_launch_date, which stays
-- physically stored). No automatic linking by name: attaching is always an
-- explicit act. Owners, SECURITY DEFINER/INVOKER and search_path of every
-- replaced function are preserved; grants are restated. RLS is not changed:
-- mkt_launches_read / mkt_launch_skus_read stay USING (true) for any
-- authenticated account (pre-existing), so the new pd_project_id column is
-- readable there too; the cards it points at stay internal-only
-- (mkt_pd_projects_read = jwt_is_internal()). Tightening launch visibility
-- for supplier accounts is a separate change.
--
-- LOCKING: the CLI applies this file in one transaction. lock_timeout makes
-- a blocked lock fail fast (retry later) instead of queueing app traffic, and
-- triggers use CREATE OR REPLACE TRIGGER (PG 14+): on this Supabase instance
-- any DROP TRIGGER, even IF EXISTS on a missing trigger, takes
-- AccessExclusiveLock on ~23 auth/storage/realtime tables until commit.
-- ============================================================================

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. mkt_pd_projects: many cards per launch + override flag
-- ---------------------------------------------------------------------------
ALTER TABLE public.mkt_pd_projects DROP CONSTRAINT IF EXISTS mkt_pd_projects_linked_launch_unique;
CREATE INDEX IF NOT EXISTS ix_mkt_pd_projects_linked_launch
  ON public.mkt_pd_projects (linked_launch_id) WHERE linked_launch_id IS NOT NULL;

ALTER TABLE public.mkt_pd_projects
  ADD COLUMN IF NOT EXISTS launch_date_override boolean NOT NULL DEFAULT false;
ALTER TABLE public.mkt_pd_projects DROP CONSTRAINT IF EXISTS mkt_pd_projects_override_needs_launch;
ALTER TABLE public.mkt_pd_projects ADD CONSTRAINT mkt_pd_projects_override_needs_launch
  CHECK (launch_date_override = false OR linked_launch_id IS NOT NULL);

COMMENT ON COLUMN public.mkt_pd_projects.linked_launch_id IS
  'The launch this card rides (many cards per launch). While attached and not overridden, target_launch_date is kept equal to the launch''s launch_date by the database.';
COMMENT ON COLUMN public.mkt_pd_projects.launch_date_override IS
  'Attached but keeps its own target_launch_date (never moved by the launch). Always false when unattached.';
COMMENT ON COLUMN public.mkt_launches.pd_project_id IS
  'Legacy single-card link; unused. Cards attach via mkt_pd_projects.linked_launch_id + mkt_launch_skus.pd_project_id.';

CREATE OR REPLACE FUNCTION public.fn_pd_launch_date_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_l date;
BEGIN
  IF NEW.linked_launch_id IS NULL THEN
    NEW.launch_date_override := false;
    RETURN NEW;
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

CREATE OR REPLACE TRIGGER trg_pd_launch_date_guard
  BEFORE INSERT OR UPDATE OF target_launch_date, linked_launch_id, launch_date_override
  ON public.mkt_pd_projects
  FOR EACH ROW EXECUTE FUNCTION public.fn_pd_launch_date_guard();

-- ---------------------------------------------------------------------------
-- 2. mkt_launch_skus: one member row per attached card
-- ---------------------------------------------------------------------------
ALTER TABLE public.mkt_launch_skus
  ADD COLUMN IF NOT EXISTS pd_project_id uuid;
ALTER TABLE public.mkt_launch_skus DROP CONSTRAINT IF EXISTS mkt_launch_skus_pd_project_id_fkey;
ALTER TABLE public.mkt_launch_skus ADD CONSTRAINT mkt_launch_skus_pd_project_id_fkey
  FOREIGN KEY (pd_project_id) REFERENCES public.mkt_pd_projects(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_mkt_launch_skus_launch_pd
  ON public.mkt_launch_skus (launch_id, pd_project_id) WHERE pd_project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_mkt_launch_skus_pd_project
  ON public.mkt_launch_skus (pd_project_id) WHERE pd_project_id IS NOT NULL;
COMMENT ON COLUMN public.mkt_launch_skus.pd_project_id IS
  'The PD card this member row stands for (one row per attached card per launch). Managed by rpc_pd_attach_launch / rpc_pd_detach_launch; never deleted by rpc_save_launch.';

-- ---------------------------------------------------------------------------
-- 3. Stage-event outcome admits 'launch_moved'; follow trigger
-- ---------------------------------------------------------------------------
ALTER TABLE public.mkt_pd_stage_events DROP CONSTRAINT IF EXISTS mkt_pd_stage_events_outcome_check;
ALTER TABLE public.mkt_pd_stage_events ADD CONSTRAINT mkt_pd_stage_events_outcome_check
  CHECK (outcome IN ('advance','recycle','kill','revive','archive','link_fo','launch_moved'));

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
       AND target_launch_date IS DISTINCT FROM NEW.launch_date
     ORDER BY created_at
     FOR UPDATE
  LOOP
    UPDATE mkt_pd_projects SET target_launch_date = NEW.launch_date WHERE id = r.id;
    INSERT INTO mkt_pd_stage_events (project_id, from_stage, to_stage, outcome, decided_by, meta)
    VALUES (r.id, r.stage, r.stage, 'launch_moved',
            COALESCE(auth.uid(), '00000000-0000-0000-0000-000000000001'::uuid),
            jsonb_build_object('launch_id', NEW.id,
                               'old_date', r.target_launch_date,
                               'new_date', NEW.launch_date));
  END LOOP;
  RETURN NULL;
END $$;

CREATE OR REPLACE TRIGGER trg_pd_follow_launch
  AFTER UPDATE OF launch_date ON public.mkt_launches
  FOR EACH ROW
  WHEN (OLD.launch_date IS DISTINCT FROM NEW.launch_date AND NEW.launch_date IS NOT NULL)
  EXECUTE FUNCTION public.fn_pd_follow_launch();

-- ---------------------------------------------------------------------------
-- 4. Attach / detach / override RPCs (internal tier)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_pd_attach_launch(p_project_ids uuid[], p_launch_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER
SET search_path TO 'public'
AS $$
DECLARE
  l        mkt_launches%ROWTYPE;
  p        mkt_pd_projects%ROWTYPE;
  v_ids    uuid[];
  v_pid    uuid;
  v_member uuid;
  v_how    text;
  v_old_nm text;
  v_missing uuid[];
  v_n      int := 0;
  v_cards  jsonb := '[]'::jsonb;
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

    UPDATE mkt_pd_projects
       SET linked_launch_id     = p_launch_id,
           launch_date_override = false,
           target_launch_date   = COALESCE(l.launch_date, target_launch_date)
     WHERE id = v_pid;

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
               factory_order_id = COALESCE(factory_order_id, p.linked_factory_order_id)
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
               factory_order_id = COALESCE(factory_order_id, p.linked_factory_order_id)
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
               factory_order_id = COALESCE(factory_order_id, p.linked_factory_order_id)
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
              p.linked_factory_order_id,
              (SELECT coalesce(max(sort_order) + 1, 0) FROM mkt_launch_skus WHERE launch_id = p_launch_id))
      RETURNING id INTO v_member;
    END IF;

    -- release whatever the card still holds on other launches (detach rule)
    DELETE FROM mkt_launch_skus
     WHERE pd_project_id = v_pid AND launch_id <> p_launch_id
       AND actual_first_30d_units IS NULL AND sold_out_at IS NULL AND factory_order_id IS NULL;
    UPDATE mkt_launch_skus SET pd_project_id = NULL
     WHERE pd_project_id = v_pid AND launch_id <> p_launch_id;

    v_n := v_n + 1;
    v_cards := v_cards || jsonb_build_object(
      'project_id', v_pid, 'member_id', v_member, 'member', v_how,
      'replaced', v_old_nm,
      'from_launch_id', p.linked_launch_id,
      'old_target', p.target_launch_date,
      'new_target', COALESCE(l.launch_date, p.target_launch_date));
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'attached', v_n, 'launch_id', p_launch_id,
                            'launch_date', l.launch_date, 'cards', v_cards);
END $$;

CREATE OR REPLACE FUNCTION public.rpc_pd_detach_launch(p_project_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER
SET search_path TO 'public'
AS $$
DECLARE
  p     mkt_pd_projects%ROWTYPE;
  v_del int;
  v_rel int;
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

  -- the card keeps its current date as its own
  UPDATE mkt_pd_projects
     SET linked_launch_id = NULL, launch_date_override = false
   WHERE id = p_project_id;

  WITH d AS (
    DELETE FROM mkt_launch_skus
     WHERE pd_project_id = p_project_id
       AND actual_first_30d_units IS NULL AND sold_out_at IS NULL AND factory_order_id IS NULL
    RETURNING 1)
  SELECT count(*) INTO v_del FROM d;
  WITH r AS (
    UPDATE mkt_launch_skus SET pd_project_id = NULL
     WHERE pd_project_id = p_project_id
    RETURNING 1)
  SELECT count(*) INTO v_rel FROM r;

  RETURN jsonb_build_object('ok', true, 'launch_id', p.linked_launch_id,
                            'target_launch_date', p.target_launch_date,
                            'member', CASE WHEN v_del > 0 THEN 'deleted'
                                           WHEN v_rel > 0 THEN 'released'
                                           ELSE 'none' END);
END $$;

CREATE OR REPLACE FUNCTION public.rpc_pd_set_launch_override(
  p_project_id uuid, p_override boolean, p_date date DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER
SET search_path TO 'public'
AS $$
DECLARE
  p mkt_pd_projects%ROWTYPE;
BEGIN
  IF NOT public.jwt_is_internal() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'internal_only');
  END IF;
  IF p_override IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'override_required'); END IF;
  SELECT * INTO p FROM mkt_pd_projects WHERE id = p_project_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found'); END IF;
  IF p.linked_launch_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'not_attached'); END IF;

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

  SELECT * INTO p FROM mkt_pd_projects WHERE id = p_project_id;
  RETURN jsonb_build_object('ok', true, 'launch_date_override', p.launch_date_override,
                            'target_launch_date', p.target_launch_date);
END $$;

-- ---------------------------------------------------------------------------
-- 5. rpc_save_launch: carries pd_project_id, never deletes card-backed rows
--    (replaces 20260827000007_early_access.sql; SECURITY INVOKER as before)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_save_launch(p_id uuid, p_launch jsonb, p_members jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_id     uuid;
  v_cards  uuid[];
  v_res    jsonb;
  v_pre    uuid[];     -- member row ids in the order the form loaded them
  v_legacy boolean;    -- payload carries no pd_project_id (form not updated yet)
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

  -- p_members NULL → members untouched (e.g. a calendar drag that only
  -- shifts dates). A provided array (even empty) reconciles membership.
  IF p_members IS NOT NULL THEN
    -- Pre-save order (LaunchFormDialog sorts rows by sort_order and sends
    -- them back by position), taken before anything below rewrites it.
    SELECT array_agg(id ORDER BY sort_order, created_at, id) INTO v_pre
      FROM mkt_launch_skus WHERE launch_id = v_id;
    v_legacy := NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_members) e
                             WHERE (e->>'pd_project_id') IS NOT NULL);

    -- (0) Card-backed members (pd_project_id set). Cards not yet on this
    -- launch are attached (same rules as the PD board's attach); then the
    -- planner inputs + position are written onto each card's row. Card rows
    -- are never deleted here — only rpc_pd_detach_launch removes them.
    SELECT array_agg(s.pid ORDER BY s.ord) INTO v_cards
      FROM (SELECT (m->>'pd_project_id')::uuid AS pid, min(ord) AS ord
              FROM jsonb_array_elements(p_members) WITH ORDINALITY AS t(m, ord)
             WHERE (m->>'pd_project_id') IS NOT NULL
             GROUP BY 1) s
     WHERE NOT EXISTS (SELECT 1 FROM mkt_launch_skus k
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

  RETURN v_id;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 6a. Promotion flips the card's member row to the new SKU
--     (replaces 20260827000001_pd_promote_supplier_cost.sql; SECURITY DEFINER)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_pd_promote_product(p_project_id uuid, p_product jsonb)
RETURNS jsonb
-- SECURITY DEFINER: writes product_skus + sku_economics + sku_supplier_costs
-- + mkt_launch_skus + audit_logs in one transaction; the admin gate is
-- jwt_is_admin() on the first line.
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

  -- the quoted cost becomes the SKU's primary supplier cost (brand-new SKU,
  -- so no primary can exist yet)
  IF p.supplier_id IS NOT NULL THEN
    INSERT INTO sku_supplier_costs (sku_id, supplier_id, unit_cost, is_primary, notes)
    VALUES (v_sku_id, p.supplier_id, p.quoted_unit_cost, true, 'Quoted on PD card');
  END IF;

  UPDATE mkt_pd_projects SET linked_sku_id = v_sku_id, sku_code = p_product->>'sku' WHERE id = p_project_id;

  -- the card's launch member row now names the real SKU (demand signals
  -- read sku_id); skipped if that launch somehow already lists the SKU
  UPDATE mkt_launch_skus k
     SET sku_id = v_sku_id, planned_name = NULL
   WHERE k.pd_project_id = p_project_id
     AND k.sku_id IS NULL
     AND NOT EXISTS (SELECT 1 FROM mkt_launch_skus o
                      WHERE o.launch_id = k.launch_id AND o.sku_id = v_sku_id);

  INSERT INTO audit_logs (actor_id, action, target_table, target_id, details)
  VALUES (auth.uid(), 'pd.product_promoted', 'product_skus', v_sku_id,
          jsonb_build_object('project_id', p_project_id, 'sku', p_product->>'sku'));
  RETURN jsonb_build_object('ok', true, 'sku_id', v_sku_id);
END $$;

-- ---------------------------------------------------------------------------
-- 6b. Ordered detection + manual FO link fill the member's factory_order_id
--     (replace 20260827000004_pd_ordered_detection.sql, SECURITY DEFINER, and
--      20260819000001_pd_board_phase1.sql, SECURITY INVOKER)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_pd_detect_order()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  p mkt_pd_projects%ROWTYPE;
BEGIN
  SELECT * INTO p FROM mkt_pd_projects
   WHERE linked_sku_id = NEW.sku_id
     AND linked_factory_order_id IS NULL
     AND archived_at IS NULL
     AND stage = 'ready_for_confirmation'
   ORDER BY created_at
   LIMIT 1
   FOR UPDATE;
  IF NOT FOUND THEN RETURN NEW; END IF;

  UPDATE mkt_pd_projects
     SET linked_factory_order_id = NEW.factory_order_id,
         stage = 'ordered', stage_entered_at = now(), ordered_at = now(), sort_index = 0,
         promise = jsonb_build_object(
           'target_launch_date', p.target_launch_date,
           'msrp', p.msrp, 'quoted_unit_cost', p.quoted_unit_cost,
           'moq_qty', p.moq_qty, 'ordered_at', now())
   WHERE id = p.id;

  UPDATE mkt_launch_skus
     SET factory_order_id = NEW.factory_order_id
   WHERE pd_project_id = p.id AND factory_order_id IS NULL;

  INSERT INTO mkt_pd_stage_events (project_id, from_stage, to_stage, outcome, decided_by, meta)
  VALUES (p.id, p.stage, 'ordered', 'link_fo',
          COALESCE(auth.uid(), '00000000-0000-0000-0000-000000000001'::uuid),
          jsonb_build_object('factory_order_id', NEW.factory_order_id, 'auto', 'factory_order_line'));
  RETURN NEW;
END $$;

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
  UPDATE mkt_launch_skus
     SET factory_order_id = p_factory_order_id
   WHERE pd_project_id = p_project_id AND factory_order_id IS NULL;
  INSERT INTO mkt_pd_stage_events (project_id, from_stage, to_stage, outcome, decided_by, meta)
  VALUES (p_project_id, p.stage, 'ordered', 'link_fo', auth.uid(),
          jsonb_build_object('factory_order_id', p_factory_order_id));
  RETURN jsonb_build_object('ok', true);
END $$;

-- ---------------------------------------------------------------------------
-- Grants (restated for replaced functions; new RPCs at the same level)
-- ---------------------------------------------------------------------------
GRANT EXECUTE ON FUNCTION public.rpc_save_launch(uuid, jsonb, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_pd_promote_product(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_pd_link_factory_order(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_pd_attach_launch(uuid[], uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_pd_detach_launch(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_pd_set_launch_override(uuid, boolean, date) TO authenticated;

-- ---------------------------------------------------------------------------
-- 7. One standard buffer: ready-by = earliest(EA, launch) - 20 (was - 21).
--    Only upcoming launches still on the untouched old default move.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r   record;
  v_n int := 0;
BEGIN
  FOR r IN
    SELECT id, name, launch_date, early_access_date, inventory_ready_by,
           LEAST(early_access_date, launch_date) - 20 AS new_ready_by
      FROM mkt_launches
     WHERE launch_date >= current_date
       AND inventory_ready_by = LEAST(early_access_date, launch_date) - 21
     ORDER BY launch_date
     FOR UPDATE
  LOOP
    UPDATE mkt_launches SET inventory_ready_by = r.new_ready_by WHERE id = r.id;
    RAISE NOTICE 'ready-by 20-day standard: "%" (launch %, early access %): % -> %',
      r.name, r.launch_date, coalesce(r.early_access_date::text, 'none'),
      r.inventory_ready_by, r.new_ready_by;
    v_n := v_n + 1;
  END LOOP;
  RAISE NOTICE 'ready-by 20-day standard: % launch(es) changed', v_n;
END $$;
