-- =============================================================
-- Migration 045: bootstrap sku_economics + sku_supplier_costs from CSV
-- =============================================================
-- One-time data import: 54 SKUs of cost data from the operations team's
-- spreadsheet. Three side effects per imported SKU (when the SKU exists
-- in product_skus -- non-matches fall out via the inner join):
--
--   1. UPSERT into sku_economics with all the per-bucket inputs (raw
--      pct + amounts, importing pct + amounts, manufacturing pct +
--      amounts, pack/ship). Idempotent on sku_id.
--
--   2. Demote any existing is_primary supplier-cost rows for the
--      touched SKUs, then UPSERT one row per supplier (NANCY, YX) with
--      the supplier's raw+additional cost as `unit_cost`. is_primary
--      is set based on whichever supplier carries the higher % share
--      (Nancy wins 50/50 ties -- though the only true split SKU, NB1,
--      was flipped to 100% YX before this import). Suppliers with no
--      actual cost data are skipped (no zero-row noise).
--
--   3. UPDATE product_skus.category to 'non_fillable' for SKUs whose
--      CSV row had blank labor + glycerin + CN-mfg fields (15 SKUs:
--      bowls, bangers, accessories that ship as-is). Guarded with
--      `WHERE category != 'non_fillable'` so re-runs are no-ops.
--
-- Idempotent -- re-running against the same data produces no changes.
-- =============================================================

