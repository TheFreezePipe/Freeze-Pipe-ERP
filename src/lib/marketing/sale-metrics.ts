/**
 * Sale dashboards — the one metrics computation.
 *
 * Input: the JSON document from rpc_sale_metrics (raw counts by day, the
 * frozen clean-day baseline, offers, SKUs, broadcasts). Output: SaleMetrics,
 * the single shape every module on the sale page reads. Nothing in a
 * component computes; everything is judged here, so the same function runs
 * on fixtures in tests.
 *
 * Phase only changes the fill: upcoming sales carry plans and no actuals,
 * live sales carry a partial last day scaled by the clean-day hour share,
 * ended sales carry the 14-day after-window as it closes.
 *
 * Revenue has no source yet (ShipStation is orders, units and codes only), so
 * every money figure that needs net sales is null or modeled at list price
 * and labelled so.
 */

import { F, addDays, daysBetween, dow, sum } from "./sale-format";
import {
  LIFT,
  type CodeKind,
  type LiftBandKey,
  type MechanismKey,
  type OfferStatusKey,
  type PaceKey,
  type PlanResultKey,
  type QualityKey,
  type RunwayKey,
  type SalePhaseKey,
  type SendStatusKey,
} from "./sale-labels";

// ---------------------------------------------------------------- input (rpc_sale_metrics)

export interface SaleInputDay {
  k: string;
  orders: number;
  awaiting: number;
  new: number;
  units: number;
  disc: Record<CodeKind, number>; // cents
  sale_code_orders: number;
}

export interface SaleInputOffer {
  id: string;
  label: string;
  format: string | null;
  code: string | null;
  scope: string | null;
  category: string | null;
  percent_off: number | null;
  dollar_off: number | null;
  min_order_amount: number | null;
  buy_qty: number | null;
  get_qty: number | null;
  once_per_order: boolean | null;
  expected_orders: number | null;
  expected_uplift_pct: number | null;
  planner_gift_units: number | null;
  derived_gift_units: number | null;
  gift_sku_id: string | null;
  gift_sku: string | null;
  member_sku_ids: string[];
  containing: number;
  qualifying_with_gift: number;
  gift_without_qualifying: number;
  redemptions: number | null;
  discount_cents: number | null;
  code_last_seen: string | null;
}

export interface SaleInputSku {
  sku_id: string;
  sku: string;
  name: string;
  category: string | null;
  retail: number | null;
  active: boolean;
  role: "member" | "gift" | null;
  units_sale: number;
  units_pre: number;
  units_post: number;
  daily: Array<[string, number]>;
  rate3: number;
  base_rate: number;
  finished: number;
  raw: number;
  prefilled_raw: number;
}

export interface SaleInputBroadcast {
  id: string;
  channel: string | null;
  name: string;
  scheduled_at: string | null;
  sent_at: string | null;
  audience_size: number | null;
  recipients: number | null;
  opens: number | null;
  clicks: number | null;
  revenue: number | null;
  metrics: Record<string, unknown> | null;
  source: string | null;
  updated_at: string | null;
}

export interface SaleInputPriorRun {
  name: string;
  d1: string;
  d2: string;
  format: string | null;
  depth_pct: number | null;
  depth_band: string | null;
  scope_class: string | null;
  holiday: boolean | null;
  orders: number | null;
  units: number | null;
  lift_pct: number | null;
  orders_lift_pct: number | null;
  post14_ratio: number | null;
  attach_pct: number | null;
  phase: string | null;
  source: string | null;
}

export interface SaleInput {
  sale: {
    id: string;
    name: string;
    notes: string | null;
    d1: string;
    start: string;
    end: string;
    ea: string | null;
    plan_orders: number | null;
    plan_source: "planner" | "derived" | null;
    season_index: number;
    cm_pct: number;
    finalized_at: string | null;
    approval_status: string | null;
    has_gift: boolean;
    final_on: string;
  };
  stores: Array<{ store_id: number; name: string }>;
  as_of: string;
  as_of_day: string;
  as_of_hour: number;
  synced_at: string | null;
  last_run: { run_type: string; started_at: string; completed_at: string | null; status: string; error: string | null } | null;
  unresolved_orders: number;
  baseline: {
    d1: string;
    frozen: boolean;
    computed_at: string;
    window_from: string;
    window_to: string;
    clean_days: string[];
    n_clean: number;
    short: boolean;
    orders_day: number;
    units_day: number;
    dow_orders: number[];
    dow_units: number[];
    hour_share: number[];
    new_share: number | null;
    everyday_disc_cents_per_order: number | null;
    store_ids: number[];
  };
  days: SaleInputDay[];
  hours_today: number[];
  codes: Array<{ code: string; kind: CodeKind; orders: number; cents: number }>;
  offers: SaleInputOffer[];
  skus: SaleInputSku[];
  broadcasts: SaleInputBroadcast[];
  prior_runs: SaleInputPriorRun[];
  sources: { orders: string; units: string; discounts: string | null; revenue: string | null; sends: string; sessions: string | null };
}

// ---------------------------------------------------------------- output (SaleMetrics)

