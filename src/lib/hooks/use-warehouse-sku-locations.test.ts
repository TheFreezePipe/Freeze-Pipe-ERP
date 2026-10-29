import { describe, expect, it, vi } from "vitest";
import {
  fetchWhSkuLocations,
  groupWhSkuLocations,
  type WhSkuBalanceRow,
  type WhSkuLocationRef,
} from "./use-warehouse-sku-locations";

function loc(code: string, over: Partial<WhSkuLocationRef> = {}): WhSkuLocationRef {
  return { id: `l-${code}`, code, kind: "bay_level", zone: "RAW", pickable: false, is_overflow: false, pick_sequence: null, ...over };
}

let n = 0;
function row(location: WhSkuLocationRef, on_hand: number, over: Partial<WhSkuBalanceRow> = {}): WhSkuBalanceRow {
  n += 1;
  return { id: `b-${n}`, location_id: location.id, container_id: null, bucket: "raw", on_hand, location, container: null, ...over };
}

function carton(code: string, over: Partial<NonNullable<WhSkuBalanceRow["container"]>> = {}) {
  return { id: `c-${code}`, code, state: "sealed" as const, qty: 24, label_stock: "white" as const, created_at: "2026-10-01T10:00:00Z", ...over };
}

function inCarton(location: WhSkuLocationRef, on_hand: number, c: ReturnType<typeof carton>, over: Partial<WhSkuBalanceRow> = {}) {
  return row(location, on_hand, { container_id: c.id, container: c, ...over });
}

describe("groupWhSkuLocations", () => {
  it("makes one entry per location with its units, cartons and loose units by bucket", () => {
    const a = loc("02-01-1", { pick_sequence: 10, pickable: true });
    const c1 = carton("C-100-001");
    const c2 = carton("C-100-002");
    const out = groupWhSkuLocations([
      inCarton(a, 24, c1),
      inCarton(a, 20, c2),
      row(a, 7, { bucket: "raw" }),
      row(a, 5, { bucket: "finished" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].location).toEqual({ id: "l-02-01-1", code: "02-01-1", kind: "bay_level", zone: "RAW", pickable: true, is_overflow: false, pick_sequence: 10 });
    expect(out[0].units).toBe(56);
    expect(out[0].cartons.map((c) => [c.code, c.qty, c.bucket])).toEqual([
      ["C-100-001", 24, "raw"],
      ["C-100-002", 20, "raw"],
    ]);
    expect(out[0].loose).toEqual([
      { bucket: "raw", units: 7 },
      { bucket: "finished", units: 5 },
    ]);
  });

  it("lists a carton holding two buckets of the SKU once, with the units summed", () => {
    const a = loc("02-01-2");
    const c = carton("C-200-001", { qty: 30 });
    const out = groupWhSkuLocations([
      inCarton(a, 10, c, { bucket: "raw" }),
      inCarton(a, 18, c, { bucket: "prefilled_raw" }),
    ]);
    expect(out[0].cartons).toHaveLength(1);
    expect(out[0].cartons[0]).toMatchObject({ code: "C-200-001", qty: 28, bucket: "prefilled_raw", buckets: ["prefilled_raw", "raw"] });
    expect(out[0].units).toBe(28);
    expect(out[0].loose).toEqual([]);
  });

  it("sorts cartons oldest first, then by code", () => {
    const a = loc("05-01-1");
    const out = groupWhSkuLocations([
      inCarton(a, 1, carton("C-3", { created_at: "2026-10-05T00:00:00Z" })),
      inCarton(a, 1, carton("C-2", { created_at: "2026-09-01T00:00:00Z" })),
      inCarton(a, 1, carton("C-1", { created_at: "2026-10-05T00:00:00Z" })),
      inCarton(a, 1, carton("C-0", { created_at: null })),
    ]);
    expect(out[0].cartons.map((c) => c.code)).toEqual(["C-2", "C-1", "C-3", "C-0"]);
  });

  it("orders real locations by walk order (unset last) then code, and virtual ones last", () => {
    const rows = [
      row(loc("UNLOCATED", { kind: "virtual", zone: "VIRTUAL" }), 1),
      row(loc("MFG-LINE", { kind: "virtual", zone: "MFG" }), 1),
      row(loc("SPARES-01", { kind: "floor", zone: "SPARE" }), 1),
      row(loc("03-02-1", { pick_sequence: 30 }), 1),
      row(loc("IN-01", { kind: "floor", zone: "IN" }), 1),
      row(loc("02-04-3", { pick_sequence: 5, is_overflow: true }), 1),
      row(loc("PK-01", { kind: "station", zone: "PACK" }), 1),
    ];
    expect(groupWhSkuLocations(rows).map((l) => l.location.code)).toEqual([
      "02-04-3",
      "03-02-1",
      "IN-01",
      "PK-01",
      "SPARES-01",
      "MFG-LINE",
      "UNLOCATED",
    ]);
  });

  it("leaves out empty or negative balances and rows whose location or carton is not visible", () => {
    const a = loc("02-01-1");
    const hidden = row(a, 4, { container_id: "c-hidden", container: null });
    const out = groupWhSkuLocations([row(a, 0), row(a, -3), row(a, 2, { location: null }), hidden, row(a, 6)]);
    expect(out).toHaveLength(1);
    expect(out[0].units).toBe(6);
    expect(out[0].cartons).toEqual([]);
    expect(out[0].loose).toEqual([{ bucket: "raw", units: 6 }]);
  });

  it("returns nothing for no rows", () => {
    expect(groupWhSkuLocations([])).toEqual([]);
  });
});

describe("fetchWhSkuLocations", () => {
  it("reads the SKU's positive balances with location and carton embedded, then groups them", async () => {
    const calls: [string, ...unknown[]][] = [];
    const a = loc("02-01-1");
    const builder: Record<string, unknown> = {};
    for (const m of ["select", "eq", "gt", "limit"]) {
      builder[m] = (...args: unknown[]) => {
        calls.push([m, ...args]);
        return m === "limit" ? Promise.resolve({ data: [row(a, 12), inCarton(a, 24, carton("C-9"))], error: null }) : builder;
      };
    }
    const client = { from: vi.fn(() => builder) };
    const out = await fetchWhSkuLocations("sku-1", client);
    expect(client.from).toHaveBeenCalledWith("wh_inventory_balances");
    const select = calls.find((c) => c[0] === "select")?.[1] as string;
    expect(select).toContain("location:wh_locations(id, code, kind, zone, pickable, is_overflow, pick_sequence, active)");
    expect(select).toContain("container:wh_containers(id, code, state, qty, label_stock, created_at)");
    expect(calls).toContainEqual(["eq", "sku_id", "sku-1"]);
    expect(calls).toContainEqual(["gt", "on_hand", 0]);
    expect(out).toHaveLength(1);
    expect(out[0].units).toBe(36);
    expect(out[0].cartons.map((c) => c.code)).toEqual(["C-9"]);
  });

  it("rethrows the client's error", async () => {
    const boom = { message: "JWT expired", code: "PGRST301" };
    const builder: Record<string, unknown> = {};
    for (const m of ["select", "eq", "gt"]) builder[m] = () => builder;
    builder.limit = () => Promise.resolve({ data: null, error: boom });
    await expect(fetchWhSkuLocations("sku-1", { from: () => builder })).rejects.toBe(boom);
  });
});
