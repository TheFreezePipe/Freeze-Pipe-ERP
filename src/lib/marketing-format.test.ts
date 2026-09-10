import { describe, it, expect } from "vitest";
import {
  describeOffer,
  inferOfferFormat,
  skuListText,
  SCOPE_LABEL,
  OFFER_FORMAT_LABEL,
  dayKeyOf,
  shiftDayKey,
  daysBetweenKeys,
  isPastKey,
  salePhase,
  launchPhase,
  retailHolidaysForYear,
  normalizeApproval,
  approvalTooltip,
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
    format: null,
    once_per_order: false,
    ...over,
  };
}

// The five offers in prod (2026-09-09), as their mechanic columns.
const PROD = {
  laborDay: offer({ percent_off: 15, scope: "sitewide" }),
  bf10: offer({ dollar_off: 10, scope: "sku_set" }),
  bf20: offer({ dollar_off: 20, scope: "sku_set" }),
  bf40: offer({ dollar_off: 40, scope: "sku_set" }),
  bfBottle: offer({ free_item_sku_id: "bottle", min_order_amount: 150, get_qty: 1, scope: "sitewide" }),
};

describe("describeOffer (v2 grammar)", () => {
  it("percent: sitewide / category / sku list, with the min-order suffix only when sitewide", () => {
    expect(describeOffer(PROD.laborDay).deal).toBe("15% off sitewide");
    expect(describeOffer(offer({ percent_off: 10, scope: "category", category: "Bubblers" })).deal).toBe(
      "10% off Bubblers",
    );
    expect(
      describeOffer(offer({ percent_off: 20, scope: "sku_set" }), {
        skuCodes: ["BW20", "NB4", "BW42", "A", "B", "C", "D", "E", "F", "G", "H", "I", "J"],
      }).deal,
    ).toBe("20% off BW20, NB4, BW42 +10");
    expect(describeOffer(offer({ percent_off: 15, scope: "sitewide", min_order_amount: 200 })).deal).toBe(
      "15% off sitewide on orders over $200",
    );
    // A targeted percent row never grows a min-order suffix (stored format;
    // by shape alone that row fits no format and takes the legacy branch).
    expect(
      describeOffer(
        offer({ format: "percent", percent_off: 15, scope: "category", category: "Bongs", min_order_amount: 200 }),
        {},
      ).deal,
    ).toBe("15% off Bongs");
  });

  it("dollar: sku list, once per order, sitewide min-order", () => {
    expect(describeOffer(PROD.bf40, { skuCodes: ["NB2", "NB6", "BW63", "X", "Y"] }).deal).toBe(
      "$40 off NB2, NB6, BW63 +2",
    );
    expect(
      describeOffer(offer({ dollar_off: 40, scope: "sku_set", once_per_order: true }), {
        skuCodes: ["NB2", "NB6"],
      }).deal,
    ).toBe("$40 off NB2, NB6, once per order");
    // once_per_order is meaningless sitewide and never renders there.
    expect(
      describeOffer(offer({ dollar_off: 25, scope: "sitewide", once_per_order: true, min_order_amount: 100 }))
        .deal,
    ).toBe("$25 off sitewide on orders over $100");
    expect(describeOffer(offer({ dollar_off: 12.5, scope: "category", category: "Grinders" })).deal).toBe(
      "$12.5 off Grinders",
    );
  });

  it("gift_min: free item over a threshold, qty prefix when > 1", () => {
    expect(describeOffer(PROD.bfBottle, "Cleaning Bottle").deal).toBe(
      "Free Cleaning Bottle on orders over $150",
    );
    expect(describeOffer({ ...PROD.bfBottle, get_qty: 2 }, { freeItemName: "Cleaning Bottle" }).deal).toBe(
      "2x Free Cleaning Bottle on orders over $150",
    );
  });

  it("gift_skus: free item with qualifying SKUs or a category", () => {
    const withSku = offer({ free_item_sku_id: "coil", get_qty: 1, buy_qty: 1, scope: "sku_set" });
    expect(describeOffer(withSku, { freeItemName: "DNA Coil", skuCodes: ["BW20DNA"] }).deal).toBe(
      "Free DNA Coil with BW20DNA",
    );
    const withCat = offer({ free_item_sku_id: "coil", get_qty: 1, buy_qty: 1, scope: "category", category: "Bongs" });
    expect(describeOffer(withCat, { freeItemName: "DNA Coil" }).deal).toBe("Free DNA Coil with Bongs");
    expect(describeOffer({ ...withSku, get_qty: 3 }, { freeItemName: "DNA Coil", skuCodes: ["BW20DNA"] }).deal).toBe(
      "3x Free DNA Coil with BW20DNA",
    );
  });

  it("gift_code: optional discount part + free item, code required", () => {
    const pct = offer({ code: "HOLIDAY", free_item_sku_id: "key", get_qty: 1, percent_off: 10, scope: "category", category: "Bongs" });
    const r = describeOffer(pct, { freeItemName: "Keychain Debowler" });
    expect(r.deal).toBe("10% off Bongs + Free Keychain Debowler");
    expect(r.how).toBe("Code HOLIDAY");
    expect(r.code).toBe("HOLIDAY");
    const dol = offer({ code: "GIFT", free_item_sku_id: "key", get_qty: 1, dollar_off: 5, scope: "sitewide" });
    expect(describeOffer(dol, "Keychain Debowler").deal).toBe("$5 off sitewide + Free Keychain Debowler");
    const none = offer({ code: "FREEBIE", free_item_sku_id: "key", get_qty: 2, scope: "sitewide" });
    expect(describeOffer(none, "Keychain Debowler").deal).toBe("2x Free Keychain Debowler");
  });

  it("bxgy: buy X of the set, get Y free", () => {
    expect(
      describeOffer(offer({ buy_qty: 2, get_qty: 1, scope: "sku_set" }), { skuCodes: ["BW20"] }).deal,
    ).toBe("Buy 2 of BW20, get 1 free");
    expect(
      describeOffer(offer({ buy_qty: 1, get_qty: 1, scope: "category", category: "Coils" })).deal,
    ).toBe("Buy 1 of Coils, get 1 free");
  });

  it("target uses SCOPE_LABEL; how is Code X or Automatic", () => {
    const auto = describeOffer(PROD.laborDay);
    expect(auto.target).toBe(SCOPE_LABEL.sitewide);
    expect(auto.how).toBe("Automatic");
    expect(auto.code).toBeNull();
    expect(describeOffer(PROD.bf10).target).toBe("Specific SKUs");
    expect(describeOffer(offer({ percent_off: 10, scope: "category", category: "Bongs" })).target).toBe("Category");
    const coded = describeOffer(offer({ percent_off: 20, code: "  LOVE " }));
    expect(coded.how).toBe("Code LOVE");
    expect(coded.code).toBe("LOVE");
  });

  it("honors a stored format over shape inference", () => {
    // Stored gift_code with a percent part reads as gift_code even though
    // the shape alone could look ambiguous.
    const r = describeOffer(
      offer({ format: "gift_code", code: "X", free_item_sku_id: "k", percent_off: 10, scope: "sitewide" }),
      "Keychain",
    );
    expect(r.deal).toBe("10% off sitewide + Free Keychain");
  });

  it("sku_set without codes falls back to a neutral phrase", () => {
    expect(describeOffer(PROD.bf10).deal).toBe("$10 off select SKUs");
  });

  it("unrecognized shapes fall back to the composable legacy sentence", () => {
    const trap = offer({ free_item_sku_id: "bottle", buy_qty: 1, min_order_amount: 150, scope: "sitewide" });
    expect(describeOffer(trap, "Cleaning Bottle").deal).toBe("Free Cleaning Bottle on orders over $150");
    expect(describeOffer(offer()).deal).toBe("Offer");
  });
});

