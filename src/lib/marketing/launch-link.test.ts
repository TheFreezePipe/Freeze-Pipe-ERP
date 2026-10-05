import { describe, it, expect } from "vitest";
import { orderByFromReadyBy } from "./workback";
import { deadlineChain, riskDot, cardFlags, chainAnchor, type PdLaunchRef } from "./pd";
import {
  followsLaunch,
  launchReadyBy,
  launchOrderBy,
  launchShipBy,
  pdStageLabel,
  launchSuggestion,
  upcomingLaunches,
  attachPlan,
  attachPreview,
  movePreview,
  launchProductCount,
  dropLaunchPrefill,
  keepCurrentCardMembers,
  launchMovedDates,
  launchMovedText,
  pdActivityText,
  launchLinkErrorMessage,
  LAUNCH_LINK_ERROR_LABEL,
  inboundBySku,
  launchSkuIds,
  memberState,
  memberStocked,
  memberStockNeed,
  type InboundLine,
  type InboundShipment,
  type LaunchLinkCard,
  type LaunchMemberCard,
  type LaunchMemberLike,
  type LaunchMemberRow,
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

  it("archived and halted cards never follow the launch; ship-by = ready-by − 35", () => {
    expect(followsLaunch(following())).toBe(true);
    expect(followsLaunch(following({ archived_at: "2026-09-22T00:00:00Z" }))).toBe(false);
    expect(followsLaunch(following({ stage: "halted" }))).toBe(false);
    expect(launchShipBy(HEADY)).toBe("2026-11-27");
    expect(launchShipBy(launch({ launch_date: null, inventory_ready_by: null }))).toBeNull();
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
    for (const code of [
      "archived",
      "already_linked",
      "sku_owned_by_other_card",
      "sku_not_found",
      "sku_required",
      "not_ordered",
      "already_archived",
      "admin_or_manager_required",
    ]) {
      expect(LAUNCH_LINK_ERROR_LABEL[code], code).toBeTruthy();
    }
  });
});

