import { describe, expect, it } from "vitest";
import { STAGE_LABELS, stageStates } from "./shipment-stages";

const shipment = (status: string, receipt_confirmed_at: string | null = null) => ({
  status,
  receipt_confirmed_at,
});

describe("stageStates", () => {
  it("answers one state per stage", () => {
    expect(stageStates(shipment("pending")).states).toHaveLength(STAGE_LABELS.length);
  });

  it.each([
    ["pending", ["done", "future", "future", "future", "future"]],
    ["on_the_water", ["done", "current", "future", "future", "future"]],
    ["high_risk", ["done", "current", "future", "future", "future"]],
    ["cleared_customs", ["done", "done", "current", "future", "future"]],
    ["tracking", ["done", "done", "done", "current", "future"]],
    ["out_for_delivery", ["done", "done", "done", "current", "future"]],
  ])("%s", (status, states) => {
    expect(stageStates(shipment(status))).toEqual({ states, deliveredUnconfirmed: false });
  });

  it("keeps a delivered shipment on Ground until the dock confirms receipt", () => {
    expect(stageStates(shipment("delivered"))).toEqual({
      states: ["done", "done", "done", "current", "future"],
      deliveredUnconfirmed: true,
    });
    expect(stageStates(shipment("delivered", "2026-10-05T14:00:00Z"))).toEqual({
      states: ["done", "done", "done", "done", "done"],
      deliveredUnconfirmed: false,
    });
  });

  it("reads a status outside the map as created only", () => {
    expect(stageStates(shipment("booked")).states).toEqual(["done", "future", "future", "future", "future"]);
  });
});