-- -------------------------------------------------------------
-- 1. UPSERT sku_economics
-- -------------------------------------------------------------
WITH csv_data(
  sku_code,
  pct_nancy, pct_yx,
  nancy_raw_cost, yx_raw_cost, additional_raw_cost,
  pct_sea, pct_air, sea_freight_cost_per_unit, air_freight_cost_per_unit,
  breakage_issue_cost,
  pct_manufactured_us, pct_manufactured_cn,
  labor_cost_us, glycerin_cost_us, manufacturing_cost_cn,
  packing_material_cost, packing_labor_cost, shipping_cost
) AS (VALUES
  ('BW20', 100.0000, 0.0000, 9.3500, 7.3000, 0.0000, 100.0000, 0.0000, 5.0000, 12.0000, 0.4700, 100.0000, 0.0000, 3.0000, 0.2500, 1.6000, 1.0100, 2.0000, 7.4500),
  ('BW20P', 0.0000, 100.0000, 17.0200, 10.2000, 3.2800, 100.0000, 0.0000, 5.0000, 12.0000, 0.6700, 100.0000, 0.0000, 3.0000, 0.2500, 1.6000, 1.0100, 2.0000, 7.4500),
  ('BW20DNA', 100.0000, 0.0000, 18.8100, 0.0000, 0.0000, 100.0000, 0.0000, 6.0000, 14.4000, 0.9400, 100.0000, 0.0000, 3.0000, 0.3500, 1.6000, 1.0100, 2.0000, 7.7500),
  ('BW20DNA-Iridescent', 100.0000, 0.0000, 21.2500, 0.0000, 0.0000, 100.0000, 0.0000, 6.0000, 14.4000, 1.0600, 100.0000, 0.0000, 3.0000, 0.3500, 1.6000, 1.0100, 2.0000, 7.7500),
  ('BW30P', 0.0000, 100.0000, 21.0000, 13.2000, 2.3500, 100.0000, 0.0000, 7.0000, 16.8000, 0.7800, 100.0000, 0.0000, 3.0000, 0.5000, 1.6000, 2.0000, 2.0000, 8.8500),
  ('BW64', 100.0000, 0.0000, 10.1500, 0.0000, 0.0000, 100.0000, 0.0000, 4.0000, 9.6000, 0.5100, 100.0000, 0.0000, 3.0000, 0.1000, 1.6000, 1.0000, 2.0000, 8.0000),
  ('BW21', 100.0000, 0.0000, 16.5000, 0.0000, 0.0000, 100.0000, 0.0000, 10.0000, 24.0000, 0.8300, 100.0000, 0.0000, 3.0000, 0.2500, 0.0000, 2.0000, 3.0000, 8.2500),
  ('BW21P', 0.0000, 100.0000, 22.8000, 14.0000, 2.3500, 100.0000, 0.0000, 10.0000, 24.0000, 0.8200, 100.0000, 0.0000, 3.0000, 0.2500, 0.0000, 2.0000, 3.0000, 8.2500),
  ('BW21U', 100.0000, 0.0000, 22.8000, 0.0000, 0.0000, 100.0000, 0.0000, 10.0000, 24.0000, 1.1400, 100.0000, 0.0000, 3.0000, 0.2500, 0.0000, 2.0000, 3.0000, 9.6000),
  ('BW40', 100.0000, 0.0000, 8.6000, 5.3000, 0.0000, 100.0000, 0.0000, 1.4000, 3.3600, 0.4300, 100.0000, 0.0000, 2.0000, 0.1500, 1.4000, 1.0000, 2.0000, 5.6000),
  ('BW40XL', 100.0000, 0.0000, 9.5000, 0.0000, 0.0000, 100.0000, 0.0000, 3.0000, 7.2000, 0.4800, 100.0000, 0.0000, 2.0000, 0.1500, 1.6000, 1.5000, 3.0000, 5.6000),
  ('BW40SP', 100.0000, 0.0000, 9.5500, 0.0000, 0.0000, 100.0000, 0.0000, 3.0000, 7.2000, 0.4800, 100.0000, 0.0000, 2.0000, 0.1500, 1.6000, 1.5000, 3.0000, 6.0000),
  ('BW60', 100.0000, 0.0000, 13.8200, 0.0000, 0.0000, 100.0000, 0.0000, 4.0000, 9.6000, 0.6900, 100.0000, 0.0000, 2.0000, 0.2500, 1.6000, 2.0000, 3.0000, 8.0000),
  ('BW60U', 0.0000, 100.0000, 0.0000, 12.5000, 2.3500, 100.0000, 0.0000, 6.0000, 14.4000, 0.7400, 100.0000, 0.0000, 3.0000, 0.3500, 1.6000, 2.0000, 3.0000, 8.9500),
  ('NB1', 0.0000, 100.0000, 28.3000, 23.0000, 2.3500, 100.0000, 0.0000, 15.0000, 36.0000, 1.3400, 100.0000, 0.0000, 3.0000, 0.5000, 0.0000, 2.0000, 3.0000, 10.7900),
  ('NB2', 0.0000, 100.0000, 46.0000, 25.8000, 2.3500, 100.0000, 0.0000, 15.0000, 36.0000, 1.4100, 100.0000, 0.0000, 3.0000, 0.5000, 0.0000, 2.0000, 3.0000, 11.1500),
  ('BW22', 100.0000, 0.0000, 18.0000, 16.2000, 0.0000, 100.0000, 0.0000, 12.0000, 22.0000, 0.9000, 100.0000, 0.0000, 3.0000, 0.5000, 0.0000, 2.0000, 3.0000, 10.5000),
  ('BW22U', 0.0000, 100.0000, 46.0000, 22.5000, 2.3500, 100.0000, 0.0000, 15.0000, 36.0000, 1.2400, 100.0000, 0.0000, 5.0000, 0.5000, 0.0000, 2.0000, 3.0000, 10.7900),
  ('BW25', 100.0000, 0.0000, 26.5000, 0.0000, 10.3500, 100.0000, 0.0000, 15.0000, 36.0000, 1.8400, 100.0000, 0.0000, 3.0000, 0.2500, 0.0000, 2.0000, 3.0000, 10.7900),
  ('BW58N', 100.0000, 0.0000, 29.5500, 0.0000, 9.3500, 100.0000, 0.0000, 15.0000, 36.0000, 1.9500, 100.0000, 0.0000, 3.0000, 0.5000, 0.0000, 2.0000, 3.0000, 13.9200),
  ('NB1M', 0.0000, 100.0000, 32.0000, 17.9000, 2.3500, 100.0000, 0.0000, 12.0000, 28.8000, 1.0100, 100.0000, 0.0000, 3.0000, 0.2500, 1.6000, 2.0000, 3.0000, 10.4600),
  ('NB2M', 0.0000, 100.0000, 0.0000, 19.0000, 2.3500, 100.0000, 0.0000, 12.0000, 28.8000, 1.0700, 100.0000, 0.0000, 3.0000, 0.2500, 0.0000, 2.0000, 3.0000, 10.4600),
  ('BW51D', 0.0000, 100.0000, 49.8500, 15.7000, 2.3500, 100.0000, 0.0000, 12.0000, 28.8000, 0.9000, 100.0000, 0.0000, 3.0000, 0.2500, 0.0000, 2.0000, 3.0000, 10.7900),
  ('BW56', 100.0000, 0.0000, 43.5000, 0.0000, 0.0000, 100.0000, 0.0000, 15.0000, 36.0000, 2.1800, 100.0000, 0.0000, 3.0000, 0.2500, 0.0000, 2.0000, 3.0000, 10.7900),
  ('BW59', 100.0000, 0.0000, 38.8000, 0.0000, 0.0000, 100.0000, 0.0000, 15.0000, 36.0000, 1.9400, 100.0000, 0.0000, 3.0000, 0.5000, 0.0000, 2.0000, 3.0000, 10.7900),
  ('BW62', 100.0000, 0.0000, 49.6000, 0.0000, 0.0000, 100.0000, 0.0000, 20.0000, 48.0000, 2.4800, 100.0000, 0.0000, 6.0000, 0.7500, 0.0000, 2.0000, 3.0000, 13.9200),
  ('BW63', 100.0000, 0.0000, 38.0000, 0.0000, 5.9000, 100.0000, 0.0000, 24.2500, 58.2000, 2.2000, 100.0000, 0.0000, 3.0000, 0.7500, 0.0000, 2.0000, 3.0000, 13.9200),
  ('BW68', 0.0000, 100.0000, 0.0000, 27.2000, 2.3500, 100.0000, 0.0000, 15.0000, 36.0000, 1.4800, 100.0000, 0.0000, 3.0000, 0.7500, 0.0000, 2.0000, 3.0000, 10.7900),
  ('NB4', 0.0000, 100.0000, 0.0000, 23.3000, 2.3500, 100.0000, 0.0000, 15.0000, 36.0000, 1.2800, 100.0000, 0.0000, 3.0000, 0.2500, 0.0000, 2.0000, 3.0000, 10.7900),
  ('NB5', 0.0000, 100.0000, 0.0000, 25.5000, 2.3500, 100.0000, 0.0000, 15.0000, 36.0000, 1.3900, 100.0000, 0.0000, 3.0000, 0.2500, 0.0000, 2.0000, 3.0000, 10.7900),
  ('NB6', 0.0000, 100.0000, 0.0000, 31.2000, 2.3500, 100.0000, 0.0000, 15.0000, 36.0000, 1.6800, 100.0000, 0.0000, 3.0000, 0.2500, 0.0000, 2.0000, 3.0000, 10.7900),
  ('BW38', 0.0000, 100.0000, 32.0000, 17.9000, 2.3500, 100.0000, 0.0000, 12.0000, 28.8000, 1.0100, 100.0000, 0.0000, 3.0000, 0.2500, 1.6000, 2.0000, 3.0000, 10.4600),
  ('BW55', 0.0000, 100.0000, 31.5000, 22.3000, 2.3500, 100.0000, 0.0000, 12.0000, 28.8000, 1.2300, 100.0000, 0.0000, 3.0000, 0.2500, 0.0000, 2.0000, 3.0000, 10.4600),
  ('BW34', 0.0000, 100.0000, 51.5000, 23.4000, 2.3500, 100.0000, 0.0000, 12.0000, 28.8000, 1.2900, 100.0000, 0.0000, 3.0000, 0.5000, 1.6000, 2.0000, 3.0000, 10.9300),
  ('E-Rig-Attachment', 0.0000, 100.0000, 0.0000, 27.3000, 2.3500, 100.0000, 0.0000, 9.0000, 21.6000, 1.4800, 100.0000, 0.0000, 3.0000, 0.2500, 1.6000, 2.0000, 3.0000, 9.7500),
  ('Mini-Enail', 100.0000, 0.0000, 34.5000, 0.0000, 0.0000, 100.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 2.0000, 3.0000, 4.6100),
  ('Vape', 100.0000, 0.0000, 11.6800, 0.0000, 0.0000, 100.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 2.0000, 3.0000, 4.6100),
  ('BW33-14', 100.0000, 0.0000, 12.5000, 7.5000, 0.0000, 100.0000, 0.0000, 5.0000, 12.0000, 0.6300, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 2.0000, 3.0000, 7.7500),
  ('BW33-19', 100.0000, 0.0000, 12.5000, 7.5000, 0.0000, 100.0000, 0.0000, 5.0000, 12.0000, 0.6300, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 2.0000, 3.0000, 7.7500),
  ('BW33-14-45', 100.0000, 0.0000, 12.5000, 0.0000, 0.0000, 100.0000, 0.0000, 5.0000, 12.0000, 0.6300, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 2.0000, 3.0000, 7.7500),
  ('BW33-19-45', 100.0000, 0.0000, 12.5000, 0.0000, 0.0000, 100.0000, 0.0000, 5.0000, 12.0000, 0.6300, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 2.0000, 3.0000, 7.7500),
  ('BW33-14 Pro', 0.0000, 100.0000, 22.8000, 9.4000, 2.3500, 100.0000, 0.0000, 7.0000, 16.8000, 0.5900, 100.0000, 0.0000, 3.0000, 0.1500, 0.0000, 2.0000, 3.0000, 8.3000),
  ('BW33-19 Pro', 0.0000, 100.0000, 22.8000, 9.4000, 2.3500, 100.0000, 0.0000, 7.0000, 16.8000, 0.5900, 100.0000, 0.0000, 3.0000, 0.1500, 0.0000, 2.0000, 3.0000, 8.3000),
  ('FP-Bowl', 100.0000, 0.0000, 0.7300, 0.0000, 0.0000, 100.0000, 0.0000, 0.3000, 0.7200, 0.0400, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 1.0000, 2.0000, 4.0000),
  ('14-HC-Bowl', 0.0000, 100.0000, 3.0000, 1.4000, 0.0000, 100.0000, 0.0000, 0.5000, 1.2000, 0.0700, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 1.0000, 2.0000, 4.0000),
  ('18-HC-Bowl', 0.0000, 100.0000, 3.0000, 1.4000, 0.0000, 100.0000, 0.0000, 0.5000, 1.2000, 0.0700, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 1.0000, 2.0000, 4.0000),
  ('Hybrid-Bowl', 100.0000, 0.0000, 3.2000, 0.0000, 0.0000, 100.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000),
  ('14-3X-Bowl', 100.0000, 0.0000, 3.5000, 0.0000, 0.0000, 100.0000, 0.0000, 0.5000, 1.2000, 0.1800, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 1.0000, 2.0000, 4.0000),
  ('18-3X-Bowl', 100.0000, 0.0000, 3.5000, 0.0000, 0.0000, 100.0000, 0.0000, 0.5000, 1.2000, 0.1800, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 1.0000, 2.0000, 4.0000),
  ('14-G-Bowl', 100.0000, 0.0000, 4.7500, 0.0000, 0.0000, 100.0000, 0.0000, 1.0000, 2.4000, 0.2400, 100.0000, 0.0000, 3.0000, 0.1500, 0.0000, 1.0000, 2.0000, 4.0000),
  ('18-G-Bowl', 100.0000, 0.0000, 4.7500, 0.0000, 0.0000, 100.0000, 0.0000, 1.0000, 2.4000, 0.2400, 100.0000, 0.0000, 3.0000, 0.1500, 0.0000, 1.0000, 2.0000, 4.0000),
  ('14-Banger', 0.0000, 100.0000, 0.0000, 2.5000, 0.0000, 100.0000, 0.0000, 1.0000, 2.4000, 0.1300, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 1.0000, 2.0000, 4.0000),
  ('18-Banger', 100.0000, 0.0000, 0.0000, 0.0000, 0.0000, 100.0000, 0.0000, 0.5000, 1.2000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 1.0000, 2.0000, 4.0000),
  ('J-Bowl', 100.0000, 0.0000, 2.1500, 0.0000, 0.0000, 0.0000, 100.0000, 0.5000, 1.0000, 0.1100, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 1.0000, 2.0000, 4.0000)
),
matched AS (
  SELECT p.id AS sku_id, c.*
  FROM csv_data c
  JOIN product_skus p ON p.sku = c.sku_code
)
INSERT INTO sku_economics (
  sku_id,
  pct_from_nancy, pct_from_yx,
  nancy_raw_cost, yx_raw_cost, additional_raw_cost,
  pct_sea, pct_air, sea_freight_cost_per_unit, air_freight_cost_per_unit,
  breakage_issue_cost,
  pct_manufactured_us, pct_manufactured_cn,
  labor_cost_us, glycerin_cost_us, manufacturing_cost_cn,
  packing_material_cost, packing_labor_cost, shipping_cost
)
SELECT
  sku_id,
  pct_nancy, pct_yx,
  nancy_raw_cost, yx_raw_cost, additional_raw_cost,
  pct_sea, pct_air, sea_freight_cost_per_unit, air_freight_cost_per_unit,
  breakage_issue_cost,
  pct_manufactured_us, pct_manufactured_cn,
  labor_cost_us, glycerin_cost_us, manufacturing_cost_cn,
  packing_material_cost, packing_labor_cost, shipping_cost
