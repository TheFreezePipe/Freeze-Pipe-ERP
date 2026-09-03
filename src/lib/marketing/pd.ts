/**
 * Product Development board — pure logic shared by the board, the card
 * sheet, and the Move sheet. Mirrors fn_pd_gate_missing (SQL is the
 * enforcer; this lets the UI paint red fields without a round-trip and must
 * stay in lockstep with the migration).
 */
import { workback, daysBetween, deadlineState, type WorkbackChain } from "./workback";

export const PD_STAGES = [
  "purgatory",
  "good_ideas",
  "ready_to_begin",
  "china_working",
  "prototype_sent",
  "ready_for_confirmation",
  "ordered",
  "halted",
] as const;
export type PdStage = (typeof PD_STAGES)[number];

/** The six working lanes, in board order (rails excluded). */
export const PD_LANES: PdStage[] = [
  "good_ideas",
  "ready_to_begin",
  "china_working",
  "prototype_sent",
  "ready_for_confirmation",
  "ordered",
];

export const PD_STAGE_LABEL: Record<PdStage, string> = {
  purgatory: "Purgatory",
  good_ideas: "Good Ideas",
  ready_to_begin: "Ready to Begin",
  china_working: "China Working",
  prototype_sent: "Prototype Sent",
  ready_for_confirmation: "Confirmed, Ready to Order",
  ordered: "Ordered",
  halted: "Halted",
};

/** Owner-approved expected days per working stage (seeded in mkt_pd_stage_config). */
export const PD_EXPECTED_DAYS: Partial<Record<PdStage, number>> = {
  good_ideas: 30,
  ready_to_begin: 14,
  china_working: 21,
  prototype_sent: 14,
  ready_for_confirmation: 7,
};

/** Minimal card shape the pure functions need (superset of the DB row). */
export interface PdCardLike {
  stage: PdStage;
  stage_entered_at: string; // ISO timestamp
  owner_id: string | null;
  display_category: string | null;
  category: "fillable" | "non_fillable" | null;
  hypothesis: string | null;
  target_launch_date: string | null;
  supplier_id: string | null;
  msrp: number | null;
  spec_sent_at: string | null;
  quoted_unit_cost: number | null;
  moq_qty: number | null;
  quoted_lead_days: number | null;
  packaging: string | null;
  logo_placement: string | null;
  koozie: string | null;
  insert_cards: string | null;
  carton_qty: number | null;
  cost_basis_confirmed: boolean;
  sku_code: string | null;
  linked_sku_id: string | null;
  linked_factory_order_id: string | null;
  /** Newest sample round (Phase 2); undefined/null when no rounds exist. */
  last_sample?: PdSampleLike | null;
}

export const PD_VERDICTS = ["approved", "approved_with_changes", "revise", "rejected"] as const;
export type PdVerdict = (typeof PD_VERDICTS)[number];
export const PD_VERDICT_LABEL: Record<PdVerdict, string> = {
  approved: "Approved",
  approved_with_changes: "Approved w/ changes",
  revise: "Revise",
  rejected: "Rejected",
};

export const PD_SAMPLE_TYPES = ["prototype", "pre_production", "first_off"] as const;
export type PdSampleType = (typeof PD_SAMPLE_TYPES)[number];
export const PD_SAMPLE_TYPE_LABEL: Record<PdSampleType, string> = {
  prototype: "Prototype",
  pre_production: "Pre-production",
  first_off: "First off",
};

/** The slice of a sample round the gate needs (mirrors fn_pd_gate_missing's last_rd). */
export interface PdSampleLike {
  round_no: number;
  received_at: string | null;
  verdict: PdVerdict | null;
  photo_count: number;
}

/** Does the newest round satisfy the confirmation verdict rule? (Approved or approved-with-changes; remote counts.) */
export function sampleVerdictOk(s: PdSampleLike | null | undefined): boolean {
  if (!s || !s.verdict) return false;
  return s.verdict === "approved" || s.verdict === "approved_with_changes";
}

export const SPEC_FIELDS = ["packaging", "logo_placement", "koozie", "insert_cards"] as const;
export const BRANDED_SPEC_FIELDS = ["logo_placement", "koozie", "insert_cards"] as const;

