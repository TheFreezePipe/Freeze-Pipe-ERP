import { describe, expect, it } from "vitest";
import type { PdLaunchRef } from "@/lib/marketing/pd";
import type { LaunchLinkCard } from "@/lib/marketing/launch-link";
import {
  cardCount,
  dropLaunchState,
  dropOnUpcomingLaunch,
  dropPillText,
  isDropProduct,
  launchChipText,
  launchFormPrefill,
  launchPickerSections,
} from "./pd-launch-utils";

const TODAY = "2026-09-29";

const L = (id: string, name: string, launch_date: string | null): PdLaunchRef => ({
  id,
  name,
  kind: "studio_drop",
  launch_date,
  early_access_date: null,
  inventory_ready_by: null,
});

const heady = L("l-heady", "Studio Heady drop 006", "2027-01-21");
const mini = L("l-mini", "Mini Bong Ultimate", "2026-11-01");
const alien = L("l-alien", "Alien Studio Drop 008", "2027-04-05");
const past = L("l-past", "Heady Studio drop 001", "2026-03-01");
const launches = [heady, mini, alien, past];

const card = (over: Partial<LaunchLinkCard> & { id: string }): LaunchLinkCard => ({
  name: over.id,
  stage: "ready_to_begin",
  target_launch_date: "2027-01-15",
  spec_sent_at: null,
  linked_launch_id: null,
  launch_date_override: false,
  launch: null,
  drop_tag: "Heady Studio",
  display_category: "Studio",
  linked_sku_id: null,
  archived_at: null,
  archive_reason: null,
  ...over,
});

const arrived = (over: Partial<LaunchLinkCard> & { id: string }): LaunchLinkCard =>
  card({ stage: "ordered", archived_at: "2026-09-22T10:00:00Z", archive_reason: "arrived", ...over });

describe("launchChipText / cardCount", () => {
  it("chip is name · date, or the name alone when undated", () => {
    expect(launchChipText(heady)).toBe("Studio Heady drop 006 · Jan 21, 2027");
    expect(launchChipText(L("x", "Someday", null))).toBe("Someday");
  });
  it("counts cards", () => {
    expect(cardCount(1)).toBe("1 card");
    expect(cardCount(4)).toBe("4 cards");
  });
});

describe("launchPickerSections", () => {
  it("suggests the upcoming launch matching the drop, lists the rest soonest first, past launches hidden", () => {
    const s = launchPickerSections(launches, { query: "", dropTag: "Heady Studio", todayIso: TODAY });
    expect(s.suggested?.id).toBe("l-heady");
    expect(s.upcoming.map((l) => l.id)).toEqual(["l-mini", "l-alien"]);
    expect(s.offerCreate).toBe(false);
  });
  it("offers Create when the drop matches no upcoming launch", () => {
    const s = launchPickerSections(launches, { query: "", dropTag: "Q4 Studio", todayIso: TODAY });
    expect(s.suggested).toBeNull();
    expect(s.upcoming).toHaveLength(3);
    expect(s.offerCreate).toBe(true);
  });
  it("a launch already carrying a card of the drop is suggested first and hides Create, whatever its name", () => {
    const s = launchPickerSections(launches, {
      query: "",
      dropTag: "Q4 Studio",
      todayIso: TODAY,
      dropCards: [card({ id: "a", linked_launch_id: mini.id }), card({ id: "b" })],
    });
    expect(s.suggested?.id).toBe("l-mini");
    expect(s.upcoming.map((l) => l.id)).toEqual(["l-heady", "l-alien"]);
    expect(s.offerCreate).toBe(false);
  });
  it("a halted card's launch does not count as carrying the drop", () => {
    const s = launchPickerSections(launches, {
      query: "",
      dropTag: "Q4 Studio",
      todayIso: TODAY,
      dropCards: [card({ id: "a", stage: "halted", linked_launch_id: mini.id })],
    });
    expect(s.suggested).toBeNull();
    expect(s.offerCreate).toBe(true);
  });
  it("no drop tag: no suggestion, no Create", () => {
    const s = launchPickerSections(launches, { query: "", dropTag: null, todayIso: TODAY });
    expect(s.suggested).toBeNull();
    expect(s.offerCreate).toBe(false);
  });
  it("type-ahead filters both the suggestion and the list", () => {
    const s = launchPickerSections(launches, { query: "alien", dropTag: "Heady Studio", todayIso: TODAY });
    expect(s.suggested).toBeNull();
    expect(s.upcoming.map((l) => l.id)).toEqual(["l-alien"]);
    expect(s.offerCreate).toBe(false);
    const h = launchPickerSections(launches, { query: "heady", dropTag: "Heady Studio", todayIso: TODAY });
    expect(h.suggested?.id).toBe("l-heady");
    expect(h.upcoming).toEqual([]);
  });
});

