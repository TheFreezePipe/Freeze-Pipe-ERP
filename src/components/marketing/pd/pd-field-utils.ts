/**
 * Product Development board — non-component helpers shared by the card
 * sheet, the Move sheet, and the field primitives: formatters, the
 * row → PdCardLike cast, cost-basis jsonb parsing, the synthetic economics
 * row that feeds computeListD2C, and the silent-save hook. No Date.now()
 * anywhere — "today" always arrives from props as an ISO date.
 */
import { toast } from "@/hooks/use-toast";
import { describeError } from "@/lib/supabase-error";
import { computeListD2C, type ListD2CResult } from "@/lib/inventory-math";
import type { PdCardLike, PdStage, PdVerdict } from "@/lib/marketing/pd";
import { useUpdatePdProject, type PdProjectUpdate, type PdProjectWithRefs } from "@/lib/hooks/use-pd";
import type { SKUEconomics } from "@/types/database";

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-08-19" (or any ISO timestamp) → "Aug 19". */
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const m = Number(iso.slice(5, 7));
  const d = Number(iso.slice(8, 10));
  if (!m || !d) return "—";
  return `${MONTHS[m - 1]} ${d}`;
}

export function fmtMoney(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `$${n.toFixed(2)}`;
}

export function fmtPct(ratio: number | null | undefined): string {
  if (ratio == null || !Number.isFinite(ratio)) return "—";
  return `${Math.round(ratio * 100)}%`;
}

/** Relative-day phrasing used by deadline tiles. */
export function relDays(days: number): string {
  if (days === 0) return "today";
  return days > 0 ? `in ${days}d` : `${-days}d late`;
}

export const MARGIN_TONE_CLASS: Record<"ok" | "amber" | "red", string> = {
  ok: "text-green-400",
  amber: "text-amber-400",
  red: "text-red-400",
};

/** Sentinel select value that commits null. */
export const NONE = "__none__";

// ---------------------------------------------------------------------------
// Row → PdCardLike (the generated row widens stage/category to string)
// ---------------------------------------------------------------------------

export function toCardLike(p: PdProjectWithRefs): PdCardLike {
  const newest = p.samples?.[0];
  return {
    ...p,
    stage: p.stage as PdStage,
    category: p.category === "fillable" || p.category === "non_fillable" ? p.category : null,
    last_sample: newest
      ? {
          round_no: newest.round_no,
          received_at: newest.received_at,
          verdict: (newest.verdict as PdVerdict | null) ?? null,
          photo_count: newest.photos?.length ?? 0,
        }
      : null,
  };
}

export interface DropSummary {
  tag: string;
  count: number;
  /** First member target launch date, if any. */
  launch: string | null;
}

/** Distinct drops on the (unarchived) board with member counts. */
export function dropSummaries(board: readonly PdProjectWithRefs[]): DropSummary[] {
  const m = new Map<string, DropSummary>();
  for (const p of board) {
    const tag = p.drop_tag?.trim();
    if (!tag) continue;
    const cur = m.get(tag) ?? { tag, count: 0, launch: null };
    cur.count += 1;
    if (!cur.launch && p.target_launch_date) cur.launch = p.target_launch_date;
    m.set(tag, cur);
  }
  return [...m.values()].sort((a, b) => a.tag.localeCompare(b.tag));
}

