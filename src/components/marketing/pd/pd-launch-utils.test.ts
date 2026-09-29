import { describe, expect, it } from "vitest";
import type { PdLaunchRef } from "@/lib/marketing/pd";
import type { LaunchLinkCard } from "@/lib/marketing/launch-link";
import {
  cardCount,
  dropLaunchState,
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
  ...over,
});

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

describe("dropLaunchState", () => {
  it("unattached drop", () => {
    expect(dropLaunchState([card({ id: "a" }), card({ id: "b" })])).toEqual({ shared: null, anyAttached: false, count: 2 });
  });
  it("every card on one launch shares it", () => {
    const s = dropLaunchState([
      card({ id: "a", linked_launch_id: heady.id, launch: heady }),
      card({ id: "b", linked_launch_id: heady.id, launch: heady, launch_date_override: true }),
    ]);
    expect(s.shared?.id).toBe("l-heady");
    expect(s.anyAttached).toBe(true);
  });
  it("mixed drop: nothing shared, but attached", () => {
    const s = dropLaunchState([card({ id: "a", linked_launch_id: heady.id, launch: heady }), card({ id: "b" })]);
    expect(s.shared).toBeNull();
    expect(s.anyAttached).toBe(true);
  });
  it("archived cards are ignored", () => {
    const s = dropLaunchState([
      card({ id: "a", linked_launch_id: heady.id, launch: heady }),
      card({ id: "b", archived_at: "2026-09-01T00:00:00Z" }),
    ]);
    expect(s.shared?.id).toBe("l-heady");
    expect(s.count).toBe(1);
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
        { pd_project_id: "a", planned_name: "Q4 Studio - NB2", included: true },
        { pd_project_id: "b", planned_name: "Q4 Studio - BW20", included: false },
      ],
    });
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
