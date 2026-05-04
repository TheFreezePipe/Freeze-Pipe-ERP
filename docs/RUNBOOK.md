# Operations Runbook — Freeze Pipe ERP

Single source of truth for "how do I do X in production." Live document — update as the system evolves.

## Stack at a glance

| Layer | Provider | Notes |
|---|---|---|
| Frontend | Vercel (free) | Auto-deploys from `main` branch |
| Database / Auth / Edge Functions | Supabase (Pro tier recommended) | Project ref: see `supabase/config.toml` |
| Email (transactional + invites) | Resend (free 3k/mo) | Configured in Supabase Auth → SMTP |
| Error tracking | Sentry (free 5k events/mo) | DSN set as `VITE_SENTRY_DSN` in Vercel |
| Source | GitHub | Private repo |

## Environments

- **Dev** — local, `VITE_APP_ENV=dev`, may run in demo mode without Supabase creds.
- **Prod** — Vercel deployment of `main`, `VITE_APP_ENV=prod`, hard-fails to boot without real Supabase creds (`src/lib/env.ts`).
- No staging today. Add one if release cadence demands it.

## Required env vars (Vercel)

| Name | Required | Notes |
|---|---|---|
| `VITE_SUPABASE_URL` | yes | `https://<ref>.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | yes | Public anon key from Supabase dashboard |
| `VITE_APP_ENV` | yes | Set to `prod` for the production deployment |
| `VITE_SENTRY_DSN` | optional | If absent, Sentry stays inert (no error tracking) |

## Required env vars (Supabase Edge Functions)

Set via `supabase secrets set --env-file ./functions.env --project-ref <ref>` or the dashboard.

| Name | Required by | Notes |
|---|---|---|
| `SUPABASE_URL` | all | Auto-populated by Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | all | Auto-populated by Supabase |
| `SUPABASE_ANON_KEY` | invite-user | Auto-populated by Supabase |
| `SITE_URL` | invite-user | Production URL — invitee redirect target |
| `MAERSK_API_KEY` | tracking-reconcile | Optional; absent → carrier mock |
| `FEDEX_API_KEY` / `FEDEX_API_SECRET` | tracking-reconcile | Optional |
| `DHL_API_KEY` | tracking-reconcile | Optional |
| `SHIPSTATION_API_KEY` / `SHIPSTATION_API_SECRET` | shipstation-webhook | Required if ShipStation integration is live |

## Deploy procedures

### Frontend

Vercel watches `main`. Push to `main` → auto-deploy. PRs build a preview URL.

To roll back:
- Vercel dashboard → Deployments → pick the last known-good build → "Promote to Production."

To deploy without auto-deploy (e.g. emergency hotfix):
- `vercel --prod` from local with the Vercel CLI authenticated.

### Database migrations

Cowork-driven via the MCP integration. Each migration is a file in `supabase/migrations/<timestamp>_<name>.sql`.

Workflow:
1. Author the migration locally; verify `tsc --noEmit` clean.
2. Compose a Cowork prompt that runs the migration in a transaction with sanity guards.
3. Append a row to `supabase_migrations.schema_migrations` so the ledger stays consistent.
4. After deploy: regenerate types via `supabase gen types typescript --project-id <ref> --schema public > src/lib/database.types.ts` and verify `tsc --noEmit` still passes.

To roll back a migration:
- For pure DDL (CREATE / ALTER): write a forward-only "undo" migration that reverses the change.
- For data changes: Supabase Pro tier has Point-in-Time Recovery — restore to the second before the bad migration applied.
- Never `DELETE FROM supabase_migrations.schema_migrations` to "redo" a migration. Write a new one that adjusts forward.

### Edge functions

```bash
# From repo root, with Supabase CLI logged in:
supabase functions deploy invite-user --project-ref <ref>
supabase functions deploy tracking-reconcile --project-ref <ref>
supabase functions deploy shipstation-webhook --project-ref <ref>
supabase functions deploy shipstation-reconcile --project-ref <ref>
```

Functions are independent — deploy individually as needed. Test locally with `supabase functions serve <name>`.

## User management

### Inviting a user

1. Sign in as admin or manager.
2. Settings → User Management → "Invite user" (top right).
3. Email + full name + role (+ supplier when role is `supplier`).
4. Click "Send invite." They receive an email with a sign-in link.
5. On first sign-in, their profile is already correctly shaped (role + supplier_id pre-applied by the edge function).

If invite fails with "user already exists" — the email is on file. Use the role editor on their existing row to promote them instead.

### Promoting an existing user to supplier

Settings → User Management → "Promote to supplier" on the user's row → pick supplier.

### Deactivating a user

Settings → User Management → flip the active/inactive toggle on the user's row. Their session is invalidated on next page load; the auth.users row stays so audit history remains attributable.

### Roles in plain English

- **admin** — full access. Can promote, deactivate, edit anything.
- **manager** — like admin but cannot grant the `admin` role or modify admins.
- **user** — internal staff, read everything, write through the standard UI flows.
- **supplier** — external partner. RLS scopes them to rows where `supplier_id ∈ jwt_supplier_scope()`.

## Common operational tasks

### "Why didn't this email arrive?"

1. Supabase dashboard → Auth → Logs → filter by recipient email.
2. If it sent: check spam folder, check Resend dashboard for bounce.
3. If it didn't send: check Resend dashboard for delivery errors / quota exhaustion.

### "Why isn't this user seeing the data they should?"

Most often RLS. Check:
1. Their `profiles.role` is what you expect (`SELECT role, supplier_id FROM profiles WHERE email = …`).
2. Their session token's `sub` claim matches the profile id (sign them out + back in if you suspect a stale session).
3. If supplier role: their `supplier_id` is set, and `consolidates_for` covers any orders they should see for other suppliers.

### "An order was deleted by mistake — can we recover it?"

- Within Supabase PITR window (Pro tier: 7 days default): restore to the second before the delete via dashboard → Database → Backups.
- Beyond PITR: lost. `inventory_transactions` rows referencing that order survive (per migration 056's documented dangling-ref pattern), so you can audit-replay what existed but not literally restore the row.

### "Migration applied but I don't see it on the frontend"

1. Did types regen? Check `src/lib/database.types.ts` for the new column / function.
2. Did the frontend redeploy? Vercel dashboard → check the build that ran after types regen.
3. Hard-refresh the browser to bust the React Query cache (or close and reopen the tab).

## Failure-mode runbook

### Vercel deploy failed

- Check the failed build's logs. Most common: `tsc` errors from a missing types regen, or a missing env var.
- Roll back to last good build in the Vercel UI while you fix.

### Edge function crashing

- Supabase dashboard → Edge Functions → logs.
- Most common: missing secret, expired API key, or upstream API rate limit.

### Database is slow / connections maxed out

- Supabase dashboard → Reports → Database → connections.
- Check for long-running transactions (likely a stuck Cowork session or a runaway query).
- Connection pool is exhausted? Bump the pool size on Pro tier, or kill the offending session.

### "Everything is broken"

1. Vercel: roll back the frontend to the last known good deploy.
2. Supabase: check if a migration just ran — if so, PITR-restore to before it.
3. Sentry: check the error feed for the trigger event.
4. Page someone (or yourself) and start debugging from the Sentry stack trace.

## Pre-flight before tagging a release

- [ ] `tsc --noEmit` clean
- [ ] `npm test` passing
- [ ] `npm run build` succeeds locally
- [ ] All migrations through current commit are deployed to prod
- [ ] Generated types match prod schema (`supabase gen types`)
- [ ] No console errors when running `npm run preview` against prod env vars
- [ ] Smoke test: login as admin, place a factory order, check the audit log shows it
