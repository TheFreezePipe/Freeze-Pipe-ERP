import { describe, it, expect } from "vitest";
import { buildInTransitMap, buildOnOrderMap } from "./inventory-aggregates";
import type { FreightLineItemWithProduct } from "./hooks/use-freight";
import type { FactoryOrderWithItems, FactoryOrderItemWithProduct } from "./hooks/use-factory-orders";
import type { FreightShipment, ProductSKU } from "@/types/database";

// ---- Fixture factories — keep tests terse -----------------------------------

let seq = 0;
const nextId = (prefix: string) => `${prefix}-${++seq}`;

function shipment(overrides: Partial<FreightShipment> = {}): FreightShipment {
  return {
    id: nextId("ship"),
    shipment_number: "FS-001",
    status: "on_the_water",
    freight_type: "sea",
    actual_arrival_date: null,
    broker_name: null,
    carrier_last_piece_event_at: null,
    carrier_name: null,
    carrier_pieces_delivered: null,
    carrier_pieces_on_vehicle: null,
    carrier_pieces_total: null,
    carrier_pieces_updated_at: null,
    china_customs_delay: false,
    closed_short_at: null,
    closed_short_reason: null,
    created_at: "2026-07-01T00:00:00Z",
    created_by_supplier_user_id: null,
    duties_cost: null,
    eta: null,
    eta_last_checked_at: null,
    eta_original: null,
    forwarder_code: null,
    freight_cost: null,
    idempotency_key: null,
    insurance_cost: null,
    notes: null,
    origin_supplier_id: null,
    receipt_confirmed_at: null,
    receipt_confirmed_by: null,
    row_version: 1,
    ship_date: null,
    status_overridden_at: null,
    status_overridden_by: null,
    total_cartons: null,
    total_cost: null,
    tracking_number: null,
    updated_at: "2026-07-01T00:00:00Z",
    ...overrides,
  };
}

function line(overrides: Partial<FreightLineItemWithProduct> = {}): FreightLineItemWithProduct {
  return {
    id: nextId("li"),
    freight_shipment_id: "ship-x",
    sku_id: "sku-1",
    quantity: 100,
    quantity_received: 0,
    quantity_prefilled: null,
    custom_description: null,
    retail_value: null,
    row_version: 1,
    source_factory_order_item_id: null,
    supplier_declared_quantity: null,
    unit_cost: null,
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-01T00:00:00Z",
    product: null,
    ...overrides,
  };
}

function orderItem(overrides: Partial<FactoryOrderItemWithProduct> = {}): FactoryOrderItemWithProduct {
  return {
    id: nextId("foi"),
    factory_order_id: "fo-x",
    sku_id: "sku-1",
    quantity_ordered: 500,
    quantity_breakage: 0,
    quantity_consumed_by_parent: 0,
    quantity_finished: null,
    quantity_shipped_manual: 0,
    alternate_expected_completion: null,
    consolidator_confirmed_at: null,
    consolidator_confirmed_by: null,
    consolidator_confirmed_quantity: null,
    unit_cost: null,
    row_version: 1,
    created_at: "2026-06-01T00:00:00Z",
    // Only referenced by UI joins, never by the aggregate math under test.
    product: { id: "sku-1" } as ProductSKU,
    ...overrides,
  };
}

function order(overrides: Partial<FactoryOrderWithItems> = {}): FactoryOrderWithItems {
  return {
    id: nextId("fo"),
    status: "in_production",
    supplier_id: "sup-1",
    supplier: null,
    parent_factory_order_id: null,
    items: [],
    canceled_at: null,
    canceled_by: null,
    canceled_reason: null,
    expected_completion: null,
    idempotency_key: null,
    notes: null,
    order_date: null,
    order_number: null,
    row_version: 1,
    ship_via_supplier_id: null,
    shipped_at: null,
    created_at: "2026-06-01T00:00:00Z",
    updated_at: "2026-06-01T00:00:00Z",
    ...overrides,
  };
}

// ---- buildInTransitMap -------------------------------------------------------
//
// Rule under test: in-transit per line = max(0, quantity - quantity_received),
// summed for EVERY shipment regardless of status. `quantity` = units that left
// the factory; `quantity_received` = units physically checked in.

