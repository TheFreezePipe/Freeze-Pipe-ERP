import { describe, it, expect } from "vitest";
import { inboundBySku, type InboundLine, type InboundShipment, type LaunchMemberCard, type LaunchMemberRow } from "./launch-link";
import type { PdLaunchRef } from "./pd";
import {
  AIR_TRANSIT_DAYS,
  SEA_TRANSIT_DAYS,
  EMPTY_FACTORY_SUPPLY,
  airAltText,
  allInText,
  arrivesText,
  bandText,
  coverageText,
  coverageTitle,
  driftText,
  factoryRemaining,
  factorySubText,
  freightWhereLabel,
  isOpenSupplyOrder,
  launchProducts,
  launchRollup,
  launchSellStart,
  ledgerLines,
  pastDueText,
  prefilledText,
  referenceHref,
  referenceLabel,
  referenceText,
  slackDays,
  slackText,
  supplyLedger,
  unitsBy,
  warehouseBySku,
  warehouseSplitText,
  type FactorySupplyRow,
  type FreightSupplyRow,
  type LaunchFactorySupply,
  type LaunchFactorySupplyItem,
  type LaunchFactorySupplyOrder,
  type LaunchProductItem,
  type LaunchSupplyContext,
  type LedgerLine,
  type SupplyLedger,
  type SupplyRow,
  type WarehouseSplit,
} from "./launch-supply";

const TODAY = "2026-10-05";

// ---------------------------------------------------------------------------
// Fixtures: the three live launches on Monday, Oct 5 (the approved mockup's LAUNCHES)
// ---------------------------------------------------------------------------

const launchRef = (over: Partial<PdLaunchRef> & { id: string; name: string }): PdLaunchRef => ({
  kind: "launch",
  launch_date: null,
  early_access_date: null,
  inventory_ready_by: null,
  ...over,
});

const NL = launchRef({ id: "nl", name: "Northern Lights Studio drop", kind: "studio_drop", launch_date: "2026-11-16", early_access_date: "2026-11-09", inventory_ready_by: "2026-10-20" });
const NEG = launchRef({ id: "neg", name: "Negative Freeze Pipe Bundle Launch", launch_date: "2026-10-26", inventory_ready_by: "2026-10-06" });
const PUFFCO = launchRef({ id: "puffco", name: "Puffco Top Pro Launch", launch_date: "2026-10-14", inventory_ready_by: "2026-09-24" });

const SKU = { bw20dna: "sku-bw20dna", nb2: "sku-nb2", nb6: "sku-nb6", bw66p: "sku-bw66p", bw66: "sku-bw66", erig: "sku-erig" };
const ITEM = { bw20dna: "foi-bw20dna", nb2: "foi-nb2", nb6: "foi-nb6" };

const split = (over: Partial<WarehouseSplit> = {}): WarehouseSplit => ({ finished: 0, prefilled: 0, wip: 0, raw: 0, other: 0, ...over });

const WAREHOUSE = new Map<string, WarehouseSplit>([
  [SKU.bw66p, split({ finished: 18, wip: 48, raw: 234 })],
  [SKU.nb2, split({ raw: 2 })],
  [SKU.nb6, split({ raw: 2 })],
  [SKU.erig, split({ raw: 2 })],
]);

interface ShipOpts {
  type?: "sea" | "air";
  original?: string | null;
  carrier?: string | null;
  cartons?: { qty: number; received?: number; skus: string[] }[];
  received?: string | null;
}

const ship = (shipment_number: string, status: string, eta: string | null, o: ShipOpts = {}): InboundShipment => ({
  id: `s-${shipment_number}`,
  shipment_number,
  freight_type: o.type ?? "sea",
  status,
  eta,
  eta_original: o.original === undefined ? eta : o.original,
  ship_date: null,
  carrier_name: o.carrier ?? null,
  receipt_confirmed_at: o.received ?? null,
  carton_groups: (o.cartons ?? []).map((g) => ({ carton_qty: g.qty, received_cartons: g.received ?? 0, skus: g.skus.map((sku_id) => ({ sku_id })) })),
});

const line = (
  sku_id: string,
  shipment: InboundShipment,
  quantity: number,
  o: { received?: number; prefilled?: number | null; src?: string | null } = {},
): InboundLine => ({
  sku_id,
  quantity,
  quantity_received: o.received ?? 0,
  quantity_prefilled: o.prefilled === undefined ? 0 : o.prefilled,
  source_factory_order_item_id: o.src ?? null,
  freight_shipment_id: shipment.id,
  shipment,
});

const AIR_268 = ship("AIR-268", "on_the_water", "2026-10-07", { type: "air", original: "2026-09-30", carrier: "UPS", cartons: [{ qty: 1, skus: [SKU.bw20dna] }] });
const SEA_486 = ship("486", "on_the_water", "2026-10-30", { carrier: "UPS", cartons: [{ qty: 5, skus: [SKU.bw20dna] }] });
const SEA_485 = ship("485", "pending", "2026-10-30", { original: null, cartons: [{ qty: 6, skus: [SKU.bw20dna] }] });
const SEA_487 = ship("487", "pending", "2026-11-04", { original: null, cartons: [{ qty: 1, skus: [SKU.nb6] }] });
const SEA_476 = ship("476", "on_the_water", "2026-10-12", { original: "2026-10-10", carrier: "FedEx", cartons: [{ qty: 9, skus: [SKU.bw66] }] });
const SEA_482 = ship("482", "on_the_water", "2026-10-24", { carrier: "FedEx", cartons: [{ qty: 1, skus: [SKU.bw66] }] });
const SEA_473 = ship("473", "tracking", "2026-10-06", { original: "2026-09-27", carrier: "FedEx", cartons: [{ qty: 9, skus: [SKU.erig] }] });
/** Samples, checked in and confirmed on Sep 22: never inbound, but they left the factory. */
const AIR_266 = ship("AIR-266", "delivered", "2026-09-22", { type: "air", received: "2026-09-22T18:00:00Z" });

const LINES: InboundLine[] = [
  line(SKU.bw20dna, SEA_485, 150, { prefilled: 150, src: ITEM.bw20dna }),
  line(SKU.bw20dna, SEA_486, 125, { prefilled: 125, src: ITEM.bw20dna }),
  line(SKU.bw20dna, AIR_268, 2, { src: ITEM.bw20dna }),
  line(SKU.nb2, AIR_266, 2, { received: 2, src: ITEM.nb2 }),
  line(SKU.nb6, AIR_266, 2, { received: 2, src: ITEM.nb6 }),
  line(SKU.nb6, SEA_487, 44, { src: ITEM.nb6 }),
  line(SKU.bw66, SEA_476, 270),
  line(SKU.bw66, SEA_482, 30),
  line(SKU.erig, SEA_473, 98),
];