describe("isDropProduct", () => {
  it("live cards and arrived cards are products; halted and otherwise-archived cards are not", () => {
    expect(isDropProduct(card({ id: "a" }))).toBe(true);
    expect(isDropProduct(arrived({ id: "b" }))).toBe(true);
    expect(isDropProduct(card({ id: "c", stage: "halted" }))).toBe(false);
    expect(isDropProduct(card({ id: "d", archived_at: "2026-09-01T00:00:00Z", archive_reason: "shelved" }))).toBe(false);
  });
});

describe("dropLaunchState", () => {
  it("unattached drop", () => {
    expect(dropLaunchState([card({ id: "a" }), card({ id: "b" })])).toEqual({
      shared: null,
      anyAttached: false,
      launchIds: [],
      count: 2,
      ordered: 0,
      arrived: 0,
      halted: 0,
    });
  });
  it("every product on one launch shares it", () => {
    const s = dropLaunchState([
      card({ id: "a", linked_launch_id: heady.id, launch: heady }),
      card({ id: "b", linked_launch_id: heady.id, launch: heady, launch_date_override: true }),
    ]);
    expect(s.shared?.id).toBe("l-heady");
    expect(s.anyAttached).toBe(true);
    expect(s.launchIds).toEqual(["l-heady"]);
  });
  it("mixed drop: nothing shared, but attached", () => {
    const s = dropLaunchState([card({ id: "a", linked_launch_id: heady.id, launch: heady }), card({ id: "b" })]);
    expect(s.shared).toBeNull();
    expect(s.anyAttached).toBe(true);
  });
  it("a halted sibling never breaks the shared launch and is counted apart (Q4 Studio: 3 of 3 ordered · 1 halted)", () => {
    const s = dropLaunchState([
      card({ id: "nb2", stage: "ordered", linked_launch_id: mini.id, launch: mini }),
      card({ id: "nb6", stage: "ordered", linked_launch_id: mini.id, launch: mini }),
      card({ id: "bw20dna", stage: "ordered", linked_launch_id: mini.id, launch: mini }),
      card({ id: "bw20", stage: "halted" }),
    ]);
    expect(s.shared?.id).toBe("l-mini");
    expect(s.count).toBe(3);
    expect(s.ordered).toBe(3);
    expect(s.halted).toBe(1);
    expect(dropPillText("Q4 Studio", s)).toBe("Q4 Studio · 3 of 3 ordered · 1 halted");
  });
  it("arrived cards are products (ordered, on their launch) and counted separately; other archived cards are ignored", () => {
    const s = dropLaunchState([
      card({ id: "a", stage: "ordered", linked_launch_id: heady.id, launch: heady }),
      arrived({ id: "b", linked_launch_id: heady.id, launch: heady }),
      card({ id: "c", archived_at: "2026-09-01T00:00:00Z", archive_reason: "shelved" }),
    ]);
    expect(s.shared?.id).toBe("l-heady");
    expect(s.count).toBe(2);
    expect(s.ordered).toBe(2);
    expect(s.arrived).toBe(1);
    expect(dropPillText("Heady Studio", s)).toBe("Heady Studio · 2 of 2 ordered · 1 arrived");
  });
});

