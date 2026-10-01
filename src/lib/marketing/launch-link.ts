/**
 * PD cards attached to launches — pure logic for the launch picker, the
 * attach / add-products confirm, the move-a-launch confirm, the Launches
 * page product rows and health chip, and the card's Activity text. The
 * database is the enforcer (20260928000001_pd_launch_attach.sql and
 * 20260930000002_launch_one_product_one_row.sql: rpc_save_launch,
 * rpc_pd_attach_launch, fn_pd_detach_member, trg_pd_halt_detaches,
 * fn_pd_follow_launch, fn_pd_launch_date_guard); these previews follow the
 * same rules so a confirm dialog shows exactly what the save will do.
 *
 * Owner rules (launch-product-rules, 2026-09-30): one product, one row; a
 * halted card is never on a launch; an arrived card stays on its launch,
 * frozen, counted and green; an ordered product is judged by its order (the
 * factory date against the launch's ship-by), and once units are on a
 * freight shipment by its sea timing (the ETA against the launch's
 * ready-by); every screen counts products as member rows minus halted-card
 * rows (launchProductCount).
 */
import { addDaysIso, daysBetween, orderByFromReadyBy } from "./workback";
import { fmtDay } from "./format-day";
import {
  deadlineChain,
  followsLaunch,
  isArrived,
  launchReadyBy,
  launchShipBy,
  nextDeadline,
  pdStageLabel,
  riskDot,
  type PdChainCard,
  type PdLaunchRef,
  type RiskDot,
} from "./pd";

export { followsLaunch, launchReadyBy, launchOrderBy, launchShipBy, pdStageLabel, isArrived } from "./pd";

/** A card as the launch-link previews read it (board rows and launch embeds both fit). */
export interface LaunchLinkCard extends PdChainCard {
  id: string;
  name: string;
  drop_tag?: string | null;
  display_category?: string | null;
  linked_sku_id?: string | null;
  /** The linked product's code, when the row embeds it (usePdBoard / usePdDropCards rows do). */
  linked_sku?: { sku: string } | null;
  archived_at?: string | null;
  archive_reason?: string | null;
}

/** One card in a confirm dialog: name, stage, target old -> new, order by old -> new. */
export interface LaunchLinkRow {
  id: string;
  name: string;
  stage: string;
  stageLabel: string;
  oldTarget: string | null;
  newTarget: string | null;
  oldOrderBy: string | null;
  newOrderBy: string | null;
  /** The target date changes. */
  moves: boolean;
}

const orderByOf = (card: PdChainCard, todayIso: string, launch?: PdLaunchRef | null): string | null =>
  deadlineChain(card, todayIso, launch)?.find((r) => r.key === "orderBy")?.date ?? null;

const day = (iso: string | null | undefined): string | null => (iso ? iso.slice(0, 10) : null);

// ---------------------------------------------------------------------------
// Launch picker
// ---------------------------------------------------------------------------

/** Words too common in launch / drop names to say which launch a drop means. */
const GENERIC_WORDS = new Set(["studio", "drop", "drops", "launch", "the", "a", "an", "of", "and", "collection"]);

function nameTokens(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).map((t) => (/^\d+$/.test(t) ? String(Number(t)) : t));
}

const normName = (s: string) => nameTokens(s).join(" ");

/** The slice of a drop's cards launchSuggestion reads to find the launch the drop already rides. */
export type DropCardRef = {
  linked_launch_id?: string | null;
  stage?: string;
  archived_at?: string | null;
  archive_reason?: string | null;
};

/**
 * The launch a drop means. A launch in `launches` that ALREADY carries a card
 * of the drop (`dropCards`: live or arrived cards with linked_launch_id;
 * halted cards are never on a launch) wins outright — the launch the owner
 * built for the drop may be named nothing like the tag ("Q4 Studio" rode
 * "Northern Lights Studio drop"). Several carrying launches: the one with the
 * most cards, then the name match below, then the earliest date, then name
 * and id.
 *
 * Otherwise the launch whose name best matches the tag, or null. Generic
 * words (studio, drop, launch, ...) are ignored; at least half of the tag's
 * remaining words must appear in the launch name. Ties break on an exact
 * name match, then the larger share and count of matched words, then the
 * fewest extra words in the launch name, then the earliest launch date
 * (undated last), then name and id — so the pick is deterministic.
 * Pass the launches the picker offers (e.g. upcomingLaunches()).
 */
export function launchSuggestion<L extends Pick<PdLaunchRef, "id" | "name" | "launch_date">>(
  dropTag: string | null | undefined,
  launches: readonly L[],
  dropCards?: readonly DropCardRef[],
): L | null {
  const tag = dropTag?.trim();
  const byName = tag ? suggestByName(tag, launches) : null;

  if (dropCards && dropCards.length > 0) {
    const carried = new Map<string, number>();
    for (const c of dropCards) {
      if (!c.linked_launch_id || c.stage === "halted") continue;
      if (c.archived_at && !isArrived(c)) continue;
      carried.set(c.linked_launch_id, (carried.get(c.linked_launch_id) ?? 0) + 1);
    }
    const carrying = launches
      .filter((l) => carried.has(l.id))
      .sort(
        (a, b) =>
          carried.get(b.id)! - carried.get(a.id)! ||
          Number(b.id === byName?.id) - Number(a.id === byName?.id) ||
          (day(a.launch_date) ?? "9999-12-31").localeCompare(day(b.launch_date) ?? "9999-12-31") ||
          a.name.localeCompare(b.name) ||
          a.id.localeCompare(b.id),
      );
    if (carrying.length > 0) return carrying[0];
  }
  return byName;
}