describe("buildInTransitMap", () => {
  it("counts the full quantity for an untouched shipment (nothing received yet)", () => {
    const s = shipment({ status: "on_the_water" });
    const lines = [
      line({ freight_shipment_id: s.id, sku_id: "sku-1", quantity: 250, quantity_received: 0 }),
    ];
    const map = buildInTransitMap([s], lines);
    expect(map.get("sku-1")).toBe(250);
  });

  it("counts only the remainder for a partially received shipment", () => {
    const s = shipment({ status: "delivered" }); // carrier delivered, check-in underway
    const lines = [
      line({ freight_shipment_id: s.id, sku_id: "sku-1", quantity: 300, quantity_received: 120 }),
    ];
    const map = buildInTransitMap([s], lines);
    expect(map.get("sku-1")).toBe(180);
  });

  it("contributes 0 for a fully received + confirmed delivered shipment", () => {
    const s = shipment({
      status: "delivered",
      receipt_confirmed_at: "2026-07-10T00:00:00Z",
    });
    const lines = [
      line({ freight_shipment_id: s.id, sku_id: "sku-1", quantity: 400, quantity_received: 400 }),
    ];
    const map = buildInTransitMap([s], lines);
    // Fully received lines drop out entirely — no zero-entry either.
    expect(map.has("sku-1")).toBe(false);
  });

  it("keeps delivered-but-unconfirmed units in transit (the limbo fix)", () => {
    // Carrier flipped status to 'delivered' but nothing has been checked in
    // (receipt_confirmed_at null, quantity_received 0). The old status
    // whitelist dropped these units from transit even though they hadn't
    // reached warehouse_raw — they vanished from both buckets.
    const s = shipment({ status: "delivered", receipt_confirmed_at: null });
    const lines = [
      line({ freight_shipment_id: s.id, sku_id: "sku-1", quantity: 500, quantity_received: 0 }),
    ];
    const map = buildInTransitMap([s], lines);
    expect(map.get("sku-1")).toBe(500);
  });

  it("sums remainders per SKU across multiple shipments", () => {
    const a = shipment({ status: "on_the_water" });
    const b = shipment({ status: "delivered" });
    const lines = [
      line({ freight_shipment_id: a.id, sku_id: "sku-1", quantity: 100, quantity_received: 0 }),
      line({ freight_shipment_id: b.id, sku_id: "sku-1", quantity: 200, quantity_received: 150 }),
      line({ freight_shipment_id: b.id, sku_id: "sku-2", quantity: 80, quantity_received: 80 }),
    ];
    const map = buildInTransitMap([a, b], lines);
    expect(map.get("sku-1")).toBe(150); // 100 + (200 - 150)
    expect(map.has("sku-2")).toBe(false); // fully received
  });

  it("clamps over-receipt to 0 instead of going negative", () => {
    const s = shipment();
    const lines = [
      line({ freight_shipment_id: s.id, sku_id: "sku-1", quantity: 100, quantity_received: 130 }),
      line({ freight_shipment_id: s.id, sku_id: "sku-1", quantity: 50, quantity_received: 0 }),
    ];
    const map = buildInTransitMap([s], lines);
    // The over-received line contributes 0 (not -30) — it must not eat into
    // the other line's genuine remainder.
    expect(map.get("sku-1")).toBe(50);
  });

  it("ignores non-catalog (sample) lines with no SKU", () => {
    const s = shipment();
    const lines = [
      line({ freight_shipment_id: s.id, sku_id: null, quantity: 999, quantity_received: 0 }),
    ];
    const map = buildInTransitMap([s], lines);
    expect(map.size).toBe(0);
  });
});

// ---- buildOnOrderMap ---------------------------------------------------------
//
// Guard the partial-receiving invariant: On Order nets out the FULL shipped
// quantity, never quantity - quantity_received. Receiving progress must not
// move units back onto On Order (close-short mutates `quantity` itself).

describe("buildOnOrderMap (partial-receiving invariant)", () => {
  it("nets out the full shipped quantity regardless of quantity_received", () => {
    const item = orderItem({ sku_id: "sku-1", quantity_ordered: 500 });
    const fo = order({ status: "in_production", items: [item] });
    // 200 units shipped, only 40 physically received so far — On Order must
    // still be 500 - 200 = 300, NOT 500 - (200 - 40).
    const lines = [
      line({
        source_factory_order_item_id: item.id,
        sku_id: "sku-1",
        quantity: 200,
        quantity_received: 40,
      }),
    ];
    const map = buildOnOrderMap([fo], lines);
    expect(map.get("sku-1")).toBe(300);
  });
});
