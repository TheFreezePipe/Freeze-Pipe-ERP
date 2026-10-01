/**
 * Product Development — pure helpers for the launch chip, the launch picker
 * and the drop actions (attach / create launch). No hooks, no Date.now():
 * "today" always arrives as an ISO date.
 *
 * Owner rules (launch-product-rules, 2026-09-30): a drop's products are its
 * live cards minus the halted ones, plus its arrived cards (they stay on
 * their launch, frozen); halted cards never ride a launch; the launch that
 * already carries a card of the drop is the drop's launch, so "Create
 * launch" is hidden while an upcoming launch carries one.
 */
import {
  dropLaunchPrefill,
  isArrived,
  launchSuggestion,
  upcomingLaunches,
  type DropCardRef,
  type LaunchLinkCard,
} from "@/lib/marketing/launch-link";
import type { PdLaunchRef } from "@/lib/marketing/pd";
import { fmtDayLong } from "@/components/marketing/launch-format";
import type { LaunchFormPrefillInput } from "@/components/marketing/LaunchFormDialog";

/** Violet launch chip classes (sheet header, drop pill). */
export const LAUNCH_CHIP_CLASS =
  "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-violet-400 px-2 py-0.5 text-xs font-medium text-violet-300 hover:bg-violet-500/10";
export const LAUNCH_DOT_CLASS = "h-2 w-2 shrink-0 rounded-full bg-violet-400";

/** Launch chip text: "Studio Heady drop 006 · Jan 21, 2027" (name only when undated). */
export function launchChipText(launch: Pick<PdLaunchRef, "name" | "launch_date">): string {
  return launch.launch_date ? `${launch.name} · ${fmtDayLong(launch.launch_date)}` : launch.name;
}

type PickerLaunch = Pick<PdLaunchRef, "id" | "name" | "launch_date">;

export interface LaunchPickerSections<L extends PickerLaunch> {
  /** The launch the drop means — the upcoming one already carrying a card of the drop, else the best name match (shown only when it passes the type-ahead). */
  suggested: L | null;
  /** Upcoming launches matching the type-ahead, soonest first, suggestion removed. */
  upcoming: L[];
  /** The drop has a tag and no upcoming launch carries it or matches it: offer "Create launch". */
  offerCreate: boolean;
}

/**
 * What the launch picker lists for a type-ahead query and a card's drop tag.
 * Pass the drop's cards (`dropCards`, from usePdDropCards or the board) so a
 * launch that already carries one of them is suggested first and Create is
 * never offered beside it.
 */
export function launchPickerSections<L extends PickerLaunch>(
  launches: readonly L[],
  opts: { query: string; dropTag: string | null | undefined; todayIso: string; dropCards?: readonly DropCardRef[] },
): LaunchPickerSections<L> {
  const up = upcomingLaunches(launches, opts.todayIso);
  const match = launchSuggestion(opts.dropTag, up, opts.dropCards);
  const q = opts.query.trim().toLowerCase();
  const hit = (l: L) => !q || l.name.toLowerCase().includes(q);
  const suggested = match && hit(match) ? match : null;
  return {
    suggested,
    upcoming: up.filter((l) => hit(l) && l.id !== suggested?.id),
    offerCreate: !!opts.dropTag?.trim() && !match,
  };
}

/** The card fields the drop pill and its actions read (board rows and usePdDropCards rows both fit). */
export type DropStateCard = Pick<LaunchLinkCard, "linked_launch_id" | "launch" | "archived_at" | "archive_reason" | "stage">;

/** Where a drop's cards stand against launches, and what the pill counts. */
export interface DropLaunchState {
  /** Every product card is attached to this one launch. */
  shared: PdLaunchRef | null;
  /** At least one product card is attached to some launch. */
  anyAttached: boolean;
  /** The launches the drop's product cards ride (distinct). */
  launchIds: string[];
  /** Products: live cards minus halted ones, plus arrived cards. */
  count: number;
  /** Products in Ordered (arrived ones included — they were ordered and landed). */
  ordered: number;
  /** Products archived as arrived. */
  arrived: number;
  /** Halted cards (never products, never on a launch). */
  halted: number;
}

