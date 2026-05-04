-- =============================================================
-- Migration 018: Money precision upgrade
-- =============================================================
-- The original schema used DECIMAL(10,2) for money columns. At $10M/year
-- revenue that's already tight — a single high-value shipment total
-- (~$5M) sits just below the DECIMAL(10,2) ceiling of $99,999,999.99.
-- More importantly:
--
--   * DECIMAL(10,2) stores only 2 decimal places. Per-unit costs are
--     routinely fractional (freight allocated across 10,000 units can
--     leave fractions-of-a-cent residue). Rounding these to 2 decimals
--     introduces real drift in landed-cost math over time.
--   * A 10,000-unit shipment × $0.01 rounding error = $100 of drift per
--     shipment. Across a year, that's thousands of dollars of phantom
--     cost allocation.
--
-- Policy going forward:
--
--   * Totals and invoiced amounts: DECIMAL(14,4) — up to ~$99.9B, 4
--     decimal places. Matches common accounting-software conventions.
--   * Per-unit costs that accumulate: DECIMAL(14,6) — 6 decimal places
--     supports sub-cent precision where it compounds over large quantities.
--   * Percentages: DECIMAL(6,3) — 3 decimal places is enough for any
--     realistic allocation (you don't need 0.0001% precision).
--
-- ALTER TABLE for numeric types is a lossless widening operation —
-- PostgreSQL handles it in place with minimal table rewrite.

-- -------------------------------------------------------------
-- A. product_skus
-- -------------------------------------------------------------
ALTER TABLE product_skus
  ALTER COLUMN retail_price TYPE DECIMAL(14,4);

-- -------------------------------------------------------------
-- B. freight_shipments — totals at DECIMAL(14,4)
-- -------------------------------------------------------------
ALTER TABLE freight_shipments
  ALTER COLUMN freight_cost    TYPE DECIMAL(14,4),
  ALTER COLUMN insurance_cost  TYPE DECIMAL(14,4),
  ALTER COLUMN duties_cost     TYPE DECIMAL(14,4),
  ALTER COLUMN total_cost      TYPE DECIMAL(14,4);

-- -------------------------------------------------------------
-- C. freight_line_items — per-unit cost at DECIMAL(14,6); retail at 4dp
-- -------------------------------------------------------------
ALTER TABLE freight_line_items
  ALTER COLUMN unit_cost    TYPE DECIMAL(14,6),
  ALTER COLUMN retail_value TYPE DECIMAL(14,4);

-- -------------------------------------------------------------
-- D. factory_order_items — per-unit cost at DECIMAL(14,6)
-- -------------------------------------------------------------
ALTER TABLE factory_order_items
  ALTER COLUMN unit_cost TYPE DECIMAL(14,6);

-- -------------------------------------------------------------
-- E. sku_economics — per-unit costs and totals
-- -------------------------------------------------------------
-- Per-unit costs use DECIMAL(14,6). Sourcing/freight/manufacturing percentages
-- stay at DECIMAL(5,2) because they're bounded [0,100] and 2dp is plenty
-- for allocation percentages.
ALTER TABLE sku_economics
  ALTER COLUMN nancy_raw_cost              TYPE DECIMAL(14,6),
  ALTER COLUMN yx_raw_cost                 TYPE DECIMAL(14,6),
  ALTER COLUMN additional_raw_cost         TYPE DECIMAL(14,6),
  ALTER COLUMN sea_freight_cost_per_unit   TYPE DECIMAL(14,6),
  ALTER COLUMN air_freight_cost_per_unit   TYPE DECIMAL(14,6),
  ALTER COLUMN breakage_issue_cost         TYPE DECIMAL(14,6),
  ALTER COLUMN labor_cost_us               TYPE DECIMAL(14,6),
  ALTER COLUMN glycerin_cost_us            TYPE DECIMAL(14,6),
  ALTER COLUMN manufacturing_cost_cn       TYPE DECIMAL(14,6),
  ALTER COLUMN packing_material_cost       TYPE DECIMAL(14,6),
  ALTER COLUMN packing_labor_cost          TYPE DECIMAL(14,6),
  ALTER COLUMN shipping_cost               TYPE DECIMAL(14,6),
  ALTER COLUMN credit_card_fees            TYPE DECIMAL(14,6);

-- -------------------------------------------------------------
-- F. ShipStation tables already use BIGINT cents. Keep as-is; document why.
-- -------------------------------------------------------------
COMMENT ON COLUMN shipstation_orders.order_total_cents IS
  'Stored as BIGINT cents (not DECIMAL) because ShipStation sends dollar floats and we want exact storage without float-to-decimal drift. Multiply by 0.01 for display.';

-- -------------------------------------------------------------
-- G. Add a computed-column consistency trigger on freight_shipments
-- -------------------------------------------------------------
-- total_cost should reconcile with freight_cost + insurance_cost + duties_cost
-- plus optionally line-item subtotals. We don't strictly enforce this yet
-- because operators may enter total_cost manually with rounding, but this
-- trigger raises a NOTICE (logged, not blocking) when it drifts significantly.
CREATE OR REPLACE FUNCTION warn_freight_total_drift()
RETURNS TRIGGER AS $$
DECLARE
  v_sum DECIMAL(14,4);
  v_drift DECIMAL(14,4);
BEGIN
  v_sum := COALESCE(NEW.freight_cost, 0)
         + COALESCE(NEW.insurance_cost, 0)
         + COALESCE(NEW.duties_cost, 0);
  -- If total_cost is set but differs by more than $1 from the sum, warn.
  IF NEW.total_cost > 0 THEN
    v_drift := ABS(NEW.total_cost - v_sum);
    IF v_drift > 1.0 THEN
      RAISE NOTICE 'Freight shipment % total_cost (%) drifts from component sum (%) by %',
        NEW.shipment_number, NEW.total_cost, v_sum, v_drift;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_warn_freight_total_drift
  BEFORE INSERT OR UPDATE ON freight_shipments
  FOR EACH ROW EXECUTE FUNCTION warn_freight_total_drift();

COMMENT ON TRIGGER trg_warn_freight_total_drift ON freight_shipments IS
  'Logs a NOTICE when total_cost drifts >$1 from the sum of components. Non-blocking; catch up via observability.';
