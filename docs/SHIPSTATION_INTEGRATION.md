# ShipStation Integration — Runbook

## What it does

Every sale in ShipStation decrements `warehouse_finished` in our inventory —
atomically, idempotently, with a full audit trail. The integration has three
moving parts:

1. **Webhook receiver** (`shipstation-webhook` Edge Function) — ShipStation
   POSTs here when orders move to shipped status. Records the event, fetches
   order details, calls the atomic RPC.
2. **Nightly reconciler** (`shipstation-reconcile` Edge Function) — cron'd
   at 03:15 UTC. Replays failed events, pulls the previous day's orders from
   the API to catch anything the webhook missed, applies inventory for orders
   still pending.
3. **Atomic RPC** (`rpc_apply_shipstation_sale`) — the only code path that
   actually moves inventory for a sale. One transaction per order, one audit
   row per (order, sku) movement.

## Guarantees

- **The ledger follows the lines** (migration 20260921000001). For every
  (order, sku), the net `order_shipped` quantity in `inventory_transactions`
  for that order equals the order's resolved line quantity *at apply time*.
  Every apply computes `delta = lines − ledger` per sku: `delta > 0` deducts
  the difference, `delta < 0` credits it back (positive `order_shipped` row,
  same reference), `delta = 0` does nothing. A sku that has ledger rows but
  no line any more is credited in full. Stock is never touched without lines
  to compare against. Because the memory is the append-only ledger (not the
  re-ingested `shipstation_order_items`, not `inventory_applied_at`), a
  webhook + reconcile racing on the same order, a re-ingest, or a retry of a
  parked order can never deduct twice. Once an order is stamped applied,
  neither the webhook nor the reconcile replaces its line rows again, so the
  lines stay what the ledger was reconciled against.
- **Cancelled orders owe nothing.** The RPC treats a cancelled order as
  target 0 for every sku (a call credits whatever the ledger still holds and
  never stamps it), and the migration un-stamped the historical cancelled
  orders it rebased. The edge functions do not call the RPC for cancelled
  orders, so a cancellation after a deduction is **not** credited back
  automatically today; it is settled by the next run of the correction
  script or a cycle count. Making it automatic is an open owner decision.
- **Same webhook delivered twice = recorded once**: unique constraints on
  `shipstation_webhook_events.event_id` and
  `shipstation_orders.shipstation_order_id`.
- **Atomic**: the RPC is a Postgres function; failure mid-way rolls back
  every change.
- **Durable**: webhook events are persisted before processing. If the Edge
  Function crashes, the reconciler replays.
- **Reconciled**: even if the webhook system fails for days, the
  pull-and-compare (every 30 minutes, plus the nightly run) catches up.
- **Unresolved SKU safety**: a ShipStation order referencing a SKU we don't
  recognize keeps that order *un-stamped* until an operator resolves the code.
  The recognized lines of the same order deduct straight away (owner decision
  2026-09-21: only the unknown line waits). An order with no line rows at all
  while its raw payload still lists a trackable item is parked with
  `line items not ingested`, never stamped.

## One-time setup

### 1. Create ShipStation credentials
Settings → API Settings in ShipStation. Generate an API Key + Secret. Treat
as a database password.

### 2. Set Edge Function secrets
```bash
# Generate a random webhook secret — used as ?s= in the webhook URL
SECRET=$(openssl rand -hex 32)

supabase secrets set \
  SHIPSTATION_API_KEY="$SS_KEY" \
  SHIPSTATION_API_SECRET="$SS_SECRET" \
  SHIPSTATION_WEBHOOK_SECRET="$SECRET" \
  --project-ref <prod-ref>
```

### 3. Deploy the Edge Functions
```bash
supabase functions deploy shipstation-webhook --no-verify-jwt --project-ref <prod-ref>
supabase functions deploy shipstation-reconcile --project-ref <prod-ref>
```

`--no-verify-jwt` is required on the webhook because ShipStation can't carry
our JWT. The secret-in-URL + RLS layer on the service-role client provide
auth instead.

