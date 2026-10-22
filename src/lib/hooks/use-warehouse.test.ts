import { describe, it, expect, vi } from "vitest";
import { whRpc } from "./use-warehouse";
import { endWhStation, startWhStation } from "./use-warehouse-tasks";

function mockClient(response: { data: unknown; error: unknown }) {
  return { rpc: vi.fn().mockResolvedValue(response) };
}

describe("whRpc (warehouse envelope seam)", () => {
  it("calls the named RPC with its arguments and returns the envelope", async () => {
    const client = mockClient({ data: { ok: true, code: "138332000051" }, error: null });
    const result = await whRpc("rpc_wh_link_barcode", { p_sku_id: "sku-1", p_scan: "1383325" }, "fallback", client);
    expect(client.rpc).toHaveBeenCalledWith("rpc_wh_link_barcode", { p_sku_id: "sku-1", p_scan: "1383325" });
    expect(result.code).toBe("138332000051");
  });

  it("throws the server's error text when ok is false", async () => {
    const client = mockClient({ data: { ok: false, error: "That code already belongs to BW20" }, error: null });
    await expect(
      whRpc("rpc_wh_link_barcode", { p_sku_id: "sku-1", p_scan: "1383325" }, "fallback", client),
    ).rejects.toThrow("That code already belongs to BW20");
  });

  it("falls back to the caller's message when the envelope has none", async () => {
    const client = mockClient({ data: null, error: null });
    await expect(whRpc("rpc_wh_barcode_coverage", {}, "Couldn't load barcode coverage", client)).rejects.toThrow(
      "Couldn't load barcode coverage",
    );
  });

  it("rethrows transport errors untouched", async () => {
    const transport = { code: "42883", message: "function rpc_wh_resolve_scan does not exist" };
    const client = mockClient({ data: null, error: transport });
    await expect(whRpc("rpc_wh_resolve_scan", { p_scan: "BW20" }, "fallback", client)).rejects.toBe(transport);
  });
});

describe("whRpc with Phase 1 envelopes", () => {
  it("throws the human message rather than the machine code", async () => {
    const client = mockClient({
      data: { ok: false, error: "already_at_line", message: "C-466-007 is already at the manufacturing line." },
      error: null,
    });
    await expect(whRpc("rpc_wh_take_to_line", { p_container_id: "ctr-1" }, "fallback", client)).rejects.toThrow(
      "C-466-007 is already at the manufacturing line.",
    );
  });
});

describe("station session mutations", () => {
  it("start calls rpc_wh_start_station with the scanned value and the device id", async () => {
    const client = mockClient({
      data: { ok: true, unchanged: false, ended_previous: null, session: { id: "s-1", code: "ST-MFG-2" }, printers: [] },
      error: null,
    });
    const result = await startWhStation({ scan: "%ST-MFG-2", deviceId: "dev-1" }, client);
    expect(client.rpc).toHaveBeenCalledWith("rpc_wh_start_station", { p_scan_value: "%ST-MFG-2", p_device_id: "dev-1" });
    expect(result.session.code).toBe("ST-MFG-2");
  });

  it("start sends a null device id when there is none", async () => {
    const client = mockClient({ data: { ok: true, session: { id: "s-1" }, printers: [] }, error: null });
    await startWhStation({ scan: "%ST-DOCK" }, client);
    expect(client.rpc).toHaveBeenCalledWith("rpc_wh_start_station", { p_scan_value: "%ST-DOCK", p_device_id: null });
  });

  it("start throws the server's message when ok is false", async () => {
    const client = mockClient({
      data: { ok: false, error: "not_a_station", message: "02-01-2 is not a station label." },
      error: null,
    });
    await expect(startWhStation({ scan: "%02-01-2" }, client)).rejects.toThrow("02-01-2 is not a station label.");
  });

  it("end calls rpc_wh_end_station with no arguments", async () => {
    const client = mockClient({ data: { ok: true, ended: "s-1" }, error: null });
    const result = await endWhStation(client);
    expect(client.rpc).toHaveBeenCalledWith("rpc_wh_end_station", {});
    expect(result.ended).toBe("s-1");
  });

  it("end throws when ok is false", async () => {
    const client = mockClient({ data: { ok: false, error: "forbidden", message: "Station sessions need an internal account." }, error: null });
    await expect(endWhStation(client)).rejects.toThrow("Station sessions need an internal account.");
  });
});
