/**
 * Sale spans for the marketing calendar (owner design 2026-09-24, "the bar"):
 * a sale is drawn as one continuous tinted bar from its first drawn day (early
 * access when set) through its close. The early-access window is the hollow
 * leading portion of the same bar (faint tint + inset outline in the sale's
 * hue), fused to the solid bar at the public open day, which carries a 3px
 * solid cap on its left edge. The bar is rounded only at its true ends and
 * square where it wraps at a week edge. Each sale gets its own hue so
 * overlapping sales read apart.
 *
 * Pure helpers — no React, no dates library — so the lane/role/segment logic
 * is unit-testable and the same for the scroll grid, the day popover, the
 * agenda and the year view.
 */

import { shiftDayKey } from "@/lib/marketing-format";

/** One sale hue: the solid step (caps, outlines, glyphs) and the light text step (labels). */
export interface SaleHue {
  solid: string;
  text: string;
}

/**
 * Eight lightened hues ordered for neighbour contrast. Violet and cyan are
 * deliberately absent: those are the launch and broadcast type colors.
 */
export const SALE_PALETTE_ENTRIES: readonly SaleHue[] = [
  { solid: "#fbbf24", text: "#fcd34d" }, // amber
  { solid: "#60a5fa", text: "#93c5fd" }, // blue
  { solid: "#f472b6", text: "#f9a8d4" }, // pink
  { solid: "#34d399", text: "#6ee7b7" }, // emerald
  { solid: "#fb923c", text: "#fdba74" }, // orange
  { solid: "#e879f9", text: "#f0abfc" }, // fuchsia
  { solid: "#a3e635", text: "#bef264" }, // lime
  { solid: "#f87171", text: "#fca5a5" }, // red
];

/** The solid step of each palette slot (what saleColorMap hands out). */
export const SALE_PALETTE: readonly string[] = SALE_PALETTE_ENTRIES.map((p) => p.solid);

/** Neutral fallback when a sale has no palette slot (sales have no single type hue). */
export const SALE_FALLBACK_COLOR = "#9a9a9a";

/** Neutral label color used when a solid hex has no text step (fallback hue). */
const FALLBACK_TEXT_COLOR = "#e6e6e6";

const TEXT_BY_SOLID: ReadonlyMap<string, string> = new Map(
  SALE_PALETTE_ENTRIES.map((p) => [p.solid.toLowerCase(), p.text]),
);

/** The light text step for a sale's solid hue (labels on the 18% tint). */
export function saleTextColor(solid: string): string {
  return TEXT_BY_SOLID.get(solid.toLowerCase()) ?? FALLBACK_TEXT_COLOR;
}

/** "#rrggbb" at an alpha → "rgba(r,g,b,a)"; any other color string is returned as-is. */
export function hexToRgba(hex: string, alpha: number): string {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return hex;
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

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

const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Sep 24" for a YYYY-MM-DD key (pure, no dates library). */
export function formatDayKeyShort(key: string): string {
  const [, m, d] = key.split("-").map(Number);
  return `${MONTH_ABBR[m - 1] ?? ""} ${d}`;
}

/** "Sep 24 – Oct 2", or "Sep 24" for a one-day sale. */
export function formatSpanRange(s: Pick<SaleSpanInput, "start" | "end">): string {
  return s.start === s.end
    ? formatDayKeyShort(s.start)
    : `${formatDayKeyShort(s.start)} – ${formatDayKeyShort(s.end)}`;
}

/**
 * The drawing facts for one day's piece of a sale bar. Every piece is 20px
 * tall; these flags decide its fill, ends, bleed and whether it hosts the
 * name for its week-row segment.
 */
export interface SaleSegmentDraw {
  role: SaleSpanRole;
  /** Early-access day: faint tint + inset outline instead of the solid tint. */
  hollow: boolean;
  /** Public open day (incl. one-day sales): 3px solid-hue cap on the left edge. */
  cap: boolean;
  /** True first / last day of the span: the only ends that get a radius. */
  roundL: boolean;
  roundR: boolean;
  /** Continues from / into a neighbouring cell within the same row: bleed into the grid gap. */
  bleedL: boolean;
  bleedR: boolean;
  /** Continues from the previous row (Sunday) / into the next row (Saturday): square to the cell edge. */
  edgeL: boolean;
  edgeR: boolean;
  /** Hosts the name: Sunday (first cell of a week row) or the span's first drawn day. */
  showLabel: boolean;
  /** "Name · early access Sep 21 · Sep 24 – Oct 2 · locked (past)" pieces (approval appended by the caller). */
  tooltipParts: string[];
}

/**
 * Drawing facts for `span` on `day` (YYYY-MM-DD) whose weekday is `dow`
 * (0 = Sunday … 6 = Saturday), or null when the day is outside the span.
 */
export function saleSegmentOnDay(s: SaleSpanInput, day: string, dow: number): SaleSegmentDraw | null {
  const role = saleRoleOnDay(s, day);
  if (!role) return null;
  const first = spanFirstDay(s);
  const trueFirst = day === first;
  const trueLast = day === s.end;
  const continuesL = !trueFirst;
  const continuesR = !trueLast;
  const tooltipParts = [
    s.name,
    s.eaStart && s.eaStart < s.start ? `early access ${formatDayKeyShort(s.eaStart)}` : null,
    formatSpanRange(s),
    s.past ? "locked (past)" : null,
  ].filter((p): p is string => !!p);
  return {
    role,
    hollow: role === "ea_start" || role === "ea_line",
    cap: role === "start" || role === "single",
    roundL: trueFirst,
    roundR: trueLast,
    bleedL: continuesL && dow !== 0,
    bleedR: continuesR && dow !== 6,
    edgeL: continuesL && dow === 0,
    edgeR: continuesR && dow === 6,
    showLabel: dow === 0 || trueFirst,
    tooltipParts,
  };
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