function suggestByName<L extends Pick<PdLaunchRef, "id" | "name" | "launch_date">>(tag: string, launches: readonly L[]): L | null {
  const all = nameTokens(tag);
  const significant = all.filter((t) => !GENERIC_WORDS.has(t));
  const want = [...new Set(significant.length ? significant : all)];
  if (want.length === 0) return null;
  const tagNorm = normName(tag);

  type Scored = { l: L; exact: boolean; ratio: number; hits: number; extra: number };
  const scored: Scored[] = [];
  for (const l of launches) {
    const have = new Set(nameTokens(l.name));
    const hits = want.filter((t) => have.has(t)).length;
    const ratio = hits / want.length;
    if (hits === 0 || ratio < 0.5) continue;
    scored.push({ l, exact: normName(l.name) === tagNorm, ratio, hits, extra: have.size - hits });
  }
  scored.sort(
    (a, b) =>
      Number(b.exact) - Number(a.exact) ||
      b.ratio - a.ratio ||
      b.hits - a.hits ||
      a.extra - b.extra ||
      (day(a.l.launch_date) ?? "9999-12-31").localeCompare(day(b.l.launch_date) ?? "9999-12-31") ||
      a.l.name.localeCompare(b.l.name) ||
      a.l.id.localeCompare(b.l.id),
  );
  return scored[0]?.l ?? null;
}

/** Launches on or after today (undated ones last), soonest first — the picker's list. */
export function upcomingLaunches<L extends Pick<PdLaunchRef, "id" | "name" | "launch_date">>(
  launches: readonly L[],
  todayIso: string,
): L[] {
  return launches
    .filter((l) => !l.launch_date || day(l.launch_date)! >= todayIso)
    .sort(
      (a, b) =>
        (day(a.launch_date) ?? "9999-12-31").localeCompare(day(b.launch_date) ?? "9999-12-31") ||
        a.name.localeCompare(b.name) ||
        a.id.localeCompare(b.id),
    );
}

// ---------------------------------------------------------------------------
// Attach preview (board "Attach to launch", Launches "Add products")
// ---------------------------------------------------------------------------

/** The launch member fields the attach rules read. */
export interface LaunchMemberLike {
  id: string;
  sku_id: string | null;
  planned_name: string | null;
  pd_project_id: string | null;
  sort_order: number;
  created_at?: string;
}

export interface AttachRow extends LaunchLinkRow {
  /** Placeholder product (planned name) on the launch this card takes over, if any. */
  replaces: string | null;
  /** The other launch the card leaves, if it is attached elsewhere now. */
  fromLaunch: { id: string; name: string } | null;
  /** An archived (arrived) card: link only, its dates stay frozen (moves is false). */
  archived: boolean;
}

/** A card the attach will not take (rpc_pd_attach_launch skipped:[]). Shown greyed in the confirm. */
export interface AttachSkipped {
  id: string;
  name: string;
  stage: string;
  stageLabel: string;
  reason: "halted";
}

export interface AttachPlan {
  rows: AttachRow[];
  skipped: AttachSkipped[];
}

const lowerTrim = (s: string | null | undefined) => (s == null ? null : s.trim().toLowerCase());

/**
 * What attaching `cards` to `launch` does, card by card, in the RPC's order
 * (duplicates dropped, first one wins). Halted cards are never attached: they
 * come back in `skipped` (the dialog lists them greyed). Each live card ends
 * up following the launch: target = the launch date (kept when the launch is
 * undated), order by from the launch's ready-by. An archived (arrived) card
 * is linked only — its dates stay where they are (`archived`, moves false).
 * `replaces` mirrors rpc_pd_attach_launch's member rules: a card already on
 * the launch keeps its row; a promoted card claims a plain row carrying its
 * SKU; otherwise it claims the earliest placeholder (no SKU, no card) named
 * like its drop tag or its own name. Pass the launch's member rows
 * (`launch.skus`) to get `replaces`.
 */
export function attachPlan(
  cards: readonly LaunchLinkCard[],
  launch: PdLaunchRef & { skus?: readonly LaunchMemberLike[] | null },
  todayIso: string,
): AttachPlan {
  const members = [...(launch.skus ?? [])]
    .sort(
      (a, b) =>
        a.sort_order - b.sort_order || (a.created_at ?? "").localeCompare(b.created_at ?? "") || a.id.localeCompare(b.id),
    )
    .map((m) => ({ ...m }));
  const seen = new Set<string>();
  const rows: AttachRow[] = [];
  const skipped: AttachSkipped[] = [];
  for (const card of cards) {
    if (seen.has(card.id)) continue;
    seen.add(card.id);

    if (card.stage === "halted") {
      skipped.push({ id: card.id, name: card.name, stage: card.stage, stageLabel: pdStageLabel(card.stage), reason: "halted" });
      continue;
    }

    let replaces: string | null = null;
    const kept = members.some((m) => m.pd_project_id === card.id);
    if (!kept) {
      const bySku = card.linked_sku_id
        ? members.find((m) => m.pd_project_id == null && m.sku_id === card.linked_sku_id)
        : undefined;
      if (bySku) {
        bySku.pd_project_id = card.id;
      } else {
        const names = [lowerTrim(card.drop_tag), lowerTrim(card.name)].filter((n): n is string => n != null);
        const ph = members.find(
          (m) => m.sku_id == null && m.pd_project_id == null && names.includes(lowerTrim(m.planned_name) ?? "\u0000"),
        );
        if (ph) {
          ph.pd_project_id = card.id;
          replaces = ph.planned_name;
        }
      }
    }

    const archived = !!card.archived_at;
    const oldTarget = day(card.target_launch_date);
    const newTarget = archived ? oldTarget : day(launch.launch_date) ?? oldTarget;
    const attached: PdChainCard = {
      stage: card.stage,
      spec_sent_at: card.spec_sent_at,
      target_launch_date: newTarget,
      linked_launch_id: launch.id,
      launch_date_override: false,
    };
    const from = card.linked_launch_id && card.linked_launch_id !== launch.id ? card.launch ?? null : null;
    const oldOrderBy = orderByOf(card, todayIso);
    rows.push({
      id: card.id,
      name: card.name,
      stage: card.stage,
      stageLabel: pdStageLabel(card.stage),
      oldTarget,
      newTarget,
      oldOrderBy,
      newOrderBy: archived ? oldOrderBy : orderByOf(attached, todayIso, launch),
      moves: oldTarget !== newTarget,
      replaces,
      fromLaunch: from ? { id: from.id, name: from.name } : null,
      archived,
    });
  }
  return { rows, skipped };
}

