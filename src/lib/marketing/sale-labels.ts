/**
 * Sale dashboards — every word on screen, in one place.
 *
 * Tones: g = good, r = bad, k = neutral, a = attention, b = planned,
 * v = early access. Marks: ring (not started), half (in progress),
 * disc (done), tri (attention), diamond (bad).
 */

export type Tone = "g" | "r" | "k" | "a" | "b" | "v";
export type Mark = "ring" | "half" | "disc" | "tri" | "diamond";
export type ChipDef = readonly [label: string, tone: Tone, mark: Mark | null];

export type SalePhaseKey = "upcoming" | "early_access" | "live" | "ended" | "final";
export type PaceKey = "reading" | "ahead" | "on_pace" | "behind" | "ea" | "upcoming";
export type PlanResultKey = "beat" | "met" | "missed";
export type LiftBandKey = "noise" | "likely_up" | "likely_down" | "clearly_up" | "clearly_down";
export type MechanismKey = "both" | "acquired" | "upsold" | "neither";
export type RunwayKey = "sellable0" | "runs_out" | "lasts" | "ran_out" | "lasted" | "plan" | "short";
export type OfferStatusKey = "missing_code" | "scheduled" | "early_access" | "active" | "expired";
export type SendStatusKey = "scheduled" | "sending" | "open" | "closes" | "closed";
export type QualityKey = "estimated" | "modeled" | "provisional" | "partial" | "actual" | "final";
export type ViewKey = "units" | "orders" | "paid" | "cum";
export type CompareKey = "baseline" | "plan" | "none";
export type RangeKey = "ea" | "main" | "sale" | "sale_after" | "full";
export type CodeKind = "sale" | "other_sale" | "everyday" | "operational" | "other";

export const PHASE: Record<SalePhaseKey, ChipDef> = {
  upcoming: ["Upcoming", "b", "ring"],
  early_access: ["Early access", "v", "half"],
  live: ["Live", "g", "half"],
  ended: ["Ended", "k", "disc"],
  final: ["Ended", "k", "disc"],
};

export const RESULT: Record<"provisional" | "final", ChipDef> = {
  provisional: ["Provisional", "k", "half"],
  final: ["Final", "k", "disc"],
};

export const PACE: Record<PaceKey, ChipDef> = {
  reading: ["Reading", "k", "ring"],
  ahead: ["Ahead", "g", "disc"],
  on_pace: ["On pace", "g", "disc"],
  behind: ["Behind", "r", "diamond"],
  ea: ["EA · vs baseline", "v", "half"],
  upcoming: ["Plan", "b", "ring"],
};

export const PLAN_RESULT: Record<PlanResultKey, ChipDef> = {
  beat: ["Beat", "g", "disc"],
  met: ["Met", "g", "disc"],
  missed: ["Missed", "r", "diamond"],
};

export const LIFT: Record<LiftBandKey, string> = {
  noise: "Within noise",
  likely_up: "Likely up",
  likely_down: "Likely down",
  clearly_up: "Clearly up",
  clearly_down: "Clearly down",
};

export const MECH: Record<MechanismKey, string> = {
  both: "Acquired and upsold",
  acquired: "Acquired, not upsold",
  upsold: "Upsold",
  neither: "Neither",
};

export const RUNWAY: Record<RunwayKey, ChipDef> = {
  sellable0: ["Sellable 0", "a", "tri"],
  runs_out: ["Runs out", "r", "diamond"],
  lasts: ["Lasts", "g", "disc"],
  ran_out: ["Ran out", "a", "tri"],
  lasted: ["Lasted", "g", "disc"],
  plan: ["Covers plan", "g", "disc"],
  short: ["Short of plan", "a", "tri"],
};

export const OFFER_STATUS: Record<OfferStatusKey, ChipDef> = {
  missing_code: ["Missing code", "a", "tri"],
  scheduled: ["Scheduled", "b", "ring"],
  early_access: ["Early access", "v", "half"],
  active: ["Active", "g", "half"],
  expired: ["Expired", "k", "disc"],
};

export const SEND_STATUS: Record<SendStatusKey, ChipDef> = {
  scheduled: ["Scheduled", "k", "ring"],
  sending: ["Sending", "g", "half"],
  open: ["Open", "g", "half"],
  closes: ["Closes", "g", "half"],
  closed: ["Closed", "k", "disc"],
};

export const QUALITY: Record<QualityKey, string> = {
  estimated: "Estimated",
  modeled: "Modeled",
  provisional: "Provisional",
  partial: "Partial",
  actual: "Actual",
  final: "Final",
};

export const VIEW: Record<ViewKey, string> = { units: "units", orders: "orders", paid: "paid", cum: "cumulative orders" };
export const COMPARE: Record<CompareKey, string> = { baseline: "baseline", plan: "plan", none: "" };
export const RANGE: Record<RangeKey, string> = {
  ea: "Early access",
  main: "Public",
  sale: "Sale",
  sale_after: "Sale + After 14",
  full: "Full window",
};

export const CODE_KIND: Record<CodeKind, string> = {
  sale: "This sale",
  other_sale: "Other sale",
  everyday: "Everyday",
  operational: "Operational",
  other: "Other",
};

/** Jump menu / hotkeys, in page order. */
export const MODULES: ReadonlyArray<readonly [id: string, label: string, key: string]> = [
  ["scorecard", "Scorecard", "s"],
  ["offers", "Offers", "o"],
  ["daily", "Daily", "d"],
  ["products", "Products", "p"],
  ["margin", "Margin", "m"],
  ["customers", "Customers", "c"],
  ["sends", "Sends", "n"],
  ["recorded", "Recorded", "r"],
];

export const COLUMN_DEF: Record<string, string> = {
  Orders: "Distinct ShipStation orders on the day (Eastern time), shipped or awaiting shipment. Reference token per Compare.",
  Units: "Units on ShipStation order lines with a catalog SKU.",
  "Paid $": "Net sales. No revenue source yet; pending.",
  "AOV $": "Paid ÷ orders. Pending a revenue source.",
  "New %": "Orders from an email with no earlier order ÷ orders. Order history starts May 2026, so some repeat buyers read as new.",
  "Δ Base": "Actual ÷ baseline − 1. Coloured when |z| ≥ 2, z = (a − b) ÷ √b.",
  "Δ Plan": "Actual ÷ plan − 1. Coloured outside ±10%.",
  Reference: "Plan and baseline for the same days. Projection = mean of the last 3 complete public days × days left, after the first full public day.",
  "Promoted units": "Units of the offer's member SKUs · baseline for the same days.",
  Containing: "Orders with at least one member SKU. Repeats an order under every offer it touches; never summed.",
  Redemptions: "Orders where the code appears on the ShipStation order (discount line).",
  "Discount $": "Discount dollars on the code, from the ShipStation discount lines.",
  Share: "Share of gross incremental units: max(0, units − base) ÷ Σ over promoted and gift SKUs.",
  "Rate/d": "Units per day, last 3 days · clean-day base.",
  "Runs out": "Finished ÷ sale rate, as a date.",
  Recipients: "Recipients entered for the send.",
  "RPR $": "Attributed revenue ÷ recipients (entered; Klaviyo 5-day Placed Order).",
};
