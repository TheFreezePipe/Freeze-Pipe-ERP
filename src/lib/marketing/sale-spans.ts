/**
 * Sale spans for the marketing calendar (owner design 2026-09-23): a sale is
 * drawn as a marker on its opening day and a marker on its closing day joined
 * by a line through every open day. The early-access open day and the line
 * joining it to the public open are black with an outline in the sale's
 * color. Each sale gets its own color so overlapping sales read apart.
 *
 * Pure helpers — no React, no dates library — so the lane/role logic is
 * unit-testable and the same for the scroll grid, the day popover, the
 * agenda and the year view.
 */

import { shiftDayKey } from "@/lib/marketing-format";

/** Distinct hues on the dark theme. Violet and cyan are deliberately absent:
 *  those are the launch and broadcast type colors. */
export const SALE_PALETTE = [
  "#f59e0b", // amber
  "#22c55e", // green
  "#3b82f6", // blue
  "#ec4899", // pink
  "#ef4444", // red
  "#a3e635", // lime
  "#fb923c", // orange
  "#2dd4bf", // teal
] as const;

/**
 * Sales sorted by start date take palette slots in order, so sales that sit
 * near each other in time never share a color. Stable for a given set of
 * sales regardless of input order.
 */
export function saleColorMap(sales: Array<{ id: string; starts_at: string | null }>): Map<string, string> {
  const sorted = [...sales].sort((a, b) => {
    const ka = a.starts_at ?? "";
    const kb = b.starts_at ?? "";
    return ka < kb ? -1 : ka > kb ? 1 : a.id.localeCompare(b.id);
  });
  const m = new Map<string, string>();
  sorted.forEach((s, i) => m.set(s.id, SALE_PALETTE[i % SALE_PALETTE.length]));
  return m;
}

export interface SaleSpanInput {
  id: string;
  name: string;
  color: string;
  /** Early-access open day (YYYY-MM-DD) when it precedes `start`, else null. */
  eaStart: string | null;
  /** Public open / close days (YYYY-MM-DD). */
  start: string;
  end: string;
  past: boolean;
  approval: string | null;
}

export interface SaleSpan extends SaleSpanInput {
  /** Vertical slot in the day cell; overlapping sales get different lanes. */
  lane: number;
}

/** First drawn day of a span (early access when set). */
export function spanFirstDay(s: Pick<SaleSpanInput, "eaStart" | "start">): string {
  return s.eaStart && s.eaStart < s.start ? s.eaStart : s.start;
}

/**
 * Greedy interval coloring: spans sorted by first day take the lowest lane
 * whose previous occupant has already ended. Overlapping sales never share a
 * lane; non-overlapping ones reuse lane 0.
 */
export function assignSaleLanes(inputs: SaleSpanInput[]): SaleSpan[] {
  const sorted = [...inputs].sort((a, b) => {
    const ka = spanFirstDay(a);
    const kb = spanFirstDay(b);
    return ka < kb ? -1 : ka > kb ? 1 : a.id.localeCompare(b.id);
  });
  const laneEnds: string[] = [];
  return sorted.map((s) => {
    const first = spanFirstDay(s);
    let lane = laneEnds.findIndex((end) => end < first);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(s.end);
    } else {
      laneEnds[lane] = s.end;
    }
    return { ...s, lane };
  });
}

export type SaleSpanRole = "ea_start" | "ea_line" | "single" | "start" | "line" | "end";

/** What a span draws on a given day, or null when the day is outside it. */
export function saleRoleOnDay(s: SaleSpanInput, day: string): SaleSpanRole | null {
  const first = spanFirstDay(s);
  if (day < first || day > s.end) return null;
  if (day < s.start) return day === first ? "ea_start" : "ea_line";
  if (s.start === s.end) return "single";
  if (day === s.start) return "start";
  if (day === s.end) return "end";
  return "line";
}

/** Sunday-based week key (YYYY-MM-DD of the Sunday) for a day key. */
export function weekKeyOf(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const dow = new Date(y, m - 1, d).getDay();
  return shiftDayKey(day, -dow);
}

/**
 * Index every drawn day of every span, and the number of lanes each week row
 * must reserve so lane positions line up across the row's cells.
 */
export function indexSaleSpans(spans: SaleSpan[], maxDays = 400): {
  byDay: Map<string, SaleSpan[]>;
  lanesByWeek: Map<string, number>;
} {
  const byDay = new Map<string, SaleSpan[]>();
  const lanesByWeek = new Map<string, number>();
  for (const s of spans) {
    let k = spanFirstDay(s);
    let guard = 0;
    while (k <= s.end && guard++ < maxDays) {
      const arr = byDay.get(k) ?? [];
      arr.push(s);
      byDay.set(k, arr);
      const wk = weekKeyOf(k);
      lanesByWeek.set(wk, Math.max(lanesByWeek.get(wk) ?? 0, s.lane + 1));
      k = shiftDayKey(k, 1);
    }
  }
  return { byDay, lanesByWeek };
}