/** attachPlan(...).rows — the cards that will attach (halted ones left out). Prefer attachPlan to show the skipped ones. */
export function attachPreview(
  cards: readonly LaunchLinkCard[],
  launch: PdLaunchRef & { skus?: readonly LaunchMemberLike[] | null },
  todayIso: string,
): AttachRow[] {
  return attachPlan(cards, launch, todayIso).rows;
}

// ---------------------------------------------------------------------------
// Move preview (calendar drag, launch form date change)
// ---------------------------------------------------------------------------

export interface MovePreview {
  /** Cards that follow the launch (ordered included): they move with it. */
  moving: LaunchLinkRow[];
  /** Cards on their own date: they stay. */
  staying: LaunchLinkRow[];
  /** The launch's own dates, old -> new (ready-by is the effective one, default included). */
  launch: {
    oldDate: string | null;
    newDate: string | null;
    oldReadyBy: string | null;
    newReadyBy: string | null;
    oldOrderBy: string | null;
    newOrderBy: string | null;
  };
}

/**
 * What moving `launch` to `newLaunchDate` does to its attached cards — the
 * same rules as fn_pd_follow_launch: every card that follows the launch
 * moves to the new date (ordered too); own-date cards never move; a launch
 * cleared to no date moves nobody. Archived cards (frozen) and halted cards
 * (never on a launch) are left out.
 *
 * `next` is the launch as it will be saved. Omitted fields follow the
 * calendar drag (MarketingCalendar handleDrop): a stored ready-by shifts by
 * the same number of days (an empty one stays empty), early access stays.
 * The launch form passes both values it is about to save.
 */
export function movePreview(
  launch: PdLaunchRef,
  newLaunchDate: string | null,
  cards: readonly LaunchLinkCard[],
  todayIso: string,
  next: { inventory_ready_by?: string | null; early_access_date?: string | null } = {},
): MovePreview {
  const oldDate = day(launch.launch_date);
  const newDate = day(newLaunchDate);
  const shiftedReady =
    launch.inventory_ready_by && oldDate && newDate
      ? addDaysIso(day(launch.inventory_ready_by)!, daysBetween(oldDate, newDate))
      : day(launch.inventory_ready_by);
  const moved: PdLaunchRef = {
    ...launch,
    launch_date: newDate,
    inventory_ready_by: next.inventory_ready_by !== undefined ? day(next.inventory_ready_by) : shiftedReady,
    early_access_date: next.early_access_date !== undefined ? day(next.early_access_date) : day(launch.early_access_date),
  };

  const moving: LaunchLinkRow[] = [];
  const staying: LaunchLinkRow[] = [];
  for (const card of cards) {
    if (card.linked_launch_id !== launch.id || card.archived_at || card.stage === "halted") continue;
    const oldTarget = day(card.target_launch_date);
    const base = { id: card.id, name: card.name, stage: card.stage, stageLabel: pdStageLabel(card.stage) };
    if (followsLaunch(card)) {
      const newTarget = newDate ?? oldTarget;
      moving.push({
        ...base,
        oldTarget,
        newTarget,
        oldOrderBy: orderByOf(card, todayIso, launch),
        newOrderBy: orderByOf({ ...card, target_launch_date: newTarget }, todayIso, moved),
        moves: newTarget !== oldTarget,
      });
    } else {
      const ob = orderByOf(card, todayIso, launch);
      staying.push({ ...base, oldTarget, newTarget: oldTarget, oldOrderBy: ob, newOrderBy: ob, moves: false });
    }
  }

  const oldReadyBy = launchReadyBy(launch);
  const newReadyBy = launchReadyBy(moved);
  return {
    moving,
    staying,
    launch: {
      oldDate,
      newDate,
      oldReadyBy,
      newReadyBy,
      oldOrderBy: oldReadyBy ? orderByFromReadyBy(oldReadyBy) : null,
      newOrderBy: newReadyBy ? orderByFromReadyBy(newReadyBy) : null,
    },
  };
}

// ---------------------------------------------------------------------------
// Inbound freight (sea timing)
// ---------------------------------------------------------------------------

/**
 * One freight line as useLaunchInbound returns it: freight_line_items joined
 * to its shipment. Only lines on a shipment whose receipt is NOT confirmed
 * are inbound (the same INBOUND test as fn_pd_evaluate_arrival).
 */
export interface InboundLine {
  sku_id: string | null;
  quantity: number;
  quantity_received: number;
  source_factory_order_item_id: string | null;
  shipment: {
    id: string;
    shipment_number: string;
    eta: string | null;
    status: string;
    receipt_confirmed_at: string | null;
  } | null;
}

/** sku_id -> its inbound lines. Built once per page (useLaunchInbound) and passed to every row. */
export type InboundMap = ReadonlyMap<string, readonly InboundLine[]>;

export const EMPTY_INBOUND: InboundMap = new Map();

/** A line still has units to land: on an unconfirmed shipment, fewer received than booked. */
export function isInboundLine(li: InboundLine): boolean {
  return !!li.sku_id && !!li.shipment && li.shipment.receipt_confirmed_at == null && li.quantity_received < li.quantity;
}

