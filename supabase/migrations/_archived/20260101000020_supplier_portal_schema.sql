-- =============================================================
-- Migration 020: Supplier portal schema + RLS (part 1 of 2)
-- =============================================================
-- This migration adds the schema necessary for external supplier access
-- to the ERP. No RPCs here — those live in migration 021. Splitting means
-- 020 can apply + verify before any write paths exist, so we can eyeball
-- RLS policies against a known-safe (no mutations possible) state first.
--
-- Sections:
--   A. Supplier capability flags — producer/filler/broker + consolidates_for
--   B. Profile ↔ supplier link + 'supplier' role
--   C. Bill of Materials (BOM) + joint products + consumable components
--   D. Location ownership (supplier-owned facilities)
--   E. Factory orders — cancellation, broker routing, BOM-aware consumption view
--   F. Factory order items — consolidator-confirmed receive, breakage
--   G. Freight shipments — supplier-created, idempotency
--   H. Freight line items — supplier-reported quantity
--   I. Variance + breakage-report tables
--   J. Supplier-facing restricted views (whitelist sensitive columns)
--   K. RLS policies (the security-critical section)
--
-- Reading order: A and B establish identity. C-H extend existing tables to
-- carry supplier-relevant data. I adds new workflow tables. J and K project
-- the data surface that suppliers can reach.

-- =============================================================
-- A. Supplier capability flags
-- =============================================================
-- Suppliers have different capabilities: Nancy produces AND fills AND brokers
-- freight, YX today only produces. These flags + consolidates_for let us
-- represent the current state and the 6-8 month future state (YX becoming
-- an export broker) as pure data changes — no code changes.

ALTER TABLE suppliers
  ADD COLUMN is_producer BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN is_filler BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN is_export_broker BOOLEAN NOT NULL DEFAULT false,
  -- Array of supplier ids whose orders this supplier consolidates.
  -- Nancy.consolidates_for = [YX.id]: Nancy physically receives YX's production
  -- and brokers the US freight on YX's behalf. Empty means "only their own."
  ADD COLUMN consolidates_for UUID[] NOT NULL DEFAULT '{}';

-- Validate consolidates_for entries are real supplier ids. Postgres FK doesn't
-- work inside array elements, so we enforce via trigger.
CREATE OR REPLACE FUNCTION validate_consolidates_for()
RETURNS TRIGGER AS $$
BEGIN
  IF array_length(NEW.consolidates_for, 1) > 0 THEN
    -- Reject self-references — a supplier cannot consolidate for themselves.
    IF NEW.id = ANY(NEW.consolidates_for) THEN
      RAISE EXCEPTION 'supplier % cannot appear in its own consolidates_for array', NEW.id;
    END IF;
    -- Reject unknown supplier ids.
    IF EXISTS (
      SELECT 1
        FROM unnest(NEW.consolidates_for) AS sid
       WHERE sid NOT IN (SELECT id FROM suppliers)
    ) THEN
      RAISE EXCEPTION 'consolidates_for contains an id not present in suppliers';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_validate_consolidates_for
  BEFORE INSERT OR UPDATE OF consolidates_for ON suppliers
  FOR EACH ROW EXECUTE FUNCTION validate_consolidates_for();

COMMENT ON COLUMN suppliers.is_producer IS
  'Can manufacture goods. True for all suppliers today.';
COMMENT ON COLUMN suppliers.is_filler IS
  'Can perform fillable-product assembly (glycerin fill + capping). True for Nancy.';
COMMENT ON COLUMN suppliers.is_export_broker IS
  'Can create freight shipments to us. True for Nancy today. Future: YX.';
COMMENT ON COLUMN suppliers.consolidates_for IS
  'Supplier ids whose orders this supplier consolidates and ships onward. ' ||
  'Nancy.consolidates_for = [YX.id] today.';

-- =============================================================
-- B. Profile ↔ supplier link + 'supplier' role + is_active
-- =============================================================
-- Each supplier has one login (per Scenario 8 MVP call). That user's profile
-- row has supplier_id set, and role = 'supplier'. Internal users have
-- supplier_id = NULL.
--
-- is_active lets admins deactivate a supplier user (when staff changes at
-- the supplier) while preserving the profile row for audit trail integrity.
-- Referential integrity on inventory_transactions.performed_by stays intact.

ALTER TABLE profiles
  -- Nullable: internal users (admin/manager/user) have no supplier.
  ADD COLUMN supplier_id UUID REFERENCES suppliers(id) ON DELETE RESTRICT,
  -- Default true; flipped to false on offboarding. We never DELETE profiles.
  ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT true;

-- Fast lookup for "all supplier users at supplier X" (admin management UI).
-- Partial index keeps size tiny — only supplier rows live here.
CREATE INDEX idx_profiles_supplier ON profiles(supplier_id)
  WHERE supplier_id IS NOT NULL;

-- Extend role check to include 'supplier'. Drop + recreate because the
-- name is auto-generated and the existing constraint can't be altered.
ALTER TABLE profiles DROP CONSTRAINT profiles_role_check;
ALTER TABLE profiles
  ADD CONSTRAINT profiles_role_check
  CHECK (role IN ('admin', 'manager', 'user', 'supplier'));

-- Invariant: a supplier-role user MUST have supplier_id set.
-- A non-supplier-role user MUST NOT have supplier_id set.
-- Prevents orphan supplier profiles and misconfigured internal users.
ALTER TABLE profiles
  ADD CONSTRAINT chk_profile_supplier_role_consistency
  CHECK (
    (role = 'supplier' AND supplier_id IS NOT NULL)
    OR (role != 'supplier' AND supplier_id IS NULL)
  );

-- Update the handle_new_user trigger so new auth users default to
-- internal 'user' role (unchanged from migration 001 — explicit here in
-- comment form). Admin promotes to 'supplier' + sets supplier_id via RPC.

COMMENT ON COLUMN profiles.supplier_id IS
  'FK to suppliers. NULL for internal users. Drives RLS scoping for role = supplier.';
COMMENT ON COLUMN profiles.is_active IS
  'False = deactivated. Profile row retained for audit-trail integrity.';

-- =============================================================
-- C. Bill of Materials (BOM) — joint products + consumable components
-- =============================================================
-- Two flavors of components:
--
--   produced             — manufactured by a supplier via a factory order.
--                          Example: BW21P-COIL produced by YX.
--   consumable_inventory — pulled from on-hand stock at an assembler's
--                          facility. Example: KZ-BLU koozies held at Nancy.
--
-- A SKU "requires BOM" iff it has ≥1 row here as parent_sku_id. No boolean
-- flag needed on product_skus — presence of rows is the source of truth.
--
-- BOM versioning: every row carries effective_from (required) and
-- effective_until (nullable). Editing a BOM doesn't mutate a row — it sets
-- effective_until on the old row and inserts a new row. Queries filter by
-- "active as of order_date" so in-flight orders keep the BOM they were
-- placed against.

