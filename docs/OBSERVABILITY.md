# Observability Setup

Three pillars for a production ERP: **errors**, **product analytics**, and
**infrastructure health**. Set up per environment. Never pipe dev/staging
telemetry into your prod project — it'll poison your baselines.

## 1. Errors — Sentry

### Install
```bash
npm install @sentry/react
```

### Configure
- Create three Sentry projects (`freezepipe-erp-dev`, `-staging`, `-prod`) under your Sentry org
- Grab each DSN → set `VITE_SENTRY_DSN` per env
- Uncomment the `Sentry.init()` block in [src/lib/monitoring/sentry.ts](src/lib/monitoring/sentry.ts)
- Add the `<ErrorBoundary>` already built in [src/components/ErrorBoundary.tsx](src/components/ErrorBoundary.tsx) around `<App />` in `src/main.tsx`, plus around each "heavy" subtree (charts, tables)
- Add `@sentry/vite-plugin` to upload source maps during build so stack traces resolve to real files

### What to alert on
- **Error rate > 2× baseline** (Sentry auto-computes baselines) — page
- **New issue in production** — Slack
- **Hash chain broken** (see migration 009 + cron check) — page immediately
- **Edge Function failures sustained for > 5 minutes** — page

### What NOT to alert on
- Single-session spurious errors (users with broken extensions, flaky networks)
- Known-noise filters are set in the init — keep them up to date

## 2. Product analytics — PostHog

### Install
```bash
npm install posthog-js
```

### Configure
- Create three PostHog projects. Set `VITE_POSTHOG_KEY` + `VITE_POSTHOG_HOST` per env
- Uncomment bodies in [src/lib/monitoring/analytics.ts](src/lib/monitoring/analytics.ts)
- Wire `identifyUser(profile.id, {...})` after sign-in
- Wire `track(...)` at the call sites listed in the `EventName` union

### Starter dashboards
- **Task log funnel** — user opens Workspace → selects SKU → selects task → submits (what % drop off at each step?)
- **Tracking refresh taps** — if users mash the manual refresh button on Freight detail, tells you the auto-poll feels slow
- **Freight override patterns** — which statuses do operators set manually? What's the median duration before a clear?
- **Unresolved SKU aging** — how long does a SKU stay in the queue?

## 3. Infrastructure — Supabase + log drains

### Built-in Supabase dashboards
- Database: connections, query time p95, deadlocks
- Edge Functions: invocations, duration, error rate
- Storage: egress, request count

### Pipe out to Datadog / Grafana / BetterStack
Supabase → Log Drain (Pro plan) → your aggregator. Dashboards to build:
- **RPC call p95 duration** by function name — catches the first sign of N+1 queries
- **Audit log insert rate** — sudden drop = someone broke the insert path
- **Edge Function error rate** per function — ShipStation vs tracking-reconcile
- **pg_cron job success** — nightly reconcilers must run

## 4. What to add to every critical UI action

Right now the codebase has a mix of `console.error` calls and silent failures.
Replace every critical one with:

```ts
import { captureException } from "@/lib/monitoring/sentry";
import { track } from "@/lib/monitoring/analytics";

try {
  await doCriticalThing();
  track("thing_did");
} catch (err) {
  captureException(err, { tags: { flow: "critical-thing" }, extra: { inputSize: X } });
  // ... user-facing error UI
}
```

## 5. Staged rollout (the sane way)

Don't wire observability into production on day 1 — wire it into **dev first**, get the signal shape right, then turn on staging, then prod.

1. Week 1: Sentry in dev. Force some errors, confirm they're captured with useful context.
2. Week 2: PostHog in dev. Confirm events land with the right props.
3. Week 3: Alerts in dev → Slack `#erp-dev-alerts`. Tune noise.
4. Week 4: Turn on in staging, observe for a week.
5. Week 5: Production.