/** Group freight lines by SKU, keeping only the inbound ones. */
export function inboundBySku(lines: readonly InboundLine[]): Map<string, InboundLine[]> {
  const m = new Map<string, InboundLine[]>();
  for (const li of lines) {
    if (!isInboundLine(li)) continue;
    const list = m.get(li.sku_id!) ?? [];
    list.push(li);
    m.set(li.sku_id!, list);
  }
  return m;
}

export interface InboundSummary {
  /** Units still to land (quantity − quantity_received over the inbound lines). */
  units: number;
  /** The latest ETA among the inbound shipments; null when none carries one. */
  eta: string | null;
  /** Shipment numbers, by ETA (undated last), then number. */
  shipments: string[];
}

/**
 * What is on the way for a SKU. When `sourceItemIds` (the SKU's factory
 * order items) is given and at least one inbound line is sourced from them,
 * only those lines count — a restock shipment of the same SKU on another
 * order does not make this order look shipped. Null when nothing is inbound.
 */
export function skuInbound(
  inbound: InboundMap,
  skuId: string | null | undefined,
  sourceItemIds?: ReadonlySet<string> | null,
): InboundSummary | null {
  if (!skuId) return null;
  const all = inbound.get(skuId) ?? [];
  const sourced = sourceItemIds?.size
    ? all.filter((li) => li.source_factory_order_item_id && sourceItemIds.has(li.source_factory_order_item_id))
    : [];
  const lines = sourced.length > 0 ? sourced : all;
  if (lines.length === 0) return null;
  let units = 0;
  let eta: string | null = null;
  const byShipment = new Map<string, string | null>();
  for (const li of lines) {
    units += Math.max(li.quantity - li.quantity_received, 0);
    const e = day(li.shipment?.eta);
    if (e && (!eta || e > eta)) eta = e;
    if (li.shipment) byShipment.set(li.shipment.shipment_number, e);
  }
  const shipments = [...byShipment.entries()]
    .sort((a, b) => (a[1] ?? "9999-12-31").localeCompare(b[1] ?? "9999-12-31") || a[0].localeCompare(b[0]))
    .map(([n]) => n);
  return { units, eta, shipments };
}

/** Every SKU a set of launches lists (member rows and their cards) — the argument for useLaunchInbound. */
export function launchSkuIds(
  launches: readonly { skus: readonly { sku_id: string | null }[]; cards?: readonly { linked_sku_id?: string | null }[] }[],
): string[] {
  const s = new Set<string>();
  for (const l of launches) {
    for (const m of l.skus) if (m.sku_id) s.add(m.sku_id);
    for (const c of l.cards ?? []) if (c.linked_sku_id) s.add(c.linked_sku_id);
  }
  return [...s].sort();
}

/** The factory-order fields incomingDatesBySku reads (use-factory-orders rows and launch card embeds both fit). */
export type IncomingFactoryOrder = Pick<LaunchCardFactoryOrder, "status" | "expected_completion" | "items">;

/** Factory orders still to be made or collected: not shipped, not canceled. */
export function isOpenFactoryOrder(fo: Pick<IncomingFactoryOrder, "status">): boolean {
  return fo.status !== "shipped" && fo.status !== "canceled";
}

/**
 * The one incoming date per SKU the Launches Status chip reads — the SAME
 * date the product rows show, so the chip can never contradict them:
 *   units on inbound freight   the latest ETA among the inbound shipments
 *                              (skuInbound; the Shipped row's date)
 *   nothing shipped yet        the earliest factory due among the open
 *                              factory orders listing the SKU (the item's
 *                              alternate date, else the order's expected
 *                              completion; the Ordered row's date)
 * SKUs with neither are absent. Inbound follows isInboundLine (receipt not
 * confirmed, fewer received than booked), never the shipment's status, so a
 * delivered-but-unchecked shipment still counts as on its way.
 */
export function incomingDatesBySku(
  skuIds: readonly string[],
  inbound: InboundMap,
  factoryOrders: readonly IncomingFactoryOrder[],
): Map<string, string> {
  const m = new Map<string, string>();
  const want = new Set(skuIds);
  const shipped = new Set<string>();
  for (const sku of want) {
    const inb = skuInbound(inbound, sku);
    if (inb && inb.units > 0 && inb.eta) {
      m.set(sku, inb.eta);
      shipped.add(sku);
    }
  }
  for (const fo of factoryOrders) {
    if (!isOpenFactoryOrder(fo)) continue;
    for (const it of fo.items ?? []) {
      if (!it.sku_id || !want.has(it.sku_id) || shipped.has(it.sku_id)) continue;
      const due = day(it.alternate_expected_completion) ?? day(fo.expected_completion);
      if (!due) continue;
      const cur = m.get(it.sku_id);
      if (!cur || due < cur) m.set(it.sku_id, due);
    }
  }
  return m;
}

// ---------------------------------------------------------------------------
// Member state (one product row on a launch)
// ---------------------------------------------------------------------------

/** A launch member row as memberState reads it (use-marketing's MktLaunchMember fits). */
export interface LaunchMemberRow {
  id: string;
  sku_id: string | null;
  planned_name: string | null;
  pd_project_id: string | null;
  limited_qty?: number | null;
  expected_first_30d_units?: number | null;
  product?: { sku: string; product_name: string } | null;
}

/** The factory order embedded on a card (use-marketing's launches query). */
export interface LaunchCardFactoryOrder {
  id: string;
  order_number: string | null;
  status: string;
  expected_completion: string | null;
  items?:
    | readonly {
        id: string;
        sku_id: string;
        quantity_ordered: number;
        quantity_consumed_by_parent?: number | null;
        alternate_expected_completion: string | null;
      }[]
    | null;
}

/** The card behind a member row (use-marketing's MktLaunchCard fits). */
export interface LaunchMemberCard extends LaunchLinkCard {
  ordered_at?: string | null;
  linked_factory_order_id?: string | null;
  factory_order?: LaunchCardFactoryOrder | null;
}