CREATE TABLE product_boms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_sku_id UUID NOT NULL REFERENCES product_skus(id) ON DELETE RESTRICT,
  component_sku_id UUID NOT NULL REFERENCES product_skus(id) ON DELETE RESTRICT,
  component_type TEXT NOT NULL
    CHECK (component_type IN ('produced', 'consumable_inventory')),
  -- How many units of this component are needed per 1 unit of the parent.
  -- Nancy's body = 1 per BW21P; a koozie = 1 per BW20. Could be 2 for
  -- something that pairs two of the same component. Never zero.
  units_per_parent INTEGER NOT NULL DEFAULT 1 CHECK (units_per_parent > 0),
  -- For 'produced': which supplier physically joins components into the parent.
  --   (Usually Nancy. The producing supplier of the component is captured on
  --   the component SKU's factory orders, not here.)
  -- For 'consumable_inventory': same meaning — who does the assembly.
  -- NOT NULL — an unassembled BOM is undefined behavior.
  assembled_at_supplier_id UUID NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  -- For 'consumable_inventory' only: which location holds the consumable.
  -- Null is invalid for consumable type; enforced by a CHECK below.
  component_location_id UUID REFERENCES locations(id) ON DELETE RESTRICT,
  -- Versioning
  effective_from DATE NOT NULL DEFAULT CURRENT_DATE,
  effective_until DATE,  -- null = still active
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- A consumable component MUST specify where it's stored. A produced
  -- component doesn't (it comes from factory orders).
  CONSTRAINT chk_bom_location_required_for_consumable CHECK (
    component_type != 'consumable_inventory' OR component_location_id IS NOT NULL
  ),
  -- effective_until, if set, must be after effective_from.
  CONSTRAINT chk_bom_effective_order CHECK (
    effective_until IS NULL OR effective_until > effective_from
  ),
  -- A parent can't be its own component. Prevents trivial cycles.
  CONSTRAINT chk_bom_no_self_reference CHECK (parent_sku_id != component_sku_id)
);

-- At most one ACTIVE (effective_until IS NULL) row per (parent, component) pair.
-- Historical rows (effective_until set) can pile up freely.
CREATE UNIQUE INDEX idx_product_boms_active_unique
  ON product_boms(parent_sku_id, component_sku_id)
  WHERE effective_until IS NULL;

-- Index for "what are the components of X?" — dashboards / assembly views.
CREATE INDEX idx_product_boms_parent ON product_boms(parent_sku_id)
  WHERE effective_until IS NULL;

-- Index for "what parents use this component?" — used by supplier RLS to
-- determine whether to hide / surface a SKU.
CREATE INDEX idx_product_boms_component ON product_boms(component_sku_id)
  WHERE effective_until IS NULL;

-- updated_at + row_version per our established pattern
ALTER TABLE product_boms ADD COLUMN row_version INTEGER NOT NULL DEFAULT 1;

CREATE TRIGGER trg_bump_version_product_boms
  BEFORE UPDATE ON product_boms
  FOR EACH ROW EXECUTE FUNCTION bump_row_version();

CREATE TRIGGER set_updated_at BEFORE UPDATE ON product_boms
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Prevent deeper cycles (A parent of B parent of A). Trigger checks on insert
-- and on update of the parent/component fields.
CREATE OR REPLACE FUNCTION check_bom_no_cycle()
RETURNS TRIGGER AS $$
DECLARE
  v_visited UUID[] := ARRAY[NEW.parent_sku_id];
  v_current UUID := NEW.component_sku_id;
  v_depth INTEGER := 0;
BEGIN
  -- Walk the component chain from NEW.component_sku_id. If we ever hit
  -- NEW.parent_sku_id (or exceed reasonable depth), reject.
  WHILE v_depth < 20 LOOP
    v_depth := v_depth + 1;
    IF v_current = NEW.parent_sku_id THEN
      RAISE EXCEPTION 'BOM insert/update would create a cycle at sku %', v_current;
    END IF;
    IF v_current = ANY(v_visited) THEN
      -- Some other cycle exists already (data corruption); stop walking.
      EXIT;
    END IF;
    v_visited := array_append(v_visited, v_current);
    -- Descend into this component's own BOM (is it also a parent?)
    SELECT component_sku_id INTO v_current
      FROM product_boms
     WHERE parent_sku_id = v_current
       AND effective_until IS NULL
     LIMIT 1;
    IF v_current IS NULL THEN EXIT; END IF;
  END LOOP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_check_bom_no_cycle
  BEFORE INSERT OR UPDATE ON product_boms
  FOR EACH ROW EXECUTE FUNCTION check_bom_no_cycle();

ALTER TABLE product_boms ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE product_boms IS
  'Bill of materials. Parent SKU ← N component SKUs with ratios and types. ' ||
  'Effective-dated: queries should filter by the relevant order date.';

-- =============================================================
-- Helper view — the "active" BOM snapshot for queries that don't care
-- about history. Supplier portal uses this exclusively.
-- =============================================================
CREATE OR REPLACE VIEW product_boms_active AS
  SELECT *
    FROM product_boms
   WHERE effective_until IS NULL;

COMMENT ON VIEW product_boms_active IS
  'Current BOM snapshot. Use this for "what are the components of X today?"';

-- =============================================================
-- D. Location ownership
-- =============================================================
-- For Nancy to have koozie inventory in the system, her facility needs to be
-- a location. Internal warehouse locations have owner_supplier_id = NULL.
-- A supplier can own multiple locations (not used today but the model
-- supports it — e.g., Nancy has a factory and a separate shipping dock).

ALTER TABLE locations
  ADD COLUMN owner_supplier_id UUID REFERENCES suppliers(id) ON DELETE RESTRICT;

-- Index for "which locations does supplier X own?" — used by RLS.
CREATE INDEX idx_locations_owner_supplier ON locations(owner_supplier_id)
  WHERE owner_supplier_id IS NOT NULL;

COMMENT ON COLUMN locations.owner_supplier_id IS
  'If set, this location is owned by an external supplier. NULL = internal warehouse. ' ||
  'Drives RLS on inventory_levels for supplier users.';

-- =============================================================
-- E. Factory orders — cancellation + broker routing
-- =============================================================
-- Two additions:
--   1. ship_via_supplier_id — future-proofs the "YX becomes a broker" case.
--      When set, this order's outbound freight is created by that supplier
--      rather than by the producing supplier. NULL today = current behavior:
--      Nancy consolidates (via consolidates_for) and brokers.
--   2. Cancellation: 'canceled' status plus who/when/why. An order can be
--      canceled after placement if the producing supplier rejects it, if
--      Nancy catches a mistake, or if the business pulls a SKU.
--
-- Cancellation is NOT a soft-delete of the row — the row stays for audit
-- and for inventory_transactions FK integrity. Items on a canceled order
-- must not contribute to demand / ATP calculations; views below enforce.

