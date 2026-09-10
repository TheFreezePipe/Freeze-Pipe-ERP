/**
 * offer-forecast — pure logic for the format-first Add-offer dialog and its
 * Forecast box. No React, no Supabase.
 *
 *   OfferDraft            — the dialog's string-typed form state
 *   validateOffer         — per-format required fields + ranges
 *   buildOfferColumns     — draft -> mkt_offers mechanic columns (every column
 *                           the format does not own is written NULL)
 *   draftFromOffer        — mkt_offers row -> draft (infers legacy formats)
 *   OfferForecastDefaults — the rpc_offer_forecast_defaults jsonb shape
 *   buildForecastColumns  — RPC result + planner edits -> forecast columns
 */
import type { Json } from "@/lib/database.types";
import {
  inferOfferFormat,
  isOfferFormat,
  isOfferScope,
  type OfferFormat,
  type OfferLike,
  type OfferScope,
} from "@/lib/marketing-format";

export type Scope = OfferScope;

/** Allowed scopes per format, first = default when the format is picked. */
export const FORMAT_SCOPES: Record<OfferFormat, Scope[]> = {
  percent: ["sitewide", "category", "sku_set"],
  dollar: ["sku_set", "category", "sitewide"],
  gift_min: ["sitewide"],
  gift_skus: ["sku_set", "category"],
  gift_code: ["sitewide", "category", "sku_set"],
  bxgy: ["sku_set", "category"],
};

export type DiscountKind = "none" | "percent" | "dollar";

export interface OfferDraft {
  format: OfferFormat | null;
  scope: Scope;
  category: string;
  skuIds: string[];
  percentOff: string;
  dollarOff: string;
  oncePerOrder: boolean;
  minOrder: string;
  freeItemSkuId: string | null;
  getQty: string;
  buyQty: string;
  /** gift_code only: which discount part (if any) rides with the gift. */
  discountKind: DiscountKind;
  code: string;
  label: string;
}

/** The mechanic fields the forecast RPC needs (no code / label / discountKind). */
export type OfferMechanics = Omit<OfferDraft, "code" | "label" | "discountKind" | "oncePerOrder">;

export const EMPTY_OFFER_DRAFT: OfferDraft = {
  format: null,
  scope: "sitewide",
  category: "",
  skuIds: [],
  percentOff: "",
  dollarOff: "",
  oncePerOrder: false,
  minOrder: "",
  freeItemSkuId: null,
  getQty: "1",
  buyQty: "1",
  discountKind: "none",
  code: "",
  label: "",
};

/** The scope a draft should take when switching to `format`; keeps the current one when allowed. */
export function defaultScopeFor(format: OfferFormat, current?: Scope | null): Scope {
  const allowed = FORMAT_SCOPES[format];
  return current && allowed.includes(current) ? current : allowed[0];
}

// ---------------------------------------------------------------------------
// Parsing helpers (form strings -> numbers)
// ---------------------------------------------------------------------------