/** Newest photo across all rounds (board-card cover), or null. */
export function coverPhotoPath(p: PdProjectWithRefs): string | null {
  for (const s of p.samples ?? []) {
    if (s.photos.length > 0) return s.photos[0].storage_path;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Cost basis (mkt_pd_projects.cost_basis jsonb)
// ---------------------------------------------------------------------------

export const COST_KEYS = [
  {
    key: "sea_freight_cost_per_unit",
    label: "Sea freight / unit",
    kind: "money",
  },
  {
    key: "air_freight_cost_per_unit",
    label: "Air freight / unit",
    kind: "money",
  },
  { key: "pct_sea", label: "Sea %", kind: "number" },
  { key: "pct_air", label: "Air %", kind: "number" },
  { key: "glycerin_cost_us", label: "Glycerin", kind: "money" },
  { key: "labor_cost_us", label: "Labor", kind: "money" },
  { key: "packing_material_cost", label: "Packing material", kind: "money" },
  { key: "packing_labor_cost", label: "Packing labor", kind: "money" },
  { key: "shipping_cost", label: "Shipping", kind: "money" },
  { key: "credit_card_fees", label: "Card fees", kind: "money" },
] as const;
export type CostKey = (typeof COST_KEYS)[number]["key"];

/** Fillable-only buckets — seeding skips them for non-fillable cards. */
export const FILLABLE_ONLY_KEYS: ReadonlySet<string> = new Set(["glycerin_cost_us", "labor_cost_us"]);

export interface CostBasis {
  values: Partial<Record<CostKey, number>>;
  /** key → SKU code the value was seeded from (cleared on edit / confirm). */
  seeded: Partial<Record<CostKey, string>>;
}

export function parseCostBasis(json: unknown): CostBasis | null {
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  const obj = json as Record<string, unknown>;
  const values: Partial<Record<CostKey, number>> = {};
  for (const { key } of COST_KEYS) {
    const v = obj[key];
    if (typeof v === "number" && Number.isFinite(v)) values[key] = v;
    else if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) values[key] = Number(v);
  }
  const seeded: Partial<Record<CostKey, string>> = {};
  const s = obj.seeded;
  if (s && typeof s === "object" && !Array.isArray(s)) {
    for (const { key } of COST_KEYS) {
      const v = (s as Record<string, unknown>)[key];
      if (typeof v === "string" && v) seeded[key] = v;
    }
  }
  return { values, seeded };
}

/** Serialize back to the jsonb shape the promote RPC reads (flat keys + `seeded`). */
export function serializeCostBasis(cb: CostBasis): Record<string, unknown> {
  const out: Record<string, unknown> = { ...cb.values };
  if (Object.keys(cb.seeded).length > 0) out.seeded = { ...cb.seeded };
  return out;
}

/**
 * Synthetic sku_economics row from a card's cost basis so the margin goes
 * through computeListD2C — the same function the SKU Costs page uses.
 */
export function econFromCostBasis(cb: CostBasis): SKUEconomics {
  const v = cb.values;
  return {
    id: "pd-card",
    sku_id: "pd-card",
    created_at: "",
    updated_at: "",
    row_version: 0,
    sea_freight_cost_per_unit: v.sea_freight_cost_per_unit ?? 0,
    air_freight_cost_per_unit: v.air_freight_cost_per_unit ?? 0,
    pct_sea: v.pct_sea ?? 100,
    pct_air: v.pct_air ?? 0,
    glycerin_cost_us: v.glycerin_cost_us ?? 0,
    labor_cost_us: v.labor_cost_us ?? 0,
    packing_material_cost: v.packing_material_cost ?? 0,
    packing_labor_cost: v.packing_labor_cost ?? 0,
    shipping_cost: v.shipping_cost ?? 0,
    credit_card_fees: v.credit_card_fees ?? 0,
    additional_raw_cost: 0,
    additional_raw_cost_reason: null,
    breakage_issue_cost: 0,
    mfg_override_active: false,
    mfg_override_pct_prefilled: null,
    mfg_window_days: 0,
    manufacturing_cost_cn: 0,
    nancy_raw_cost: null,
    yx_raw_cost: null,
    pct_from_nancy: null,
    pct_from_yx: null,
    pct_manufactured_us: 100,
    pct_manufactured_cn: 0,
  };
}

/** Margin for a card; null until quoted cost, MSRP, and a cost basis exist. */
export function pdMargin(card: {
  quoted_unit_cost: number | null;
  msrp: number | null;
  category: string | null;
  cost_basis: unknown;
}): ListD2CResult | null {
  if (card.quoted_unit_cost == null || card.msrp == null) return null;
  const cb = parseCostBasis(card.cost_basis);
  if (!cb) return null;
  return computeListD2C(
    econFromCostBasis(cb),
    card.quoted_unit_cost,
    card.msrp,
    card.category === "fillable" ? "fillable" : "non_fillable",
  );
}

// ---------------------------------------------------------------------------
// Field save (silent on success, toast on error)
// ---------------------------------------------------------------------------

export function usePdFieldSave(projectId: string) {
  const update = useUpdatePdProject();
  const save = (patch: PdProjectUpdate) =>
    update.mutateAsync({ id: projectId, patch }).then(
      () => true,
      (e: unknown) => {
        toast({
          title: "Save failed",
          description: describeError(e),
          variant: "destructive",
        });
        return false;
      },
    );
  return { save, pending: update.isPending };
}