FROM matched
ON CONFLICT (sku_id) DO UPDATE SET
  pct_from_nancy = EXCLUDED.pct_from_nancy,
  pct_from_yx = EXCLUDED.pct_from_yx,
  nancy_raw_cost = EXCLUDED.nancy_raw_cost,
  yx_raw_cost = EXCLUDED.yx_raw_cost,
  additional_raw_cost = EXCLUDED.additional_raw_cost,
  pct_sea = EXCLUDED.pct_sea,
  pct_air = EXCLUDED.pct_air,
  sea_freight_cost_per_unit = EXCLUDED.sea_freight_cost_per_unit,
  air_freight_cost_per_unit = EXCLUDED.air_freight_cost_per_unit,
  breakage_issue_cost = EXCLUDED.breakage_issue_cost,
  pct_manufactured_us = EXCLUDED.pct_manufactured_us,
  pct_manufactured_cn = EXCLUDED.pct_manufactured_cn,
  labor_cost_us = EXCLUDED.labor_cost_us,
  glycerin_cost_us = EXCLUDED.glycerin_cost_us,
  manufacturing_cost_cn = EXCLUDED.manufacturing_cost_cn,
  packing_material_cost = EXCLUDED.packing_material_cost,
  packing_labor_cost = EXCLUDED.packing_labor_cost,
  shipping_cost = EXCLUDED.shipping_cost,
  updated_at = now();

