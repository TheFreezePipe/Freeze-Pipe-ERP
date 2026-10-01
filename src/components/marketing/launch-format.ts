/**
 * Launch vocabulary shared by the launch form, the Launches page, the launch
 * confirm dialogs and the PD launch picker: the kind label map (never show
 * the raw mkt_launches.kind value) and the date formats the launch-link
 * dialogs use. fmtDay / relDays (lib/marketing/format-day) are also the PD
 * sheet's formatters (pd-field-utils re-exports them), so both sides format
 * dates one way.
 *
 * Also the Launches page's pure row logic (no hooks, no Date.now()): the
 * plain SKU rows' stock reading, the Status chip's stock signal and the
 * "Add products" merge of a drop's arrived cards.
 */
import { humanizeEnum } from "@/lib/utils";
import { addDaysIso } from "@/lib/marketing/workback";
import { isArrived, launchOrderBy, type PdLaunchRef } from "@/lib/marketing/pd";
import { memberStockNeed, memberStocked, type LaunchMemberRow } from "@/lib/marketing/launch-link";
import type { AddProductGroup, BoardCardLike } from "./launch-members";

/** mkt_launches.kind values, in form order, with their labels. */
export const LAUNCH_KINDS: readonly { value: string; label: string }[] = [
  { value: "launch", label: "Launch" },
  { value: "drop", label: "Drop" },
  { value: "studio_drop", label: "Studio drop" },
  { value: "restock", label: "Restock" },
];

export const LAUNCH_KIND_LABEL: Readonly<Record<string, string>> = Object.fromEntries(
  LAUNCH_KINDS.map((k) => [k.value, k.label]),
);

/** Label for a launch kind; unknown values are humanized, never shown raw. */
export function launchKindLabel(kind: string | null | undefined): string {
  if (!kind) return "";
  return LAUNCH_KIND_LABEL[kind] ?? humanizeEnum(kind);
}

/** fmtDay "Jan 21" / fmtDayLong "Jan 21, 2027" / relDays "in 29d": one copy in lib (format-day), shared with launch-link's Activity text. */
export { fmtDay, fmtDayLong, relDays } from "@/lib/marketing/format-day";

/** A product date against its launch deadline (memberState.against.slackDays): "22d late", "on the day", "5d early". */
export function slackText(slackDays: number): string {
  if (slackDays === 0) return "on the day";
  return slackDays < 0 ? `${-slackDays}d late` : `${slackDays}d early`;
}

// ---------------------------------------------------------------------------
// Launches page — plain SKU rows' stock reading and the row's Status chip
// ---------------------------------------------------------------------------

/** The member-row fields the stock reading needs. */
export type StockRow = Pick<LaunchMemberRow, "sku_id" | "limited_qty" | "expected_first_30d_units"> & {
  product?: { sku: string } | null;
  planned_name?: string | null;
};

/** "2 of 200 on hand" when the row needs a quantity, else "120 on hand"; null for rows without a SKU. */
export function stockReading(row: StockRow, onHand: number | undefined): string | null {
  if (!row.sku_id) return null;
  const have = onHand ?? 0;
  const need = memberStockNeed(row);
  return need != null ? `${have} of ${need} on hand` : `${have} on hand`;
}

/**
 * The single most urgent stock signal for an upcoming launch, in priority
 * order: SKUs the incoming pipeline won't cover by launch day → order window
 * passed → order-by inside 14 days → incoming (overdue when every short SKU's
 * incoming date has passed — never a past "incoming by") → stocked. A SKU is
 * short unless memberStocked (on hand covers its limited / expected units
 * when set, else above zero), so sample units never read as stock.
 */
export type StockSignal =
  | { kind: "uncovered"; skus: string[] }
  | { kind: "window_passed"; orderBy: string }
  | { kind: "order_by"; orderBy: string }
  | { kind: "incoming_overdue"; date: string }
  | { kind: "incoming"; date: string }
  | { kind: "stocked" }
  | null;

export const ORDER_BY_SOON_DAYS = 14;

export function stockSignal(
  rows: readonly StockRow[],
  launch: Pick<PdLaunchRef, "launch_date" | "early_access_date" | "inventory_ready_by">,
  onHandBySku: ReadonlyMap<string, number>,
  incomingBySku: ReadonlyMap<string, string>,
  todayIso: string,
): StockSignal {
  const launchDay = launch.launch_date ? launch.launch_date.slice(0, 10) : null;
  const orderBy = launchOrderBy(launch);
  const skuRows = rows.filter((r) => r.sku_id);
  const short = skuRows.filter((r) => !memberStocked(r, onHandBySku.get(r.sku_id!) ?? 0));
  const incomingOf = (r: StockRow) => incomingBySku.get(r.sku_id!) ?? null;

  if (launchDay && skuRows.length > 0) {
    const uncovered = short.filter((r) => {
      const eta = incomingOf(r);
      return !eta || eta > launchDay;
    });
    if (uncovered.length > 0) {
      return { kind: "uncovered", skus: uncovered.map((r) => r.product?.sku ?? r.planned_name ?? "?") };
    }
  }
  if (orderBy && todayIso > orderBy && short.some((r) => !incomingOf(r))) return { kind: "window_passed", orderBy };
  if (orderBy && todayIso <= orderBy && addDaysIso(todayIso, ORDER_BY_SOON_DAYS) >= orderBy) return { kind: "order_by", orderBy };
  if (launchDay && short.length > 0) {
    const latest = short
      .map(incomingOf)
      .filter((d): d is string => !!d)
      .sort()
      .pop()!;
    return latest < todayIso ? { kind: "incoming_overdue", date: latest } : { kind: "incoming", date: latest };
  }
  if (launchDay && skuRows.length > 0) return { kind: "stocked" };
  return null;
}

// ---------------------------------------------------------------------------
// Launches page — "Add products" with a drop's arrived cards
// ---------------------------------------------------------------------------

/**
 * The suggested group's cards plus the drop's ARRIVED cards that are not on
 * this launch yet (usePdDropCards; the board itself hides archived cards).
 * Arrived cards attach link-only — their dates stay frozen — so they are
 * offered where the drop's live cards are. Cards already in the group or on
 * the launch are not repeated; names sort as addProductGroups sorts them.
 */
export function withArrivedDropCards<C extends BoardCardLike>(
  groups: readonly AddProductGroup<C>[],
  arrived: readonly C[],
  launchId: string,
): AddProductGroup<C>[] {
  const extra = arrived.filter((c) => isArrived(c) && c.linked_launch_id !== launchId);
  if (extra.length === 0) return [...groups];
  return groups.map((g) => {
    if (!g.suggested) return g;
    const have = new Set(g.cards.map((c) => c.id));
    const add = extra.filter((c) => !have.has(c.id));
    if (add.length === 0) return g;
    return { ...g, cards: [...g.cards, ...add].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)) };
  });
}
