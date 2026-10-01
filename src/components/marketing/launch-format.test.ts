import { describe, expect, it } from "vitest";
import {
  ORDER_BY_SOON_DAYS,
  slackText,
  stockReading,
  stockSignal,
  withArrivedDropCards,
  type StockRow,
} from "./launch-format";
import type { AddProductGroup, BoardCardLike } from "./launch-members";

// A launch with an explicit ready-by so the dates below are plain arithmetic:
// ready-by Oct 20 → order-by Aug 16 (ready-by − 35 sea − 30 manufacturing).
const LAUNCH = { launch_date: "2026-11-16", early_access_date: null, inventory_ready_by: "2026-10-20" };
const ORDER_BY = "2026-08-16";

const row = (sku: string, extra: Partial<StockRow> = {}): StockRow => ({
  sku_id: `id-${sku}`,
  product: { sku },
  limited_qty: null,
  expected_first_30d_units: null,
  ...extra,
});
const onHand = (pairs: Record<string, number>) => new Map(Object.entries(pairs).map(([k, v]) => [`id-${k}`, v]));
const incoming = (pairs: Record<string, string>) => new Map(Object.entries(pairs).map(([k, v]) => [`id-${k}`, v]));

describe("slackText", () => {
  it("reads late, on the day and early", () => {
    expect(slackText(-22)).toBe("22d late");
    expect(slackText(0)).toBe("on the day");
    expect(slackText(5)).toBe("5d early");
  });
});

describe("stockReading", () => {
  it("shows have of need when the row has a limited or expected quantity", () => {
    expect(stockReading(row("NB2", { limited_qty: 200 }), 2)).toBe("2 of 200 on hand");
    expect(stockReading(row("NB2", { expected_first_30d_units: 60 }), 75)).toBe("75 of 60 on hand");
    expect(stockReading(row("NB2", { limited_qty: 200, expected_first_30d_units: 60 }), 0)).toBe("0 of 200 on hand");
  });
  it("shows the plain count otherwise, and nothing without a SKU", () => {
    expect(stockReading(row("X"), 120)).toBe("120 on hand");
    expect(stockReading(row("X"), undefined)).toBe("0 on hand");
    expect(stockReading({ sku_id: null, limited_qty: null, expected_first_30d_units: null, planned_name: "Mini" }, 5)).toBeNull();
  });
});