const item = (over: Partial<LaunchFactorySupplyItem> & { id: string; sku_id: string; quantity_ordered: number }): LaunchFactorySupplyItem => ({
  quantity_finished: null,
  quantity_breakage: 0,
  quantity_shipped_manual: 0,
  quantity_consumed_by_parent: 0,
  alternate_expected_completion: null,
  ...over,
});

const AS: LaunchFactorySupplyOrder = {
  id: "fo-as",
  order_number: "AS082726BW",
  status: "ordered",
  expected_completion: "2026-09-27",
  items: [item({ id: ITEM.bw20dna, sku_id: SKU.bw20dna, quantity_ordered: 300 })],
};
const YX: LaunchFactorySupplyOrder = {
  id: "fo-yx",
  order_number: "YX-2026082802",
  status: "ordered",
  expected_completion: "2026-10-07",
  items: [item({ id: ITEM.nb2, sku_id: SKU.nb2, quantity_ordered: 200 }), item({ id: ITEM.nb6, sku_id: SKU.nb6, quantity_ordered: 200 })],
};
const FACTORY: LaunchFactorySupply = {
  orders: [AS, YX],
  shippedByItem: new Map([
    [ITEM.bw20dna, 277],
    [ITEM.nb2, 2],
    [ITEM.nb6, 46],
  ]),
};

const CTX: LaunchSupplyContext = { warehouse: WAREHOUSE, inbound: inboundBySku(LINES), factory: FACTORY };

/** A context with just the given lines / orders / stock. */
const ctx = (o: { lines?: InboundLine[]; orders?: LaunchFactorySupplyOrder[]; shipped?: [string, number][]; warehouse?: [string, WarehouseSplit][] } = {}): LaunchSupplyContext => ({
  warehouse: new Map(o.warehouse ?? []),
  inbound: inboundBySku(o.lines ?? []),
  factory: { orders: o.orders ?? [], shippedByItem: new Map(o.shipped ?? []) },
});

const row = (over: Partial<LaunchMemberRow> & { id: string }): LaunchMemberRow => ({
  sku_id: null,
  planned_name: null,
  pd_project_id: null,
  limited_qty: null,
  expected_first_30d_units: null,
  product: null,
  ...over,
});

const card = (over: Partial<LaunchMemberCard> & { id: string; name: string }): LaunchMemberCard => ({
  stage: "ordered",
  target_launch_date: null,
  spec_sent_at: null,
  linked_launch_id: null,
  launch_date_override: false,
  launch: null,
  linked_sku_id: null,
  archived_at: null,
  ...over,
});

const plain = (r: LaunchMemberRow): LaunchProductItem<LaunchMemberCard, LaunchMemberRow> => ({
  kind: "plain",
  key: r.id,
  sku: r.product?.sku ?? null,
  name: r.product?.product_name ?? r.planned_name ?? "",
  row: r,
});
const carded = (c: LaunchMemberCard, r: LaunchMemberRow | null): LaunchProductItem<LaunchMemberCard, LaunchMemberRow> => ({ kind: "card", key: r?.id ?? c.id, card: c, row: r });

const NL_CARDS = [
  card({ id: "c-bw20dna", name: "Q4 Studio - BW20DNA", linked_sku_id: SKU.bw20dna, linked_launch_id: NL.id, launch: NL, target_launch_date: NL.launch_date }),
  card({ id: "c-nb2", name: "Q4 Studio - NB2", linked_sku_id: SKU.nb2, linked_launch_id: NL.id, launch: NL, target_launch_date: NL.launch_date }),
  card({ id: "c-nb6", name: "Q4 Studio - NB6", linked_sku_id: SKU.nb6, linked_launch_id: NL.id, launch: NL, target_launch_date: NL.launch_date }),
];
const NL_ROWS = [
  row({ id: "m1", sku_id: SKU.bw20dna, pd_project_id: "c-bw20dna", limited_qty: 300, product: { sku: "S04-BW20DNA", product_name: "Q4 Studio - BW20DNA" } }),
  row({ id: "m2", sku_id: SKU.nb2, pd_project_id: "c-nb2", limited_qty: 200, product: { sku: "S04-NB2", product_name: "Q4 Studio - NB2" } }),
  row({ id: "m3", sku_id: SKU.nb6, pd_project_id: "c-nb6", limited_qty: 200, product: { sku: "S04-NB6", product_name: "Q4 Studio - NB6" } }),
];
const NL_LAUNCH = { ...NL, skus: NL_ROWS, cards: NL_CARDS };
const NL_ITEMS = NL_ROWS.map((r, i) => carded(NL_CARDS[i], r));

const NEG_ROWS = [
  row({ id: "n1", sku_id: SKU.bw66p, product: { sku: "BW66P", product_name: "Negative Freeze Pipe" } }),
  row({ id: "n2", sku_id: SKU.bw66, product: { sku: "BW66", product_name: "Negative Freeze Pipe Mini" } }),
];
const NEG_LAUNCH = { ...NEG, skus: NEG_ROWS, cards: [] };

const PUFFCO_ROWS = [row({ id: "p1", sku_id: SKU.erig, product: { sku: "E-Rig-Pro", product_name: "Puffco Peak Attachment Pro" } })];
const PUFFCO_LAUNCH = { ...PUFFCO, skus: PUFFCO_ROWS, cards: [] };

const keys = (l: SupplyLedger) => l.rows.map((r) => r.key);
const lineKeys = (lines: LedgerLine[]) => lines.map((x) => (x.kind === "row" ? x.row.key : x.kind === "band" ? `band:${x.band.key}` : `remainder:${x.units}`));
const freight = (l: SupplyLedger, number: string) => l.rows.find((r) => r.kind === "freight" && r.shipment.shipment_number === number) as FreightSupplyRow;
const factory = (l: SupplyLedger, order: string) => l.rows.find((r) => r.kind === "factory" && r.order.order_number === order) as FactorySupplyRow;

// ---------------------------------------------------------------------------
// Northern Lights (EA Nov 9, launch Nov 16, ready by Oct 20)
// ---------------------------------------------------------------------------

