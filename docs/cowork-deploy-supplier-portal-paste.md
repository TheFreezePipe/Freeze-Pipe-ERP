# Cowork prompt — Deploy supplier portal migrations (paste this whole file)

Copy everything below the `---` into Cowork as one message.

---

# Task: deploy supplier portal migrations 020 + 021

You need to create three new files in the repo, then deploy them. The files don't exist yet — create them with the exact contents below, then run the deploy sequence.

## Files to create

### File 1 of 3: `supabase/migrations/20260101000020_supplier_portal_schema.sql`

Save the SQL in the fenced block below to this exact path. Preserve every character, including the `$$` markers. Use UTF-8 with LF line endings.

```sql
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

-- =============================================================
-- A. Supplier capability flags
-- =============================================================
ALTER TABLE suppliers
  ADD COLUMN is_producer BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN is_filler BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN is_export_broker BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN consolidates_for UUID[] NOT NULL DEFAULT '{}';

CREATE OR REPLACE FUNCTION validate_consolidates_for()
RETURNS TRIGGER AS $$
BEGIN
  IF array_length(NEW.consolidates_for, 1) > 0 THEN
    IF NEW.id = ANY(NEW.consolidates_for) THEN
      RAISE EXCEPTION 'supplier % cannot appear in its own consolidates_for array', NEW.id;
    END IF;
    IF EXISTS (
      SELECT 1 FROM unnest(NEW.consolidates_for) AS sid
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

COMMENT ON COLUMN suppliers.is_producer IS 'Can manufacture goods.';
COMMENT ON COLUMN suppliers.is_filler IS 'Can perform fillable-product assembly.';
COMMENT ON COLUMN suppliers.is_export_broker IS 'Can create freight shipments to us.';
COMMENT ON COLUMN suppliers.consolidates_for IS 'Supplier ids whose orders this supplier consolidates.';

-- =============================================================
-- B. Profile ↔ supplier link + 'supplier' role + is_active
-- =============================================================
ALTER TABLE profiles
  ADD COLUMN supplier_id UUID REFERENCES suppliers(id) ON DELETE RESTRICT,
  ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT true;

CREATE INDEX idx_profiles_supplier ON profiles(supplier_id)
  WHERE supplier_id IS NOT NULL;

ALTER TABLE profiles DROP CONSTRAINT profiles_role_check;
ALTER TABLE profiles
  ADD CONSTRAINT profiles_role_check
  CHECK (role IN ('admin', 'manager', 'user', 'supplier'));

ALTER TABLE profiles
  ADD CONSTRAINT chk_profile_supplier_role_consistency
  CHECK (
    (role = 'supplier' AND supplier_id IS NOT NULL)
    OR (role != 'supplier' AND supplier_id IS NULL)
  );

COMMENT ON COLUMN profiles.supplier_id IS 'FK to suppliers. NULL for internal users.';
COMMENT ON COLUMN profiles.is_active IS 'False = deactivated. Row retained for audit.';

-- =============================================================
-- C. Bill of Materials (BOM)
-- =============================================================
CREATE TABLE product_boms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_sku_id UUID NOT NULL REFERENCES product_skus(id) ON DELETE RESTRICT,
  component_sku_id UUID NOT NULL REFERENCES product_skus(id) ON DELETE RESTRICT,
  component_type TEXT NOT NULL CHECK (component_type IN ('produced', 'consumable_inventory')),
  units_per_parent INTEGER NOT NULL DEFAULT 1 CHECK (units_per_parent > 0),
  assembled_at_supplier_id UUID NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  component_location_id UUID REFERENCES locations(id) ON DELETE RESTRICT,
  effective_from DATE NOT NULL DEFAULT CURRENT_DATE,
  effective_until DATE,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_bom_location_required_for_consumable CHECK (
    component_type != 'consumable_inventory' OR component_location_id IS NOT NULL
  ),
  CONSTRAINT chk_bom_effective_order CHECK (
    effective_until IS NULL OR effective_until > effective_from
  ),
  CONSTRAINT chk_bom_no_self_reference CHECK (parent_sku_id != component_sku_id)
);

CREATE UNIQUE INDEX idx_product_boms_active_unique
  ON product_boms(parent_sku_id, component_sku_id)
  WHERE effective_until IS NULL;

CREATE INDEX idx_product_boms_parent ON product_boms(parent_sku_id)
  WHERE effective_until IS NULL;

CREATE INDEX idx_product_boms_component ON product_boms(component_sku_id)
  WHERE effective_until IS NULL;

ALTER TABLE product_boms ADD COLUMN row_version INTEGER NOT NULL DEFAULT 1;

CREATE TRIGGER trg_bump_version_product_boms
  BEFORE UPDATE ON product_boms
  FOR EACH ROW EXECUTE FUNCTION bump_row_version();

CREATE TRIGGER set_updated_at BEFORE UPDATE ON product_boms
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE OR REPLACE FUNCTION check_bom_no_cycle()
RETURNS TRIGGER AS $$
DECLARE
  v_visited UUID[] := ARRAY[NEW.parent_sku_id];
  v_current UUID := NEW.component_sku_id;
  v_depth INTEGER := 0;
BEGIN
  WHILE v_depth < 20 LOOP
    v_depth := v_depth + 1;
    IF v_current = NEW.parent_sku_id THEN
      RAISE EXCEPTION 'BOM insert/update would create a cycle at sku %', v_current;
    END IF;
    IF v_current = ANY(v_visited) THEN EXIT; END IF;
    v_visited := array_append(v_visited, v_current);
    SELECT component_sku_id INTO v_current
      FROM product_boms
     WHERE parent_sku_id = v_current AND effective_until IS NULL
     LIMIT 1;
    IF v_current IS NULL THEN EXIT; END IF;
  END LOOP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_check_bom_no_cycle
  BEFORE INSERT OR UPDATE ON product_boms
  FOR EACH ROW EXECUTE FUNCTION check_bom_no_cycle();

CREATE OR REPLACE VIEW product_boms_active AS
  SELECT * FROM product_boms WHERE effective_until IS NULL;

-- =============================================================
-- D. Location ownership
-- =============================================================
ALTER TABLE locations
  ADD COLUMN owner_supplier_id UUID REFERENCES suppliers(id) ON DELETE RESTRICT;

CREATE INDEX idx_locations_owner_supplier ON locations(owner_supplier_id)
  WHERE owner_supplier_id IS NOT NULL;

-- =============================================================
-- E. Factory orders — cancellation + broker routing + idempotency
-- =============================================================
ALTER TABLE factory_orders
  ADD COLUMN ship_via_supplier_id UUID REFERENCES suppliers(id) ON DELETE RESTRICT,
  ADD COLUMN canceled_at TIMESTAMPTZ,
  ADD COLUMN canceled_by UUID REFERENCES profiles(id) ON DELETE RESTRICT,
  ADD COLUMN canceled_reason TEXT,
  ADD COLUMN idempotency_key UUID;

CREATE UNIQUE INDEX idx_factory_orders_idempotency
  ON factory_orders(supplier_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

ALTER TABLE factory_orders DROP CONSTRAINT IF EXISTS factory_orders_status_check;
ALTER TABLE factory_orders
  ADD CONSTRAINT factory_orders_status_check
  CHECK (status IN ('ordered', 'in_production', 'finished', 'shipped', 'canceled'));

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

CREATE INDEX idx_factory_orders_active_by_supplier
  ON factory_orders(supplier_id, status, order_date)
  WHERE status != 'canceled';

-- =============================================================
-- F. Factory order items — consolidator confirm + breakage
-- =============================================================
ALTER TABLE factory_order_items
  ADD COLUMN consolidator_confirmed_quantity INTEGER,
  ADD COLUMN consolidator_confirmed_at TIMESTAMPTZ,
  ADD COLUMN consolidator_confirmed_by UUID REFERENCES profiles(id) ON DELETE RESTRICT,
  ADD COLUMN quantity_breakage INTEGER NOT NULL DEFAULT 0 CHECK (quantity_breakage >= 0);

ALTER TABLE factory_order_items
  ADD CONSTRAINT chk_factory_order_items_breakage_bounds
  CHECK (
    (consolidator_confirmed_quantity IS NULL AND quantity_breakage = 0)
    OR (consolidator_confirmed_quantity IS NOT NULL AND quantity_breakage <= consolidator_confirmed_quantity)
  );

ALTER TABLE factory_order_items
  ADD CONSTRAINT chk_factory_order_items_confirm_coherent
  CHECK (
    (consolidator_confirmed_quantity IS NULL AND consolidator_confirmed_at IS NULL AND consolidator_confirmed_by IS NULL)
    OR (consolidator_confirmed_quantity IS NOT NULL AND consolidator_confirmed_at IS NOT NULL AND consolidator_confirmed_by IS NOT NULL)
  );

-- =============================================================
-- G. Freight shipments
-- =============================================================
ALTER TABLE freight_shipments
  ADD COLUMN origin_supplier_id UUID REFERENCES suppliers(id) ON DELETE RESTRICT,
  ADD COLUMN created_by_supplier_user_id UUID REFERENCES profiles(id) ON DELETE RESTRICT,
  ADD COLUMN idempotency_key UUID;

CREATE UNIQUE INDEX idx_freight_shipments_idempotency
  ON freight_shipments(origin_supplier_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

ALTER TABLE freight_shipments
  ADD CONSTRAINT chk_freight_idempotency_scoped
  CHECK (idempotency_key IS NULL OR origin_supplier_id IS NOT NULL);

CREATE INDEX idx_freight_shipments_origin_supplier
  ON freight_shipments(origin_supplier_id, created_at DESC)
  WHERE origin_supplier_id IS NOT NULL;

-- =============================================================
-- H. Freight line items
-- =============================================================
ALTER TABLE freight_line_items
  ADD COLUMN supplier_declared_quantity INTEGER
    CHECK (supplier_declared_quantity IS NULL OR supplier_declared_quantity >= 0),
  ADD COLUMN source_factory_order_item_id UUID
    REFERENCES factory_order_items(id) ON DELETE RESTRICT;

CREATE INDEX idx_freight_line_items_source_foi
  ON freight_line_items(source_factory_order_item_id)
  WHERE source_factory_order_item_id IS NOT NULL;

-- =============================================================
-- I. shipment_variances
-- =============================================================
CREATE TABLE shipment_variances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  freight_line_item_id UUID NOT NULL REFERENCES freight_line_items(id) ON DELETE RESTRICT,
  shipment_id UUID NOT NULL REFERENCES freight_shipments(id) ON DELETE RESTRICT,
  sku_id UUID NOT NULL REFERENCES product_skus(id) ON DELETE RESTRICT,
  origin_supplier_id UUID NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  declared_quantity INTEGER NOT NULL CHECK (declared_quantity >= 0),
  received_quantity INTEGER NOT NULL CHECK (received_quantity >= 0),
  variance_quantity INTEGER GENERATED ALWAYS AS (received_quantity - declared_quantity) STORED,
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
  CONSTRAINT chk_variance_ack_coherent CHECK (
    (status = 'open' AND acknowledged_at IS NULL AND acknowledged_by IS NULL)
    OR (status != 'open' AND acknowledged_at IS NOT NULL AND acknowledged_by IS NOT NULL)
  ),
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

CREATE INDEX idx_shipment_variances_shipment ON shipment_variances(shipment_id);
CREATE INDEX idx_shipment_variances_sku ON shipment_variances(sku_id, created_at DESC);

CREATE OR REPLACE FUNCTION enforce_shipment_variance_append_only()
RETURNS TRIGGER AS $$
BEGIN
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
    RAISE EXCEPTION 'shipment_variances: immutable field modified.';
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
  RAISE EXCEPTION 'shipment_variances is append-only. DELETE not permitted.';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_shipment_variance_no_delete
  BEFORE DELETE ON shipment_variances
  FOR EACH ROW EXECUTE FUNCTION block_shipment_variance_delete();

-- =============================================================
-- I.2 component_breakage_reports
-- =============================================================
CREATE TABLE component_breakage_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  factory_order_item_id UUID NOT NULL REFERENCES factory_order_items(id) ON DELETE RESTRICT,
  producing_supplier_id UUID NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  reporter_supplier_id UUID NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  sku_id UUID NOT NULL REFERENCES product_skus(id) ON DELETE RESTRICT,
  quantity_broken INTEGER NOT NULL CHECK (quantity_broken > 0),
  reason_category TEXT NOT NULL
    CHECK (reason_category IN ('crushed_in_transit', 'manufacturing_defect', 'wet_damage', 'contamination', 'other')),
  description TEXT NOT NULL CHECK (length(trim(description)) > 0),
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
    RAISE EXCEPTION 'component_breakage_reports: immutable field modified.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_breakage_report_append_only
  BEFORE UPDATE ON component_breakage_reports
  FOR EACH ROW EXECUTE FUNCTION enforce_breakage_report_append_only();

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
      NEW.reporter_supplier_id, NEW.producing_supplier_id;
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
  RAISE EXCEPTION 'component_breakage_reports is append-only.';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_breakage_report_no_delete
  BEFORE DELETE ON component_breakage_reports
  FOR EACH ROW EXECUTE FUNCTION block_breakage_report_delete();

-- =============================================================
-- J. Supplier-facing views
-- =============================================================
CREATE OR REPLACE VIEW supplier_portal_skus WITH (security_invoker = true) AS
  SELECT id, sku, name, category, is_active, created_at FROM product_skus;

CREATE OR REPLACE VIEW supplier_portal_factory_orders WITH (security_invoker = true) AS
  SELECT id, supplier_id, ship_via_supplier_id, order_date, expected_ready_date,
         status, canceled_at, canceled_reason, notes, created_at, updated_at, row_version
  FROM factory_orders;

CREATE OR REPLACE VIEW supplier_portal_factory_order_items WITH (security_invoker = true) AS
  SELECT id, factory_order_id, sku_id, quantity, consolidator_confirmed_quantity,
         consolidator_confirmed_at, quantity_breakage, created_at, updated_at
  FROM factory_order_items;

CREATE OR REPLACE VIEW supplier_portal_freight_shipments WITH (security_invoker = true) AS
  SELECT id, origin_supplier_id, tracking_number, carrier, status, eta, eta_original,
         departed_at, delivered_at, total_cartons, created_by_supplier_user_id,
         idempotency_key, created_at, updated_at, row_version
  FROM freight_shipments;

CREATE OR REPLACE VIEW supplier_portal_freight_line_items WITH (security_invoker = true) AS
  SELECT id, shipment_id, sku_id, quantity, supplier_declared_quantity,
         source_factory_order_item_id, created_at, updated_at
  FROM freight_line_items;

CREATE OR REPLACE VIEW supplier_portal_variances WITH (security_invoker = true) AS
  SELECT id, freight_line_item_id, shipment_id, sku_id, origin_supplier_id,
         declared_quantity, received_quantity, variance_quantity, variance_type,
         status, notes, resolution_notes, acknowledged_at, resolved_at, created_at
  FROM shipment_variances;

CREATE OR REPLACE VIEW supplier_portal_breakage_reports WITH (security_invoker = true) AS
  SELECT id, factory_order_item_id, producing_supplier_id, reporter_supplier_id,
         sku_id, quantity_broken, reason_category, description, replacement_requested,
         replacement_factory_order_id, status, resolution_notes, acknowledged_at,
         resolved_at, created_at
  FROM component_breakage_reports;

-- =============================================================
-- K. RLS helpers + policies
-- =============================================================
CREATE OR REPLACE FUNCTION jwt_supplier_id()
RETURNS UUID LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT supplier_id FROM profiles
   WHERE id = auth.uid() AND is_active = true AND role = 'supplier'
$$;

CREATE OR REPLACE FUNCTION jwt_supplier_scope()
RETURNS UUID[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(ARRAY[s.id] || s.consolidates_for, ARRAY[]::UUID[])
    FROM profiles p JOIN suppliers s ON s.id = p.supplier_id
   WHERE p.id = auth.uid() AND p.is_active = true AND p.role = 'supplier'
$$;

CREATE OR REPLACE FUNCTION jwt_is_internal()
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM profiles
     WHERE id = auth.uid() AND is_active = true AND role IN ('admin', 'manager', 'user')
  )
$$;

CREATE POLICY "supplier_select_in_scope" ON suppliers
  FOR SELECT TO authenticated
  USING (id = ANY(jwt_supplier_scope()));

CREATE POLICY "supplier_select_own_profile" ON profiles
  FOR SELECT TO authenticated
  USING (id = auth.uid());

CREATE POLICY "supplier_select_related_skus" ON product_skus
  FOR SELECT TO authenticated
  USING (
    jwt_supplier_id() IS NOT NULL
    AND (
      EXISTS (
        SELECT 1 FROM factory_order_items foi
        JOIN factory_orders fo ON fo.id = foi.factory_order_id
        WHERE foi.sku_id = product_skus.id
          AND fo.supplier_id = ANY(jwt_supplier_scope())
      )
      OR EXISTS (
        SELECT 1 FROM product_boms b
        WHERE b.component_sku_id = product_skus.id
          AND b.assembled_at_supplier_id = ANY(jwt_supplier_scope())
          AND b.effective_until IS NULL
      )
      OR EXISTS (
        SELECT 1 FROM product_boms b
        WHERE b.parent_sku_id = product_skus.id
          AND b.assembled_at_supplier_id = ANY(jwt_supplier_scope())
          AND b.effective_until IS NULL
      )
    )
  );

ALTER TABLE product_boms ENABLE ROW LEVEL SECURITY;
CREATE POLICY "supplier_select_assembled_boms" ON product_boms
  FOR SELECT TO authenticated
  USING (assembled_at_supplier_id = ANY(jwt_supplier_scope()));

CREATE POLICY "supplier_select_own_locations" ON locations
  FOR SELECT TO authenticated
  USING (owner_supplier_id = ANY(jwt_supplier_scope()));

CREATE POLICY "supplier_select_in_scope_factory_orders" ON factory_orders
  FOR SELECT TO authenticated
  USING (
    supplier_id = ANY(jwt_supplier_scope())
    OR ship_via_supplier_id = ANY(jwt_supplier_scope())
  );

CREATE POLICY "supplier_insert_own_factory_orders" ON factory_orders
  FOR INSERT TO authenticated
  WITH CHECK (supplier_id = jwt_supplier_id() AND status = 'ordered');

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
         AND fo.status = 'ordered'
    )
    AND consolidator_confirmed_quantity IS NULL
    AND consolidator_confirmed_at IS NULL
    AND consolidator_confirmed_by IS NULL
    AND quantity_breakage = 0
  );

CREATE POLICY "supplier_select_own_shipments" ON freight_shipments
  FOR SELECT TO authenticated
  USING (origin_supplier_id = ANY(jwt_supplier_scope()));

CREATE POLICY "supplier_insert_own_shipments" ON freight_shipments
  FOR INSERT TO authenticated
  WITH CHECK (
    origin_supplier_id = jwt_supplier_id()
    AND created_by_supplier_user_id = auth.uid()
    AND status IN ('pending', 'booked')
  );

CREATE POLICY "supplier_select_own_freight_lines" ON freight_line_items
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM freight_shipments s
       WHERE s.id = freight_line_items.shipment_id
         AND s.origin_supplier_id = ANY(jwt_supplier_scope())
    )
  );

CREATE POLICY "supplier_insert_own_freight_lines" ON freight_line_items
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM freight_shipments s
       WHERE s.id = freight_line_items.shipment_id
         AND s.origin_supplier_id = jwt_supplier_id()
         AND s.status IN ('pending', 'booked')
    )
    AND supplier_declared_quantity IS NOT NULL
    AND quantity = supplier_declared_quantity
  );

CREATE POLICY "supplier_select_own_inventory" ON inventory_levels
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM locations l
       WHERE l.id = inventory_levels.location_id
         AND l.owner_supplier_id = ANY(jwt_supplier_scope())
    )
  );

CREATE POLICY "supplier_select_own_inv_transactions" ON inventory_transactions
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM locations l
       WHERE l.id = inventory_transactions.location_id
         AND l.owner_supplier_id = ANY(jwt_supplier_scope())
    )
  );

ALTER TABLE shipment_variances ENABLE ROW LEVEL SECURITY;
CREATE POLICY "supplier_select_own_variances" ON shipment_variances
  FOR SELECT TO authenticated
  USING (origin_supplier_id = ANY(jwt_supplier_scope()));

ALTER TABLE component_breakage_reports ENABLE ROW LEVEL SECURITY;
CREATE POLICY "supplier_select_own_breakage_reports" ON component_breakage_reports
  FOR SELECT TO authenticated
  USING (
    producing_supplier_id = ANY(jwt_supplier_scope())
    OR reporter_supplier_id = ANY(jwt_supplier_scope())
  );

CREATE POLICY "supplier_insert_breakage_reports_as_reporter" ON component_breakage_reports
  FOR INSERT TO authenticated
  WITH CHECK (
    reporter_supplier_id = jwt_supplier_id()
    AND created_by = auth.uid()
    AND status = 'open'
  );
```