-- -------------------------------------------------------------
-- 2a. Demote existing primary supplier-cost rows for the imported
--     SKUs. The partial unique index on (sku_id) WHERE is_primary
--     means we have to demote BEFORE re-promoting another supplier.
-- -------------------------------------------------------------
WITH csv_skus(sku_code) AS (VALUES
  
  ('BW20'),  
  ('BW20P'),  
  ('BW20DNA'),  
  ('BW20DNA-Iridescent'),  
  ('BW30P'),  
  ('BW64'),  
  ('BW21'),  
  ('BW21P'),  
  ('BW21U'),  
  ('BW40'),  
  ('BW40XL'),  
  ('BW40SP'),  
  ('BW60'),  
  ('BW60U'),  
  ('NB1'),  
  ('NB2'),  
  ('BW22'),  
  ('BW22U'),  
  ('BW25'),  
  ('BW58N'),  
  ('NB1M'),  
  ('NB2M'),  
  ('BW51D'),  
  ('BW56'),  
  ('BW59'),  
  ('BW62'),  
  ('BW63'),  
  ('BW68'),  
  ('NB4'),  
  ('NB5'),  
  ('NB6'),  
  ('BW38'),  
  ('BW55'),  
  ('BW34'),  
  ('E-Rig-Attachment'),  
  ('Mini-Enail'),  
  ('Vape'),  
  ('BW33-14'),  
  ('BW33-19'),  
  ('BW33-14-45'),  
  ('BW33-19-45'),  
  ('BW33-14 Pro'),  
  ('BW33-19 Pro'),  
  ('FP-Bowl'),  
  ('14-HC-Bowl'),  
  ('18-HC-Bowl'),  
  ('Hybrid-Bowl'),  
  ('14-3X-Bowl'),  
  ('18-3X-Bowl'),  
  ('14-G-Bowl'),  
  ('18-G-Bowl'),  
  ('14-Banger'),  
  ('18-Banger'),  
  ('J-Bowl')
)
UPDATE sku_supplier_costs sc
   SET is_primary = false,
       updated_at = now()
  FROM csv_skus c
  JOIN product_skus p ON p.sku = c.sku_code
 WHERE sc.sku_id = p.id
   AND sc.is_primary = true;

