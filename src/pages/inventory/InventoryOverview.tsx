import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { differenceInDays, format, formatDistanceToNow, parseISO } from "date-fns";
import {
  AlertCircle,
  AlertTriangle,
  ArrowDownToLine,
  ClipboardCheck,
  ListChecks,
  MapPin,
  PackageCheck,
  PackageSearch,
  Plus,
  Scale,
  Ship,
  TrendingDown,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { StatCard } from "@/components/shared/StatCard";
import { NewFactoryOrderDialog } from "@/components/manufacturing/NewFactoryOrderDialog";
import { OverviewPanel, PhaseCard } from "@/components/inventory/overview/OverviewCards";
import { StockStrip, type StockStages } from "@/components/inventory/overview/StockStrip";
import { ShippingBaseline } from "@/components/inventory/overview/ShippingBaseline";
import {
  ArrivingList,
  IssuesList,
  MaterialsLowList,
  ReceivingList,
  RunningLowList,
  type IssueRow,
  type MaterialRow,
  type RunningLowRow,
  type ShipmentRow,
} from "@/components/inventory/overview/OverviewLists";
import {
  useAllRecipes,
  useBreakageReports,
  useFactoryOrders,
  useFreightLineItems,
  useFreightShipments,
  useForecastDemandMap,
  useInventory,
  useMaterials,
  useMaterialUsageRates,
  useProductBoms,
  useShipmentVariances,
  useSuppliers,
  useWhOverview,
  useWhPutawayQueue,
  type FreightLineItemWithProduct,
} from "@/lib/hooks";
import { useWhCountTasks } from "@/lib/hooks/use-warehouse-counts";
import { buildInTransitMap, buildOnOrderMap, inventoryTotalsReal } from "@/lib/inventory-aggregates";
import { buildPlannedAllocationMap } from "@/lib/allocation";
import { computeDOS, NO_DEMAND_DOS } from "@/lib/inventory-math";
import { getEffectiveDemand } from "@/lib/demand";
import { productLifecycle } from "@/lib/product-lifecycle";
import { isReceivingActive } from "@/lib/freight/receiving";
import { computeAllMaterialRunways } from "@/lib/materials/runway";
import { INVENTORY_ROUTES, stockView } from "@/lib/inventory-routes";
import { cn, humanizeEnum } from "@/lib/utils";
import type { FreightShipment } from "@/types/database";

/** Warehouse days of supply under which a SKU counts as running low. */
const RUNNING_LOW_DAYS = 14;
/** ETA window for "Arriving this week" (the Dashboard alert's window). */
const ARRIVING_DAYS = 7;
const RUNNING_LOW_ROWS = 6;
const ARRIVING_ROWS = 5;
const ISSUE_ROWS = 4;

const isOpenIssue = (status: string) => status !== "resolved" && status !== "written_off";

/** Stock › Counts on a given tab. */
const countsTab = (tab: string) => `${stockView("counts")}&tab=${tab}`;

/** Below Tailwind's md breakpoint the putaway card opens the phone screen. */
function isPhone(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches;
}

interface LastReconcile {
  run_at?: string;
  mismatched_skus?: number;
  abs_residual_units?: number;
}

/**
 * Inventory Overview (`/inventory`): the work waiting today above one stock
 * strip, built only on data the database has now. The warehouse cards read
 * the putaway queue, the count tasks and rpc_wh_overview (variances,
 * unlocated units, the latest reconcile); low pick faces wait for Phase 2.
 * Design: docs/design/INVENTORY_MODULE_IA.md.
 */
export default function InventoryOverview() {
  const navigate = useNavigate();
  const [newOrderOpen, setNewOrderOpen] = useState(false);

  const { data: inventory = [], isLoading: inventoryLoading } = useInventory();
  const { data: freight = [], isLoading: freightLoading, isError: freightError } = useFreightShipments();
  const { data: lines = [], isLoading: linesLoading } = useFreightLineItems();
  const { data: factoryOrders = [] } = useFactoryOrders();
  const { data: boms = [] } = useProductBoms();
  const forecastMap = useForecastDemandMap();
  const { data: suppliers = [] } = useSuppliers();
  const breakageQ = useBreakageReports();
  const variancesQ = useShipmentVariances();
  const { data: materials = [], isLoading: materialsLoading, isError: materialsError } = useMaterials();
  const { data: allRecipes = [] } = useAllRecipes();
  const { data: usageRates } = useMaterialUsageRates();
  const putawayQ = useWhPutawayQueue();
  const liveCountsQ = useWhCountTasks(["open", "counting"]);
  const whOverviewQ = useWhOverview();
  const whOverview = whOverviewQ.data;
  const lastReconcile = (whOverview?.last_reconcile ?? null) as LastReconcile | null;

  const supplierName = useMemo(() => new Map(suppliers.map((s) => [s.id, s.name])), [suppliers]);

  // ---- Stock: the Stock page's math (inventoryTotalsReal over the live
  // in-transit / on-order maps, warehouse DOS on effective demand). ----
  const stock = useMemo(() => {
    const inTransitMap = buildInTransitMap(freight, lines);
    const onOrderMap = buildOnOrderMap(factoryOrders, lines, buildPlannedAllocationMap(factoryOrders, boms));
    const stages: StockStages = { raw: 0, prefilled: 0, inProduction: 0, finished: 0, other: 0, inTransit: 0, onOrder: 0 };
    const withDemand: RunningLowRow[] = [];
    let activeSkus = 0;
    for (const inv of inventory) {
      const totals = inventoryTotalsReal(inv, inTransitMap, onOrderMap);
      stages.raw += inv.warehouse_raw ?? 0;
      stages.prefilled += inv.warehouse_prefilled_raw ?? 0;
      stages.inProduction += inv.warehouse_in_production ?? 0;
      stages.finished += inv.warehouse_finished ?? 0;
      stages.other += inv.warehouse_other ?? 0;
      stages.inTransit += totals.transitTotal;
      stages.onOrder += totals.onOrderTotal;

      const product = inv.product;
      // Live catalog only, as on the Dashboard alerts and the daily email.
      if (!product || productLifecycle(product) !== "active") continue;
      activeSkus += 1;
      const dos = computeDOS(totals.warehouseTotal, getEffectiveDemand(product.id, product.monthly_demand, forecastMap));
      if (dos === NO_DEMAND_DOS) continue;
      withDemand.push({
        id: product.id,
        sku: product.sku,
        name: product.product_name,
        finished: inv.warehouse_finished ?? 0,
        dos,
        inTransit: totals.transitTotal,
        onOrder: totals.onOrderTotal,
      });
    }
    withDemand.sort((a, b) => a.dos - b.dos);
    return {
      stages,
      activeSkus,
      runningLowCount: withDemand.filter((r) => r.dos < RUNNING_LOW_DAYS).length,
      runningLow: withDemand.slice(0, RUNNING_LOW_ROWS),
    };
  }, [inventory, freight, lines, factoryOrders, boms, forecastMap]);

  // ---- Shipments: the Shipments page's receiving rule and the Dashboard
  // alert's 7-day arrival window. ----
  const shipments = useMemo(() => {
    const linesByShipment = new Map<string, FreightLineItemWithProduct[]>();
    for (const li of lines) {
      const arr = linesByShipment.get(li.freight_shipment_id);
      if (arr) arr.push(li);
      else linesByShipment.set(li.freight_shipment_id, [li]);
    }
    const toRow = (shipment: FreightShipment): ShipmentRow => {
      const own = linesByShipment.get(shipment.id) ?? [];
      return {
        shipment,
        supplier: shipment.origin_supplier_id ? supplierName.get(shipment.origin_supplier_id) ?? null : null,
        units: own.reduce((s, l) => s + (l.quantity ?? 0), 0),
        received: own.reduce((s, l) => s + (l.quantity_received ?? 0), 0),
      };
    };

    const now = new Date();
    const open = freight.filter((f) => f.status !== "delivered");
    const receiving = freight.filter((f) => isReceivingActive(f, linesByShipment.get(f.id) ?? [])).map(toRow);
    const receivingIds = new Set(receiving.map((r) => r.shipment.id));
    const thisWeek = open
      .filter((f) => {
        if (!f.eta) return false;
        const daysLeft = differenceInDays(parseISO(f.eta), now);
        return daysLeft >= 0 && daysLeft <= ARRIVING_DAYS;
      })
      .map(toRow)
      .sort((a, b) => (a.shipment.eta ?? "").localeCompare(b.shipment.eta ?? ""));
    const highRisk = open.filter((f) => f.status === "high_risk");
    const highRiskIds = new Set(highRisk.map((f) => f.id));
    const retailAtRisk = lines
      .filter((li) => highRiskIds.has(li.freight_shipment_id))
      .reduce((s, li) => s + (li.retail_value ?? 0) * li.quantity, 0);
    // Still on the way: not on the dock yet (those sit under Receiving), by
    // ETA with undated shipments last.
    const arriving = open
      .filter((f) => !receivingIds.has(f.id))
      .sort((a, b) => (a.eta ?? "9999-99-99").localeCompare(b.eta ?? "9999-99-99"))
      .slice(0, ARRIVING_ROWS)
      .map(toRow);
    return { receiving, thisWeek, highRiskCount: highRisk.length, retailAtRisk, arriving };
  }, [freight, lines, supplierName]);

  // ---- Issues: open breakage reports and variances, as on Quality Issues. ----
  const issues = useMemo(() => {
    const skuCode = new Map(inventory.map((inv) => [inv.sku_id, inv.product?.sku ?? null]));
    const openBreakage = (breakageQ.data ?? []).filter((r) => isOpenIssue(r.status));
    const openVariances = (variancesQ.data ?? []).filter((v) => isOpenIssue(v.status));
    const rows: IssueRow[] = [
      ...openBreakage.map((r) => ({
        id: r.id,
        kind: "breakage" as const,
        createdAt: r.created_at,
        title: `${r.quantity_broken.toLocaleString()} broken · ${humanizeEnum(r.reason_category).toLowerCase()}`,
        sku: skuCode.get(r.sku_id) ?? null,
        supplier: supplierName.get(r.producing_supplier_id) ?? null,
        status: r.status,
      })),
      ...openVariances.map((v) => ({
        id: v.id,
        kind: "variance" as const,
        createdAt: v.created_at,
        title: `${humanizeEnum(v.variance_type)} · ${v.variance_quantity > 0 ? "+" : ""}${v.variance_quantity.toLocaleString()}`,
        sku: skuCode.get(v.sku_id) ?? null,
        supplier: supplierName.get(v.origin_supplier_id) ?? null,
        status: v.status,
      })),
    ].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { breakage: openBreakage.length, variances: openVariances.length, total: rows.length, latest: rows.slice(0, ISSUE_ROWS) };
  }, [breakageQ.data, variancesQ.data, inventory, supplierName]);
  const issuesLoading = breakageQ.isLoading || variancesQ.isLoading;

  // ---- Materials below reorder point (the Materials page's rule), with the
  // Materials page's runway from the same inputs. ----
  const materialsLow = useMemo<MaterialRow[]>(() => {
    const runways = computeAllMaterialRunways({
      materials,
      allRecipes,
      usageRateByMaterial: usageRates,
      fillableInventory: inventory
        .filter((inv) => inv.product?.category === "fillable")
        .map((inv) => ({
          product: { id: inv.product.id, category: inv.product.category, monthly_demand: inv.product.monthly_demand },
          inventory: {
            warehouse_raw: inv.warehouse_raw,
            warehouse_prefilled_raw: inv.warehouse_prefilled_raw,
            warehouse_in_production: inv.warehouse_in_production,
          },
        })),
    });
    return materials
      .filter((m) => m.reorder_point_qty != null && (m.inventory?.on_hand_qty ?? 0) < m.reorder_point_qty)
      .map((m) => ({
        id: m.id,
        code: m.code,
        name: m.name,
        onHand: m.inventory?.on_hand_qty ?? 0,
        unit: m.unit_of_measure,
        reorderAt: m.reorder_point_qty ?? 0,
        runwayDays: runways.get(m.id)?.currentRunwayDays ?? null,
      }))
      .sort((a, b) => (a.runwayDays ?? Infinity) - (b.runwayDays ?? Infinity));
  }, [materials, allRecipes, usageRates, inventory]);

  const shipmentsLoading = freightLoading || linesLoading;
  const nextArrival = shipments.thisWeek[0];
  const dash = (n: number, loading: boolean) => (loading ? "—" : n);
  // No subtitle while loading, so an empty state never flashes as a fact.
  const sub = (text: string, loading: boolean) => (loading ? undefined : text);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Inventory</h1>
          <p className="text-muted-foreground">What is coming, what is on the dock, and what needs attention</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => navigate(INVENTORY_ROUTES.newShipment)}>
            <Ship className="mr-2 h-4 w-4" />
            New shipment
          </Button>
          <Button onClick={() => setNewOrderOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            New factory order
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          title="Arriving this week"
          value={dash(shipments.thisWeek.length, shipmentsLoading)}
          subtitle={sub(
            nextArrival?.shipment.eta
              ? `Next: ${nextArrival.shipment.shipment_number} · ${format(parseISO(nextArrival.shipment.eta), "EEE MMM d")}`
              : `Nothing due in ${ARRIVING_DAYS} days`,
            shipmentsLoading,
          )}
          icon={Ship}
          iconColor="text-blue-400"
          onClick={() => navigate(INVENTORY_ROUTES.shipments)}
        />
        <StatCard
          title="On the dock"
          value={dash(shipments.receiving.length, shipmentsLoading)}
          subtitle={sub(
            shipments.receiving.length > 0
              ? `To check in: ${shipments.receiving.map((r) => r.shipment.shipment_number).slice(0, 3).join(", ")}`
              : "Nothing to check in",
            shipmentsLoading,
          )}
          icon={PackageCheck}
          iconColor="text-amber-400"
          onClick={() => navigate(`${INVENTORY_ROUTES.shipments}?filter=receiving`)}
        />
        <StatCard
          title="High risk"
          value={dash(shipments.highRiskCount, shipmentsLoading)}
          subtitle={sub(
            shipments.highRiskCount > 0
              ? `$${Math.round(shipments.retailAtRisk).toLocaleString()} retail at risk`
              : "No shipments under inspection",
            shipmentsLoading,
          )}
          icon={AlertTriangle}
          iconColor="text-red-400"
          onClick={() => navigate(`${INVENTORY_ROUTES.shipments}?filter=high_risk`)}
        />
        <StatCard
          title="Running low"
          value={dash(stock.runningLowCount, inventoryLoading)}
          subtitle={`Active SKUs under ${RUNNING_LOW_DAYS} days in the warehouse`}
          icon={TrendingDown}
          iconColor="text-orange-400"
          onClick={() => navigate(INVENTORY_ROUTES.stock)}
        />
        <StatCard
          title="Issues"
          value={dash(issues.total, issuesLoading)}
          subtitle={sub(
            `${issues.breakage} breakage · ${issues.variances} variance${issues.variances === 1 ? "" : "s"}`,
            issuesLoading,
          )}
          icon={AlertCircle}
          iconColor="text-red-400"
          onClick={() => navigate(INVENTORY_ROUTES.issues)}
        />
        <StatCard
          title="To put away"
          value={dash(putawayQ.data?.length ?? 0, putawayQ.isLoading)}
          subtitle={sub(
            whOverview && (whOverview.rts_unplaced > 0 || whOverview.putaways_over_24h > 0)
              ? [
                  whOverview.rts_unplaced > 0 ? `${whOverview.rts_unplaced} green RTS` : null,
                  whOverview.putaways_over_24h > 0 ? `${whOverview.putaways_over_24h} over 24 h` : null,
                ]
                  .filter(Boolean)
                  .join(" · ")
              : (putawayQ.data?.length ?? 0) > 0
                ? "Cartons waiting for a bay"
                : "Nothing waiting for a bay",
            putawayQ.isLoading,
          )}
          icon={ArrowDownToLine}
          iconColor="text-cyan-400"
          onClick={() => navigate(isPhone() ? "/go/putaway" : `${INVENTORY_ROUTES.shipments}?filter=receiving`)}
        />
        <StatCard
          title="Counts due"
          value={dash(liveCountsQ.data?.length ?? 0, liveCountsQ.isLoading)}
          subtitle={sub(
            whOverview ? `${whOverview.counts_due} due by today · open or counting` : "Open or counting",
            liveCountsQ.isLoading,
          )}
          icon={ClipboardCheck}
          iconColor="text-blue-400"
          onClick={() => navigate(countsTab("tasks"))}
        />
        <PhaseCard title="Low pick faces" subtitle="Faces below their minimum" icon={MapPin} phase="Phase 2" />
        <StatCard
          title="Variances to approve"
          value={dash(whOverview?.variances ?? 0, whOverviewQ.isLoading)}
          subtitle={sub(
            (whOverview?.variances ?? 0) > 0 ? "Submitted counts that differ" : "No count waiting for approval",
            whOverviewQ.isLoading,
          )}
          icon={ListChecks}
          iconColor="text-amber-400"
          onClick={() => navigate(countsTab("variances"))}
        />
        <StatCard
          title="Unlocated"
          value={whOverviewQ.isLoading ? "—" : whOverview ? whOverview.unlocated_units.toLocaleString() : "—"}
          subtitle={sub(
            whOverview
              ? whOverview.unlocated_units !== 0
                ? "Net units at UNLOCATED, waiting for a home"
                : "Nothing without a location"
              : "No warehouse data",
            whOverviewQ.isLoading,
          )}
          icon={PackageSearch}
          iconColor="text-orange-400"
          onClick={() => navigate(countsTab("reconcile"))}
        />
        <StatCard
          title="Off-by SKUs"
          value={whOverviewQ.isLoading ? "—" : lastReconcile ? (lastReconcile.mismatched_skus ?? 0) : "—"}
          subtitle={sub(
            lastReconcile?.run_at
              ? `Σ ${(lastReconcile.abs_residual_units ?? 0).toLocaleString()} units · reconciled ${formatDistanceToNow(parseISO(lastReconcile.run_at), { addSuffix: true })}`
              : "No reconcile run yet",
            whOverviewQ.isLoading,
          )}
          icon={Scale}
          iconColor="text-red-400"
          onClick={() => navigate(countsTab("reconcile"))}
        />
      </div>

      <StockStrip stages={stock.stages} activeSkus={stock.activeSkus} loading={inventoryLoading || shipmentsLoading} />

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="min-w-0 space-y-4">
          <OverviewPanel
            title="Running low"
            linkTo={INVENTORY_ROUTES.stock}
            linkLabel="All SKUs"
            loading={inventoryLoading}
            empty={stock.runningLow.length === 0}
            emptyText="No active SKUs with demand on file."
          >
            <RunningLowList rows={stock.runningLow} />
          </OverviewPanel>
          <OverviewPanel
            title="Arriving"
            linkTo={INVENTORY_ROUTES.shipments}
            linkLabel="Shipments"
            loading={shipmentsLoading}
            error={freightError}
            empty={shipments.arriving.length === 0}
            emptyText="Nothing on the way."
          >
            <ArrivingList rows={shipments.arriving} />
          </OverviewPanel>
        </div>

        <div className="min-w-0 space-y-4">
          <OverviewPanel
            title="Receiving"
            count={shipments.receiving.length}
            linkTo={`${INVENTORY_ROUTES.shipments}?filter=receiving`}
            linkLabel="Shipments"
            loading={shipmentsLoading}
            error={freightError}
            empty={shipments.receiving.length === 0}
            emptyText="Nothing on the dock."
            className={cn(shipments.receiving.length > 0 && "border-amber-500/45")}
          >
            <ReceivingList rows={shipments.receiving} />
          </OverviewPanel>
          <OverviewPanel
            title="Issues"
            count={issues.total}
            linkTo={INVENTORY_ROUTES.issues}
            linkLabel="All issues"
            loading={issuesLoading}
            error={breakageQ.isError || variancesQ.isError}
            empty={issues.latest.length === 0}
            emptyText="No open issues."
          >
            <IssuesList rows={issues.latest} />
          </OverviewPanel>
          <OverviewPanel
            title="Materials below reorder point"
            count={materialsLow.length}
            linkTo={INVENTORY_ROUTES.materials}
            linkLabel="Materials"
            loading={materialsLoading}
            error={materialsError}
            empty={materialsLow.length === 0}
            emptyText="Every material is above its reorder point."
          >
            <MaterialsLowList rows={materialsLow} />
          </OverviewPanel>
        </div>
      </div>

      <ShippingBaseline />

      {/* Mounted only while open: the dialog loads its own catalog data. */}
      {newOrderOpen && <NewFactoryOrderDialog open onOpenChange={setNewOrderOpen} />}
    </div>
  );
}
