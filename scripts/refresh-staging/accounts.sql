-- =============================================================
-- accounts.sql - staging accounts step (design 3.1 step 3, runbook step 3)
-- =============================================================
-- Runs on STAGING only, by refresh.py, after `suppliers` has been copied
-- (profiles.supplier_id references it) and after the migrations that
-- create profiles, handle_new_user and the role guard have been applied.
--
-- Why this exists: copied rows point at profiles (performed_by, created_by,
-- received_by). Those foreign keys only hold if staging has a profile with
-- the SAME uuid as production, and a profile needs an auth user. So:
--   * every production profile gets a staging auth user with its production
--     uuid and the shared practice password (STAGING_PRACTICE_PASSWORD);
--   * the system actor 00000000-0000-0000-0000-000000000001 gets one too,
--     with NO password, so nobody can sign in as it;
--   * staging-only logins that already exist (the owner's staging login,
--     the pilot supplier accounts) keep their auth rows and passwords; only
--     their profiles are re-created, from a snapshot taken before the
--     public schema was dropped;
--   * roles, names, active flags and supplier links are mirrored with the
--     role-guard trigger switched off around the one UPDATE.
-- A staging login whose email equals a production profile email but whose
-- uuid differs is replaced by the production uuid (and the practice
-- password), because the foreign keys need the production uuid.
--
-- Placeholders are replaced by refresh.py with ready-made SQL literals:
--   {{PRACTICE_PASSWORD}}  text literal, read from .env.local, never logged
--   {{SYSTEM_ACTOR_ID}}    text literal, the system actor uuid
--   {{PROD_PROFILES}}      text literal holding a JSON array read from production
--   {{KEEP_ACCOUNTS}}      text literal holding a JSON array of staging-only logins
-- Sections are separate API calls, run in the order they appear.

-- @@ auth_trigger stg
-- public was dropped, which dropped the trigger on auth.users with it.
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- @@ accounts stg
DO $accounts$
DECLARE
  v_hash  text := extensions.crypt({{PRACTICE_PASSWORD}}, extensions.gen_salt('bf'));
  v_actor uuid := {{SYSTEM_ACTOR_ID}}::uuid;
  v_col   text;