describe("skuListText", () => {
  it("lists up to three codes then +N", () => {
    expect(skuListText(["A"])).toBe("A");
    expect(skuListText(["A", "B", "C"])).toBe("A, B, C");
    expect(skuListText(["A", "B", "C", "D"])).toBe("A, B, C +1");
    expect(skuListText([])).toBe("select SKUs");
    expect(skuListText(undefined, "SKUs")).toBe("SKUs");
  });
});

describe("inferOfferFormat (strict shapes)", () => {
  it("recovers the five prod shapes", () => {
    expect(inferOfferFormat(PROD.laborDay)).toBe("percent");
    expect(inferOfferFormat(PROD.bf10)).toBe("dollar");
    expect(inferOfferFormat(PROD.bf20)).toBe("dollar");
    expect(inferOfferFormat(PROD.bf40)).toBe("dollar");
    expect(inferOfferFormat(PROD.bfBottle)).toBe("gift_min");
    // gift_min tolerates a null get_qty (defaults to 1).
    expect(inferOfferFormat({ ...PROD.bfBottle, get_qty: null })).toBe("gift_min");
  });

  it("recovers the other formats", () => {
    expect(inferOfferFormat(offer({ free_item_sku_id: "c", buy_qty: 1, get_qty: 1, scope: "sku_set" }))).toBe(
      "gift_skus",
    );
    expect(inferOfferFormat(offer({ code: "X", free_item_sku_id: "k", get_qty: 1, scope: "sitewide" }))).toBe(
      "gift_code",
    );
    expect(
      inferOfferFormat(offer({ code: "X", free_item_sku_id: "k", percent_off: 10, scope: "category", category: "B" })),
    ).toBe("gift_code");
    expect(inferOfferFormat(offer({ buy_qty: 2, get_qty: 1, scope: "sku_set" }))).toBe("bxgy");
    expect(inferOfferFormat(offer({ dollar_off: 10, scope: "sitewide", min_order_amount: 50 }))).toBe("dollar");
  });

  it("returns null for shapes that fit no single format", () => {
    // The legacy trap: sitewide gift with both a qualifier count and a threshold.
    expect(
      inferOfferFormat(offer({ free_item_sku_id: "bottle", buy_qty: 1, min_order_amount: 150, scope: "sitewide" })),
    ).toBeNull();
    // Targeted min-order is not a percent offer.
    expect(inferOfferFormat(offer({ percent_off: 10, scope: "sku_set", min_order_amount: 50 }))).toBeNull();
    // Percent + dollar together is nothing.
    expect(inferOfferFormat(offer({ percent_off: 10, dollar_off: 5 }))).toBeNull();
    // Gift with both discount parts is not gift_code.
    expect(
      inferOfferFormat(offer({ code: "X", free_item_sku_id: "k", percent_off: 10, dollar_off: 5 })),
    ).toBeNull();
    // Gift without code, threshold, or qualifier is nothing.
    expect(inferOfferFormat(offer({ free_item_sku_id: "k" }))).toBeNull();
    // bxgy sitewide is not allowed.
    expect(inferOfferFormat(offer({ buy_qty: 1, get_qty: 1, scope: "sitewide" }))).toBeNull();
    expect(inferOfferFormat(offer())).toBeNull();
  });

  it("label maps cover every key", () => {
    expect(Object.keys(OFFER_FORMAT_LABEL)).toHaveLength(6);
    expect(Object.keys(SCOPE_LABEL)).toEqual(["sitewide", "category", "sku_set"]);
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

describe("salePhase (derived from dates)", () => {
  const today = "2026-02-10";
  it("upcoming when start is in the future", () => {
    expect(salePhase("2026-02-12", "2026-02-14", today)).toBe("upcoming");
  });
  it("live when today is within the range (inclusive)", () => {
    expect(salePhase("2026-02-08", "2026-02-12", today)).toBe("live");
    expect(salePhase("2026-02-10", "2026-02-10", today)).toBe("live");
  });
  it("ended when the end date has passed", () => {
    expect(salePhase("2026-02-01", "2026-02-09", today)).toBe("ended");
  });
  it("treats a missing end as a single-day sale", () => {
    expect(salePhase("2026-02-10", null, today)).toBe("live");
    expect(salePhase("2026-02-09", null, today)).toBe("ended");
  });
  it("returns null when no start date is set", () => {
    expect(salePhase(null, null, today)).toBeNull();
  });
});

describe("retailHolidaysForYear (pure UTC date math)", () => {
  function holiday(year: number, label: string): string | undefined {
    return retailHolidaysForYear(year).find((h) => h.label === label)?.dayKey;
  }

  it("computes the floating 2026 anchors", () => {
    expect(holiday(2026, "Memorial Day")).toBe("2026-05-25"); // last Mon of May
    expect(holiday(2026, "Father's Day")).toBe("2026-06-21"); // 3rd Sun of Jun
    expect(holiday(2026, "Labor Day")).toBe("2026-09-07"); // 1st Mon of Sep
    expect(holiday(2026, "Thanksgiving")).toBe("2026-11-26"); // 4th Thu of Nov
    expect(holiday(2026, "Black Friday")).toBe("2026-11-27");
    expect(holiday(2026, "Cyber Monday")).toBe("2026-11-30");
  });

  it("computes the floating 2027 anchors (rules, not lookups)", () => {
    expect(holiday(2027, "Memorial Day")).toBe("2027-05-31");
    expect(holiday(2027, "Father's Day")).toBe("2027-06-20");
    expect(holiday(2027, "Labor Day")).toBe("2027-09-06");
    expect(holiday(2027, "Thanksgiving")).toBe("2027-11-25");
    expect(holiday(2027, "Black Friday")).toBe("2027-11-26");
    expect(holiday(2027, "Cyber Monday")).toBe("2027-11-29");
  });

  it("handles a late Thanksgiving pushing Cyber Monday into December", () => {
    // 2019: Thanksgiving Nov 28 (latest possible) → Cyber Monday Dec 2.
    expect(holiday(2019, "Thanksgiving")).toBe("2019-11-28");
    expect(holiday(2019, "Black Friday")).toBe("2019-11-29");
    expect(holiday(2019, "Cyber Monday")).toBe("2019-12-02");
  });

  it("includes the fixed dates with the expected labels", () => {
    const keys = new Map(retailHolidaysForYear(2026).map((h) => [h.label, h.dayKey]));
    expect(keys.get("Valentine's Day")).toBe("2026-02-14");
    expect(keys.get("4/20")).toBe("2026-04-20");
    expect(keys.get("Independence Day")).toBe("2026-07-04");
    expect(keys.get("Prime Day (approx.)")).toBe("2026-07-11");
    expect(keys.get("Halloween")).toBe("2026-10-31");
    expect(keys.get("Christmas")).toBe("2026-12-25");
  });

  it("returns 12 holidays in chronological order", () => {
    const hs = retailHolidaysForYear(2026);
    expect(hs).toHaveLength(12);
    const sorted = [...hs.map((h) => h.dayKey)].sort();
    expect(hs.map((h) => h.dayKey)).toEqual(sorted);
  });
});

describe("approval helpers (binary: confirmed or not)", () => {
  it("normalizes everything but confirmed to draft — legacy proposed included", () => {
    expect(normalizeApproval("confirmed")).toBe("confirmed");
    expect(normalizeApproval("proposed")).toBe("draft");
    expect(normalizeApproval("draft")).toBe("draft");
    expect(normalizeApproval("whatever")).toBe("draft");
    expect(normalizeApproval(null)).toBe("draft");
    expect(normalizeApproval(undefined)).toBe("draft");
  });

  it("tooltip only when unconfirmed", () => {
    expect(approvalTooltip("draft")).toBe("not confirmed yet");
    expect(approvalTooltip("proposed")).toBe("not confirmed yet");
    expect(approvalTooltip("confirmed")).toBeNull();
  });
});

describe("launchPhase (date + inventory)", () => {
  const today = "2026-02-10";
  it("upcoming when launch date is in the future (ignores sold-out)", () => {
    expect(launchPhase("2026-02-12", today, false)).toBe("upcoming");
    expect(launchPhase("2026-02-12", today, true)).toBe("upcoming");
  });
  it("launched once the date arrives and stock remains", () => {
    expect(launchPhase("2026-02-10", today, false)).toBe("launched");
    expect(launchPhase("2026-02-01", today, false)).toBe("launched");
  });
  it("sold out when launched and no stock on hand", () => {
    expect(launchPhase("2026-02-01", today, true)).toBe("sold_out");
  });
  it("returns null when no launch date is set", () => {
    expect(launchPhase(null, today, false)).toBeNull();
  });
});

describe("early access phases", () => {
  it("sale enters early_access between EA and public start", () => {
    expect(salePhase("2026-09-01", "2026-09-07", "2026-08-29", "2026-08-30")).toBe("upcoming");
    expect(salePhase("2026-09-01", "2026-09-07", "2026-08-30", "2026-08-30")).toBe("early_access");
    expect(salePhase("2026-09-01", "2026-09-07", "2026-09-01", "2026-08-30")).toBe("live");
    expect(salePhase("2026-09-01", "2026-09-07", "2026-09-08", "2026-08-30")).toBe("ended");
    // no EA date → unchanged behavior
    expect(salePhase("2026-09-01", "2026-09-07", "2026-08-30")).toBe("upcoming");
  });

  it("launch enters early_access between EA and launch day", () => {
    expect(launchPhase("2026-09-05", "2026-09-02", false, "2026-09-03")).toBe("upcoming");
    expect(launchPhase("2026-09-05", "2026-09-03", false, "2026-09-03")).toBe("early_access");
    expect(launchPhase("2026-09-05", "2026-09-05", false, "2026-09-03")).toBe("launched");
    expect(launchPhase("2026-09-05", "2026-09-06", true, "2026-09-03")).toBe("sold_out");
  });
});