export function numOrNull(s: string | null | undefined): number | null {
  if (s == null) return null;
  const t = s.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export function intOrNull(s: string | null | undefined): number | null {
  const n = numOrNull(s);
  return n != null && Number.isInteger(n) ? n : null;
}

function isPercent(s: string): boolean {
  const n = numOrNull(s);
  return n != null && n >= 1 && n <= 100;
}
function isPositive(s: string): boolean {
  const n = numOrNull(s);
  return n != null && n > 0;
}
function isQty(s: string): boolean {
  const n = intOrNull(s);
  return n != null && n >= 1;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface OfferValidation {
  ok: boolean;
  /** OfferDraft field names that are missing or out of range. */
  missing: string[];
}

function validateScope(d: OfferMechanics, format: OfferFormat, missing: string[]) {
  if (!FORMAT_SCOPES[format].includes(d.scope)) missing.push("scope");
  else if (d.scope === "category" && !d.category.trim()) missing.push("category");
  else if (d.scope === "sku_set" && d.skuIds.length === 0) missing.push("skuIds");
}

/** Validate the mechanic fields only (what the forecast RPC needs). */
export function validateOfferMechanics(d: OfferMechanics, discountKind?: DiscountKind): OfferValidation {
  const missing: string[] = [];
  if (!d.format) return { ok: false, missing: ["format"] };
  const format = d.format;

  switch (format) {
    case "percent":
      if (!isPercent(d.percentOff)) missing.push("percentOff");
      validateScope(d, format, missing);
      if (d.scope === "sitewide" && d.minOrder.trim() && !isPositive(d.minOrder)) missing.push("minOrder");
      break;
    case "dollar":
      if (!isPositive(d.dollarOff)) missing.push("dollarOff");
      validateScope(d, format, missing);
      if (d.scope === "sitewide" && d.minOrder.trim() && !isPositive(d.minOrder)) missing.push("minOrder");
      break;
    case "gift_min":
      if (!d.freeItemSkuId) missing.push("freeItemSkuId");
      if (!isQty(d.getQty)) missing.push("getQty");
      if (!isPositive(d.minOrder)) missing.push("minOrder");
      break;
    case "gift_skus":
      if (!d.freeItemSkuId) missing.push("freeItemSkuId");
      if (!isQty(d.getQty)) missing.push("getQty");
      validateScope(d, format, missing);
      break;
    case "gift_code": {
      if (!d.freeItemSkuId) missing.push("freeItemSkuId");
      if (!isQty(d.getQty)) missing.push("getQty");
      // With an explicit discountKind that part is required; without one
      // (RPC gating) whichever part is present must be valid, never both.
      const kind: DiscountKind =
        discountKind ?? (d.percentOff.trim() ? "percent" : d.dollarOff.trim() ? "dollar" : "none");
      if (kind === "percent" && !isPercent(d.percentOff)) missing.push("percentOff");
      if (kind === "dollar" && !isPositive(d.dollarOff)) missing.push("dollarOff");
      if (discountKind == null && d.percentOff.trim() && d.dollarOff.trim()) missing.push("dollarOff");
      if (kind !== "none") validateScope(d, format, missing);
      break;
    }
    case "bxgy":
      if (!isQty(d.buyQty)) missing.push("buyQty");
      if (!isQty(d.getQty)) missing.push("getQty");
      validateScope(d, format, missing);
      break;
  }
  return { ok: missing.length === 0, missing };
}

/** Full-draft validation for Save: mechanics + code (gift_code) + label. */
export function validateOffer(d: OfferDraft): OfferValidation {
  const base = validateOfferMechanics(d, d.format === "gift_code" ? d.discountKind : undefined);
  const missing = [...base.missing];
  if (d.format === "gift_code" && !d.code.trim()) missing.push("code");
  if (!d.label.trim()) missing.push("label");
  return { ok: missing.length === 0, missing };
}

// ---------------------------------------------------------------------------
// Draft <-> mkt_offers columns
// ---------------------------------------------------------------------------

export interface OfferMechanicColumns {
  format: OfferFormat | null;
  scope: Scope;
  category: string | null;
  code: string | null;
  percent_off: number | null;
  dollar_off: number | null;
  free_item_sku_id: string | null;
  min_order_amount: number | null;
  buy_qty: number | null;
  get_qty: number | null;
  once_per_order: boolean;
}

const NULL_MECHANICS: Omit<OfferMechanicColumns, "format" | "scope" | "category" | "code"> = {
  percent_off: null,
  dollar_off: null,
  free_item_sku_id: null,
  min_order_amount: null,
  buy_qty: null,
  get_qty: null,
  once_per_order: false,
};

/**
 * Project a draft onto the mkt_offers mechanic columns. Every column the
 * format does not own is NULL (once_per_order false), so a row can never
 * carry stale values from a previous format.
 */
export function buildOfferColumns(d: OfferDraft): OfferMechanicColumns {
  const format = d.format;
  const scope: Scope = format ? defaultScopeFor(format, d.scope) : d.scope;
  const code = d.code.trim() || null;
  const base: OfferMechanicColumns = {
    ...NULL_MECHANICS,
    format,
    scope,
    category: scope === "category" ? d.category.trim() || null : null,
    code,
  };
  if (!format) return base;

  const sitewideMin = scope === "sitewide" ? numOrNull(d.minOrder) : null;
  const getQty = intOrNull(d.getQty) ?? 1;

  switch (format) {
    case "percent":
      return { ...base, percent_off: numOrNull(d.percentOff), min_order_amount: sitewideMin };
    case "dollar":
      return {
        ...base,
        dollar_off: numOrNull(d.dollarOff),
        once_per_order: scope !== "sitewide" && d.oncePerOrder,
        min_order_amount: sitewideMin,
      };
    case "gift_min":
      return {
        ...base,
        scope: "sitewide",
        category: null,
        free_item_sku_id: d.freeItemSkuId,
        get_qty: getQty,
        min_order_amount: numOrNull(d.minOrder),
      };
    case "gift_skus":
      return { ...base, free_item_sku_id: d.freeItemSkuId, get_qty: getQty, buy_qty: 1 };
    case "gift_code": {
      const kind = d.discountKind;
      const s: Scope = kind === "none" ? "sitewide" : scope;
      return {
        ...base,
        scope: s,
        category: s === "category" ? base.category : null,
        free_item_sku_id: d.freeItemSkuId,
        get_qty: getQty,
        percent_off: kind === "percent" ? numOrNull(d.percentOff) : null,
        dollar_off: kind === "dollar" ? numOrNull(d.dollarOff) : null,
      };
    }
    case "bxgy":
      return { ...base, buy_qty: intOrNull(d.buyQty), get_qty: intOrNull(d.getQty) };
  }
}

export type OfferRowLike = OfferLike & {
  label?: string | null;
  offer_skus?: { sku_id: string }[] | null;
};

const str = (n: number | null | undefined): string => (n == null ? "" : String(n));

/** Hydrate a draft from a stored row, inferring the format for legacy rows. */
export function draftFromOffer(row: OfferRowLike, skuIds?: string[]): OfferDraft {
  const format: OfferFormat | null = isOfferFormat(row.format) ? row.format : inferOfferFormat(row);
  const storedScope: Scope = isOfferScope(row.scope) ? row.scope : "sitewide";
  const scope: Scope = format ? defaultScopeFor(format, storedScope) : storedScope;
  const discountKind: DiscountKind =
    row.percent_off != null ? "percent" : row.dollar_off != null ? "dollar" : "none";
  return {
    format,
    scope,
    category: row.category ?? "",
    skuIds: skuIds ?? (row.offer_skus ?? []).map((s) => s.sku_id),
    percentOff: str(row.percent_off),
    dollarOff: str(row.dollar_off),
    oncePerOrder: !!row.once_per_order,
    minOrder: str(row.min_order_amount),
    freeItemSkuId: row.free_item_sku_id ?? null,
    getQty: row.get_qty != null ? String(row.get_qty) : "1",
    buyQty: row.buy_qty != null ? String(row.buy_qty) : "1",
    discountKind,
    code: row.code ?? "",
    label: row.label ?? "",
  };
}

// ---------------------------------------------------------------------------
// Forecast defaults (rpc_offer_forecast_defaults) + planner edits
// ---------------------------------------------------------------------------

export type LiftSource = "measured" | "seeded" | "default" | "last_year";
export type OrdersSource = "derived" | "last_year";
export type AttachSource = "measured" | "default";
export type DepthBand = "low" | "mid" | "high";
export type ScopeClass = "sitewide" | "targeted";
export type Season = "holiday" | "other";

export interface OfferForecastCell {
  format: OfferFormat;
  /** null when depth could not be computed (no retail price / no SKUs). */
  depth_band: DepthBand | null;
  scope_class: ScopeClass;
  season: Season;
}

/** EXACT jsonb shape returned by rpc_offer_forecast_defaults. */
export interface OfferForecastDefaults {
  lift_pct: number | null;
  lift_source: LiftSource;
  lift_n: number | null;
  depth_pct: number | null;
  orders: number | null;
  orders_source: OrdersSource | null;
  attach_pct: number | null;
  attach_source: AttachSource | null;
  gift_units: number | null;
  after_ratio: number | null;
  after_n: number | null;
  holiday: boolean;
  cell: OfferForecastCell;
}

/** Planner overrides as typed in the Forecast box (blank = use derived). */
export interface ForecastEdits {
  lift: string;
  orders: string;
  giftUnits: string;
}

export const EMPTY_FORECAST_EDITS: ForecastEdits = { lift: "", orders: "", giftUnits: "" };

export interface OfferForecastColumns {
  derived_lift_pct: number | null;
  derived_orders: number | null;
  derived_attach_pct: number | null;
  derived_gift_units: number | null;
  defaults_source: Json | null;
  expected_uplift_pct: number | null;
  expected_orders: number | null;
  planner_gift_units: number | null;
  effective_discount_pct: number | null;
  derived_at: string | null;
}

/** round(orders x attach/100 x qty); null when any input is missing. */
export function giftUnits(
  orders: number | null | undefined,
  attachPct: number | null | undefined,
  qty: number | null | undefined,
): number | null {
  if (orders == null || attachPct == null || qty == null) return null;
  return Math.round((orders * attachPct * qty) / 100);
}

/**
 * The columns written on every save. Planner-first (owner decision
 * 2026-09-10, SAP/Dynamics style): the planner TYPES lift and, for gift
 * formats, orders; the history estimate is stored beside them as derived_*
 * for scoring but never stands in for a number nobody entered. Gift units
 * = the planner's orders x attach x qty unless the planner typed a cap.
 * effective_discount_pct = computed depth.
 */
export function buildForecastColumns(
  defaults: OfferForecastDefaults | null,
  edits: ForecastEdits,
  format: OfferFormat | null,
  getQty: number = 1,
  now: Date = new Date(),
): OfferForecastColumns {
  const { lift, orders, gift } = cleanEdits(edits, format);
  const computedGift = isGiftFormat(format) ? giftUnits(orders, defaults?.attach_pct, getQty) : null;
  return {
    derived_lift_pct: defaults?.lift_pct ?? null,
    derived_orders: defaults?.orders ?? null,
    derived_attach_pct: defaults?.attach_pct ?? null,
    derived_gift_units: defaults?.gift_units ?? null,
    defaults_source: defaults ? (defaults as unknown as Json) : null,
    expected_uplift_pct: lift,
    expected_orders: orders,
    planner_gift_units: gift ?? computedGift,
    effective_discount_pct: defaults?.depth_pct ?? null,
    derived_at: defaults ? now.toISOString() : null,
  };
}

/**
 * Planner-entered forecast inputs are REQUIRED: lift on every format,
 * orders on gift formats; a typed gift-units cap must be a whole number
 * >= 0. (The estimate beside the field is a reference, not a default.)
 */
export function validateForecastEdits(edits: ForecastEdits, format: OfferFormat | null): OfferValidation {
  const missing: string[] = [];
  if (!format) return { ok: false, missing: ["format"] };
  const lift = numOrNull(edits.lift);
  if (lift == null || lift < -100) missing.push("lift");
  if (isGiftFormat(format)) {
    const orders = intOrNull(edits.orders);
    if (orders == null || orders < 1) missing.push("orders");
    if (edits.giftUnits.trim()) {
      const g = intOrNull(edits.giftUnits);
      if (g == null || g < 0) missing.push("giftUnits");
    }
  }
  return { ok: missing.length === 0, missing };
}

/** True for the four formats whose Forecast box shows the Orders x Attach row. */
export function isGiftFormat(format: OfferFormat | null): boolean {
  return format === "gift_min" || format === "gift_skus" || format === "gift_code" || format === "bxgy";
}

/**
 * Planner edits as numbers, with out-of-range or out-of-format values
 * treated as unset: orders must be >= 1 (mkt_offers_expected_orders_check),
 * gift units >= 0, lift >= -100; orders / gift only on gift formats.
 */
export function cleanEdits(
  edits: ForecastEdits,
  format: OfferFormat | null,
): { lift: number | null; orders: number | null; gift: number | null } {
  const liftRaw = numOrNull(edits.lift);
  const ordersRaw = intOrNull(edits.orders);
  const giftRaw = intOrNull(edits.giftUnits);
  const giftFmt = isGiftFormat(format);
  return {
    lift: liftRaw != null && liftRaw >= -100 ? liftRaw : null,
    orders: giftFmt && ordersRaw != null && ordersRaw >= 1 ? ordersRaw : null,
    gift: giftFmt && giftRaw != null && giftRaw >= 0 ? giftRaw : null,
  };
}

/**
 * The values the Forecast box displays. Lift and orders are the planner's
 * typed numbers only (null until typed; the estimate is shown beside them,
 * never in them). Gift units = typed cap, else orders x attach x qty.
 */
export interface ForecastView {
  lift: number | null;
  liftSet: boolean;
  orders: number | null;
  ordersSet: boolean;
  giftUnits: number | null;
  giftUnitsSet: boolean;
}

export function forecastView(
  defaults: OfferForecastDefaults | null,
  edits: ForecastEdits,
  getQty: number,
  format: OfferFormat | null = "gift_min",
): ForecastView {
  const { lift, orders, gift } = cleanEdits(edits, format);
  const computedGift = giftUnits(orders, defaults?.attach_pct, getQty);
  return {
    lift,
    liftSet: lift != null,
    orders,
    ordersSet: orders != null,
    giftUnits: gift ?? computedGift,
    giftUnitsSet: gift != null,
  };
}
