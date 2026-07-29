import { describe, it, expect } from "vitest";
import { buildPlannedAllocationMap, allocatedReserve } from "./allocation";
import type { FactoryOrderWithItems, ProductBomRow } from "@/lib/hooks/use-factory-orders";

// Minimal fixtures — only the fields the allocator reads.
let seq = 0;
const id = (p: string) => `${p}-${++seq}`;

function order(
  // Omit `items` from the Partial before re-adding it as Partial-of-item —
  // a plain intersection would still demand FULL item objects (and made the
  // `...it` spreads read as guaranteed overwrites), failing `tsc -b`.
  overrides: Omit<Partial<FactoryOrderWithItems>, "items"> & {
    items?: Array<Partial<FactoryOrderWithItems["items"][number]>>;
  },
): FactoryOrderWithItems {
  const oid = (overrides.id as string) ?? id("fo");
  return {
    id: oid,
    order_number: overrides.order_number ?? oid,
    status: overrides.status ?? "in_production",
    parent_factory_order_id: overrides.parent_factory_order_id ?? null,
    items: (overrides.items ?? []).map((it) => ({
      id: (it.id as string) ?? id("foi"),
      factory_order_id: oid,
      sku_id: it.sku_id ?? null,
      quantity_ordered: it.quantity_ordered ?? 0,
      quantity_consumed_by_parent: it.quantity_consumed_by_parent ?? 0,
      ...it,
    })),
  } as unknown as FactoryOrderWithItems;
}

const bom = (parent: string, component: string, per: number): ProductBomRow =>
  ({ id: id("bom"), parent_sku_id: parent, component_sku_id: component, units_per_parent: per,
     component_type: "produced", assembled_at_supplier_id: "sup-1" }) as ProductBomRow;

describe("buildPlannedAllocationMap", () => {
  it("allocates BOM × parent qty, leaving the child's remainder free", () => {
    // Owner's canonical example: 50 BW58B need 50 of the child's 100 HT-5.
    const parent = order({ id: "P", order_number: "AS-1", items: [{ sku_id: "BW58B", quantity_ordered: 50 }] });
    const child = order({ id: "C", parent_factory_order_id: "P", items: [{ id: "ht5-line", sku_id: "HT-5", quantity_ordered: 100 }] });
    const map = buildPlannedAllocationMap([parent, child], [bom("BW58B", "HT-5", 1)]);
    expect(map.get("ht5-line")).toMatchObject({ planned: 50, parentOrderNumber: "AS-1" });
  });

  it("caps at the child's ordered quantity when the parent needs more", () => {
    const parent = order({ id: "P", items: [{ sku_id: "BW58B", quantity_ordered: 100 }] });
    const child = order({ id: "C", parent_factory_order_id: "P", items: [{ id: "short", sku_id: "HT-5", quantity_ordered: 60 }] });
    const map = buildPlannedAllocationMap([parent, child], [bom("BW58B", "HT-5", 1)]);
    expect(map.get("short")?.planned).toBe(60);
  });

  it("sums need across multiple parent lines using the same component", () => {
    const parent = order({
      id: "P",
      items: [
        { sku_id: "BW58B", quantity_ordered: 100 },
        { sku_id: "BW61", quantity_ordered: 100 },
      ],
    });
    const child = order({ id: "C", parent_factory_order_id: "P", items: [{ id: "ht5", sku_id: "HT-5", quantity_ordered: 500 }] });
    const map = buildPlannedAllocationMap(
      [parent, child],
      [bom("BW58B", "HT-5", 1), bom("BW61", "HT-5", 2)],
    );
    expect(map.get("ht5")?.planned).toBe(300); // 100×1 + 100×2
  });

  it("ride-along SKUs with no BOM relation are absent (fully free)", () => {
    const parent = order({ id: "P", items: [{ sku_id: "BW58B", quantity_ordered: 100 }] });
    const child = order({
      id: "C", parent_factory_order_id: "P",
      items: [{ id: "ride", sku_id: "BW21P", quantity_ordered: 200 }],
    });
    const map = buildPlannedAllocationMap([parent, child], [bom("BW58B", "HT-5", 1)]);
    expect(map.has("ride")).toBe(false);
  });

  it("unlinked orders never allocate", () => {
    const solo = order({ id: "S", items: [{ id: "l", sku_id: "HT-5", quantity_ordered: 100 }] });
    const map = buildPlannedAllocationMap([solo], [bom("BW58B", "HT-5", 1)]);
    expect(map.size).toBe(0);
  });
});

describe("allocatedReserve", () => {
  const planned = new Map([["x", { planned: 50, parentOrderId: "P", parentOrderNumber: "AS-1" }]]);

  it("uses the plan before shipment realizes anything", () => {
    expect(allocatedReserve({ id: "x", quantity_consumed_by_parent: 0 }, planned)).toBe(50);
  });

  it("lets realized consumption win once it exceeds the plan", () => {
    expect(allocatedReserve({ id: "x", quantity_consumed_by_parent: 80 }, planned)).toBe(80);
  });

  it("falls back to consumed-only without a planned map", () => {
    expect(allocatedReserve({ id: "x", quantity_consumed_by_parent: 30 }, undefined)).toBe(30);
  });
});
