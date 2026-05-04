-- =============================================================
-- Migration 023: handle_new_user search_path fix
-- =============================================================
-- Root cause captured: the handle_new_user trigger from migration 001 is
-- SECURITY DEFINER but did NOT set search_path. When called from
-- auth.admin.createUser (service-role path), Postgres uses the session
-- search_path from auth-server internals, which doesn't include `public`.
-- The INSERT INTO profiles fails with "relation profiles does not exist",
-- surfacing as a generic "Database error creating new user" HTTP 500 from
-- the Supabase Auth Admin API.
--
-- Fix: SET search_path = public, pg_temp on the function. Applied in-place
-- against staging during pilot setup (2026-04-22). This migration
-- reproduces the patch for fresh deploys so the bug can't regress.
--
-- Why `public, pg_temp` specifically:
--   - `public` is where profiles lives.
--   - `pg_temp` is always first in a normal session search_path. Including
--     it explicitly avoids surprising behavior if someone ever creates a
--     pg_temp.profiles.
--   - We deliberately exclude the caller's original search_path because a
--     SECURITY DEFINER function with an open search_path is a vector for
--     search_path hijack attacks.

CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO profiles (id, email, full_name, role)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.email),
    'user'
  );
  RETURN NEW;
END;
$$;

-- Trigger from migration 001 already references this function by name and
-- auto-picks up the new body — no need to re-CREATE the trigger.

COMMENT ON FUNCTION handle_new_user IS
  'Creates a matching profiles row on auth.users INSERT. SECURITY DEFINER with an explicit search_path to work when invoked from the Auth Admin API (migration 023 fix).';