describe("Activity text", () => {
  const NL = "308629af";
  const names = new Map([[NL, "Northern Lights Studio drop"], ["puffco", "Puffco Pivot Launch"]]);
  const moved = (meta: Record<string, unknown>) =>
    launchMovedText({ launch_id: NL, old_date: "2026-11-05", new_date: "2026-11-16", ...meta }, names);

  it("says what happened per via, with the launch's name and the date change", () => {
    expect(moved({ via: "attach", member: "claimed_sku" })).toBe("Added to Northern Lights Studio drop · Nov 5 → Nov 16");
    expect(moved({ via: "attach", backfill: true })).toBe("Added to Northern Lights Studio drop · Nov 5 → Nov 16");
    expect(moved({ via: "attach", old_date: "2026-11-16" })).toBe("Added to Northern Lights Studio drop");
    expect(moved({ via: "attach", from_launch_id: "puffco" })).toBe(
      "Moved to Northern Lights Studio drop from Puffco Pivot Launch · Nov 5 → Nov 16",
    );
    expect(moved({ via: "detach", old_date: "2026-11-16", member: "deleted" })).toBe("Removed from Northern Lights Studio drop");
    expect(moved({ via: "form", old_date: "2026-11-16" })).toBe("Removed from Northern Lights Studio drop");
    expect(moved({ via: "halt", old_date: "2026-11-16" })).toBe("Removed from Northern Lights Studio drop");
    expect(moved({ via: "revive", old_date: "2026-11-16" })).toBe("Removed from Northern Lights Studio drop");
    expect(moved({ via: "follow" })).toBe("Launch moved Nov 5 → Nov 16");
    expect(moved({ via: "override", override: true })).toBe("Date set by hand · Nov 5 → Nov 16");
    expect(moved({ via: "override", override: true, old_date: "2026-11-16" })).toBe("Date set by hand");
    expect(moved({ via: "override", override: false })).toBe("Back on the launch date · Nov 5 → Nov 16");
  });

  it("falls back for events older than the via field and unknown launches", () => {
    expect(launchMovedText({ launch_id: "x", old_date: "2027-01-21", new_date: "2027-01-28" })).toBe("Launch moved Jan 21 → Jan 28");
    expect(launchMovedText(null)).toBe("Launch moved");
    expect(launchMovedText({ via: "attach", launch_id: "gone", new_date: "2027-01-28" })).toBe("Added to launch · Jan 28");
  });

  it("pdActivityText: restore, link_sku, arrival; null for the sheet's own outcomes", () => {
    const ev = (outcome: string, over: Partial<Parameters<typeof pdActivityText>[0]> = {}) => ({
      outcome,
      from_stage: "ordered",
      to_stage: "ordered",
      reason: null,
      meta: null,
      ...over,
    });
    expect(pdActivityText(ev("restore", { reason: "Samples only: 2 of 200 arrived on AIR-266" }))).toBe(
      "Restored to Ordered · Samples only: 2 of 200 arrived on AIR-266",
    );
    expect(pdActivityText(ev("link_sku", { meta: { sku: "S04-NB2", member: "merged" } }))).toBe("Linked to SKU S04-NB2");
    expect(pdActivityText(ev("archive", { to_stage: null, reason: "arrived", meta: { auto: "arrival" } }))).toBe("Arrived");
    expect(pdActivityText(ev("archive", { to_stage: null, reason: "arrived", meta: { manual: true, note: "Counted in" } }))).toBe(
      "Marked arrived · Counted in",
    );
    expect(pdActivityText(ev("archive", { to_stage: null, reason: "shelved" }))).toBeNull();
    expect(pdActivityText(ev("launch_moved", { meta: { via: "detach", launch_id: NL } }), names)).toBe(
      "Removed from Northern Lights Studio drop",
    );
    expect(pdActivityText(ev("advance"))).toBeNull();
    expect(pdActivityText(ev("kill", { reason: "no demand" }))).toBeNull();
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

  it("a launch already carrying a card of the drop wins, whatever its name (Q4 Studio rode Northern Lights)", () => {
    const nl = launch({ id: "nl", name: "Northern Lights Studio drop", launch_date: "2026-11-16" });
    const all = [...LAUNCHES, nl];
    const q4 = [
      { linked_launch_id: "nl", stage: "ordered", archived_at: null },
      { linked_launch_id: null, stage: "halted", archived_at: null },
    ];
    expect(launchSuggestion("Q4 Studio", all)).toBeNull();
    expect(launchSuggestion("Q4 Studio", all, q4)?.id).toBe("nl");
    // an arrived card still says where the drop lives; other archived cards and halted ones do not
    expect(launchSuggestion("Q4 Studio", all, [{ linked_launch_id: "nl", archived_at: "2026-09-22", archive_reason: "shelved" }])).toBeNull();
    expect(launchSuggestion("Q4 Studio", all, [{ linked_launch_id: "nl", archived_at: "2026-09-22", archive_reason: "arrived" }])?.id).toBe("nl");
    expect(launchSuggestion("Q4 Studio", all, [{ linked_launch_id: "nl", stage: "halted" }])).toBeNull();
    // the carrying launch beats the name match; among several, most cards, then the name match
    expect(launchSuggestion("Heady Studio", all, [{ linked_launch_id: "nl" }])?.id).toBe("nl");
    expect(launchSuggestion("Heady Studio", all, [{ linked_launch_id: "nl" }, { linked_launch_id: "L-heady" }])?.id).toBe("L-heady");
    expect(launchSuggestion("Heady Studio", all, [{ linked_launch_id: "nl" }, { linked_launch_id: "nl" }, { linked_launch_id: "L-heady" }])?.id).toBe("nl");
    // only launches in the offered list count
    expect(launchSuggestion("Q4 Studio", upcomingLaunches(all, "2026-12-01"), q4)).toBeNull();
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

  it("attachPlan: halted cards are skipped (greyed), arrived cards link without moving", () => {
    const plan = attachPlan(
      [
        card({ id: "h", name: "Q4 Studio - BW20", stage: "halted", target_launch_date: "2026-11-16" }),
        card({
          id: "a",
          name: "Q4 Studio - NB2",
          stage: "ordered",
          target_launch_date: "2026-11-05",
          archived_at: "2026-09-22T00:00:00Z",
          archive_reason: "arrived",
          linked_sku_id: "sku-nb2",
        }),
        card({ id: "l", name: "Q4 Studio - BW20DNA", stage: "ordered", target_launch_date: "2026-11-05" }),
        card({ id: "h" }),
      ],
      { ...HEADY, skus: [{ id: "m0", sku_id: "sku-nb2", planned_name: null, pd_project_id: null, sort_order: 0 }] },
      TODAY,
    );
    expect(plan.skipped).toEqual([{ id: "h", name: "Q4 Studio - BW20", stage: "halted", stageLabel: "Halted", reason: "halted" }]);
    expect(plan.rows.map((r) => [r.id, r.archived, r.moves, r.oldTarget, r.newTarget])).toEqual([
      ["a", true, false, "2026-11-05", "2026-11-05"],
      ["l", false, true, "2026-11-05", "2027-01-21"],
    ]);
    expect(plan.rows[0].oldOrderBy).toBe(plan.rows[0].newOrderBy);
    expect(attachPreview([card({ id: "h", stage: "halted" })], HEADY, TODAY)).toEqual([]);
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

  it("a week later (calendar drag): followers move incl. ordered; halted and archived left out; ready-by keeps its offset", () => {
    const p = movePreview(HEADY, "2027-01-28", cards, TODAY);
    expect(p.moving.map((r) => r.id)).toEqual(["f1", "ord"]);
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

// ---------------------------------------------------------------------------
// Northern Lights Studio drop (launch 308629af, live shapes on 2026-10-01)
// ---------------------------------------------------------------------------

const NL_TODAY = "2026-10-01";
const NL: PdLaunchRef = {
  id: "nl",
  name: "Northern Lights Studio drop",
  kind: "studio_drop",
  launch_date: "2026-11-16",
  early_access_date: "2026-11-09",
  inventory_ready_by: "2026-10-20",
};
const SKU = { bw20dna: "sku-bw20dna", nb2: "sku-nb2", nb6: "sku-nb6" };
const ITEM = { bw20dna: "foi-bw20dna", nb2: "foi-nb2", nb6: "foi-nb6" };

const ordered = (over: Partial<LaunchMemberCard> & { id: string; name: string }): LaunchMemberCard => ({
  ...card({ stage: "ordered", drop_tag: "Q4 Studio", target_launch_date: NL.launch_date, linked_launch_id: NL.id, launch: NL }),
  ...over,
});

const BW20DNA = ordered({ id: "c-bw20dna", name: "Q4 Studio - BW20DNA", linked_sku_id: SKU.bw20dna, ordered_at: "2026-08-27T15:00:00Z", linked_factory_order_id: "fo-as" });
const NB2 = ordered({ id: "c-nb2", name: "Q4 Studio - NB2", linked_sku_id: SKU.nb2, ordered_at: "2026-09-01T12:00:00Z", linked_factory_order_id: "fo-yx" });
const NB6 = ordered({ id: "c-nb6", name: "Q4 Studio - NB6", linked_sku_id: SKU.nb6, ordered_at: "2026-09-01T12:00:00Z", linked_factory_order_id: "fo-yx" });

const row = (over: Partial<LaunchMemberRow> & { id: string }): LaunchMemberRow => ({
  sku_id: null,
  planned_name: null,
  pd_project_id: null,
  limited_qty: null,
  expected_first_30d_units: null,
  product: null,
  ...over,
});
const NL_ROWS: LaunchMemberRow[] = [
  row({ id: "m1", sku_id: SKU.bw20dna, pd_project_id: BW20DNA.id, limited_qty: 300, product: { sku: "S04-BW20DNA", product_name: "BW20DNA" } }),
  row({ id: "m2", sku_id: SKU.nb2, pd_project_id: NB2.id, limited_qty: 200, product: { sku: "S04-NB2", product_name: "NB2" } }),
  row({ id: "m3", sku_id: SKU.nb6, pd_project_id: NB6.id, limited_qty: 200, product: { sku: "S04-NB6", product_name: "NB6" } }),
];

const ship = (shipment_number: string, eta: string | null, status: string, received: string | null = null): InboundShipment => ({
  id: `s-${shipment_number}`,
  shipment_number,
  freight_type: shipment_number.startsWith("AIR") ? "air" : "sea",
  status,
  eta,
  eta_original: eta,
  ship_date: null,
  carrier_name: null,
  receipt_confirmed_at: received,
  carton_groups: [],
});
const line = (sku_id: string, quantity: number, quantity_received: number, src: string | null, shipment: InboundShipment | null): InboundLine => ({
  sku_id,
  quantity,
  quantity_received,
  quantity_prefilled: 0,
  source_factory_order_item_id: src,
  freight_shipment_id: shipment?.id ?? "s-none",
  shipment,
});
/** Live freight on 2026-10-01: sea 485 + 486 and air 268 for BW20DNA; AIR-266 (2 samples each of NB2/NB6) checked in and confirmed. */
const NL_LINES: InboundLine[] = [
  line(SKU.bw20dna, 150, 0, ITEM.bw20dna, ship("485", "2026-10-30", "pending")),
  line(SKU.bw20dna, 125, 0, ITEM.bw20dna, ship("486", "2026-10-30", "on_the_water")),
  line(SKU.bw20dna, 2, 0, ITEM.bw20dna, ship("AIR-268", "2026-10-03", "on_the_water")),
  line(SKU.nb2, 2, 2, ITEM.nb2, ship("AIR-266", "2026-09-22", "delivered", "2026-09-22T18:00:00Z")),
  line(SKU.nb6, 2, 2, ITEM.nb6, ship("AIR-266", "2026-09-22", "delivered", "2026-09-22T18:00:00Z")),
];
const NL_INBOUND = inboundBySku(NL_LINES);
const NL_LAUNCH = { ...NL, skus: NL_ROWS, cards: [BW20DNA, NB2, NB6] };

describe("inbound freight", () => {
  it("groups unconfirmed, not-yet-received lines by SKU", () => {
    expect([...NL_INBOUND.keys()]).toEqual([SKU.bw20dna]);
    expect(NL_INBOUND.get(SKU.bw20dna)).toHaveLength(3);
    // a confirmed shipment, a fully received line, a line with no SKU: not inbound
    expect(inboundBySku([line(SKU.nb2, 10, 10, null, ship("X", "2026-12-01", "pending"))]).size).toBe(0);
    expect(inboundBySku([{ ...line(SKU.nb2, 10, 0, null, ship("X", null, "pending")), sku_id: null }]).size).toBe(0);
  });

  it("launchSkuIds: member rows and cards, deduped, sorted", () => {
    expect(launchSkuIds([NL_LAUNCH, { skus: [{ sku_id: "a" }, { sku_id: null }], cards: [{ linked_sku_id: SKU.nb2 }] }])).toEqual([
      "a", SKU.bw20dna, SKU.nb2, SKU.nb6,
    ]);
  });
});

describe("memberState (rows without a SKU)", () => {
  it("arrived: green, frozen, the day it landed; halted: never rated", () => {
    const arrived = { ...NB2, archived_at: "2026-09-22T18:00:00Z", archive_reason: "arrived" };
    expect(memberState(NL_ROWS[1], { ...NL_LAUNCH, cards: [arrived] }, NL_TODAY)).toEqual({
      kind: "arrived",
      label: "Arrived",
      date: { label: "Arrived", value: "2026-09-22", days: -9 },
      risk: "g",
      orderBy: null,
    });
    const halted = { ...NB2, stage: "halted" };
    expect(memberState(NL_ROWS[1], { ...NL_LAUNCH, cards: [halted] }, NL_TODAY)).toMatchObject({ kind: "halted", label: "Halted", risk: null, date: null });
    // archived for another reason: stage label, nothing rated
    const shelved = { ...NB2, archived_at: "2026-09-22T18:00:00Z", archive_reason: "shelved" };
    expect(memberState(NL_ROWS[1], { ...NL_LAUNCH, cards: [shelved] }, NL_TODAY)).toMatchObject({ kind: "development", label: "Ordered", risk: null });
  });

  it("development: the board's chain and risk dot anchored on the launch; order by exposed", () => {
    const dev = following({ id: "d", name: "Heady Studio Drop - BW58" });
    const s = memberState(row({ id: "m", pd_project_id: "d", planned_name: "BW58" }), { ...HEADY, cards: [dev] }, TODAY);
    expect(s).toMatchObject({
      kind: "development",
      label: "Ready to Begin",
      date: { label: "Spec by", value: "2026-09-23", days: -6 },
      risk: "r",
      orderBy: "2026-10-28",
    });
  });

  it("an ordered card reads through the chain too: order by done, ship by (ready-by − 35) next", () => {
    const s = memberState(NL_ROWS[1], NL_LAUNCH, NL_TODAY);
    expect(s).toMatchObject({ kind: "development", label: "Ordered", date: { label: "Ship by", value: "2026-09-15" }, risk: "r", orderBy: "2026-08-16" });
  });

  it("plain rows: no card (or a card RLS hid) → unrated", () => {
    expect(memberState(row({ id: "p", planned_name: "Someday" }), { ...NL, cards: [] }, NL_TODAY)).toEqual({
      kind: "plain",
      label: "",
      date: null,
      risk: null,
      orderBy: null,
    });
    expect(memberState(row({ id: "p", pd_project_id: "hidden" }), { ...NL, cards: [] }, NL_TODAY).kind).toBe("plain");
  });

  it("stock reading: on hand must cover the limited qty / expected units, else any stock", () => {
    expect(memberStockNeed(row({ id: "a", limited_qty: 200, expected_first_30d_units: 50 }))).toBe(200);
    expect(memberStockNeed(row({ id: "a", expected_first_30d_units: 50 }))).toBe(50);
    expect(memberStockNeed(row({ id: "a" }))).toBeNull();
    expect(memberStocked(row({ id: "a", limited_qty: 200 }), 2)).toBe(false); // AIR-266's samples
    expect(memberStocked(row({ id: "a", limited_qty: 200 }), 200)).toBe(true);
    expect(memberStocked(row({ id: "a" }), 1)).toBe(true);
    expect(memberStocked(row({ id: "a" }), 0)).toBe(false);
  });
});

describe("launchProductCount", () => {
  it("arrived rows count; halted rows count for nothing; plain rows count", () => {
    const arrived = { ...NB2, archived_at: "2026-11-01T00:00:00Z", archive_reason: "arrived" };
    const halted = { ...NB6, stage: "halted" };
    const l = {
      ...NL_LAUNCH,
      skus: [...NL_ROWS, row({ id: "m4", sku_id: "sku-plain", product: { sku: "S04-PLAIN", product_name: "Restock" } })],
      cards: [BW20DNA, arrived, halted],
    };
    expect(launchProductCount(l)).toBe(3);
    expect(launchProductCount({ ...NL_LAUNCH, skus: [], cards: [] })).toBe(0);
  });

  it("member rows minus halted cards' rows — rows, not cards", () => {
    expect(launchProductCount({ skus: [{ pd_project_id: "c1" }, { pd_project_id: "h" }, { pd_project_id: null }], cards: [{ id: "c1" }, { id: "h", stage: "halted" }] })).toBe(2);
    expect(launchProductCount({ skus: [{ pd_project_id: "arrived" }], cards: [{ id: "arrived", stage: "ordered" }] })).toBe(1);
    expect(launchProductCount({ skus: [], cards: [{ id: "c1" }, { id: "c2" }] })).toBe(0);
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
    expect(p.products.map((x) => [x.pd_project_id, x.included, x.arrived])).toEqual([["o1", true, false], ["o2", true, false], ["h1", false, false]]);
    // each product carries what the form row shows: stage, its own target date, the SKU code when the card embeds it
    expect(p.products[0]).toMatchObject({ stage: "ordered", target_launch_date: "2026-11-05", sku_id: "s1", sku: null });
    expect(p.products[2]).toMatchObject({ stage: "halted", target_launch_date: "2026-12-01" });
    expect(dropLaunchPrefill("Q4 Studio", [{ ...cards[0], linked_sku: { sku: "S04-BW20DNA" } }]).products[0].sku).toBe("S04-BW20DNA");
  });

  it("arrived cards are offered and ticked (frozen date only counts when no live card has one); other archived cards are not", () => {
    const live = card({ id: "o1", stage: "ordered", target_launch_date: "2026-11-16" });
    const arrived = card({ id: "ar", stage: "ordered", target_launch_date: "2026-11-05", archived_at: "2026-09-22T00:00:00Z", archive_reason: "arrived" });
    const shelved = card({ id: "sh", archived_at: "2026-09-22T00:00:00Z", archive_reason: "shelved" });
    const p = dropLaunchPrefill("Q4 Studio", [live, arrived, shelved]);
    expect(p.products.map((x) => [x.pd_project_id, x.included, x.arrived])).toEqual([["o1", true, false], ["ar", true, true]]);
    expect(p.launch_date).toBe("2026-11-16");
    expect(dropLaunchPrefill("Q4 Studio", [arrived]).launch_date).toBe("2026-11-05");
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

  it("with the cards the form opened with: only those can be dropped; a newly picked card's row goes through", () => {
    const members = [
      { pd_project_id: "c1", planned_name: null }, // opened with, still on the launch
      { pd_project_id: "c2", planned_name: null }, // opened with, detached meanwhile
      { pd_project_id: "new", planned_name: null }, // SKU pick that belongs to a card
      { pd_project_id: null, planned_name: "Working name" },
    ];
    expect(keepCurrentCardMembers(members, new Set(["c1"]), new Set(["c1", "c2"])).map((m) => m.pd_project_id)).toEqual(["c1", "new", null]);
    expect(keepCurrentCardMembers(members, new Set(["c1"]), new Set()).map((m) => m.pd_project_id)).toEqual(["c1", "c2", "new", null]);
  });
});