describe("Northern Lights · S04-BW20DNA (need 300)", () => {
  const l = supplyLedger(SKU.bw20dna, 300, NL, CTX, TODAY);

  it("stock first, then by date, firm before estimated, shipments before factory remainders; running totals", () => {
    expect(keys(l)).toEqual([`wh:${SKU.bw20dna}`, "fr:s-AIR-268", "fr:s-486", "fr:s-485", `fo:${ITEM.bw20dna}`]);
    expect(l.rows.map((r) => [r.units, r.runningTotal, r.date, r.estimated])).toEqual([
      [0, 0, "2026-10-05", false],
      [2, 2, "2026-10-07", false],
      [125, 127, "2026-10-30", false],
      [150, 277, "2026-11-09", true],
      [23, 300, "2026-11-09", true],
    ]);
  });

  it("On time: all 300 in the building by EA (Nov 9), all in ~Nov 9; only 2 made the ready-by goal", () => {
    expect(l).toMatchObject({ total: 300, need: 300, basis: 300, bySell: 300, byReady: 2, sellStart: "2026-11-09", readyBy: "2026-10-20" });
    expect(l.verdict).toEqual({ key: "on_time", tone: "g", text: "On time", shortfall: 0 });
    expect(l.allIn).toEqual({ kind: "date", date: "2026-11-09", estimated: true });
    expect(allInText(l.allIn)).toBe("~Nov 9");
    expect(coverageText(l)).toBe("300 / 300");
  });

  it("AIR-268: 2 units, firm Oct 7, drifted +7d from Sep 30, 1 carton, In the air", () => {
    const r = freight(l, "AIR-268");
    expect(r).toMatchObject({ mode: "air", units: 2, cartons: 1, driftDays: 7, overdueDays: 0, whereLabel: "In the air", tone: "g" });
    expect(arrivesText(r, TODAY)).toBe("Oct 7 · 2d");
    expect(driftText(r)).toBe("+7d");
    expect(referenceText(r)).toBe("Air AIR-268 · UPS");
    expect(referenceLabel(r)).toBe("Air AIR-268");
    expect(referenceHref(r)).toBe("/freight/s-AIR-268");
    expect(slackText(slackDays(r, l.sellStart))).toBe("33d to spare");
    expect(prefilledText(r)).toBeNull();
    expect(coverageTitle(r)).toBe("Air AIR-268 · 2 · Oct 7");
  });

  it("Sea 486: 125 pre-filled units, firm Oct 30 (amber: past the goal, before EA), no drift", () => {
    const r = freight(l, "486");
    expect(r).toMatchObject({ mode: "sea", units: 125, cartons: 5, driftDays: null, whereLabel: "On the water", tone: "a" });
    expect(prefilledText(r)).toBe("PRE-FILLED");
    expect(referenceText(r)).toBe("Sea 486 · UPS");
    expect(slackText(slackDays(r, l.sellStart))).toBe("10d to spare");
  });

  it("Sea 485 has not sailed: its Oct 30 ETA cannot be reached, so it re-dates to today + 35 (~Nov 9), no drift chip", () => {
    const r = freight(l, "485");
    expect(r).toMatchObject({ date: "2026-11-09", estimated: true, units: 150, cartons: 6, driftDays: null, whereLabel: "Not shipped", tone: "a" });
    expect(arrivesText(r, TODAY)).toBe("~Nov 9 · ~35d");
    expect(referenceText(r)).toBe("Sea 485");
    expect(slackText(slackDays(r, l.sellStart))).toBe("on the day");
    expect(coverageTitle(r)).toBe("Sea 485 · 150 · ~Nov 9");
  });

  it("factory AS082726BW: 23 of 300 still to ship, due Sep 27 passed (8d) → sails today, ~Nov 9 by sea, air ~Oct 20", () => {
    const r = factory(l, "AS082726BW");
    expect(r).toMatchObject({ units: 23, due: "2026-09-27", date: "2026-11-09", estimated: true, airAlt: "2026-10-20", pastDueDays: 8, ordered: 300, shipped: 277, finished: 0, cartons: null, whereLabel: "At factory" });
    expect(arrivesText(r, TODAY)).toBe("~Nov 9 · ~35d");
    expect(airAltText(r)).toBe("air ~Oct 20");
    expect(pastDueText(r)).toBe("Past due 8d");
    expect(referenceText(r)).toBe("AS082726BW");
    expect(referenceHref(r)).toBe("/inventory/factory-orders/fo-as");
    expect(factorySubText(r)).toBe("300 ordered · 277 shipped");
    expect(coverageTitle(r)).toBe("Factory AS082726BW · 23 · ~Nov 9");
  });

  it("bands: Ready by Oct 20 reads 2 of 300 (amber, the goal) before the Oct 30 row; EA and Launch after the last row, met", () => {
    expect(l.bands).toEqual([
      { key: "ready", label: "Ready by", date: "2026-10-20", have: 2, basis: 300, tone: "a" },
      { key: "ea", label: "Early access", date: "2026-11-09", have: 300, basis: 300, tone: null },
      { key: "launch", label: "Launch", date: "2026-11-16", have: 300, basis: 300, tone: null },
    ]);
    expect(lineKeys(ledgerLines(l, TODAY))).toEqual([`wh:${SKU.bw20dna}`, "fr:s-AIR-268", "band:ready", "fr:s-486", "fr:s-485", `fo:${ITEM.bw20dna}`, "band:ea", "band:launch"]);
    expect(bandText(l.bands[0])).toEqual({ label: "Ready by Oct 20", count: "2 of 300" });
  });

  it("the empty warehouse row reads — and Here", () => {
    const wh = l.rows[0];
    expect(wh).toMatchObject({ kind: "warehouse", here: true, units: 0, cartons: null, whereLabel: "In warehouse", tone: "g" });
    expect(referenceText(wh)).toBe("—");
    expect(arrivesText(wh, TODAY)).toBe("Here");
    expect(slackDays(wh, l.sellStart)).toBeNull();
    expect(slackText(null)).toBe("—");
    expect(coverageTitle(wh)).toBe("In warehouse · 0 · here");
  });
});

