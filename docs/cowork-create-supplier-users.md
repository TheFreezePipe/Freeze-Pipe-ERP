# Cowork prompt — create pre-configured Nancy + YX supplier users

Paste everything below into Cowork.

---

# Task: create two supplier users directly (no invite flow)

Skip the magic-link invite flow entirely. Create `nancy@freezepipe.test` and `yx@freezepipe.test` as confirmed auth users with known passwords, wire their profiles to role=`supplier` + the right `supplier_id`, and clean up the retired Edge Function.

## Step 1 — Create the two auth users via the Admin API

Use `auth.admin.createUser` (service role). Set `email_confirm: true` so they can log in immediately without email verification. Set the passwords verbatim.

```
POST /auth/v1/admin/users
{
  "email": "nancy@freezepipe.test",
  "password": "PilotNancy2026!",
  "email_confirm": true,
  "user_metadata": { "full_name": "Nancy (Pilot)" }
}
```

```
POST /auth/v1/admin/users
{
  "email": "yx@freezepipe.test",
  "password": "PilotYX2026!",
  "email_confirm": true,
  "user_metadata": { "full_name": "YX (Pilot)" }
}
```

Capture the `id` from each response — that's the auth user UUID. You'll need it for Step 2.

## Step 2 — Upsert profiles linked to the supplier orgs

For each user, make sure there's a row in `public.profiles` with `role='supplier'`, `is_active=true`, and `supplier_id` pointing at the right supplier. The `handle_new_user` trigger may have auto-created a profile with `role='user'` on the insert; use UPSERT to force the correct values regardless.

Supplier UUIDs (from migration 017):
- Nancy: `00000000-0000-0000-0000-000000000201`
- YX: `00000000-0000-0000-0000-000000000202`

```sql
-- Replace <NANCY_AUTH_ID> / <YX_AUTH_ID> with the ids returned from Step 1.

INSERT INTO profiles (id, email, full_name, role, supplier_id, is_active)
VALUES (
  '<NANCY_AUTH_ID>'::uuid,
  'nancy@freezepipe.test',
  'Nancy (Pilot)',
  'supplier',
  '00000000-0000-0000-0000-000000000201'::uuid,
  true
)
ON CONFLICT (id) DO UPDATE
  SET role        = 'supplier',
      supplier_id = EXCLUDED.supplier_id,
      is_active   = true,
      full_name   = EXCLUDED.full_name;

INSERT INTO profiles (id, email, full_name, role, supplier_id, is_active)
VALUES (
  '<YX_AUTH_ID>'::uuid,
  'yx@freezepipe.test',
  'YX (Pilot)',
  'supplier',
  '00000000-0000-0000-0000-000000000202'::uuid,
  true
)
ON CONFLICT (id) DO UPDATE
  SET role        = 'supplier',
      supplier_id = EXCLUDED.supplier_id,
      is_active   = true,
      full_name   = EXCLUDED.full_name;

-- Verify
SELECT p.email, p.role, p.is_active, s.code AS supplier_code
  FROM profiles p
  LEFT JOIN suppliers s ON s.id = p.supplier_id
 WHERE p.email IN ('nancy@freezepipe.test', 'yx@freezepipe.test')
 ORDER BY p.email;
```

Expected output: two rows, both `role = supplier`, `is_active = true`, supplier codes `NANCY` and `YX` respectively.

## Step 3 — Delete the retired Edge Function

The `invite-supplier-user` function is being retired — we don't need it anymore.

```
DELETE /v1/projects/{ref}/functions/invite-supplier-user
```

Or via CLI if you have it:
```
supabase functions delete invite-supplier-user
```

If it's already gone, ignore the "not found" response.

## Report back

1. The two auth user IDs from Step 1.
2. The verify-query output from Step 2.
3. Confirmation the function is deleted (or confirmation it was already gone).

If anything fails, stop and report the exact error — don't try to work around it.

---

## Login credentials (for your reference — not to share with Cowork)

Once Cowork confirms:

| Role   | Email                    | Password           |
|--------|--------------------------|--------------------|
| Nancy  | `nancy@freezepipe.test`  | `PilotNancy2026!`  |
| YX     | `yx@freezepipe.test`     | `PilotYX2026!`     |

Log in via the normal `/login` screen. Each account auto-lands on `/supplier`.
