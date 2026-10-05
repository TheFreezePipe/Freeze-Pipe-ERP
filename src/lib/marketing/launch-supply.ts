/**
 * Launch supply ledger — the one calculation behind the Launches page's
 * product section: for every launch product with a SKU, a dated list of
 * supply (stock first, then each delivery in arrival order, then what is
 * still at the factory) with a running total, the coverage numbers at each
 * milestone, and one verdict. The collapsed launch row, its Status chip and
 * the expanded ledger all read from launchProducts(), so they can never
 * disagree. The layout is the stock/requirements list every planning system
 * uses (SAP MD04, Dynamics net requirements, Oracle supply and demand).
 *
 * Owner decisions (2026-10-05):
 *   - On time means every needed unit is in the building on or before the
 *     first selling day: early access when the launch has one, else the
 *     launch date. The ready-by date is the GOAL, never a verdict — the
 *     Ready by band and the coverage bar shade late arrivals amber, but
 *     nothing is called "late" any more.
 *   - A shipment that has not sailed re-dates to today plus the transit
 *     (35 days sea, 15 air) when its entered ETA can no longer be reached,
 *     shown as an estimate.
 *   - A product with no quantity set is judged against its total supply.
 *   - All stock on hand counts toward the launch; nothing is held back for
 *     regular sales (new products and drops have none yet).
 *   - Every ledger starts closed; a Chart view is offered beside the table.
 *
 * Pure: no hooks, no Date.now(). Dates are date-only ISO slices.
 */
import { humanizeEnum } from "@/lib/utils";
import { WORKBACK, addDaysIso, daysBetween } from "./workback";
import { fmtDay } from "./format-day";
import { launchReadyBy, type PdLaunchRef, type RiskDot } from "./pd";
import {
  isInboundLine,
  launchProductCount,
  memberState,
  memberStockNeed,
  type InboundMap,
  type InboundShipment,
  type LaunchMemberCard,
  type LaunchMemberRow,
  type MemberState,
  type MemberStateLaunch,
} from "./launch-link";

/** Sea transit, the same figure the work-back chain uses. */
export const SEA_TRANSIT_DAYS = WORKBACK.seaTransitDays;
/** Air transit for the re-dating of unsailed air shipments and the factory rows' "air ~" alternative. */
export const AIR_TRANSIT_DAYS = WORKBACK.airTransitDays;

const day = (iso: string | null | undefined): string | null => (iso ? iso.slice(0, 10) : null);
const laterOf = (a: string, b: string): string => (a > b ? a : b);

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

export type Tone = Exclude<RiskDot, null>;

/** Every word the ledger shows (label maps, never raw enum values). */
export const LAUNCH_SUPPLY_LABEL = {
  where: {
    warehouse: "In warehouse",
    factory: "At factory",
    pending: "Not shipped",
    on_the_water: "On the water",
    in_the_air: "In the air",
    high_risk: "High risk",
    cleared_customs: "Customs cleared",
    tracking: "Ground",
    out_for_delivery: "Out for delivery",
    delivered: "On the dock",
  },
  mode: { sea: "Sea", air: "Air" },
  verdict: {
    on_time: "On time",
    misses_ea: "Misses EA",
    misses_launch: "Misses launch",
    short: "Short",
    none: "No supply",
  },
  milestone: { ready: "Ready by", ea: "Early access", launch: "Launch" },
  bucket: { finished: "Finished", prefilled: "Pre-filled", wip: "WIP", raw: "Raw", other: "Other" },
  here: "Here",
  overdue: "Overdue",
  awaitingNumber: "Awaiting #",
  prefilled: "PRE-FILLED",
  remainder: "No supply yet",
  toSpare: "to spare",
  onTheDay: "on the day",
  past: "past",
  pastDue: "Past due",
  allIn: "all in",
  ordered: "ordered",
  shipped: "shipped",
  finished: "finished",
  air: "air",
  missEa: "miss EA",
  missLaunch: "miss launch",
  late: "late",
  tight: "tight",
} as const;

/** Where a shipment's units are, by freight type and status; an air shipment on its way is "In the air". */
export function freightWhereLabel(freightType: string, status: string): string {
  if (status === "on_the_water" && freightType === "air") return LAUNCH_SUPPLY_LABEL.where.in_the_air;
  const known = LAUNCH_SUPPLY_LABEL.where as Readonly<Record<string, string>>;
  return known[status] ?? humanizeEnum(status);
}

