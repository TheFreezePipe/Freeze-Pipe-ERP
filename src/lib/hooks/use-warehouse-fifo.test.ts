import { describe, it, expect, vi } from "vitest";
import type { WhNextCarton } from "./use-warehouse";
import {
  describeNextCarton,
  fetchWhNextCartons,
  fifoSuggestsParts,
  fifoSuggestsText,
  nextCartonPullLine,
  NEXT_CARTON_REASON_WORDS,
  WH_NEXT_CARTONS_CHUNK,
} from "./use-warehouse-fifo";

const NOW = new Date("2026-10-28T12:00:00Z");

/** A next carton; the server may still send null for fields the type says are always there. */
function carton(over: { [K in keyof WhNextCarton]?: WhNextCarton[K] | null } = {}): WhNextCarton {
  return {
    container_id: "c-466-004",
    code: "C-466-004",
    state: "sealed",
    qty: 48,
    bucket: "raw",
    location_id: "l-05-02-1",
    location_code: "05-02-1",
    factory_order_id: "fo-118",
    factory_order_number: "FO-2026-118",
    order_date: "2026-08-01",
    shipment_id: "sh-1",
    shipment_number: "SH-2026-031",
    received_at: "2026-10-20T15:00:00Z",
    reason: "oldest_batch",
    ...over,
  } as unknown as WhNextCarton;
}

function mockClient(...responses: { data: unknown; error: unknown }[]) {
  const rpc = vi.fn();
  for (const r of responses) rpc.mockResolvedValueOnce(r);
  return { rpc };
}

describe("fetchWhNextCartons (rpc_wh_next_cartons)", () => {
  it("sends the de-duplicated, sorted ids and maps every id, unknown ones to null", async () => {
    const next = carton();
    const client = mockClient({ data: { ok: true, next: { "sku-b": next, "sku-a": null } }, error: null });
    const res = await fetchWhNextCartons(["sku-b", "sku-a", "sku-b", "sku-c"], client);
    expect(client.rpc).toHaveBeenCalledTimes(1);
    expect(client.rpc).toHaveBeenCalledWith("rpc_wh_next_cartons", { p_sku_ids: ["sku-a", "sku-b", "sku-c"] });
    expect(res).toEqual({ "sku-a": null, "sku-b": next, "sku-c": null });
  });

  it("asks in chunks of 200 and merges the answers", async () => {
    const ids = Array.from({ length: WH_NEXT_CARTONS_CHUNK + 5 }, (_, i) => `sku-${String(i).padStart(3, "0")}`);
    const last = carton({ code: "C-999-001" });
    const client = mockClient(
      { data: { ok: true, next: { "sku-000": carton() } }, error: null },
      { data: { ok: true, next: { "sku-204": last } }, error: null },
    );
    const res = await fetchWhNextCartons(ids, client);
    expect(client.rpc).toHaveBeenCalledTimes(2);
    expect((client.rpc.mock.calls[0][1] as { p_sku_ids: string[] }).p_sku_ids).toHaveLength(WH_NEXT_CARTONS_CHUNK);
    expect((client.rpc.mock.calls[1][1] as { p_sku_ids: string[] }).p_sku_ids).toEqual(ids.slice(WH_NEXT_CARTONS_CHUNK));
    expect(Object.keys(res)).toHaveLength(ids.length);
    expect(res["sku-000"]?.code).toBe("C-466-004");
    expect(res["sku-204"]).toBe(last);
    expect(res["sku-100"]).toBeNull();
  });

  it("makes no call for an empty list", async () => {
    const client = mockClient();
    expect(await fetchWhNextCartons([], client)).toEqual({});
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it("throws the server's message on ok:false and rethrows transport errors", async () => {
    await expect(
      fetchWhNextCartons(["sku-a"], mockClient({ data: { ok: false, error: "forbidden", message: "Next cartons need an internal account." }, error: null })),
    ).rejects.toThrow("Next cartons need an internal account.");
    const transport = { code: "42883", message: "function rpc_wh_next_cartons does not exist" };
    await expect(fetchWhNextCartons(["sku-a"], mockClient({ data: null, error: transport }))).rejects.toBe(transport);
  });
});

describe("describeNextCarton", () => {
  it("builds the dashboard line and the reason word", () => {
    const d = describeNextCarton(carton(), NOW);
    expect(d.line).toBe("C-466-004 · 05-02-1 · FO-2026-118 · received Oct 20");
    expect(d.detail).toBe("05-02-1 · FO-2026-118 · received Oct 20");
    expect(d.reason).toBe("oldest batch");
    expect(d).toMatchObject({ code: "C-466-004", location: "05-02-1", batch: "FO-2026-118", received: "received Oct 20" });
  });

  it("names each rule", () => {
    expect(describeNextCarton(carton({ reason: "open_carton", state: "open" }), NOW).reason).toBe("open carton");
    expect(describeNextCarton(carton({ reason: "oldest_received" }), NOW).reason).toBe("oldest on the shelf");
    expect(NEXT_CARTON_REASON_WORDS).toEqual({
      open_carton: "open carton",
      oldest_batch: "oldest batch",
      oldest_received: "oldest on the shelf",
    });
  });

  it("drops the parts it does not know", () => {
    const d = describeNextCarton(
      carton({ location_code: null, factory_order_number: null, received_at: null, reason: "oldest_received" }),
      NOW,
    );
    expect(d.line).toBe("C-466-004");
    expect(d.detail).toBe("");
    expect(describeNextCarton(carton({ factory_order_number: null }), NOW).line).toBe("C-466-004 · 05-02-1 · received Oct 20");
  });

  it("adds the year to a check-in from another year", () => {
    expect(describeNextCarton(carton({ received_at: "2025-11-03T15:00:00Z" }), NOW).received).toBe("received Nov 3, 2025");
  });
});

describe("take-to-line words", () => {
  it("the suggestion line names the carton, the bin, the rule and the batch", () => {
    expect(nextCartonPullLine(carton())).toBe("Pull C-466-004 from 05-02-1 (oldest batch, FO-2026-118)");
    expect(nextCartonPullLine(carton({ location_code: null, factory_order_number: null, reason: "oldest_received" }))).toBe(
      "Pull C-466-004 (oldest on the shelf)",
    );
  });

  it("the prompt says the scanned carton is newer and why the other is older", () => {
    expect(fifoSuggestsText("C-472-003", carton(), NOW)).toBe(
      "C-472-003 is newer. C-466-004 in 05-02-1 is older (FO-2026-118, received Oct 20).",
    );
    expect(fifoSuggestsText("C-472-003", carton({ location_code: null, factory_order_number: null, received_at: null }), NOW)).toBe(
      "C-472-003 is newer. C-466-004 is older.",
    );
  });

  it("splits the sentence so the screen can link both carton codes", () => {
    expect(fifoSuggestsParts("C-472-003", carton(), NOW)).toEqual([
      { code: "C-472-003" },
      { text: " is newer. " },
      { code: "C-466-004" },
      { text: " in 05-02-1 is older (FO-2026-118, received Oct 20)." },
    ]);
    expect(fifoSuggestsParts("C-472-003", carton({ reason: "open_carton", state: "open" }), NOW).filter((p) => "code" in p)).toEqual([
      { code: "C-466-004" },
      { code: "C-472-003" },
    ]);
  });

  it("an open carton is named as open, not older", () => {
    expect(fifoSuggestsText("C-472-003", carton({ reason: "open_carton", state: "open" }), NOW)).toBe(
      "C-466-004 in 05-02-1 is already open (FO-2026-118, received Oct 20). Finish it before C-472-003.",
    );
  });
});
