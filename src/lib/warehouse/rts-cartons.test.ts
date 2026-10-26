import { describe, it, expect } from "vitest";
import {
  addCarton,
  assignedUnits,
  canAddCarton,
  checkRtsPlan,
  clearLoose,
  confirmByScan,
  looseRemainder,
  mergeCarton,
  newRtsPlan,
  physicalLayerLive,
  reduceRtsPlan,
  rtsCartonsPayload,
  rtsRules,
  setCartonQty,
  takenUnits,
  toggleCartonState,
  unassignedUnits,
  type TakenCarton,
} from "./rts-cartons";

const qtys = (plan: ReturnType<typeof newRtsPlan>) => plan.cartons.map((c) => c.qty);

describe("newRtsPlan", () => {
  it("starts with one sealed carton holding the whole batch", () => {
    const plan = newRtsPlan(96);
    expect(plan.cartons).toEqual([{ key: 1, qty: 96, state: "sealed" }]);
    expect(plan.loose).toBe(0);
    expect(unassignedUnits(plan)).toBe(0);
    expect(checkRtsPlan(plan).ok).toBe(true);
  });

  it("has no carton for an empty batch, and says so", () => {
    const plan = newRtsPlan(0);
    expect(plan.cartons).toEqual([]);
    expect(checkRtsPlan(plan).problems).toEqual(["Set the quantity first."]);
  });

  it("treats fractions and negatives as whole units at least zero", () => {
    expect(newRtsPlan(7.9).total).toBe(7);
    expect(newRtsPlan(-3).total).toBe(0);
  });
});

describe("split (Add another carton)", () => {
  it("keeps a standard carton's worth and moves the rest to the new carton", () => {
    const plan = addCarton(newRtsPlan(96), 48);
    expect(qtys(plan)).toEqual([48, 48]);
    expect(assignedUnits(plan)).toBe(96);
  });

  it("splits a 100-unit batch 48 + 52, then the 52 into 48 + 4", () => {
    const two = addCarton(newRtsPlan(100), 48);
    expect(qtys(two)).toEqual([48, 52]);
    expect(qtys(addCarton(two, 48))).toEqual([48, 48, 4]);
  });

  it("halves (rounding up the kept part) without a standard, or when the carton is not over it", () => {
    expect(qtys(addCarton(newRtsPlan(7)))).toEqual([4, 3]);
    expect(qtys(addCarton(newRtsPlan(40), 48))).toEqual([20, 20]);
  });

  it("puts unassigned units into the new carton instead of splitting", () => {
    const plan = addCarton(setCartonQty(newRtsPlan(96), 1, 90));
    expect(qtys(plan)).toEqual([90, 6]);
    expect(checkRtsPlan(plan).ok).toBe(true);
  });

  it("gives every new carton a fresh key", () => {
    const plan = addCarton(addCarton(newRtsPlan(9)));
    expect(new Set(plan.cartons.map((c) => c.key)).size).toBe(3);
  });

  it("does nothing when no carton holds two or more and nothing is unassigned", () => {
    const one = newRtsPlan(1);
    expect(canAddCarton(one)).toBe(false);
    expect(addCarton(one)).toBe(one);
  });
});

describe("merge (remove a carton)", () => {
  it("merges a carton's units into the one before it", () => {
    const plan = addCarton(addCarton(newRtsPlan(96), 48), 24);
    expect(qtys(plan)).toEqual([48, 24, 24]);
    const merged = mergeCarton(plan, plan.cartons[2].key);
    expect(qtys(merged)).toEqual([48, 48]);
    expect(checkRtsPlan(merged).ok).toBe(true);
  });

  it("merges the first carton into the next one", () => {
    const plan = addCarton(newRtsPlan(96), 48);
    expect(qtys(mergeCarton(plan, plan.cartons[0].key))).toEqual([96]);
  });

  it("leaves the only carton's units unassigned", () => {
    const plan = mergeCarton(newRtsPlan(12), 1);
    expect(plan.cartons).toEqual([]);
    expect(unassignedUnits(plan)).toBe(12);
    expect(checkRtsPlan(plan).ok).toBe(false);
  });

  it("ignores an unknown key", () => {
    const plan = newRtsPlan(5);
    expect(mergeCarton(plan, 99)).toBe(plan);
  });
});

describe("remainder loose to pick face", () => {
  it("sends whatever no carton holds loose", () => {
    const plan = looseRemainder(setCartonQty(newRtsPlan(100), 1, 96));
    expect(plan.loose).toBe(4);
    expect(checkRtsPlan(plan).ok).toBe(true);
    expect(rtsCartonsPayload(plan)).toEqual([{ qty: 96, state: "sealed" }, { qty: 4, loose: true }]);
  });

  it("does nothing when everything is in a carton", () => {
    const plan = newRtsPlan(10);
    expect(looseRemainder(plan)).toBe(plan);
  });

  it("clearing the remainder makes its units unassigned again", () => {
    const plan = clearLoose(looseRemainder(setCartonQty(newRtsPlan(10), 1, 8)));
    expect(plan.loose).toBe(0);
    expect(unassignedUnits(plan)).toBe(2);
  });

  it("may send the whole batch loose only when no carton is required", () => {
    const plan = looseRemainder(mergeCarton(newRtsPlan(6), 1));
    expect(checkRtsPlan(plan).ok).toBe(true);
    expect(checkRtsPlan(plan, { requireCarton: true }).problems).toEqual([
      "At least one carton needs a green label at this station.",
    ]);
    expect(rtsCartonsPayload(plan)).toEqual([{ qty: 6, loose: true }]);
  });
});

