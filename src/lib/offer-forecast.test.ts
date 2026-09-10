import { describe, it, expect } from "vitest";
import {
  FORMAT_SCOPES,
  EMPTY_OFFER_DRAFT,
  defaultScopeFor,
  validateOffer,
  validateOfferMechanics,
  buildOfferColumns,
  draftFromOffer,
  buildForecastColumns,
  validateForecastEdits,
  forecastView,
  giftUnits,
  isGiftFormat,
  type OfferDraft,
  type OfferRowLike,
  type OfferForecastDefaults,
} from "./offer-forecast";

function row(over: Partial<OfferRowLike> = {}): OfferRowLike {
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
    label: "x",
    offer_skus: [],
    ...over,
  };
}

const MECHANIC_KEYS = [
  "percent_off",
  "dollar_off",
  "free_item_sku_id",
  "min_order_amount",
  "buy_qty",
  "get_qty",
  "scope",
  "category",
  "code",
] as const;

function mechanics(r: Record<string, unknown>) {
  return Object.fromEntries(MECHANIC_KEYS.map((k) => [k, r[k] ?? null]));
}

// The five prod rows (2026-09-09). None carries `format` yet; the gift row
// stores get_qty 1 (the backfill default).
const PROD: Record<string, OfferRowLike> = {
  laborDay: row({ label: "15% off sitewide", percent_off: 15, scope: "sitewide" }),
  bf10: row({ label: "$10 off", dollar_off: 10, scope: "sku_set", offer_skus: [{ sku_id: "a" }] }),
  bf20: row({ label: "$20 off", dollar_off: 20, scope: "sku_set", offer_skus: [{ sku_id: "b" }, { sku_id: "c" }] }),
  bf40: row({ label: "$40 off", dollar_off: 40, scope: "sku_set", offer_skus: [{ sku_id: "d" }] }),
  bfBottle: row({
    label: "Free Cleaning Bottle Over $150",
    free_item_sku_id: "bottle",
    min_order_amount: 150,
    get_qty: 1,
    scope: "sitewide",
  }),
};

function draft(over: Partial<OfferDraft>): OfferDraft {
  return { ...EMPTY_OFFER_DRAFT, label: "L", ...over };
}

describe("round-trips the five prod rows", () => {
  it.each(Object.entries(PROD))("%s", (_name, r) => {
    const d = draftFromOffer(r);
    expect(d.format).not.toBeNull();
    expect(validateOffer(d).ok).toBe(true);
    const cols = buildOfferColumns(d);
    expect(mechanics(cols as unknown as Record<string, unknown>)).toEqual(mechanics(r as unknown as Record<string, unknown>));
    expect(cols.format).toBe(d.format);
    expect(cols.once_per_order).toBe(false);
  });

  it("hydrates the sku set from offer_skus or the explicit list", () => {
    expect(draftFromOffer(PROD.bf20).skuIds).toEqual(["b", "c"]);
    expect(draftFromOffer(PROD.bf20, ["z"]).skuIds).toEqual(["z"]);
  });

  it("legacy trap row hydrates with a null format", () => {
    const trap = row({ free_item_sku_id: "bottle", buy_qty: 1, min_order_amount: 150, scope: "sitewide" });
    const d = draftFromOffer(trap);
    expect(d.format).toBeNull();
    expect(validateOffer(d)).toEqual({ ok: false, missing: ["format"] });
  });

  it("honors a stored format and hydrates the gift_code discount kind", () => {
    const d = draftFromOffer(
      row({ format: "gift_code", code: "X", free_item_sku_id: "k", get_qty: 2, dollar_off: 5, scope: "category", category: "Bongs" }),
    );
    expect(d.format).toBe("gift_code");
    expect(d.discountKind).toBe("dollar");
    expect(d.getQty).toBe("2");
    expect(d.category).toBe("Bongs");
    expect(buildOfferColumns(d)).toMatchObject({
      format: "gift_code",
      scope: "category",
      category: "Bongs",
      code: "X",
      dollar_off: 5,
      percent_off: null,
      free_item_sku_id: "k",
      get_qty: 2,
      buy_qty: null,
      min_order_amount: null,
    });
  });
});

