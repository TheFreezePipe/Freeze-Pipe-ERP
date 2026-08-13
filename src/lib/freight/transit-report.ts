/**
 * Sea Transit Report — statistics for the drill-down modal behind the
 * dashboard's sea-transit card.
 *
 * Design rules (owner-approved proposal, 2026-08-13): at ~10-45 arrivals
 * every number must survive one bad shipment. Medians headline, averages
 * are sub-lines; on-time is a count before it is a percentage; the P90
 * "plan on" figure is suppressed below P90_MIN_N arrivals where it's just
 * the 2nd-worst shipment; the trend line hides below TREND_MIN_N. No
 * period-over-period deltas anywhere — the full-history dot timeline is
 * the honest trend display.
 */

export interface TransitShipmentSource {
  id: string;
  shipment_number: string | null;
  freight_type: string;
  status: string;
  ship_date: string | null;
  actual_arrival_date: string | null;
  eta_original: string | null;
  receipt_confirmed_at: string | null;
  china_customs_delay: boolean | null;
  created_at: string;
}

export interface TransitRow {
  id: string;
  number: string;
  shipDate: string;
  arrivalDate: string;
  transitDays: number;
  /** arrival − originally promised ETA; null when no promise recorded. */
  slipDays: number | null;
  /** arrival → receipt confirmed; null while still unconfirmed. */
  dwellDays: number | null;
  /** First→last check-in event, days. Null for shipments created before
   *  the carton-native shape existed (their one-shot receives would sit
   *  in the median as fake zeros) and for shipments not yet received. */
  spreadDays: number | null;
  customsDelay: boolean;
}

/** "On time" = within this many days after the originally promised ETA. */
export const ON_TIME_GRACE_DAYS = 3;
/** Below this many arrivals, P90 is just the 2nd-worst shipment — hide it. */
export const P90_MIN_N = 15;
/** Below this many arrivals the trailing-median trend line hides. */
export const TREND_MIN_N = 5;
/** Dock-to-stock beyond this many days surfaces the exception note. */
export const DWELL_ALERT_DAYS = 5;
/** Shipments created before this predate carton-group entry — their
 *  receipts are structurally one-session and excluded from spread stats. */
export const CARTON_NATIVE_SINCE = "2026-07-22";
/** Windows holding more arrivals than this render as weekly aggregates. */
export const AGGREGATE_THRESHOLD = 120;

export const REPORT_WINDOWS = [
  { key: "30", label: "30D", days: 30 },
  { key: "90", label: "90D", days: 90 },
  { key: "180", label: "6M", days: 180 },
  { key: "365", label: "1Y", days: 365 },
] as const;
export type ReportWindowKey = (typeof REPORT_WINDOWS)[number]["key"];

const DAY_MS = 86_400_000;

function diffDays(a: string, b: string): number {
  return Math.round((Date.parse(a + "T00:00:00Z") - Date.parse(b + "T00:00:00Z")) / DAY_MS);
}

export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const i = (s.length - 1) * p;
  const lo = Math.floor(i);
  return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (i - lo);
}

export interface ReceiptEvent {
  freight_shipment_id: string;
  received_at: string;
}

/** First→last check-in date span (days) per shipment. */
export function buildReceiptSpans(events: readonly ReceiptEvent[]): Map<string, number> {
  const range = new Map<string, { first: string; last: string }>();
  for (const e of events) {
    const d = e.received_at.slice(0, 10);
    const r = range.get(e.freight_shipment_id);
    if (!r) range.set(e.freight_shipment_id, { first: d, last: d });
    else {
      if (d < r.first) r.first = d;
      if (d > r.last) r.last = d;
    }
  }
  const out = new Map<string, number>();
  for (const [id, r] of range) out.set(id, diffDays(r.last, r.first));
  return out;
}

/**
 * Arrived sea shipments with both dates, oldest arrival first. Negative
 * transits (arrival before ship date — data entry error) are excluded:
 * they tell us nothing about the lane and would poison every percentile.
 */