-- -------------------------------------------------------------
-- 2b. UPSERT sku_supplier_costs -- one row per (sku, supplier) where
--     unit cost > 0. NULL unit means "this supplier carries no data
--     for this SKU"; it gets filtered out before INSERT.
-- -------------------------------------------------------------
WITH csv_data(
  sku_code, pct_nancy, pct_yx, nancy_unit, yx_unit
) AS (VALUES
  ('BW20', 100.0000, 0.0000, 9.3500, 9.6500),
  ('BW20P', 0.0000, 100.0000, 17.0200, 13.4800),
  ('BW20DNA', 100.0000, 0.0000, 18.8100, NULL::NUMERIC),
  ('BW20DNA-Iridescent', 100.0000, 0.0000, 21.2500, NULL::NUMERIC),
  ('BW30P', 0.0000, 100.0000, 21.0000, 15.5500),
  ('BW64', 100.0000, 0.0000, 10.1500, NULL::NUMERIC),
  ('BW21', 100.0000, 0.0000, 16.5000, NULL::NUMERIC),
  ('BW21P', 0.0000, 100.0000, 22.8000, 16.3500),
  ('BW21U', 100.0000, 0.0000, 22.8000, NULL::NUMERIC),
  ('BW40', 100.0000, 0.0000, 8.6000, 7.6500),
  ('BW40XL', 100.0000, 0.0000, 9.5000, NULL::NUMERIC),
  ('BW40SP', 100.0000, 0.0000, 9.5500, NULL::NUMERIC),
  ('BW60', 100.0000, 0.0000, 13.8200, NULL::NUMERIC),
  ('BW60U', 0.0000, 100.0000, NULL::NUMERIC, 14.8500),
  ('NB1', 0.0000, 100.0000, 28.3000, 25.3500),
  ('NB2', 0.0000, 100.0000, 46.0000, 28.1500),
  ('BW22', 100.0000, 0.0000, 18.0000, 18.5500),
  ('BW22U', 0.0000, 100.0000, 46.0000, 24.8500),
  ('BW25', 100.0000, 0.0000, 36.8500, NULL::NUMERIC),
  ('BW58N', 100.0000, 0.0000, 38.9000, NULL::NUMERIC),
  ('NB1M', 0.0000, 100.0000, 32.0000, 20.2500),
  ('NB2M', 0.0000, 100.0000, NULL::NUMERIC, 21.3500),
  ('BW51D', 0.0000, 100.0000, 49.8500, 18.0500),
  ('BW56', 100.0000, 0.0000, 43.5000, NULL::NUMERIC),
  ('BW59', 100.0000, 0.0000, 38.8000, NULL::NUMERIC),
  ('BW62', 100.0000, 0.0000, 49.6000, NULL::NUMERIC),
  ('BW63', 100.0000, 0.0000, 43.9000, NULL::NUMERIC),
  ('BW68', 0.0000, 100.0000, NULL::NUMERIC, 29.5500),
  ('NB4', 0.0000, 100.0000, NULL::NUMERIC, 25.6500),
  ('NB5', 0.0000, 100.0000, NULL::NUMERIC, 27.8500),
  ('NB6', 0.0000, 100.0000, NULL::NUMERIC, 33.5500),
  ('BW38', 0.0000, 100.0000, 32.0000, 20.2500),
  ('BW55', 0.0000, 100.0000, 34.0500, 24.6500),
  ('BW34', 0.0000, 100.0000, 51.5000, 25.7500),
  ('E-Rig-Attachment', 0.0000, 100.0000, NULL::NUMERIC, 29.6500),
  ('Mini-Enail', 100.0000, 0.0000, 34.5000, NULL::NUMERIC),
  ('Vape', 100.0000, 0.0000, 11.6800, NULL::NUMERIC),
  ('BW33-14', 100.0000, 0.0000, 12.5000, 7.5000),
  ('BW33-19', 100.0000, 0.0000, 12.5000, 7.5000),
  ('BW33-14-45', 100.0000, 0.0000, 12.5000, NULL::NUMERIC),
  ('BW33-19-45', 100.0000, 0.0000, 12.5000, NULL::NUMERIC),
  ('BW33-14 Pro', 0.0000, 100.0000, 22.8000, 11.7500),
  ('BW33-19 Pro', 0.0000, 100.0000, 22.8000, 11.7500),
  ('FP-Bowl', 100.0000, 0.0000, 0.7300, NULL::NUMERIC),
  ('14-HC-Bowl', 0.0000, 100.0000, 3.0000, 1.4000),
  ('18-HC-Bowl', 0.0000, 100.0000, 3.0000, 1.4000),
  ('Hybrid-Bowl', 100.0000, 0.0000, 3.2000, NULL::NUMERIC),
  ('14-3X-Bowl', 100.0000, 0.0000, 3.5000, NULL::NUMERIC),
  ('18-3X-Bowl', 100.0000, 0.0000, 3.5000, NULL::NUMERIC),
  ('14-G-Bowl', 100.0000, 0.0000, 4.7500, NULL::NUMERIC),
  ('18-G-Bowl', 100.0000, 0.0000, 4.7500, NULL::NUMERIC),
  ('14-Banger', 0.0000, 100.0000, NULL::NUMERIC, 2.5000),
  ('18-Banger', 100.0000, 0.0000, NULL::NUMERIC, NULL::NUMERIC),
  ('J-Bowl', 100.0000, 0.0000, 2.1500, NULL::NUMERIC)
),
matched AS (
  SELECT p.id AS sku_id, c.*
  FROM csv_data c
  JOIN product_skus p ON p.sku = c.sku_code
),
nancy AS (SELECT id FROM suppliers WHERE code = 'NANCY'),
yx     AS (SELECT id FROM suppliers WHERE code = 'YX'),
rows_to_insert AS (
  SELECT
    m.sku_id,
    n.id AS supplier_id,
    m.nancy_unit AS unit_cost,
    (m.pct_nancy >= m.pct_yx) AS is_primary
  FROM matched m, nancy n
  WHERE m.nancy_unit IS NOT NULL
  UNION ALL
  SELECT
    m.sku_id,
    y.id,
    m.yx_unit,
    (m.pct_yx > m.pct_nancy)
  FROM matched m, yx y
  WHERE m.yx_unit IS NOT NULL
)
INSERT INTO sku_supplier_costs (sku_id, supplier_id, unit_cost, is_primary)
SELECT sku_id, supplier_id, unit_cost, is_primary FROM rows_to_insert
ON CONFLICT (sku_id, supplier_id) DO UPDATE SET
  unit_cost = EXCLUDED.unit_cost,
  is_primary = EXCLUDED.is_primary,
  updated_at = now();

