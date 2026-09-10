/**
 * marketing-format — pure display helpers for the Marketing module.
 * No React, no Supabase. Keeps the composable-offer → human-text logic
 * in one tested place.
 */

/** Drop trailing zeros from a numeric value for display (20.00 → "20"). */
function trimNum(n: number): string {
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 });
}

// ---------------------------------------------------------------------------
// Offer formats — the six owner-approved shapes (2026-09-09). The stored
// mechanic columns are a projection of exactly one format; `format` is the
// discriminator, and inferOfferFormat() recovers it for legacy rows that
// predate the column.
// ---------------------------------------------------------------------------

export type OfferFormat = "percent" | "dollar" | "gift_min" | "gift_skus" | "gift_code" | "bxgy";

export const OFFER_FORMATS: readonly OfferFormat[] = [
  "percent",
  "dollar",
  "gift_min",
  "gift_skus",
  "gift_code",
  "bxgy",
];

export const OFFER_FORMAT_LABEL: Record<OfferFormat, string> = {
  percent: "Percent off",
  dollar: "Dollars off",
  gift_min: "Free item over $ minimum",
  gift_skus: "Free item with SKUs",
  gift_code: "Free item with code",
  bxgy: "Buy X get Y free",
};

export type OfferScope = "sitewide" | "category" | "sku_set";

export const SCOPE_LABEL: Record<OfferScope, string> = {
  sitewide: "Sitewide",
  category: "Category",
  sku_set: "Specific SKUs",
};

export function isOfferFormat(v: unknown): v is OfferFormat {
  return typeof v === "string" && (OFFER_FORMATS as readonly string[]).includes(v);
}

export function isOfferScope(v: unknown): v is OfferScope {
  return v === "sitewide" || v === "category" || v === "sku_set";
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
  /** Format discriminator; null on legacy rows (see inferOfferFormat). */
  format?: string | null;
  /** Dollars-off modifier: the discount applies once per order, not per unit. */
  once_per_order?: boolean | null;
}

const isTargeted = (scope: string) => scope === "category" || scope === "sku_set";

/**
 * Strict shape → format. Returns null when the mechanic columns do not
 * match exactly one of the six formats (e.g. the legacy trap
 * {sitewide, free_item, buy_qty 1, min_order 150}: gift_min forbids buy_qty
 * and gift_skus forbids sitewide + min_order).
 */
export function inferOfferFormat(o: OfferLike): OfferFormat | null {
  const pct = o.percent_off != null;
  const dol = o.dollar_off != null;
  const gift = !!o.free_item_sku_id;
  const min = o.min_order_amount != null;
  const buy = o.buy_qty != null;
  const get = o.get_qty != null;
  const code = !!(o.code && o.code.trim());
  const sitewide = o.scope === "sitewide";
  const targeted = isTargeted(o.scope);

  if (!sitewide && !targeted) return null;

  // percent: percent_off only; min-order only when sitewide.
  if (pct && !dol && !gift && !buy && !get && (!min || sitewide)) return "percent";
  // dollar: dollar_off only; min-order only when sitewide.
  if (dol && !pct && !gift && !buy && !get && (!min || sitewide)) return "dollar";
  // bxgy: buy + get, nothing else, targeted.
  if (buy && get && !gift && !pct && !dol && !min && targeted) return "bxgy";
  if (gift) {
    // gift_min: free item over a threshold, sitewide, no qualifier.
    if (min && sitewide && !pct && !dol && !buy) return "gift_min";
    // gift_skus: free item with qualifying items (buy_qty 1 = qualifier count).
    if (targeted && !min && !pct && !dol && o.buy_qty === 1) return "gift_skus";
    // gift_code: code-gated gift, optional single discount part, no qualifier.
    if (code && !min && !buy && !(pct && dol)) return "gift_code";
  }
  return null;
}

export interface DescribeOfferContext {
  freeItemName?: string | null;
  /** SKU codes of the offer's member set (for scope = sku_set). */
  skuCodes?: string[];
  /** Display name of the category (defaults to the stored category key). */
  categoryName?: string | null;
}

export interface OfferDescription {
  /** "15% off sitewide", "Free DNA Coil with BW20DNA", ... */
  deal: string;
  /** SCOPE_LABEL of the offer's scope. */
  target: string;
  /** "Code HOLIDAY" | "Automatic" */
  how: string;
  code: string | null;
}

