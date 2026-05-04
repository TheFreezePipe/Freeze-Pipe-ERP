# Environments

Three Supabase projects. No exceptions. Never "test in prod" — discipline here
is what prevents a bad migration from wiping $10M of operational data.

## The three environments

| Env | Supabase project | Domain | Who has access | Data |
|---|---|---|---|---|
| **dev** | `freezepipe-dev` | `dev.freezepipe-erp.internal` or localhost | Developers | Seeded fakes, reset freely |
| **staging** | `freezepipe-staging` | `staging.freezepipe-erp.internal` | Devs + ops leads | Refreshed weekly from prod with PII scrubbed |
| **prod** | `freezepipe-prod` | `erp.freezepipe.com` | All users | Real business data — treat as sacred |

Each has its own:
- Supabase URL + anon key + **separate** service_role key
- ShipStation API credentials (use ShipStation's sandbox for dev/staging; production keys only in prod)
- Homebase API credentials (same split)
- Sentry project, PostHog project

## Promotion flow

Code flows `dev → staging → prod`. Data never flows `prod → staging` in
bulk — only via the scrubbed weekly refresh job.

```
feature branch
    │ PR review
    ▼
main branch ───── auto-deploys to dev
    │ QA on dev
    ▼
v2025.04.12 tag ──── auto-deploys to staging
    │ soak 24–72h, QA
    ▼
promoted to prod ──── auto-deploys to prod (with approval gate)
```

## Migrations

```bash
# Always test on dev first
supabase db push --linked --project-ref <dev-ref>

# When green, apply to staging
supabase db push --linked --project-ref <staging-ref>

# After soak, apply to prod (manual step, requires 2nd approver)
supabase db push --linked --project-ref <prod-ref>
```

**Never run `--force` on prod.** If a migration fails, revert, fix on dev, redo.

## `.env` layout

`.env.example` is committed; real keys never are. Each developer maintains their
own `.env.local`. CI/CD injects environment-specific `.env` at build time.

### `.env.example`
```
# Frontend (safe to bundle)
VITE_SUPABASE_URL=https://<project-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<anon-key>
VITE_APP_ENV=dev
VITE_SENTRY_DSN=<frontend-sentry-dsn>

# Server-side only — NEVER in VITE_ vars; only set in Edge Function secrets
# and CI. Listed here for reference; keep real values in the Supabase dashboard.
SUPABASE_SERVICE_ROLE_KEY=<service-role-key>
SHIPSTATION_API_KEY=<shipstation-api-key>
SHIPSTATION_API_SECRET=<shipstation-api-secret>
SHIPSTATION_WEBHOOK_SECRET=<32+ char random>
SHIPSTATION_IP_ALLOWLIST=   # optional, comma-separated
HOMEBASE_API_KEY=<homebase-api-key>
```

### Setting Edge Function secrets

```bash
supabase secrets set \
  SHIPSTATION_API_KEY="..." \
  SHIPSTATION_API_SECRET="..." \
  SHIPSTATION_WEBHOOK_SECRET="$(openssl rand -hex 32)" \
  --project-ref <env-project-ref>
```

## Seed & reset policy

- **dev** — reset is cheap; `supabase db reset` allowed any time. Seed script
  in `scripts/seed-dev.sql` populates fake SKUs + users so the app is usable.
- **staging** — weekly scrubbed refresh from prod. See `scripts/refresh-staging.sh`.
  Scrubbing replaces PII: customer emails/names → `user-<hash>@example.com`,
  Homebase IDs retained but clocked hours redacted.
- **prod** — **no resets, ever**. Only forward-direction migrations.

## Backups & DR

- Supabase Pro gives 7-day PITR (point-in-time restore). Required for prod.
- Nightly `pg_dump` pushed to S3/R2 with 90-day retention. Script in `scripts/nightly-backup.sh`.
- Quarterly DR drill: restore yesterday's backup into a scratch project, run
  a read-only spot check, destroy the project. Document the drill outcome.

## Environment detection in code

The app detects its environment in two places:

1. `src/lib/supabase.ts` — picks the URL/key from `VITE_` env
2. `VITE_APP_ENV` — set to `dev` | `staging` | `prod`; used to gate feature
   flags and to show a visible banner on non-prod.

Add a banner on staging/dev:

```tsx
{import.meta.env.VITE_APP_ENV !== "prod" && (
  <div className="bg-amber-500 text-black text-center text-xs py-1 font-semibold">
    {import.meta.env.VITE_APP_ENV.toUpperCase()} ENVIRONMENT — NOT REAL DATA
  </div>
)}
```

Non-negotiable: on staging/dev, nothing should ever reach a real carrier API,
real Homebase, or real ShipStation. Use sandbox credentials; add safety checks
on webhook send paths that refuse to run when `VITE_APP_ENV !== "prod"`.

## Demo mode sunset plan

The app currently has a built-in demo mode (detects placeholder URLs and
short-circuits to localStorage). **Remove demo mode before going live** —
leave it only in dev, guarded by `VITE_APP_ENV === "dev"`. A production
build should **fail** if `VITE_SUPABASE_URL` is missing or matches the
placeholder.