export interface Judged {
  value: number | null;
  ref: number | null;
  delta: number | null;
  z: number | null;
  tone: "g" | "r" | "k";
  unit: "pct" | "pts";
  small: boolean;
}

export type DayPhase = "pre" | "ea" | "main" | "post";

export interface SaleDay {
  k: string;
  phase: DayPhase;
  quality: "future" | "partial" | "actual";
  partial: boolean;
  future: boolean;
  orders: number | null;
  awaiting: number;
  units: number | null;
  net: number | null;
  new: number | null;
  saleDisc: number | null; // $ on this sale's codes
  codeOrders: number | null;
  base: { orders: number; units: number; unitsFull: number };
  plan: { orders: number; units: number };
  sends: SaleSend[];
}

export interface SaleGroup {
  rows: SaleDay[];
  done: number;
  total: number;
  closed: number;
  A: { orders: number; units: number; new: number; saleDisc: number; codeOrders: number };
  B: { orders: number; units: number };
  P: { orders: number; units: number };
  PtD: { orders: number; units: number };
  lift: { orders: Judged; units: Judged };
}

export interface ScorecardRow {
  key: "margin" | "orders" | "units" | "paid" | "new";
  label: string;
  actual: number | null;
  projected: number | null;
  plan: number | null;
  planToDate: number | null;
  base: Judged;
  planD: Judged;
  quality: QualityKey;
  note: string[];
  money: boolean;
  pending: boolean;
}

export type StructureFact = readonly [label: string, value: string];

export interface SaleOffer {
  id: string;
  label: string;
  kind: string;
  format: string | null;
  code: string | null;
  status: OfferStatusKey;
  unitsA: number | null;
  unitsB: number | null;
  units: Judged;
  containing: number | null;
  redemptions: number | null;
  discount: number | null; // $
  structure: StructureFact[];
  skuIds: string[];
  giftSkuId: string | null;
}

export interface SaleProduct {
  skuId: string;
  sku: string;
  name: string;
  role: "member" | "gift" | "other";
  units: number;
  base: number;
  judged: Judged;
  share: number;
  finished: number;
  raw: number;
  rate: number;
  baseRate: number;
  planRate: number;
  runsOut: string | null;
  runway: RunwayKey;
  daysLeft: number | null;
  daily: Array<[string, number]>;
  retail: number | null;
}

export interface SaleSend {
  id: string;
  dayKey: string | null;
  time: string;
  campaign: string;
  channel: string;
  status: SendStatusKey;
  windowLabel: string;
  recipients: number | null;
  open: number | null;
  click: number | null;
  orders: number | null;
  revenue: number | null;
  rpr: number | null;
  closes: string | null;
}

export interface SaleAlert {
  tone: "a" | "k" | "r";
  code: string;
  title: string;
  detail: string;
  source: string;
}

export interface SaleMetrics {
  input: SaleInput;
  phase: SalePhaseKey;
  live: boolean;
  upcoming: boolean;
  asOf: string | null;
  asOfTime: string;
  syncedAt: string | null;
  h: number;
  season: number;
  base: {
    ordersDay: number;
    unitsDay: number;
    newShare: number | null;
    days: number;
    from: string | null;
    to: string | null;
    short: boolean;
    frozen: boolean;
    discPerOrder: number | null;
  };
  days: SaleDay[];
  G: Record<DayPhase | "full", SaleGroup>;
  planOrders: number;
  planUnits: number;
  planSource: "planner" | "derived";
  uplift: number;
  projected: number | null;
  scorecard: Record<ScorecardRow["key"], ScorecardRow>;
  status: {
    pace: PaceKey | null;
    planResult: PlanResultKey | null;
    liftBand: string | null;
    mechanism: MechanismKey | null;
    cannib: string | null;
    result: "provisional" | "final" | null;
  };
  margin: {
    incremental: number;
    giveaway: number;
    giftCost: number;
    dipMargin: number | null;
    net: number;
    promoCost: number;
    roi: number | null;
    perOrder: number | null;
    perNew: number | null;
    discOnInc: number;
    quality: QualityKey;
    priceBasis: "modeled" | "actual";
    incUnits: number;
    incOrders: number;
    dip: number;
    post14: number | null;
    netInc: number;
    saleDisc: number;
    baseShare: number;
    avgList: number;
    discRate: number;
    giftUnits: number;
    cm: number;
  };
  offers: SaleOffer[];
  products: SaleProduct[];
  other: { n: number; units: number; base: number; judged: Judged; share: number } | null;
  sends: SaleSend[];
  attributed: { orders: number; revenue: number };
  sendsEnteredAt: string | null;
  customers: {
    new: number;
    newShare: number;
    returning: number;
    retShare: number;
    ea: number;
    eaShare: number;
    eaNew: number | null;
    aov: number | null;
    ordersDay: number;
    incNew: number;
  } | null;
  codes: Array<{ code: string; kind: CodeKind; orders: number; dollars: number }>;
  alerts: SaleAlert[];
  recorded: { finalizedAt: string | null; finalOn: string; priors: number; planLift: number | null; publicLift: number | null };
  lastRun: { name: string; liftUnits: number | null; comparable: boolean; note: string } | null;
  unresolved: number;
}

// ---------------------------------------------------------------- judgement

