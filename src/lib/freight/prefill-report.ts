/**
 * Pre-filled Rate report — statistics for the redesigned modal.
 *
 * Owner-approved design (2026-08-14 proposal, v3): counts headline every
 * tile with the share as context, all backward-looking figures on ARRIVAL
 * basis (workload truth), the on-the-water band is window-exempt, and the
 * factory ask list only claims capability the factory has demonstrated on
 * its own shipments. Small-data guardrails: thin months get muted labels,
 * crew-days conversion suppresses itself below FILL_PACE_MIN_DAYS of
 * measured activity.
 */

export interface PrefillLineSource {
  sku_id: string | null;
  freight_shipment_id: string;
  quantity: number | null;
  quantity_prefilled: number | null;
  quantity_received: number | null;
  product: { sku: string; product_name: string; category: string } | null;
}

export interface PrefillShipmentSource {
  id: string;
  status: string;
  ship_date: string | null;
  actual_arrival_date: string | null;
  eta: string | null;
}

export const PREFILL_WINDOWS = [
  { key: "90", label: "90D", days: 90 },
  { key: "180", label: "6M", days: 180 },
  { key: "all", label: "All", days: Infinity },
] as const;
export type PrefillWindowKey = (typeof PREFILL_WINDOWS)[number]["key"];

/** A month is "thin" (muted % label) below this many units… */
export const THIN_MONTH_UNITS = 200;
/** …or below this many distinct shipments. */
export const THIN_MONTH_SHIPMENTS = 2;
/** Crew-days conversion needs at least this many active fill days. */
export const FILL_PACE_MIN_DAYS = 10;

const DAY_MS = 86_400_000;

/** One arrived fillable line, prefill split known. */
export interface PrefillRow {
  arrivalDate: string;
  shipmentId: string;
  sku: string;
  name: string;
  qty: number;
  prefilled: number;
}

export function buildPrefillRows(
  lines: readonly PrefillLineSource[],
  shipments: readonly PrefillShipmentSource[],
): PrefillRow[] {
  const shipById = new Map(shipments.map((s) => [s.id, s]));
  const rows: PrefillRow[] = [];
  for (const l of lines) {
    if (l.product?.category !== "fillable" || l.quantity_prefilled == null || !l.sku_id) continue;
    const ship = shipById.get(l.freight_shipment_id);
    if (!ship?.actual_arrival_date) continue; // still on the water → inbound band
    rows.push({
      arrivalDate: ship.actual_arrival_date,
      shipmentId: ship.id,
      sku: l.product.sku,
      name: l.product.product_name,
      qty: l.quantity ?? 0,
      prefilled: Math.min(Math.max(l.quantity_prefilled, 0), l.quantity ?? 0),
    });
  }
  return rows.sort((a, b) => a.arrivalDate.localeCompare(b.arrivalDate));
}

export function windowCutoffIso(days: number, todayIso: string): string {
  if (!Number.isFinite(days)) return "0000-00-00";
  return new Date(Date.parse(todayIso + "T00:00:00Z") - days * DAY_MS).toISOString().slice(0, 10);
}

export interface PrefillTotals {
  units: number;
  prefilled: number;
  unfilled: number;
  shipmentCount: number;
}

export function windowTotals(
  rows: readonly PrefillRow[],
  days: number,
  todayIso: string,
): PrefillTotals {
  const cutoff = windowCutoffIso(days, todayIso);
  const w = rows.filter((r) => r.arrivalDate >= cutoff);
  const units = w.reduce((s, r) => s + r.qty, 0);
  const prefilled = w.reduce((s, r) => s + r.prefilled, 0);
  return {
    units,
    prefilled,
    unfilled: units - prefilled,
    shipmentCount: new Set(w.map((r) => r.shipmentId)).size,
  };
}

export interface MonthStack {
  month: string; // YYYY-MM
  units: number;
  prefilled: number;
  unfilled: number;
  pct: number; // rounded prefilled share
  /** Muted/hollow % label when true — too little data for a confident rate. */
  thin: boolean;
}