/** Up to 3 SKU codes, then "+N". */
export function skuListText(codes: string[] | undefined, fallback = "select SKUs"): string {
  if (!codes || codes.length === 0) return fallback;
  const head = codes.slice(0, 3).join(", ");
  return codes.length > 3 ? `${head} +${codes.length - 3}` : head;
}

function scopeWord(o: OfferLike, ctx: DescribeOfferContext): string {
  if (o.scope === "sitewide") return "sitewide";
  if (o.scope === "category") return ctx.categoryName || o.category || "category";
  return skuListText(ctx.skuCodes);
}

function money(n: number): string {
  return `$${trimNum(n)}`;
}

function giftText(o: OfferLike, ctx: DescribeOfferContext): string {
  const qty = o.get_qty ?? 1;
  const name = ctx.freeItemName ?? "item";
  return `${qty > 1 ? `${qty}x ` : ""}Free ${name}`;
}

function overText(o: OfferLike): string {
  return o.scope === "sitewide" && o.min_order_amount != null
    ? ` on orders over ${money(o.min_order_amount)}`
    : "";
}

/**
 * Render an offer into the v2 sentence grammar. One function feeds both the
 * dialog's live strip and the sale-page row so they can never disagree.
 * The second argument accepts the legacy positional free-item name.
 */
export function describeOffer(
  o: OfferLike,
  ctxOrName?: DescribeOfferContext | string | null,
): OfferDescription {
  const ctx: DescribeOfferContext =
    typeof ctxOrName === "string" || ctxOrName == null ? { freeItemName: ctxOrName ?? null } : ctxOrName;
  const format: OfferFormat | null = isOfferFormat(o.format) ? o.format : inferOfferFormat(o);
  const target = isOfferScope(o.scope) ? SCOPE_LABEL[o.scope] : SCOPE_LABEL.sku_set;
  const where = scopeWord(o, ctx);
  const code = o.code && o.code.trim() ? o.code.trim() : null;

  let deal: string;
  switch (format) {
    case "percent":
      deal = `${trimNum(o.percent_off ?? 0)}% off ${where}${overText(o)}`;
      break;
    case "dollar": {
      const once = o.once_per_order && isTargeted(o.scope) ? ", once per order" : "";
      deal = `${money(o.dollar_off ?? 0)} off ${where}${once}${overText(o)}`;
      break;
    }
    case "gift_min":
      deal = `${giftText(o, ctx)} on orders over ${money(o.min_order_amount ?? 0)}`;
      break;
    case "gift_skus":
      deal = `${giftText(o, ctx)} with ${where}`;
      break;
    case "gift_code": {
      const discount =
        o.percent_off != null
          ? `${trimNum(o.percent_off)}% off ${where} + `
          : o.dollar_off != null
            ? `${money(o.dollar_off)} off ${where} + `
            : "";
      deal = `${discount}${giftText(o, ctx)}`;
      break;
    }
    case "bxgy":
      deal = `Buy ${o.buy_qty ?? 1} of ${where}, get ${o.get_qty ?? 1} free`;
      break;
    default:
      deal = legacyDeal(o, ctx);
  }
  deal = deal.charAt(0).toUpperCase() + deal.slice(1);

  return { deal, target, how: code ? `Code ${code}` : "Automatic", code };
}

/** Composable fallback for rows whose columns fit no single format. */
function legacyDeal(o: OfferLike, ctx: DescribeOfferContext): string {
  const parts: string[] = [];
  if (o.percent_off != null) parts.push(`${trimNum(o.percent_off)}% off`);
  if (o.dollar_off != null) parts.push(`${money(o.dollar_off)} off`);
  if (o.buy_qty != null && o.get_qty != null && !o.free_item_sku_id) {
    parts.push(`buy ${o.buy_qty} get ${o.get_qty}`);
  }
  if (o.free_item_sku_id) {
    const qty = o.get_qty ?? 1;
    parts.push(`${qty > 1 ? `${qty}x ` : ""}free ${ctx.freeItemName ?? "item"}`);
  }
  let deal = parts.join(" + ") || "Offer";
  if (o.min_order_amount != null) deal += ` on orders over ${money(o.min_order_amount)}`;
  return deal;
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