const zOf = (a: number, b: number): number => (b > 0 ? (a - b) / Math.sqrt(b) : 0);

export function bandWord(z: number | null): string {
  if (z == null) return LIFT.noise;
  const a = Math.abs(z);
  const key: LiftBandKey = a < 2 ? "noise" : a < 3 ? (z > 0 ? "likely_up" : "likely_down") : z > 0 ? "clearly_up" : "clearly_down";
  return LIFT[key];
}

export interface JudgeOptions {
  unit?: "pct" | "pts";
  mode?: "z" | "band";
  band?: number;
  increaseGood?: boolean;
}

/** Actual vs reference. z-gated colour by default (Poisson), ±band for plans. */
export function judge(value: number | null | undefined, ref: number | null | undefined, o: JudgeOptions = {}): Judged {
  const unit = o.unit ?? "pct";
  if (value == null || ref == null || ref <= 0) {
    return { value: value ?? null, ref: ref ?? null, delta: null, z: null, tone: "k", unit, small: unit === "pct" && ref != null && ref > 0 && ref < 20 };
  }
  const delta = unit === "pts" ? value - ref : value / ref - 1;
  const z = zOf(value, ref);
  let good: boolean | null = null;
  if (o.mode === "band") {
    const b = o.band ?? 0.1;
    if (delta >= b) good = true;
    else if (delta <= -b) good = false;
  } else if (z >= 2) good = true;
  else if (z <= -2) good = false;
  if (good != null && o.increaseGood === false) good = !good;
  return { value, ref, delta, z, tone: good == null ? "k" : good ? "g" : "r", unit, small: unit === "pct" && ref < 20 };
}

const none = (): Judged => judge(null, null);

// ---------------------------------------------------------------- helpers

const cents = (c: number | null | undefined): number => (c == null ? 0 : c / 100);

function sendStatus(sentAt: string | null, asOf: Date): { status: SendStatusKey; closes: string | null } {
  if (!sentAt) return { status: "scheduled", closes: null };
  const sent = new Date(sentAt);
  const closes = new Date(sent.getTime() + 5 * 864e5);
  if (asOf.getTime() < sent.getTime() + 3600e3) return { status: "sending", closes: closes.toISOString() };
  if (asOf.getTime() < closes.getTime() - 864e5) return { status: "open", closes: closes.toISOString() };
  if (asOf.getTime() < closes.getTime()) return { status: "closes", closes: closes.toISOString() };
  return { status: "closed", closes: closes.toISOString() };
}

/** Day key in Eastern time for an ISO instant. */
export function etDayKey(iso: string): string {
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  return parts; // en-CA gives YYYY-MM-DD
}

// ---------------------------------------------------------------- compute

export interface ComputeOptions {
  /** Override the recorded season index (preview in the Season popover). */
  seasonIndex?: number;
}

