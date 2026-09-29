/**
 * PD cards attached to launches — pure logic for the launch picker, the
 * attach / add-products confirm, the move-a-launch confirm and the Launches
 * page health chip. The database is the enforcer (migration
 * 20260928000001_pd_launch_attach.sql: rpc_pd_attach_launch,
 * trg_pd_follow_launch, trg_pd_launch_date_guard); these previews follow the
 * same rules so a confirm dialog shows exactly what the save will do.
 */
import { addDaysIso, daysBetween, orderByFromReadyBy } from "./workback";
import {
  deadlineChain,
  followsLaunch,
  launchReadyBy,
  pdStageLabel,
  riskDot,
  type PdChainCard,
  type PdLaunchRef,
  type RiskDot,
} from "./pd";

export { followsLaunch, launchReadyBy, launchOrderBy, pdStageLabel } from "./pd";

/** A card as the launch-link previews read it (board rows and launch embeds both fit). */
export interface LaunchLinkCard extends PdChainCard {
  id: string;
  name: string;
  drop_tag?: string | null;
  display_category?: string | null;
  linked_sku_id?: string | null;
  archived_at?: string | null;
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

/**
 * The launch whose name best matches a drop tag, or null. Generic words
 * (studio, drop, launch, ...) are ignored; at least half of the tag's
 * remaining words must appear in the launch name. Ties break on an exact
 * name match, then the larger share and count of matched words, then the
 * fewest extra words in the launch name, then the earliest launch date
 * (undated last), then name and id — so the pick is deterministic.
 * Pass the launches the picker offers (e.g. upcomingLaunches()).
 */
export function launchSuggestion<L extends Pick<PdLaunchRef, "id" | "name" | "launch_date">>(
  dropTag: string | null | undefined,
  launches: readonly L[],
): L | null {
  const tag = dropTag?.trim();
  if (!tag) return null;
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
}

const lowerTrim = (s: string | null | undefined) => (s == null ? null : s.trim().toLowerCase());

/**
 * What attaching `cards` to `launch` does, card by card, in the RPC's order
 * (duplicates dropped, first one wins). Each card ends up following the
 * launch: target = the launch date (kept when the launch is undated), order
 * by from the launch's ready-by. `replaces` mirrors rpc_pd_attach_launch's
 * member rules: a card already on the launch keeps its row; a promoted card
 * claims a plain row carrying its SKU; otherwise it claims the earliest
 * placeholder (no SKU, no card) named like its drop tag or its own name.
 * Pass the launch's member rows (`launch.skus`) to get `replaces`.
 */
export function attachPreview(
  cards: readonly LaunchLinkCard[],
  launch: PdLaunchRef & { skus?: readonly LaunchMemberLike[] | null },
  todayIso: string,
): AttachRow[] {
  const members = [...(launch.skus ?? [])]
    .sort(
      (a, b) =>
        a.sort_order - b.sort_order || (a.created_at ?? "").localeCompare(b.created_at ?? "") || a.id.localeCompare(b.id),
    )
    .map((m) => ({ ...m }));
  const seen = new Set<string>();
  const rows: AttachRow[] = [];
  for (const card of cards) {
    if (seen.has(card.id)) continue;
    seen.add(card.id);

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

    const oldTarget = day(card.target_launch_date);
    const newTarget = day(launch.launch_date) ?? oldTarget;
    const attached: PdChainCard = {
      stage: card.stage,
      spec_sent_at: card.spec_sent_at,
      target_launch_date: newTarget,
      linked_launch_id: launch.id,
      launch_date_override: false,
    };
    const from = card.linked_launch_id && card.linked_launch_id !== launch.id ? card.launch ?? null : null;
    rows.push({
      id: card.id,
      name: card.name,
      stage: card.stage,
      stageLabel: pdStageLabel(card.stage),
      oldTarget,
      newTarget,
      oldOrderBy: orderByOf(card, todayIso),
      newOrderBy: orderByOf(attached, todayIso, launch),
      moves: oldTarget !== newTarget,
      replaces,
      fromLaunch: from ? { id: from.id, name: from.name } : null,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Move preview (calendar drag, launch form date change)
// ---------------------------------------------------------------------------

export interface MovePreview {
  /** Cards that follow the launch (ordered and halted included): they move with it. */
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
 * same rules as trg_pd_follow_launch: every card that follows the launch
 * moves to the new date (ordered and halted too); own-date cards never move;
 * a launch cleared to no date moves nobody. Archived cards are left out.
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
    if (card.linked_launch_id !== launch.id || card.archived_at) continue;
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
// Launches page health rollup
// ---------------------------------------------------------------------------

export interface LaunchHealth {
  /** Attached cards (archived left out). */
  count: number;
  /** Risk dot red (next deadline passed). Halted cards are not rated. */
  late: number;
  /** Risk dot amber (next deadline inside 14 days). */
  tight: number;
  /** Worst risk dot among the rated cards; null when none has a chain. */
  worst: RiskDot;
}

/**
 * Health of a launch's attached cards from the board's own risk dot.
 * `launch` defaults to each card's embedded launch.
 */
export function launchHealth(
  cards: readonly LaunchLinkCard[],
  todayIso: string,
  launch?: PdLaunchRef | null,
): LaunchHealth {
  let count = 0;
  let late = 0;
  let tight = 0;
  let rated = 0;
  for (const c of cards) {
    if (c.archived_at) continue;
    count += 1;
    if (c.stage === "halted") continue;
    const dot = riskDot(c, todayIso, launch);
    if (!dot) continue;
    rated += 1;
    if (dot === "r") late += 1;
    else if (dot === "a") tight += 1;
  }
  const worst: RiskDot = late > 0 ? "r" : tight > 0 ? "a" : rated > 0 ? "g" : null;
  return { count, late, tight, worst };
}

/** "no products", "1 product", "4 products · 2 late · 1 tight". */
export function launchHealthText(h: LaunchHealth): string {
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
  /** The date every dated card in the drop shares, else null. */
  launch_date: string | null;
  /** One entry per card, board order; halted cards start unticked. */
  products: { pd_project_id: string; name: string; sku_id: string | null; stage: string; included: boolean }[];
}

/**
 * The launch form prefill for "Create launch" on an isolated drop: name
 * "<drop> drop", Studio drop when the cards' category is Studio, the shared
 * target date (ticked cards only), and the cards as products. Saved by the
 * launch form with ONE rpc_save_launch whose members carry pd_project_id.
 */
export function dropLaunchPrefill(dropTag: string, cards: readonly LaunchLinkCard[]): DropLaunchPrefill {
  const live = cards.filter((c) => !c.archived_at);
  const cats = live.map((c) => c.display_category?.trim()).filter((c): c is string => !!c);
  const kind = cats.length > 0 && cats.every((c) => c.toLowerCase() === "studio") ? "studio_drop" : "launch";
  const products = live.map((c) => ({
    pd_project_id: c.id,
    name: c.name,
    sku_id: c.linked_sku_id ?? null,
    stage: c.stage,
    included: c.stage !== "halted",
  }));
  const dates = new Set(
    live.filter((c) => c.stage !== "halted").map((c) => day(c.target_launch_date)).filter((d): d is string => !!d),
  );
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
 * the stale row would silently re-attach the card.
 */
export function keepCurrentCardMembers<M extends { pd_project_id?: string | null }>(
  members: readonly M[],
  currentCardIds: ReadonlySet<string>,
): M[] {
  return members.filter((m) => !m.pd_project_id || currentCardIds.has(m.pd_project_id));
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

/** Plain-language messages for the attach / detach / override RPC error codes. */
export const LAUNCH_LINK_ERROR_LABEL: Record<string, string> = {
  internal_only: "Only internal users can change a card's launch.",
  nothing_to_attach: "Pick a launch and at least one card.",
  launch_not_found: "That launch no longer exists.",
  project_not_found: "A card in this drop no longer exists.",
  not_found: "That card no longer exists.",
  not_attached: "This card is not attached to a launch.",
  override_required: "Choose the launch date or the card's own date.",
};

export function launchLinkErrorMessage(code: string | null | undefined): string {
  return (code && LAUNCH_LINK_ERROR_LABEL[code]) || "The launch link could not be saved.";
}
