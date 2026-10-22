/**
 * What the Stock map paints on each bay (design §9.1 map modes, §9.3
 * FloorPlan). Pure: wh_location_summary rows in, numbers and colours out.
 *
 *   browse   zone colour (status-colors WH_ZONE_FILLS)
 *   stock    cartons against capacity_cartons; empty bins outlined; with no
 *            capacity set, shaded relative to the fullest bin on the plan
 *   counted  days since last_counted_at, bucketed
 *   heat     30-day demand per SKU (getEffectiveDemand) spread evenly over
 *            the bins holding that SKU, pick bins first (design §9.1:
 *            bin-level picks only exist after Phase 2)
 */
import { bayKey } from "./map-geometry";

export type MapMode = "browse" | "stock" | "counted" | "heat";
export const MAP_MODES: readonly MapMode[] = ["browse", "stock", "counted", "heat"];
export const MAP_MODE_LABELS: Record<MapMode, string> = {
  browse: "Browse",
  stock: "Stock",
  counted: "Counted",
  heat: "Heat",
};

export type MapLevel = "1" | "2" | "3" | "all";
export const MAP_LEVELS: readonly MapLevel[] = ["1", "2", "3", "all"];

export function parseMapMode(v: string | null | undefined): MapMode {
  return MAP_MODES.includes(v as MapMode) ? (v as MapMode) : "browse";
}

export function parseMapLevel(v: string | null | undefined): MapLevel {
  return MAP_LEVELS.includes(v as MapLevel) ? (v as MapLevel) : "all";
}

/** The fields of a wh_location_summary row the map reads. */
export interface MapContent {
  container_id: string | null;
  code: string | null;
  sku_id: string;
  sku: string;
  qty: number;
}

export interface MapLocationRow {
  id: string | null;
  code: string | null;
  name?: string | null;
  kind: string | null;
  zone: string | null;
  face: string | null;
  bay: number | null;
  level: number | null;
  pickable: boolean | null;
  is_overflow: boolean | null;
  active: boolean | null;
  capacity_cartons: number | null;
  cartons: number | null;
  units: number | null;
  last_counted_at: string | null;
  contents: MapContent[];
}

/** Bay-level rows by bay key ("03-05"), levels ascending. Inactive rows are left out. */
export function indexByBay<T extends MapLocationRow>(rows: T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    if (r.kind !== "bay_level" || r.active === false || r.face == null || r.bay == null) continue;
    const k = bayKey(r.face, r.bay);
    const list = out.get(k) ?? [];
    list.push(r);
    out.set(k, list);
  }
  for (const list of out.values()) list.sort((a, b) => (a.level ?? 0) - (b.level ?? 0));
  return out;
}

/** The rows a bay cell shows for the chosen level. */
export function rowsForLevel<T extends MapLocationRow>(rows: T[] | undefined, level: MapLevel): T[] {
  if (!rows) return [];
  return level === "all" ? rows : rows.filter((r) => String(r.level) === level);
}

/** Rack faces in walk order (their lowest pick_sequence), each with its bay-levels. */
export function facesInWalkOrder<T extends Pick<MapLocationRow, "kind" | "active" | "face"> & { pick_sequence: number | null }>(
  rows: T[],
): { face: string; rows: T[]; first: number }[] {
  const by = new Map<string, T[]>();
  for (const r of rows) {
    if (r.kind !== "bay_level" || r.active === false || !r.face) continue;
    const list = by.get(r.face) ?? [];
    list.push(r);
    by.set(r.face, list);
  }
  return [...by.entries()]
    .map(([face, list]) => ({ face, rows: list, first: Math.min(...list.map((r) => r.pick_sequence ?? Number.MAX_SAFE_INTEGER)) }))
    .sort((a, b) => a.first - b.first || a.face.localeCompare(b.face));
}

// ---- stock ------------------------------------------------------------------

export interface StockFill {
  cartons: number;
  units: number;
  /** Sum of capacity_cartons; null when any shown row has none. */
  capacity: number | null;
  empty: boolean;
  over: boolean;
}

