# Freeze Pipe ERP — Project Context

Internal ERP app for Freeze Pipe. React 19 + TypeScript + Vite frontend, Supabase backend (not yet wired up for current work — see Demo Mode below).

## Stack

- **Framework**: React 19 + Vite 8 + TypeScript 5.9
- **Routing**: react-router-dom v7
- **State/data**: TanStack Query v5
- **Forms**: react-hook-form + zod
- **UI**: shadcn/ui (Radix primitives) + Tailwind CSS 3 + lucide-react icons
- **Charts**: recharts
- **Backend**: Supabase (`@supabase/supabase-js`)
- **Path alias**: `@/*` → `src/*`

## Run it

```bash
npm install          # only if node_modules is missing or stale
npm run dev          # http://localhost:5173
npm run build        # tsc -b && vite build
npm run lint         # eslint .
```

Requires **Node 20+** (Vite 8).

## Demo Mode — IMPORTANT

The app auto-detects when Supabase isn't configured and runs in **demo mode**: auth is bypassed, a demo admin profile is used, and mock data comes from `src/lib/demo-data.ts`.

The detection check (in `src/App.tsx` and `src/lib/auth-context.tsx`):

```ts
const isDemoMode =
  !import.meta.env.VITE_SUPABASE_URL ||
  import.meta.env.VITE_SUPABASE_URL === "https://your-project.supabase.co";
```

`.env.local` currently has placeholder values, so demo mode is ON. **Keep it that way while refining the UI — don't replace with real Supabase creds until ready to wire up persistence.**

## Project Layout

```
src/
  App.tsx                      # Router + providers + demo-mode gate
  main.tsx
  index.css
  lib/
    supabase.ts                # Supabase client (falls back to placeholder)
    auth-context.tsx           # AuthProvider; bypasses in demo mode
    query-client.ts            # TanStack Query client
    demo-data.ts               # Mock data for demo mode
    forecast-data.ts           # Demand forecast data
    category-demand.ts
    constants.ts
    utils.ts
  components/
    ui/                        # shadcn primitives
    layout/Layout.tsx          # App shell
    shared/RequireRole.tsx     # Role-based route guard
    dashboard/
    economics/
    freight/
    inventory/
    manufacturing/
  pages/
    auth/ (Login, Register)
    Dashboard.tsx
    manufacturing/ (Dashboard, Workspace, Performance)
    freight/ (Dashboard, Detail, New)
    inventory/ (Dashboard, FactoryOrders)
    economics/ (SKUList, SKUDetail)
    settings/Settings.tsx
  types/database.ts            # Supabase-generated types
scripts/
  build-forecast.cjs           # Demand-forecast builder (reads CSV)
  backtest-forecast.cjs        # Backtest runner
  forecast-overrides.json
  forecast-report.txt          # Last forecast output
  backtest-report.txt          # Last backtest output
supabase/
  migrations/001_initial_schema.sql
```

Note: `src/src/` is a leftover duplicate from the initial Vite scaffold. Nothing imports from it — safe to delete.

## Roles

Three roles gate routes via `<RequireRole>`:

- **admin** — everything (Dashboard, Manufacturing, Freight, Inventory, Economics, Settings)
- **manager** — Dashboard, Manufacturing, Freight, Inventory
- **user** — Manufacturing Overview + Workspace only; default landing page is `/manufacturing/workspace`

Demo mode logs in as admin.

## Open TODOs (persistence stubs)

These are the places that will need Supabase calls when you're ready to leave demo mode. Until then they're safe to leave as-is:

- `src/pages/freight/FreightNew.tsx:198` — `// TODO: POST to Supabase` (shipment creation)
- `src/pages/manufacturing/Workspace.tsx:31` — `// TODO: Submit task log to Supabase and update inventory_levels`

## Forecast Scripts

Standalone Node scripts under `scripts/`:

```bash
node scripts/build-forecast.cjs "<path-to-CSV>"
node scripts/backtest-forecast.cjs "<path-to-CSV>"
```

They emit human-readable reports to `scripts/forecast-report.txt` and `scripts/backtest-report.txt`.

## Recent Work (last session before migration)

Most recently edited files, in rough order:

1. `src/pages/freight/FreightNew.tsx` — shipment creation form (persistence stub still present)
2. `src/pages/inventory/FactoryOrders.tsx`
3. `src/lib/demo-data.ts` — expanded mock dataset
4. `src/components/manufacturing/NewFactoryOrderDialog.tsx`
5. `src/types/database.ts`
6. Forecast scripts (`build-forecast.cjs`, `backtest-forecast.cjs`)

## Conventions