/** Packaging is required for every product; the branded trio is waived for Accessories. */
export function brandedSpecRequired(card: Pick<PdCardLike, "display_category">): boolean {
  return card.display_category !== "Accessories";
}

export const PD_FIELD_LABEL: Record<string, string> = {
  owner: "Owner",
  display_category: "Category",
  hypothesis: "Hypothesis",
  target_launch_date: "Target launch",
  supplier_id: "Factory",
  msrp: "MSRP",
  spec_sent_at: "Spec sent",
  quoted_unit_cost: "Quoted cost",
  moq_qty: "MOQ",
  quoted_lead_days: "Lead days",
  packaging: "Packaging",
  logo_placement: "Logo placement",
  koozie: "Koozie",
  insert_cards: "Insert cards",
  category: "Fillable / non-fillable",
  carton_qty: "Carton qty",
  cost_basis: "Cost basis confirmed",
  sku_code: "SKU code",
  product_created: "Product created",
  factory_order: "Factory order",
  sample_received: "Sample in hand",
  sample_verdict: "Sample approved",
  sample_photo: "Sample photo",
};

const blank = (v: string | null | undefined) => !v || v.trim() === "";

/**
 * What's missing to move INTO `to`. Must match fn_pd_gate_missing exactly —
 * the SQL function is authoritative; this is the UI's preview.
 */
export function gateMissing(card: PdCardLike, to: PdStage): string[] {
  const m: string[] = [];
  switch (to) {
    case "purgatory":
    case "good_ideas":
    case "halted":
      break;
    case "prototype_sent":
      if (!card.last_sample?.received_at) m.push("sample_received");
      break;
    case "ready_to_begin":
      if (!card.display_category) m.push("display_category");
      if (blank(card.hypothesis)) m.push("hypothesis");
      if (!card.target_launch_date) m.push("target_launch_date");
      break;
    case "china_working":
      if (!card.supplier_id) m.push("supplier_id");
      if (!card.spec_sent_at) m.push("spec_sent_at");
      break;
    case "ready_for_confirmation":
      if (card.quoted_unit_cost == null) m.push("quoted_unit_cost");
      if (card.moq_qty == null) m.push("moq_qty");
      if (card.quoted_lead_days == null) m.push("quoted_lead_days");
      if (blank(card.packaging)) m.push("packaging");
      if (brandedSpecRequired(card)) {
        if (blank(card.logo_placement)) m.push("logo_placement");
        if (blank(card.koozie)) m.push("koozie");
        if (blank(card.insert_cards)) m.push("insert_cards");
      }
      if (!sampleVerdictOk(card.last_sample)) m.push("sample_verdict");
      if (!card.last_sample || card.last_sample.photo_count === 0) m.push("sample_photo");
      if (card.msrp == null) m.push("msrp");
      if (!card.category) m.push("category");
      if (card.carton_qty == null) m.push("carton_qty");
      if (!card.cost_basis_confirmed) m.push("cost_basis");
      if (blank(card.sku_code)) m.push("sku_code");
      if (!card.linked_sku_id) m.push("product_created");
      break;
    case "ordered":
      if (!card.linked_sku_id) m.push("product_created");
      if (!card.linked_factory_order_id) m.push("factory_order");
      break;
  }
  return m;
}

export function nextStage(stage: PdStage): PdStage | null {
  const i = PD_LANES.indexOf(stage);
  if (i < 0 || i >= PD_LANES.length - 1) return null;
  return PD_LANES[i + 1];
}

/** Days the card has sat in its current stage, and the stage's expected days. */
export function aging(card: Pick<PdCardLike, "stage" | "stage_entered_at">, todayIso: string) {
  const entered = card.stage_entered_at.slice(0, 10);
  const days = Math.max(daysBetween(entered, todayIso), 0);
  const expected = PD_EXPECTED_DAYS[card.stage] ?? null;
  const tone: "ok" | "amber" | "red" =
    expected == null ? "ok" : days > expected * 2 ? "red" : days > expected ? "amber" : "ok";
  return { days, expected, tone };
}

/** Sample-loop allowance used for the spec-by deadline (China Working + Prototype Sent). */
export const SAMPLE_LOOP_DAYS = (PD_EXPECTED_DAYS.china_working ?? 0) + (PD_EXPECTED_DAYS.prototype_sent ?? 0);