export function stockFill(rows: MapLocationRow[]): StockFill {
  let cartons = 0;
  let units = 0;
  let capacity: number | null = rows.length ? 0 : null;
  for (const r of rows) {
    cartons += r.cartons ?? 0;
    units += r.units ?? 0;
    capacity = capacity == null || r.capacity_cartons == null ? null : capacity + r.capacity_cartons;
  }
  return { cartons, units, capacity, empty: cartons === 0 && units === 0, over: capacity != null && cartons > capacity };
}

/**
 * 0..1 shade for a bay: cartons / capacity, or, with no capacity set,
 * cartons relative to the fullest bin (loose units alone count as a sliver).
 */
export function stockRatio(fill: StockFill, maxCartons: number): number {
  if (fill.empty) return 0;
  if (fill.capacity != null && fill.capacity > 0) return Math.min(1, fill.cartons / fill.capacity);
  if (fill.cartons === 0) return 0.12;
  return Math.min(1, fill.cartons / Math.max(1, maxCartons));
}

// ---- counted ----------------------------------------------------------------

export type CountBucket = "week" | "month" | "quarter" | "old" | "never";

export const COUNT_BUCKETS: { bucket: CountBucket; label: string; fill: string }[] = [
  { bucket: "week", label: "≤ 7 days", fill: "#22c55e" },
  { bucket: "month", label: "8–30 days", fill: "#84cc16" },
  { bucket: "quarter", label: "31–90 days", fill: "#f59e0b" },
  { bucket: "old", label: "> 90 days", fill: "#ef4444" },
  { bucket: "never", label: "Never counted", fill: "#475569" },
];

export function daysSince(iso: string | null | undefined, now: Date = new Date()): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((now.getTime() - t) / 86_400_000));
}

export function countBucket(days: number | null): CountBucket {
  if (days == null) return "never";
  if (days <= 7) return "week";
  if (days <= 30) return "month";
  if (days <= 90) return "quarter";
  return "old";
}

/** The stalest count among the shown rows: never counted wins. */
export function oldestCountDays(rows: MapLocationRow[], now: Date = new Date()): number | null {
  if (rows.length === 0) return null;
  let worst = -1;
  for (const r of rows) {
    const d = daysSince(r.last_counted_at, now);
    if (d == null) return null;
    worst = Math.max(worst, d);
  }
  return worst;
}

// ---- heat -------------------------------------------------------------------

export interface HeatResult {
  /** Units of 30-day demand per location id. */
  byLocation: Map<string, number>;
  max: number;
  /** Bins holding any stock; 0 means heat has nothing to paint. */
  stockedBins: number;
}

/**
 * Spread each SKU's 30-day demand evenly over the bins holding it, using
 * only its pick bins when it has any (picks come off the pick face).
 */
export function heatByLocation(rows: MapLocationRow[], demandBySku: Map<string, number>): HeatResult {
  const binsBySku = new Map<string, { pick: Set<string>; all: Set<string> }>();
  let stockedBins = 0;
  for (const r of rows) {
    if (!r.id || r.active === false || r.kind === "virtual") continue;
    let stocked = false;
    for (const c of r.contents) {
      if (c.qty <= 0) continue;
      stocked = true;
      const entry = binsBySku.get(c.sku_id) ?? { pick: new Set<string>(), all: new Set<string>() };
      entry.all.add(r.id);
      if (r.pickable) entry.pick.add(r.id);
      binsBySku.set(c.sku_id, entry);
    }
    if (stocked) stockedBins++;
  }
  const byLocation = new Map<string, number>();
  for (const [skuId, bins] of binsBySku) {
    const demand = demandBySku.get(skuId) ?? 0;
    if (demand <= 0) continue;
    const target = bins.pick.size > 0 ? bins.pick : bins.all;
    const share = demand / target.size;
    for (const id of target) byLocation.set(id, (byLocation.get(id) ?? 0) + share);
  }
  let max = 0;
  for (const v of byLocation.values()) max = Math.max(max, v);
  return { byLocation, max, stockedBins };
}

