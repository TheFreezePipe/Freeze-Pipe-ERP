-- =============================================================
-- Migration 011: ShipStation integration tables
-- =============================================================
-- Three tables, separating concerns:
--
--   1. shipstation_orders        — durable sales history
--   2. shipstation_order_items   — per-SKU line breakdown
--   3. shipstation_webhook_events — every webhook received, used for
--                                   idempotency AND as an audit trail of
--                                   what ShipStation sent us
--   4. shipstation_sync_runs     — reconciliation job log
--
-- Hygiene principles:
--   * `shipstation_order_id` (ShipStation's id) is UNIQUE — two webhooks
--     for the same order cannot create duplicate rows.
--   * `shipstation_webhook_events.event_id` is UNIQUE — two deliveries of
--     the same event (ShipStation retries on any non-2xx) won't be processed
--     twice.
--   * `inventory_applied_at` flag on each order: inventory delta was applied.
--     Only flipped true after the transactional RPC succeeds.
--   * Reconcile runs can mark discrepancies without touching history —
--     corrections go through the normal cycle-count path.

CREATE TABLE shipstation_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- ShipStation-side identifiers
  shipstation_order_id BIGINT UNIQUE NOT NULL,
  order_number TEXT NOT NULL,
  order_status TEXT NOT NULL,
  -- Timing
  order_date TIMESTAMPTZ NOT NULL,
  ship_date TIMESTAMPTZ,
  -- Customer
  customer_email TEXT,
  customer_name TEXT,
  -- Store/Channel (e.g., Shopify, Amazon)
  store_id BIGINT,
  store_name TEXT,
  -- Money (stored as BIGINT cents for precision)
  order_total_cents BIGINT NOT NULL DEFAULT 0,
  shipping_amount_cents BIGINT NOT NULL DEFAULT 0,
  tax_amount_cents BIGINT NOT NULL DEFAULT 0,
  -- Our tracking of whether inventory has been decremented for this order
  inventory_applied_at TIMESTAMPTZ,
  inventory_apply_attempts INTEGER NOT NULL DEFAULT 0,
  inventory_apply_error TEXT,
  -- Reconciliation
  last_seen_via TEXT CHECK (last_seen_via IN ('webhook', 'api_pull', 'manual')),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Raw payload for forensic use (never indexed; store the lot)
  raw_payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_ss_orders_order_date ON shipstation_orders(order_date DESC);
CREATE INDEX idx_ss_orders_inventory_pending
  ON shipstation_orders(inventory_applied_at)
  WHERE inventory_applied_at IS NULL;
CREATE INDEX idx_ss_orders_order_number ON shipstation_orders(order_number);

CREATE TABLE shipstation_order_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shipstation_order_id UUID NOT NULL REFERENCES shipstation_orders(id) ON DELETE CASCADE,
  shipstation_line_item_id BIGINT,
  -- SKU code as sent by ShipStation. Resolved to a product_skus.id below.
  sku_code TEXT NOT NULL,
  -- Resolved internal SKU. Null when we receive a SKU we don't recognize —
  -- operator must reconcile before inventory can be applied.
  sku_id UUID REFERENCES product_skus(id) ON DELETE RESTRICT,
  quantity INTEGER NOT NULL,
  unit_price_cents BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_ss_item_qty_positive CHECK (quantity > 0)
);

CREATE INDEX idx_ss_items_order ON shipstation_order_items(shipstation_order_id);
CREATE INDEX idx_ss_items_sku ON shipstation_order_items(sku_id);
CREATE INDEX idx_ss_items_unresolved
  ON shipstation_order_items(sku_code)
  WHERE sku_id IS NULL;

CREATE TABLE shipstation_webhook_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Unique per delivery. ShipStation sends a resource_url + event type; we
  -- hash them together with the timestamp as our dedup key.
  event_id TEXT UNIQUE NOT NULL,
  event_type TEXT NOT NULL,           -- ORDER_NOTIFY | SHIP_NOTIFY | ITEM_SHIP_NOTIFY ...
  resource_url TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  processing_error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  -- Signature info: whether and how we verified the request
  signature_verified BOOLEAN NOT NULL DEFAULT false,
  -- Raw request body + headers for forensic use
  request_headers JSONB,
  request_body JSONB,
  -- Optional: the shipstation_order record we created/updated from this event
  resulting_order_id UUID REFERENCES shipstation_orders(id)
);

CREATE INDEX idx_ss_events_pending
  ON shipstation_webhook_events(received_at DESC)
  WHERE processed_at IS NULL;
CREATE INDEX idx_ss_events_type ON shipstation_webhook_events(event_type);

CREATE TABLE shipstation_sync_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_type TEXT NOT NULL CHECK (run_type IN ('webhook_replay', 'nightly_reconcile', 'backfill')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'succeeded', 'failed')),
  -- Range pulled
  from_date TIMESTAMPTZ,
  to_date TIMESTAMPTZ,
  -- Tallies
  orders_pulled INTEGER NOT NULL DEFAULT 0,
  orders_new INTEGER NOT NULL DEFAULT 0,
  orders_updated INTEGER NOT NULL DEFAULT 0,
  orders_drift_detected INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  notes TEXT
);

CREATE INDEX idx_ss_sync_started_at ON shipstation_sync_runs(started_at DESC);

-- RLS: all ShipStation tables are read-only for authenticated users.
-- Writes happen exclusively through Edge Functions (service_role).
ALTER TABLE shipstation_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE shipstation_order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE shipstation_webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE shipstation_sync_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated can read shipstation orders"
  ON shipstation_orders FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated can read shipstation items"
  ON shipstation_order_items FOR SELECT TO authenticated USING (true);
CREATE POLICY "Admins can read webhook events"
  ON shipstation_webhook_events FOR SELECT TO authenticated USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
  );
CREATE POLICY "Authenticated can read sync runs"
  ON shipstation_sync_runs FOR SELECT TO authenticated USING (true);

-- updated_at trigger
CREATE TRIGGER set_updated_at BEFORE UPDATE ON shipstation_orders
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
