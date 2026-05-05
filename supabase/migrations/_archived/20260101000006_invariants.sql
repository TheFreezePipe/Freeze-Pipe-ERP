-- =============================================================
-- Migration 006: Database-level invariants
-- =============================================================
-- Anything that must never be true in the application is enforced here
-- at the database level. These are the last line of defense — a buggy
-- client or a rogue SQL session cannot violate them.
--
-- Rule of thumb: if a number represents physical units of inventory, it
-- must not go negative. If two dates have a logical order, it must hold.
-- If a set of percentages must sum to 100, the DB must check it.

-- -------------------------------------------------------------
-- inventory_levels: every bucket is non-negative
-- -------------------------------------------------------------
ALTER TABLE inventory_levels
  ADD CONSTRAINT chk_inv_warehouse_raw_nonneg CHECK (warehouse_raw >= 0),
  ADD CONSTRAINT chk_inv_warehouse_wip_nonneg CHECK (warehouse_in_production >= 0),
  ADD CONSTRAINT chk_inv_warehouse_finished_nonneg CHECK (warehouse_finished >= 0),
  ADD CONSTRAINT chk_inv_warehouse_other_nonneg CHECK (warehouse_other >= 0),
  ADD CONSTRAINT chk_inv_transit_air_nonneg CHECK (in_transit_air >= 0),
  ADD CONSTRAINT chk_inv_transit_sea_nonneg CHECK (in_transit_sea >= 0),
  ADD CONSTRAINT chk_inv_transit_high_risk_nonneg CHECK (in_transit_high_risk >= 0),
  ADD CONSTRAINT chk_inv_nancy_finished_nonneg CHECK (nancy_finished >= 0),
  ADD CONSTRAINT chk_inv_nancy_ordered_nonneg CHECK (nancy_ordered >= 0),
  ADD CONSTRAINT chk_inv_yx_finished_nonneg CHECK (yx_finished >= 0),
  ADD CONSTRAINT chk_inv_yx_ordered_nonneg CHECK (yx_ordered >= 0);

-- -------------------------------------------------------------
-- task_logs: quantities must be positive, duration must be valid
-- -------------------------------------------------------------
ALTER TABLE task_logs
  ADD CONSTRAINT chk_task_qty_positive CHECK (quantity_processed > 0),
  ADD CONSTRAINT chk_task_time_order CHECK (
    time_started IS NULL
    OR time_completed IS NULL
    OR time_completed >= time_started
  );

-- -------------------------------------------------------------
-- freight_shipments: date ordering + non-negative costs
-- -------------------------------------------------------------
ALTER TABLE freight_shipments
  ADD CONSTRAINT chk_freight_eta_after_ship CHECK (
    ship_date IS NULL OR eta IS NULL OR eta >= ship_date
  ),
  ADD CONSTRAINT chk_freight_arrival_after_ship CHECK (
    ship_date IS NULL OR actual_arrival_date IS NULL OR actual_arrival_date >= ship_date
  ),
  ADD CONSTRAINT chk_freight_cost_nonneg CHECK (freight_cost >= 0),
  ADD CONSTRAINT chk_freight_insurance_nonneg CHECK (insurance_cost >= 0),
  ADD CONSTRAINT chk_freight_duties_nonneg CHECK (duties_cost >= 0),
  ADD CONSTRAINT chk_freight_total_nonneg CHECK (total_cost >= 0),
  ADD CONSTRAINT chk_freight_cartons_nonneg CHECK (total_cartons IS NULL OR total_cartons >= 0);

-- -------------------------------------------------------------
-- freight_line_items: quantity > 0
-- -------------------------------------------------------------
ALTER TABLE freight_line_items
  ADD CONSTRAINT chk_freight_li_qty_positive CHECK (quantity > 0),
  ADD CONSTRAINT chk_freight_li_cost_nonneg CHECK (unit_cost >= 0),
  ADD CONSTRAINT chk_freight_li_retail_nonneg CHECK (retail_value >= 0);