-- -------------------------------------------------------------
-- 3. Flip product_skus.category to 'non_fillable' for SKUs whose
--    CSV row had blank labor + glycerin + CN-mfg fields. Guarded
--    so re-runs don't bump updated_at unnecessarily.
-- -------------------------------------------------------------
UPDATE product_skus
   SET category = 'non_fillable',
       updated_at = now()
 WHERE sku IN (
    'Mini-Enail',
    'Vape',
    'BW33-14',
    'BW33-19',
    'BW33-14-45',
    'BW33-19-45',
    'FP-Bowl',
    '14-HC-Bowl',
    '18-HC-Bowl',
    'Hybrid-Bowl',
    '14-3X-Bowl',
    '18-3X-Bowl',
    '14-Banger',
    '18-Banger',
    'J-Bowl'
  )
   AND category != 'non_fillable';

-- -------------------------------------------------------------
-- Sanity report. Surfaces row counts via NOTICE so the deployer can
-- confirm at apply-time. Doesn't fail the migration on any specific
-- number -- we expect skips for SKUs that don't exist in product_skus.
-- -------------------------------------------------------------
DO $$
DECLARE
  v_csv_count INTEGER := 54;
  v_econ_rows INTEGER;
  v_supplier_rows INTEGER;
  v_nonfill_count INTEGER;
