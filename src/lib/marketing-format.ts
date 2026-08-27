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
  if (o.free_item_sku_id && o.buy_qty != null) {
    // Qualifier-triggered gift — one mechanic, one sentence. (buy_qty
    // without a free item stays the plain same-item BOGO below.)
    const n = o.get_qty ?? 1;
    parts.push(`buy any ${o.buy_qty}, get ${n > 1 ? `${n}× ` : ""}${freeItemName ?? "item"} free`);
  } else {
    if (o.buy_qty != null && o.get_qty != null) parts.push(`buy ${o.buy_qty} get ${o.get_qty}`);
    if (o.free_item_sku_id) parts.push(`free ${freeItemName ?? "item"}`);
  }

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
export type SalePhase = "upcoming" | "early_access" | "live" | "ended";

export function salePhase(
  startsAt: string | null,
  endsAt: string | null,
  todayKey: string,
  earlyAccessStartsAt?: string | null,
): SalePhase | null {
  const s = dayKeyOf(startsAt);
  if (!s) return null;
  const e = dayKeyOf(endsAt) ?? s;
  const ea = dayKeyOf(earlyAccessStartsAt ?? null);
  if (todayKey > e) return "ended";
  if (todayKey >= s) return "live";
  if (ea && todayKey >= ea) return "early_access";
  return "upcoming";
}

export const PHASE_COLOR: Record<SalePhase, string> = {
  upcoming: "bg-blue-500/10 text-blue-400",
  early_access: "bg-violet-500/10 text-violet-400",
  live: "bg-green-500/10 text-green-400",
  ended: "bg-muted/40 text-muted-foreground",
};

export const PHASE_LABEL: Record<SalePhase, string> = {
  upcoming: "Upcoming",
  early_access: "Early access",
  live: "Live",
  ended: "Ended",
};

/**
 * A launch's state is DERIVED, never stored:
 *   Upcoming — launch_date is in the future
 *   Launched — launch_date is today or past
 *   Sold out — launched AND the linked SKU has no stock on hand (passed in
 *              by the caller, read live from inventory)
 * Returns null when no launch date is set yet.
 */
export type LaunchPhase = "upcoming" | "early_access" | "launched" | "sold_out";

export function launchPhase(
  launchDate: string | null,
  todayKey: string,
  soldOut: boolean,
  earlyAccessDate?: string | null,
): LaunchPhase | null {
  const d = dayKeyOf(launchDate);
  if (!d) return null;
  if (todayKey < d) {
    const ea = dayKeyOf(earlyAccessDate ?? null);
    return ea && todayKey >= ea ? "early_access" : "upcoming";
  }
  return soldOut ? "sold_out" : "launched";
}

export const LAUNCH_PHASE_COLOR: Record<LaunchPhase, string> = {
  upcoming: "bg-blue-500/10 text-blue-400",
  early_access: "bg-violet-500/10 text-violet-400",
  launched: "bg-green-500/10 text-green-400",
  sold_out: "bg-amber-500/10 text-amber-400",
};

export const LAUNCH_PHASE_LABEL: Record<LaunchPhase, string> = {
  upcoming: "Upcoming",
  early_access: "Early access",
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
// Confirmation — binary, orthogonal to the derived temporal phase (owner
// decision 2026-08-27: the draft → proposed → confirmed ceremony collapsed to
// confirmed-or-not; legacy "proposed" rows normalize to unconfirmed).
// Unconfirmed sales/launches render dashed + muted so the team sees what's
// brewing without mistaking it for a committed plan.
// ---------------------------------------------------------------------------

export type ApprovalStatus = "draft" | "confirmed";

/** Coerce a raw DB string to the binary model (anything not confirmed → "draft"). */
export function normalizeApproval(status: string | null | undefined): ApprovalStatus {
  return status === "confirmed" ? "confirmed" : "draft";
}

/** Tooltip for an unconfirmed sale/launch; null when confirmed (no tooltip). */
export function approvalTooltip(status: string | null | undefined): string | null {
  return normalizeApproval(status) === "confirmed" ? null : "not confirmed yet";
}

export const APPROVAL_LABEL: Record<ApprovalStatus, string> = {
  draft: "Unconfirmed",
  confirmed: "Confirmed",
};

export const APPROVAL_COLOR: Record<ApprovalStatus, string> = {
  draft: "border border-dashed border-muted-foreground/40 bg-muted/40 text-muted-foreground",
  confirmed: "bg-green-500/10 text-green-400",
};

// ---------------------------------------------------------------------------
// Retail-holiday overlay — seeded, read-only planning context (NOT events:
// never editable, never feed the forecast; baseline seasonality already
// carries them). Pure UTC date math → YYYY-MM-DD day keys, so the computed
// day can't drift with the viewer's timezone.
// ---------------------------------------------------------------------------

function utcKey(dt: Date): string {
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const d = String(dt.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** The nth (1-based) given weekday (0=Sun…6=Sat) of a month (0-based). */
function nthWeekday(year: number, month0: number, weekday: number, n: number): Date {
  const first = new Date(Date.UTC(year, month0, 1));
  const offset = (weekday - first.getUTCDay() + 7) % 7;
  return new Date(Date.UTC(year, month0, 1 + offset + (n - 1) * 7));
}

/** The last given weekday (0=Sun…6=Sat) of a month (0-based). */
function lastWeekday(year: number, month0: number, weekday: number): Date {
  const last = new Date(Date.UTC(year, month0 + 1, 0)); // day 0 = last of month0
  const offset = (last.getUTCDay() - weekday + 7) % 7;
  return new Date(Date.UTC(year, month0, last.getUTCDate() - offset));
}

/** Shift a UTC date by whole days (UTC has no DST, so day math is exact). */
function addDaysUTC(dt: Date, days: number): Date {
  return new Date(dt.getTime() + days * 86_400_000);
}

export interface RetailHoliday {
  dayKey: string; // YYYY-MM-DD
  label: string;
}

/**
 * The retail holidays the marketing team plans around, for one calendar year,
 * in chronological order. Fixed dates + the floating US retail anchors
 * (Memorial/Labor Day, Father's Day, Thanksgiving → BFCM).
 */
export function retailHolidaysForYear(year: number): RetailHoliday[] {
  const thanksgiving = nthWeekday(year, 10, 4, 4); // 4th Thursday of November
  return [
    { dayKey: `${year}-02-14`, label: "Valentine's Day" },
    { dayKey: `${year}-04-20`, label: "4/20" },
    { dayKey: utcKey(lastWeekday(year, 4, 1)), label: "Memorial Day" },
    { dayKey: utcKey(nthWeekday(year, 5, 0, 3)), label: "Father's Day" },
    { dayKey: `${year}-07-04`, label: "Independence Day" },
    { dayKey: `${year}-07-11`, label: "Prime Day (approx.)" },
    { dayKey: utcKey(nthWeekday(year, 8, 1, 1)), label: "Labor Day" },
    { dayKey: `${year}-10-31`, label: "Halloween" },
    { dayKey: utcKey(thanksgiving), label: "Thanksgiving" },
    { dayKey: utcKey(addDaysUTC(thanksgiving, 1)), label: "Black Friday" },
    { dayKey: utcKey(addDaysUTC(thanksgiving, 4)), label: "Cyber Monday" },
    { dayKey: `${year}-12-25`, label: "Christmas" },
  ];
}

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