describe("format switch scope defaulting", () => {
  it("each format lists its allowed scopes in default order", () => {
    expect(FORMAT_SCOPES.percent).toEqual(["sitewide", "category", "sku_set"]);
    expect(FORMAT_SCOPES.dollar).toEqual(["sku_set", "category", "sitewide"]);
    expect(FORMAT_SCOPES.gift_min).toEqual(["sitewide"]);
    expect(FORMAT_SCOPES.gift_skus).toEqual(["sku_set", "category"]);
    expect(FORMAT_SCOPES.gift_code).toEqual(["sitewide", "category", "sku_set"]);
    expect(FORMAT_SCOPES.bxgy).toEqual(["sku_set", "category"]);
  });

  it("keeps the current scope when the new format allows it, else takes the default", () => {
    expect(defaultScopeFor("dollar", "category")).toBe("category");
    expect(defaultScopeFor("dollar", null)).toBe("sku_set");
    expect(defaultScopeFor("gift_min", "sku_set")).toBe("sitewide");
    expect(defaultScopeFor("bxgy", "sitewide")).toBe("sku_set");
    expect(defaultScopeFor("gift_skus", "sitewide")).toBe("sku_set");
  });

  it("buildOfferColumns coerces a disallowed scope to the format default", () => {
    const cols = buildOfferColumns(draft({ format: "gift_min", scope: "sku_set", skuIds: ["a"], freeItemSkuId: "g", minOrder: "150" }));
    expect(cols.scope).toBe("sitewide");
    expect(cols.category).toBeNull();
  });
});

describe("validateOffer", () => {
  it("percent: 1-100, scope members, sitewide-only min order", () => {
    expect(validateOffer(draft({ format: "percent", percentOff: "15" })).ok).toBe(true);
    expect(validateOffer(draft({ format: "percent", percentOff: "0" })).missing).toContain("percentOff");
    expect(validateOffer(draft({ format: "percent", percentOff: "101" })).missing).toContain("percentOff");
    expect(validateOffer(draft({ format: "percent", percentOff: "" })).missing).toContain("percentOff");
    expect(validateOffer(draft({ format: "percent", percentOff: "10", scope: "category" })).missing).toContain("category");
    expect(validateOffer(draft({ format: "percent", percentOff: "10", scope: "sku_set" })).missing).toContain("skuIds");
    expect(validateOffer(draft({ format: "percent", percentOff: "10", scope: "sku_set", skuIds: ["a"] })).ok).toBe(true);
    expect(validateOffer(draft({ format: "percent", percentOff: "10", minOrder: "-5" })).missing).toContain("minOrder");
    expect(validateOffer(draft({ format: "percent", percentOff: "10", minOrder: "200" })).ok).toBe(true);
  });

  it("dollar: > 0", () => {
    expect(validateOffer(draft({ format: "dollar", dollarOff: "10", scope: "sku_set", skuIds: ["a"] })).ok).toBe(true);
    expect(validateOffer(draft({ format: "dollar", dollarOff: "0", scope: "sku_set", skuIds: ["a"] })).missing).toContain("dollarOff");
    expect(validateOffer(draft({ format: "dollar", dollarOff: "abc", scope: "sitewide" })).missing).toContain("dollarOff");
  });

  it("gift_min: free item, min order > 0, qty >= 1 integer", () => {
    const good = draft({ format: "gift_min", freeItemSkuId: "g", minOrder: "150", getQty: "1" });
    expect(validateOffer(good).ok).toBe(true);
    expect(validateOffer({ ...good, freeItemSkuId: null }).missing).toEqual(["freeItemSkuId"]);
    expect(validateOffer({ ...good, minOrder: "" }).missing).toEqual(["minOrder"]);
    expect(validateOffer({ ...good, getQty: "0" }).missing).toEqual(["getQty"]);
    expect(validateOffer({ ...good, getQty: "1.5" }).missing).toEqual(["getQty"]);
  });

  it("gift_skus: free item + targeted scope members", () => {
    expect(validateOffer(draft({ format: "gift_skus", freeItemSkuId: "g", scope: "sku_set", skuIds: ["a"] })).ok).toBe(true);
    expect(validateOffer(draft({ format: "gift_skus", freeItemSkuId: "g", scope: "sku_set" })).missing).toEqual(["skuIds"]);
    expect(validateOffer(draft({ format: "gift_skus", freeItemSkuId: "g", scope: "sitewide" })).missing).toEqual(["scope"]);
  });

  it("gift_code: code required; the chosen discount part must be valid", () => {
    const base = draft({ format: "gift_code", freeItemSkuId: "g", code: "HOLIDAY" });
    expect(validateOffer(base).ok).toBe(true);
    expect(validateOffer({ ...base, code: "  " }).missing).toEqual(["code"]);
    expect(validateOffer({ ...base, discountKind: "percent" }).missing).toEqual(["percentOff"]);
    expect(validateOffer({ ...base, discountKind: "percent", percentOff: "10" }).ok).toBe(true);
    expect(validateOffer({ ...base, discountKind: "dollar", dollarOff: "5", scope: "category" }).missing).toEqual(["category"]);
    expect(validateOffer({ ...base, discountKind: "dollar", dollarOff: "5", scope: "category", category: "Bongs" }).ok).toBe(true);
  });

  it("bxgy: integer quantities >= 1 and a targeted scope", () => {
    expect(validateOffer(draft({ format: "bxgy", buyQty: "2", getQty: "1", scope: "sku_set", skuIds: ["a"] })).ok).toBe(true);
    expect(validateOffer(draft({ format: "bxgy", buyQty: "0", getQty: "1", scope: "sku_set", skuIds: ["a"] })).missing).toEqual(["buyQty"]);
    expect(validateOffer(draft({ format: "bxgy", buyQty: "2", getQty: "", scope: "sku_set", skuIds: ["a"] })).missing).toEqual(["getQty"]);
  });

  it("label is required; format is required first", () => {
    expect(validateOffer(draft({ format: "percent", percentOff: "10", label: "" })).missing).toEqual(["label"]);
    expect(validateOffer(draft({ format: null })).missing).toEqual(["format"]);
  });

  it("mechanics-only validation ignores code and label, infers the gift_code part", () => {
    expect(validateOfferMechanics(draft({ format: "gift_code", freeItemSkuId: "g", label: "", code: "" })).ok).toBe(true);
    expect(validateOfferMechanics(draft({ format: "gift_code", freeItemSkuId: "g", percentOff: "200" })).missing).toEqual(["percentOff"]);
    expect(validateOfferMechanics(draft({ format: "gift_code", freeItemSkuId: "g", percentOff: "10", dollarOff: "5" })).ok).toBe(false);
  });
});