describe("Northern Lights · NB2 and NB6 (need 200)", () => {
  it("NB2: 2 raw + 198 at the factory due Oct 7 → ~Nov 11; Misses EA, 2 / 200", () => {
    const l = supplyLedger(SKU.nb2, 200, NL, CTX, TODAY);
    expect(keys(l)).toEqual([`wh:${SKU.nb2}`, `fo:${ITEM.nb2}`]);
    const r = factory(l, "YX-2026082802");
    expect(r).toMatchObject({ units: 198, date: "2026-11-11", airAlt: "2026-10-22", pastDueDays: 0, shipped: 2, tone: "r" });
    expect(pastDueText(r)).toBeNull();
    expect(slackText(slackDays(r, l.sellStart))).toBe("2d past");
    expect(l).toMatchObject({ total: 200, basis: 200, bySell: 2, byReady: 2 });
    expect(l.verdict).toEqual({ key: "misses", tone: "r", text: "Misses EA", shortfall: 0 });
    expect(l.allIn).toEqual({ kind: "date", date: "2026-11-11", estimated: true });
    expect(coverageText(l)).toBe("2 / 200");
    expect(referenceText(l.rows[0])).toBe("Raw 2");
  });

  it("NB6: Sea 487 (pending, 44u) re-dates from its Nov 4 ETA to ~Nov 9; factory 154u ~Nov 11 → Misses EA 46 / 200", () => {
    const l = supplyLedger(SKU.nb6, 200, NL, CTX, TODAY);
    expect(keys(l)).toEqual([`wh:${SKU.nb6}`, "fr:s-487", `fo:${ITEM.nb6}`]);
    expect(freight(l, "487")).toMatchObject({ units: 44, cartons: 1, date: "2026-11-09", estimated: true });
    expect(factory(l, "YX-2026082802")).toMatchObject({ units: 154, shipped: 46, date: "2026-11-11" });
    expect(l).toMatchObject({ bySell: 46, basis: 200 });
    expect(l.verdict?.text).toBe("Misses EA");
    expect(allInText(l.allIn)).toBe("~Nov 11");
    expect(l.bands.map((b) => [b.key, b.have, b.tone])).toEqual([
      ["ready", 2, "a"],
      ["ea", 46, "r"],
      ["launch", 200, null],
    ]);
    expect(lineKeys(ledgerLines(l, TODAY))).toEqual([`wh:${SKU.nb6}`, "band:ready", "fr:s-487", "band:ea", `fo:${ITEM.nb6}`, "band:launch"]);
  });

  it("launch rollup: red, '3 products · 2 miss EA', chip 'Misses EA · ~Nov 11'", () => {
    const products = launchProducts(NL_ITEMS, NL_LAUNCH, CTX, TODAY);
    expect(products.map((p) => [p.sku, p.skuId, p.ledger?.verdict?.key, p.development])).toEqual([
      ["S04-BW20DNA", SKU.bw20dna, "on_time", null],
      ["S04-NB2", SKU.nb2, "misses", null],
      ["S04-NB6", SKU.nb6, "misses", null],
    ]);
    const roll = launchRollup(products, NL_LAUNCH);
    expect(roll).toEqual({
      tone: "r",
      text: "3 products · 2 miss EA",
      chip: { tone: "r", text: "Misses EA · ~Nov 11" },
      counts: { short: 0, misses: 2, late: 0, tight: 0 },
    });
  });
});

// ---------------------------------------------------------------------------
// Negative bundle (launch Oct 26, ready by Oct 6) and Puffco (launch Oct 14, ready by Sep 24 passed)
// ---------------------------------------------------------------------------

describe("Negative Freeze Pipe Bundle", () => {
  it("BW66P: 300 in the warehouse, no quantity set → judged against the total; On time, Here", () => {
    const l = supplyLedger(SKU.bw66p, null, NEG, CTX, TODAY);
    expect(keys(l)).toEqual([`wh:${SKU.bw66p}`]);
    expect(l).toMatchObject({ total: 300, need: null, basis: 300, bySell: 300, byReady: 300 });
    expect(l.verdict?.key).toBe("on_time");
    expect(l.allIn).toEqual({ kind: "here" });
    expect(allInText(l.allIn)).toBe("Here");
    expect(referenceText(l.rows[0])).toBe("Finished 18 · WIP 48 · Raw 234");
    expect(l.bands.map((b) => [b.key, b.have, b.tone])).toEqual([
      ["ready", 300, null],
      ["launch", 300, null],
    ]);
    expect(lineKeys(ledgerLines(l, TODAY))).toEqual([`wh:${SKU.bw66p}`, "band:ready", "band:launch"]);
  });

  it("BW66: Sea 476 (270u, Oct 12, +2d) and Sea 482 (30u, Oct 24): On time, all in Oct 24; both bars amber (past the goal, before launch)", () => {
    const l = supplyLedger(SKU.bw66, null, NEG, CTX, TODAY);
    expect(keys(l)).toEqual([`wh:${SKU.bw66}`, "fr:s-476", "fr:s-482"]);
    const a = freight(l, "476");
    expect(a).toMatchObject({ units: 270, cartons: 9, driftDays: 2, tone: "a", runningTotal: 270 });
    expect(driftText(a)).toBe("+2d");
    expect(referenceText(a)).toBe("Sea 476 · FedEx");
    expect(coverageTitle(a)).toBe("Sea 476 · 270 · Oct 12");
    expect(freight(l, "482")).toMatchObject({ units: 30, cartons: 1, driftDays: null, tone: "a", runningTotal: 300 });
    expect(l).toMatchObject({ basis: 300, bySell: 300, byReady: 0 });
    expect(l.verdict?.key).toBe("on_time");
    expect(l.allIn).toEqual({ kind: "date", date: "2026-10-24", estimated: false });
    expect(slackText(slackDays(a, l.sellStart))).toBe("14d to spare");
  });

  it("rollup: green, '2 products', chip 'On time · all in Oct 24'", () => {
    const roll = launchRollup(launchProducts(NEG_ROWS.map(plain), NEG_LAUNCH, CTX, TODAY), NEG_LAUNCH);
    expect(roll).toEqual({ tone: "g", text: "2 products", chip: { tone: "g", text: "On time · all in Oct 24" }, counts: { short: 0, misses: 0, late: 0, tight: 0 } });
  });
});

describe("Puffco Top Pro", () => {
  const l = supplyLedger(SKU.erig, null, PUFFCO, CTX, TODAY);

  it("2 raw + Sea 473 (98u, Oct 6, Ground, +9d): basis 100, On time, all in Oct 6", () => {
    const r = freight(l, "473");
    expect(r).toMatchObject({ units: 98, cartons: 9, driftDays: 9, whereLabel: "Ground", tone: "a", date: "2026-10-06", estimated: false });
    expect(l).toMatchObject({ total: 100, basis: 100, bySell: 100, byReady: 2 });
    expect(l.verdict?.key).toBe("on_time");
    expect(l.allIn).toEqual({ kind: "date", date: "2026-10-06", estimated: false });
    expect(arrivesText(r, TODAY)).toBe("Oct 6 · 1d");
  });

  it("the passed Ready by band sits directly under the warehouse row, 2 of 100, amber", () => {
    expect(lineKeys(ledgerLines(l, TODAY))).toEqual([`wh:${SKU.erig}`, "band:ready", "fr:s-473", "band:launch"]);
    expect(l.bands[0]).toEqual({ key: "ready", label: "Ready by", date: "2026-09-24", have: 2, basis: 100, tone: "a" });
    const roll = launchRollup(launchProducts(PUFFCO_ROWS.map(plain), PUFFCO_LAUNCH, CTX, TODAY), PUFFCO_LAUNCH);
    expect(roll.chip).toEqual({ tone: "g", text: "On time · all in Oct 6" });
    expect(roll.text).toBe("1 product");
  });
});

// ---------------------------------------------------------------------------
// Arrival rules
// ---------------------------------------------------------------------------