BEGIN
  CREATE TEMP TABLE _wanted (
    id            uuid PRIMARY KEY,
    profile_email text    NOT NULL,
    auth_email    text    NOT NULL,
    full_name     text    NOT NULL,
    role          text    NOT NULL,
    is_active     boolean NOT NULL,
    supplier_id   uuid,
    origin        text    NOT NULL,
    has_password  boolean NOT NULL
  ) ON COMMIT DROP;

  -- 1. production profiles
  INSERT INTO _wanted
  SELECT p.id, p.email, p.email, p.full_name, p.role, coalesce(p.is_active, true),
         p.supplier_id, 'production', true
    FROM jsonb_to_recordset({{PROD_PROFILES}}::jsonb)
         AS p(id uuid, email text, full_name text, role text, is_active boolean, supplier_id uuid);

  -- 2. the system actor (production's auth user is system@internal.freezepipe;
  --    its profile email is system@internal). No password, no identity.
  INSERT INTO _wanted
  VALUES (v_actor, 'system@internal', 'system@internal.freezepipe', 'System (automated)',
          'admin', true, NULL, 'system', false)
  ON CONFLICT (id) DO NOTHING;

  UPDATE _wanted
     SET auth_email = 'system@internal.freezepipe', has_password = false, origin = 'system'
   WHERE id = v_actor;

  -- 3. staging-only logins that still exist in auth.users
  INSERT INTO _wanted
  SELECT s.id, s.email, s.email, s.full_name, s.role, coalesce(s.is_active, true),
         s.supplier_id, 'staging_only', true
    FROM jsonb_to_recordset({{KEEP_ACCOUNTS}}::jsonb)
         AS s(id uuid, email text, full_name text, role text, is_active boolean, supplier_id uuid)
   WHERE EXISTS (SELECT 1 FROM auth.users u WHERE u.id = s.id)
     AND NOT EXISTS (SELECT 1 FROM _wanted w
                      WHERE w.id = s.id OR lower(w.auth_email) = lower(s.email));

  -- 4. a staging login with a production email but another uuid is replaced
  DELETE FROM auth.users u
   USING _wanted w
   WHERE w.origin <> 'staging_only'
     AND lower(u.email) = lower(w.auth_email)
     AND u.id <> w.id;

  -- 5. auth users with the production uuids; the on_auth_user_created trigger
  --    creates each profile with role 'user' (mirrored in step 10)
  INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                          raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  SELECT '00000000-0000-0000-0000-000000000000'::uuid, w.id, 'authenticated', 'authenticated', w.auth_email,
         CASE WHEN w.has_password THEN v_hash ELSE '' END, now(),
         '{"provider":"email","providers":["email"]}'::jsonb,
         jsonb_build_object('full_name', w.full_name), now(), now()
    FROM _wanted w
   WHERE w.origin <> 'staging_only'
     AND NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = w.id);

  -- 6. one shared practice password for every mirrored production login
  UPDATE auth.users u
     SET encrypted_password = v_hash,
         email_confirmed_at = coalesce(u.email_confirmed_at, now()),
         updated_at = now()
    FROM _wanted w
   WHERE u.id = w.id AND w.origin = 'production' AND w.has_password;

  -- 7. GoTrue cannot read NULL in its token columns (sign-in fails with
  --    "converting NULL to string"); fill whichever of them this version has
  FOREACH v_col IN ARRAY ARRAY['confirmation_token', 'recovery_token', 'email_change',
                               'email_change_token_new', 'email_change_token_current',
                               'phone_change', 'phone_change_token', 'reauthentication_token'] LOOP
    IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'auth' AND table_name = 'users' AND column_name = v_col) THEN
      EXECUTE format('UPDATE auth.users u SET %1$I = coalesce(u.%1$I, '''') FROM _wanted w '
                     'WHERE u.id = w.id AND w.origin <> ''staging_only''', v_col);
    END IF;
  END LOOP;

  -- 8. email identities, so password sign-in works
  INSERT INTO auth.identities (id, user_id, provider_id, identity_data, provider,
                               last_sign_in_at, created_at, updated_at)
  SELECT gen_random_uuid(), u.id, u.id::text,
         jsonb_build_object('sub', u.id::text, 'email', u.email,
                            'email_verified', true, 'phone_verified', false),
         'email', now(), now(), now()
    FROM auth.users u
    JOIN _wanted w ON w.id = u.id
   WHERE w.has_password AND w.origin <> 'staging_only'
     AND NOT EXISTS (SELECT 1 FROM auth.identities i WHERE i.user_id = u.id AND i.provider = 'email');

  -- 9. profiles for pre-existing logins (the trigger only fires on insert)
  INSERT INTO public.profiles (id, email, full_name, role)
  SELECT u.id, u.email, coalesce(u.raw_user_meta_data->>'full_name', u.email), 'user'
    FROM auth.users u
   WHERE u.email IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = u.id);

  -- 10. mirror roles, names, active flags and supplier links with the
  --     role guard (block_direct_role_update) disabled around the update
  ALTER TABLE public.profiles DISABLE TRIGGER trg_block_direct_role_update;
  UPDATE public.profiles p
     SET email = w.profile_email, full_name = w.full_name, role = w.role,
         is_active = w.is_active, supplier_id = w.supplier_id
    FROM _wanted w
   WHERE p.id = w.id;
  ALTER TABLE public.profiles ENABLE TRIGGER trg_block_direct_role_update;

  IF EXISTS (SELECT 1 FROM _wanted w
              WHERE NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = w.id AND p.role = w.role)) THEN
    RAISE EXCEPTION 'accounts: a wanted profile is missing or has the wrong role after the mirror step';
  END IF;
END
$accounts$;

-- @@ guard_restore stg
-- Belt and braces: run again by refresh.py whatever happened above.
ALTER TABLE public.profiles ENABLE TRIGGER trg_block_direct_role_update;