/** A card the drop counts as a product: live and not halted, or archived as arrived. */
export function isDropProduct(card: Pick<DropStateCard, "stage" | "archived_at" | "archive_reason">): boolean {
  if (card.stage === "halted") return false;
  return !card.archived_at || isArrived(card);
}

export function dropLaunchState(cards: readonly DropStateCard[]): DropLaunchState {
  const products = cards.filter(isDropProduct);
  const ids = new Set(products.map((c) => c.linked_launch_id ?? null));
  const anyAttached = products.some((c) => !!c.linked_launch_id);
  const onlyId = products.length > 0 && ids.size === 1 ? [...ids][0] : null;
  const shared = onlyId ? (products.find((c) => c.launch?.id === onlyId)?.launch ?? null) : null;
  return {
    shared,
    anyAttached,
    launchIds: [...new Set(products.map((c) => c.linked_launch_id).filter((id): id is string => !!id))],
    count: products.length,
    ordered: products.filter((c) => c.stage === "ordered").length,
    arrived: products.filter((c) => isArrived(c)).length,
    halted: cards.filter((c) => c.stage === "halted").length,
  };
}

/** The board pill: "Q4 Studio · 3 of 3 ordered · 1 arrived · 1 halted" (arrived / halted only when any). */
export function dropPillText(tag: string, state: Pick<DropLaunchState, "count" | "ordered" | "arrived" | "halted">): string {
  const parts = [tag, `${state.ordered} of ${state.count} ordered`];
  if (state.arrived > 0) parts.push(`${state.arrived} arrived`);
  if (state.halted > 0) parts.push(`${state.halted} halted`);
  return parts.join(" · ");
}

/** An upcoming launch (dated today or later, or undated) already carries a product of the drop: "Create launch" is hidden. */
export function dropOnUpcomingLaunch(
  state: Pick<DropLaunchState, "launchIds">,
  launches: readonly PickerLaunch[],
  todayIso: string,
): boolean {
  if (state.launchIds.length === 0) return false;
  const up = new Set(upcomingLaunches(launches, todayIso).map((l) => l.id));
  return state.launchIds.some((id) => up.has(id));
}

/** LaunchFormDialog's `prefill` for "Create launch" on a drop. */
export type LaunchFormPrefill = LaunchFormPrefillInput;

/**
 * Name "<drop> drop", Studio drop / Launch, the cards' shared date, the cards
 * as products: halted unticked; an arrived card that already rides a launch
 * starts unticked too (it stays where it landed — a new launch is not a
 * reason to pull it over). Every member carries the card's stage, arrived
 * flag, target date and SKU code: the form's board rows do not list arrived
 * cards, so these are what its row shows (Arrived chip, frozen date).
 */
export function launchFormPrefill(dropTag: string, cards: readonly LaunchLinkCard[]): LaunchFormPrefill {
  const p = dropLaunchPrefill(dropTag, cards);
  const onLaunch = new Set(cards.filter((c) => !!c.linked_launch_id).map((c) => c.id));
  return {
    name: p.name,
    kind: p.kind,
    launchDate: p.launch_date,
    members: p.products.map((x) => ({
      pd_project_id: x.pd_project_id,
      planned_name: x.name,
      included: x.included && !(x.arrived && onLaunch.has(x.pd_project_id)),
      stage: x.stage,
      arrived: x.arrived,
      target_launch_date: x.target_launch_date,
      sku: x.sku,
    })),
  };
}

/** "1 card" / "4 cards". */
export function cardCount(n: number): string {
  return `${n} ${n === 1 ? "card" : "cards"}`;
}