describe("buildOfferColumns nulls every column the format does not own", () => {
  it("percent drops stale dollar/gift/qty values", () => {
    const cols = buildOfferColumns(
      draft({ format: "percent", percentOff: "15", dollarOff: "10", freeItemSkuId: "g", buyQty: "2", getQty: "3", minOrder: "50", scope: "category", category: "Bongs", oncePerOrder: true }),
    );
    expect(cols).toEqual({
      format: "percent",
      scope: "category",
      category: "Bongs",
      code: null,
      percent_off: 15,
      dollar_off: null,
      free_item_sku_id: null,
      min_order_amount: null,
      buy_qty: null,
      get_qty: null,
      once_per_order: false,
    });
  });

  it("dollar keeps once_per_order only when targeted; min order only sitewide", () => {
    const targeted = buildOfferColumns(draft({ format: "dollar", dollarOff: "40", scope: "sku_set", skuIds: ["a"], oncePerOrder: true, minOrder: "100" }));
    expect(targeted.once_per_order).toBe(true);
    expect(targeted.min_order_amount).toBeNull();
    const sitewide = buildOfferColumns(draft({ format: "dollar", dollarOff: "40", scope: "sitewide", oncePerOrder: true, minOrder: "100" }));
    expect(sitewide.once_per_order).toBe(false);
    expect(sitewide.min_order_amount).toBe(100);
  });

  it("gift_skus writes buy_qty 1; gift formats default get_qty to 1", () => {
    const cols = buildOfferColumns(draft({ format: "gift_skus", freeItemSkuId: "g", scope: "sku_set", skuIds: ["a"], getQty: "" }));
    expect(cols.buy_qty).toBe(1);
    expect(cols.get_qty).toBe(1);
    expect(cols.min_order_amount).toBeNull();
  });

  it("gift_code without a discount part is sitewide with no percent/dollar", () => {
    const cols = buildOfferColumns(draft({ format: "gift_code", code: "X", freeItemSkuId: "g", scope: "category", category: "Bongs", percentOff: "10", discountKind: "none" }));
    expect(cols.scope).toBe("sitewide");
    expect(cols.category).toBeNull();
    expect(cols.percent_off).toBeNull();
    expect(cols.dollar_off).toBeNull();
    expect(cols.code).toBe("X");
  });

  it("bxgy writes both quantities and nothing else", () => {
    const cols = buildOfferColumns(draft({ format: "bxgy", buyQty: "2", getQty: "1", scope: "sku_set", skuIds: ["a"], freeItemSkuId: "g", percentOff: "5" }));
    expect(cols).toMatchObject({ buy_qty: 2, get_qty: 1, free_item_sku_id: null, percent_off: null, dollar_off: null, min_order_amount: null });
  });

  it("code is trimmed and blank becomes null on every format", () => {
    expect(buildOfferColumns(draft({ format: "percent", percentOff: "10", code: "  SAVE " })).code).toBe("SAVE");
    expect(buildOfferColumns(draft({ format: "percent", percentOff: "10", code: "   " })).code).toBeNull();
  });
});

