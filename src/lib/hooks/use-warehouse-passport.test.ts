import { describe, expect, it, vi } from "vitest";
import { fetchWhCartonPassport } from "./use-warehouse-passport";

function mockClient(response: { data: unknown; error: unknown }) {
  return { rpc: vi.fn().mockResolvedValue(response) };
}

describe("fetchWhCartonPassport", () => {
  it("calls rpc_wh_carton_passport with the trimmed code and returns the passport", async () => {
    const client = mockClient({
      data: { ok: true, carton: { id: "c-1", code: "C-466-007" }, batch: null, timeline: [], legs: {} },
      error: null,
    });
    const res = await fetchWhCartonPassport(" C-466-007 ", client);
    expect(client.rpc).toHaveBeenCalledWith("rpc_wh_carton_passport", { p_code: "C-466-007" });
    expect(res.found).toBe(true);
    if (res.found) expect(res.passport.carton.code).toBe("C-466-007");
  });

  it("turns carton_not_found into a not-found answer instead of an error", async () => {
    const client = mockClient({ data: { ok: false, error: "carton_not_found", message: "No carton C-NOPE." }, error: null });
    await expect(fetchWhCartonPassport("C-NOPE", client)).resolves.toEqual({ found: false, code: "C-NOPE" });
  });

  it("throws any other refusal with its message", async () => {
    const client = mockClient({ data: { ok: false, error: "forbidden", message: "Only staff can read cartons." }, error: null });
    await expect(fetchWhCartonPassport("C-1", client)).rejects.toThrow("Only staff can read cartons.");
  });

  it("rethrows transport errors untouched", async () => {
    const boom = { message: "JWT expired", code: "PGRST301" };
    const client = mockClient({ data: null, error: boom });
    await expect(fetchWhCartonPassport("C-1", client)).rejects.toBe(boom);
  });
});