export function buildTransitRows(
  shipments: readonly TransitShipmentSource[],
  receiptSpans?: ReadonlyMap<string, number>,
): TransitRow[] {
  const rows: TransitRow[] = [];
  for (const s of shipments) {
    if (s.freight_type !== "sea") continue;
    if (!s.ship_date || !s.actual_arrival_date) continue;
    const transit = diffDays(s.actual_arrival_date, s.ship_date);
    if (transit < 0) continue;
    const cartonNative = s.created_at.slice(0, 10) >= CARTON_NATIVE_SINCE;
    rows.push({
      id: s.id,
      number: s.shipment_number ?? "—",
      shipDate: s.ship_date,
      arrivalDate: s.actual_arrival_date,
      transitDays: transit,
      slipDays: s.eta_original ? diffDays(s.actual_arrival_date, s.eta_original) : null,
      dwellDays: s.receipt_confirmed_at
        ? Math.max(diffDays(s.receipt_confirmed_at.slice(0, 10), s.actual_arrival_date), 0)
        : null,
      spreadDays: cartonNative ? receiptSpans?.get(s.id) ?? null : null,
      customsDelay: !!s.china_customs_delay,
    });
  }
  return rows.sort(
    (a, b) => a.arrivalDate.localeCompare(b.arrivalDate) || a.number.localeCompare(b.number),
  );
}

export function windowCutoff(days: number, todayIso: string): string {
  return new Date(Date.parse(todayIso + "T00:00:00Z") - days * DAY_MS).toISOString().slice(0, 10);
}

export interface TransitWindowStats {
  n: number;
  medianTransit: number;
  avgTransit: number;
  minTransit: number;
  maxTransit: number;
  /** ship → receipt-confirmed ("sellable"); over confirmed rows only. */
  s2sMedian: number;
  /** null when n < P90_MIN_N (see module doc). */
  s2sP90: number | null;
  s2sWorst: { days: number; number: string } | null;
  /** On-time counted over rows that have a recorded promise. */
  withPromise: number;
  onTimeCount: number;
  /** Median slip of the late (> grace) shipments; null when none late. */
  lateMedianSlip: number | null;
  dwellMedian: number;
  dwellMax: number;
  dwellMaxNumber: string | null;
  /** Arrival spread (first→last carton) over carton-native shipments. */
  spreadN: number;
  spreadMedian: number;
  spreadMax: number;
  spreadMaxNumber: string | null;
  /** Trend line renders only when true (n >= TREND_MIN_N). */
  showTrend: boolean;
}

export function windowStats(
  rows: readonly TransitRow[],
  days: number,
  todayIso: string = new Date().toISOString().slice(0, 10),
): TransitWindowStats {
  const cutoff = windowCutoff(days, todayIso);
  const w = rows.filter((r) => r.arrivalDate >= cutoff);
  if (w.length === 0) {
    return {
      n: 0, medianTransit: 0, avgTransit: 0, minTransit: 0, maxTransit: 0,
      s2sMedian: 0, s2sP90: null, s2sWorst: null,
      withPromise: 0, onTimeCount: 0, lateMedianSlip: null,
      dwellMedian: 0, dwellMax: 0, dwellMaxNumber: null,
      spreadN: 0, spreadMedian: 0, spreadMax: 0, spreadMaxNumber: null,
      showTrend: false,
    };
  }

  const t = w.map((r) => r.transitDays);
  const confirmed = w.filter((r) => r.dwellDays != null);
  const s2s = confirmed.map((r) => r.transitDays + (r.dwellDays as number));
  const worst = confirmed.reduce<TransitRow | null>(
    (best, r) =>
      !best || r.transitDays + (r.dwellDays as number) > best.transitDays + (best.dwellDays as number)
        ? r
        : best,
    null,
  );
  const promised = w.filter((r) => r.slipDays != null);
  const late = promised.filter((r) => (r.slipDays as number) > ON_TIME_GRACE_DAYS);
  const dwells = confirmed.map((r) => r.dwellDays as number);
  const dwellMax = dwells.length ? Math.max(...dwells) : 0;
  const spreads = w.filter((r) => r.spreadDays != null);
  const spreadMax = spreads.length ? Math.max(...spreads.map((r) => r.spreadDays as number)) : 0;

  return {
    n: w.length,
    medianTransit: percentile(t, 0.5),
    avgTransit: t.reduce((a, b) => a + b, 0) / t.length,
    minTransit: Math.min(...t),
    maxTransit: Math.max(...t),
    s2sMedian: percentile(s2s, 0.5),
    s2sP90: w.length >= P90_MIN_N && s2s.length > 0 ? percentile(s2s, 0.9) : null,
    s2sWorst: worst
      ? { days: worst.transitDays + (worst.dwellDays as number), number: worst.number }
      : null,
    withPromise: promised.length,
    onTimeCount: promised.filter((r) => (r.slipDays as number) <= ON_TIME_GRACE_DAYS).length,
    lateMedianSlip: late.length ? percentile(late.map((r) => r.slipDays as number), 0.5) : null,
    dwellMedian: percentile(dwells, 0.5),
    dwellMax,
    dwellMaxNumber: dwells.length
      ? confirmed.find((r) => r.dwellDays === dwellMax)?.number ?? null
      : null,
    spreadN: spreads.length,
    spreadMedian: percentile(spreads.map((r) => r.spreadDays as number), 0.5),
    spreadMax,
    spreadMaxNumber: spreads.length
      ? spreads.find((r) => r.spreadDays === spreadMax)?.number ?? null
      : null,
    showTrend: w.length >= TREND_MIN_N,
  };
}

