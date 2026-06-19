/**
 * marketing-format — pure display helpers for the Marketing module.
 * No React, no Supabase. Keeps the composable-offer → human-text logic
 * in one tested place.
 */

/** Drop trailing zeros from a numeric value for display (20.00 → "20"). */
function trimNum(n: number): string {
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 });
}

export interface OfferLike {
  percent_off: number | null;
  dollar_off: number | null;
  free_item_sku_id: string | null;
  min_order_amount: number | null;
  buy_qty: number | null;
  get_qty: number | null;
  scope: string;
  category: string | null;
  code: string | null;
}

/**
 * Render a composable offer into readable parts:
 *   deal   — "20% off + free Grinder over $75"
 *   target — "Sitewide" | "<Category>" | "Select SKUs"
 *   code   — the coupon code or null
 */
export function describeOffer(
  o: OfferLike,
  freeItemName?: string | null,
): { deal: string; target: string; code: string | null } {
  const parts: string[] = [];
  if (o.percent_off != null) parts.push(`${trimNum(o.percent_off)}% off`);
  if (o.dollar_off != null) parts.push(`$${trimNum(o.dollar_off)} off`);
  if (o.buy_qty != null && o.get_qty != null) parts.push(`buy ${o.buy_qty} get ${o.get_qty}`);
  if (o.free_item_sku_id) parts.push(`free ${freeItemName ?? "item"}`);

  let deal = parts.join(" + ") || "Offer";
  deal = deal.charAt(0).toUpperCase() + deal.slice(1);
  if (o.min_order_amount != null) deal += ` over $${trimNum(o.min_order_amount)}`;

  const target =
    o.scope === "sitewide"
      ? "Sitewide"
      : o.scope === "category"
        ? o.category || "Category"
        : "Select SKUs";

  return { deal, target, code: o.code || null };
}

/**
 * A sale's running state is DERIVED from its dates (vs. today, YYYY-MM-DD) —
 * never stored — so it can't drift. Unconfirmed/canceled sales aren't parked;
 * they're deleted. Returns null when no start date is set yet.
 */
export type SalePhase = "upcoming" | "live" | "ended";

export function salePhase(
  startsAt: string | null,
  endsAt: string | null,
  todayKey: string,
): SalePhase | null {
  const s = dayKeyOf(startsAt);
  if (!s) return null;
  const e = dayKeyOf(endsAt) ?? s;
  if (todayKey < s) return "upcoming";
  if (todayKey > e) return "ended";
  return "live";
}

export const PHASE_COLOR: Record<SalePhase, string> = {
  upcoming: "bg-blue-500/10 text-blue-400",
  live: "bg-green-500/10 text-green-400",
  ended: "bg-muted/40 text-muted-foreground",
};

/**
 * A launch's state is DERIVED, never stored:
 *   Upcoming — launch_date is in the future
 *   Launched — launch_date is today or past
 *   Sold out — launched AND the linked SKU has no stock on hand (passed in
 *              by the caller, read live from inventory)
 * Returns null when no launch date is set yet.
 */
export type LaunchPhase = "upcoming" | "launched" | "sold_out";

export function launchPhase(
  launchDate: string | null,
  todayKey: string,
  soldOut: boolean,
): LaunchPhase | null {
  const d = dayKeyOf(launchDate);
  if (!d) return null;
  if (todayKey < d) return "upcoming";
  return soldOut ? "sold_out" : "launched";
}

export const LAUNCH_PHASE_COLOR: Record<LaunchPhase, string> = {
  upcoming: "bg-blue-500/10 text-blue-400",
  launched: "bg-green-500/10 text-green-400",
  sold_out: "bg-amber-500/10 text-amber-400",
};

export const LAUNCH_PHASE_LABEL: Record<LaunchPhase, string> = {
  upcoming: "Upcoming",
  launched: "Launched",
  sold_out: "Sold out",
};

/** Marketing event-type colors for the calendar (sale / launch / broadcast). */
export const EVENT_TYPE_COLOR = {
  sale: "hsl(45, 85%, 55%)",
  launch: "hsl(270, 67%, 60%)",
  broadcast: "hsl(190, 80%, 55%)",
} as const;

// ---------------------------------------------------------------------------
// Day-key helpers — treat marketing dates as calendar days, NOT instants.
// Stored values are timestamptz/date; converting via the local tz can shift
// the day (e.g. a UTC-midnight value reads as the previous day in EDT). We
// key off the first 10 chars ("YYYY-MM-DD") so the day the user picked is the
// day we show and move, with no timezone drift. Lexicographic compare is valid
// for the YYYY-MM-DD format.
// ---------------------------------------------------------------------------

/** The calendar-day key ("YYYY-MM-DD") of an ISO/date string, or null. */
export function dayKeyOf(iso: string | null): string | null {
  return iso ? iso.slice(0, 10) : null;
}

/** Shift a YYYY-MM-DD key by a whole number of days (tz-safe, local math). */
export function shiftDayKey(key: string, deltaDays: number): string {
  const [y, m, d] = key.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + deltaDays);
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

/** Whole calendar days from `from` to `to` (both YYYY-MM-DD). Negative if to<from. */
export function daysBetweenKeys(from: string, to: string): number {
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  const a = new Date(fy, fm - 1, fd).getTime();
  const b = new Date(ty, tm - 1, td).getTime();
  return Math.round((b - a) / 86_400_000);
}

/** Is this day strictly before today? (Used to lock past events.) */
export function isPastKey(key: string | null, todayKey: string): boolean {
  return !!key && key < todayKey;
}