/** The launch memberState / launchHealth read: its dates and its attached cards. */
export type MemberStateLaunch = Pick<PdLaunchRef, "launch_date" | "early_access_date" | "inventory_ready_by"> & {
  id?: string;
  cards: readonly LaunchMemberCard[];
};

export type MemberStateKind = "development" | "ordered" | "shipped" | "arrived" | "halted" | "plain";

/** Chip text per state (development rows show their stage label instead). */
export const MEMBER_STATE_LABEL: Readonly<Record<MemberStateKind, string>> = {
  development: "In development",
  ordered: "Ordered",
  shipped: "Shipped",
  arrived: "Arrived",
  halted: "Halted",
  plain: "",
};

/** Days before the launch deadline inside which an ordered / shipped product reads amber. */
export const TIMING_TIGHT_DAYS = 7;

export interface MemberState {
  kind: MemberStateKind;
  /** Chip text: the stage label for development rows, MEMBER_STATE_LABEL otherwise ("" for plain rows). */
  label: string;
  /** The one date the row shows (Factory due / ETA / Arrived / next deadline); `days` from today. */
  date: { label: string; value: string; days: number } | null;
  risk: RiskDot;
  /** The launch deadline `date` was judged against (ordered: Ship by; shipped: Ready by). slackDays < 0 = late. */
  against: { label: string; value: string; slackDays: number } | null;
  /** Plain words for the row: "Placed Aug 27", "277 of 300 units · 485, 486, AIR-268". */
  detail: string | null;
  /** Development rows: the chain's order-by date. */
  orderBy: string | null;
  /** Units on the way, against the order size when known (shipped rows; plain rows with inbound freight). */
  units: { inbound: number; ordered: number | null } | null;
  /** Inbound shipment numbers, soonest ETA first. */
  shipments: string[];
}

/** Factory due for a SKU on an order: the item's alternate date, else the order's. */
export function factoryDueFor(fo: LaunchCardFactoryOrder | null | undefined, skuId: string | null | undefined): string | null {
  if (!fo) return null;
  const alt = skuId ? fo.items?.find((it) => it.sku_id === skuId && it.alternate_expected_completion)?.alternate_expected_completion : null;
  return day(alt) ?? day(fo.expected_completion);
}

/** Units ordered of a SKU on an order (minus units built into a parent), or null when the order lists none. */
export function orderedUnitsFor(fo: LaunchCardFactoryOrder | null | undefined, skuId: string | null | undefined): number | null {
  if (!fo || !skuId) return null;
  const items = (fo.items ?? []).filter((it) => it.sku_id === skuId);
  if (items.length === 0) return null;
  return items.reduce((n, it) => n + it.quantity_ordered - (it.quantity_consumed_by_parent ?? 0), 0);
}

/** A product's date against a launch deadline: red after it, amber inside TIMING_TIGHT_DAYS, else green. */
export function timingRisk(dateIso: string, deadlineIso: string): { risk: Exclude<RiskDot, null>; slackDays: number } {
  const slackDays = daysBetween(dateIso, deadlineIso);
  return { slackDays, risk: slackDays < 0 ? "r" : slackDays < TIMING_TIGHT_DAYS ? "a" : "g" };
}

const noState = (kind: MemberStateKind, label: string): MemberState => ({
  kind,
  label,
  date: null,
  risk: null,
  against: null,
  detail: null,
  orderBy: null,
  units: null,
  shipments: [],
});

/**
 * How one product row on a launch reads today.
 *
 *  halted      the card is stopped (should not be on the launch; never rated)
 *  arrived     archived with reason 'arrived': green, date = the day it landed, frozen
 *  shipped     an ordered card with units on inbound freight: date = the latest
 *              ETA, judged against the launch's ready-by (red after it, amber
 *              inside 7 days); units booked of ordered
 *  ordered     an ordered card with nothing on the water: date = the factory
 *              due (item alternate date, else the order's expected completion),
 *              judged against the launch's ship-by (ready-by − 35 days);
 *              detail = the day the order was placed (card ordered_at)
 *  development every other card stage: the board's deadline chain and risk dot
 *  plain       a SKU / planned-name row with no card (its chip stays stock-based
 *              on the launch; inbound freight is reported, not rated)
 *
 * A row whose card is not in `launch.cards` (RLS hides cards from non-internal
 * users) reads as plain.
 */