**Deploy order for the 2026-09-21 fix**: apply migration
`20260921000001_shipstation_apply_once.sql` (`supabase db push`) BEFORE
deploying the reconcile function that drops the `< 6` attempts cap. The old
RPC under uncapped retries would re-deduct every parked order's recognized
lines every run; the new RPC with the old (capped) reconcile is safe. Then
deploy the webhook (it stops replacing the lines of applied orders and fails
an event whose line insert errors so Stage 1 replays it). Push the migration
between reconcile runs (cron `*/30`, each run 11–40 s from :00 / :30): its
data step holds every unapplied order row for a few seconds. Its E2 step
uses the same reset knob as the correction script (`c_min_reset_abs_delta`,
1 or 5); the owner decides the knob once, before the push, because the
absorbed-by-count stamp is permanent.

### 4. Register the webhook in ShipStation
Settings → Integrations → Webhooks → Add Webhook

- **URL**: `https://<project-ref>.supabase.co/functions/v1/shipstation-webhook?s=<SECRET>`
- **Event**: `Items shipped — ITEM_SHIP_NOTIFY`
- (Optionally also `Orders — ORDER_NOTIFY` to track order lifecycle without inventory impact)

ShipStation will send a test POST. Verify it hits `shipstation_webhook_events`
with `processed_at` populated.

### 5. Schedule the nightly reconciler
In Supabase SQL Editor, enable pg_cron + pg_net, then:

```sql
SELECT cron.schedule(
  'shipstation-reconcile-daily',
  '15 3 * * *',  -- 03:15 UTC = 23:15 ET
  $$
    SELECT net.http_post(
      url := 'https://<project-ref>.supabase.co/functions/v1/shipstation-reconcile',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || current_setting('app.settings.service_role_jwt'),
        'Content-Type', 'application/json'
      ),
      body := '{}'::jsonb
    );
  $$
);
```

The service_role JWT should be set as a database-level setting, NOT inlined
in the cron script. See Supabase docs on `app.settings`.

### 6. Seed the system user
```sql
INSERT INTO profiles (id, email, full_name, role)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  'system@internal',
  'System (automated)',
  'admin'
);
```

This profile id is the `performed_by` value on audit entries written by the
webhook and reconciler.

## Daily ops

### Check the webhook is healthy
```sql
-- Events delivered in the last hour
SELECT event_type, COUNT(*) FILTER (WHERE processed_at IS NOT NULL) AS processed,
       COUNT(*) FILTER (WHERE processed_at IS NULL) AS pending
  FROM shipstation_webhook_events
 WHERE received_at > now() - interval '1 hour'
 GROUP BY event_type;
```

Pending should trend to zero within minutes.

### Unresolved SKU queue (work daily)
```sql
SELECT * FROM shipstation_unresolved_skus;          -- every unknown code on a live, unapplied order
SELECT * FROM shipstation_unresolved_skus_pending;  -- same, minus codes that already have a handling row
```
Each row is a SKU code on a shipped / awaiting_shipment order that is not yet
applied and matches neither `product_skus.sku` nor an alias (both matched
case-insensitively). Codes that only live on cancelled or already-applied
orders are not shown. To clear a code, do ONE of:
- **Add an alias** (SKU detail page → ShipStation Aliases, or
  `rpc_shipstation_register_sku_alias`) when the code is another spelling of
  an existing product; or
- **Add the product** to `product_skus` when it is genuinely new; or
- **Register it non-inventory** (`rpc_shipstation_register_non_inventory_sku`,
  admin) when it should never move stock (gift cards, insurance, …).

Then wait: the next reconcile run (≤ 30 minutes) re-resolves the parked
orders' lines itself and applies them. No re-ingest, no manual
`shipstation_order_items` update, no attempts reset is needed — the RPC
re-resolves still-unknown lines with the alias table and the catalog on every
call, and the register RPCs report `orders_requeued` (the SKU page shows
"N orders will apply within 30 minutes").

Removing an alias (admin) credits the old SKU back on every order that
resolved through it and re-opens those orders (only the ones whose lines
actually lost their resolution), so re-pointing a code to another SKU nets
one unit per unit sold.