export function monthlyStacks(
  rows: readonly PrefillRow[],
  days: number,
  todayIso: string,
): MonthStack[] {
  const cutoff = windowCutoffIso(days, todayIso);
  const byMonth = new Map<string, { units: number; prefilled: number; ships: Set<string> }>();
  for (const r of rows) {
    if (r.arrivalDate < cutoff) continue;
    const m = r.arrivalDate.slice(0, 7);
    const c = byMonth.get(m) ?? { units: 0, prefilled: 0, ships: new Set<string>() };
    c.units += r.qty;
    c.prefilled += r.prefilled;
    c.ships.add(r.shipmentId);
    byMonth.set(m, c);
  }
  return [...byMonth.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([month, c]) => ({
      month,
      units: c.units,
      prefilled: c.prefilled,
      unfilled: c.units - c.prefilled,
      pct: c.units > 0 ? Math.round((100 * c.prefilled) / c.units) : 0,
      thin: c.units < THIN_MONTH_UNITS || c.ships.size < THIN_MONTH_SHIPMENTS,
    }));
}

/** Per-SKU capability evidence, from ALL shipments (arrived or not):
 *  the factory either has or hasn't pre-filled this SKU before. */
export interface SkuProof {
  shipments: number;
  prefilledShipments: number;
  lastShipDate: string | null;
}

export function buildSkuProof(
  lines: readonly PrefillLineSource[],
  shipments: readonly PrefillShipmentSource[],
): Map<string, SkuProof> {
  const shipById = new Map(shipments.map((s) => [s.id, s]));
  const acc = new Map<string, { ships: Set<string>; preShips: Set<string>; last: string | null }>();
  for (const l of lines) {
    if (l.product?.category !== "fillable" || l.quantity_prefilled == null || !l.sku_id) continue;
    const sku = l.product.sku;
    const c = acc.get(sku) ?? { ships: new Set<string>(), preShips: new Set<string>(), last: null };
    c.ships.add(l.freight_shipment_id);
    if ((l.quantity_prefilled ?? 0) > 0) c.preShips.add(l.freight_shipment_id);
    const shipDate = shipById.get(l.freight_shipment_id)?.ship_date ?? null;
    if (shipDate && (!c.last || shipDate > c.last)) c.last = shipDate;
    acc.set(sku, c);
  }
  const out = new Map<string, SkuProof>();
  for (const [sku, c] of acc) {
    out.set(sku, {
      shipments: c.ships.size,
      prefilledShipments: c.preShips.size,
      lastShipDate: c.last,
    });
  }
  return out;
}

export interface AskRow {
  sku: string;
  name: string;
  units: number;
  prefilled: number;
  unfilled: number;
  pct: number;
  shipmentsInWindow: number;
  proof: SkuProof | null;
}

/** Per-SKU rollup for the window, ranked by unfilled volume. */
export function skuRollup(
  rows: readonly PrefillRow[],
  days: number,
  todayIso: string,
  proof: ReadonlyMap<string, SkuProof>,
): AskRow[] {
  const cutoff = windowCutoffIso(days, todayIso);
  const acc = new Map<string, { name: string; units: number; prefilled: number; ships: Set<string> }>();
  for (const r of rows) {
    if (r.arrivalDate < cutoff) continue;
    const c = acc.get(r.sku) ?? { name: r.name, units: 0, prefilled: 0, ships: new Set<string>() };
    c.units += r.qty;
    c.prefilled += r.prefilled;
    c.ships.add(r.shipmentId);
    acc.set(r.sku, c);
  }
  return [...acc.entries()]
    .map(([sku, c]) => ({
      sku,
      name: c.name,
      units: c.units,
      prefilled: c.prefilled,
      unfilled: c.units - c.prefilled,
      pct: c.units > 0 ? Math.round((100 * c.prefilled) / c.units) : 0,
      shipmentsInWindow: c.ships.size,
      proof: proof.get(sku) ?? null,
    }))
    .sort((a, b) => b.unfilled - a.unfilled);
}

