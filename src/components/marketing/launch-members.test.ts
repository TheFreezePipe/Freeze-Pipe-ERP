import { describe, it, expect } from "vitest";
import {
  launchMemberItems,
  launchProductCount,
  addProductGroups,
  defaultAddPick,
  taggedDropHints,
  type BoardCardLike,
} from "./launch-members";
import { launchKindLabel, LAUNCH_KINDS, fmtDay, fmtDayLong, relDays } from "./launch-format";

const TODAY = "2026-09-29";

const member = (over: Partial<{ id: string; sku_id: string | null; planned_name: string | null; pd_project_id: string | null; sort_order: number; product: { sku: string; product_name: string } | null }>) => ({
  id: "m",
  sku_id: null,
  planned_name: null,
  pd_project_id: null,
  sort_order: 0,
  product: null,
  ...over,
});

const card = (over: Partial<BoardCardLike> & { id: string }): BoardCardLike => ({
  name: over.id,
  stage: "good_ideas",
  drop_tag: null,
  linked_launch_id: null,
  archived_at: null,
  ...over,
});

describe("launch-format", () => {
  it("labels every form kind and never shows a raw enum", () => {
    for (const k of LAUNCH_KINDS) expect(launchKindLabel(k.value)).toBe(k.label);
    expect(launchKindLabel("studio_drop")).toBe("Studio drop");
    expect(launchKindLabel("flash_sale")).toBe("Flash sale");
    expect(launchKindLabel(null)).toBe("");
  });

  it("formats days short and long", () => {
    expect(fmtDay("2027-01-21")).toBe("Jan 21");
    expect(fmtDay("2027-01-21T00:00:00Z")).toBe("Jan 21");
    expect(fmtDay(null)).toBe("—");
    expect(fmtDayLong("2027-01-21")).toBe("Jan 21, 2027");
    expect(fmtDayLong(undefined)).toBe("—");
  });

  it("phrases relative days", () => {
    expect(relDays(0)).toBe("today");
    expect(relDays(29)).toBe("in 29d");
    expect(relDays(-6)).toBe("6d late");
  });
});

describe("launchMemberItems", () => {
  it("lists members in sort order, cards as cards (arrived ones kept), halted dropped, each with its row", () => {
    const items = launchMemberItems({
      skus: [
        member({ id: "m3", sort_order: 2, pd_project_id: "c-arrived", sku_id: "s2" }),
        member({ id: "m2", sort_order: 1, sku_id: "s1", product: { sku: "NB3M", product_name: "Mini Bong" } }),
        member({ id: "m1", sort_order: 0, pd_project_id: "c1", planned_name: "BW58" }),
        member({ id: "m4", sort_order: 3, planned_name: "Placeholder" }),
        member({ id: "m5", sort_order: 4, pd_project_id: "c-halted" }),
      ],
      cards: [
        { id: "c1", stage: "ready_to_begin", archived_at: null },
        { id: "c-arrived", stage: "ordered", archived_at: "2026-09-01T00:00:00Z" },
        { id: "c-halted", stage: "halted", archived_at: null },
        { id: "c-norow", stage: "good_ideas", archived_at: null },
      ],
    });
    expect(items.map((i) => (i.kind === "card" ? `card:${i.card.id}:${i.row?.id ?? "-"}` : `plain:${i.sku ?? ""}:${i.name}:${i.row.id}`))).toEqual([
      "card:c1:m1",
      "plain:NB3M:Mini Bong:m2",
      "card:c-arrived:m3",
      "plain::Placeholder:m4",
      "card:c-norow:-",
    ]);
  });
});

describe("launchProductCount (re-export of launch-link's one definition)", () => {
  it("counts member rows except halted cards' rows; arrived rows count; cards without a row do not", () => {
    expect(
      launchProductCount({
        skus: [{ pd_project_id: "c1" }, { pd_project_id: "c-halted" }, { pd_project_id: "c-arrived" }, { pd_project_id: null }],
        cards: [{ id: "c1" }, { id: "c-halted", stage: "halted" }, { id: "c-arrived", stage: "ordered" }],
      }),
    ).toBe(3);
    expect(launchProductCount({ skus: [], cards: [{ id: "c1" }, { id: "c2" }] })).toBe(0);
    expect(launchProductCount({ skus: [], cards: [] })).toBe(0);
  });
});