### Orders stuck not-applied
```sql
SELECT order_number, order_date, inventory_apply_attempts, inventory_apply_error
  FROM shipstation_orders
 WHERE inventory_applied_at IS NULL
   AND order_status IN ('shipped', 'awaiting_shipment')
 ORDER BY order_date;
```
Every row here is an order with at least one line still waiting: an unknown
code (`inventory_apply_error` names the codes) or an incomplete ingest
(`line items not ingested`). The order's recognized lines have already been
deducted. `inventory_apply_attempts` only climbs when the unresolved set
changes, so a high number means the code set kept changing, not that the
order was retried that many times.

### Historical over-deduction (2026-05 → 2026-09-21)
Before migration 20260921000001 the RPC re-deducted an order's recognized
lines on every retry while an unknown code blocked it. The migration wrote
per-pair `shipstation_ledger_rebase` metadata rows (no stock movement) so the
new rule does not blindly credit that excess back, stamped the orders whose
owed units a later qualifying cycle count had already absorbed
(`shipstation_absorbed_by_count`, plus one negative rebase row per pair so a
re-open never deducts them; "qualifying" = the same `|delta| >=` knob the
correction script uses), un-stamped the cancelled orders it rebased, and the
stock itself is returned per SKU by the owner-approved
`shipstation_overdeduct_correction` script (rows of that type in the Change
Log). Cancelled orders owe the ledger nothing under that script's rule. Run
the script between reconcile runs; its guard aborts if any
`warehouse_finished` row for a SKU lands between derivation and write.

### Reconcile run history
```sql
SELECT started_at, status, orders_pulled, orders_new, orders_updated,
       orders_drift_detected, error_message
  FROM shipstation_sync_runs
 ORDER BY started_at DESC
 LIMIT 30;
```
Any `failed` status or non-zero `orders_drift_detected` warrants investigation.

## Failure modes

| Symptom | Likely cause | Fix |
|---|---|---|
| Webhook events with `processing_error` | ShipStation API flaky or our DB down briefly | Usually clears itself on next reconciler run |
| Same event arrives twice | ShipStation retry | Dedup on `event_id` — no action required |
| Inventory went negative | Oversell (sale before receiving) | Cycle-count correction; investigate why stock wasn't received first |
| Order parked with `line items not ingested` | Ingest wrote the order row but the line insert failed (or the payload is missing while the ledger holds units) | The next reconcile rebuilds the lines from the stored payload (Stage 2b); the RPC refuses to stamp or credit until the lines exist |
| Cancelled order still holds `order_shipped` units | Deducted while awaiting shipment, then cancelled | Not credited automatically (owner decision pending); the correction script or a cycle count settles it. A direct RPC call credits it and leaves it un-stamped |
| Positive `order_shipped` row in the Change Log | A line was reduced/removed, or an alias was removed (units credited back) | Expected — the ledger follows the lines |
| Order count mismatch between ShipStation and us | Webhook missed + reconciler caught | `orders_drift_detected` in sync run — review the drift |
| Rate-limited (429) | High-volume day | The client auto-backs off; tune `pageSize` if frequent |

## Security notes

- The webhook endpoint is authenticated by a secret in the URL query. Rotate
  the secret quarterly. To rotate: set a new secret, update the ShipStation
  webhook URL, then remove the old secret.
- Real API credentials never hit the browser bundle. Any code that needs them
  lives in Supabase Edge Functions (`supabase/functions/`), not `src/`.
- The service_role JWT also never hits the browser. Only the anon key does.
- Optional: populate `SHIPSTATION_IP_ALLOWLIST` with ShipStation's published
  webhook IP ranges for defense-in-depth.

## Local testing

Demo mode has no live ShipStation. To test the webhook locally:
1. `supabase functions serve shipstation-webhook`
2. In a separate terminal, POST a sample payload:
   ```bash
   curl -X POST "http://localhost:54321/functions/v1/shipstation-webhook?s=<local-secret>" \
     -H "Content-Type: application/json" \
     -d @test/fixtures/shipstation-webhook.json
   ```
3. Inspect `shipstation_webhook_events` and `shipstation_orders` in the local DB.