export function memberState(
  row: LaunchMemberRow,
  launch: MemberStateLaunch,
  inbound: InboundMap,
  todayIso: string,
): MemberState {
  const card = row.pd_project_id ? launch.cards.find((c) => c.id === row.pd_project_id) : undefined;
  const skuId = row.sku_id ?? card?.linked_sku_id ?? null;

  if (!card) {
    const inb = skuInbound(inbound, skuId);
    const s = noState("plain", MEMBER_STATE_LABEL.plain);
    if (inb) {
      s.units = { inbound: inb.units, ordered: null };
      s.shipments = inb.shipments;
      s.detail = unitsText(inb.units, null, inb.shipments);
      if (inb.eta) s.date = { label: "ETA", value: inb.eta, days: daysBetween(todayIso, inb.eta) };
    }
    return s;
  }

  if (card.stage === "halted") return noState("halted", MEMBER_STATE_LABEL.halted);

  if (isArrived(card)) {
    const s = noState("arrived", MEMBER_STATE_LABEL.arrived);
    s.risk = "g";
    const landed = day(card.archived_at);
    if (landed) s.date = { label: "Arrived", value: landed, days: daysBetween(todayIso, landed) };
    return s;
  }

  if (card.archived_at) return noState("development", pdStageLabel(card.stage));

  if (card.stage === "ordered") {
    const fo = card.factory_order ?? null;
    const itemIds = new Set((fo?.items ?? []).filter((it) => it.sku_id === skuId).map((it) => it.id));
    const inb = skuInbound(inbound, skuId, itemIds);
    const ordered = orderedUnitsFor(fo, skuId);
    if (inb && inb.units > 0) {
      const s = noState("shipped", MEMBER_STATE_LABEL.shipped);
      s.units = { inbound: inb.units, ordered };
      s.shipments = inb.shipments;
      s.detail = unitsText(inb.units, ordered, inb.shipments);
      if (inb.eta) {
        s.date = { label: "ETA", value: inb.eta, days: daysBetween(todayIso, inb.eta) };
        const readyBy = launchReadyBy(launch);
        if (readyBy) {
          const t = timingRisk(inb.eta, readyBy);
          s.risk = t.risk;
          s.against = { label: "Ready by", value: readyBy, slackDays: t.slackDays };
        }
      }
      return s;
    }
    const s = noState("ordered", MEMBER_STATE_LABEL.ordered);
    const placed = day(card.ordered_at);
    s.detail = placed ? `Placed ${fmtDay(placed)}` : null;
    if (ordered != null) s.units = { inbound: 0, ordered };
    const due = factoryDueFor(fo, skuId);
    if (due) {
      s.date = { label: "Factory due", value: due, days: daysBetween(todayIso, due) };
      const shipBy = launchShipBy(launch);
      if (shipBy) {
        const t = timingRisk(due, shipBy);
        s.risk = t.risk;
        s.against = { label: "Ship by", value: shipBy, slackDays: t.slackDays };
      }
    }
    return s;
  }

  const launchRef: PdLaunchRef = {
    id: launch.id ?? card.linked_launch_id ?? "",
    name: "",
    kind: "",
    launch_date: launch.launch_date,
    early_access_date: launch.early_access_date,
    inventory_ready_by: launch.inventory_ready_by,
  };
  const chain = deadlineChain(card, todayIso, launchRef);
  const next = nextDeadline(chain);
  const s = noState("development", pdStageLabel(card.stage));
  s.orderBy = chain?.find((r) => r.key === "orderBy")?.date ?? null;
  if (next) {
    s.date = { label: next.label, value: next.date, days: next.days };
    s.risk = riskDot(card, todayIso, launchRef);
  }
  return s;
}

function unitsText(inbound: number, ordered: number | null, shipments: readonly string[]): string {
  const head = ordered != null ? `${inbound} of ${ordered} units` : `${inbound} units`;
  return shipments.length > 0 ? `${head} · ${shipments.join(", ")}` : head;
}

// ---------------------------------------------------------------------------
// Stock reading for plain SKU rows (Launches Status chip)
// ---------------------------------------------------------------------------

/** Units a launch needs of a SKU row: its limited quantity, else its expected units, else null (any stock will do). */
export function memberStockNeed(row: Pick<LaunchMemberRow, "limited_qty" | "expected_first_30d_units">): number | null {
  return row.limited_qty ?? row.expected_first_30d_units ?? null;
}

/**
 * Is a SKU row stocked for its launch? On hand must cover its need
 * (memberStockNeed) when one is set, else be above zero — so 2 sample units
 * never read as "stock on hand" for a 200-unit drop.
 */
export function memberStocked(row: Pick<LaunchMemberRow, "limited_qty" | "expected_first_30d_units">, onHand: number): boolean {
  const need = memberStockNeed(row);
  return need != null ? onHand >= need : onHand > 0;
}

// ---------------------------------------------------------------------------
// Product count + Launches page health rollup
// ---------------------------------------------------------------------------

/**
 * Products on a launch: its member rows minus the rows of halted cards — THE
 * definition (rpc_daily_report's sku_count uses the same one). Arrived cards'
 * rows count; plain rows count; a card without a row does not.
 */
export function launchProductCount(launch: {
  skus: readonly Pick<LaunchMemberRow, "pd_project_id">[];
  cards: readonly { id: string; stage?: string }[];
}): number {
  const halted = new Set(launch.cards.filter((c) => c.stage === "halted").map((c) => c.id));
  return launch.skus.filter((m) => !m.pd_project_id || !halted.has(m.pd_project_id)).length;
}

export interface LaunchHealth {
  /** launchProductCount: member rows minus halted cards' rows. */
  count: number;
  /** Rows reading red: an ETA after ready-by, a factory date after ship-by, a passed deadline. */
  late: number;
  /** Rows reading amber. */
  tight: number;
  /** Arrived products (green, frozen). */
  arrived: number;
  /** Worst risk among the rated rows; null when none is rated. */
  worst: RiskDot;
}

export type LaunchHealthInput = MemberStateLaunch & { skus: readonly LaunchMemberRow[] };

/**
 * Health of a launch from its product rows (memberState for each): ordered
 * and shipped rows by their order / sea dates, arrived rows green, halted
 * rows never rated, development rows by the deadline chain, plain rows not
 * rated. `inbound` comes from useLaunchInbound (EMPTY_INBOUND while loading:
 * shipped products then read as ordered).
 *
 * The legacy form launchHealth(cards, todayIso, launch?) rates attached cards
 * by the deadline chain alone (no rows, no inbound); callers should move to
 * the row form.
 */
