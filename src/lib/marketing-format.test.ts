import { describe, it, expect } from "vitest";
import {
  describeOffer,
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

describe("approval helpers", () => {
  it("normalizes unknown/null statuses to draft", () => {
    expect(normalizeApproval("confirmed")).toBe("confirmed");
    expect(normalizeApproval("proposed")).toBe("proposed");
    expect(normalizeApproval("draft")).toBe("draft");
    expect(normalizeApproval("whatever")).toBe("draft");
    expect(normalizeApproval(null)).toBe("draft");
    expect(normalizeApproval(undefined)).toBe("draft");
  });

  it("tooltips only for unconfirmed statuses", () => {
    expect(approvalTooltip("draft")).toBe("draft — not ops-confirmed");
    expect(approvalTooltip("proposed")).toBe("proposed — awaiting ops confirmation");
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
