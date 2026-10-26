import { describe, expect, it } from "vitest";
import { groupLpns, loosePutaway, lpnRange, reasonWords, voidCandidate, warehouseProgress } from "./lpn-progress";

type Ctr = Parameters<typeof voidCandidate>[1][number];

const T0 = "2026-10-23T10:00:00.000000+00:00";
const T1 = "2026-10-23T11:00:00.000000+00:00";

function ctr(code: string, seq: number, p: Partial<Ctr> = {}): Ctr {
  return {
    id: code,
    code,
    carton_seq: seq,
    carton_group_id: "g2",
    qty: 9,
    qty_initial: 9,
    state: "sealed",
    printed_at: null,
    created_at: T0,
    balances: [],
    ...p,
  };
}

// The SQL test's mixed group: TP3-B 25 + TP3-C 10 over 4 cartons → 6+3, 7+2, 6+3, 6+2
const mixed = { id: "g2", carton_qty: 4, received_cartons: 4, skus: [{ sku_id: "B", units_total: 25 }, { sku_id: "C", units_total: 10 }] };
const bal = (b: number, c: number) => [
  { sku_id: "B", bucket: "raw" as const, on_hand: b },
  { sku_id: "C", bucket: "raw" as const, on_hand: c },
];

describe("lpnRange", () => {
  it("writes the shared prefix once", () => {
    expect(lpnRange(["C-466-001", "C-466-002", "C-466-040"])).toBe("C-466-001…040");
    expect(lpnRange(["C-AIR270-001"])).toBe("C-AIR270-001");
    expect(lpnRange(["C-466-003B", "C-466-007"])).toBe("C-466-003B…007");
    expect(lpnRange([])).toBeNull();
  });
});

describe("voidCandidate (mirrors _freight_void_cartons)", () => {
  const cartons = [
    ctr("C-1-004", 4, { balances: bal(6, 3) }),
    ctr("C-1-005", 5, { balances: bal(7, 2) }),
    ctr("C-1-006", 6, { balances: bal(6, 3) }),
    ctr("C-1-007", 7, { qty: 8, qty_initial: 8, balances: bal(6, 2) }),
  ];

  it("voids the newest sealed carton when it holds the slot being reversed", () => {
    expect(voidCandidate(mixed, cartons)?.code).toBe("C-1-007");
  });

  it("prefers an exact match for the slot over a newer carton with other contents", () => {
    // slot 3 holds 6+3: 006 is opened, so 004 (6+3) beats the newer 005 (7+2)
    const opened = cartons.map((c) => (c.code === "C-1-006" ? { ...c, state: "open" as const, qty: 5 } : c));
    expect(voidCandidate({ ...mixed, received_cartons: 3 }, opened.filter((c) => c.code !== "C-1-007"))?.code).toBe("C-1-004");
  });

  it("falls back to the newest sealed-and-full carton, by check-in time first", () => {
    const later = [ctr("C-1-005", 5, { balances: bal(7, 2), created_at: T1 }), ctr("C-1-009", 9, { balances: bal(7, 2) })];
    expect(voidCandidate({ ...mixed, received_cartons: 3 }, later)?.code).toBe("C-1-005");
  });

  it("finds nothing once every carton is opened, voided or split", () => {
    const gone = [
      ctr("C-1-004", 4, { state: "open", balances: bal(6, 3) }),
      ctr("C-1-005", 5, { state: "void", qty: 0 }),
      ctr("C-1-006", 6, { qty: 4, balances: bal(4, 0) }),
    ];
    expect(voidCandidate({ ...mixed, received_cartons: 2 }, gone)).toBeNull();
    expect(voidCandidate({ ...mixed, received_cartons: 0 }, cartons)).toBeNull();
  });

  it("may void a carton the rounding left empty", () => {
    const tiny = { id: "g2", carton_qty: 5, received_cartons: 5, skus: [{ sku_id: "B", units_total: 2 }] };
    expect(voidCandidate(tiny, [ctr("C-1-010", 10, { state: "empty", qty: 0, qty_initial: 0 })])?.code).toBe("C-1-010");
  });
});

describe("groupLpns, loosePutaway and warehouseProgress", () => {
  const cartons = [
    ctr("C-1-005", 5, { balances: bal(7, 2), printed_at: T1 }),
    ctr("C-1-004", 4, { balances: bal(6, 3), printed_at: T1 }),
    ctr("C-1-007", 7, { state: "void", qty: 0 }),
  ];
  const tasks = [
    { status: "done", sku_id: null, qty: null, container_id: "C-1-004", container: { carton_group_id: "g2" } },
    { status: "open", sku_id: null, qty: null, container_id: "C-1-005", container: { carton_group_id: "g2" } },
    { status: "cancelled", sku_id: null, qty: null, container_id: "C-1-007", container: { carton_group_id: "g2" } },
    { status: "done", sku_id: "A", qty: 10, container_id: null, container: null },
    { status: "open", sku_id: "A", qty: 5, container_id: null, container: null },
  ];

  it("summarises a group's live cartons and putaways", () => {
    const g = groupLpns({ ...mixed, received_cartons: 2 }, cartons, tasks);
    expect(g.live.map((c) => c.code)).toEqual(["C-1-004", "C-1-005"]);
    expect(g.range).toBe("C-1-004…005");
    expect([g.putawayDone, g.putawayTotal]).toEqual([1, 2]);
    expect(g.voidCandidate?.code).toBe("C-1-005");
  });

  it("counts loose units per SKU", () => {
    expect(loosePutaway("A", tasks)).toEqual({ units: 15, done: 10 });
    expect(loosePutaway("Z", tasks)).toEqual({ units: 0, done: 0 });
  });

  it("feeds the stepper", () => {
    expect(warehouseProgress([{ carton_qty: 4 }, { carton_qty: 4 }], cartons, tasks)).toEqual({
      cartonsPlanned: 8,
      labelled: 2,
      printed: 2,
      putawayTotal: 4,
      putawayDone: 2,
    });
  });

  it("words the suggestion reason", () => {
    expect(reasonWords("same_sku_reserve")).toBe("Reserve with the same SKU");
    expect(reasonWords(null)).toBe("No suggestion");
  });
});