/** Dark-to-hot ramp for 0..1. */
export function heatColor(t: number): string {
  const x = Math.min(1, Math.max(0, t));
  // #1e293b (slate) → #f97316 (orange) → #fde047 (yellow)
  const stops = [
    [30, 41, 59],
    [249, 115, 22],
    [253, 224, 71],
  ];
  const seg = x < 0.6 ? 0 : 1;
  const local = seg === 0 ? x / 0.6 : (x - 0.6) / 0.4;
  const a = stops[seg];
  const b = stops[seg + 1];
  const c = a.map((v, i) => Math.round(v + (b[i] - v) * local));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

// ---- search -----------------------------------------------------------------

export interface MapSearchContainer {
  code: string;
  location_id: string | null;
  sku?: { sku: string } | null;
}

export interface MapSearchResult {
  /** Location ids that light up. */
  ids: Set<string>;
  /** How the query matched: exact SKU/LPN/location, or a looser contains. */
  match: "exact" | "partial" | "none";
  units: number;
  cartons: number;
}

const norm = (s: string | null | undefined) => (s ?? "").trim().toUpperCase().replace(/^%/, "");

/**
 * Locations a query lights up: SKU codes in their contents, carton LPNs
 * (contents, plus live cartons from useWhContainers) and location codes
 * (a code prefix such as "03" or "03-05" lights the face or bay). Exact
 * matches win; without any, a contains match of three or more characters.
 */
export function searchLocations(rows: MapLocationRow[], containers: MapSearchContainer[], query: string): MapSearchResult {
  const q = norm(query);
  const empty: MapSearchResult = { ids: new Set(), match: "none", units: 0, cartons: 0 };
  if (!q) return empty;

  const tally = (ids: Set<string>, match: MapSearchResult["match"], skuOnly: (c: MapContent) => boolean) => {
    let units = 0;
    const ctns = new Set<string>();
    for (const r of rows) {
      if (!r.id || !ids.has(r.id)) continue;
      for (const c of r.contents) {
        if (!skuOnly(c)) continue;
        units += c.qty;
        if (c.container_id) ctns.add(c.container_id);
      }
    }
    return { ids, match, units, cartons: ctns.size };
  };

  // exact
  const exact = new Set<string>();
  let skuHit = false;
  let lpnHit = false;
  for (const r of rows) {
    if (!r.id || r.active === false) continue;
    const code = norm(r.code);
    if (code === q || (r.kind === "bay_level" && /^\d{2}(-\d{2})?$/.test(q) && code.startsWith(`${q}-`))) exact.add(r.id);
    for (const c of r.contents) {
      if (norm(c.sku) === q) {
        exact.add(r.id);
        skuHit = true;
      }
      if (c.code && norm(c.code) === q) {
        exact.add(r.id);
        lpnHit = true;
      }
    }
  }
  for (const c of containers) {
    if (c.location_id && norm(c.code) === q) {
      exact.add(c.location_id);
      lpnHit = true;
    }
  }
  if (exact.size > 0) {
    const filter = skuHit ? (c: MapContent) => norm(c.sku) === q : lpnHit ? (c: MapContent) => norm(c.code) === q : () => true;
    return tally(exact, "exact", filter);
  }

  if (q.length < 3) return empty;
  const partial = new Set<string>();
  for (const r of rows) {
    if (!r.id || r.active === false) continue;
    if (norm(r.code).includes(q) || norm(r.name).includes(q)) partial.add(r.id);
    if (r.contents.some((c) => norm(c.sku).includes(q) || norm(c.code).includes(q))) partial.add(r.id);
  }
  for (const c of containers) if (c.location_id && norm(c.code).includes(q)) partial.add(c.location_id);
  if (partial.size === 0) return empty;
  return tally(partial, "partial", (c) => norm(c.sku).includes(q) || norm(c.code).includes(q));
}

/** "Face 02 · Bay 01 · Level 2", or the name and kind of a named location. */
export function locationWords(row: Pick<MapLocationRow, "kind" | "face" | "bay" | "level" | "name" | "is_overflow">): string {
  if (row.kind === "bay_level" && row.face != null && row.bay != null && row.level != null) {
    const parts = [`Face ${row.face}`, `Bay ${String(row.bay).padStart(2, "0")}`, `Level ${row.level}`];
    return parts.join(" · ");
  }
  const kind = row.kind === "station" ? "Station" : row.kind === "virtual" ? "Virtual" : "Floor location";
  return row.name ? `${row.name} · ${kind}` : kind;
}
