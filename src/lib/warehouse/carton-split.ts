/**
 * Carton split (design §5.4): the TypeScript twin of the per-carton
 * arithmetic in rpc_record_freight_receipt (20260722000001) and
 * _freight_mint_cartons (20261023000001).
 *
 * A carton group holds U units of a SKU across M identical cartons. After
 * r cartons are checked in the receipt has credited round(U·r/M) units
 * (cumulative rounding, so the last carton lands exactly on U). Carton k
 * (1-based) therefore holds round(U·k/M) − round(U·(k−1)/M): the cartons
 * sum exactly to what the ledger credited. Postgres `round(numeric)` rounds
 * halves away from zero; every value here is non-negative, so that is
 * "half up", done in integers so no float can land on the wrong side of .5.
 */

export interface SplitSku {
  sku_id: string;
  units_total: number;
  /** Shown in previews ("BW20×12"); optional so callers can pass the raw rows. */
  sku?: string | null;
}

/** round(a / b) half up for a ≥ 0, b > 0, in integer arithmetic. */
function roundHalfUp(a: number, b: number): number {
  return Math.floor((2 * a + b) / (2 * b));
}

function assertPlan(unitsTotal: number, cartonQty: number) {
  if (!Number.isInteger(unitsTotal) || unitsTotal < 0) throw new RangeError(`units_total must be a whole number ≥ 0 (got ${unitsTotal})`);
  if (!Number.isInteger(cartonQty) || cartonQty <= 0) throw new RangeError(`carton_qty must be a whole number > 0 (got ${cartonQty})`);
}

/** Units credited once `received` of `cartonQty` cartons are in: round(U·r/M), r clamped to 0..M. */
export function cumulativeUnits(unitsTotal: number, cartonQty: number, received: number): number {
  assertPlan(unitsTotal, cartonQty);
  const r = Math.min(Math.max(Math.trunc(received), 0), cartonQty);
  return roundHalfUp(unitsTotal * r, cartonQty);
}

/** Units of one SKU in carton k (1-based): round(U·k/M) − round(U·(k−1)/M). */
export function cartonUnits(unitsTotal: number, cartonQty: number, k: number): number {
  assertPlan(unitsTotal, cartonQty);
  if (!Number.isInteger(k) || k < 1 || k > cartonQty) throw new RangeError(`carton ${k} is not one of 1..${cartonQty}`);
  return cumulativeUnits(unitsTotal, cartonQty, k) - cumulativeUnits(unitsTotal, cartonQty, k - 1);
}

/** Every carton's units of one SKU, carton 1 first. */
export function splitUnits(unitsTotal: number, cartonQty: number): number[] {
  assertPlan(unitsTotal, cartonQty);
  return Array.from({ length: cartonQty }, (_, i) => cartonUnits(unitsTotal, cartonQty, i + 1));
}

export interface CartonContents {
  /** 1-based carton number within the group. */
  k: number;
  /** Units per SKU row of the group (zero rows kept, so callers can align by index). */
  skus: { sku_id: string; sku: string | null; units: number }[];
  total: number;
}

/** What carton k of a (possibly mixed) group holds. */
export function cartonContents(skus: SplitSku[], cartonQty: number, k: number): CartonContents {
  const rows = skus.map((s) => ({ sku_id: s.sku_id, sku: s.sku ?? null, units: cartonUnits(s.units_total, cartonQty, k) }));
  return { k, skus: rows, total: rows.reduce((sum, r) => sum + r.units, 0) };
}

/** "12" for a single SKU, "BW20×6 + NB4×3" for a mixed carton (SKUs with no units omitted). */
export function describeContents(c: CartonContents): string {
  if (c.skus.length === 1) return String(c.total);
  const parts = c.skus.filter((s) => s.units > 0).map((s) => `${s.sku ?? "?"}×${s.units}`);
  return parts.length > 0 ? parts.join(" + ") : "0";
}

/**
 * The preview the dock reads before tapping +1: "carton 7 of 40 holds 12",
 * or "carton 7 of 40 holds BW20×6 + NB4×3" (k counts within the group, the
 * index the split depends on). Null once every carton is in.
 */
export function nextCartonPreview(skus: SplitSku[], cartonQty: number, received: number): string | null {
  if (received >= cartonQty || cartonQty <= 0) return null;
  const k = Math.max(received, 0) + 1;
  return `carton ${k} of ${cartonQty} holds ${describeContents(cartonContents(skus, cartonQty, k))}`;
}
