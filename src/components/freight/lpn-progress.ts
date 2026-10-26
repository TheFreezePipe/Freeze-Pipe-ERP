import { cartonContents } from "@/lib/warehouse/carton-split";
import type {
  CartonGroupWithSkus,
  ShipmentContainer,
  ShipmentPutawayRow,
  WhSuggestionReason,
} from "@/lib/hooks";
import type { WarehouseProgress } from "./shipment-stages";

// ---------------------------------------------------------------------------
// lpn-progress — what the shipment page shows about a shipment's license
// plates (migration 20261023000001): the LPN range per carton group, which
// carton a correction would void, putaway counts, and the stepper's
// warehouse progress. Pure, so the manifest, the putaway card and the
// stepper agree, and tests can pin the rules.
// ---------------------------------------------------------------------------

type GroupForLpns = Pick<CartonGroupWithSkus, "id" | "carton_qty" | "received_cartons"> & {
  skus: Pick<CartonGroupWithSkus["skus"][number], "sku_id" | "units_total">[];
};
type ContainerForLpns = Pick<
  ShipmentContainer,
  "id" | "code" | "carton_seq" | "carton_group_id" | "qty" | "qty_initial" | "state" | "printed_at" | "created_at" | "balances"
>;
type PutawayForLpns = Pick<ShipmentPutawayRow, "status" | "sku_id" | "qty" | "container_id"> & {
  container: Pick<NonNullable<ShipmentPutawayRow["container"]>, "carton_group_id"> | null;
};

const bySeq = (a: ContainerForLpns, b: ContainerForLpns) =>
  (a.carton_seq ?? Number.MAX_SAFE_INTEGER) - (b.carton_seq ?? Number.MAX_SAFE_INTEGER) || a.code.localeCompare(b.code);

/** "C-466-001…040": first and last code, the shared "C-466-" written once. */
export function lpnRange(codes: string[]): string | null {
  if (codes.length === 0) return null;
  const first = codes[0];
  const last = codes[codes.length - 1];
  if (codes.length === 1 || first === last) return first;
  const cut = first.lastIndexOf("-") + 1;
  return cut > 0 && last.startsWith(first.slice(0, cut)) ? `${first}…${last.slice(cut)}` : `${first}…${last}`;
}

/** Still a carton on the floor (voided ones keep their code but are gone). */
export function isLiveCarton(c: Pick<ShipmentContainer, "state">): boolean {
  return c.state !== "void";
}

/** Sealed and never drawn from (or minted empty): what a correction may void. */
export function isVoidable(c: Pick<ShipmentContainer, "state" | "qty" | "qty_initial">): boolean {
  return (c.state === "sealed" && c.qty === c.qty_initial && c.qty > 0) || (c.state === "empty" && c.qty_initial === 0);
}

function unitsBySku(entries: { sku_id: string; units: number }[]): string {
  const m = new Map<string, number>();
  for (const e of entries) if (e.units > 0) m.set(e.sku_id, (m.get(e.sku_id) ?? 0) + e.units);
  return [...m.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}:${v}`)
    .join(",");
}

/**
 * The carton a −1 tap on this group would void, as the RPC chooses it: the
 * newest sealed-and-full carton, preferring one whose contents equal the
 * split of the slot being reversed (carton r0). Null when none qualifies,
 * which the RPC refuses as lpn_in_use.
 */
export function voidCandidate(group: GroupForLpns, containers: ContainerForLpns[]): ContainerForLpns | null {
  if (group.received_cartons <= 0 || group.carton_qty <= 0) return null;
  const slot = Math.min(group.received_cartons, group.carton_qty);
  const target = unitsBySku(
    cartonContents(group.skus, group.carton_qty, slot).skus.map((s) => ({ sku_id: s.sku_id, units: s.units })),
  );
  const candidates = containers
    .filter((c) => c.carton_group_id === group.id && isVoidable(c))
    .sort((a, b) => b.created_at.localeCompare(a.created_at) || bySeq(b, a));
  const exact = candidates.find(
    (c) => unitsBySku(c.balances.map((b) => ({ sku_id: b.sku_id, units: b.on_hand }))) === target,
  );
  return exact ?? candidates[0] ?? null;
}

export interface GroupLpns {
  /** Live cartons in carton order. */
  live: ContainerForLpns[];
  range: string | null;
  /** Putaway tasks of the group's cartons (cancelled ones excluded). */
  putawayTotal: number;
  putawayDone: number;
  voidCandidate: ContainerForLpns | null;
}

export function groupLpns(group: GroupForLpns, containers: ContainerForLpns[], putaway: PutawayForLpns[]): GroupLpns {
  const live = containers.filter((c) => c.carton_group_id === group.id && isLiveCarton(c)).sort(bySeq);
  const tasks = putaway.filter((m) => m.container?.carton_group_id === group.id && m.status !== "cancelled");
  return {
    live,
    range: lpnRange(live.map((c) => c.code)),
    putawayTotal: tasks.length,
    putawayDone: tasks.filter((m) => m.status === "done").length,
    voidCandidate: voidCandidate(group, containers),
  };
}

/** Loose-unit putaway for one SKU (unit mode): units in its tasks and units put away. */
export function loosePutaway(skuId: string, putaway: PutawayForLpns[]): { units: number; done: number } {
  let units = 0;
  let done = 0;
  for (const m of putaway) {
    if (m.container_id || m.sku_id !== skuId || m.status === "cancelled") continue;
    units += m.qty ?? 0;
    if (m.status === "done") done += m.qty ?? 0;
  }
  return { units, done };
}

/** The stepper's warehouse stages for a shipment. */
export function warehouseProgress(
  groups: Pick<CartonGroupWithSkus, "carton_qty">[],
  containers: Pick<ShipmentContainer, "state" | "printed_at">[],
  putaway: Pick<ShipmentPutawayRow, "status">[],
): WarehouseProgress {
  const live = containers.filter(isLiveCarton);
  const tasks = putaway.filter((m) => m.status !== "cancelled");
  return {
    cartonsPlanned: groups.reduce((s, g) => s + g.carton_qty, 0),
    labelled: live.length,
    printed: live.filter((c) => !!c.printed_at).length,
    putawayTotal: tasks.length,
    putawayDone: tasks.filter((m) => m.status === "done").length,
  };
}

/** Why the suggestion was made, in the receiver's words. */
export const SUGGESTION_REASON_WORDS: Record<WhSuggestionReason, string> = {
  same_sku_reserve: "Reserve with the same SKU",
  same_sku_face: "The SKU's pick face",
  nearest_empty: "Nearest empty bay in its zone",
  other_zone_empty: "Nearest empty bay (other zone)",
  breakdown_shelf: "Break-down shelf (mixed carton)",
  none: "No free bay: scan any location",
};

export function reasonWords(reason: string | null | undefined): string {
  return reason && reason in SUGGESTION_REASON_WORDS
    ? SUGGESTION_REASON_WORDS[reason as WhSuggestionReason]
    : "No suggestion";
}