ALTER TABLE factory_orders
  -- Nullable: today orders ship via their producing supplier's consolidator
  -- (captured implicitly through suppliers.consolidates_for). Set explicitly
  -- to override per-order routing, e.g., "this YX order ships via YX directly
  -- once YX is a broker, bypassing Nancy."
  ADD COLUMN ship_via_supplier_id UUID REFERENCES suppliers(id) ON DELETE RESTRICT,
  ADD COLUMN canceled_at TIMESTAMPTZ,
  ADD COLUMN canceled_by UUID REFERENCES profiles(id) ON DELETE RESTRICT,
  ADD COLUMN canceled_reason TEXT,
  -- Retry-safety for rpc_supplier_create_factory_order. Scoped per supplier
  -- via the unique index below — two different suppliers can use the same
  -- client-side UUID without collision.
  ADD COLUMN idempotency_key UUID;

-- Unique per (supplier, key). Partial so legacy / admin-created rows (no
-- key) aren't forced to carry one.
CREATE UNIQUE INDEX idx_factory_orders_idempotency
  ON factory_orders(supplier_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Extend status CHECK to include 'canceled'. Drop + recreate.
ALTER TABLE factory_orders DROP CONSTRAINT IF EXISTS factory_orders_status_check;
ALTER TABLE factory_orders
  ADD CONSTRAINT factory_orders_status_check
  CHECK (status IN ('ordered', 'in_production', 'finished', 'shipped', 'canceled'));

-- Enforce cancellation triplet coherence: either all three canceled_*
-- fields are set (status = 'canceled'), or all three are null.
ALTER TABLE factory_orders
  ADD CONSTRAINT chk_factory_orders_cancellation_coherent
  CHECK (
    (status = 'canceled'
       AND canceled_at IS NOT NULL
       AND canceled_by IS NOT NULL
       AND canceled_reason IS NOT NULL
       AND length(trim(canceled_reason)) > 0)
    OR (status != 'canceled'
       AND canceled_at IS NULL
       AND canceled_by IS NULL
       AND canceled_reason IS NULL)
  );

CREATE INDEX idx_factory_orders_ship_via ON factory_orders(ship_via_supplier_id)
  WHERE ship_via_supplier_id IS NOT NULL;

-- Partial index for "active (non-canceled) orders" — the dashboard's hot path.
CREATE INDEX idx_factory_orders_active_by_supplier
  ON factory_orders(supplier_id, status, order_date)
  WHERE status != 'canceled';

COMMENT ON COLUMN factory_orders.ship_via_supplier_id IS
  'Per-order outbound freight routing override. NULL = default (consolidator via suppliers.consolidates_for).';
COMMENT ON COLUMN factory_orders.canceled_at IS
  'Cancellation timestamp. Row is preserved for audit; items should not contribute to demand.';

-- =============================================================
-- F. Factory order items — consolidator-confirmed receive + breakage
-- =============================================================
-- The producing supplier reports a "produced" quantity when the order is
-- finished. The consolidator (Nancy) inspects on receive and may find that
-- the actual count differs and/or that some units arrived broken. We capture
-- both signals separately so downstream analytics can distinguish
-- "YX miscounted" from "transit breakage at YX→Nancy leg."

ALTER TABLE factory_order_items
  -- Filled by the consolidator (Nancy) when the order physically arrives.
  -- Null until then. Represents the consolidator's authoritative count —
  -- what actually landed on the dock, inclusive of breakage.
  ADD COLUMN consolidator_confirmed_quantity INTEGER,
  ADD COLUMN consolidator_confirmed_at TIMESTAMPTZ,
  ADD COLUMN consolidator_confirmed_by UUID REFERENCES profiles(id) ON DELETE RESTRICT,
  -- Units counted as broken / unusable on receive. Default 0. This is a
  -- subset of consolidator_confirmed_quantity — the confirmed count already
  -- includes breakage; this column breaks out how much of it was broken.
  -- The usable/sellable portion = consolidator_confirmed_quantity - quantity_breakage.
  ADD COLUMN quantity_breakage INTEGER NOT NULL DEFAULT 0 CHECK (quantity_breakage >= 0);

-- Breakage can't exceed confirmed quantity. Null confirmed quantity = no
-- receive has happened yet, so breakage must remain 0.
ALTER TABLE factory_order_items
  ADD CONSTRAINT chk_factory_order_items_breakage_bounds
  CHECK (
    (consolidator_confirmed_quantity IS NULL AND quantity_breakage = 0)
    OR (consolidator_confirmed_quantity IS NOT NULL AND quantity_breakage <= consolidator_confirmed_quantity)
  );

-- Confirmation triplet coherence: either all three consolidator_* fields
-- are set, or all three are null. Prevents half-filled receives.
ALTER TABLE factory_order_items
  ADD CONSTRAINT chk_factory_order_items_confirm_coherent
  CHECK (
    (consolidator_confirmed_quantity IS NULL AND consolidator_confirmed_at IS NULL AND consolidator_confirmed_by IS NULL)
    OR (consolidator_confirmed_quantity IS NOT NULL AND consolidator_confirmed_at IS NOT NULL AND consolidator_confirmed_by IS NOT NULL)
  );

COMMENT ON COLUMN factory_order_items.consolidator_confirmed_quantity IS
  'Physical count at consolidator receive. NULL until receive. Inclusive of breakage.';
COMMENT ON COLUMN factory_order_items.quantity_breakage IS
  'Broken/unusable units within consolidator_confirmed_quantity. Usable = confirmed - breakage.';

-- =============================================================
-- G. Freight shipments — supplier-created + idempotency + origin supplier
-- =============================================================
-- Today freight rows are created by internal users against a trusted UI.
-- Once suppliers create them via the portal, we need:
--
--   1. origin_supplier_id — records which supplier declared the shipment.
--      A supplier can only see/mutate shipments where this = their id,
--      regardless of what else is on the row. NULL permitted for legacy
--      rows; new supplier-created rows must set it.
--
--   2. created_by_supplier_user_id — which specific supplier user logged in
--      and clicked "create." Denormalized from profiles.created_by for
--      supplier-side audit reporting (so we don't have to join through
--      profiles every time). Null for internally-created rows.
--
--   3. idempotency_key — every supplier-side create RPC accepts a client-
--      generated UUID. If the request retries (dropped socket, double-click),
--      the UNIQUE index ensures we don't create two shipments. Scoped per
--      supplier so keys from different suppliers can't collide.

ALTER TABLE freight_shipments
  ADD COLUMN origin_supplier_id UUID REFERENCES suppliers(id) ON DELETE RESTRICT,
  ADD COLUMN created_by_supplier_user_id UUID REFERENCES profiles(id) ON DELETE RESTRICT,
  ADD COLUMN idempotency_key UUID;

-- Uniqueness per (origin_supplier, key). Partial so internal rows (no
-- supplier, no key) don't have to carry a value.
CREATE UNIQUE INDEX idx_freight_shipments_idempotency
  ON freight_shipments(origin_supplier_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Invariant: if origin_supplier_id is set, the creating user's profile must
-- be a supplier user of THAT supplier. Enforced in the create RPC rather
-- than a CHECK (can't easily join to profiles from a row-level CHECK).
--
-- Invariant: idempotency_key without origin_supplier_id is nonsensical.
ALTER TABLE freight_shipments
  ADD CONSTRAINT chk_freight_idempotency_scoped
  CHECK (idempotency_key IS NULL OR origin_supplier_id IS NOT NULL);

-- Partial index for "all shipments from supplier X" — supplier dashboard hot path.
CREATE INDEX idx_freight_shipments_origin_supplier
  ON freight_shipments(origin_supplier_id, created_at DESC)
  WHERE origin_supplier_id IS NOT NULL;

COMMENT ON COLUMN freight_shipments.origin_supplier_id IS
  'Supplier who declared this shipment. NULL = internal-created (legacy or admin).';
COMMENT ON COLUMN freight_shipments.idempotency_key IS
  'Client-supplied UUID for retry-safe supplier creates. Unique per origin_supplier.';

-- =============================================================
-- H. Freight line items — supplier-declared vs. receiver-confirmed quantities
-- =============================================================
-- Same pattern as factory_order_items: the supplier declares a shipped
-- quantity, the receiver (internal warehouse) confirms a received quantity
-- on actual arrival. Variance rows (section I) are generated when they
-- disagree. Existing columns (quantity) keep meaning "received quantity"
-- for backwards compat; we add a supplier-declared column alongside.

ALTER TABLE freight_line_items
  -- What the supplier says they put on the truck. Null for legacy /
  -- internally-created rows where the distinction doesn't apply.
  ADD COLUMN supplier_declared_quantity INTEGER
    CHECK (supplier_declared_quantity IS NULL OR supplier_declared_quantity >= 0),
  -- Link back to the factory order item(s) this line is sourced from.
  -- Null allowed — freight can carry items that weren't from a factory
  -- order (samples, spare parts). When set, downstream reconciliation can
  -- walk factory_order_items → this line → freight_shipments.
  ADD COLUMN source_factory_order_item_id UUID
    REFERENCES factory_order_items(id) ON DELETE RESTRICT;

CREATE INDEX idx_freight_line_items_source_foi
  ON freight_line_items(source_factory_order_item_id)
  WHERE source_factory_order_item_id IS NOT NULL;

COMMENT ON COLUMN freight_line_items.supplier_declared_quantity IS
  'Shipped qty per supplier. `quantity` remains the received/confirmed qty on delivery.';
COMMENT ON COLUMN freight_line_items.source_factory_order_item_id IS
  'Optional linkage back to the factory order item. Enables order→shipment→receive reconciliation.';

-- =============================================================
-- I. Variance + breakage report tables
-- =============================================================
-- Two new workflow tables. Both are append-only (UPDATE/DELETE blocked) and
-- have their own status fields for resolution workflow.

-- -------------------------------------------------------------
-- I.1 shipment_variances — receiver vs. supplier disagreement
-- -------------------------------------------------------------
-- Created automatically by rpc_apply_freight_delivery (migration 021) when
-- freight_line_items.quantity != supplier_declared_quantity on a line where
-- both are set. One row per line with a variance. Status drives the
-- resolution UI: open → acknowledged → resolved.

CREATE TABLE shipment_variances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  freight_line_item_id UUID NOT NULL REFERENCES freight_line_items(id) ON DELETE RESTRICT,
  shipment_id UUID NOT NULL REFERENCES freight_shipments(id) ON DELETE RESTRICT,
  sku_id UUID NOT NULL REFERENCES product_skus(id) ON DELETE RESTRICT,
  origin_supplier_id UUID NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  -- Snapshot of the two numbers at the moment the variance was opened.
  -- Retained even if the source row changes later.
  declared_quantity INTEGER NOT NULL CHECK (declared_quantity >= 0),
  received_quantity INTEGER NOT NULL CHECK (received_quantity >= 0),
  -- Generated: received − declared. Negative = shortage (missing units).
  -- Positive = overage. Kept generated so we can index / query without math.
  variance_quantity INTEGER GENERATED ALWAYS AS (received_quantity - declared_quantity) STORED,
  -- Typed classification helps analytics + drives different workflows.
  variance_type TEXT NOT NULL
    CHECK (variance_type IN ('shortage', 'overage', 'breakage_in_transit', 'damage', 'other')),
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'acknowledged', 'resolved', 'written_off')),
  notes TEXT,
  resolution_notes TEXT,
  acknowledged_at TIMESTAMPTZ,
  acknowledged_by UUID REFERENCES profiles(id) ON DELETE RESTRICT,
  resolved_at TIMESTAMPTZ,
  resolved_by UUID REFERENCES profiles(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID REFERENCES profiles(id) ON DELETE RESTRICT,

  -- Status-coherence: once acknowledged, the acknowledged_* fields must be set.
  CONSTRAINT chk_variance_ack_coherent CHECK (
    (status = 'open' AND acknowledged_at IS NULL AND acknowledged_by IS NULL)
    OR (status != 'open' AND acknowledged_at IS NOT NULL AND acknowledged_by IS NOT NULL)
  ),
  -- Resolution coherence: terminal states require resolved_* set.
  CONSTRAINT chk_variance_resolved_coherent CHECK (
    (status IN ('resolved', 'written_off')
      AND resolved_at IS NOT NULL AND resolved_by IS NOT NULL
      AND resolution_notes IS NOT NULL AND length(trim(resolution_notes)) > 0)
    OR (status NOT IN ('resolved', 'written_off')
      AND resolved_at IS NULL AND resolved_by IS NULL)
  )
);

CREATE INDEX idx_shipment_variances_open
  ON shipment_variances(origin_supplier_id, created_at DESC)
  WHERE status IN ('open', 'acknowledged');

CREATE INDEX idx_shipment_variances_shipment
  ON shipment_variances(shipment_id);

CREATE INDEX idx_shipment_variances_sku
  ON shipment_variances(sku_id, created_at DESC);

-- Append-only guards — same pattern as task_logs / inventory_transactions.
-- Status transitions happen via a dedicated RPC that deletes + re-inserts?
-- No — status is the ONE mutable field. Carve a targeted exception: allow
-- UPDATE only when the columns being updated are in a whitelist. Enforce
-- via a trigger that compares OLD/NEW per-column.
CREATE OR REPLACE FUNCTION enforce_shipment_variance_append_only()
RETURNS TRIGGER AS $$
BEGIN
  -- Immutable fields: the facts of the variance must never change.
  IF NEW.freight_line_item_id   IS DISTINCT FROM OLD.freight_line_item_id
  OR NEW.shipment_id            IS DISTINCT FROM OLD.shipment_id
  OR NEW.sku_id                 IS DISTINCT FROM OLD.sku_id
  OR NEW.origin_supplier_id     IS DISTINCT FROM OLD.origin_supplier_id
  OR NEW.declared_quantity      IS DISTINCT FROM OLD.declared_quantity
  OR NEW.received_quantity      IS DISTINCT FROM OLD.received_quantity
  OR NEW.variance_type          IS DISTINCT FROM OLD.variance_type
  OR NEW.created_at             IS DISTINCT FROM OLD.created_at
  OR NEW.created_by             IS DISTINCT FROM OLD.created_by
  OR NEW.notes                  IS DISTINCT FROM OLD.notes THEN
    RAISE EXCEPTION 'shipment_variances: immutable field modified. Only status / resolution fields may change.'
      USING HINT = 'To record a correction, resolve this variance and open a new one.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_shipment_variance_append_only
  BEFORE UPDATE ON shipment_variances
  FOR EACH ROW EXECUTE FUNCTION enforce_shipment_variance_append_only();

CREATE OR REPLACE FUNCTION block_shipment_variance_delete()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'shipment_variances is append-only. DELETE is not permitted.';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_shipment_variance_no_delete
  BEFORE DELETE ON shipment_variances
  FOR EACH ROW EXECUTE FUNCTION block_shipment_variance_delete();

ALTER TABLE shipment_variances ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE shipment_variances IS
  'Shipment-level discrepancies. Append-only except for status/resolution fields. ' ||
  'Created by rpc_apply_freight_delivery when declared != received.';

-- -------------------------------------------------------------
-- I.2 component_breakage_reports — narrative + evidence for breakage
-- -------------------------------------------------------------
-- The numeric breakage count lives on factory_order_items.quantity_breakage.
-- This table holds the narrative: when Nancy opens boxes and finds broken
-- coils, she logs a report here with photos (via existing documents table),
-- reason codes, and replacement requests. YX sees reports on their own
-- orders and can acknowledge / dispute.
--
-- Decoupled from factory_order_items so one order can have multiple reports
-- (e.g., damaged cases discovered a week apart as different pallets get
-- unpacked) and so the lifecycle (open → replacement_requested → resolved)
-- is independent of the factory order's own status.

CREATE TABLE component_breakage_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  factory_order_item_id UUID NOT NULL REFERENCES factory_order_items(id) ON DELETE RESTRICT,
  -- Denormalized for RLS speed — avoids a 3-level join on every read.
  producing_supplier_id UUID NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  reporter_supplier_id UUID NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  sku_id UUID NOT NULL REFERENCES product_skus(id) ON DELETE RESTRICT,
  quantity_broken INTEGER NOT NULL CHECK (quantity_broken > 0),
  -- Reason code: free-form but encouraged-list in UI.
  reason_category TEXT NOT NULL
    CHECK (reason_category IN ('crushed_in_transit', 'manufacturing_defect', 'wet_damage', 'contamination', 'other')),
  description TEXT NOT NULL CHECK (length(trim(description)) > 0),
  -- Replacement workflow state
  replacement_requested BOOLEAN NOT NULL DEFAULT false,
  replacement_factory_order_id UUID REFERENCES factory_orders(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'acknowledged', 'disputed', 'resolved', 'written_off')),
  acknowledged_at TIMESTAMPTZ,
  acknowledged_by UUID REFERENCES profiles(id) ON DELETE RESTRICT,
  resolution_notes TEXT,
  resolved_at TIMESTAMPTZ,
  resolved_by UUID REFERENCES profiles(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,

  -- producing_supplier_id must NOT equal reporter_supplier_id. A supplier
  -- doesn't open a breakage report against themselves — that's an internal
  -- QC issue, not a cross-supplier dispute.
  -- Additional constraint (trigger below): reporter must consolidate for
  -- producer. Enforced in a trigger because CHECK can't subquery suppliers.
  CONSTRAINT chk_breakage_distinct_parties
    CHECK (producing_supplier_id != reporter_supplier_id),

  CONSTRAINT chk_breakage_ack_coherent CHECK (
    (status = 'open' AND acknowledged_at IS NULL AND acknowledged_by IS NULL)
    OR (status != 'open' AND acknowledged_at IS NOT NULL AND acknowledged_by IS NOT NULL)
  ),
  CONSTRAINT chk_breakage_resolved_coherent CHECK (
    (status IN ('resolved', 'written_off')
      AND resolved_at IS NOT NULL AND resolved_by IS NOT NULL
      AND resolution_notes IS NOT NULL AND length(trim(resolution_notes)) > 0)
    OR (status NOT IN ('resolved', 'written_off')
      AND resolved_at IS NULL AND resolved_by IS NULL)
  ),
  -- Replacement linkage: if replacement_factory_order_id is set, the flag
  -- must also be set. Can't have a replacement FO without explicitly
  -- requesting one.
  CONSTRAINT chk_breakage_replacement_coherent CHECK (
    replacement_factory_order_id IS NULL OR replacement_requested = true
  )
);