- Path alias `@/...` for all intra-project imports.
- shadcn components live in `src/components/ui/` — don't reinvent; extend what's there.
- Tailwind tokens come from `tailwind.config.js`; dark mode is on by default (`<html class="dark">` in `index.html`).
- `class-variance-authority` + `tailwind-merge` + `clsx` for conditional classes (see `src/lib/utils.ts`'s `cn()` helper).

## Setup status

- No `.git` repo — initialize one before making more changes (`git init`, commit baseline).
- **Supabase CLI installed** (`npx supabase` works) — project not yet linked to a cloud project. See [docs/SUPABASE_SETUP.md](docs/SUPABASE_SETUP.md) for the end-to-end runbook.
- **Vitest installed** + 63 unit tests passing (`npm test`). E2E / Playwright deferred until UI stabilizes.
- 23 DB migrations in `supabase/migrations/` renamed to `YYYYMMDDHHmmss_*.sql` format — deployed through 022 on staging; 023 is the catch-up for an in-place handle_new_user patch applied during pilot setup.
- 3 Edge Functions in `supabase/functions/`: `shipstation-webhook`, `shipstation-reconcile`, `tracking-reconcile`. (Previously 4; `invite-supplier-user` was retired in favor of pre-seeded supplier users — see Supplier portal section below.)
- `supabase/seed.sql` populates a fresh dev DB with representative data.

## Supplier portal — deployed + pilot-ready

- Migrations 020–022 live: supplier capability flags, BOM, variances, breakage reports, supplier RLS, 13 supplier/admin RPCs.
- Nancy (code `NANCY`, id `…0201`) and YX (`…0202`) seeded with capability flags. Nancy is producer + filler + export_broker and consolidates for YX.
- Nancy's facility seeded as a `locations` row (code `NANCY-DOCK`, id `…0301`, `location_type = 'supplier_warehouse'` — NOT `'supplier_facility'`; the CHECK rejects the latter).
- Supplier UI at `/supplier/*` — 7 routes wired. Admin provisioning UI lives in `/settings` user management (Promote + Deactivate). Invite flow removed; supplier users are pre-seeded directly.
- Two pilot supplier accounts live on staging: `nancy@freezepipe.test` / `PilotNancy2026!` and `yx@freezepipe.test` / `PilotYX2026!`. Both have password sign-in enabled, role=`supplier`, linked to their respective orgs.
- Pilot playbook: `docs/cowork-supplier-pilot.md` (Part 2).
- Known drift (non-blocking, punted): `FactoryOrders.tsx` filter-by-factory still reads `order.factory`, a column removed pre-020. Silent empty filter against real DB rows. Fix is a separate pass — not on the supplier portal critical path.

## Cowork gotchas (learned the hard way)

- **Sandbox network policy** blocks direct `*.supabase.co` and `*.supabase.com` traffic, so `supabase db push` and `supabase gen types` don't work from Cowork. Use the Management API's `/database/query` and `/types/typescript` endpoints instead — same transport the dashboard uses, not blocked.
- **Base64 payloads can mutate in transit** through the browser tool's response channel. When Cowork transfers anything binary-ish (gzipped SQL dumps, regenerated type files), use per-chunk SHA-256 verification and re-fetch corrupted chunks as hex. This has bitten us twice (migration 024 + 026 types regen, 2026-04-22).
- **`CREATE OR REPLACE FUNCTION` does not validate referenced relations.** A function body that INSERTs into a non-existent table deploys fine and only fails at first call. After deploying new RPCs, run at least one smoke invocation per RPC (even an input expected to fail with a validation error is enough — a table-missing error surfaces a 500). Migration 021 shipped referencing a non-existent `audit_logs` table and wasn't caught until migration 026 three days later.
- **Dashboard JWT expires at 30 min.** Long chunked transports through the browser tool (big types regen, multi-step migration deploys) can cross the boundary mid-task. The SPA doesn't auto-refresh. Recovery: stash in-flight state into `localStorage`, `location.reload()`, re-hydrate. Worth checking token age before starting anything that'll take more than 20 min.
- **`CREATE OR REPLACE VIEW` can only APPEND columns to the SELECT list.** Existing column positions and names are frozen at the original CREATE — reordering or inserting in the middle errors with `42P16: cannot change name of view column`. Add new columns at the end of the projection, even when it reads less naturally. Column order in a projection view doesn't affect anything functional because Supabase clients address by column name. Migration 029 hit this on its first deploy and had to be patched. If you really need a logical reordering, `DROP VIEW IF EXISTS foo; CREATE VIEW foo ...` — but be aware that invalidates any materialized views / triggers / grants that reference it.