export interface DeadlineRow {
  key: "specBy" | "orderBy" | "shipBy" | "arriveBy" | "launch";
  label: string;
  date: string;
  days: number;
  state: "done" | "ok" | "tight" | "late";
  /** Only on orderBy: the air-freight fallback date. */
  air?: { date: string; days: number };
}

/** The deadline chain for a card, with per-row state; null when no target date. */
export function deadlineChain(card: PdCardLike, todayIso: string): DeadlineRow[] | null {
  if (!card.target_launch_date) return null;
  const ch: WorkbackChain = workback(card.target_launch_date, {
    sampleLoopDays: SAMPLE_LOOP_DAYS,
  });
  const row = (key: DeadlineRow["key"], label: string, date: string, done: boolean): DeadlineRow => ({
    key,
    label,
    date,
    days: daysBetween(todayIso, date),
    state: done ? "done" : deadlineState(date, todayIso),
  });
  const stageIdx = PD_LANES.indexOf(card.stage);
  const specDone = !!card.spec_sent_at || stageIdx >= PD_LANES.indexOf("china_working");
  const orderDone = card.stage === "ordered";
  const rows: DeadlineRow[] = [
    row("specBy", "Spec by", ch.specBy as string, specDone),
    row("orderBy", "Order by", ch.orderBy, orderDone),
    row("shipBy", "Ship by", ch.shipBy, false),
    row("arriveBy", "Arrive by", ch.arriveBy, false),
    row("launch", "Launch", ch.launch, false),
  ];
  if (!orderDone) {
    rows[1].air = {
      date: ch.orderByAir,
      days: daysBetween(todayIso, ch.orderByAir),
    };
  }
  return rows;
}

/** The next undone deadline — drives the card's risk dot. */
export function nextDeadline(rows: DeadlineRow[] | null): DeadlineRow | null {
  return rows?.find((r) => r.state !== "done") ?? null;
}

export type RiskDot = "g" | "a" | "r" | null;
export function riskDot(card: PdCardLike, todayIso: string): RiskDot {
  const n = nextDeadline(deadlineChain(card, todayIso));
  if (!n) return null;
  return n.state === "late" ? "r" : n.state === "tight" ? "a" : "g";
}

/** Card-face flags (owner: flag on the card, nothing in the 8am email). */
export function cardFlags(card: PdCardLike, todayIso: string, opts: { hasFactoryOrderLine?: boolean } = {}): string[] {
  const out: string[] = [];
  if (card.stage === "ordered" || card.stage === "halted" || card.stage === "purgatory") return out;
  const n = nextDeadline(deadlineChain(card, todayIso));
  if (n && n.state === "late") out.push(`${n.label} passed`);
  if (n && n.key === "orderBy" && n.state === "tight" && !opts.hasFactoryOrderLine) out.push("Order by inside 14d");
  return out;
}

/** Purgatory cards untouched this long land in the Review list (manual archive only). */
export const PURGATORY_REVIEW_DAYS = 90;

/**
 * Is this card in the Review list? (Flag tripped, sat past 2× expected days,
 * or parked in Purgatory untouched for 90+ days.) Shared by the board's
 * Review toggle and the sidebar badge so the two counts can never differ.
 */
export function needsReview(
  card: PdCardLike & { last_reviewed_at?: string | null; created_at?: string },
  todayIso: string,
): boolean {
  if (card.stage === "halted" || card.stage === "ordered") return false;
  if (card.stage === "purgatory") {
    const touched = (card.last_reviewed_at ?? card.created_at ?? "").slice(0, 10);
    return !!touched && daysBetween(touched, todayIso) >= PURGATORY_REVIEW_DAYS;
  }
  if (cardFlags(card, todayIso).length > 0) return true;
  return aging(card, todayIso).tone === "red";
}

/** Margin thresholds for the RFC chip (config; owner: no hard floor, just visible). */
export const MARGIN_AMBER_BELOW = 0.5;
export const MARGIN_RED_BELOW = 0.4;
export function marginTone(contributionMargin: number | null): "ok" | "amber" | "red" | null {
  if (contributionMargin == null) return null;
  if (contributionMargin < MARGIN_RED_BELOW) return "red";
  if (contributionMargin < MARGIN_AMBER_BELOW) return "amber";
  return "ok";
}