CREATE INDEX idx_breakage_reports_producer_open
  ON component_breakage_reports(producing_supplier_id, created_at DESC)
  WHERE status IN ('open', 'acknowledged', 'disputed');

CREATE INDEX idx_breakage_reports_reporter
  ON component_breakage_reports(reporter_supplier_id, created_at DESC);

CREATE INDEX idx_breakage_reports_foi
  ON component_breakage_reports(factory_order_item_id);

-- Append-only guard — same carve-out as shipment_variances.
CREATE OR REPLACE FUNCTION enforce_breakage_report_append_only()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.factory_order_item_id  IS DISTINCT FROM OLD.factory_order_item_id
  OR NEW.producing_supplier_id  IS DISTINCT FROM OLD.producing_supplier_id
  OR NEW.reporter_supplier_id   IS DISTINCT FROM OLD.reporter_supplier_id
  OR NEW.sku_id                 IS DISTINCT FROM OLD.sku_id
  OR NEW.quantity_broken        IS DISTINCT FROM OLD.quantity_broken
  OR NEW.reason_category        IS DISTINCT FROM OLD.reason_category
  OR NEW.description            IS DISTINCT FROM OLD.description
  OR NEW.created_at             IS DISTINCT FROM OLD.created_at
  OR NEW.created_by             IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'component_breakage_reports: immutable field modified. Only workflow fields may change.'
      USING HINT = 'Open a new report to correct the facts; resolve the old one with notes.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_breakage_report_append_only
  BEFORE UPDATE ON component_breakage_reports
  FOR EACH ROW EXECUTE FUNCTION enforce_breakage_report_append_only();

