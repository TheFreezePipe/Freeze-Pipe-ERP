import { describe, expect, it } from "vitest";
import {
  LABEL_STAGE,
  PUTAWAY_STAGE,
  STAGE_LABELS,
  stageStates,
  stagesWithWarehouse,
  type WarehouseProgress,
} from "./shipment-stages";

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

describe("stagesWithWarehouse", () => {
  const wh = (p: Partial<WarehouseProgress> = {}): WarehouseProgress => ({
    cartonsPlanned: 31,
    labelled: 0,
    printed: 0,
    putawayTotal: 0,
    putawayDone: 0,
    ...p,
  });
  const view = (r: ReturnType<typeof stagesWithWarehouse>) => r.stages.map((s) => `${s.label}:${s.state}${s.progress ? `:${s.progress}` : ""}`);

  it("without warehouse data it is the five transit stages", () => {
    expect(stagesWithWarehouse(shipment("tracking"), null).stages.map((s) => s.label)).toEqual([...STAGE_LABELS]);
  });

  it("adds Label cartons before Received and Put away after it, future until check-in starts", () => {
    expect(view(stagesWithWarehouse(shipment("tracking"), wh()))).toEqual([
      "Created:done",
      "Shipped:done",
      "Customs:done",
      "Ground:current",
      `${LABEL_STAGE}:future:0/31`,
      "Received:future",
      `${PUTAWAY_STAGE}:future`,
    ]);
  });

  it("during check-in the transit stages are done and Label cartons is current", () => {
    const r = stagesWithWarehouse(shipment("cleared_customs"), wh({ labelled: 21, printed: 21, putawayTotal: 21, putawayDone: 7 }));
    expect(view(r)).toEqual([
      "Created:done",
      "Shipped:done",
      "Customs:done",
      "Ground:done",
      `${LABEL_STAGE}:current:21/31`,
      "Received:future",
      `${PUTAWAY_STAGE}:future:7/21`,
    ]);
  });

  it("once received, Put away is current until every task is done", () => {
    const received = shipment("delivered", "2026-10-22T14:00:00Z");
    expect(view(stagesWithWarehouse(received, wh({ labelled: 31, printed: 31, putawayTotal: 31, putawayDone: 24 }))).slice(4)).toEqual([
      `${LABEL_STAGE}:done:31/31`,
      "Received:done",
      `${PUTAWAY_STAGE}:current:24/31`,
    ]);
    expect(
      stagesWithWarehouse(received, wh({ labelled: 31, printed: 31, putawayTotal: 31, putawayDone: 31 })).stages.every((s) => s.state === "done"),
    ).toBe(true);
  });

  it("keeps Label cartons open while a received shipment has unprinted labels", () => {
    const received = shipment("delivered", "2026-10-22T14:00:00Z");
    const label = stagesWithWarehouse(received, wh({ labelled: 31, printed: 29, putawayTotal: 31 })).stages[4];
    expect(label).toEqual({ label: LABEL_STAGE, state: "current", progress: "29/31 printed" });
  });

  it("loose units (no carton plan) get Put away without a label stage", () => {
    const r = stagesWithWarehouse(shipment("delivered", "2026-10-22T14:00:00Z"), wh({ cartonsPlanned: 0, putawayTotal: 2, putawayDone: 1 }));
    expect(r.stages.map((s) => s.label)).toEqual([...STAGE_LABELS, PUTAWAY_STAGE]);
    expect(r.stages[5]).toEqual({ label: PUTAWAY_STAGE, state: "current", progress: "1/2" });
  });
});