-- -------------------------------------------------------------
-- factory_order_items: ordered > 0, finished within [0, ordered]
-- -------------------------------------------------------------
ALTER TABLE factory_order_items
  ADD CONSTRAINT chk_fo_item_ordered_positive CHECK (quantity_ordered > 0),
  ADD CONSTRAINT chk_fo_item_finished_bounded CHECK (
    quantity_finished >= 0 AND quantity_finished <= quantity_ordered
  ),
  ADD CONSTRAINT chk_fo_item_cost_nonneg CHECK (unit_cost >= 0);

-- -------------------------------------------------------------
-- factory_orders: expected_completion should be on or after order_date
-- -------------------------------------------------------------
ALTER TABLE factory_orders
  ADD CONSTRAINT chk_fo_completion_after_order CHECK (
    order_date IS NULL OR expected_completion IS NULL
    OR expected_completion >= order_date
  );

-- -------------------------------------------------------------
-- product_skus: retail price non-negative; standard carton qty positive
-- -------------------------------------------------------------
ALTER TABLE product_skus
  ADD CONSTRAINT chk_sku_retail_nonneg CHECK (retail_price >= 0),
  ADD CONSTRAINT chk_sku_std_carton_positive CHECK (standard_quantity_per_carton > 0),
  ADD CONSTRAINT chk_sku_monthly_demand_nonneg CHECK (monthly_demand >= 0);

-- -------------------------------------------------------------
-- sku_economics: all dollar amounts non-negative, percentage groups sum to 100
-- -------------------------------------------------------------
ALTER TABLE sku_economics
  -- Raw sourcing split (YX + Nancy = 100%)
  ADD CONSTRAINT chk_econ_pct_sourcing CHECK (
    ROUND((pct_from_yx + pct_from_nancy)::numeric, 2) = 100
    OR (pct_from_yx = 0 AND pct_from_nancy = 0)  -- allow un-configured rows
  ),
  -- Freight mode split (sea + air = 100%)
  ADD CONSTRAINT chk_econ_pct_freight CHECK (
    ROUND((pct_sea + pct_air)::numeric, 2) = 100
    OR (pct_sea = 0 AND pct_air = 0)
  ),
  -- Manufacturing location split (US + CN = 100%)
  ADD CONSTRAINT chk_econ_pct_mfg CHECK (
    ROUND((pct_manufactured_us + pct_manufactured_cn)::numeric, 2) = 100
    OR (pct_manufactured_us = 0 AND pct_manufactured_cn = 0)
  ),
  -- Individual percentages in [0, 100]
  ADD CONSTRAINT chk_econ_pct_bounds CHECK (
    pct_from_yx BETWEEN 0 AND 100
    AND pct_from_nancy BETWEEN 0 AND 100
    AND pct_sea BETWEEN 0 AND 100
    AND pct_air BETWEEN 0 AND 100
    AND pct_manufactured_us BETWEEN 0 AND 100
    AND pct_manufactured_cn BETWEEN 0 AND 100
  ),
  -- All cost fields non-negative
  ADD CONSTRAINT chk_econ_costs_nonneg CHECK (
    nancy_raw_cost >= 0 AND yx_raw_cost >= 0 AND additional_raw_cost >= 0
    AND sea_freight_cost_per_unit >= 0 AND air_freight_cost_per_unit >= 0
    AND breakage_issue_cost >= 0
    AND labor_cost_us >= 0 AND glycerin_cost_us >= 0 AND manufacturing_cost_cn >= 0
    AND packing_material_cost >= 0 AND packing_labor_cost >= 0
    AND shipping_cost >= 0 AND credit_card_fees >= 0
  );

COMMENT ON CONSTRAINT chk_econ_pct_sourcing ON sku_economics IS
  'Raw sourcing percentages must sum to exactly 100, or both be zero (un-configured)';