### File 2 of 3: `supabase/migrations/20260101000021_supplier_portal_rpcs.sql`

Full SQL in the repo at my session (I'll paste it next). For now, request that contents separately from me (the user) if you need it — the file is long and the assistant will provide it in a follow-up message if the file above + the test file are handled cleanly first.

### File 3 of 3: `supabase/tests/supplier_portal_rls.test.sql`

pgTAP test file. Same — I'll paste its contents separately once files 1 and 2 are in place. It has the same paste pattern as File 1.

---

## After all three files are saved, run the deploy sequence

1. Preflight:
   ```
   supabase projects list
   supabase migration list
   ```
   Confirm migration 019 is the latest remote; 020 and 021 should be in Local only.

2. Take a Supabase dashboard backup (manual, UI).

3. Push:
   ```
   supabase db push
   ```

4. Test:
   ```
   supabase test db
   ```
   Expect 18 tests passing.

5. Regenerate types:
   ```
   supabase gen types typescript --linked > src/lib/database.types.ts
   ```

6. Sanity:
   ```sql
   SELECT jwt_supplier_id();
   SELECT jwt_supplier_scope();
   SELECT jwt_is_internal();
   ```
   All should return null/{}/false for a non-authenticated session.

## Report back

Paste back:
- Migration push output (verbatim)
- Test results (N / 18 passing, full output if any failures)
- Typecheck errors from `tsc -b --noEmit` (or equivalent) if any
- Output of the three jwt_* sanity queries
