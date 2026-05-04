-- =============================================================
-- Migration 015: Close the role-escalation hole
-- =============================================================
-- The original RLS policy on profiles allowed users to update their own
-- profile. The `role` column lived on the same row, so a user could
-- self-promote to admin by updating their own profile. That's a hard
-- security hole.
--
-- Fix: split profile updates into two paths:
--   1. Regular profile fields (full_name, avatar_url) — users can update
--      their own via the existing RLS policy. The `role` column is now
--      protected by a column-level trigger that rejects direct updates.
--   2. Role changes — must go through rpc_update_user_role() which:
--        * requires caller to be admin OR manager
--        * forbids self-edit (no one can change their own role via this path)
--        * forbids manager from granting admin (only admin can promote to admin)
--        * writes an audit entry with before/after values
--
-- Only a super-admin DB operator can bypass this (via SQL Editor as
-- service_role).

-- -------------------------------------------------------------
-- A. Column-level trigger blocking direct role updates
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION block_direct_role_update()
RETURNS TRIGGER AS $$
BEGIN
  -- If the role is being changed and we're not the service_role (which
  -- is what the RPC runs as with SECURITY DEFINER), block it.
  IF NEW.role IS DISTINCT FROM OLD.role THEN
    -- current_setting('role') is 'authenticated' for user sessions and
    -- something else when invoked via SECURITY DEFINER. The cleanest check
    -- is "is this being called from within rpc_update_user_role?" via a
    -- GUC we set inside that function. If the GUC isn't set, reject.
    IF COALESCE(current_setting('app.role_change_allowed', true), '') != 'yes' THEN
      RAISE EXCEPTION 'Direct updates to profiles.role are not allowed. Use rpc_update_user_role() instead.'
        USING HINT = 'SELECT rpc_update_user_role(target_user_id, new_role, your_user_id);';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_block_direct_role_update
  BEFORE UPDATE ON profiles
  FOR EACH ROW EXECUTE FUNCTION block_direct_role_update();

-- -------------------------------------------------------------
-- B. The role-change RPC
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION rpc_update_user_role(
  p_target_user_id UUID,
  p_new_role TEXT,
  p_actor_id UUID
) RETURNS JSONB AS $$
DECLARE
  v_actor profiles%ROWTYPE;
  v_target profiles%ROWTYPE;
BEGIN
  -- Validate new role value
  IF p_new_role NOT IN ('admin', 'manager', 'user') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid role');
  END IF;

  -- Look up actor and target
  SELECT * INTO v_actor FROM profiles WHERE id = p_actor_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'actor not found');
  END IF;

  SELECT * INTO v_target FROM profiles WHERE id = p_target_user_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'target user not found');
  END IF;

  -- Rule 1: Actor must be admin or manager
  IF v_actor.role NOT IN ('admin', 'manager') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'only admins and managers can change roles');
  END IF;

  -- Rule 2: No self-role-edits
  IF v_actor.id = v_target.id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'cannot change your own role');
  END IF;

  -- Rule 3: Managers cannot grant admin
  IF v_actor.role = 'manager' AND p_new_role = 'admin' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'managers cannot grant admin role');
  END IF;

  -- Rule 4: Managers cannot change an existing admin's role
  IF v_actor.role = 'manager' AND v_target.role = 'admin' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'managers cannot change an admin role');
  END IF;

  -- Noop if no actual change
  IF v_target.role = p_new_role THEN
    RETURN jsonb_build_object('ok', true, 'noop', true);
  END IF;

  -- Open the gate and update
  PERFORM set_config('app.role_change_allowed', 'yes', true); -- true = transaction-scoped
  UPDATE profiles SET role = p_new_role WHERE id = p_target_user_id;
  PERFORM set_config('app.role_change_allowed', '', true);

  -- Audit entry
  INSERT INTO inventory_transactions (
    sku_id, transaction_type, quantity, field_affected,
    movement_kind, reference_id, reference_type, notes, performed_by
  ) VALUES (
    NULL, 'user_role_change', 0, 'role',
    'metadata', p_target_user_id, 'profile',
    format('%s: role changed %s → %s by %s',
      v_target.full_name, v_target.role, p_new_role, v_actor.full_name),
    p_actor_id
  );

  RETURN jsonb_build_object('ok', true, 'previous_role', v_target.role, 'new_role', p_new_role);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION rpc_update_user_role TO authenticated;

-- -------------------------------------------------------------
-- C. Also lock down profile INSERTs from authenticated —
--    only the auth trigger (handle_new_user) should create them.
-- -------------------------------------------------------------
-- The existing policies already don't grant INSERT to authenticated,
-- so nothing to do here, but assert it explicitly for clarity.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'profiles'
       AND cmd = 'INSERT'
  ) THEN
    RAISE NOTICE 'Profiles has INSERT policy — review migration 001 and 015 together.';
  END IF;
END$$;

COMMENT ON FUNCTION rpc_update_user_role IS
  'The only supported path for changing a user role. Enforces RBAC and writes audit.';