export function launchHealth(launch: LaunchHealthInput, inbound: InboundMap, todayIso: string): LaunchHealth;
/** @deprecated pass the launch (rows + cards) and the inbound map. */
export function launchHealth(cards: readonly LaunchLinkCard[], todayIso: string, launch?: PdLaunchRef | null): LaunchHealth;
export function launchHealth(
  a: LaunchHealthInput | readonly LaunchLinkCard[],
  b: InboundMap | string,
  c?: string | PdLaunchRef | null,
): LaunchHealth {
  if (Array.isArray(a)) return legacyLaunchHealth(a as readonly LaunchLinkCard[], b as string, c as PdLaunchRef | null | undefined);
  const launch = a as LaunchHealthInput;
  const inbound = b as InboundMap;
  const todayIso = c as string;
  let late = 0;
  let tight = 0;
  let arrived = 0;
  let rated = 0;
  for (const row of launch.skus) {
    const s = memberState(row, launch, inbound, todayIso);
    if (s.kind === "arrived") arrived += 1;
    if (!s.risk) continue;
    rated += 1;
    if (s.risk === "r") late += 1;
    else if (s.risk === "a") tight += 1;
  }
  const worst: RiskDot = late > 0 ? "r" : tight > 0 ? "a" : rated > 0 ? "g" : null;
  return { count: launchProductCount(launch), late, tight, arrived, worst };
}

function legacyLaunchHealth(cards: readonly LaunchLinkCard[], todayIso: string, launch?: PdLaunchRef | null): LaunchHealth {
  let count = 0;
  let late = 0;
  let tight = 0;
  let arrived = 0;
  let rated = 0;
  for (const c of cards) {
    if (c.stage === "halted") continue;
    if (c.archived_at && !isArrived(c)) continue;
    count += 1;
    if (isArrived(c)) {
      arrived += 1;
      rated += 1;
      continue;
    }
    const dot = riskDot(c, todayIso, launch);
    if (!dot) continue;
    rated += 1;
    if (dot === "r") late += 1;
    else if (dot === "a") tight += 1;
  }
  const worst: RiskDot = late > 0 ? "r" : tight > 0 ? "a" : rated > 0 ? "g" : null;
  return { count, late, tight, arrived, worst };
}

/** "no products", "1 product", "4 products · 2 late · 1 tight". */
export function launchHealthText(h: LaunchHealth | Pick<LaunchHealth, "count" | "late" | "tight">): string {
  if (h.count === 0) return "no products";
  const parts = [`${h.count} ${h.count === 1 ? "product" : "products"}`];
  if (h.late > 0) parts.push(`${h.late} late`);
  if (h.tight > 0) parts.push(`${h.tight} tight`);
  return parts.join(" · ");
}

// ---------------------------------------------------------------------------
// Create a launch from a drop
// ---------------------------------------------------------------------------

export interface DropLaunchPrefill {
  name: string;
  /** mkt_launches.kind value (label via the launch form's KINDS map). */
  kind: "studio_drop" | "launch";
  /** The date every ticked, unarchived card in the drop shares, else null. */
  launch_date: string | null;
  /**
   * One entry per card, board order; halted cards start unticked, arrived
   * cards ticked. `target_launch_date` and `sku` are what the form row shows
   * for a card the board does not list (an arrived card: its frozen date).
   */
  products: {
    pd_project_id: string;
    name: string;
    sku_id: string | null;
    sku: string | null;
    stage: string;
    target_launch_date: string | null;
    included: boolean;
    arrived: boolean;
  }[];
}

/**
 * The launch form prefill for "Create launch" on an isolated drop: name
 * "<drop> drop", Studio drop when the cards' category is Studio, the shared
 * target date (ticked, unarchived cards; arrived cards' dates are frozen and
 * only count when no live card has one), and the cards as products — live
 * and arrived ones; cards archived for any other reason are left out. Saved
 * by the launch form with ONE rpc_save_launch whose members carry
 * pd_project_id (the server skips halted cards, so an unticked halted card
 * sent by mistake still gets no row).
 */
export function dropLaunchPrefill(dropTag: string, cards: readonly LaunchLinkCard[]): DropLaunchPrefill {
  const offered = cards.filter((c) => !c.archived_at || isArrived(c));
  const cats = offered.map((c) => c.display_category?.trim()).filter((c): c is string => !!c);
  const kind = cats.length > 0 && cats.every((c) => c.toLowerCase() === "studio") ? "studio_drop" : "launch";
  const products = offered.map((c) => ({
    pd_project_id: c.id,
    name: c.name,
    sku_id: c.linked_sku_id ?? null,
    sku: c.linked_sku?.sku ?? null,
    stage: c.stage,
    target_launch_date: day(c.target_launch_date),
    included: c.stage !== "halted",
    arrived: isArrived(c),
  }));
  const ticked = offered.filter((c) => c.stage !== "halted");
  const datesOf = (list: readonly LaunchLinkCard[]) =>
    new Set(list.map((c) => day(c.target_launch_date)).filter((d): d is string => !!d));
  let dates = datesOf(ticked.filter((c) => !c.archived_at));
  if (dates.size === 0) dates = datesOf(ticked);
  return {
    name: `${dropTag.trim()} drop`,
    kind,
    launch_date: dates.size === 1 ? [...dates][0] : null,
    products,
  };
}

/**
 * An edit-launch save's members, minus card-backed rows whose card no longer
 * has a member row on the launch (detached while the form was open).
 * rpc_save_launch attaches any card-backed member without a row, so sending
 * the stale row would silently re-attach the card. `openedWithCardIds` (the
 * cards that had a row when the form opened) limits the rule to those cards:
 * a card row the form ADDED (a SKU pick that belongs to a card) is kept even
 * though the card has no row yet. Omitted = every card row is subject.
 */
export function keepCurrentCardMembers<M extends { pd_project_id?: string | null }>(
  members: readonly M[],
  currentCardIds: ReadonlySet<string>,
  openedWithCardIds?: ReadonlySet<string>,
): M[] {
  return members.filter(
    (m) =>
      !m.pd_project_id ||
      currentCardIds.has(m.pd_project_id) ||
      (openedWithCardIds != null && !openedWithCardIds.has(m.pd_project_id)),
  );
}

// ---------------------------------------------------------------------------
// Activity + RPC errors
// ---------------------------------------------------------------------------

