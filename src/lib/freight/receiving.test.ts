import { describe, it, expect } from "vitest";
import { isReceivingActive } from "./receiving";
import type { FreightShipment } from "@/types/database";
import type { FreightLineItemWithProduct } from "@/lib/hooks";

const TODAY = "2026-09-14";

function shipment(overrides: Partial<FreightShipment> = {}): FreightShipment {
  return {
    id: "f1",
    shipment_number: "466",
    freight_type: "sea",
    status: "on_the_water",
    carrier_name: "UPS",
    broker_name: null,
    forwarder_code: null,
    tracking_number: "1Z16G70V0333597433",
    ship_date: "2026-08-14",
    eta: "2026-09-20",
    eta_original: "2026-09-20",
    eta_last_checked_at: null,
    actual_arrival_date: null,
    status_overridden_at: null,
    total_cartons: 16,
    freight_cost: 1722,
    insurance_cost: 0,
    duties_cost: 0,
    total_cost: 1722,
    notes: null,
    receipt_confirmed_at: null,
    carrier_pieces_total: null,
    carrier_pieces_delivered: null,
    carrier_pieces_on_vehicle: null,
    created_at: "",
    updated_at: "",
    ...overrides,
  } as FreightShipment;
}

function line(overrides: Partial<FreightLineItemWithProduct> = {}): FreightLineItemWithProduct {
  return { id: "l1", sku_id: "s1", quantity: 50, quantity_received: 0, ...overrides } as FreightLineItemWithProduct;
}

describe("isReceivingActive", () => {
  it("never active once the receipt is confirmed", () => {
    expect(isReceivingActive(shipment({ status: "delivered", receipt_confirmed_at: "2026-09-10T00:00:00Z" }), [line()], TODAY)).toBe(false);
  });

  it("never active while pending (nothing has shipped)", () => {
    expect(isReceivingActive(shipment({ status: "pending", eta: "2026-09-01" }), [line()], TODAY)).toBe(false);
  });

  it("not active on the water ahead of the ETA with no carrier or dock signal", () => {
    expect(isReceivingActive(shipment({ status: "on_the_water", eta: "2026-09-20" }), [line()], TODAY)).toBe(false);
    expect(isReceivingActive(shipment({ status: "high_risk", eta: "2026-09-20" }), [line()], TODAY)).toBe(false);
  });

  it("sea 466 shape: tracking status, ETA today, piece counts nulled by the trust guard -> active", () => {
    const s466 = shipment({ status: "tracking", eta: "2026-09-14", carrier_pieces_delivered: null, carrier_pieces_total: null });
    expect(isReceivingActive(s466, [line()], TODAY)).toBe(true);
  });

  it("active once the shipment is past the water, even before the ETA", () => {
    for (const status of ["cleared_customs", "tracking", "out_for_delivery", "delivered"]) {
      expect(isReceivingActive(shipment({ status, eta: "2026-09-25" }), [line()], TODAY)).toBe(true);
    }
  });

  it("active once the ETA has arrived, whatever the feed says", () => {
    expect(isReceivingActive(shipment({ status: "on_the_water", eta: "2026-09-14" }), [line()], TODAY)).toBe(true);
    expect(isReceivingActive(shipment({ status: "on_the_water", eta: "2026-09-01" }), [line()], TODAY)).toBe(true);
    expect(isReceivingActive(shipment({ status: "high_risk", eta: "2026-09-13T00:00:00+00:00" }), [line()], TODAY)).toBe(true);
    expect(isReceivingActive(shipment({ status: "on_the_water", eta: null }), [line()], TODAY)).toBe(false);
  });

  it("active when the carrier reports delivered pieces", () => {
    expect(isReceivingActive(shipment({ status: "on_the_water", carrier_pieces_delivered: 3, carrier_pieces_total: 16 }), [line()], TODAY)).toBe(true);
  });

  it("active when any catalog line already has a check-in (straggler)", () => {
    expect(isReceivingActive(shipment({ status: "on_the_water" }), [line({ quantity_received: 4 })], TODAY)).toBe(true);
    expect(isReceivingActive(shipment({ status: "on_the_water" }), [line({ sku_id: null, quantity_received: 4 })], TODAY)).toBe(false);
  });
});
