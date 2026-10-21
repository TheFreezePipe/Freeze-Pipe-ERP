import { describe, it, expect, vi } from "vitest";
import { whRpc } from "./use-warehouse";

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