describe("stockSignal", () => {
  const today = "2026-10-01";

  it("does not call 2 sample units stocked against a 200-unit limited drop", () => {
    const rows = [row("NB2", { limited_qty: 200 })];
    // Nothing incoming: the SKU is short and uncovered.
    expect(stockSignal(rows, LAUNCH, onHand({ NB2: 2 }), incoming({}), today)).toEqual({ kind: "uncovered", skus: ["NB2"] });
    // Full quantity on hand → stocked.
    expect(stockSignal(rows, LAUNCH, onHand({ NB2: 200 }), incoming({}), today)).toEqual({ kind: "stocked" });
  });

  it("reads stocked when a row with no need has any units", () => {
    expect(stockSignal([row("X")], LAUNCH, onHand({ X: 1 }), incoming({}), today)).toEqual({ kind: "stocked" });
  });

  it("flags SKUs whose incoming lands after launch day as uncovered", () => {
    const rows = [row("A"), row("B")];
    const s = stockSignal(rows, LAUNCH, onHand({}), incoming({ A: "2026-11-20", B: "2026-10-30" }), today);
    expect(s).toEqual({ kind: "uncovered", skus: ["A"] });
  });

  it("names the planned product when the uncovered row has no SKU code", () => {
    const r: StockRow = { sku_id: "id-planned", product: null, planned_name: "Mini", limited_qty: null, expected_first_30d_units: null };
    expect(stockSignal([r], LAUNCH, onHand({}), incoming({}), today)).toEqual({ kind: "uncovered", skus: ["Mini"] });
  });

  it("reports the order window passed when a short SKU has nothing incoming and no launch day is set", () => {
    const undated = { ...LAUNCH, launch_date: null };
    expect(stockSignal([row("A")], undated, onHand({}), incoming({}), today)).toEqual({ kind: "window_passed", orderBy: ORDER_BY });
  });

  it("asks to order when the order-by date is inside the soon window", () => {
    const soonToday = "2026-08-10"; // 6 days before order-by
    expect(ORDER_BY_SOON_DAYS).toBe(14);
    expect(stockSignal([row("A")], LAUNCH, onHand({}), incoming({ A: "2026-10-01" }), soonToday)).toEqual({ kind: "order_by", orderBy: ORDER_BY });
    // Well ahead of the window: incoming covers it, so the chip is the incoming date.
    expect(stockSignal([row("A")], LAUNCH, onHand({}), incoming({ A: "2026-10-01" }), "2026-06-01")).toEqual({ kind: "incoming", date: "2026-10-01" });
  });

  it("never shows a past incoming-by date: it reads as overdue instead", () => {
    const rows = [row("BW20DNA", { limited_qty: 300 })];
    const late = stockSignal(rows, LAUNCH, onHand({ BW20DNA: 0 }), incoming({ BW20DNA: "2026-09-20" }), today);
    expect(late).toEqual({ kind: "incoming_overdue", date: "2026-09-20" });
    const ahead = stockSignal(rows, LAUNCH, onHand({ BW20DNA: 0 }), incoming({ BW20DNA: "2026-10-30" }), today);
    expect(ahead).toEqual({ kind: "incoming", date: "2026-10-30" });
  });

  it("uses the latest incoming date among the short SKUs", () => {
    const rows = [row("A"), row("B")];
    const s = stockSignal(rows, LAUNCH, onHand({}), incoming({ A: "2026-10-05", B: "2026-10-30" }), today);
    expect(s).toEqual({ kind: "incoming", date: "2026-10-30" });
  });

  it("is quiet with no SKU rows or no dates", () => {
    expect(stockSignal([], LAUNCH, onHand({}), incoming({}), today)).toBeNull();
    const noDates = { launch_date: null, early_access_date: null, inventory_ready_by: null };
    expect(stockSignal([row("A")], noDates, onHand({ A: 5 }), incoming({}), today)).toBeNull();
  });
});

describe("withArrivedDropCards", () => {
  const card = (id: string, name: string, extra: Partial<BoardCardLike> = {}): BoardCardLike => ({ id, name, stage: "ordered", drop_tag: "Northern Lights", ...extra });
  const arrived = (id: string, name: string, extra: Partial<BoardCardLike> = {}) =>
    card(id, name, { archived_at: "2026-09-22T00:00:00Z", archive_reason: "arrived", ...extra });
  const groups: AddProductGroup<BoardCardLike>[] = [
    { tag: "Northern Lights", suggested: true, cards: [card("c1", "BW20DNA")] },
    { tag: "Alien Studio", suggested: false, cards: [card("c9", "Alien Recycler", { drop_tag: "Alien Studio" })] },
  ];

  it("adds the drop's arrived cards to the suggested group, sorted by name", () => {
    const out = withArrivedDropCards(groups, [arrived("c2", "NB6"), arrived("c3", "NB2")], "L1");
    expect(out[0].cards.map((c) => c.name)).toEqual(["BW20DNA", "NB2", "NB6"]);
    expect(out[1]).toBe(groups[1]);
  });

  it("leaves out cards already on this launch, non-arrived archived cards and duplicates", () => {
    const out = withArrivedDropCards(
      groups,
      [
        arrived("c2", "NB6", { linked_launch_id: "L1" }),
        card("c4", "Shelved", { archived_at: "2026-01-01T00:00:00Z", archive_reason: "shelved" }),
        arrived("c1", "BW20DNA"),
      ],
      "L1",
    );
    expect(out[0].cards.map((c) => c.id)).toEqual(["c1"]);
  });

  it("returns a copy of the groups when nothing is added", () => {
    const out = withArrivedDropCards(groups, [], "L1");
    expect(out).toEqual(groups);
    expect(out).not.toBe(groups);
  });
});