describe("addProductGroups / defaultAddPick", () => {
  const alien = { id: "L-alien", name: "Alien Studio Drop 008", launch_date: "2027-04-05" };
  const board = [
    card({ id: "a2", name: "Alien Studio Drop - NB4", drop_tag: "Alien Studio" }),
    card({ id: "a1", name: "Alien Studio Drop - BW42", drop_tag: "Alien Studio", stage: "ready_to_begin" }),
    card({ id: "a3", name: "Alien Studio Drop - BW20", drop_tag: "Alien Studio", stage: "halted" }),
    card({ id: "a4", name: "Alien Studio Drop - BW22U", drop_tag: "Alien Studio", linked_launch_id: "L-other" }),
    card({ id: "p1", name: "Puffco Pivot Attachment", drop_tag: "Puffco" }),
    card({ id: "n1", name: "Loose idea" }),
    card({ id: "on", name: "Already on it", drop_tag: "Alien Studio", linked_launch_id: "L-alien" }),
    card({ id: "gone", name: "Archived", drop_tag: "Alien Studio", archived_at: "2026-01-01" }),
  ];

  it("groups by drop, matching drop first, no-drop last, skips cards already on the launch or archived", () => {
    const groups = addProductGroups(board, alien);
    expect(groups.map((g) => [g.tag, g.suggested, g.cards.map((c) => c.id)])).toEqual([
      ["Alien Studio", true, ["a3", "a4", "a1", "a2"]],
      ["Puffco", false, ["p1"]],
      ["", false, ["n1"]],
    ]);
  });

  it("ticks the matching drop's free, non-halted cards", () => {
    expect([...defaultAddPick(addProductGroups(board, alien))].sort()).toEqual(["a1", "a2"]);
  });

  it("ticks nothing when no drop matches", () => {
    expect(defaultAddPick(addProductGroups(board, { id: "L-x", name: "Holiday Bundle", launch_date: null })).size).toBe(0);
  });

  it("a drop whose other cards already ride the launch is the matching drop, whatever the names", () => {
    const nl = { id: "L-nl", name: "Northern Lights Studio drop", launch_date: "2026-11-16" };
    const groups = addProductGroups(
      [
        card({ id: "q1", name: "Q4 Studio - NB2", drop_tag: "Q4 Studio", stage: "ordered", linked_launch_id: "L-nl" }),
        card({ id: "q2", name: "Q4 Studio - NB6", drop_tag: "Q4 Studio", stage: "ordered" }),
        card({ id: "q3", name: "Q4 Studio - BW20", drop_tag: "Q4 Studio", stage: "halted" }),
        card({ id: "p1", name: "Puffco Pivot Attachment", drop_tag: "Puffco" }),
      ],
      nl,
    );
    expect(groups.map((g) => [g.tag, g.suggested, g.cards.map((c) => c.id)])).toEqual([
      ["Q4 Studio", true, ["q3", "q2"]],
      ["Puffco", false, ["p1"]],
    ]);
    expect([...defaultAddPick(groups)]).toEqual(["q2"]);
  });
});

describe("taggedDropHints", () => {
  const launches = [
    { id: "L-alien", name: "Alien Studio Drop 008", launch_date: "2027-04-05" },
    { id: "L-past", name: "Pirate Studio Drop 001", launch_date: "2025-05-01" },
    { id: "L-pirate", name: "Pirate Studio Drop 009", launch_date: "2027-05-12" },
  ];

  it("counts unattached, live, non-halted cards per drop under the upcoming launch they match", () => {
    const hints = taggedDropHints(
      [
        card({ id: "a1", drop_tag: "Alien Studio" }),
        card({ id: "a2", drop_tag: "Alien Studio" }),
        card({ id: "a3", drop_tag: "Alien Studio", stage: "halted" }),
        card({ id: "a4", drop_tag: "Alien Studio", linked_launch_id: "L-alien" }),
        card({ id: "a5", drop_tag: "Alien Studio", archived_at: "2026-01-01" }),
        card({ id: "p1", drop_tag: "Pirate Studio" }),
        card({ id: "x1", drop_tag: "Nothing Matches" }),
        card({ id: "n1" }),
      ],
      launches,
      TODAY,
    );
    expect(Object.fromEntries(hints)).toEqual({
      "L-alien": [{ tag: "Alien Studio", count: 2 }],
      "L-pirate": [{ tag: "Pirate Studio", count: 1 }],
    });
  });

  it("an unattached card of a drop that already rides a launch hints under that launch, not a name match", () => {
    const hints = taggedDropHints(
      [
        card({ id: "q1", drop_tag: "Q4 Studio", stage: "ordered", linked_launch_id: "L-nl" }),
        card({ id: "q2", drop_tag: "Q4 Studio", stage: "ordered" }),
      ],
      [...launches, { id: "L-nl", name: "Northern Lights Studio drop", launch_date: "2026-11-16" }],
      TODAY,
    );
    expect(Object.fromEntries(hints)).toEqual({ "L-nl": [{ tag: "Q4 Studio", count: 1 }] });
  });
});
