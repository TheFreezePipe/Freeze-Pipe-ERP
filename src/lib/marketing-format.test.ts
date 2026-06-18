import { describe, it, expect } from "vitest";
import { describeOffer, type OfferLike } from "./marketing-format";

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
