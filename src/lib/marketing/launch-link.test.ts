import { describe, it, expect } from "vitest";
import { orderByFromReadyBy } from "./workback";
import { deadlineChain, riskDot, cardFlags, chainAnchor, type PdLaunchRef } from "./pd";
import {
  followsLaunch,
  launchReadyBy,
  launchOrderBy,
  pdStageLabel,
  launchSuggestion,
  upcomingLaunches,
  attachPreview,
  movePreview,
  launchHealth,
  launchHealthText,
  dropLaunchPrefill,
  keepCurrentCardMembers,
  launchMovedDates,
  launchLinkErrorMessage,
  type LaunchLinkCard,
  type LaunchMemberLike,
} from "./launch-link";

const TODAY = "2026-09-29";

const launch = (over: Partial<PdLaunchRef> = {}): PdLaunchRef => ({
  id: "L-heady",
  name: "Studio Heady drop 006",
  kind: "studio_drop",
  launch_date: "2027-01-21",
  early_access_date: null,
  inventory_ready_by: "2027-01-01",
  ...over,
});

const HEADY = launch();

const card = (over: Partial<LaunchLinkCard> = {}): LaunchLinkCard => ({
  id: "c1",
  name: "Heady Studio Drop - BW58",
  stage: "ready_to_begin",
  target_launch_date: null,
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

/** A card following HEADY, as the board / launches embed hands it over. */
const following = (over: Partial<LaunchLinkCard> = {}) =>
  card({ target_launch_date: HEADY.launch_date, linked_launch_id: HEADY.id, launch: HEADY, ...over });

const orderBy = (c: LaunchLinkCard, l?: PdLaunchRef | null) =>
  deadlineChain(c, TODAY, l)?.find((r) => r.key === "orderBy")?.date ?? null;

describe("launch-anchored deadline chain", () => {
  it("Heady: launch 2027-01-21, ready-by 2027-01-01 → arrive 01-01, order by 2026-10-28 (= Launches page)", () => {
    const rows = deadlineChain(following(), TODAY)!;
    const at = (k: string) => rows.find((r) => r.key === k)!.date;
    expect(at("launch")).toBe("2027-01-21");
    expect(at("arriveBy")).toBe("2027-01-01");
    expect(at("orderBy")).toBe("2026-10-28");
    expect(at("orderBy")).toBe(orderByFromReadyBy("2027-01-01"));
    expect(launchOrderBy(HEADY)).toBe("2026-10-28");
  });

  it("a custom ready-by moves the card's arrive-by and order-by with it (mockup: ready-by Dec 31 → order by Oct 27)", () => {
    const l = launch({ inventory_ready_by: "2026-12-31" });
    const c = following({ launch: l });
    expect(chainAnchor(c)).toEqual({ launchDate: "2027-01-21", arrivalBufferDays: 21, followsLaunch: true });
    expect(orderBy(c)).toBe("2026-10-27");
    expect(orderBy(c)).toBe(launchOrderBy(l));
  });

  it("EA launch with NULL ready-by: arrive by = early access − 20, order by matches the Launches default", () => {
    const l = launch({ id: "L-xmas", launch_date: "2027-11-12", early_access_date: "2027-11-05", inventory_ready_by: null });
    expect(launchReadyBy(l)).toBe("2027-10-16");
    const c = following({ linked_launch_id: l.id, launch: l, target_launch_date: "2027-11-12" });
    const rows = deadlineChain(c, TODAY)!;
    expect(rows.find((r) => r.key === "arriveBy")!.date).toBe("2027-10-16");
    expect(rows.find((r) => r.key === "orderBy")!.date).toBe("2027-08-12");
    expect(launchOrderBy(l)).toBe("2027-08-12");
  });

  it("NULL ready-by, no EA: launch − 20, the same as an unattached card", () => {
    const l = launch({ inventory_ready_by: null });
    expect(launchReadyBy(l)).toBe("2027-01-01");
    expect(orderBy(following({ launch: l }))).toBe("2026-10-28");
    expect(orderBy(card({ target_launch_date: "2027-01-21" }))).toBe("2026-10-28");
  });

  it("own-date card ignores the launch: own target, 20-day buffer", () => {
    const l = launch({ inventory_ready_by: "2026-12-01" }); // a 51-day ready-by would pull order-by in
    const own = following({ launch: l, launch_date_override: true, target_launch_date: "2027-01-15" });
    expect(followsLaunch(own)).toBe(false);
    expect(chainAnchor(own)).toEqual({ launchDate: "2027-01-15", arrivalBufferDays: 20, followsLaunch: false });
    expect(orderBy(own)).toBe("2026-10-22");
  });

  it("explicit null launch ignores the embedded one; unattached cards are unchanged", () => {
    const l = launch({ inventory_ready_by: "2026-12-01" });
    const c = following({ launch: l });
    expect(orderBy(c)).toBe("2026-09-27");
    expect(orderBy(c, null)).toBe("2026-10-28");
    const plain = card({ target_launch_date: "2026-12-18", launch: null });
    expect(orderBy(plain)).toBe("2026-09-24");
  });

  it("undated launch: the card keeps its own date and the standard buffer", () => {
    const l = launch({ launch_date: null, inventory_ready_by: null });
    const c = following({ launch: l, target_launch_date: "2027-02-01" });
    expect(chainAnchor(c)).toEqual({ launchDate: "2027-02-01", arrivalBufferDays: 20, followsLaunch: false });
    expect(deadlineChain(following({ launch: l, target_launch_date: null }), TODAY)).toBeNull();
  });

  it("riskDot and cardFlags read the launch too", () => {
    const tightLaunch = launch({ inventory_ready_by: "2026-12-10" }); // order by 2026-10-06 → 7 days → tight
    const c = following({ stage: "prototype_sent", spec_sent_at: "2026-08-01", launch: tightLaunch });
    expect(riskDot(c, TODAY)).toBe("a");
    expect(cardFlags(c, TODAY)).toEqual(["Order by inside 14d"]);
    expect(riskDot(c, TODAY, null)).toBe("g");
    expect(cardFlags(c, TODAY, { launch: null })).toEqual([]);
  });
});

describe("labels", () => {
  it("stage label map, never the raw enum", () => {
    expect(pdStageLabel("ready_for_confirmation")).toBe("Confirmed, Ready to Order");
    expect(pdStageLabel("halted")).toBe("Halted");
    expect(pdStageLabel("some_new_stage")).toBe("Some new stage");
  });

  it("launch_moved meta and RPC error messages", () => {
    expect(launchMovedDates({ launch_id: "x", old_date: "2027-01-21", new_date: "2027-01-28" })).toEqual({
      oldDate: "2027-01-21",
      newDate: "2027-01-28",
    });
    expect(launchMovedDates(null)).toBeNull();
    expect(launchMovedDates([1])).toBeNull();
    expect(launchLinkErrorMessage("not_attached")).toBe("This card is not attached to a launch.");
    expect(launchLinkErrorMessage("weird")).toBe("The launch link could not be saved.");
    expect(launchLinkErrorMessage(undefined)).toBe("The launch link could not be saved.");
  });
});

const LAUNCHES: PdLaunchRef[] = [
  launch({ id: "mini", name: "Mini Bong Ultimate", kind: "launch", launch_date: "2026-11-01" }),
  HEADY,
  launch({ id: "007", name: "Studio Drop 007", launch_date: "2027-02-08" }),
  launch({ id: "008", name: "Alien Studio Drop 008", launch_date: "2027-04-05" }),
  launch({ id: "009", name: "Pirate Studio Drop 009", launch_date: "2027-05-12" }),
  launch({ id: "010", name: "Celestial Studio Drop 010", launch_date: "2027-07-20" }),
  launch({ id: "old", name: "Halloween Studio Drop", launch_date: "2026-09-18" }),
  launch({ id: "undated", name: "Someday Launch", launch_date: null }),
];

describe("launchSuggestion", () => {
  it("matches drop tags to launch names on the words that matter", () => {
    expect(launchSuggestion("Heady Studio", LAUNCHES)?.id).toBe("L-heady");
    expect(launchSuggestion("Alien Studio", LAUNCHES)?.id).toBe("008");
    expect(launchSuggestion("Pirate Studio", LAUNCHES)?.id).toBe("009");
    expect(launchSuggestion("Celestial Constellation", LAUNCHES)?.id).toBe("010");
  });

  it("no match: generic words alone never pick a launch", () => {
    expect(launchSuggestion("Q4 Studio", LAUNCHES)).toBeNull();
    expect(launchSuggestion("", LAUNCHES)).toBeNull();
    expect(launchSuggestion(null, LAUNCHES)).toBeNull();
  });

  it("numbers match without leading zeros; all-generic tags fall back to every word", () => {
    expect(launchSuggestion("Drop 6", LAUNCHES)?.id).toBe("L-heady");
    // fewest extra words; ties go to the earliest date, so pass the picker's upcoming list
    expect(launchSuggestion("Studio Drop", LAUNCHES)?.id).toBe("old");
    expect(launchSuggestion("Studio Drop", upcomingLaunches(LAUNCHES, TODAY))?.id).toBe("007");
  });

  it("deterministic ties: exact name, then fewest extra words, then earliest date", () => {
    const a = launch({ id: "a", name: "Heady Glass", launch_date: "2027-03-01" });
    const b = launch({ id: "b", name: "Heady Glass Extra", launch_date: "2027-02-01" });
    const c = launch({ id: "c", name: "Glass Heady", launch_date: "2027-01-01" });
    expect(launchSuggestion("Heady Glass", [b, c, a])?.id).toBe("a");
    expect(launchSuggestion("Heady Glass", [b, c])?.id).toBe("c");
    expect(launchSuggestion("Heady Glass", [c, b])?.id).toBe("c");
  });

  it("upcomingLaunches: today on, soonest first, undated last", () => {
    expect(upcomingLaunches(LAUNCHES, TODAY).map((l) => l.id)).toEqual([
      "mini", "L-heady", "007", "008", "009", "010", "undated",
    ]);
  });
});

describe("attachPreview", () => {
  const members: LaunchMemberLike[] = [
    { id: "m1", sku_id: null, planned_name: "Heady Studio", pd_project_id: null, sort_order: 0 },
  ];

  it("whole drop onto Heady: Jan 15 → Jan 21, order by old → new; the first card takes the placeholder", () => {
    const drop = [
      card({ id: "a", name: "BW20DNA", target_launch_date: "2027-01-15" }),
      card({ id: "b", name: "BW58", target_launch_date: "2027-01-15" }),
      card({ id: "c", name: "BW22U", stage: "china_working", target_launch_date: "2027-01-15" }),
    ];
    const rows = attachPreview(drop, { ...HEADY, skus: members }, TODAY);
    expect(rows.map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(rows[0]).toMatchObject({
      name: "BW20DNA",
      stageLabel: "Ready to Begin",
      oldTarget: "2027-01-15",
      newTarget: "2027-01-21",
      oldOrderBy: "2026-10-22",
      newOrderBy: "2026-10-28",
      moves: true,
      replaces: "Heady Studio",
      fromLaunch: null,
    });
    expect(rows[1].replaces).toBeNull();
    expect(rows[2].stageLabel).toBe("China Working");
  });

  it("duplicates dropped; a card already on the launch keeps its row; a promoted card claims its SKU row", () => {
    const ms: LaunchMemberLike[] = [
      { id: "m0", sku_id: "sku-9", planned_name: null, pd_project_id: null, sort_order: 0 },
      { id: "m1", sku_id: null, planned_name: "Heady Studio", pd_project_id: null, sort_order: 1 },
      { id: "m2", sku_id: null, planned_name: "BW58", pd_project_id: "b", sort_order: 2 },
    ];
    const rows = attachPreview(
      [
        card({ id: "p", linked_sku_id: "sku-9", target_launch_date: "2027-01-21" }),
        following({ id: "b" }),
        card({ id: "p" }),
        card({ id: "n", name: "Heady Studio", drop_tag: null, target_launch_date: "2027-01-21" }),
      ],
      { ...HEADY, skus: ms },
      TODAY,
    );
    expect(rows.map((r) => [r.id, r.replaces, r.moves])).toEqual([
      ["p", null, false],
      ["b", null, false],
      ["n", "Heady Studio", false],
    ]);
  });

  it("a card on another launch reports where it comes from; an own-date card re-attached follows again", () => {
    const other = launch({ id: "puffco", name: "Puffco Pivot Launch", launch_date: "2027-05-25", inventory_ready_by: null });
    const moved = attachPreview(
      [card({ id: "x", linked_launch_id: other.id, launch: other, target_launch_date: "2027-05-25" })],
      HEADY,
      TODAY,
    )[0];
    expect(moved.fromLaunch).toEqual({ id: "puffco", name: "Puffco Pivot Launch" });
    expect(moved).toMatchObject({ oldTarget: "2027-05-25", newTarget: "2027-01-21", oldOrderBy: "2027-03-01", newOrderBy: "2026-10-28" });

    const own = attachPreview([following({ launch_date_override: true, target_launch_date: "2027-01-15" })], HEADY, TODAY)[0];
    expect(own).toMatchObject({ oldTarget: "2027-01-15", newTarget: "2027-01-21", moves: true, fromLaunch: null });
  });

  it("undated launch: the card keeps its date", () => {
    const row = attachPreview([card({ target_launch_date: "2027-03-01" })], launch({ launch_date: null, inventory_ready_by: null }), TODAY)[0];
    expect(row).toMatchObject({ oldTarget: "2027-03-01", newTarget: "2027-03-01", moves: false });
  });
});

describe("movePreview (same rules as trg_pd_follow_launch)", () => {
  const cards = [
    following({ id: "f1", name: "BW20DNA" }),
    following({ id: "ord", name: "Ordered one", stage: "ordered" }),
    following({ id: "hal", name: "Halted one", stage: "halted" }),
    following({ id: "own", name: "Own date", launch_date_override: true, target_launch_date: "2027-01-15" }),
    following({ id: "arc", name: "Archived", archived_at: "2026-09-01T00:00:00Z" }),
    card({ id: "else", linked_launch_id: "other", target_launch_date: "2027-01-21" }),
  ];

  it("a week later (calendar drag): followers move incl. ordered and halted; ready-by keeps its offset", () => {
    const p = movePreview(HEADY, "2027-01-28", cards, TODAY);
    expect(p.moving.map((r) => r.id)).toEqual(["f1", "ord", "hal"]);
    expect(p.moving[0]).toMatchObject({
      oldTarget: "2027-01-21",
      newTarget: "2027-01-28",
      oldOrderBy: "2026-10-28",
      newOrderBy: "2026-11-04",
      moves: true,
    });
    expect(p.moving[1].stageLabel).toBe("Ordered");
    expect(p.staying).toEqual([
      {
        id: "own",
        name: "Own date",
        stage: "ready_to_begin",
        stageLabel: "Ready to Begin",
        oldTarget: "2027-01-15",
        newTarget: "2027-01-15",
        oldOrderBy: "2026-10-22",
        newOrderBy: "2026-10-22",
        moves: false,
      },
    ]);
    expect(p.launch).toEqual({
      oldDate: "2027-01-21",
      newDate: "2027-01-28",
      oldReadyBy: "2027-01-01",
      newReadyBy: "2027-01-08",
      oldOrderBy: "2026-10-28",
      newOrderBy: "2026-11-04",
    });
  });

  it("the launch form passes the ready-by it saves", () => {
    const p = movePreview(HEADY, "2027-01-28", cards, TODAY, { inventory_ready_by: "2027-01-01" });
    expect(p.launch.newReadyBy).toBe("2027-01-01");
    expect(p.moving[0].newOrderBy).toBe("2026-10-28");
  });

  it("NULL ready-by launch with early access: ready-by stays default, EA stays (drag)", () => {
    const l = launch({ launch_date: "2027-11-12", early_access_date: "2027-11-05", inventory_ready_by: null });
    const c = following({ launch: l, target_launch_date: "2027-11-12" });
    const p = movePreview(l, "2027-11-26", [c], TODAY);
    expect(p.launch.oldReadyBy).toBe("2027-10-16");
    expect(p.launch.newReadyBy).toBe("2027-10-16"); // earliest(EA 11-05, launch 11-26) − 20
    expect(p.moving[0]).toMatchObject({ newTarget: "2027-11-26", oldOrderBy: "2027-08-12", newOrderBy: "2027-08-12" });
  });

  it("clearing the launch date moves nobody", () => {
    const p = movePreview(HEADY, null, cards, TODAY);
    expect(p.moving.every((r) => !r.moves && r.newTarget === r.oldTarget)).toBe(true);
    expect(p.launch.newDate).toBeNull();
  });
});

describe("launchHealth", () => {
  it("rolls up the worst risk dot; halted not rated, archived not counted", () => {
    const late = following({ id: "l1" }); // spec by 2026-09-23 passed → red
    const late2 = following({ id: "l2" });
    const ok = following({ id: "g1", stage: "china_working", spec_sent_at: "2026-09-01" }); // order by 10-28 → 29d
    const halted = following({ id: "h", stage: "halted" });
    const archived = following({ id: "a", archived_at: "2026-09-01T00:00:00Z" });
    const h = launchHealth([late, late2, ok, halted, archived], TODAY);
    expect(h).toEqual({ count: 4, late: 2, tight: 0, worst: "r" });
    expect(launchHealthText(h)).toBe("4 products · 2 late");
    expect(launchHealth([ok], TODAY)).toEqual({ count: 1, late: 0, tight: 0, worst: "g" });
    expect(launchHealthText(launchHealth([ok], TODAY))).toBe("1 product");
    expect(launchHealth([], TODAY)).toEqual({ count: 0, late: 0, tight: 0, worst: null });
    expect(launchHealthText(launchHealth([], TODAY))).toBe("no products");
    expect(launchHealthText({ count: 3, late: 1, tight: 1, worst: "r" })).toBe("3 products · 1 late · 1 tight");
  });
});

describe("dropLaunchPrefill", () => {
  it("Q4 Studio: studio drop, shared date, halted unticked; members carry pd_project_id", () => {
    const cards = [
      card({ id: "o1", name: "Q4 Studio - BW20DNA", stage: "ordered", target_launch_date: "2026-11-05", linked_sku_id: "s1", drop_tag: "Q4 Studio" }),
      card({ id: "o2", name: "Q4 Studio - NB2", stage: "ordered", target_launch_date: "2026-11-05", display_category: null, drop_tag: "Q4 Studio" }),
      card({ id: "h1", name: "Q4 Studio - BW20", stage: "halted", target_launch_date: "2026-12-01", drop_tag: "Q4 Studio" }),
    ];
    const p = dropLaunchPrefill("Q4 Studio", cards);
    expect(p).toMatchObject({ name: "Q4 Studio drop", kind: "studio_drop", launch_date: "2026-11-05" });
    expect(p.products.map((x) => [x.pd_project_id, x.included])).toEqual([["o1", true], ["o2", true], ["h1", false]]);
  });

  it("mixed dates → no date; non-Studio category → Launch", () => {
    const p = dropLaunchPrefill("Pivot", [
      card({ id: "a", display_category: "Accessories", target_launch_date: "2027-01-01" }),
      card({ id: "b", display_category: "Studio", target_launch_date: "2027-02-01" }),
    ]);
    expect(p.kind).toBe("launch");
    expect(p.launch_date).toBeNull();
  });
});

describe("keepCurrentCardMembers", () => {
  it("drops card rows whose card lost its member row; keeps plain rows and current cards", () => {
    const members = [
      { pd_project_id: "c1", planned_name: null },
      { pd_project_id: "c2", planned_name: null },
      { pd_project_id: null, planned_name: "Working name" },
      { planned_name: "No card key" },
    ];
    expect(keepCurrentCardMembers(members, new Set(["c1"]))).toEqual([
      { pd_project_id: "c1", planned_name: null },
      { pd_project_id: null, planned_name: "Working name" },
      { planned_name: "No card key" },
    ]);
    expect(keepCurrentCardMembers(members, new Set())).toHaveLength(2);
  });
});