BEGIN
  SELECT count(*) INTO v_econ_rows
    FROM sku_economics se
    JOIN product_skus p ON p.id = se.sku_id
   WHERE p.sku IN (
  'BW20',
  'BW20P',
  'BW20DNA',
  'BW20DNA-Iridescent',
  'BW30P',
  'BW64',
  'BW21',
  'BW21P',
  'BW21U',
  'BW40',
  'BW40XL',
  'BW40SP',
  'BW60',
  'BW60U',
  'NB1',
  'NB2',
  'BW22',
  'BW22U',
  'BW25',
  'BW58N',
  'NB1M',
  'NB2M',
  'BW51D',
  'BW56',
  'BW59',
  'BW62',
  'BW63',
  'BW68',
  'NB4',
  'NB5',
  'NB6',
  'BW38',
  'BW55',
  'BW34',
  'E-Rig-Attachment',
  'Mini-Enail',
  'Vape',
  'BW33-14',
  'BW33-19',
  'BW33-14-45',
  'BW33-19-45',
  'BW33-14 Pro',
  'BW33-19 Pro',
  'FP-Bowl',
  '14-HC-Bowl',
  '18-HC-Bowl',
  'Hybrid-Bowl',
  '14-3X-Bowl',
  '18-3X-Bowl',
  '14-G-Bowl',
  '18-G-Bowl',
  '14-Banger',
  '18-Banger',
  'J-Bowl'
);

  SELECT count(*) INTO v_supplier_rows
    FROM sku_supplier_costs sc
    JOIN product_skus p ON p.id = sc.sku_id
   WHERE p.sku IN (
  'BW20',
  'BW20P',
  'BW20DNA',
  'BW20DNA-Iridescent',
  'BW30P',
  'BW64',
  'BW21',
  'BW21P',
  'BW21U',
  'BW40',
  'BW40XL',
  'BW40SP',
  'BW60',
  'BW60U',
  'NB1',
  'NB2',
  'BW22',
  'BW22U',
  'BW25',
  'BW58N',
  'NB1M',
  'NB2M',
  'BW51D',
  'BW56',
  'BW59',
  'BW62',
  'BW63',
  'BW68',
  'NB4',
  'NB5',
  'NB6',
  'BW38',
  'BW55',
  'BW34',
  'E-Rig-Attachment',
  'Mini-Enail',
  'Vape',
  'BW33-14',
  'BW33-19',
  'BW33-14-45',
  'BW33-19-45',
  'BW33-14 Pro',
  'BW33-19 Pro',
  'FP-Bowl',
  '14-HC-Bowl',
  '18-HC-Bowl',
  'Hybrid-Bowl',
  '14-3X-Bowl',
  '18-3X-Bowl',
  '14-G-Bowl',
  '18-G-Bowl',
  '14-Banger',
  '18-Banger',
  'J-Bowl'
);

  SELECT count(*) INTO v_nonfill_count
    FROM product_skus
   WHERE sku IN (
    'Mini-Enail',
    'Vape',
    'BW33-14',
    'BW33-19',
    'BW33-14-45',
    'BW33-19-45',
    'FP-Bowl',
    '14-HC-Bowl',
    '18-HC-Bowl',
    'Hybrid-Bowl',
    '14-3X-Bowl',
    '18-3X-Bowl',
    '14-Banger',
    '18-Banger',
    'J-Bowl'
  )
     AND category = 'non_fillable';

  RAISE NOTICE 'Migration 045 summary:';
  RAISE NOTICE '  CSV rows: %', v_csv_count;
  RAISE NOTICE '  sku_economics rows for imported SKUs: %', v_econ_rows;
  RAISE NOTICE '  sku_supplier_costs rows for imported SKUs: %', v_supplier_rows;
  RAISE NOTICE '  Non-fillable category set on % of 15 expected', v_nonfill_count;
  IF v_econ_rows < v_csv_count THEN
    RAISE NOTICE '  Note: % CSV SKUs were skipped (not present in product_skus).',
      v_csv_count - v_econ_rows;
  END IF;
END$$;