const DEFAULTS: OfferForecastDefaults = {
  lift_pct: 23.5,
  lift_source: "seeded",
  lift_n: 2,
  depth_pct: 15,
  orders: 120,
  orders_source: "derived",
  attach_pct: 40,
  attach_source: "measured",
  gift_units: 48,
  after_ratio: -0.07,
  after_n: 3,
  holiday: false,
  cell: { format: "gift_min", depth_band: "mid", scope_class: "sitewide", season: "other" },
};

describe("buildForecastColumns (planner-first)", () => {
  const now = new Date("2026-09-09T12:00:00Z");

  it("no typed values: derived columns from the RPC, planner columns null", () => {
    expect(buildForecastColumns(DEFAULTS, { lift: "", orders: "", giftUnits: "" }, "gift_min", 1, now)).toEqual({
      derived_lift_pct: 23.5,
      derived_orders: 120,
      derived_attach_pct: 40,
      derived_gift_units: 48,
      defaults_source: DEFAULTS,
      expected_uplift_pct: null,
      expected_orders: null,
      planner_gift_units: null,
      effective_discount_pct: 15,
      derived_at: "2026-09-09T12:00:00.000Z",
    });
  });

  it("typed lift + orders: planner columns set, gift units computed from the typed orders", () => {
    const cols = buildForecastColumns(DEFAULTS, { lift: "30", orders: "150", giftUnits: "" }, "gift_min", 1, now);
    expect(cols.expected_uplift_pct).toBe(30);
    expect(cols.expected_orders).toBe(150);
    expect(cols.planner_gift_units).toBe(60); // 150 x 40% x 1
    expect(cols.derived_lift_pct).toBe(23.5);
    expect(cols.derived_orders).toBe(120);
    expect(cols.derived_gift_units).toBe(48);
    expect(buildForecastColumns(DEFAULTS, { lift: "30", orders: "150", giftUnits: "" }, "gift_min", 2, now).planner_gift_units).toBe(120);
  });

  it("a typed gift-units cap wins over the computed value", () => {
    const cols = buildForecastColumns(DEFAULTS, { lift: "30", orders: "150", giftUnits: "55" }, "gift_min", 1, now);
    expect(cols.planner_gift_units).toBe(55);
  });

  it("non-numeric or fractional edits are treated as unset", () => {
    const cols = buildForecastColumns(DEFAULTS, { lift: "abc", orders: "12.5", giftUnits: " " }, "gift_min", 1, now);
    expect(cols.expected_uplift_pct).toBeNull();
    expect(cols.expected_orders).toBeNull();
    expect(cols.planner_gift_units).toBeNull();
  });

  it("no RPC result: everything derived is null, typed values still land", () => {
    const cols = buildForecastColumns(null, { lift: "25", orders: "", giftUnits: "" }, "percent", 1, now);
    expect(cols.derived_lift_pct).toBeNull();
    expect(cols.defaults_source).toBeNull();
    expect(cols.derived_at).toBeNull();
    expect(cols.effective_discount_pct).toBeNull();
    expect(cols.expected_uplift_pct).toBe(25);
  });

  it("orders / gift edits never land on a non-gift format (format-switch leak)", () => {
    const cols = buildForecastColumns(DEFAULTS, { lift: "15", orders: "900", giftUnits: "500" }, "percent", 1, now);
    expect(cols.expected_uplift_pct).toBe(15);
    expect(cols.expected_orders).toBeNull();
    expect(cols.planner_gift_units).toBeNull();
    expect(buildForecastColumns(DEFAULTS, { lift: "", orders: "900", giftUnits: "500" }, "dollar", 1, now).expected_orders).toBeNull();
  });

  it("edits outside the DB CHECK range are treated as unset", () => {
    const zero = buildForecastColumns(DEFAULTS, { lift: "", orders: "0", giftUnits: "-5" }, "gift_min", 1, now);
    expect(zero.expected_orders).toBeNull();
    expect(zero.planner_gift_units).toBeNull();
    const neg = buildForecastColumns(DEFAULTS, { lift: "-150", orders: "-3", giftUnits: "0" }, "gift_code", 1, now);
    expect(neg.expected_uplift_pct).toBeNull();
    expect(neg.expected_orders).toBeNull();
    expect(neg.planner_gift_units).toBe(0);
  });
});