-- Reporter must consolidate for producer. Per user call: MVP assumes
-- only consolidators open breakage reports against their upstream producers.
-- If a future 3-party flow needs to relax this, lift the trigger — but for
-- today it stops miswired reports (e.g., YX opening a report against Nancy).
CREATE OR REPLACE FUNCTION enforce_breakage_reporter_consolidates()
RETURNS TRIGGER AS $$
DECLARE
  v_consolidates UUID[];
BEGIN
  SELECT consolidates_for INTO v_consolidates
    FROM suppliers WHERE id = NEW.reporter_supplier_id;

  IF v_consolidates IS NULL OR NOT (NEW.producing_supplier_id = ANY(v_consolidates)) THEN
    RAISE EXCEPTION
      'reporter_supplier_id (%) does not consolidate for producing_supplier_id (%)',
      NEW.reporter_supplier_id, NEW.producing_supplier_id
      USING HINT = 'Only a consolidator (suppliers.consolidates_for contains the producer) may open a breakage report.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_breakage_reporter_consolidates
  BEFORE INSERT ON component_breakage_reports
  FOR EACH ROW EXECUTE FUNCTION enforce_breakage_reporter_consolidates();

CREATE OR REPLACE FUNCTION block_breakage_report_delete()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'component_breakage_reports is append-only. DELETE is not permitted.';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_breakage_report_no_delete
  BEFORE DELETE ON component_breakage_reports
  FOR EACH ROW EXECUTE FUNCTION block_breakage_report_delete();

