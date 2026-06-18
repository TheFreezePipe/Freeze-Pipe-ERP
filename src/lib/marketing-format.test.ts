import { describe, it, expect } from "vitest";
import {
  describeOffer,
  dayKeyOf,
  shiftDayKey,
  daysBetweenKeys,
  isPastKey,
  type OfferLike,
} from "./marketing-format";

function offer(over: Partial<OfferLike> = {}): OfferLike {
  return {
    percent_off: null,
    dollar_off: null,
    free_item_sku_id: null,
    min_order_amount: null,
    buy_qty: null,
    get_qty: null,
    scope: "sitewide",
    category: null,
    code: null,
    ...over,
  };
}

describe("describeOffer", () => {
  it("percent off sitewide with a code", () => {
    const r = describeOffer(offer({ percent_off: 20, scope: "sitewide", code: "LOVE" }));
    expect(r.deal).toBe("20% off");
    expect(r.target).toBe("Sitewide");
    expect(r.code).toBe("LOVE");
  });

  it("dollar off a category", () => {
    const r = describeOffer(offer({ dollar_off: 15, scope: "category", category: "Bongs" }));
    expect(r.deal).toBe("$15 off");
    expect(r.target).toBe("Bongs");
  });

  it("free item over a threshold", () => {
    const r = describeOffer(
      offer({ free_item_sku_id: "x", min_order_amount: 75 }),
      "Grinder",
    );
    expect(r.deal).toBe("Free Grinder over $75");
  });

  it("combines percent + free item (the LOVE-style combo)", () => {
    const r = describeOffer(
      offer({ percent_off: 10, free_item_sku_id: "x", code: "HEART" }),
      "Sticker",
    );
    expect(r.deal).toBe("10% off + free Sticker");
    expect(r.code).toBe("HEART");
  });

  it("BOGO on a SKU set", () => {
    const r = describeOffer(offer({ buy_qty: 1, get_qty: 1, scope: "sku_set" }));
    expect(r.deal).toBe("Buy 1 get 1");
    expect(r.target).toBe("Select SKUs");
  });

  it("falls back to 'Offer' when nothing is set", () => {
    expect(describeOffer(offer()).deal).toBe("Offer");
  });
});

describe("day-key helpers", () => {
  it("dayKeyOf slices the date out of an ISO timestamp (no tz drift)", () => {
    expect(dayKeyOf("2026-02-10T00:00:00+00:00")).toBe("2026-02-10");
    expect(dayKeyOf("2026-02-10")).toBe("2026-02-10");
    expect(dayKeyOf(null)).toBeNull();
  });

  it("shiftDayKey moves whole days across month/year boundaries", () => {
    expect(shiftDayKey("2026-02-10", 5)).toBe("2026-02-15");
    expect(shiftDayKey("2026-02-27", 2)).toBe("2026-03-01");
    expect(shiftDayKey("2026-03-01", -1)).toBe("2026-02-28");
    expect(shiftDayKey("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("daysBetweenKeys is signed", () => {
    expect(daysBetweenKeys("2026-02-10", "2026-02-15")).toBe(5);
    expect(daysBetweenKeys("2026-02-15", "2026-02-10")).toBe(-5);
    expect(daysBetweenKeys("2026-02-10", "2026-02-10")).toBe(0);
  });

  it("isPastKey compares against today", () => {
    expect(isPastKey("2026-02-09", "2026-02-10")).toBe(true);
    expect(isPastKey("2026-02-10", "2026-02-10")).toBe(false);
    expect(isPastKey("2026-02-11", "2026-02-10")).toBe(false);
    expect(isPastKey(null, "2026-02-10")).toBe(false);
  });
});
