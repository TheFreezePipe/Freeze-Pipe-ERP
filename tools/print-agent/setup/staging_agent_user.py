#!/usr/bin/env python3
"""Create (or repair) the print-agent login on STAGING and write tools/print-agent/.env.

  python tools/print-agent/setup/staging_agent_user.py             # create if missing, keep an existing password
  python tools/print-agent/setup/staging_agent_user.py --rotate    # new password, rewrite .env

What it does, as the database owner through scripts/staging/mgmt.py (the Management API):
  1. auth.users + an email identity for print-agent@freezepipe.test (password sign-in, email confirmed);
     the on_auth_user_created trigger makes its profile (role 'user', so it can read the warehouse tables);
  2. profiles.is_print_agent = true (only the owner can set it: a trigger refuses it from client sessions),
     full_name 'Print agent';
  3. tools/print-agent/.env with SUPABASE_URL and SUPABASE_ANON_KEY (from .env.local's VITE_ values, which
     must point at staging), AGENT_EMAIL, AGENT_PASSWORD and AGENT_ID.

The password is random (secrets.token_urlsafe), lives only in memory and in tools/print-agent/.env (git-ignored),
and is never printed, logged or put on a command line. Like scripts/refresh-staging/accounts.sql it is hashed by
pgcrypto inside the SQL sent to the Management API over TLS. Re-run after a staging --rebuild: the rebuild keeps the
login but recreates its profile without the flag.

STAGING ONLY: mgmt.STG; the production ref is refused.
"""
import argparse
import os
import re
import secrets
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
AGENT_DIR = os.path.dirname(HERE)
REPO = os.path.dirname(os.path.dirname(AGENT_DIR))
sys.path.insert(0, os.path.join(REPO, "scripts", "staging"))
import mgmt  # noqa: E402

ENV_LOCAL = os.path.join(REPO, ".env.local")
ENV_AGENT = os.path.join(AGENT_DIR, ".env")