describe("arrival rules", () => {
  const sku = SKU.bw66;
  const one = (s: InboundShipment, units = 10) => supplyLedger(sku, null, NEG, ctx({ lines: [line(sku, s, units)] }), TODAY).rows[1] as FreightSupplyRow;

  it("delivered, receipt unconfirmed: on the dock — today, firm, here; counts toward a passed milestone, whose band sits below it", () => {
    const r = one(ship("D", "delivered", "2026-10-01"));
    expect(r).toMatchObject({ date: TODAY, estimated: false, here: true, whereLabel: "On the dock", tone: "g", overdueDays: 0 });
    expect(arrivesText(r, TODAY)).toBe("Here");
    expect(slackDays(r, "2026-10-26")).toBeNull();
    expect(unitsBy([r], "2026-09-01")).toBe(10);
    const l = supplyLedger(sku, null, PUFFCO, ctx({ lines: [line(sku, ship("D", "delivered", "2026-10-01"), 10)] }), TODAY);
    expect(l.bands[0]).toMatchObject({ key: "ready", have: 10, tone: null });
    expect(l.allIn).toEqual({ kind: "here" });
    expect(lineKeys(ledgerLines(l, TODAY))).toEqual([`wh:${sku}`, "fr:s-D", "band:ready", "band:launch"]);
  });

  it("the dock follows the warehouse ahead of every shipment, and the passed band follows the whole here block it counts", () => {
    const lines = [line(sku, ship("T", "tracking", "2026-10-06"), 88), line(sku, ship("M", "cleared_customs", TODAY), 5), line(sku, ship("D", "delivered", "2026-10-01"), 10)];
    const l = supplyLedger(sku, null, PUFFCO, ctx({ lines, warehouse: [[sku, split({ raw: 2 })]] }), TODAY);
    expect(keys(l)).toEqual([`wh:${sku}`, "fr:s-D", "fr:s-M", "fr:s-T"]);
    expect(l.rows.map((r) => r.runningTotal)).toEqual([2, 12, 17, 105]);
    expect(l.bands[0]).toMatchObject({ key: "ready", have: 12, basis: 105, tone: "a" });
    expect(lineKeys(ledgerLines(l, TODAY))).toEqual([`wh:${sku}`, "fr:s-D", "band:ready", "fr:s-M", "fr:s-T", "band:launch"]);
  });

  it("pending: the later of the ETA and today + transit (35 sea / 15 air), estimated; no drift", () => {
    expect(one(ship("P1", "pending", "2026-12-01", { original: "2026-11-01" }))).toMatchObject({ date: "2026-12-01", estimated: true, driftDays: null });
    expect(one(ship("P2", "pending", "2026-10-20"))).toMatchObject({ date: "2026-11-09", estimated: true });
    expect(one(ship("P3", "pending", null))).toMatchObject({ date: "2026-11-09", estimated: true });
    expect(one(ship("P4", "pending", "2026-10-10", { type: "air" }))).toMatchObject({ date: "2026-10-20", estimated: true, mode: "air" });
    expect(SEA_TRANSIT_DAYS).toBe(35);
    expect(AIR_TRANSIT_DAYS).toBe(15);
  });

  it("in transit with a future ETA: the ETA, firm; drift from the original ETA either way", () => {
    expect(one(ship("T1", "on_the_water", "2026-10-20", { original: "2026-10-22" }))).toMatchObject({ date: "2026-10-20", estimated: false, driftDays: -2 });
    expect(driftText(one(ship("T1", "on_the_water", "2026-10-20", { original: "2026-10-22" })))).toBe("−2d");
    expect(one(ship("T2", "cleared_customs", TODAY))).toMatchObject({ date: TODAY, estimated: false, overdueDays: 0, whereLabel: "Customs cleared" });
    expect(driftText(one(ship("T3", "on_the_water", "2026-10-20", { original: null })))).toBeNull();
  });

  it("in transit, ETA passed: today, estimated, Overdue Nd (the drift chip still shows)", () => {
    const r = one(ship("O", "on_the_water", "2026-10-01", { original: "2026-09-28" }));
    expect(r).toMatchObject({ date: TODAY, estimated: true, here: false, overdueDays: 4, driftDays: 3 });
    expect(arrivesText(r, TODAY)).toBe("Overdue 4d");
  });

  it("in transit, no ETA: today + transit, estimated", () => {
    expect(one(ship("N1", "on_the_water", null))).toMatchObject({ date: "2026-11-09", estimated: true });
    expect(one(ship("N2", "on_the_water", null, { type: "air" }))).toMatchObject({ date: "2026-10-20", estimated: true });
    expect(arrivesText(one(ship("N1", "on_the_water", null)), TODAY)).toBe("~Nov 9 · ~35d");
  });

  it("factory: a future due sails on the due; a passed one today; no due at all means today", () => {
    const order = (due: string | null, alt: string | null = null): LaunchFactorySupplyOrder => ({
      id: "fo",
      order_number: "F-1",
      status: "in_production",
      expected_completion: due,
      items: [item({ id: "i", sku_id: sku, quantity_ordered: 50, alternate_expected_completion: alt })],
    });
    const fac = (o: LaunchFactorySupplyOrder) => supplyLedger(sku, null, NEG, ctx({ orders: [o] }), TODAY).rows[1] as FactorySupplyRow;
    expect(fac(order("2026-10-20"))).toMatchObject({ due: "2026-10-20", date: "2026-11-24", airAlt: "2026-11-04", pastDueDays: 0 });
    expect(fac(order("2026-12-01", "2026-10-20"))).toMatchObject({ due: "2026-10-20", date: "2026-11-24" });
    expect(fac(order("2026-09-25"))).toMatchObject({ due: "2026-09-25", date: "2026-11-09", airAlt: "2026-10-20", pastDueDays: 10 });
    expect(fac(order(null))).toMatchObject({ due: null, date: "2026-11-09", pastDueDays: 0 });
    expect(referenceLabel(fac({ ...order("2026-10-20"), order_number: null }))).toBe("Awaiting #");
  });
});