describe("validateForecastEdits", () => {
  it("lift is required on every format", () => {
    expect(validateForecastEdits({ lift: "", orders: "", giftUnits: "" }, "percent")).toEqual({ ok: false, missing: ["lift"] });
    expect(validateForecastEdits({ lift: "15", orders: "", giftUnits: "" }, "percent").ok).toBe(true);
    expect(validateForecastEdits({ lift: "-101", orders: "", giftUnits: "" }, "dollar").missing).toContain("lift");
    expect(validateForecastEdits({ lift: "0", orders: "", giftUnits: "" }, "dollar").ok).toBe(true);
  });

  it("orders is required on gift formats; a typed cap must be a whole number >= 0", () => {
    expect(validateForecastEdits({ lift: "40", orders: "", giftUnits: "" }, "gift_min")).toEqual({ ok: false, missing: ["orders"] });
    expect(validateForecastEdits({ lift: "40", orders: "0", giftUnits: "" }, "gift_skus").missing).toEqual(["orders"]);
    expect(validateForecastEdits({ lift: "40", orders: "900", giftUnits: "" }, "gift_code").ok).toBe(true);
    expect(validateForecastEdits({ lift: "40", orders: "900", giftUnits: "-1" }, "bxgy").missing).toEqual(["giftUnits"]);
    expect(validateForecastEdits({ lift: "40", orders: "900", giftUnits: "12.5" }, "bxgy").missing).toEqual(["giftUnits"]);
    expect(validateForecastEdits({ lift: "40", orders: "900", giftUnits: "0" }, "bxgy").ok).toBe(true);
  });

  it("no format: not ok", () => {
    expect(validateForecastEdits({ lift: "40", orders: "900", giftUnits: "" }, null).ok).toBe(false);
  });
});

describe("giftUnits / forecastView", () => {
  it("giftUnits rounds orders x attach x qty", () => {
    expect(giftUnits(120, 40, 1)).toBe(48);
    expect(giftUnits(120, 40, 2)).toBe(96);
    expect(giftUnits(101, 33.3, 1)).toBe(34);
    expect(giftUnits(null, 40, 1)).toBeNull();
    expect(giftUnits(120, null, 1)).toBeNull();
  });

  it("forecastView shows only typed lift/orders and computes gift units from typed orders", () => {
    const empty = forecastView(DEFAULTS, { lift: "", orders: "", giftUnits: "" }, 1);
    expect(empty).toEqual({ lift: null, liftSet: false, orders: null, ordersSet: false, giftUnits: null, giftUnitsSet: false });
    const typed = forecastView(DEFAULTS, { lift: "30", orders: "200", giftUnits: "" }, 2);
    expect(typed.lift).toBe(30);
    expect(typed.liftSet).toBe(true);
    expect(typed.orders).toBe(200);
    expect(typed.giftUnits).toBe(160);
    expect(typed.giftUnitsSet).toBe(false);
    const capped = forecastView(DEFAULTS, { lift: "30", orders: "200", giftUnits: "30" }, 1);
    expect(capped.giftUnits).toBe(30);
    expect(capped.giftUnitsSet).toBe(true);
  });

  it("forecastView ignores orders / gift edits on a non-gift format and out-of-range values", () => {
    const pct = forecastView(DEFAULTS, { lift: "12", orders: "900", giftUnits: "500" }, 1, "percent");
    expect(pct.orders).toBeNull();
    expect(pct.ordersSet).toBe(false);
    expect(pct.giftUnits).toBeNull();
    expect(pct.giftUnitsSet).toBe(false);
    const zero = forecastView(DEFAULTS, { lift: "", orders: "0", giftUnits: "" }, 1, "gift_min");
    expect(zero.orders).toBeNull();
    expect(zero.ordersSet).toBe(false);
  });

  it("isGiftFormat covers the four gift-row formats", () => {
    expect(isGiftFormat("gift_min")).toBe(true);
    expect(isGiftFormat("bxgy")).toBe(true);
    expect(isGiftFormat("percent")).toBe(false);
    expect(isGiftFormat(null)).toBe(false);
  });
});
