/**
 * Product Development — pure helpers for the launch chip, the launch picker
 * and the drop actions (attach / create launch). No hooks, no Date.now():
 * "today" always arrives as an ISO date.
 */
import { dropLaunchPrefill, launchSuggestion, upcomingLaunches, type LaunchLinkCard } from "@/lib/marketing/launch-link";
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
  /** The launch whose name best matches the drop tag (shown only when it passes the type-ahead). */
  suggested: L | null;
  /** Upcoming launches matching the type-ahead, soonest first, suggestion removed. */
  upcoming: L[];
  /** The drop has a tag and no upcoming launch matches it: offer "Create launch". */
  offerCreate: boolean;
}

/** What the launch picker lists for a type-ahead query and a card's drop tag. */
export function launchPickerSections<L extends PickerLaunch>(
  launches: readonly L[],
  opts: { query: string; dropTag: string | null | undefined; todayIso: string },
): LaunchPickerSections<L> {
  const up = upcomingLaunches(launches, opts.todayIso);
  const match = launchSuggestion(opts.dropTag, up);
  const q = opts.query.trim().toLowerCase();
  const hit = (l: L) => !q || l.name.toLowerCase().includes(q);
  const suggested = match && hit(match) ? match : null;
  return {
    suggested,
    upcoming: up.filter((l) => hit(l) && l.id !== suggested?.id),
    offerCreate: !!opts.dropTag?.trim() && !match,
  };
}

/** Where a drop's cards stand against launches. */
export interface DropLaunchState {
  /** Every live card is attached to this one launch. */
  shared: PdLaunchRef | null;
  /** At least one live card is attached to some launch. */
  anyAttached: boolean;
  /** Live (unarchived) cards. */
  count: number;
}

export function dropLaunchState(
  cards: readonly Pick<LaunchLinkCard, "linked_launch_id" | "launch" | "archived_at">[],
): DropLaunchState {
  const live = cards.filter((c) => !c.archived_at);
  const ids = new Set(live.map((c) => c.linked_launch_id ?? null));
  const anyAttached = live.some((c) => !!c.linked_launch_id);
  const onlyId = ids.size === 1 ? [...ids][0] : null;
  const shared = onlyId ? (live.find((c) => c.launch?.id === onlyId)?.launch ?? null) : null;
  return { shared, anyAttached, count: live.length };
}

/** LaunchFormDialog's `prefill` for "Create launch" on a drop. */
export type LaunchFormPrefill = LaunchFormPrefillInput;

/** Name "<drop> drop", Studio drop / Launch, the cards' shared date, the cards as products (halted unticked). */
export function launchFormPrefill(dropTag: string, cards: readonly LaunchLinkCard[]): LaunchFormPrefill {
  const p = dropLaunchPrefill(dropTag, cards);
  return {
    name: p.name,
    kind: p.kind,
    launchDate: p.launch_date,
    members: p.products.map((x) => ({ pd_project_id: x.pd_project_id, planned_name: x.name, included: x.included })),
  };
}

/** "1 card" / "4 cards". */
export function cardCount(n: number): string {
  return `${n} ${n === 1 ? "card" : "cards"}`;
}