/**
 * Trailing-k-shipment median transit, one value per row (rows must be in
 * arrival order — buildTransitRows guarantees it). Calmer than a calendar
 * rolling average at ~10 arrivals/month.
 */
export function trailingMedianSeries(rows: readonly TransitRow[], k = 5): number[] {
  return rows.map((_, i) =>
    percentile(rows.slice(Math.max(0, i - k + 1), i + 1).map((r) => r.transitDays), 0.5),
  );
}

/** Full-history quartile band + tail threshold for chart + table coloring. */
export function transitBand(rows: readonly TransitRow[]): { p25: number; p75: number; p90: number } {
  const t = rows.map((r) => r.transitDays);
  return { p25: percentile(t, 0.25), p75: percentile(t, 0.75), p90: percentile(t, 0.9) };
}

export interface WeeklyBucket {
  /** Monday-aligned ISO date the bucket starts on. */
  weekStart: string;
  n: number;
  median: number;
  min: number;
  max: number;
  customsCount: number;
}

/**
 * Weekly rollup for windows too dense to render per-dot (see
 * AGGREGATE_THRESHOLD). One mark per calendar week of arrivals: median
 * tick with a min–max whisker, customs count carried for the tooltip.
 */
export function weeklyAggregate(rows: readonly TransitRow[]): WeeklyBucket[] {
  const buckets = new Map<string, TransitRow[]>();
  for (const r of rows) {
    const epochDays = Math.floor(Date.parse(r.arrivalDate + "T00:00:00Z") / DAY_MS);
    // Epoch day 0 was a Thursday; +3 aligns bucket boundaries to Mondays.
    const weekStartDays = epochDays - ((epochDays + 3) % 7);
    const key = new Date(weekStartDays * DAY_MS).toISOString().slice(0, 10);
    const arr = buckets.get(key);
    if (arr) arr.push(r);
    else buckets.set(key, [r]);
  }
  return [...buckets.entries()]
    .map(([weekStart, rs]) => {
      const t = rs.map((r) => r.transitDays);
      return {
        weekStart,
        n: rs.length,
        median: percentile(t, 0.5),
        min: Math.min(...t),
        max: Math.max(...t),
        customsCount: rs.filter((r) => r.customsDelay).length,
      };
    })
    .sort((a, b) => a.weekStart.localeCompare(b.weekStart));
}

export interface InTransitSummary {
  count: number;
  oldestDays: number;
  oldestNumber: string;
  oldestHighRisk: boolean;
}

/** Sea shipments currently on the water — excluded from every statistic,
 *  surfaced as a header strip so the report never looks dead between
 *  arrivals. */
export function inTransitSummary(
  shipments: readonly TransitShipmentSource[],
  todayIso: string = new Date().toISOString().slice(0, 10),
): InTransitSummary | null {
  const open = shipments.filter(
    (s) => s.freight_type === "sea" && s.status !== "delivered" && s.ship_date,
  );
  if (open.length === 0) return null;
  const oldest = open.reduce((a, b) => ((a.ship_date as string) <= (b.ship_date as string) ? a : b));
  return {
    count: open.length,
    oldestDays: diffDays(todayIso, oldest.ship_date as string),
    oldestNumber: oldest.shipment_number ?? "—",
    oldestHighRisk: oldest.status === "high_risk",
  };
}
