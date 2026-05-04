# Supabase Setup — Step-by-Step Runbook

This is the walkthrough for standing up Supabase for the Freeze Pipe ERP.
Start with one **dev** project (free tier is fine). Add staging + prod later
per [ENVIRONMENTS.md](ENVIRONMENTS.md).

Time budget: **30-60 minutes** for the first project, end to end.

---

## Prerequisites

- [x] A Supabase account (create at https://supabase.com if you don't have one)
- [x] Node.js 20+ (you've got it — used for Vite already)
- [x] Supabase CLI installed in this project (`npm install --save-dev supabase` — done)
- [ ] A ShipStation account (for later integration setup)
- [ ] A Homebase account (for later integration setup)

You do NOT need Docker locally for the cloud-first path we're using.

---

## Step 1 — Create the dev Supabase project

1. Open https://supabase.com/dashboard → **New project**
2. Organization: whichever you use
3. Project name: `freezepipe-erp-dev`
4. Database password: **generate a strong one and save it** (can't be recovered)
5. Region: `us-east-1` (or whatever's closest to your warehouse — doesn't matter much for ops)
6. Pricing plan: **Free tier** is fine for dev. Pro only needed for prod (PITR backups, no-pause policy)
7. Click **Create** — takes ~2 minutes to provision

While you wait, copy down from **Settings → API**:

| What | Where to find it | Paste where |
|---|---|---|
| Project URL | Settings → API → Project URL | `.env.local` as `VITE_SUPABASE_URL` |
| Anon key | Settings → API → Project API keys → `anon public` | `.env.local` as `VITE_SUPABASE_ANON_KEY` |
| Service role key | Settings → API → Project API keys → `service_role` | Keep for Edge Functions — do NOT put in `.env.local` |
| Project reference | Settings → General → Project ID (e.g., `abcdefghijklmnop`) | Used with CLI commands below |

---

## Step 2 — Wire `.env.local` for the frontend

```bash
cp .env.example .env.local
```

Edit `.env.local` and fill in:

```
VITE_SUPABASE_URL=https://<your-project-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGci... (the anon key)
VITE_APP_ENV=dev
```

Restart `npm run dev`. The app will start using the real Supabase project
instead of demo mode.

*(Demo mode is triggered by the placeholder URL string — once you set a real
URL, the demo short-circuit is bypassed automatically.)*

---

## Step 3 — Link the Supabase CLI to the project

```bash
npx supabase login           # one-time; opens browser for auth
npx supabase link --project-ref <your-project-ref>
```

You'll be asked for the database password from Step 1.

---

## Step 4 — Apply the migrations

**Review first** — the migrations in `supabase/migrations/` are extensive
(18 files, ~2000 lines). Scan `001_initial_schema.sql` at minimum before
pushing.

```bash
npx supabase db push
```

This applies every migration in order. Expected output:

```
Applying migration 20260101000001_initial_schema.sql...
Applying migration 20260101000002_freight_tracking_fields.sql...
... (16 more)
Finished supabase db push.
```

If any migration fails, **stop and report**. The migrations are designed to
be idempotent (use `IF NOT EXISTS` etc.), but a real failure shouldn't be
papered over.

### Enable required extensions

The migrations assume `pg_cron`, `pg_net`, and `pgcrypto` are available.
Supabase has them as available extensions, but you need to enable them
in the Dashboard → Database → Extensions:

- [x] `pgcrypto` (for the audit hash chain in migration 009)
- [x] `pg_cron` (for scheduled reconcile jobs in migration 016)
- [x] `pg_net` (for HTTP calls from pg_cron to Edge Functions)

Enable each, then re-run `npx supabase db push` if migration 016 failed
the first time.

---

## Step 5 — Seed dev data

Dev projects should have demo data so the app is immediately usable.

```bash
npx supabase db reset                 # WARNING: deletes everything, re-applies migrations + seed
```

Or just run the seed manually:

```bash
psql "$(npx supabase status -o env | grep DB_URL | cut -d= -f2- | tr -d '\"')" -f supabase/seed.sql
```

*(On Windows without psql, use the SQL Editor in the Supabase Dashboard:
paste the contents of `supabase/seed.sql` and run.)*

---

## Step 6 — Set Edge Function secrets

```bash
# Generate the webhook secret
WEBHOOK_SECRET=$(openssl rand -hex 32)

npx supabase secrets set \
  SHIPSTATION_API_KEY="..." \
  SHIPSTATION_API_SECRET="..." \
  SHIPSTATION_WEBHOOK_SECRET="$WEBHOOK_SECRET" \
  HOMEBASE_API_KEY="..." \
  HOMEBASE_LOCATION_ID="..." \
  MAERSK_API_KEY="" \
  FEDEX_API_KEY="" \
  FEDEX_API_SECRET="" \
  DHL_API_KEY="" \
  --project-ref <your-project-ref>
```

(Leave carrier keys blank for now — the tracking reconciler handles missing
creds gracefully and returns `not_received` for unsupported carriers.)

---

## Step 7 — Deploy Edge Functions

Three functions to deploy:

```bash
# ShipStation webhook — receives inbound notifications. Public endpoint,
# so we skip the JWT verification (our secret-in-URL handles auth).
npx supabase functions deploy shipstation-webhook --no-verify-jwt --project-ref <ref>

# ShipStation reconciler — service_role callers only (pg_cron).
npx supabase functions deploy shipstation-reconcile --project-ref <ref>

# Carrier tracking reconciler — service_role callers only (pg_cron).
npx supabase functions deploy tracking-reconcile --project-ref <ref>
```

Test the webhook endpoint:

```bash
# Should return 401 — secret is required
curl https://<ref>.supabase.co/functions/v1/shipstation-webhook

# Should return 200 + {"ok":true,"id":...}
curl -X POST \
  "https://<ref>.supabase.co/functions/v1/shipstation-webhook?s=$WEBHOOK_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"resource_url":"https://ssapi.shipstation.com/orders/99999","resource_type":"SHIP_NOTIFY"}'
```

*(The second call will 200 but the inner processing will fail because the
orderId 99999 doesn't exist — that's fine. Check `shipstation_webhook_events`
in the dashboard to confirm the event was recorded.)*

---

## Step 8 — Configure pg_cron for scheduled jobs

In the Supabase **SQL Editor**, run once:

```sql
-- Tell pg_cron where to find our Edge Functions + how to auth.
-- Replace both values with your project's actuals.
ALTER DATABASE postgres SET app.settings.project_url
  TO 'https://<your-project-ref>.supabase.co';
ALTER DATABASE postgres SET app.settings.service_role_jwt
  TO '<your-service-role-jwt>';
```

Migration 016 already scheduled the cron jobs. Verify:

```sql
SELECT jobname, schedule, active FROM cron.job;
-- Should show 3 rows:
--   tracking-reconcile             7 */6 * * *
--   shipstation-reconcile-nightly  15 3 * * *
--   audit-chain-verify             30 4 * * *
```

---

## Step 9 — Register the ShipStation webhook

In the ShipStation dashboard → **Settings → Integrations → Webhooks → Add Webhook**:

- **URL**: `https://<your-project-ref>.supabase.co/functions/v1/shipstation-webhook?s=<WEBHOOK_SECRET>`
- **Event**: `Items shipped — ITEM_SHIP_NOTIFY` (this is the one that decrements inventory)
- Optionally also `Orders — ORDER_NOTIFY` to track order lifecycle

ShipStation sends a test POST when you save. Check `shipstation_webhook_events`
in the Supabase dashboard — you should see a row with `processed_at` populated.

---

## Step 10 — Create real auth users

For yourself and your team:

1. Supabase dashboard → **Authentication → Users → Add user → Create new user**
2. Set email + initial password
3. Click the new user → note the UUID
4. In the SQL Editor:
   ```sql
   UPDATE profiles SET role = 'admin' WHERE id = '<that-uuid>';
   ```

Users created via this flow automatically get a `profiles` row with role
`user` (via the `handle_new_user` trigger in migration 001). Promote yourself
to `admin`, then use the app's User Management UI to onboard the rest.

---

## Step 11 — Sanity-check the app

Open the app in a browser, log in as the user you created.

Quick smoke test:
- [ ] Inventory page loads with seeded SKUs
- [ ] Freight page shows the seeded shipments
- [ ] Settings → Change Log shows the seeded audit entry
- [ ] Settings → User Management shows team members

If any page errors, check the browser console AND the Supabase dashboard's
**Logs → API / Postgres / Edge Functions** tabs.

---

## Going to staging + prod

Repeat Steps 1-10 for each additional project. Use distinct:
- Project names (`freezepipe-erp-staging`, `freezepipe-erp-prod`)
- `.env.<env>` files
- ShipStation API keys (use ShipStation's sandbox for staging)
- Homebase API keys

See [ENVIRONMENTS.md](ENVIRONMENTS.md) for the separation doctrine.

---

## Rollback / emergency procedures

### Undo the last migration
```bash
# Find the last migration name
npx supabase migration list --linked

# Manually revert in SQL Editor, then:
psql <conn> -c "DELETE FROM supabase_migrations.schema_migrations WHERE version = '<timestamp>';"
```

(Supabase doesn't ship a `migration down` — keep forward-only discipline.)

### Point-in-time restore (Pro only)
Dashboard → Database → Backups → select timestamp → Restore.
Tests your DR runbook; do a drill quarterly.

---

## After setup: deleting demo mode

Once the real Supabase is wired up and working for ~1 week without issues:

1. Grep the codebase for `demoInventory`, `demoFreight`, `demoTaskLogs`, etc.
2. Replace each read with a Supabase query / hook
3. Replace each mutation helper (`logTaskCompletion`, `archiveSku`, etc.) with an RPC call
4. Delete `src/lib/demo-data.ts` once every reference is gone
5. Remove the `isDemoMode` check from `src/App.tsx` and `src/lib/auth-context.tsx`

This is a ~1-2 day refactor. Do it as a single PR titled "Remove demo mode"
so it's easy to revert if anything breaks. Keep the demo-mode code paths
working until then — that's what makes the cutover safe.
