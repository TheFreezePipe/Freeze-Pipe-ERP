import { describe, it, expect } from "vitest";
import { buildRetailValueBreakdown } from "./retail-value";
import type { InventoryWithProduct } from "./hooks/use-inventory";
import type { FactoryOrderWithItems } from "./hooks/use-factory-orders";
import type { FreightLineItemWithProduct } from "./hooks/use-freight";
import type { FreightShipment, ProductSKU, SKUEconomics } from "@/types/database";

// ---- fixture factories (terse, cast to the live shapes) ----
function product(over: Partial<ProductSKU> = {}): ProductSKU {
  return {
    id: "s1",
    sku: "S1",
    product_name: "Widget",
    category: "non_fillable",
    display_category: "Widgets",
    retail_price: 100,
    monthly_demand: 30,
    is_active: true,
    upc_code: null,
    standard_quantity_per_carton: 1,
    abc_classification: "A",
    created_at: "2026-01-01",
    updated_at: "2026-01-01",
    ...over,
  } as ProductSKU;
}

function inv(over: Partial<InventoryWithProduct> = {}): InventoryWithProduct {
  return {
    id: "il1",
    sku_id: "s1",
    warehouse_raw: 0,
    warehouse_prefilled_raw: 0,
    warehouse_in_production: 0,
    warehouse_finished: 0,
    warehouse_other: 0,
    last_synced_at: "2026-01-01",
    updated_at: "2026-01-01",
    product: product(),
    ...over,
  } as InventoryWithProduct;
}

function shipment(over: Partial<FreightShipment> = {}): FreightShipment {
  return { id: "sh1", status: "on_the_water", ...over } as FreightShipment;
}

function line(over: Partial<FreightLineItemWithProduct> = {}): FreightLineItemWithProduct {
  return {
    id: "fl1",
    freight_shipment_id: "sh1",
    sku_id: "s1",
    quantity: 0,
    source_factory_order_item_id: null,
    product: product(),
    ...over,
  } as FreightLineItemWithProduct;
}

function order(items: unknown[], over: Record<string, unknown> = {}): FactoryOrderWithItems {
  return { id: "o1", status: "ordered", items, ...over } as unknown as FactoryOrderWithItems;
}

function econ(over: Partial<SKUEconomics> = {}): SKUEconomics {
  return {
    sku_id: "s1",
    additional_raw_cost: 0,
    pct_sea: 100,
    pct_air: 0,
    sea_freight_cost_per_unit: 5,
    air_freight_cost_per_unit: 0,
    breakage_issue_cost: 0,
    manufacturing_cost_cn: 0,
    labor_cost_us: 0,
    glycerin_cost_us: 0,
    mfg_override_active: false,
    mfg_override_pct_prefilled: null,
    packing_material_cost: 0,
    packing_labor_cost: 0,
    shipping_cost: 0,
    credit_card_fees: 0,
    ...over,
  } as SKUEconomics;
}

describe("buildRetailValueBreakdown", () => {
  it("values each stage at retail and rolls per-stage cash", () => {
    const inventory = [inv({ warehouse_finished: 10 })];
    const shipments = [shipment()];
    const freight = [line({ quantity: 5 })]; // in transit
    const orders = [
      order([
        {
          id: "foi1",
          sku_id: "s1",
          quantity_ordered: 8,
          quantity_breakage: 0,
          quantity_shipped_manual: 0,
          quantity_consumed_by_parent: 0,
        },
      ]),
    ];
    const economics = new Map([["s1", econ()]]);
    const primary = new Map([["s1", { unit_cost: 20 }]]);

    const b = buildRetailValueBreakdown(inventory, shipments, freight, orders, economics, primary);

    // Retail: 10×100 wh, 5×100 transit, 8×100 on order
    expect(b.warehouse).toBe(1000);
    expect(b.transit).toBe(500);
    expect(b.onOrder).toBe(800);
    expect(b.total).toBe(2300);

    // Cash: rawCost=20, importCost=5, base=25 (non_fillable → no mfg)
    // on order = 8×20=160; transit = 5×25=125; warehouse = 10×25=250
    expect(b.cashOnOrder).toBe(160);
    expect(b.cashTransit).toBe(125);
    expect(b.cashWarehouse).toBe(250);
    expect(b.totalCash).toBe(535);

    expect(b.skusMissingCost).toBe(0);
    expect(b.rows).toHaveLength(1);
    expect(b.rows[0].totalRetail).toBe(2300);
    expect(b.rows[0].totalCash).toBe(535);
    expect(b.rows[0].hasCost).toBe(true);
  });

  it("counts SKUs with inventory but no economics row, contributing zero cash", () => {
    const inventory = [inv({ warehouse_finished: 4 })];
    const b = buildRetailValueBreakdown(inventory, [], [], [], new Map(), new Map());
    expect(b.warehouse).toBe(400); // retail still counts
    expect(b.totalCash).toBe(0); // no cost data
    expect(b.skusMissingCost).toBe(1);
    expect(b.rows[0].hasCost).toBe(false);
  });

  it("skips SKUs with no/zero retail price entirely", () => {
    const inventory = [inv({ warehouse_finished: 10, product: product({ retail_price: 0 }) })];
    const b = buildRetailValueBreakdown(inventory, [], [], [], new Map(), new Map());
    expect(b.total).toBe(0);
    expect(b.rows).toHaveLength(0);
    expect(b.skusMissingCost).toBe(0);
  });
});
