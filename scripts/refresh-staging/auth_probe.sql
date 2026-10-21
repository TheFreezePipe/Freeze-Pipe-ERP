-- =============================================================
-- auth_probe.sql - check 4 (auth trigger), STAGING only, always rolls back
-- =============================================================
-- Design 3.1 check 4 says "sign up a throwaway user: profile created, role
-- user". The GoTrue sign-up endpoint is not reachable through the
-- Management API, so this inserts a throwaway row into auth.users inside a
-- DO block, reads the profile the on_auth_user_created trigger made, and
-- then RAISES, so the whole block (insert, profile, anything else) is rolled
-- back and nothing is left behind. refresh.py reads the marker out of the
-- error text. If the trigger is missing the marker says profile_role=none.

-- @@ probe stg
DO $probe$
DECLARE
  v_id   uuid := gen_random_uuid();
  v_role text;
BEGIN
  INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                          raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  VALUES ('00000000-0000-0000-0000-000000000000'::uuid, v_id, 'authenticated', 'authenticated',
          'refresh-probe-' || v_id::text || '@example.com', '', now(),
          '{}'::jsonb, '{}'::jsonb, now(), now());
  SELECT p.role INTO v_role FROM public.profiles p WHERE p.id = v_id;
  RAISE EXCEPTION 'REFRESH_PROBE profile_role=%', coalesce(v_role, 'none');
END
$probe$;
