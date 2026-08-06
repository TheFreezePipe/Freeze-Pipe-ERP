import { describe, it, expect } from "vitest";
import {
  deltaToWarehouseTotal,
  signedLedgerQuantity,
  type LedgerRow,
} from "./ledger-sign";

const row = (over: Partial<LedgerRow>): LedgerRow => ({
  quantity: 0,
  movement_kind: "net_change",
  field_affected: "warehouse_finished",
  from_field: null,
  to_field: null,
  ...over,
});

describe("signedLedgerQuantity", () => {
  it("flips write-offs negative (breakage stored as +1 displays as -1)", () => {
    expect(signedLedgerQuantity({ movement_kind: "write_off", quantity: 1 })).toBe(-1);
  });

  it("keeps a defensively-negative write-off negative", () => {
    expect(signedLedgerQuantity({ movement_kind: "write_off", quantity: -2 })).toBe(-2);
  });

  it("passes through already-signed rows untouched", () => {
    expect(signedLedgerQuantity({ movement_kind: "net_change", quantity: -5 })).toBe(-5);
    expect(signedLedgerQuantity({ movement_kind: "net_change", quantity: 40 })).toBe(40);
    expect(signedLedgerQuantity({ movement_kind: "category_move", quantity: 96 })).toBe(96);
  });
});

describe("deltaToWarehouseTotal", () => {
  it("counts breakage write-offs as a decrease to the warehouse total", () => {
    const breakage = row({
      movement_kind: "write_off",
      quantity: 1,
      field_affected: "warehouse_finished",
      from_field: "warehouse_finished",
    });
    expect(deltaToWarehouseTotal(breakage)).toBe(-1);
  });

  it("ignores a write-off from a non-warehouse field", () => {
    expect(
      deltaToWarehouseTotal(
        row({ movement_kind: "write_off", quantity: 3, field_affected: "eta", from_field: null }),
      ),
    ).toBe(0);
  });

  it("treats intra-warehouse category moves as neutral", () => {
    expect(
      deltaToWarehouseTotal(
        row({
          movement_kind: "category_move",
          quantity: 96,
          from_field: "warehouse_raw",
          to_field: "warehouse_in_production",
        }),
      ),
    ).toBe(0);
  });

  it("counts category moves leaving/entering the warehouse", () => {
    expect(
      deltaToWarehouseTotal(
        row({ movement_kind: "category_move", quantity: 10, from_field: "warehouse_finished", to_field: "shipped" }),
      ),
    ).toBe(-10);
    expect(
      deltaToWarehouseTotal(
        row({ movement_kind: "category_move", quantity: 10, from_field: "in_transit", to_field: "warehouse_raw" }),
      ),
    ).toBe(10);
  });

  it("passes signed net changes through and zeroes metadata + non-warehouse fields", () => {
    expect(deltaToWarehouseTotal(row({ movement_kind: "net_change", quantity: -3 }))).toBe(-3);
    expect(deltaToWarehouseTotal(row({ movement_kind: "metadata", quantity: -1 }))).toBe(0);
    expect(deltaToWarehouseTotal(row({ movement_kind: "net_change", quantity: 5, field_affected: "eta" }))).toBe(0);
  });
});