ALTER TABLE component_breakage_reports ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE component_breakage_reports IS
  'Narrative breakage reports between suppliers (reporter vs producer). Append-only ' ||
  'except for workflow fields. Numeric counts live on factory_order_items.quantity_breakage.';

-- =============================================================
-- J. Supplier-facing views
-- =============================================================
-- Views project a narrow, column-whitelisted surface for supplier users.
-- RLS on base tables (section K) is the hard boundary; views are a
-- defense-in-depth + DX layer so hooks don't accidentally SELECT columns
-- a supplier shouldn't see (landed_cost, duty, retail_price, margin, etc.).
--
-- IMPORTANT: views in Postgres run as the VIEW OWNER by default, which
-- would bypass RLS on the base tables. We set security_invoker = true on
-- all these views so RLS on the underlying tables still applies to the
-- querying user — the view is pure column projection, not a privilege
-- escalation.

-- -------------------------------------------------------------
-- J.1 supplier_portal_skus — what a supplier can see about product SKUs
-- -------------------------------------------------------------
-- Suppliers see: sku, name, is_active. They do NOT see: retail_price,
-- landed_cost, margin, reorder thresholds, our demand numbers.
CREATE OR REPLACE VIEW supplier_portal_skus
  WITH (security_invoker = true) AS
  SELECT
    id,
    sku,
    product_name,
    category,
    is_active,
    created_at
  FROM product_skus;

COMMENT ON VIEW supplier_portal_skus IS
  'Column-whitelisted SKU projection for supplier portal. Excludes pricing/cost/demand.';

-- -------------------------------------------------------------
-- J.2 supplier_portal_factory_orders — orders a supplier can see
-- -------------------------------------------------------------
-- A supplier sees: orders where they are the producing supplier, OR orders
-- where they consolidate the producer (Nancy sees YX orders). RLS on
-- factory_orders enforces the row filter; this view hides columns like
-- internal cost fields if we add them later.
CREATE OR REPLACE VIEW supplier_portal_factory_orders
  WITH (security_invoker = true) AS
  SELECT
    id,
    supplier_id,
    ship_via_supplier_id,
    order_date,
    expected_completion,
    status,
    canceled_at,
    canceled_reason,
    notes,
    created_at,
    updated_at,
    row_version
  FROM factory_orders;

COMMENT ON VIEW supplier_portal_factory_orders IS
  'Column-whitelisted factory order projection for supplier portal.';

-- -------------------------------------------------------------
-- J.3 supplier_portal_factory_order_items — items on those orders
-- -------------------------------------------------------------
CREATE OR REPLACE VIEW supplier_portal_factory_order_items
  WITH (security_invoker = true) AS
  SELECT
    foi.id,
    foi.factory_order_id,
    foi.sku_id,
    foi.quantity_ordered,
    foi.consolidator_confirmed_quantity,
    foi.consolidator_confirmed_at,
    foi.quantity_breakage,
    foi.created_at,
    foi.row_version
  FROM factory_order_items foi;

COMMENT ON VIEW supplier_portal_factory_order_items IS
  'Column-whitelisted factory order items for supplier portal.';

-- -------------------------------------------------------------
-- J.4 supplier_portal_freight_shipments — shipments they created or consolidate
-- -------------------------------------------------------------
-- Excludes: landed_cost_total, duty_paid, broker_fee — anything the
-- supplier shouldn't know about our cost stack. They see tracking-grade data.
CREATE OR REPLACE VIEW supplier_portal_freight_shipments
  WITH (security_invoker = true) AS
  SELECT
    id,
    origin_supplier_id,
    tracking_number,
    carrier_name,
    status,
    eta,
    eta_original,
    actual_arrival_date,
    total_cartons,
    created_by_supplier_user_id,
    idempotency_key,
    created_at,
    updated_at,
    row_version
  FROM freight_shipments;

COMMENT ON VIEW supplier_portal_freight_shipments IS
  'Column-whitelisted freight projection. Excludes cost/duty/broker-fee columns.';

-- -------------------------------------------------------------
-- J.5 supplier_portal_freight_line_items — line detail on their shipments
-- -------------------------------------------------------------
-- NOTE: quantity_prefilled is added to freight_line_items in migration 027
-- and re-projected into this view in migration 029. Left out of this
-- definition so applying migrations in order doesn't error with a
-- "column does not exist" at time 020. Re-run 029 will finalize the shape.
CREATE OR REPLACE VIEW supplier_portal_freight_line_items
  WITH (security_invoker = true) AS
  SELECT
    fli.id,
    fli.freight_shipment_id,
    fli.sku_id,
    fli.quantity,
    fli.supplier_declared_quantity,
    fli.source_factory_order_item_id,
    fli.created_at,
    fli.updated_at
  FROM freight_line_items fli;

COMMENT ON VIEW supplier_portal_freight_line_items IS
  'Freight line items for supplier portal. Excludes unit_cost / line_cost columns. See migration 029 for quantity_prefilled projection.';

-- -------------------------------------------------------------
-- J.6 supplier_portal_variances + supplier_portal_breakage_reports
-- -------------------------------------------------------------
-- Suppliers see variances + breakage reports filed against them OR by them.
-- Column projection just excludes created_by (internal user id — supplier
-- sees the supplier-level party, not the specific human).
CREATE OR REPLACE VIEW supplier_portal_variances
  WITH (security_invoker = true) AS
  SELECT
    id,
    freight_line_item_id,
    shipment_id,
    sku_id,
    origin_supplier_id,
    declared_quantity,
    received_quantity,
    variance_quantity,
    variance_type,
    status,
    notes,
    resolution_notes,
    acknowledged_at,
    resolved_at,
    created_at
  FROM shipment_variances;