def read_env(path):
    if not os.path.exists(path):
        return {}
    text = open(path, encoding="utf-8").read()
    return {k: v.strip().strip('"').strip("'") for k, v in re.findall(r"^([A-Z_][A-Z0-9_]*)=(.*)$", text, re.M)}


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--email", default="print-agent@freezepipe.test")
    ap.add_argument("--agent-id", default="agent-dev")
    ap.add_argument("--rotate", action="store_true", help="set a new password and rewrite .env")
    args = ap.parse_args()

    ref = mgmt.STG
    if ref == mgmt.PROD or ref == "pnqujtugddxusllkikje":
        print("Refusing: this script only runs against staging.")
        return 4

    local = read_env(ENV_LOCAL)
    url = local.get("VITE_SUPABASE_URL", "")
    anon = local.get("VITE_SUPABASE_ANON_KEY", "")
    if f"https://{ref}.supabase.co" != url.rstrip("/"):
        print("Refusing: .env.local's VITE_SUPABASE_URL is not the staging project, so .env would point elsewhere.")
        return 4
    if not anon:
        print("Refusing: .env.local has no VITE_SUPABASE_ANON_KEY.")
        return 4
    if not re.fullmatch(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", args.email):
        print("That email does not look valid.")
        return 2
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,60}", args.agent_id):
        print("--agent-id: letters, digits, dot, dash or underscore.")
        return 2

    existing = mgmt.q(f"SELECT id FROM auth.users WHERE lower(email) = lower({mgmt.lit(args.email)})", ref)
    current = read_env(ENV_AGENT)
    keep = bool(existing) and bool(current.get("AGENT_PASSWORD")) and current.get("AGENT_EMAIL", "").lower() == args.email.lower() and not args.rotate
    password = None if keep else secrets.token_urlsafe(24)

    pw_sql = "NULL" if password is None else mgmt.lit(password)
    sql = f"""
DO $agent$
DECLARE
  v_email text := {mgmt.lit(args.email)};
  v_pw    text := {pw_sql};
  v_id    uuid;
  v_col   text;
BEGIN
  SELECT id INTO v_id FROM auth.users WHERE lower(email) = lower(v_email);
  IF v_id IS NULL THEN
    v_id := gen_random_uuid();
    INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                            raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    VALUES ('00000000-0000-0000-0000-000000000000'::uuid, v_id, 'authenticated', 'authenticated', v_email,
            extensions.crypt(v_pw, extensions.gen_salt('bf')), now(),
            '{{"provider":"email","providers":["email"]}}'::jsonb, '{{"full_name":"Print agent"}}'::jsonb, now(), now());
  ELSIF v_pw IS NOT NULL THEN
    UPDATE auth.users
       SET encrypted_password = extensions.crypt(v_pw, extensions.gen_salt('bf')),
           email_confirmed_at = coalesce(email_confirmed_at, now()), updated_at = now()
     WHERE id = v_id;
  END IF;

  -- GoTrue cannot read NULL token columns (sign-in fails "converting NULL to string")
  FOREACH v_col IN ARRAY ARRAY['confirmation_token', 'recovery_token', 'email_change', 'email_change_token_new',
                               'email_change_token_current', 'phone_change', 'phone_change_token',
                               'reauthentication_token'] LOOP
    IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'auth' AND table_name = 'users' AND column_name = v_col) THEN
      EXECUTE format('UPDATE auth.users SET %1$I = coalesce(%1$I, '''') WHERE id = $1', v_col) USING v_id;
    END IF;
  END LOOP;

  INSERT INTO auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
  SELECT gen_random_uuid(), u.id, u.id::text,
         jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true, 'phone_verified', false),
         'email', now(), now(), now()
    FROM auth.users u
   WHERE u.id = v_id
     AND NOT EXISTS (SELECT 1 FROM auth.identities i WHERE i.user_id = u.id AND i.provider = 'email');

  INSERT INTO public.profiles (id, email, full_name, role)
  VALUES (v_id, v_email, 'Print agent', 'user')
  ON CONFLICT (id) DO NOTHING;

  -- the owner session may set the flag; client sessions are refused by trg_block_client_print_agent_change
  UPDATE public.profiles SET is_print_agent = true, is_active = true, full_name = 'Print agent' WHERE id = v_id;
END
$agent$;
SELECT p.id, p.email, p.role, p.is_active, p.is_print_agent
  FROM public.profiles p JOIN auth.users u ON u.id = p.id
 WHERE lower(u.email) = lower({mgmt.lit(args.email)});
"""
    try:
        rows = mgmt.q(sql, ref)
    except Exception as e:  # never echo the statement (it holds the password)
        msg = str(e)
        if password:
            msg = msg.replace(password, "***")
        print("Staging call failed: " + msg[:500])
        return 1
    if not rows or not rows[0].get("is_print_agent"):
        print("The profile was not flagged; check the trigger and profiles table.")
        return 1
    row = rows[0]

    if password is not None:
        extra = {k: v for k, v in current.items()
                 if k not in ("SUPABASE_URL", "SUPABASE_ANON_KEY", "AGENT_EMAIL", "AGENT_PASSWORD", "AGENT_ID")}
        lines = [
            "# Written by setup/staging_agent_user.py for STAGING. Git-ignored; never commit or share.",
            f"SUPABASE_URL={url.rstrip('/')}",
            f"SUPABASE_ANON_KEY={anon}",
            f"AGENT_EMAIL={args.email}",
            f"AGENT_PASSWORD={password}",
            f"AGENT_ID={current.get('AGENT_ID') or args.agent_id}",
        ] + [f"{k}={v}" for k, v in extra.items()]
        with open(ENV_AGENT, "w", encoding="utf-8", newline="\n") as f:
            f.write("\n".join(lines) + "\n")
        written = "written (password not shown)"
    else:
        written = "kept (existing password; --rotate to replace it)"

    print(f"print-agent user {row['email']} ({row['id']}): role {row['role']}, active {row['is_active']}, "
          f"is_print_agent {row['is_print_agent']}. tools/print-agent/.env {written}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