describe("factory remainder, cartons, pre-filled", () => {
  it("remaining = ordered − breakage − on freight (any status) − shipped by hand − built into a parent, floored at 0", () => {
    const it0 = item({ id: "i", sku_id: "s", quantity_ordered: 100, quantity_breakage: 3, quantity_shipped_manual: 10, quantity_consumed_by_parent: 7 });
    expect(factoryRemaining(it0, new Map([["i", 20]]))).toBe(60);
    expect(factoryRemaining(it0, new Map())).toBe(80);
    expect(factoryRemaining(it0, new Map([["i", 500]]))).toBe(0);
    expect(isOpenSupplyOrder({ status: "ordered" })).toBe(true);
    expect(isOpenSupplyOrder({ status: "finished" })).toBe(true);
    expect(isOpenSupplyOrder({ status: "shipped" })).toBe(false);
    expect(isOpenSupplyOrder({ status: "canceled" })).toBe(false);
  });

  it("fully shipped items, shipped / canceled orders and other SKUs make no row; shipped and finished show in the sub-line", () => {
    const o: LaunchFactorySupplyOrder = {
      id: "fo",
      order_number: "F-2",
      status: "finished",
      expected_completion: "2026-10-20",
      items: [
        item({ id: "done", sku_id: SKU.bw66, quantity_ordered: 100 }),
        item({ id: "left", sku_id: SKU.bw66, quantity_ordered: 100, quantity_finished: 40, quantity_shipped_manual: 5 }),
        item({ id: "other", sku_id: SKU.nb2, quantity_ordered: 100 }),
      ],
    };
    const l = supplyLedger(SKU.bw66, null, NEG, ctx({ orders: [o, { ...o, id: "gone", status: "shipped" }, { ...o, id: "dead", status: "canceled" }], shipped: [["done", 100], ["left", 30]] }), TODAY);
    expect(keys(l)).toEqual([`wh:${SKU.bw66}`, "fo:left"]);
    const r = l.rows[1] as FactorySupplyRow;
    expect(r).toMatchObject({ units: 65, ordered: 100, shipped: 35, finished: 40 });
    expect(factorySubText(r)).toBe("100 ordered · 35 shipped · 40 finished");
  });

  it("cartons: the SKU's groups' cartons still to land; null when no group lists the SKU; the lines of one shipment sum", () => {
    const s = ship("C", "on_the_water", "2026-10-20", { cartons: [{ qty: 5, received: 2, skus: [SKU.bw66] }, { qty: 4, skus: [SKU.bw66, SKU.nb2] }, { qty: 9, skus: [SKU.nb2] }] });
    const l = supplyLedger(SKU.bw66, null, NEG, ctx({ lines: [line(SKU.bw66, s, 60, { received: 10 }), line(SKU.bw66, s, 40, { prefilled: 40 })] }), TODAY);
    expect(keys(l)).toEqual([`wh:${SKU.bw66}`, "fr:s-C"]);
    const r = l.rows[1] as FreightSupplyRow;
    expect(r).toMatchObject({ units: 90, quantity: 100, cartons: 7, prefilledUnits: 40 });
    expect(prefilledText(r)).toBe("40 PRE-FILLED");
    const none = supplyLedger(SKU.bw66, null, NEG, ctx({ lines: [line(SKU.bw66, ship("X", "on_the_water", "2026-10-20"), 10)] }), TODAY).rows[1];
    expect(none.cartons).toBeNull();
    expect(prefilledText(none)).toBeNull();
    const nullPrefilled = supplyLedger(SKU.bw66, null, NEG, ctx({ lines: [line(SKU.bw66, ship("X", "on_the_water", "2026-10-20"), 10, { prefilled: null })] }), TODAY).rows[1] as FreightSupplyRow;
    expect(nullPrefilled.prefilledUnits).toBe(0);
  });

  it("fully received lines and confirmed shipments are not supply", () => {
    const l = supplyLedger(SKU.nb2, null, NEG, ctx({ lines: [line(SKU.nb2, AIR_266, 2, { received: 2 })] }), TODAY);
    expect(keys(l)).toEqual([`wh:${SKU.nb2}`]);
  });
});

// ---------------------------------------------------------------------------
// Ordering, totals, bands, remainder, basis
// ---------------------------------------------------------------------------