CREATE OR REPLACE VIEW supplier_portal_breakage_reports
  WITH (security_invoker = true) AS
  SELECT
    id,
    factory_order_item_id,
    producing_supplier_id,
    reporter_supplier_id,
    sku_id,
    quantity_broken,
    reason_category,
    description,
    replacement_requested,
    replacement_factory_order_id,
    status,
    resolution_notes,
    acknowledged_at,
    resolved_at,
    created_at
  FROM component_breakage_reports;

-- =============================================================
-- K. Row-Level Security policies
-- =============================================================
-- This is the security-critical section. Rules:
--
--   1. Every policy is explicit — no reliance on "default deny" alone.
--      We state SELECT / INSERT / UPDATE / DELETE separately.
--
--   2. Supplier policies use a SECURITY DEFINER helper (jwt_supplier_id())
--      that reads the caller's profile row once per query. Avoids
--      recursive RLS (profile reads profile) and is faster than a CTE.
--
--   3. "Visibility" = own orders OR orders they consolidate for.
--      Consolidator check uses suppliers.consolidates_for @> ARRAY[...].
--
--   4. Supplier policies NEVER grant DELETE. Everything is append-only
--      or update-via-RPC. Hard rule.
--
--   5. We don't remove existing policies — we ADD supplier-scoped policies
--      ON TOP. Existing "admin/manager can X" policies remain.

-- -------------------------------------------------------------
-- K.0 Helper functions (SECURITY DEFINER, read-only)
-- -------------------------------------------------------------

-- Returns the supplier_id of the calling user, or NULL if the user is
-- internal (or not authenticated). Stable within a query.
CREATE OR REPLACE FUNCTION jwt_supplier_id()
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT supplier_id
    FROM profiles
   WHERE id = auth.uid()
     AND is_active = true
     AND role = 'supplier'
$$;

-- Returns array of supplier ids the caller consolidates for (plus self).
-- A supplier sees their own + any producer they consolidate for.
CREATE OR REPLACE FUNCTION jwt_supplier_scope()
RETURNS UUID[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    ARRAY[s.id] || s.consolidates_for,
    ARRAY[]::UUID[]
  )
    FROM profiles p
    JOIN suppliers s ON s.id = p.supplier_id
   WHERE p.id = auth.uid()
     AND p.is_active = true
     AND p.role = 'supplier'
$$;

-- Returns true if the caller is internal staff (admin/manager/user).
-- Handy where a policy is "internal OR supplier-scoped."
CREATE OR REPLACE FUNCTION jwt_is_internal()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM profiles
     WHERE id = auth.uid()
       AND is_active = true
       AND role IN ('admin', 'manager', 'user')
  )
$$;

COMMENT ON FUNCTION jwt_supplier_id IS
  'Caller supplier_id or NULL. Null-safe: internal users return NULL, unauthenticated return NULL.';
COMMENT ON FUNCTION jwt_supplier_scope IS
  'Supplier ids visible to the caller: self + consolidates_for. Empty array if not a supplier.';

-- -------------------------------------------------------------
-- K.1 suppliers — supplier sees their own row + ones they consolidate for
-- -------------------------------------------------------------
-- RLS is already enabled on suppliers in earlier migrations.
-- Add a supplier-scoped SELECT policy.
CREATE POLICY "supplier_select_in_scope" ON suppliers
  FOR SELECT TO authenticated
  USING (id = ANY(jwt_supplier_scope()));

-- No INSERT/UPDATE/DELETE — suppliers never edit the suppliers table.
-- Internal admin policies (from migration that created suppliers) remain.

-- -------------------------------------------------------------
-- K.2 profiles — supplier sees their own profile only
-- -------------------------------------------------------------
-- Suppliers must NOT be able to enumerate internal user emails / profiles.
CREATE POLICY "supplier_select_own_profile" ON profiles
  FOR SELECT TO authenticated
  USING (
    id = auth.uid()
    -- Or: internal user viewing (handled by existing "internal users can
    -- select profiles" policy from migration 001).
  );
-- Note: we do NOT give suppliers UPDATE on their own profile row here.
-- Role + supplier_id changes go through rpc_update_user_role (admin-only).
-- Name / contact edits by suppliers can be added later via RPC if needed.

-- -------------------------------------------------------------
-- K.3 product_skus — suppliers see only SKUs they're involved with
-- -------------------------------------------------------------
-- "Involved" = appears on one of their factory orders OR is a component
-- in a BOM assembled by them OR is a component they produce on someone
-- else's BOM.
--
-- Performance: this is a correlated EXISTS per row. SKU count is ~hundreds,
-- query result set is small. Fine for MVP.
CREATE POLICY "supplier_select_related_skus" ON product_skus
  FOR SELECT TO authenticated
  USING (
    jwt_supplier_id() IS NOT NULL
    AND (
      -- SKUs on their factory orders (own or consolidated)
      EXISTS (
        SELECT 1 FROM factory_order_items foi
        JOIN factory_orders fo ON fo.id = foi.factory_order_id
        WHERE foi.sku_id = product_skus.id
          AND fo.supplier_id = ANY(jwt_supplier_scope())
      )
      -- SKUs that are components in BOMs assembled by them
      OR EXISTS (
        SELECT 1 FROM product_boms b
        WHERE b.component_sku_id = product_skus.id
          AND b.assembled_at_supplier_id = ANY(jwt_supplier_scope())
          AND b.effective_until IS NULL
      )
      -- Parent SKUs whose BOMs they assemble
      OR EXISTS (
        SELECT 1 FROM product_boms b
        WHERE b.parent_sku_id = product_skus.id
          AND b.assembled_at_supplier_id = ANY(jwt_supplier_scope())
          AND b.effective_until IS NULL
      )
    )
  );

-- -------------------------------------------------------------
-- K.4 product_boms — suppliers see BOMs where they're the assembler OR
--                    they produce one of the components
-- -------------------------------------------------------------
-- CRITICAL: the Scenario 4 requirement. YX must NOT see Nancy's koozie
-- composition ("BW20 = coil + koozie") because that leaks supply chain
-- info. YX CAN see BOMs for SKUs they produce components for, but the
-- view they get on those is column-whitelisted (product_boms_active
-- doesn't leak costs). The filter below is: you see a BOM row iff
-- you assemble it. If you merely produce a component, you don't see
-- the fact that you're a component — factory_orders are your view.
--
-- Per the user's vote in the adversarial walkthrough: "YX should not
-- know Nancy uses koozies with their coils." So assembly-only visibility
-- is correct.
CREATE POLICY "supplier_select_assembled_boms" ON product_boms
  FOR SELECT TO authenticated
  USING (assembled_at_supplier_id = ANY(jwt_supplier_scope()));

-- -------------------------------------------------------------
-- K.5 locations — suppliers see only their own locations
-- -------------------------------------------------------------
CREATE POLICY "supplier_select_own_locations" ON locations
  FOR SELECT TO authenticated
  USING (owner_supplier_id = ANY(jwt_supplier_scope()));

-- -------------------------------------------------------------
-- K.6 factory_orders — in-scope orders, read + update-via-RPC only
-- -------------------------------------------------------------
CREATE POLICY "supplier_select_in_scope_factory_orders" ON factory_orders
  FOR SELECT TO authenticated
  USING (
    supplier_id = ANY(jwt_supplier_scope())
    OR ship_via_supplier_id = ANY(jwt_supplier_scope())
  );

-- Suppliers create their own factory orders (YX logs a new production run).
-- The RPC validates supplier_id matches jwt; policy is the backstop.
CREATE POLICY "supplier_insert_own_factory_orders" ON factory_orders
  FOR INSERT TO authenticated
  WITH CHECK (
    supplier_id = jwt_supplier_id()
    AND status = 'ordered'  -- new orders always start here
  );

-- NO UPDATE policy for suppliers. All status transitions go through
-- SECURITY DEFINER RPCs in migration 021 (rpc_supplier_advance_order_status,
-- rpc_supplier_cancel_order, etc.) that run with elevated privilege and
-- enforce the allowed state machine.

-- NO DELETE policy. Ever.

-- -------------------------------------------------------------
-- K.7 factory_order_items — read + insert on own orders
-- -------------------------------------------------------------
CREATE POLICY "supplier_select_in_scope_foi" ON factory_order_items
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM factory_orders fo
       WHERE fo.id = factory_order_items.factory_order_id
         AND (fo.supplier_id = ANY(jwt_supplier_scope())
              OR fo.ship_via_supplier_id = ANY(jwt_supplier_scope()))
    )
  );