export function computeSaleMetrics(input: SaleInput, opts: ComputeOptions = {}): SaleMetrics {
  const S = input.sale;
  const B0 = input.baseline;
  const TODAY = input.as_of_day;
  const season = opts.seasonIndex ?? (Number(S.season_index) || 1);
  const cm = Number(S.cm_pct) / 100;

  const phase: SalePhaseKey = S.finalized_at
    ? "final"
    : TODAY < S.d1
      ? "upcoming"
      : TODAY < S.start
        ? "early_access"
        : TODAY <= S.end
          ? "live"
          : "ended";
  const live = phase === "early_access" || phase === "live";
  const upcoming = phase === "upcoming";
  const asOf = live ? TODAY : null;
  const asOfDate = new Date(input.as_of);
  const asOfTime = F.timeET(input.as_of);
  // Hour share: cumulative share of clean-day orders placed by the end of the as-of hour.
  const hourShare = B0.hour_share?.[Math.min(23, Math.max(0, input.as_of_hour))];
  const h = live ? Math.min(1, Math.max(0.02, Number(hourShare) || (input.as_of_hour + 1) / 24)) : 1;

  const byDay = new Map(input.days.map((d) => [d.k, d]));
  const dowO = B0.dow_orders?.length === 7 ? B0.dow_orders.map(Number) : [1, 1, 1, 1, 1, 1, 1];
  const dowU = B0.dow_units?.length === 7 ? B0.dow_units.map(Number) : [1, 1, 1, 1, 1, 1, 1];
  const ordersDay = Number(B0.orders_day) || 0;
  const unitsDay = Number(B0.units_day) || 0;
  const baseNewShare = B0.new_share == null ? null : Number(B0.new_share);
  const Bof = (k: string) => ({ orders: ordersDay * dowO[dow(k)] * season, units: unitsDay * dowU[dow(k)] * season });

  // Uplift prior: mean of the member offers' expected uplift (planner input), else 15%.
  const upliftPcts = input.offers.map((o) => o.expected_uplift_pct).filter((v): v is number => v != null && v > 0);
  const uplift = upliftPcts.length ? sum(upliftPcts) / upliftPcts.length / 100 : 0.15;
  const factor = (ph: DayPhase) => (ph === "ea" ? 1.01 : ph === "main" ? 1 + uplift : 1);

  // Plan scale: the planner's order total shapes the per-day plan.
  let shaped = 0;
  for (let k = S.d1; k <= S.end; k = addDays(k, 1)) shaped += Bof(k).orders * factor(k < S.start ? "ea" : "main");
  const planOrders = S.plan_orders && S.plan_orders > 0 ? S.plan_orders : Math.round(shaped);
  const planSource: "planner" | "derived" = S.plan_orders && S.plan_orders > 0 ? "planner" : "derived";
  const kplan = shaped > 0 ? planOrders / shaped : 1;

  // Sends by day (ET).
  const sends: SaleSend[] = input.broadcasts.map((b) => {
    const st = sendStatus(b.sent_at, asOfDate);
    const when = b.sent_at ?? b.scheduled_at;
    const m = (b.metrics ?? {}) as Record<string, unknown>;
    const recipients = b.recipients ?? b.audience_size ?? null;
    const opens = b.opens ?? (typeof m.opens === "number" ? m.opens : null);
    const clicks = b.clicks ?? (typeof m.clicks === "number" ? m.clicks : null);
    const orders = typeof m.orders === "number" ? m.orders : null;
    const revenue = b.revenue == null ? null : Number(b.revenue);
    return {
      id: b.id,
      dayKey: when ? etDayKey(when) : null,
      time: when ? F.timeET(when) : "",
      campaign: b.name,
      channel: b.channel ?? "email",
      status: st.status,
      windowLabel: st.status === "closes" && st.closes ? "Closes " + F.md(etDayKey(st.closes)) : st.status === "scheduled" && when ? "Scheduled " + F.md(etDayKey(when)) : st.status[0].toUpperCase() + st.status.slice(1),
      recipients,
      open: recipients && opens != null ? opens / recipients : null,
      click: recipients && clicks != null ? clicks / recipients : null,
      orders,
      revenue,
      rpr: recipients && revenue != null ? revenue / recipients : null,
      closes: st.closes,
    };
  });
  const sendsByDay = new Map<string, SaleSend[]>();
  sends.forEach((s) => { if (s.dayKey) sendsByDay.set(s.dayKey, [...(sendsByDay.get(s.dayKey) ?? []), s]); });

  // Days: pre-7 → end+14.
  const days: SaleDay[] = [];
  for (let k = addDays(S.d1, -7); k <= addDays(S.end, 14); k = addDays(k, 1)) {
    const ph: DayPhase = k < S.d1 ? "pre" : k < S.start ? "ea" : k <= S.end ? "main" : "post";
    const r = byDay.get(k);
    const b = Bof(k);
    const future = k > TODAY;
    const partial = live && k === asOf;
    const scale = partial ? h : 1;
    const has = !future && !!r;
    days.push({
      k,
      phase: ph,
      quality: future ? "future" : partial ? "partial" : "actual",
      partial,
      future: future || !has,
      orders: has ? r.orders : null,
      awaiting: has ? r.awaiting : 0,
      units: has ? r.units : null,
      net: null,
      new: has ? r.new : null,
      saleDisc: has ? cents(r.disc?.sale) : null,
      codeOrders: has ? r.sale_code_orders : null,
      base: { orders: b.orders * scale, units: b.units * scale, unitsFull: b.units },
      plan: { orders: b.orders * factor(ph) * (ph === "pre" || ph === "post" ? 1 : kplan), units: b.units * factor(ph) },
      sends: sendsByDay.get(k) ?? [],
    });
  }

  const group = (ph: DayPhase | "full"): SaleGroup => {
    const rows = days.filter((d) => (ph === "full" ? d.phase === "ea" || d.phase === "main" : d.phase === ph));
    const done = rows.filter((d) => !d.future);
    const A = {
      orders: sum(done.map((d) => d.orders)),
      units: sum(done.map((d) => d.units)),
      new: sum(done.map((d) => d.new)),
      saleDisc: sum(done.map((d) => d.saleDisc)),
      codeOrders: sum(done.map((d) => d.codeOrders)),
    };
    const Bt = { orders: sum(done.map((d) => d.base.orders)), units: sum(done.map((d) => d.base.units)) };
    const P = { orders: sum(rows.map((d) => d.plan.orders)), units: sum(rows.map((d) => d.plan.units)) };
    const PtD = { orders: sum(done.map((d) => d.plan.orders * (d.partial ? h : 1))), units: sum(done.map((d) => d.plan.units * (d.partial ? h : 1))) };
    return {
      rows,
      done: done.length,
      total: rows.length,
      closed: done.filter((d) => !d.partial).length,
      A,
      B: Bt,
      P,
      PtD,
      lift: { orders: judge(done.length ? A.orders : null, Bt.orders), units: judge(done.length ? A.units : null, Bt.units) },
    };
  };
  const G = { pre: group("pre"), ea: group("ea"), main: group("main"), post: group("post"), full: group("full") };
  const Fu = G.full;
  const any = Fu.done > 0;
  const planUnits = Math.round(Fu.P.units);

  // Projection: at least one complete public day → mean of the last 3 complete days × days left.
  const closedMain = G.main.rows.filter((d) => !d.future && !d.partial);
  let projected: number | null = null;
  if (live && closedMain.length >= 1) {
    const last = closedMain.slice(-3);
    const rate = sum(last.map((d) => d.orders)) / last.length;
    const remaining = G.main.rows.filter((d) => d.future).length + (G.main.rows.some((d) => d.partial) ? 1 - h : 0);
    projected = Fu.A.orders + rate * remaining;
  }
  const hoursIntoMain = live && asOf != null && asOf >= S.start ? (asOf > S.start ? 24 : input.as_of_hour) : 0;
  const pace: PaceKey | null = upcoming
    ? "upcoming"
    : phase === "early_access"
      ? "ea"
      : live
        ? hoursIntoMain < 24
          ? "reading"
          : Fu.PtD.orders > 0 && Fu.A.orders / Fu.PtD.orders >= 1.1
            ? "ahead"
            : Fu.PtD.orders > 0 && Fu.A.orders / Fu.PtD.orders >= 0.9
              ? "on_pace"
              : "behind"
        : null;
  const planResult: PlanResultKey | null =
    !live && !upcoming && any && planOrders > 0
      ? Fu.A.orders / planOrders >= 1.1
        ? "beat"
        : Fu.A.orders / planOrders >= 0.9
          ? "met"
          : "missed"
      : null;

  // After-dip and net lift.
  const post14 = G.post.done === 14 && G.post.B.units > 0 ? G.post.A.units / G.post.B.units : null;
  const dip = post14 != null ? Math.max(0, G.post.B.units - G.post.A.units) : 0;
  const incUnits = Fu.A.units - Fu.B.units;
  const incOrders = Fu.A.orders - Fu.B.orders;
  const netInc = incUnits - dip;

  // Products.
  const saleDays = daysBetween(S.d1, S.end) + 1;
  const elapsedDowUnits = sum(Fu.rows.filter((d) => !d.future).map((d) => d.base.unitsFull / (unitsDay || 1)));
  const giftIds = new Set(input.offers.map((o) => o.gift_sku_id).filter((x): x is string => !!x));
  const endDay = live ? asOf! : S.end;
  const daysToEnd = live ? daysBetween(asOf!, S.end) : 0;
  const skuRows = input.skus.map((r) => {
    const base = Number(r.base_rate) * elapsedDowUnits * season;
    const planRate = Number(r.base_rate) * (1 + uplift);
    const rate = upcoming ? planRate : Number(r.rate3);
    const daysLeft = r.finished > 0 && rate > 0 ? r.finished / rate : null;
    let runway: RunwayKey;
    if (r.finished <= 0) runway = live || upcoming ? "sellable0" : "ran_out";
    else if (upcoming) runway = daysLeft != null && daysLeft >= saleDays ? "plan" : "short";
    else if (live) runway = daysLeft != null && daysLeft <= daysToEnd ? "runs_out" : "lasts";
    else runway = "lasted";
    const role: SaleProduct["role"] = giftIds.has(r.sku_id) ? "gift" : r.role === "member" ? "member" : "other";
    return {
      skuId: r.sku_id,
      sku: r.sku,
      name: r.name,
      role,
      units: upcoming ? 0 : r.units_sale,
      base,
      judged: upcoming ? none() : judge(r.units_sale, base),
      share: 0,
      finished: r.finished,
      raw: r.raw + r.prefilled_raw,
      rate,
      baseRate: Number(r.base_rate),
      planRate,
      runsOut: daysLeft == null ? null : daysLeft > 60 ? "after " + F.md(addDays(endDay, 60)) : F.md(addDays(endDay, Math.floor(daysLeft))),
      runway,
      daysLeft,
      daily: r.daily ?? [],
      retail: r.retail == null ? null : Number(r.retail),
    } satisfies SaleProduct;
  });
  const promoted = skuRows.filter((p) => p.role !== "other");
  const others = skuRows.filter((p) => p.role === "other");
  const incPos = sum(promoted.map((p) => Math.max(0, p.units - p.base))) + Math.max(0, sum(others.map((p) => p.units)) - sum(others.map((p) => p.base)));
  promoted.forEach((p) => { p.share = incPos > 0 && p.units > p.base ? (p.units - p.base) / incPos : 0; });
  const products = promoted.sort((a, b) => b.share - a.share || b.units - a.units);
  const otherUnits = sum(others.map((p) => p.units));
  const otherBase = sum(others.map((p) => p.base));
  const other = others.length
    ? { n: others.length, units: otherUnits, base: otherBase, judged: upcoming ? none() : judge(otherUnits, otherBase), share: incPos > 0 ? Math.max(0, otherUnits - otherBase) / incPos : 0 }
    : null;

  // Margin, modeled at list price (no revenue source yet). Discount dollars are real (ShipStation lines).
  const skuById = new Map(input.skus.map((x) => [x.sku_id, x]));
  const soldUnits = sum(skuRows.map((p) => p.units));
  const avgList = soldUnits > 0 ? sum(skuRows.map((p) => p.units * (p.retail ?? 0))) / soldUnits : 0;
  // Gift-code lines (e.g. COIL −$99.95) are the gift's list value, not a cash
  // discount: they are gift cost, never also give-away.
  const giftCodeDisc = sum(input.offers.filter((o) => o.gift_sku_id && o.discount_cents != null).map((o) => cents(o.discount_cents)));
  const saleDisc = Math.max(0, Fu.A.saleDisc - giftCodeDisc);
  const listSales = Fu.A.units * avgList;
  const discRate = listSales > 0 ? saleDisc / listSales : 0;
  const baseShare = Fu.A.units > 0 ? Math.min(1, Fu.B.units / Fu.A.units) : 1;
  const giveaway = saleDisc * baseShare;
  const discOnInc = saleDisc * (1 - baseShare);
  const incMargin = incUnits * avgList * (cm - discRate);
  // Gifts given = qualifying orders that received the gift × get quantity (the gift SKU's paid sales are not a cost).
  const giftUnits = sum(input.offers.filter((o) => o.gift_sku_id).map((o) => o.qualifying_with_gift * (o.get_qty ?? 1)));
  const giftCost = sum(input.offers.filter((o) => o.gift_sku_id).map((o) => {
    const g = skuById.get(o.gift_sku_id!);
    return o.qualifying_with_gift * (o.get_qty ?? 1) * (g?.retail == null ? 0 : Number(g.retail)) * (1 - cm);
  }));
  const dipMargin = post14 == null ? null : dip * cm * avgList;
  const netMargin = incMargin - giveaway - giftCost - (dipMargin ?? 0);
  const promoCost = giveaway + giftCost;
  const incNew = baseNewShare == null ? 0 : Fu.A.new - Fu.B.orders * baseNewShare;
  const marginQ: QualityKey = upcoming ? "modeled" : live ? "estimated" : phase === "ended" ? "provisional" : "final";

  const newShare = any && Fu.A.orders > 0 ? Fu.A.new / Fu.A.orders : null;
  const acq = any && newShare != null && baseNewShare != null && newShare - baseNewShare >= 0.05;
  const mechanism: MechanismKey | null = !any ? null : acq ? "acquired" : "neither";

  const sc: SaleMetrics["scorecard"] = {
    margin: {
      key: "margin",
      label: "Net incremental margin $",
      actual: any ? netMargin : null,
      projected: null,
      plan: null,
      planToDate: null,
      base: none(),
      planD: none(),
      quality: marginQ,
      note: any ? ["Modeled at list", "promo cost " + F.money(promoCost), promoCost > 0 ? "ROI " + F.x(netMargin / promoCost) : ""] : ["Modeled from offer depth"],
      money: true,
      pending: false,
    },
    orders: {
      key: "orders",
      label: "Orders (distinct)",
      actual: any ? Fu.A.orders : null,
      projected,
      plan: planOrders,
      planToDate: Fu.PtD.orders,
      base: judge(any ? Fu.A.orders : null, Fu.B.orders),
      planD: judge(any ? Fu.A.orders : null, live ? Fu.PtD.orders : planOrders, { mode: "band" }),
      quality: live ? "partial" : "actual",
      note: [
        live ? "plan " + F.int(Fu.PtD.orders) + " by now" : "plan " + F.int(planOrders),
        any ? "base " + F.int(Fu.B.orders) : "",
        projected != null && pace !== "reading" ? "projection " + F.int(projected) : "",
      ],
      money: false,
      pending: false,
    },
    units: {
      key: "units",
      label: "Units",
      actual: any ? Fu.A.units : null,
      projected: null,
      plan: planUnits,
      planToDate: Fu.PtD.units,
      base: judge(any ? Fu.A.units : null, Fu.B.units),
      planD: judge(any ? Fu.A.units : null, live ? Fu.PtD.units : planUnits, { mode: "band" }),
      quality: live ? "partial" : "actual",
      note: [live ? "plan " + F.int(Fu.PtD.units) + " by now" : "plan " + F.int(planUnits), any ? "base " + F.int(Fu.B.units) : ""],
      money: false,
      pending: false,
    },
    paid: {
      key: "paid",
      label: "Paid $",
      actual: null,
      projected: null,
      plan: null,
      planToDate: null,
      base: none(),
      planD: none(),
      quality: "modeled",
      note: ["Revenue source pending"],
      money: true,
      pending: true,
    },
    new: {
      key: "new",
      label: "New customers",
      actual: any ? Fu.A.new : null,
      projected: null,
      plan: null,
      planToDate: null,
      base: judge(newShare, baseNewShare, { unit: "pts" }),
      planD: none(),
      quality: live ? "partial" : "actual",
      note: [any ? "share " + F.pct0(newShare) + "%" : "", baseNewShare == null ? "" : "base " + F.pct0(baseNewShare) + "%", any ? "incremental " + F.int(incNew) : "", "since May 2026"],
      money: false,
      pending: false,
    },
  };

  // Offers.
  const memberUnits = (ids: string[]) => sum(ids.map((id) => skuById.get(id)?.units_sale ?? 0));
  const memberBase = (ids: string[]) => sum(ids.map((id) => (Number(skuById.get(id)?.base_rate) || 0) * elapsedDowUnits * season));
  const offerStatus = (o: SaleInputOffer): OfferStatusKey => {
    const gated = o.format === "percent" || o.format === "dollar" || o.format === "gift_code";
    if (gated && !o.code && o.scope !== "sitewide") return "missing_code";
    if (upcoming) return "scheduled";
    if (phase === "early_access") return "early_access";
    if (live) return "active";
    return "expired";
  };
  const offers: SaleOffer[] = input.offers.map((o) => {
    const sitewide = o.scope === "sitewide";
    const unitsA = upcoming ? null : sitewide ? Fu.A.units : memberUnits(o.member_sku_ids);
    const unitsB = sitewide ? Fu.B.units : memberBase(o.member_sku_ids);
    const kindWords = [o.format ? o.format.replace("_", " ") : "", o.scope ?? "", o.code ? o.code.toUpperCase() : ""].filter(Boolean).join(" · ");
    const structure: StructureFact[] = [];
    if (!upcoming && any) {
      if (sitewide && o.format === "percent") {
        structure.push(["Redemption", Fu.A.orders > 0 ? F.pct0(Fu.A.codeOrders / Fu.A.orders) + "% of orders" : "—"]);
        if (newShare != null && baseNewShare != null) structure.push(["New share", F.signed(newShare - baseNewShare, "pts")]);
        structure.push(["After-dip", post14 == null ? "after " + F.md(addDays(S.end, 14)) : F.dec2(post14)]);
      } else if (o.scope === "category" || (o.scope === "sku_set" && (o.format === "percent" || o.format === "dollar"))) {
        structure.push(["Containing", F.int(o.containing) + (Fu.A.orders > 0 ? " · " + F.pct0(o.containing / Fu.A.orders) + "% of orders" : "")]);
        if (o.format === "dollar" && o.dollar_off != null) structure.push(["Per unit", "$" + F.cell(o.dollar_off)]);
      } else if (o.gift_sku_id) {
        const qual = o.containing;
        structure.push(["Attach", qual > 0 ? F.pct0(o.qualifying_with_gift / qual) + "%" : "—"]);
        structure.push(["Without gift", F.int(qual - o.qualifying_with_gift)]);
        structure.push(["Gift w/o set", F.int(o.gift_without_qualifying)]);
        structure.push(["Qualifying", F.int(qual) + (Fu.A.orders > 0 ? " · " + F.pct0(qual / Fu.A.orders) + "% of orders" : "")]);
        if (o.format === "gift_min" && o.min_order_amount != null) structure.push(["Threshold", "$" + F.cell(o.min_order_amount) + " · needs revenue"]);
      }
    } else if (o.expected_orders) {
      structure.push(["Plan", F.int(o.expected_orders) + " orders"]);
    }
    return {
      id: o.id,
      label: o.label,
      kind: kindWords,
      format: o.format,
      code: o.code,
      status: offerStatus(o),
      unitsA,
      unitsB: upcoming ? null : unitsB,
      units: upcoming ? none() : judge(unitsA, unitsB),
      containing: upcoming ? null : sitewide ? Fu.A.orders : o.containing,
      redemptions: upcoming ? null : o.redemptions,
      discount: upcoming || o.discount_cents == null ? null : cents(o.discount_cents),
      structure,
      skuIds: [...o.member_sku_ids, ...(o.gift_sku_id ? [o.gift_sku_id] : [])],
      giftSkuId: o.gift_sku_id,
    };
  });

  // Codes seen in the window.
  const codes = input.codes.map((c) => ({ code: c.code, kind: c.kind, orders: c.orders, dollars: cents(c.cents) }));

  // Customers.
  const customers: SaleMetrics["customers"] = any
    ? {
        new: Fu.A.new,
        newShare: newShare ?? 0,
        returning: Fu.A.orders - Fu.A.new,
        retShare: 1 - (newShare ?? 0),
        ea: G.ea.A.orders,
        eaShare: Fu.A.orders > 0 ? G.ea.A.orders / Fu.A.orders : 0,
        eaNew: G.ea.A.orders > 0 ? G.ea.A.new / G.ea.A.orders : null,
        aov: null,
        ordersDay: Fu.A.orders / Math.max(1, Fu.done - (G.main.rows.some((d) => d.partial) ? 1 - h : 0)),
        incNew,
      }
    : null;

  // Attributed email revenue (entered), never added into sale totals.
  const attributed = { orders: sum(sends.map((s) => s.orders)), revenue: sum(sends.map((s) => s.revenue)) };
  const sendsEnteredAt = input.broadcasts.reduce<string | null>((m, b) => (b.updated_at && (!m || b.updated_at > m) ? b.updated_at : m), null);

  // Last comparable run: same format family, ≥ 60 days earlier (the RPC already filters the date).
  const fmtOf = (f: string | null) => (f === "percent" ? "percent" : f === "dollar" ? "dollar" : f ? "gift" : null);
  const primaryFmt = fmtOf(input.offers[0]?.format ?? null);
  const prior = input.prior_runs.find((r) => r.name.toLowerCase().includes(S.name.toLowerCase().split(" ")[0]));
  const lastRun: SaleMetrics["lastRun"] = prior
    ? {
        name: prior.name,
        liftUnits: prior.lift_pct == null ? null : Number(prior.lift_pct) / 100,
        comparable: fmtOf(prior.format) === primaryFmt && (prior.format ?? "none") !== "none",
        note: fmtOf(prior.format) === primaryFmt ? "" : "Different structure: " + (prior.format ?? "no code") + " · " + F.range(prior.d1, prior.d2),
      }
    : null;

  // Alerts.
  const alerts: SaleAlert[] = [];
  const giftRows = products.filter((p) => p.role === "gift");
  giftRows.forEach((g) => {
    if (upcoming) {
      const planGift = input.offers.find((o) => o.gift_sku_id === g.skuId);
      const need = planGift?.planner_gift_units ?? planGift?.derived_gift_units ?? null;
      if (need != null && g.finished < need) alerts.push({ tone: "a", code: "gift_stock", title: "Gift " + g.sku + " short of plan", detail: F.int(g.finished) + " finished · plan " + F.int(need), source: "inventory" });
    } else if (live && g.runway === "sellable0") alerts.push({ tone: "a", code: "gift_stock", title: "Gift " + g.sku + " sellable 0", detail: "raw " + F.int(g.raw), source: "inventory" });
    else if (live && g.runway === "runs_out") alerts.push({ tone: "a", code: "gift_runway", title: "Gift " + g.sku + " runs out " + (g.runsOut ?? ""), detail: F.rate(g.rate) + " per day", source: "inventory" });
  });
  codes.filter((c) => c.kind === "other_sale" && c.orders > 0).forEach((c) => {
    alerts.push({ tone: "a", code: "other_sale_code", title: c.code + " still redeeming", detail: F.int(c.orders) + " orders · " + F.money(c.dollars), source: "codes" });
  });
  input.offers.filter((o) => offerStatus(o) === "missing_code").forEach((o) => {
    alerts.push({ tone: "a", code: "missing_code", title: "No code on " + o.label, detail: "redemptions cannot be counted", source: "offers" });
  });
  if (!upcoming && B0.short) alerts.push({ tone: "k", code: "baseline_short", title: "Baseline short", detail: B0.n_clean + " clean days", source: "baseline" });
  if (upcoming && B0.short) alerts.push({ tone: "k", code: "baseline_short", title: "Baseline short · " + B0.n_clean + " clean days", detail: "freezes " + F.md(S.d1), source: "baseline" });
  if (upcoming && !(S.plan_orders && S.plan_orders > 0)) alerts.push({ tone: "k", code: "plan_missing", title: "Plan derived", detail: F.int(planOrders) + " orders from the baseline", source: "plan" });
  if (live && input.unresolved_orders > 0) alerts.push({ tone: "k", code: "unresolved", title: F.int(input.unresolved_orders) + " orders waiting on a SKU", detail: "not in units until resolved", source: "shipstation" });
  if (live && input.synced_at) {
    const ageMin = (asOfDate.getTime() - new Date(input.synced_at).getTime()) / 60000;
    if (ageMin > 60) alerts.push({ tone: "r", code: "sync_behind", title: "Sync behind · " + Math.round(ageMin) + " min", detail: "last order seen " + F.stampET(input.synced_at), source: "shipstation" });
  }
  if (live && input.last_run?.status === "failed") alerts.push({ tone: "r", code: "sync_failed", title: "Last ShipStation sync failed", detail: input.last_run.error ?? "", source: "shipstation" });

  const publicLift = G.main.lift.units.delta;
  const recorded = { finalizedAt: S.finalized_at, finalOn: S.final_on, priors: input.prior_runs.length, planLift: upliftPcts.length ? uplift : null, publicLift };

  return {
    input,
    phase,
    live,
    upcoming,
    asOf,
    asOfTime,
    syncedAt: input.synced_at,
    h,
    season,
    base: {
      ordersDay,
      unitsDay,
      newShare: baseNewShare,
      days: B0.n_clean,
      from: B0.clean_days?.[0] ?? null,
      to: B0.clean_days?.[B0.clean_days.length - 1] ?? null,
      short: !!B0.short,
      frozen: !!B0.frozen,
      discPerOrder: B0.everyday_disc_cents_per_order == null ? null : cents(B0.everyday_disc_cents_per_order),
    },
    days,
    G,
    planOrders,
    planUnits,
    planSource,
    uplift,
    projected,
    scorecard: sc,
    status: {
      pace,
      planResult,
      liftBand: any ? bandWord(Fu.lift.units.z) : null,
      mechanism,
      cannib: null,
      result: phase === "final" ? "final" : phase === "ended" ? "provisional" : null,
    },
    margin: {
      incremental: incMargin,
      giveaway,
      giftCost,
      dipMargin,
      net: netMargin,
      promoCost,
      roi: promoCost > 0 ? netMargin / promoCost : null,
      perOrder: incOrders > 0 ? promoCost / incOrders : null,
      perNew: incNew > 0 && newShare != null ? (promoCost * newShare) / incNew : null,
      discOnInc,
      quality: marginQ,
      priceBasis: "modeled",
      incUnits,
      incOrders,
      dip,
      post14,
      netInc,
      saleDisc,
      baseShare,
      avgList,
      discRate,
      giftUnits,
      cm,
    },
    offers,
    products,
    other,
    sends,
    attributed,
    sendsEnteredAt,
    customers,
    codes,
    alerts,
    recorded,
    lastRun,
    unresolved: input.unresolved_orders,
  };
}
