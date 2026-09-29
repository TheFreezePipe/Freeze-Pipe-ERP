/**
 * Pure helpers behind the Launches page's product list and "Add products"
 * dialog: which rows a launch lists, how many products it has, which board
 * cards are offered (grouped by drop, the matching drop first and ticked),
 * and the "N cards tagged <drop>" hint under a launch.
 */
import { launchSuggestion, upcomingLaunches } from "@/lib/marketing/launch-link";

// ---------------------------------------------------------------------------
// Member list
// ---------------------------------------------------------------------------

interface MemberRowLike {
  id: string;
  sku_id: string | null;
  planned_name: string | null;
  pd_project_id: string | null;
  sort_order: number | null;
  product?: { sku: string; product_name: string } | null;
}

interface CardRef {
  id: string;
  archived_at?: string | null;
}

export type LaunchMemberItem<C extends CardRef> =
  | { kind: "card"; key: string; card: C }
  | { kind: "plain"; key: string; sku: string | null; name: string };

/**
 * The launch's products in member order: card-backed rows as their card,
 * plain rows as their SKU / working name. Archived cards are left out; an
 * attached card without a member row (should not happen) is appended.
 */
export function launchMemberItems<C extends CardRef>(launch: {
  skus: readonly MemberRowLike[];
  cards: readonly C[];
}): LaunchMemberItem<C>[] {
  const cardById = new Map(launch.cards.map((c) => [c.id, c]));
  const items: LaunchMemberItem<C>[] = [];
  const seen = new Set<string>();
  const rows = [...launch.skus].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  for (const m of rows) {
    const card = m.pd_project_id ? cardById.get(m.pd_project_id) : undefined;
    if (card) {
      seen.add(card.id);
      if (!card.archived_at) items.push({ kind: "card", key: m.id, card });
      continue;
    }
    items.push({
      kind: "plain",
      key: m.id,
      sku: m.product?.sku ?? null,
      name: m.product?.product_name ?? m.planned_name ?? "",
    });
  }
  for (const c of launch.cards) {
    if (!seen.has(c.id) && !c.archived_at) items.push({ kind: "card", key: c.id, card: c });
  }
  return items;
}

/** Products on a launch: every member row except an archived card's, and at least its live cards. */
export function launchProductCount(launch: {
  skus: readonly Pick<MemberRowLike, "pd_project_id">[];
  cards: readonly CardRef[];
}): number {
  const archived = new Set(launch.cards.filter((c) => c.archived_at).map((c) => c.id));
  const rows = launch.skus.filter((m) => !m.pd_project_id || !archived.has(m.pd_project_id)).length;
  const live = launch.cards.filter((c) => !c.archived_at).length;
  return Math.max(rows, live);
}

// ---------------------------------------------------------------------------
// Add products
// ---------------------------------------------------------------------------

export interface BoardCardLike {
  id: string;
  name: string;
  stage: string;
  drop_tag?: string | null;
  linked_launch_id?: string | null;
  archived_at?: string | null;
}

export interface AddProductGroup<C extends BoardCardLike> {
  /** Drop tag; "" = cards with no drop. */
  tag: string;
  /** The drop's name matches the launch (launchSuggestion). */
  suggested: boolean;
  cards: C[];
}

/**
 * Board cards not on `launch` yet, grouped by drop: the drop that matches
 * the launch first, then drops by name, cards without a drop last; cards by
 * name within a group.
 */
export function addProductGroups<C extends BoardCardLike>(
  board: readonly C[],
  launch: { id: string; name: string; launch_date: string | null },
): AddProductGroup<C>[] {
  const byTag = new Map<string, C[]>();
  for (const c of board) {
    if (c.archived_at || c.linked_launch_id === launch.id) continue;
    const tag = c.drop_tag?.trim() || "";
    const list = byTag.get(tag) ?? [];
    list.push(c);
    byTag.set(tag, list);
  }
  const groups = [...byTag.entries()].map(([tag, cards]) => ({
    tag,
    suggested: tag !== "" && launchSuggestion(tag, [launch]) != null,
    cards: [...cards].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
  }));
  return groups.sort(
    (a, b) =>
      Number(b.suggested) - Number(a.suggested) ||
      Number(a.tag === "") - Number(b.tag === "") ||
      a.tag.localeCompare(b.tag),
  );
}

/** Starts ticked: the matching drop's cards that are on no launch and not halted. */
export function defaultAddPick(groups: readonly AddProductGroup<BoardCardLike>[]): Set<string> {
  const s = new Set<string>();
  for (const g of groups) {
    if (!g.suggested) continue;
    for (const c of g.cards) if (!c.linked_launch_id && c.stage !== "halted") s.add(c.id);
  }
  return s;
}

// ---------------------------------------------------------------------------
// "4 cards tagged Alien Studio"
// ---------------------------------------------------------------------------

/**
 * Per upcoming launch, the drops of unattached (live, not halted) cards whose
 * name matches it — the same match the launch picker suggests.
 */
export function taggedDropHints(
  board: readonly BoardCardLike[],
  launches: readonly { id: string; name: string; launch_date: string | null }[],
  todayIso: string,
): Map<string, { tag: string; count: number }[]> {
  const byDrop = new Map<string, number>();
  for (const c of board) {
    const tag = c.drop_tag?.trim();
    if (!tag || c.linked_launch_id || c.archived_at || c.stage === "halted") continue;
    byDrop.set(tag, (byDrop.get(tag) ?? 0) + 1);
  }
  const pickable = upcomingLaunches(launches, todayIso);
  const out = new Map<string, { tag: string; count: number }[]>();
  for (const [tag, count] of [...byDrop.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const l = launchSuggestion(tag, pickable);
    if (!l) continue;
    out.set(l.id, [...(out.get(l.id) ?? []), { tag, count }]);
  }
  return out;
}