/** The meta rpc/trigger writes on a 'launch_moved' stage event. */
export function launchMovedDates(meta: unknown): { oldDate: string | null; newDate: string | null } | null {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
  const m = meta as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === "string" && v ? v.slice(0, 10) : null);
  return { oldDate: s(m.old_date), newDate: s(m.new_date) };
}

/** How a launch link changed (fn_pd_launch_moved_event meta.via). */
export type LaunchMovedVia = "attach" | "detach" | "halt" | "form" | "revive" | "follow" | "override";

/** launch id -> launch name, from the launches the caller already holds (unknown ids read as "launch"). */
export type LaunchNameMap = ReadonlyMap<string, string>;

/** Build the id -> name map from any launch list (useLaunches data; a deleted launch simply reads as "launch"). */
export function launchNameMap(launches: readonly { id: string; name: string }[]): LaunchNameMap {
  return new Map(launches.map((l) => [l.id, l.name]));
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

function launchNameIn(names: LaunchNameMap, id: string | null): string {
  return (id && names.get(id)) || "launch";
}

/** " · Nov 5 → Nov 16" when the dates differ (" · Nov 16" when only one is known), else "". */
function dateChange(oldDate: string | null, newDate: string | null): string {
  if (oldDate === newDate) return "";
  if (!oldDate || !newDate) return ` · ${fmtDay(oldDate ?? newDate)}`;
  return ` · ${fmtDay(oldDate)} → ${fmtDay(newDate)}`;
}

/**
 * Plain words for a 'launch_moved' event, by how it happened:
 *   attach    "Added to Northern Lights Studio drop · Nov 5 → Nov 16"
 *             ("Moved to <launch> from <other> …" when it left another launch)
 *   detach    "Removed from <launch>"          (also form / halt / revive)
 *   follow    "Launch moved Nov 5 → Nov 16"
 *   override  "Date set by hand · Nov 16 → Nov 20" / "Back on the launch date · …"
 *   (none)    "Launch moved Nov 5 → Nov 16"    (events older than the via field)
 */
export function launchMovedText(meta: unknown, launchNames: LaunchNameMap = new Map()): string {
  const d = launchMovedDates(meta);
  const m = (meta && typeof meta === "object" && !Array.isArray(meta) ? meta : {}) as Record<string, unknown>;
  const via = str(m.via) as LaunchMovedVia | null;
  const launchName = launchNameIn(launchNames, str(m.launch_id));
  const change = d ? dateChange(d.oldDate, d.newDate) : "";
  switch (via) {
    case "attach": {
      const from = str(m.from_launch_id);
      return from
        ? `Moved to ${launchName} from ${launchNameIn(launchNames, from)}${change}`
        : `Added to ${launchName}${change}`;
    }
    case "detach":
    case "form":
    case "halt":
    case "revive":
      return `Removed from ${launchName}`;
    case "override":
      return `${m.override === false ? "Back on the launch date" : "Date set by hand"}${change}`;
    case "follow":
    default:
      return d && (d.oldDate || d.newDate) ? `Launch moved ${fmtDay(d.oldDate)} → ${fmtDay(d.newDate)}` : "Launch moved";
  }
}

/** The stage-event fields pdActivityText reads. */
export interface PdActivityEvent {
  outcome: string;
  from_stage: string | null;
  to_stage: string | null;
  reason: string | null;
  meta: unknown;
}

/**
 * Plain Activity text for the launch-link and arrival events; null for every
 * other outcome (the card sheet keeps its own wording for advance / recycle /
 * kill / link_fo).
 *   launch_moved  launchMovedText
 *   restore       "Restored to Ordered · Samples only: 2 of 200 arrived"
 *   link_sku      "Linked to SKU S04-NB2"
 *   archive       "Arrived" / "Marked arrived · <note>" (reason 'arrived'); null otherwise
 */
export function pdActivityText(e: PdActivityEvent, launchNames: LaunchNameMap = new Map()): string | null {
  const m = (e.meta && typeof e.meta === "object" && !Array.isArray(e.meta) ? e.meta : {}) as Record<string, unknown>;
  const reason = e.reason ? ` · ${e.reason}` : "";
  switch (e.outcome) {
    case "launch_moved":
      return launchMovedText(e.meta, launchNames);
    case "restore":
      return `Restored to ${pdStageLabel(e.to_stage ?? e.from_stage ?? "")}${reason}`;
    case "link_sku": {
      const sku = str(m.sku);
      return sku ? `Linked to SKU ${sku}` : "Linked to SKU";
    }
    case "archive": {
      if (e.reason !== "arrived") return null;
      if (m.manual === true) {
        const note = str(m.note);
        return note ? `Marked arrived · ${note}` : "Marked arrived";
      }
      return "Arrived";
    }
    default:
      return null;
  }
}

/** Plain-language messages for the attach / detach / override / link-SKU / mark-arrived RPC error codes. */
export const LAUNCH_LINK_ERROR_LABEL: Record<string, string> = {
  internal_only: "Only internal users can change a card's launch.",
  admin_or_manager_required: "Only an admin or manager can do this.",
  nothing_to_attach: "Pick a launch and at least one card.",
  launch_not_found: "That launch no longer exists.",
  project_not_found: "A card in this drop no longer exists.",
  not_found: "That card no longer exists.",
  not_attached: "This card is not attached to a launch.",
  override_required: "Choose the launch date or the card's own date.",
  archived: "This card is archived; its dates are frozen.",
  already_linked: "This card already has a SKU.",
  sku_required: "Pick a SKU.",
  sku_not_found: "That SKU no longer exists.",
  sku_owned_by_other_card: "Another card already owns that SKU.",
  not_ordered: "Only an ordered card can be marked arrived.",
  already_archived: "This card is already archived.",
};

export function launchLinkErrorMessage(code: string | null | undefined): string {
  return (code && LAUNCH_LINK_ERROR_LABEL[code]) || "The launch link could not be saved.";
}