describe("sum check", () => {
  it("reports units in no carton", () => {
    const check = checkRtsPlan(setCartonQty(newRtsPlan(96), 1, 95));
    expect(check.ok).toBe(false);
    expect(check.unassigned).toBe(1);
    expect(check.problems).toEqual(["1 unit is in no carton: add a carton or send the remainder loose."]);
  });

  it("reports cartons holding more than the batch", () => {
    const check = checkRtsPlan(setCartonQty(newRtsPlan(96), 1, 100));
    expect(check.ok).toBe(false);
    expect(check.problems).toEqual(["The cartons hold 4 more than the 96 logged."]);
  });

  it("reports an empty carton", () => {
    const plan = setCartonQty(addCarton(newRtsPlan(10)), 1, 0);
    expect(checkRtsPlan(plan).problems).toContain("Carton 1 is empty: give it units or remove it.");
  });

  it("keeps state through toggles and leaves empty cartons out of the payload", () => {
    const plan = toggleCartonState(addCarton(newRtsPlan(10)), 2);
    expect(plan.cartons.map((c) => c.state)).toEqual(["sealed", "open"]);
    expect(rtsCartonsPayload(plan)).toEqual([
      { qty: 5, state: "sealed" },
      { qty: 5, state: "open" },
    ]);
    expect(rtsCartonsPayload(setCartonQty(plan, 2, 0))).toEqual([{ qty: 5, state: "sealed" }]);
  });
});

describe("reduceRtsPlan (the line holds less than was logged)", () => {
  it("cuts the loose remainder first, then the last cartons", () => {
    const plan = looseRemainder(setCartonQty(addCarton(newRtsPlan(100), 48), 2, 48));
    expect(qtys(plan)).toEqual([48, 48]);
    expect(plan.loose).toBe(4);
    const reduced = reduceRtsPlan(plan, 90);
    expect(reduced.total).toBe(90);
    expect(reduced.loose).toBe(0);
    expect(qtys(reduced)).toEqual([48, 42]);
    expect(checkRtsPlan(reduced).ok).toBe(true);
  });

  it("drops cartons that reach zero", () => {
    const reduced = reduceRtsPlan(addCarton(newRtsPlan(96), 48), 40);
    expect(qtys(reduced)).toEqual([40]);
    expect(checkRtsPlan(reduced).ok).toBe(true);
  });

  it("takes unassigned units before any carton", () => {
    const reduced = reduceRtsPlan(setCartonQty(newRtsPlan(96), 1, 90), 92);
    expect(qtys(reduced)).toEqual([90]);
    expect(unassignedUnits(reduced)).toBe(2);
  });

  it("never grows a plan", () => {
    const plan = newRtsPlan(10);
    expect(reduceRtsPlan(plan, 12)).toBe(plan);
  });
});

describe("settings", () => {
  const now = Date.parse("2026-10-26T15:00:00Z");

  it("is live only once live_since is set and has passed", () => {
    expect(physicalLayerLive({ physical_layer: { live_since: null } }, now)).toBe(false);
    expect(physicalLayerLive({ physical_layer: { live_since: "2026-10-26T14:00:00Z" } }, now)).toBe(true);
    expect(physicalLayerLive({ physical_layer: { live_since: "2026-10-27T00:00:00Z" } }, now)).toBe(false);
    expect(physicalLayerLive({ physical_layer: { live_since: "not a date" } }, now)).toBe(false);
    expect(physicalLayerLive(undefined, now)).toBe(false);
    expect(physicalLayerLive({}, now)).toBe(false);
  });

  it("reads the RTS rules with true defaults", () => {
    expect(rtsRules(undefined)).toEqual({ requireRelabel: true, allowNoParent: true });
    expect(rtsRules({ rts: { require_relabel: false, allow_no_parent: false } })).toEqual({
      requireRelabel: false,
      allowNoParent: false,
    });
  });

  it("confirms destinations by scan unless confirm_putaway_location is off", () => {
    expect(confirmByScan(undefined)).toBe(true);
    expect(confirmByScan({ scan_rules: { confirm_putaway_location: true } })).toBe(true);
    expect(confirmByScan({ scan_rules: { confirm_putaway_location: false } })).toBe(false);
  });
});

describe("takenUnits (emptying pre-fill)", () => {
  const carton = (over: Partial<TakenCarton>): TakenCarton => ({
    id: "c",
    code: "C-1",
    sku_id: "sku-a",
    sku: "BW20",
    units: 12,
    from_code: "01-01-3",
    already_at_line: false,
    ...over,
  });

  it("sums the scanned cartons of the task's SKU only", () => {
    const taken = [
      carton({ id: "1" }),
      carton({ id: "2", units: 7 }),
      carton({ id: "3", sku_id: "sku-b" }),
      carton({ id: "4", sku_id: null }),
    ];
    expect(takenUnits(taken, "sku-a")).toBe(19);
    expect(takenUnits(taken, "sku-b")).toBe(12);
    expect(takenUnits(taken, null)).toBe(0);
  });
});