describe("dropOnUpcomingLaunch", () => {
  it("true only when a carried launch is upcoming", () => {
    const up = dropLaunchState([card({ id: "a", linked_launch_id: heady.id, launch: heady })]);
    expect(dropOnUpcomingLaunch(up, launches, TODAY)).toBe(true);
    const gone = dropLaunchState([arrived({ id: "a", linked_launch_id: past.id, launch: past })]);
    expect(dropOnUpcomingLaunch(gone, launches, TODAY)).toBe(false);
    expect(dropOnUpcomingLaunch(dropLaunchState([card({ id: "a" })]), launches, TODAY)).toBe(false);
  });
});

describe("launchFormPrefill", () => {
  it("maps the drop into the launch form prefill (halted unticked, shared date, studio kind)", () => {
    const p = launchFormPrefill("Q4 Studio", [
      card({ id: "a", name: "Q4 Studio - NB2", target_launch_date: "2026-11-05" }),
      card({ id: "b", name: "Q4 Studio - BW20", stage: "halted", target_launch_date: "2026-12-01" }),
    ]);
    expect(p).toEqual({
      name: "Q4 Studio drop",
      kind: "studio_drop",
      launchDate: "2026-11-05",
      members: [
        {
          pd_project_id: "a",
          planned_name: "Q4 Studio - NB2",
          included: true,
          stage: "ready_to_begin",
          arrived: false,
          target_launch_date: "2026-11-05",
          sku: null,
        },
        {
          pd_project_id: "b",
          planned_name: "Q4 Studio - BW20",
          included: false,
          stage: "halted",
          arrived: false,
          target_launch_date: "2026-12-01",
          sku: null,
        },
      ],
    });
  });
  it("an arrived card is offered: ticked when it rides no launch, unticked when it already does", () => {
    const p = launchFormPrefill("Q4 Studio", [
      card({ id: "a", name: "NB2", target_launch_date: "2026-11-05" }),
      arrived({ id: "b", name: "NB6", target_launch_date: "2026-11-05" }),
      arrived({ id: "c", name: "BW20DNA", target_launch_date: "2026-11-05", linked_launch_id: past.id, launch: past }),
    ]);
    expect(p.members.map((m) => [m.pd_project_id, m.included])).toEqual([
      ["a", true],
      ["b", true],
      ["c", false],
    ]);
  });
  it("an arrived card's member carries the card facts the form row shows: Arrived, its frozen target, its SKU", () => {
    const p = launchFormPrefill("Q4 Studio", [
      card({ id: "a", name: "NB2", target_launch_date: "2026-11-16" }),
      arrived({
        id: "b",
        name: "NB6",
        target_launch_date: "2026-11-05",
        linked_sku_id: "sku-nb6",
        linked_sku: { sku: "S04-NB6" },
      }),
    ]);
    // The live card sets the launch date; the arrived card keeps its own, frozen.
    expect(p.launchDate).toBe("2026-11-16");
    expect(p.members[1]).toEqual({
      pd_project_id: "b",
      planned_name: "NB6",
      included: true,
      stage: "ordered",
      arrived: true,
      target_launch_date: "2026-11-05",
      sku: "S04-NB6",
    });
    expect(p.members[0]).toMatchObject({ arrived: false, stage: "ready_to_begin", sku: null });
  });
  it("non-studio cards make a plain launch; differing dates leave the date empty", () => {
    const p = launchFormPrefill("Puffco", [
      card({ id: "a", display_category: "Accessories", target_launch_date: "2027-05-25" }),
      card({ id: "b", display_category: "Accessories", target_launch_date: "2027-06-01" }),
    ]);
    expect(p.kind).toBe("launch");
    expect(p.launchDate).toBeNull();
  });
});