export interface InboundBuckets {
  shipments: number;
  units: number;
  prefilled: number;
  unfilled: number;
  /** Unfilled units by expected arrival: ≤14d, 15–28d, later-or-unknown. */
  buckets: [number, number, number];
  lastEta: string | null;
}

/** On-the-water fillable workload — remaining units only (partial receipts
 *  excluded), prefill split applied proportionally per line. */
export function inboundSummary(
  lines: readonly PrefillLineSource[],
  shipments: readonly PrefillShipmentSource[],
  todayIso: string,
): InboundBuckets {
  const shipById = new Map(shipments.map((s) => [s.id, s]));
  const t0 = Date.parse(todayIso + "T00:00:00Z");
  let units = 0;
  let unfilled = 0;
  const buckets: [number, number, number] = [0, 0, 0];
  const shipIds = new Set<string>();
  let lastEta: string | null = null;
  for (const l of lines) {
    if (l.product?.category !== "fillable" || l.quantity_prefilled == null || !l.sku_id) continue;
    const ship = shipById.get(l.freight_shipment_id);
    if (!ship || ship.status === "delivered") continue;
    const qty = l.quantity ?? 0;
    if (qty <= 0) continue;
    const remaining = Math.max(qty - (l.quantity_received ?? 0), 0);
    if (remaining === 0) continue;
    const unfilledShare = (remaining * (qty - Math.min(l.quantity_prefilled, qty))) / qty;
    units += remaining;
    unfilled += unfilledShare;
    shipIds.add(ship.id);
    const eta = ship.eta;
    if (eta && (!lastEta || eta > lastEta)) lastEta = eta;
    const daysOut = eta ? Math.round((Date.parse(eta + "T00:00:00Z") - t0) / DAY_MS) : null;
    const idx = daysOut == null || daysOut > 28 ? 2 : daysOut > 14 ? 1 : 0;
    buckets[idx] += unfilledShare;
  }
  return {
    shipments: shipIds.size,
    units: Math.round(units),
    prefilled: Math.round(units - unfilled),
    unfilled: Math.round(unfilled),
    buckets: [Math.round(buckets[0]), Math.round(buckets[1]), Math.round(buckets[2])],
    lastEta,
  };
}

export interface FillPace {
  /** Median units per ACTIVE fill day; null below FILL_PACE_MIN_DAYS. */
  unitsPerActiveDay: number | null;
  activeDays: number;
}

export function fillPaceFromDailyTotals(dailyTotals: readonly number[]): FillPace {
  const active = dailyTotals.filter((d) => d > 0);
  if (active.length < FILL_PACE_MIN_DAYS) {
    return { unitsPerActiveDay: null, activeDays: active.length };
  }
  const s = [...active].sort((a, b) => a - b);
  const mid = (s.length - 1) / 2;
  const median = (s[Math.floor(mid)] + s[Math.ceil(mid)]) / 2;
  return { unitsPerActiveDay: Math.round(median), activeDays: active.length };
}

/** Mon–Fri days strictly after today, through end date inclusive. */
export function workingDaysUntil(endIso: string, todayIso: string): number {
  let t = Date.parse(todayIso + "T00:00:00Z");
  const end = Date.parse(endIso + "T00:00:00Z");
  let n = 0;
  while (t < end) {
    t += DAY_MS;
    const dow = new Date(t).getUTCDay();
    if (dow !== 0 && dow !== 6) n++;
  }
  return n;
}

export type PaceVerdict = "room" | "par" | "over";

/** How inbound fill work compares to the runway before it all lands. */
export function paceVerdict(crewDays: number, workDays: number): PaceVerdict {
  if (workDays <= 0) return crewDays > 0 ? "over" : "par";
  const ratio = crewDays / workDays;
  if (ratio <= 0.8) return "room";
  if (ratio <= 1.2) return "par";
  return "over";
}
