"""Generate migration 045 from .cost_import_preview.json + the source CSV.

The JSON preview was built by parsing the CSV with the rules the user
approved (skip-blank-SKU, skip BW64P, treat missing Bluewon% as Nancy,
etc). We re-touch the original CSV here only to recover the per-supplier
"Additional Raw Costs" columns — those aren't stored in the preview JSON
because they get folded into the supplier-side unit_cost during import.
"""
from __future__ import annotations
import csv, json, sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

ROOT = Path(__file__).parent.parent
CSV_PATH = Path(r"C:\Users\chase\Downloads\Data Projects 2025 - Costs Data.csv")
PREVIEW_PATH = ROOT / ".cost_import_preview.json"
OUT_PATH = ROOT / "supabase" / "migrations" / "20260101000045_bootstrap_sku_costs_from_csv.sql"


def parse_money(v):
    if v is None: return None
    s = v.strip().replace("$", "").replace(",", "").strip()
    if s in ("", "-"): return None if v.strip() == "" else 0.0
    try: return float(s)
    except ValueError: return None


def sql_str(s: str) -> str:
    return "'" + s.replace("'", "''") + "'"


def num(v: float) -> str:
    return f"{v:.4f}"


# Load parsed rows (NB1 already overridden in the JSON).
rows = json.loads(PREVIEW_PATH.read_text(encoding="utf-8"))

# Recover per-supplier "Additional Raw Costs" from the source CSV so we
# can compute supplier-side unit_cost = supplier_raw + supplier_additional.
csv_extras: dict[str, dict[str, float]] = {}
with open(CSV_PATH, newline="", encoding="utf-8-sig") as f:
    reader = csv.reader(f)
    next(reader)
    for r in reader:
        if len(r) < 21: r = r + [""] * (21 - len(r))
        sku = r[0].strip()
        if not sku: continue
        csv_extras[sku] = {
            "nancy_add": parse_money(r[3]) or 0.0,
            "yx_add": parse_money(r[5]) or 0.0,
        }

# Build the per-row data shapes needed for each step.
econ_tuples: list[str] = []
supplier_tuples: list[str] = []
nonfill_skus: list[str] = []

for r in rows:
    sku = r["sku"]
    extras = csv_extras.get(sku, {"nancy_add": 0.0, "yx_add": 0.0})
    nancy_unit = (r["nancy_raw_cost"] or 0.0) + extras["nancy_add"]
    yx_unit = (r["yx_raw_cost"] or 0.0) + extras["yx_add"]
    nancy_unit_sql = num(nancy_unit) if nancy_unit > 0 else "NULL::NUMERIC"
    yx_unit_sql = num(yx_unit) if yx_unit > 0 else "NULL::NUMERIC"

    econ_tuples.append(
        "  (" + ", ".join([
            sql_str(sku),
            num(r["pct_nancy"]),
            num(r["pct_yx"]),
            num(r["nancy_raw_cost"]),
            num(r["yx_raw_cost"]),
            num(r["additional_raw_cost"]),
            num(r["pct_sea"]),
            num(r["pct_air"]),
            num(r["sea_freight_cost_per_unit"]),
            num(r["air_freight_cost_per_unit"]),
            num(r["breakage_issue_cost"]),
            num(r["pct_manufactured_us"]),
            num(r["pct_manufactured_cn"]),
            num(r["labor_cost_us"]),
            num(r["glycerin_cost_us"]),
            num(r["manufacturing_cost_cn"]),
            num(r["packing_material_cost"]),
            num(r["packing_labor_cost"]),
            num(r["shipping_cost"]),
        ]) + ")"
    )
    supplier_tuples.append(
        "  (" + ", ".join([
            sql_str(sku),
            num(r["pct_nancy"]),
            num(r["pct_yx"]),
            nancy_unit_sql,
            yx_unit_sql,
        ]) + ")"
    )
    if r["non_fillable"]:
        nonfill_skus.append(sku)

econ_block = ",\n".join(econ_tuples)
supplier_block = ",\n".join(supplier_tuples)
all_skus_list = ",\n  ".join(sql_str(r["sku"]) for r in rows)
nonfill_list = ",\n    ".join(sql_str(s) for s in nonfill_skus)

migration = f"""-- =============================================================
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
{econ_block}
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
  {",  ".join(chr(10) + "  (" + sql_str(r["sku"]) + ")" for r in rows)}
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
{supplier_block}
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
    {nonfill_list}
  )
   AND category != 'non_fillable';

-- -------------------------------------------------------------
-- Sanity report. Surfaces row counts via NOTICE so the deployer can
-- confirm at apply-time. Doesn't fail the migration on any specific
-- number -- we expect skips for SKUs that don't exist in product_skus.
-- -------------------------------------------------------------
DO $$
DECLARE
  v_csv_count INTEGER := {len(rows)};
  v_econ_rows INTEGER;
  v_supplier_rows INTEGER;
  v_nonfill_count INTEGER;
BEGIN
  SELECT count(*) INTO v_econ_rows
    FROM sku_economics se
    JOIN product_skus p ON p.id = se.sku_id
   WHERE p.sku IN (
  {all_skus_list}
);

  SELECT count(*) INTO v_supplier_rows
    FROM sku_supplier_costs sc
    JOIN product_skus p ON p.id = sc.sku_id
   WHERE p.sku IN (
  {all_skus_list}
);

  SELECT count(*) INTO v_nonfill_count
    FROM product_skus
   WHERE sku IN (
    {nonfill_list}
  )
     AND category = 'non_fillable';

  RAISE NOTICE 'Migration 045 summary:';
  RAISE NOTICE '  CSV rows: %', v_csv_count;
  RAISE NOTICE '  sku_economics rows for imported SKUs: %', v_econ_rows;
  RAISE NOTICE '  sku_supplier_costs rows for imported SKUs: %', v_supplier_rows;
  RAISE NOTICE '  Non-fillable category set on % of {len(nonfill_skus)} expected', v_nonfill_count;
  IF v_econ_rows < v_csv_count THEN
    RAISE NOTICE '  Note: % CSV SKUs were skipped (not present in product_skus).',
      v_csv_count - v_econ_rows;
  END IF;
END$$;
"""

OUT_PATH.write_text(migration, encoding="utf-8")
print(f"Wrote {OUT_PATH}")
print(f"  size: {len(migration):,} bytes")
print(f"  csv rows: {len(rows)}")
print(f"  non_fillable flips: {len(nonfill_skus)}")