CREATE POLICY "supplier_insert_own_foi" ON factory_order_items
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM factory_orders fo
       WHERE fo.id = factory_order_items.factory_order_id
         AND fo.supplier_id = jwt_supplier_id()
         AND fo.status = 'ordered'  -- items can only be added while order is still draftable
    )
    -- consolidator_confirmed_* and quantity_breakage must be null on insert —
    -- those are filled by the consolidator via RPC later.
    AND consolidator_confirmed_quantity IS NULL
    AND consolidator_confirmed_at IS NULL
    AND consolidator_confirmed_by IS NULL
    AND quantity_breakage = 0
  );

-- -------------------------------------------------------------
-- K.8 freight_shipments — read own/consolidated, insert own
-- -------------------------------------------------------------
CREATE POLICY "supplier_select_own_shipments" ON freight_shipments
  FOR SELECT TO authenticated
  USING (origin_supplier_id = ANY(jwt_supplier_scope()));

CREATE POLICY "supplier_insert_own_shipments" ON freight_shipments
  FOR INSERT TO authenticated
  WITH CHECK (
    origin_supplier_id = jwt_supplier_id()
    AND created_by_supplier_user_id = auth.uid()
    -- Initial status must be a pre-departure state; suppliers can't
    -- insert an already-delivered shipment to bypass receiving.
    AND status IN ('pending', 'booked')
  );

-- NO UPDATE policy for suppliers. Mutations via RPC.

-- -------------------------------------------------------------
-- K.9 freight_line_items — read on own shipments, insert on own
-- -------------------------------------------------------------
CREATE POLICY "supplier_select_own_freight_lines" ON freight_line_items
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM freight_shipments s
       WHERE s.id = freight_line_items.freight_shipment_id
         AND s.origin_supplier_id = ANY(jwt_supplier_scope())
    )
  );

CREATE POLICY "supplier_insert_own_freight_lines" ON freight_line_items
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM freight_shipments s
       WHERE s.id = freight_line_items.freight_shipment_id
         AND s.origin_supplier_id = jwt_supplier_id()
         AND s.status IN ('pending', 'booked')
    )
    -- Received quantity must match declared on insert — receiver updates via RPC
    AND supplier_declared_quantity IS NOT NULL
    AND quantity = supplier_declared_quantity
  );

-- -------------------------------------------------------------
-- K.10 inventory_levels — suppliers see stocks at their own locations only
-- -------------------------------------------------------------
-- Nancy has consumable stock (koozies) — she sees it.
-- YX has no locations owned in our system today, so sees nothing.
CREATE POLICY "supplier_select_own_inventory" ON inventory_levels
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM locations l
       WHERE l.id = inventory_levels.location_id
         AND l.owner_supplier_id = ANY(jwt_supplier_scope())
    )
  );

-- No INSERT / UPDATE / DELETE for suppliers on inventory_levels.
-- Stock changes happen via RPCs (rpc_cycle_count already supplier-aware
-- in migration 021).

-- -------------------------------------------------------------
-- K.11 inventory_transactions — suppliers see transactions at their locations
-- -------------------------------------------------------------
CREATE POLICY "supplier_select_own_inv_transactions" ON inventory_transactions
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM locations l
       WHERE l.id = inventory_transactions.location_id
         AND l.owner_supplier_id = ANY(jwt_supplier_scope())
    )
  );

-- Append-only by migration 009; no INSERT policy needed for suppliers
-- (their mutations come through SECURITY DEFINER RPCs).

-- -------------------------------------------------------------
-- K.12 shipment_variances — visible to implicated suppliers
-- -------------------------------------------------------------
CREATE POLICY "supplier_select_own_variances" ON shipment_variances
  FOR SELECT TO authenticated
  USING (origin_supplier_id = ANY(jwt_supplier_scope()));

-- Suppliers don't insert variances directly — rpc_apply_freight_delivery does.
-- Updates (acknowledgment) happen via rpc_supplier_acknowledge_variance in 021.

-- -------------------------------------------------------------
-- K.13 component_breakage_reports — visible to implicated suppliers
-- -------------------------------------------------------------
CREATE POLICY "supplier_select_own_breakage_reports" ON component_breakage_reports
  FOR SELECT TO authenticated
  USING (
    producing_supplier_id = ANY(jwt_supplier_scope())
    OR reporter_supplier_id = ANY(jwt_supplier_scope())
  );

-- Suppliers (consolidators) create breakage reports via RPC. The insert
-- policy below is the backstop in case the RPC isn't used.
CREATE POLICY "supplier_insert_breakage_reports_as_reporter" ON component_breakage_reports
  FOR INSERT TO authenticated
  WITH CHECK (
    reporter_supplier_id = jwt_supplier_id()
    AND created_by = auth.uid()
    AND status = 'open'
    -- Other constraints (producer != reporter, reporter consolidates producer)
    -- are enforced by the table's own triggers regardless of insert path.
  );

-- -------------------------------------------------------------
-- K.14 Global DENY for supplier UPDATE/DELETE on tables that lack policies
-- -------------------------------------------------------------
-- Postgres RLS is default-deny when RLS is enabled on a table. Every table
-- above has RLS enabled from prior migrations. The ABSENCE of an UPDATE or
-- DELETE policy for suppliers IS the deny. Documenting here so a future
-- maintainer reading this file understands why there are no "deny" policies.

-- =============================================================
-- End of Migration 020. Ready for 021 (RPCs).
-- =============================================================
