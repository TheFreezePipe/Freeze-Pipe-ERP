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
   actually decrements inventory. One transaction per order, one audit row
   per line item.

## Guarantees

- **Idempotent**: same webhook delivered twice = recorded once. Same order
  applied twice = inventory decremented once. Enforced by unique constraints
  on `shipstation_webhook_events.event_id` and `shipstation_orders.shipstation_order_id`,
  plus the `inventory_applied_at` flag on each order.
- **Atomic**: the RPC is a Postgres function; failure mid-way rolls back
  every change.
- **Durable**: webhook events are persisted before processing. If the Edge
  Function crashes, the nightly reconciler replays.
- **Reconciled**: even if the webhook system fails for days, the nightly
  pull-and-compare catches up.
- **Unresolved SKU safety**: a ShipStation order referencing a SKU we don't
  recognize blocks inventory application for that order until an operator
  resolves the SKU. No silent drift.

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
SELECT * FROM shipstation_unresolved_skus;
```
Each row is a SKU code ShipStation is sending that doesn't match any
`product_skus.sku`. Either:
- Add the SKU to `product_skus` (normal case — someone added a product to
  ShipStation but not the ERP), then re-run the reconciler; or
- Change the SKU in ShipStation to match an existing ERP SKU; orders with
  the old code can be re-pulled by the next nightly reconcile.

### Orders stuck not-applied
```sql
SELECT order_number, order_date, inventory_apply_attempts, inventory_apply_error
  FROM shipstation_orders
 WHERE inventory_applied_at IS NULL
   AND order_date > now() - interval '7 days'
 ORDER BY order_date;
```
Every row here is revenue we shipped but haven't accounted for in inventory.
Usually unresolved SKUs; sometimes an oversell (stock went negative and was
blocked).

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