describe("ordering and totals", () => {
  it("same date: firm before estimated, then by reference text; the running total follows", () => {
    const lines = [
      line(SKU.bw66, ship("Z9", "on_the_water", "2026-11-09"), 5),
      line(SKU.bw66, ship("A1", "pending", "2026-11-09"), 7),
      line(SKU.bw66, ship("B2", "on_the_water", "2026-11-09"), 3),
    ];
    const l = supplyLedger(SKU.bw66, null, NEG, ctx({ lines, warehouse: [[SKU.bw66, split({ finished: 1 })]] }), TODAY);
    expect(keys(l)).toEqual([`wh:${SKU.bw66}`, "fr:s-B2", "fr:s-Z9", "fr:s-A1"]);
    expect(l.rows.map((r) => r.runningTotal)).toEqual([1, 4, 9, 16]);
    expect(l.total).toBe(16);
  });

  it("unitsBy counts rows dated on or before the day, stock always", () => {
    const l = supplyLedger(SKU.bw66, null, NEG, CTX, TODAY);
    expect(unitsBy(l.rows, "2026-10-11")).toBe(0);
    expect(unitsBy(l.rows, "2026-10-12")).toBe(270);
    expect(unitsBy(l.rows, "2026-10-24")).toBe(300);
  });

  it("short: the verdict names the gap, all in is null, a remainder line closes the ledger, the bands count what arrives", () => {
    const l = supplyLedger(SKU.bw66, 500, NEG, CTX, TODAY);
    expect(l).toMatchObject({ total: 300, basis: 500, bySell: 300 });
    expect(l.verdict).toEqual({ key: "short", tone: "r", text: "Short 200", shortfall: 200 });
    expect(l.allIn).toBeNull();
    expect(allInText(l.allIn)).toBe("—");
    expect(lineKeys(ledgerLines(l, TODAY))).toEqual([`wh:${SKU.bw66}`, "band:ready", "fr:s-476", "fr:s-482", "band:launch", "remainder:200"]);
    expect(l.bands.map((b) => [b.key, b.have, b.tone])).toEqual([
      ["ready", 0, "a"],
      ["launch", 300, "r"],
    ]);
    expect(coverageText(l)).toBe("300 / 500");
  });

  it("no supply at all and no need: No supply; a need with nothing coming: Short N", () => {
    const none = supplyLedger("sku-ghost", null, NEG, CTX, TODAY);
    expect(none).toMatchObject({ total: 0, basis: 0, allIn: null });
    expect(none.verdict).toEqual({ key: "none", tone: "r", text: "No supply", shortfall: 0 });
    expect(lineKeys(ledgerLines(none, TODAY))).toEqual(["wh:sku-ghost", "band:ready", "band:launch"]);
    const short = supplyLedger("sku-ghost", 1250, NEG, CTX, TODAY);
    expect(short.verdict).toEqual({ key: "short", tone: "r", text: "Short 1,250", shortfall: 1250 });
    expect(lineKeys(ledgerLines(short, TODAY))).toContain("remainder:1250");
  });

  it("basis: the need when set (limited qty before expected units), else the total supply", () => {
    expect(supplyLedger(SKU.bw66, 120, NEG, CTX, TODAY)).toMatchObject({ need: 120, basis: 120, bySell: 120 });
    expect(supplyLedger(SKU.bw66, null, NEG, CTX, TODAY)).toMatchObject({ need: null, basis: 300 });
    const products = launchProducts(
      [plain(row({ id: "a", sku_id: SKU.bw66, limited_qty: 120, expected_first_30d_units: 50 })), plain(row({ id: "b", sku_id: SKU.bw66, expected_first_30d_units: 50 }))],
      NEG_LAUNCH,
      CTX,
      TODAY,
    );
    expect(products.map((p) => p.ledger?.basis)).toEqual([120, 50]);
  });

  it("a need already met by stock: all in Here, every band met; stock beyond the need caps the counts at the basis", () => {
    const l = supplyLedger(SKU.bw66p, 100, NEG, CTX, TODAY);
    expect(l).toMatchObject({ total: 300, basis: 100, bySell: 100, byReady: 100, allIn: { kind: "here" } });
    expect(l.bands.every((b) => b.have === 100 && b.tone === null)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Verdicts
// ---------------------------------------------------------------------------

describe("verdicts", () => {
  const arriving = (eta: string, launch: PdLaunchRef) => supplyLedger(SKU.bw66, 10, launch, ctx({ lines: [line(SKU.bw66, ship("V", "on_the_water", eta), 10)] }), TODAY);

  it("on time means in the building on or before the first selling day — EA when set, else the launch date, inclusive", () => {
    expect(launchSellStart(NL)).toBe("2026-11-09");
    expect(launchSellStart(NEG)).toBe("2026-10-26");
    expect(launchSellStart(launchRef({ id: "x", name: "x" }))).toBeNull();
    expect(arriving("2026-11-09", NL).verdict?.key).toBe("on_time");
    expect(arriving("2026-11-10", NL).verdict?.text).toBe("Misses EA");
    expect(arriving("2026-10-26", NEG).verdict?.key).toBe("on_time");
    expect(arriving("2026-10-27", NEG).verdict?.text).toBe("Misses launch");
  });

  it("the ready-by goal is never a verdict: an arrival after it but before selling is On time with an amber bar", () => {
    const l = arriving("2026-10-25", NEG);
    expect(l.verdict?.key).toBe("on_time");
    expect(l.rows[1].tone).toBe("a");
    expect(l.byReady).toBe(0);
    expect(arriving("2026-10-27", NEG).rows[1].tone).toBe("r");
    expect(arriving("2026-10-06", NEG).rows[1].tone).toBe("g");
  });

  it("no selling day: no verdict, no bands; the bar shades by the launch date when the launch has no ready-by", () => {
    const undated = launchRef({ id: "u", name: "Undated" });
    const l = arriving("2026-10-25", undated);
    expect(l.verdict).toBeNull();
    expect(l.bands).toEqual([]);
    expect(l.sellStart).toBeNull();
    expect(l.rows[1].tone).toBe("g");
    const launchOnly = launchRef({ id: "lo", name: "Launch only", launch_date: "2026-10-26" });
    expect(supplyLedger(SKU.bw66, 10, launchOnly, ctx({ lines: [line(SKU.bw66, ship("V", "on_the_water", "2026-10-07"), 10)] }), TODAY).rows[1].tone).toBe("a");
  });
});

// ---------------------------------------------------------------------------
// Rollup
// ---------------------------------------------------------------------------

describe("launch rollup", () => {
  const skuRow = (id: string, sku_id: string, need: number | null = null) => plain(row({ id, sku_id, limited_qty: need, product: { sku: id.toUpperCase(), product_name: id } }));
  const roll = (items: LaunchProductItem<LaunchMemberCard, LaunchMemberRow>[], launch = NEG, c: LaunchSupplyContext = CTX) => {
    const l = { ...launch, skus: items.map((it) => it.row ?? { pd_project_id: it.kind === "card" ? it.card.id : null }), cards: items.flatMap((it) => (it.kind === "card" ? [it.card] : [])) };
    return launchRollup(launchProducts(items, l, c, TODAY), l);
  };

  it("short beats misses beats on time; the shortfalls add up", () => {
    const r = roll([skuRow("a", SKU.bw66, 400), skuRow("b", SKU.bw66p, 350), skuRow("c", SKU.erig)]);
    expect(r.tone).toBe("r");
    expect(r.text).toBe("3 products · 2 short");
    expect(r.chip).toEqual({ tone: "r", text: "Short 150" });
    expect(r.counts).toEqual({ short: 2, misses: 0, late: 0, tight: 0 });
  });

  it("No supply when every short product has nothing at all", () => {
    const r = roll([skuRow("a", "sku-ghost"), skuRow("b", SKU.bw66p)]);
    expect(r.chip).toEqual({ tone: "r", text: "No supply" });
    expect(r.text).toBe("2 products · 1 short");
  });

  it("misses: the word follows the launch (EA or launch) and the latest all-in among the missing products", () => {
    const late = launchRef({ id: "l", name: "Soon", launch_date: "2026-10-20", inventory_ready_by: "2026-10-01" });
    const r = roll([skuRow("a", SKU.bw66), skuRow("b", SKU.erig)], late);
    expect(r.chip).toEqual({ tone: "r", text: "Misses launch · Oct 24" });
    expect(r.text).toBe("2 products · 1 miss launch");
    expect(roll(NL_ITEMS, NL).chip?.text).toBe("Misses EA · ~Nov 11");
  });

  it("on time: plain when everything is already here, else the latest all-in (~ when estimated)", () => {
    expect(roll([skuRow("a", SKU.bw66p)]).chip).toEqual({ tone: "g", text: "On time" });
    expect(roll([skuRow("a", SKU.bw66p), skuRow("b", SKU.bw66)]).chip?.text).toBe("On time · all in Oct 24");
    const l = launchRef({ id: "l", name: "Later", launch_date: "2026-12-20", early_access_date: "2026-12-10" });
    expect(roll([skuRow("a", SKU.bw20dna), skuRow("b", SKU.bw66)], l).chip?.text).toBe("On time · all in ~Nov 9");
  });

  it("no chip without SKU products or without a selling day; the count is every non-halted row", () => {
    const dev = card({ id: "d", name: "Heady Studio Drop - BW58", stage: "ready_to_begin", linked_launch_id: NL.id, launch: NL, target_launch_date: NL.launch_date });
    const r = roll([carded(dev, row({ id: "m", pd_project_id: "d", planned_name: "BW58" }))], NL);
    expect(r.chip).toBeNull();
    expect(r.text).toBe("1 product · 1 late");
    const undated = roll([skuRow("a", SKU.bw66p)], launchRef({ id: "u", name: "Undated" }));
    expect(undated).toEqual({ tone: null, text: "1 product", chip: null, counts: { short: 0, misses: 0, late: 0, tight: 0 } });
    expect(roll([]).text).toBe("no products");
  });

  it("development rows keep memberState's reading: late / tight counts and the worst tone; red supply outranks a tight card", () => {
    const tightLaunch = launchRef({ id: "t", name: "Tight", launch_date: "2027-01-04", inventory_ready_by: "2026-12-15" }); // order by Oct 11 → 6d → tight
    const tight = card({ id: "t1", name: "Tight card", stage: "china_working", spec_sent_at: "2026-09-01", linked_launch_id: "t", launch: tightLaunch, target_launch_date: "2027-01-04" });
    const items = [carded(tight, row({ id: "m1", pd_project_id: "t1", planned_name: "Tight card" })), skuRow("a", SKU.bw66p)];
    const r = roll(items, tightLaunch);
    expect(r).toMatchObject({ tone: "a", text: "2 products · 1 tight", counts: { tight: 1, late: 0 } });
    expect(r.chip).toEqual({ tone: "g", text: "On time" });
    const products = launchProducts(items, { ...tightLaunch, skus: [], cards: [tight] }, CTX, TODAY);
    expect(products[0]).toMatchObject({ sku: null, skuId: null, ledger: null, development: { kind: "development", label: "China Working", risk: "a" } });
    expect(roll([...items, skuRow("b", "sku-ghost", 50)], tightLaunch).tone).toBe("r");
  });

  it("launchProducts: a card row takes its SKU from the row, else the card; the code from the row's product, else the card's linked SKU", () => {
    const c = card({ id: "c", name: "Card", linked_sku_id: SKU.bw66, linked_sku: { sku: "BW66" } });
    const products = launchProducts([carded(c, row({ id: "m", pd_project_id: "c" })), carded(c, null)], { ...NEG, skus: [{ pd_project_id: "c" }], cards: [c] }, CTX, TODAY);
    expect(products[0]).toMatchObject({ key: "m", sku: "BW66", skuId: SKU.bw66, name: "Card", development: null });
    expect(products[0].ledger?.total).toBe(300);
    expect(products[1]).toMatchObject({ key: "c", skuId: SKU.bw66, row: { id: "c", sku_id: SKU.bw66, pd_project_id: "c" } });
    const noSku = launchProducts([plain(row({ id: "p", planned_name: "Someday" }))], NEG_LAUNCH, CTX, TODAY)[0];
    expect(noSku).toMatchObject({ sku: null, skuId: null, name: "Someday", ledger: null, development: null });
  });
});

// ---------------------------------------------------------------------------
// Labels and words
// ---------------------------------------------------------------------------

describe("labels", () => {
  it("where: by status, air on its way is In the air; unknown statuses humanized", () => {
    expect(freightWhereLabel("sea", "on_the_water")).toBe("On the water");
    expect(freightWhereLabel("air", "on_the_water")).toBe("In the air");
    expect(freightWhereLabel("sea", "high_risk")).toBe("High risk");
    expect(freightWhereLabel("sea", "out_for_delivery")).toBe("Out for delivery");
    expect(freightWhereLabel("sea", "delivered")).toBe("On the dock");
    expect(freightWhereLabel("sea", "lost_at_sea")).toBe("Lost at sea");
  });

  it("warehouse split: Finished, Pre-filled, WIP, Raw, Other — zeros left out", () => {
    expect(warehouseSplitText(split({ finished: 18, wip: 48, raw: 234 }))).toBe("Finished 18 · WIP 48 · Raw 234");
    expect(warehouseSplitText(split({ other: 3, prefilled: 1200 }))).toBe("Pre-filled 1,200 · Other 3");
    expect(warehouseSplitText(split())).toBe("—");
    const m = warehouseBySku([
      { sku_id: "a", warehouse_raw: 2, warehouse_prefilled_raw: null, warehouse_in_production: 1, warehouse_finished: 5, warehouse_other: null },
      { sku_id: "a", warehouse_raw: 1, warehouse_prefilled_raw: 4, warehouse_in_production: 0, warehouse_finished: 0, warehouse_other: 1 },
      { sku_id: "b", warehouse_raw: 0, warehouse_prefilled_raw: 0, warehouse_in_production: 0, warehouse_finished: 0, warehouse_other: 0 },
    ]);
    expect(m.get("a")).toEqual({ finished: 5, prefilled: 4, wip: 1, raw: 3, other: 1 });
    expect(m.get("b")).toEqual(split());
  });

  it("slack words: to spare / on the day / past", () => {
    expect(slackText(-12)).toBe("12d to spare");
    expect(slackText(0)).toBe("on the day");
    expect(slackText(3)).toBe("3d past");
  });

  it("empty context: a warehouse-only ledger", () => {
    expect(EMPTY_FACTORY_SUPPLY.orders).toEqual([]);
    const l = supplyLedger(SKU.bw66, null, NEG, ctx(), TODAY);
    expect(l.rows.map((r: SupplyRow) => r.kind)).toEqual(["warehouse"]);
    expect(l.verdict?.key).toBe("none");
  });
});

// ---------------------------------------------------------------------------
// Verdict window and same-day order
// ---------------------------------------------------------------------------

describe("verdict window", () => {
  const halloween = launchRef({ id: "hw", name: "Halloween Studio Drop", kind: "studio_drop", launch_date: "2026-09-18", early_access_date: "2026-09-15", inventory_ready_by: "2026-09-14" });

  it("after the first selling day the verdict is withdrawn: a product that sold through never reads Short", () => {
    const l = supplyLedger(SKU.bw66, 300, halloween, ctx(), TODAY);
    expect(l.total).toBe(0);
    expect(l.verdict).toBeNull();
  });

  it("on the first selling day itself the product is still judged", () => {
    const l = supplyLedger(SKU.bw66, 300, halloween, ctx(), "2026-09-15");
    expect(l.verdict).toMatchObject({ key: "short", shortfall: 300 });
  });

  it("a past launch's rollup counts nothing from supply", () => {
    const member = row({ id: "h1", sku_id: SKU.bw66, limited_qty: 300, product: { sku: "S03-BW20P", product_name: "Halloween BW20P" } });
    const launch = { ...halloween, skus: [member], cards: [] };
    const roll = launchRollup(launchProducts([plain(member)], launch, ctx(), TODAY), launch);
    expect(roll).toMatchObject({ tone: null, text: "1 product", chip: null, counts: { short: 0, misses: 0 } });
  });

  it("same estimated day: a shipment sorts before a factory remainder", () => {
    const l = supplyLedger(SKU.bw20dna, 300, NL, CTX, TODAY);
    expect(l.rows.filter((r) => r.date === "2026-11-09").map((r) => r.kind)).toEqual(["freight", "factory"]);
  });
});