/** "Sea" / "Air" for the reference text and the mode tile; unknown types humanized. */
export function freightModeLabel(freightType: string): string {
  return (LAUNCH_SUPPLY_LABEL.mode as Readonly<Record<string, string>>)[freightType] ?? humanizeEnum(freightType);
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** The warehouse buckets of inventory_levels, summed per SKU. */
export interface WarehouseSplit {
  finished: number;
  prefilled: number;
  wip: number;
  raw: number;
  other: number;
}

export const EMPTY_SPLIT: WarehouseSplit = { finished: 0, prefilled: 0, wip: 0, raw: 0, other: 0 };

export type WarehouseLevelRow = {
  sku_id: string;
  warehouse_raw: number | null;
  warehouse_prefilled_raw: number | null;
  warehouse_in_production: number | null;
  warehouse_finished: number | null;
  warehouse_other: number | null;
};

/** sku_id -> its warehouse split, summed over the page's inventory_levels rows (useInventory). */
export function warehouseBySku(levels: readonly WarehouseLevelRow[]): Map<string, WarehouseSplit> {
  const m = new Map<string, WarehouseSplit>();
  for (const inv of levels) {
    const cur = m.get(inv.sku_id) ?? { ...EMPTY_SPLIT };
    cur.finished += inv.warehouse_finished ?? 0;
    cur.prefilled += inv.warehouse_prefilled_raw ?? 0;
    cur.wip += inv.warehouse_in_production ?? 0;
    cur.raw += inv.warehouse_raw ?? 0;
    cur.other += inv.warehouse_other ?? 0;
    m.set(inv.sku_id, cur);
  }
  return m;
}

export const splitTotal = (s: WarehouseSplit): number => s.finished + s.prefilled + s.wip + s.raw + s.other;

/** One factory order item as useLaunchFactorySupply returns it. */
export interface LaunchFactorySupplyItem {
  id: string;
  sku_id: string;
  quantity_ordered: number;
  quantity_finished: number | null;
  quantity_breakage: number;
  quantity_shipped_manual: number;
  quantity_consumed_by_parent: number;
  alternate_expected_completion: string | null;
}

/** An open factory order (status not shipped / canceled) with the items for the page's SKUs. */
export interface LaunchFactorySupplyOrder {
  id: string;
  order_number: string | null;
  status: string;
  expected_completion: string | null;
  items: readonly LaunchFactorySupplyItem[];
}

/** useLaunchFactorySupply's data: the open orders and, per item id, the units already on any freight shipment. */
export interface LaunchFactorySupply {
  orders: readonly LaunchFactorySupplyOrder[];
  shippedByItem: ReadonlyMap<string, number>;
}

export const EMPTY_FACTORY_SUPPLY: LaunchFactorySupply = { orders: [], shippedByItem: new Map() };

/** Factory orders still to be made or collected: not shipped, not canceled. */
export function isOpenSupplyOrder(order: Pick<LaunchFactorySupplyOrder, "status">): boolean {
  return order.status !== "shipped" && order.status !== "canceled";
}

/** What the page hands every ledger: the warehouse, the inbound freight and the open factory orders. */
export interface LaunchSupplyContext {
  warehouse: ReadonlyMap<string, WarehouseSplit>;
  inbound: InboundMap;
  factory: LaunchFactorySupply;
}

/** The launch dates the ledger reads. */
export type LaunchSupplyLaunch = Pick<PdLaunchRef, "launch_date" | "early_access_date" | "inventory_ready_by">;

/** The first selling day: early access when set, else the launch date. Null for an undated launch. */
export function launchSellStart(launch: LaunchSupplyLaunch): string | null {
  return day(launch.early_access_date) ?? day(launch.launch_date);
}

// ---------------------------------------------------------------------------
// Supply rows
// ---------------------------------------------------------------------------

export type SupplyMode = "warehouse" | "sea" | "air" | "factory";

interface SupplyRowBase {
  key: string;
  mode: SupplyMode;
  /** Arrival date (date-only ISO); today for stock and dock rows. */
  date: string;
  estimated: boolean;
  /** In the building (warehouse) or on the dock: counts toward every milestone. */
  here: boolean;
  units: number;
  /** Cartons still to land; null where cartons do not apply or the shipment has no carton group for the SKU. */
  cartons: number | null;
  /** Units in the building once this row has landed (rows in ledger order). */
  runningTotal: number;
  /** Coverage-bar shade only (never a verdict): green by the ready-by goal, amber by the first selling day, red after. */
  tone: Tone;
  /** "In warehouse" / "On the water" / "At factory" … */
  whereLabel: string;
}

export interface WarehouseSupplyRow extends SupplyRowBase {
  kind: "warehouse";
  mode: "warehouse";
  split: WarehouseSplit;
}

export interface FreightSupplyRow extends SupplyRowBase {
  kind: "freight";
  mode: "sea" | "air";
  shipment: InboundShipment;
  /** Units booked on the shipment for the SKU (quantity summed over its lines). */
  quantity: number;
  /** Pre-filled units among them. */
  prefilledUnits: number;
  /** ETA moved since it was first entered: +N later, −N earlier; null when unchanged, unknown or not yet shipped. */
  driftDays: number | null;
  /** Days past its ETA while still in transit (the row re-dates to today, estimated). */
  overdueDays: number;
}

export interface FactorySupplyRow extends SupplyRowBase {
  kind: "factory";
  mode: "factory";
  order: Pick<LaunchFactorySupplyOrder, "id" | "order_number">;
  itemId: string;
  /** The factory due the row counts from (item alternate date, else the order's); null when the order has none. */
  due: string | null;
  /** Arrival if the remainder flew instead of sailing. */
  airAlt: string;
  pastDueDays: number;
  ordered: number;
  /** Units that left the factory: on freight lines sourced from the item plus units shipped outside the system. */
  shipped: number;
  finished: number;
}

export type SupplyRow = WarehouseSupplyRow | FreightSupplyRow | FactorySupplyRow;

// --- warehouse ---------------------------------------------------------------

function warehouseRow(skuId: string, ctx: LaunchSupplyContext, todayIso: string): WarehouseSupplyRow {
  const split = ctx.warehouse.get(skuId) ?? EMPTY_SPLIT;
  return {
    kind: "warehouse",
    key: `wh:${skuId}`,
    mode: "warehouse",
    date: todayIso,
    estimated: false,
    here: true,
    units: splitTotal(split),
    cartons: null,
    runningTotal: 0,
    tone: "g",
    whereLabel: LAUNCH_SUPPLY_LABEL.where.warehouse,
    split,
  };
}

// --- freight -----------------------------------------------------------------

interface Arrival {
  date: string;
  estimated: boolean;
  here: boolean;
  overdueDays: number;
}

/**
 * When a shipment's units land:
 *   delivered (receipt unconfirmed)  today, firm, on the dock — counts like stock
 *   pending (not sailed)             the later of its ETA and today + transit, estimated
 *   in transit, ETA today or later   the ETA, firm
 *   in transit, no ETA               today + transit, estimated
 *   in transit, ETA passed           today, estimated, flagged overdue by the days missed
 */
function freightArrival(shipment: InboundShipment, todayIso: string): Arrival {
  const eta = day(shipment.eta);
  const lead = shipment.freight_type === "air" ? AIR_TRANSIT_DAYS : SEA_TRANSIT_DAYS;
  const byLead = addDaysIso(todayIso, lead);
  if (shipment.status === "delivered") return { date: todayIso, estimated: false, here: true, overdueDays: 0 };
  if (shipment.status === "pending") return { date: laterOf(eta ?? "", byLead), estimated: true, here: false, overdueDays: 0 };
  if (!eta) return { date: byLead, estimated: true, here: false, overdueDays: 0 };
  if (eta < todayIso) return { date: todayIso, estimated: true, here: false, overdueDays: daysBetween(eta, todayIso) };
  return { date: eta, estimated: false, here: false, overdueDays: 0 };
}

/** Cartons of the shipment still to land that carry the SKU; null when no carton group lists it. */
function cartonsFor(shipment: InboundShipment, skuId: string): number | null {
  const groups = shipment.carton_groups.filter((g) => g.skus.some((s) => s.sku_id === skuId));
  if (groups.length === 0) return null;
  return groups.reduce((n, g) => n + Math.max(0, g.carton_qty - g.received_cartons), 0);
}

/** One row per shipment with inbound lines for the SKU (the lines of one shipment summed). */
function freightRows(skuId: string, ctx: LaunchSupplyContext, todayIso: string): FreightSupplyRow[] {
  const byShipment = new Map<string, { shipment: InboundShipment; units: number; quantity: number; prefilled: number }>();
  for (const li of ctx.inbound.get(skuId) ?? []) {
    if (!isInboundLine(li) || !li.shipment) continue;
    const cur = byShipment.get(li.shipment.id) ?? { shipment: li.shipment, units: 0, quantity: 0, prefilled: 0 };
    cur.units += li.quantity - li.quantity_received;
    cur.quantity += li.quantity;
    cur.prefilled += li.quantity_prefilled ?? 0;
    byShipment.set(li.shipment.id, cur);
  }
  const rows: FreightSupplyRow[] = [];
  for (const { shipment, units, quantity, prefilled } of byShipment.values()) {
    const a = freightArrival(shipment, todayIso);
    const eta = day(shipment.eta);
    const original = day(shipment.eta_original);
    rows.push({
      kind: "freight",
      key: `fr:${shipment.id}`,
      mode: shipment.freight_type === "air" ? "air" : "sea",
      date: a.date,
      estimated: a.estimated,
      here: a.here,
      units,
      cartons: cartonsFor(shipment, skuId),
      runningTotal: 0,
      tone: "g",
      whereLabel: freightWhereLabel(shipment.freight_type, shipment.status),
      shipment,
      quantity,
      prefilledUnits: prefilled,
      driftDays: shipment.status !== "pending" && eta && original && eta !== original ? daysBetween(original, eta) : null,
      overdueDays: a.overdueDays,
    });
  }
  return rows;
}

// --- factory -----------------------------------------------------------------

/**
 * Units of an item still at the factory: ordered minus breakage, minus
 * what left on freight (lines sourced from the item, ANY shipment status),
 * minus units shipped outside the system, minus units built into a parent
 * order. This mirrors inventory-aggregates' buildOnOrderMap without its
 * planned-allocation reserve — that reserve holds component SKUs back for
 * a linked parent, and a launch product is the finished good.
 */
export function factoryRemaining(item: LaunchFactorySupplyItem, shippedByItem: ReadonlyMap<string, number>): number {
  const shipped = shippedByItem.get(item.id) ?? 0;
  return Math.max(
    0,
    item.quantity_ordered - item.quantity_breakage - shipped - item.quantity_shipped_manual - item.quantity_consumed_by_parent,
  );
}

/**
 * One row per open order item with units still at the factory. The units
 * sail when the factory finishes (the due date, or today when it has
 * passed) and land SEA_TRANSIT_DAYS later, estimated; airAlt is the
 * AIR_TRANSIT_DAYS alternative.
 */
function factoryRows(skuId: string, ctx: LaunchSupplyContext, todayIso: string): FactorySupplyRow[] {
  const rows: FactorySupplyRow[] = [];
  for (const order of ctx.factory.orders) {
    if (!isOpenSupplyOrder(order)) continue;
    for (const item of order.items) {
      if (item.sku_id !== skuId) continue;
      const units = factoryRemaining(item, ctx.factory.shippedByItem);
      if (units <= 0) continue;
      const due = day(item.alternate_expected_completion) ?? day(order.expected_completion);
      const start = laterOf(due ?? todayIso, todayIso);
      rows.push({
        kind: "factory",
        key: `fo:${item.id}`,
        mode: "factory",
        date: addDaysIso(start, SEA_TRANSIT_DAYS),
        estimated: true,
        here: false,
        units,
        cartons: null,
        runningTotal: 0,
        tone: "g",
        whereLabel: LAUNCH_SUPPLY_LABEL.where.factory,
        order: { id: order.id, order_number: order.order_number },
        itemId: item.id,
        due,
        airAlt: addDaysIso(start, AIR_TRANSIT_DAYS),
        pastDueDays: due && due < todayIso ? daysBetween(due, todayIso) : 0,
        ordered: item.quantity_ordered,
        shipped: (ctx.factory.shippedByItem.get(item.id) ?? 0) + item.quantity_shipped_manual,
        finished: item.quantity_finished ?? 0,
      });
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------

export type AllIn = { kind: "here" } | { kind: "date"; date: string; estimated: boolean };

export type VerdictKey = "none" | "short" | "on_time" | "misses";

export interface Verdict {
  key: VerdictKey;
  tone: Tone;
  /** "On time" / "Misses EA" / "Misses launch" / "Short 150" / "No supply". */
  text: string;
  /** Units missing from the supply (short only). */
  shortfall: number;
}

export type MilestoneKey = "ready" | "ea" | "launch";

/** A milestone band inside the ledger: the units in the building by its date against the basis. */
export interface MilestoneBand {
  key: MilestoneKey;
  label: string;
  date: string;
  have: number;
  basis: number;
  /** Amber for the ready-by goal, red for a selling day; null when the basis is met. */
  tone: "a" | "r" | null;
}

export interface SupplyLedger {
  rows: SupplyRow[];
  /** Units across every row. */
  total: number;
  /** memberStockNeed: limited quantity, else expected units, else null. */
  need: number | null;
  /** What the product is judged against: the need, else the total supply. */
  basis: number;
  /** Units in the building by the first selling day, capped at the basis; 0 for an undated launch, which the table does not show. */
  bySell: number;
  /** Units in the building by the ready-by goal, capped at the basis. */
  byReady: number;
  /** The row at which the running total reaches the basis; null when the supply falls short. */
  allIn: AllIn | null;
  /** Null when the launch has no first selling day. */
  verdict: Verdict | null;
  sellStart: string | null;
  readyBy: string | null;
  bands: MilestoneBand[];
}

/** Units in the building by `date`: stock and dock rows always count. */
export function unitsBy(rows: readonly SupplyRow[], date: string): number {
  return rows.reduce((n, r) => (r.here || r.date <= date ? n + r.units : n), 0);
}

/** Warehouse first, then the dock (stock, then dock, then shipments); then by date, firm before estimated on the same day, then by reference text. */
function compareRows(a: SupplyRow, b: SupplyRow): number {
  return (
    Number(b.kind === "warehouse") - Number(a.kind === "warehouse") ||
    Number(b.here) - Number(a.here) ||
    a.date.localeCompare(b.date) ||
    Number(a.estimated) - Number(b.estimated) ||
    Number(a.kind === "factory") - Number(b.kind === "factory") ||
    referenceText(a).localeCompare(referenceText(b))
  );
}

/** Bar shade for an arrival date: green by the ready-by goal, amber by the first selling day, red after. */
function timingTone(date: string, readyBy: string | null, sellStart: string | null): Tone {
  const goal = readyBy ?? sellStart;
  if (!goal) return "g";
  if (date <= goal) return "g";
  if (sellStart && date <= sellStart) return "a";
  return "r";
}

function verdictOf(total: number, basis: number, bySell: number, hasEa: boolean): Verdict {
  if (total === 0 && basis === 0) return { key: "none", tone: "r", text: LAUNCH_SUPPLY_LABEL.verdict.none, shortfall: 0 };
  if (total < basis) return { key: "short", tone: "r", text: `${LAUNCH_SUPPLY_LABEL.verdict.short} ${fmtUnits(basis - total)}`, shortfall: basis - total };
  // On time: every needed unit in the building on or before the first selling day (inclusive).
  if (bySell >= basis) return { key: "on_time", tone: "g", text: LAUNCH_SUPPLY_LABEL.verdict.on_time, shortfall: 0 };
  return {
    key: "misses",
    tone: "r",
    text: hasEa ? LAUNCH_SUPPLY_LABEL.verdict.misses_ea : LAUNCH_SUPPLY_LABEL.verdict.misses_launch,
    shortfall: 0,
  };
}

/** The milestone bands the ledger shows, in date order: ready-by, early access, launch — only the dates that exist. */
function milestoneBands(launch: LaunchSupplyLaunch, readyBy: string | null, rows: readonly SupplyRow[], basis: number): MilestoneBand[] {
  const dates: { key: MilestoneKey; label: string; date: string | null }[] = [
    { key: "ready", label: LAUNCH_SUPPLY_LABEL.milestone.ready, date: readyBy },
    { key: "ea", label: LAUNCH_SUPPLY_LABEL.milestone.ea, date: day(launch.early_access_date) },
    { key: "launch", label: LAUNCH_SUPPLY_LABEL.milestone.launch, date: day(launch.launch_date) },
  ];
  const bands: MilestoneBand[] = [];
  for (const m of dates) {
    if (!m.date) continue;
    const have = Math.min(unitsBy(rows, m.date), basis);
    // The ready-by goal reads amber when missed; the selling days read red.
    const tone = have < basis ? (m.key === "ready" ? "a" : "r") : null;
    bands.push({ key: m.key, label: m.label, date: m.date, have, basis, tone });
  }
  return bands;
}

/** The ledger for one SKU on a launch. `need` is memberStockNeed(row); null means judge against the total supply. */
export function supplyLedger(
  skuId: string,
  need: number | null,
  launch: LaunchSupplyLaunch,
  ctx: LaunchSupplyContext,
  todayIso: string,
): SupplyLedger {
  const sellStart = launchSellStart(launch);
  const readyBy = launchReadyBy(launch);
  const rows: SupplyRow[] = [warehouseRow(skuId, ctx, todayIso), ...freightRows(skuId, ctx, todayIso), ...factoryRows(skuId, ctx, todayIso)];
  rows.sort(compareRows);

  let run = 0;
  for (const r of rows) {
    run += r.units;
    r.runningTotal = run;
    r.tone = r.here ? "g" : timingTone(r.date, readyBy, sellStart);
  }
  const total = run;
  const basis = need ?? total;
  const bySell = sellStart ? Math.min(unitsBy(rows, sellStart), basis) : 0;
  const byReady = readyBy ? Math.min(unitsBy(rows, readyBy), basis) : 0;

  let allIn: AllIn | null = null;
  if (total >= basis && basis > 0) {
    const row = rows.find((r) => r.runningTotal >= basis)!;
    allIn = row.here && !row.estimated && row.date === todayIso ? { kind: "here" } : { kind: "date", date: row.date, estimated: row.estimated };
  }

  return {
    rows,
    total,
    need,
    basis,
    bySell,
    byReady,
    allIn,
    // Judged only up to the first selling day: after it the question is history, and a product
    // that sold through must not read Short.
    verdict: sellStart && todayIso <= sellStart ? verdictOf(total, basis, bySell, !!day(launch.early_access_date)) : null,
    sellStart,
    readyBy,
    bands: milestoneBands(launch, readyBy, rows, basis),
  };
}

// ---------------------------------------------------------------------------
// Ledger lines (rows, bands and the remainder, in display order)
// ---------------------------------------------------------------------------

export type LedgerLine =
  | { kind: "row"; row: SupplyRow }
  | { kind: "band"; band: MilestoneBand }
  | { kind: "remainder"; units: number };

/**
 * The table's lines: each band sits after the last row dated on or before
 * it; bands dated today or earlier sit under the last row already here
 * (the warehouse and any dock rows, whose units they count); bands no row
 * reaches follow the last row. When the supply falls short, a remainder
 * line closes the list with the missing units.
 */
export function ledgerLines(ledger: SupplyLedger, todayIso: string): LedgerLine[] {
  const out: LedgerLine[] = [];
  const pending = [...ledger.bands];
  const placeUpTo = (date: string, inclusive: boolean) => {
    for (const band of [...pending]) {
      if (inclusive ? band.date <= date : band.date < date) {
        out.push({ kind: "band", band });
        pending.splice(pending.indexOf(band), 1);
      }
    }
  };
  // Here rows lead the ledger (compareRows), so the last one closes the block the passed bands follow.
  const lastHere = ledger.rows.reduce((i, r, k) => (r.here ? k : i), -1);
  ledger.rows.forEach((row, i) => {
    if (!row.here) placeUpTo(row.date, false);
    out.push({ kind: "row", row });
    if (i === lastHere) placeUpTo(todayIso, true);
  });
  placeUpTo("9999-12-31", true);
  if (ledger.total < ledger.basis) out.push({ kind: "remainder", units: ledger.basis - ledger.total });
  return out;
}

// ---------------------------------------------------------------------------
// Launch products + rollup
// ---------------------------------------------------------------------------

/** launch-members' LaunchMemberItem, as this module reads it. */
export type LaunchProductItem<C extends LaunchMemberCard, M extends LaunchMemberRow> =
  | { kind: "card"; key: string; card: C; row: M | null }
  | { kind: "plain"; key: string; sku: string | null; name: string; row: M };

/** The launch as launchProducts reads it: its dates, its cards and its member rows (use-marketing's MktLaunchWithMembers fits). */
export type LaunchProductsLaunch = MemberStateLaunch & { skus: readonly Pick<LaunchMemberRow, "pd_project_id">[] };

export interface LaunchProduct<C extends LaunchMemberCard = LaunchMemberCard> {
  key: string;
  /** The product code, when the row or card carries one. */
  sku: string | null;
  skuId: string | null;
  name: string;
  card: C | null;
  row: LaunchMemberRow;
  /** Rows with a SKU: the supply ledger. */
  ledger: SupplyLedger | null;
  /** Card rows without a SKU (still in development): memberState's reading — stage, next deadline, risk dot. */
  development: MemberState | null;
}

/**
 * One product per launch item (launchMemberItems: member rows minus halted
 * cards, arrived cards kept), with its supply ledger when it has a SKU
 * (row.sku_id, else the card's linked SKU) or its development reading when
 * it does not. The launch row and the expanded table both read this array.
 */
export function launchProducts<C extends LaunchMemberCard, M extends LaunchMemberRow>(
  items: readonly LaunchProductItem<C, M>[],
  launch: LaunchProductsLaunch,
  ctx: LaunchSupplyContext,
  todayIso: string,
): LaunchProduct<C>[] {
  return items.map((it) => {
    const card = it.kind === "card" ? it.card : null;
    // A live card without a member row (should not happen) reads through a row built from the card.
    const row: LaunchMemberRow =
      it.kind === "card"
        ? it.row ?? { id: it.card.id, sku_id: it.card.linked_sku_id ?? null, planned_name: it.card.name, pd_project_id: it.card.id }
        : it.row;
    const skuId = row.sku_id ?? card?.linked_sku_id ?? null;
    const sku = it.kind === "card" ? it.row?.product?.sku ?? it.card.linked_sku?.sku ?? null : it.sku;
    const name = it.kind === "card" ? it.card.name : it.name;
    return {
      key: it.key,
      sku,
      skuId,
      name,
      card,
      row,
      ledger: skuId ? supplyLedger(skuId, memberStockNeed(row), launch, ctx, todayIso) : null,
      development: !skuId && card ? memberState(row, launch, todayIso) : null,
    };
  });
}

export interface LaunchRollup {
  /** Worst reading: red for a short / missing product or a late development row, amber for a tight one, green when rated, null when nothing is. */
  tone: RiskDot;
  /** "3 products · 2 miss EA", "4 products · 1 short · 1 late"; "no products" when the launch has none. */
  text: string;
  /** The Status chip for an upcoming launch; null when no product has a SKU or the launch has no selling day. */
  chip: { tone: Tone; text: string } | null;
  counts: { short: number; misses: number; late: number; tight: number };
}

const latestAllIn = (ledgers: readonly SupplyLedger[]): Extract<AllIn, { kind: "date" }> | null => {
  let best: Extract<AllIn, { kind: "date" }> | null = null;
  for (const l of ledgers) {
    if (!l.allIn || l.allIn.kind !== "date") continue;
    if (!best || l.allIn.date > best.date) best = l.allIn;
  }
  return best;
};

/**
 * The collapsed launch row's mark, words and Status chip from its products.
 * Chip precedence: short / no supply, then misses, then on time — a launch
 * is only as ready as its least-covered product.
 */
export function launchRollup(products: readonly LaunchProduct[], launch: LaunchProductsLaunch): LaunchRollup {
  const ledgers = products.map((p) => p.ledger).filter((l): l is SupplyLedger => !!l);
  const verdicts = ledgers.map((l) => l.verdict).filter((v): v is Verdict => !!v);
  const dev = products.map((p) => p.development).filter((d): d is MemberState => !!d);

  const counts = {
    short: verdicts.filter((v) => v.key === "short" || v.key === "none").length,
    misses: verdicts.filter((v) => v.key === "misses").length,
    late: dev.filter((d) => d.risk === "r").length,
    tight: dev.filter((d) => d.risk === "a").length,
  };
  const rated = verdicts.length > 0 || dev.some((d) => d.risk != null);
  const tone: RiskDot = counts.short + counts.misses + counts.late > 0 ? "r" : counts.tight > 0 ? "a" : rated ? "g" : null;

  const count = launchProductCount(launch);
  const hasEa = !!day(launch.early_access_date);
  const parts = count === 0 ? ["no products"] : [`${count} ${count === 1 ? "product" : "products"}`];
  if (counts.short) parts.push(`${counts.short} ${LAUNCH_SUPPLY_LABEL.verdict.short.toLowerCase()}`);
  if (counts.misses) parts.push(`${counts.misses} ${hasEa ? LAUNCH_SUPPLY_LABEL.missEa : LAUNCH_SUPPLY_LABEL.missLaunch}`);
  if (counts.late) parts.push(`${counts.late} ${LAUNCH_SUPPLY_LABEL.late}`);
  if (counts.tight) parts.push(`${counts.tight} ${LAUNCH_SUPPLY_LABEL.tight}`);

  let chip: LaunchRollup["chip"] = null;
  if (verdicts.length > 0) {
    if (counts.short > 0) {
      const n = verdicts.reduce((s, v) => s + v.shortfall, 0);
      chip = { tone: "r", text: n > 0 ? `${LAUNCH_SUPPLY_LABEL.verdict.short} ${fmtUnits(n)}` : LAUNCH_SUPPLY_LABEL.verdict.none };
    } else if (counts.misses > 0) {
      const word = hasEa ? LAUNCH_SUPPLY_LABEL.verdict.misses_ea : LAUNCH_SUPPLY_LABEL.verdict.misses_launch;
      const latest = latestAllIn(ledgers.filter((l) => l.verdict?.key === "misses"));
      chip = { tone: "r", text: latest ? `${word} · ${allInText(latest)}` : word };
    } else {
      const latest = latestAllIn(ledgers);
      chip = {
        tone: "g",
        text: latest ? `${LAUNCH_SUPPLY_LABEL.verdict.on_time} · ${LAUNCH_SUPPLY_LABEL.allIn} ${allInText(latest)}` : LAUNCH_SUPPLY_LABEL.verdict.on_time,
      };
    }
  }

  return { tone, text: parts.join(" · "), chip, counts };
}

// ---------------------------------------------------------------------------
// Words for the cells (the components hold no math)
// ---------------------------------------------------------------------------

/** "1,250" — units, grouped. */
export function fmtUnits(n: number): string {
  return n.toLocaleString("en-US");
}

/** "Here" / "Oct 24" / "~Nov 9"; "—" when the supply never reaches the basis. */
export function allInText(allIn: AllIn | null): string {
  if (!allIn) return "—";
  if (allIn.kind === "here") return LAUNCH_SUPPLY_LABEL.here;
  return `${allIn.estimated ? "~" : ""}${fmtDay(allIn.date)}`;
}

/** The Arrives cell: "Here" / "Oct 12 · 7d" / "~Nov 9 · ~35d" / "Overdue 4d". */
export function arrivesText(row: SupplyRow, todayIso: string): string {
  if (row.here) return LAUNCH_SUPPLY_LABEL.here;
  if (row.kind === "freight" && row.overdueDays > 0) return `${LAUNCH_SUPPLY_LABEL.overdue} ${row.overdueDays}d`;
  const t = row.estimated ? "~" : "";
  return `${t}${fmtDay(row.date)} · ${t}${daysBetween(todayIso, row.date)}d`;
}

/** The drift chip beside the arrival: "+7d" when the ETA slipped, "−2d" when it came forward; null otherwise. */
export function driftText(row: SupplyRow): string | null {
  if (row.kind !== "freight" || row.driftDays == null) return null;
  return row.driftDays > 0 ? `+${row.driftDays}d` : `−${-row.driftDays}d`;
}

/** The factory row's second line: "air ~Oct 20". */
export function airAltText(row: SupplyRow): string | null {
  return row.kind === "factory" ? `${LAUNCH_SUPPLY_LABEL.air} ~${fmtDay(row.airAlt)}` : null;
}

/** Days from the first selling day to the row's arrival (positive = past it); null for stock / dock rows or an undated launch. */
export function slackDays(row: SupplyRow, sellStart: string | null): number | null {
  if (row.here || !sellStart) return null;
  return daysBetween(sellStart, row.date);
}

/** The vs EA / vs Launch cell: "12d to spare" / "on the day" / "3d past"; "—" when not judged. */
export function slackText(days: number | null): string {
  if (days == null) return "—";
  if (days === 0) return LAUNCH_SUPPLY_LABEL.onTheDay;
  return days < 0 ? `${-days}d ${LAUNCH_SUPPLY_LABEL.toSpare}` : `${days}d ${LAUNCH_SUPPLY_LABEL.past}`;
}

/** The factory row's red second line: "Past due 8d"; null when the due has not passed. */
export function pastDueText(row: SupplyRow): string | null {
  return row.kind === "factory" && row.pastDueDays > 0 ? `${LAUNCH_SUPPLY_LABEL.pastDue} ${row.pastDueDays}d` : null;
}

/** The non-zero warehouse buckets in order: Finished, Pre-filled, WIP, Raw, Other. */
export function warehouseSplitParts(split: WarehouseSplit): { label: string; units: number }[] {
  return (
    [
      [LAUNCH_SUPPLY_LABEL.bucket.finished, split.finished],
      [LAUNCH_SUPPLY_LABEL.bucket.prefilled, split.prefilled],
      [LAUNCH_SUPPLY_LABEL.bucket.wip, split.wip],
      [LAUNCH_SUPPLY_LABEL.bucket.raw, split.raw],
      [LAUNCH_SUPPLY_LABEL.bucket.other, split.other],
    ] as const
  )
    .filter(([, n]) => n > 0)
    .map(([label, units]) => ({ label, units }));
}

/** "Finished 18 · WIP 48 · Raw 234"; "—" when the warehouse holds nothing. */
export function warehouseSplitText(split: WarehouseSplit): string {
  const parts = warehouseSplitParts(split);
  return parts.length ? parts.map((p) => `${p.label} ${fmtUnits(p.units)}`).join(" · ") : "—";
}

/** The pre-filled tag on a freight row: "PRE-FILLED" when the whole booking is, "40 PRE-FILLED" for part of it; null when none. */
export function prefilledText(row: SupplyRow): string | null {
  if (row.kind !== "freight" || row.prefilledUnits <= 0) return null;
  return row.prefilledUnits >= row.quantity ? LAUNCH_SUPPLY_LABEL.prefilled : `${fmtUnits(row.prefilledUnits)} ${LAUNCH_SUPPLY_LABEL.prefilled}`;
}

/** The linked part of a reference: "Sea 476" / "Air AIR-268" / the order number ("Awaiting #" when none); null for the warehouse row. */
export function referenceLabel(row: SupplyRow): string | null {
  if (row.kind === "freight") return `${freightModeLabel(row.shipment.freight_type)} ${row.shipment.shipment_number}`;
  if (row.kind === "factory") return row.order.order_number ?? LAUNCH_SUPPLY_LABEL.awaitingNumber;
  return null;
}

/** Where a reference links: the shipment or the factory order; null for the warehouse row. */
export function referenceHref(row: SupplyRow): string | null {
  if (row.kind === "freight") return `/freight/${row.shipment.id}`;
  if (row.kind === "factory") return `/inventory/factory-orders/${row.order.id}`;
  return null;
}

/** The whole Reference cell as text: "Sea 476 · FedEx", "AS082726BW", "Finished 18 · WIP 48 · Raw 234". */
export function referenceText(row: SupplyRow): string {
  if (row.kind === "warehouse") return warehouseSplitText(row.split);
  const label = referenceLabel(row)!;
  if (row.kind === "freight" && row.shipment.carrier_name) return `${label} · ${row.shipment.carrier_name}`;
  return label;
}

/** The factory row's muted sub-line: "300 ordered · 277 shipped" (+ " · 20 finished" when any are). */
export function factorySubText(row: FactorySupplyRow): string {
  const parts = [`${fmtUnits(row.ordered)} ${LAUNCH_SUPPLY_LABEL.ordered}`, `${fmtUnits(row.shipped)} ${LAUNCH_SUPPLY_LABEL.shipped}`];
  if (row.finished > 0) parts.push(`${fmtUnits(row.finished)} ${LAUNCH_SUPPLY_LABEL.finished}`);
  return parts.join(" · ");
}

/** A coverage-bar segment's title: "Sea 476 · 270 · Oct 12", "In warehouse · 300 · here", "Factory AS082726BW · 23 · ~Nov 9". */
export function coverageTitle(row: SupplyRow): string {
  const what =
    row.kind === "warehouse"
      ? LAUNCH_SUPPLY_LABEL.where.warehouse
      : row.kind === "factory"
        ? `Factory ${referenceLabel(row)}`
        : referenceLabel(row)!;
  const when = row.here ? "here" : `${row.estimated ? "~" : ""}${fmtDay(row.date)}`;
  return `${what} · ${fmtUnits(row.units)} · ${when}`;
}

/** A band's words: "Ready by Oct 20" and "2 of 300". */
export function bandText(band: MilestoneBand): { label: string; count: string } {
  return { label: `${band.label} ${fmtDay(band.date)}`, count: `${fmtUnits(band.have)} of ${fmtUnits(band.basis)}` };
}

/** The product row's coverage numbers: "300 / 300". */
export function coverageText(ledger: SupplyLedger): string {
  return `${fmtUnits(ledger.bySell)} / ${fmtUnits(ledger.basis)}`;
}
