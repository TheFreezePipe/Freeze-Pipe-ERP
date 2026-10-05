/**
 * Launch vocabulary shared by the launch form, the Launches page, the launch
 * confirm dialogs and the PD launch picker: the kind label map (never show
 * the raw mkt_launches.kind value) and the date formats the launch-link
 * dialogs use. fmtDay / relDays (lib/marketing/format-day) are also the PD
 * sheet's formatters (pd-field-utils re-exports them), so both sides format
 * dates one way.
 *
 * Also the Launches page's "Add products" merge of a drop's arrived cards
 * (pure, no hooks).
 */
import { humanizeEnum } from "@/lib/utils";
import { isArrived } from "@/lib/marketing/pd";
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
