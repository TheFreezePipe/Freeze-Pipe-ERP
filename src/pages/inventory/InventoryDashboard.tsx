import { StatCard } from "@/components/shared/StatCard";
import { Warehouse, Ship, Factory, Pencil, X, Save, Search, Plane, DollarSign, ShoppingCart, Trash2, ArrowRight } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { format, parseISO, differenceInDays } from "date-fns";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { computeDOS, NO_DEMAND_DOS } from "@/lib/inventory-math";
import { useTableSort, applySort, SortableTh } from "@/components/shared/table-sort";
import { displayCategoryRank } from "@/lib/constants";
import { getEffectiveDemand } from "@/lib/demand";
import {
  buildInTransitMap,
  buildOnOrderMap,
  inventoryTotalsReal,
} from "@/lib/inventory-aggregates";
import { SKUDetailModal } from "@/components/inventory/SKUDetailModal";
import { useMemo, useState, useEffect } from "react";
import { useUrlFilter, useUrlBoolFilter } from "@/lib/use-url-filter";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { ProductSKU, InventoryLevel, FreightShipment } from "@/types/database";
import { useInventory, useBulkCycleCount, useFreightShipments, useFreightLineItems, useFactoryOrders, useForecastDemandMap, useDemandOverrides, useSuppliers, useAllPrimarySkuSupplierCosts, type CycleCountField, type CycleCountReason } from "@/lib/hooks";
import { useAuth } from "@/lib/auth-context";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { buildOrderPreview, type OrderPreviewLine } from "@/lib/order-preview";
import { NewFactoryOrderDialog } from "@/components/manufacturing/NewFactoryOrderDialog";
import type { FreightLineItemWithProduct, FactoryOrderWithItems } from "@/lib/hooks";

// Category priority + rank helper moved to src/lib/constants.ts so the
// SKU Economics page can share the exact same sequence without drift.

/**
 * Visual style for each freight status as it shows up inside the in-transit
 * popover. `tracking` is the actionable state operators care about most
 * (carrier has scanned it; ETA is now high-confidence), so it gets a green
 * dot to make the binary "tracking yet or not?" answer visible at a glance.
 */
const FREIGHT_STATUS_PILL: Record<string, { label: string; dot: string; text: string }> = {
  out_for_delivery:{ label: "Out for delivery", dot: "bg-emerald-400", text: "text-emerald-300" },
  tracking:        { label: "Tracking",        dot: "bg-green-400", text: "text-green-300" },
  cleared_customs: { label: "Customs cleared", dot: "bg-cyan-400",  text: "text-cyan-300" },
  on_the_water:    { label: "On the water",    dot: "bg-blue-400",  text: "text-blue-300" },
  high_risk:       { label: "High risk",       dot: "bg-red-500",   text: "text-red-300" },
  pending:         { label: "Pending",         dot: "bg-zinc-500",  text: "text-zinc-400" },
};

/** Hover popover showing which freight shipments make up a SKU's in-transit total */
function TransitBreakdownPopover({
  skuId,
  totalUnits,
  freightShipments,
  freightLineItems,
}: {
  skuId: string;
  totalUnits: number;
  freightShipments: FreightShipment[];
  freightLineItems: FreightLineItemWithProduct[];
}) {
  const [open, setOpen] = useState(false);

  const shipments = useMemo(() => {
    return freightLineItems
      .filter(li => li.sku_id === skuId)
      .map(li => {
        const shipment = freightShipments.find(f => f.id === li.freight_shipment_id);
        return shipment && shipment.status !== "delivered"
          ? { shipment, quantity: li.quantity }
          : null;
      })
      .filter((x): x is { shipment: FreightShipment; quantity: number } => x !== null)
      .sort((a, b) => (a.shipment.eta ?? "").localeCompare(b.shipment.eta ?? ""));
  }, [skuId, freightShipments, freightLineItems]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          onMouseEnter={() => setOpen(true)}
          onMouseLeave={() => setOpen(false)}
          className="block w-full px-3 py-2 text-right tabular-nums hover:text-primary transition-colors"
        >
          {totalUnits.toLocaleString()}
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        className="w-[320px] p-0"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
      >
        <div className="border-b border-border px-3 py-2">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">In Transit Breakdown</p>
          <p className="text-sm font-semibold tabular-nums">{totalUnits.toLocaleString()} units across {shipments.length} shipment{shipments.length === 1 ? "" : "s"}</p>
        </div>
        {shipments.length === 0 ? (
          <div className="px-3 py-4 text-xs text-muted-foreground text-center">No active shipments</div>
        ) : (
          <div className="divide-y divide-border/50">
            {shipments.map(({ shipment, quantity }) => {
              const isAir = shipment.freight_type === "air";
              const Icon = isAir ? Plane : Ship;
              const daysLeft = shipment.eta ? differenceInDays(parseISO(shipment.eta), new Date()) : null;
              // Fall back to a neutral chip for any status the map doesn't
              // cover so a future schema addition doesn't render a blank.
              const pill =
                FREIGHT_STATUS_PILL[shipment.status] ?? {
                  label: shipment.status,
                  dot: "bg-zinc-500",
                  text: "text-zinc-400",
                };
              return (
                <div key={shipment.id} className="flex items-center gap-3 px-3 py-2">
                  <div className={`flex h-8 w-8 items-center justify-center rounded-md ${isAir ? "bg-cyan-400/10 text-cyan-400" : "bg-blue-400/10 text-blue-400"}`}>
                    <Icon className="h-4 w-4" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium truncate">{shipment.shipment_number}</p>
                    <p className="text-[10px] text-muted-foreground">
                      {shipment.eta ? `ETA ${format(parseISO(shipment.eta), "MMM d")}` : "ETA —"}
                      {daysLeft !== null && daysLeft >= 0 && ` · ${daysLeft}d`}
                      {daysLeft !== null && daysLeft < 0 && ` · ${Math.abs(daysLeft)}d overdue`}
                    </p>
                    {/* Status pill — dot + label so "is it tracking yet?"
                        is answerable at a glance without parsing the
                        underlying enum value. */}
                    <p className={`mt-0.5 inline-flex items-center gap-1 text-[10px] ${pill.text}`}>
                      <span className={`inline-block h-1.5 w-1.5 rounded-full ${pill.dot}`} />
                      {pill.label}
                    </p>
                  </div>
                  <p className="text-sm font-semibold tabular-nums">{quantity.toLocaleString()}</p>
                </div>
              );
            })}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

/**
 * Status pill styles for factory orders inside the on-order popover —
 * the on-order analogue of FREIGHT_STATUS_PILL above. `finished` is the
 * actionable "made, just needs to ship" state, so it gets the green dot.
 */
const FACTORY_STATUS_PILL: Record<string, { label: string; dot: string; text: string }> = {
  finished:      { label: "Finished",      dot: "bg-green-400", text: "text-green-300" },
  in_production: { label: "In production", dot: "bg-amber-400", text: "text-amber-300" },
  ordered:       { label: "Ordered",       dot: "bg-blue-400",  text: "text-blue-300" },
};

/** Hover popover showing which factory orders make up a SKU's on-order total.
 *  Mirrors TransitBreakdownPopover; rows use the same math as buildOnOrderMap
 *  so the per-order quantities sum exactly to totalUnits. */
function OnOrderBreakdownPopover({
  skuId,
  totalUnits,
  factoryOrders,
  freightLineItems,
}: {
  skuId: string;
  totalUnits: number;
  factoryOrders: FactoryOrderWithItems[];
  freightLineItems: FreightLineItemWithProduct[];
}) {
  const [open, setOpen] = useState(false);

  const orders = useMemo(() => {
    // Total freight already shipped per factory_order_item — netted out of
    // each order's remaining (a line can be split across shipments).
    const shippedByFoi = new Map<string, number>();
    for (const line of freightLineItems) {
      const foi = line.source_factory_order_item_id;
      if (!foi) continue;
      shippedByFoi.set(foi, (shippedByFoi.get(foi) ?? 0) + (line.quantity ?? 0));
    }
    // Same active-order statuses as buildOnOrderMap (ON_ORDER_STATUSES).
    const active = new Set(["ordered", "in_production", "finished"]);
    const rows: { order: FactoryOrderWithItems; quantity: number }[] = [];
    for (const order of factoryOrders) {
      if (!active.has(order.status)) continue;
      let remainingForSku = 0;
      for (const item of order.items ?? []) {
        if (item.sku_id !== skuId) continue;
        const shipped = shippedByFoi.get(item.id) ?? 0;
        remainingForSku += Math.max(
          0,
          (item.quantity_ordered ?? 0) -
            (item.quantity_breakage ?? 0) -
            shipped -
            (item.quantity_shipped_manual ?? 0) -
            (item.quantity_consumed_by_parent ?? 0),
        );
      }
      if (remainingForSku > 0) rows.push({ order, quantity: remainingForSku });
    }
    // Soonest expected completion first; null completion sinks to the bottom.
    return rows.sort((a, b) =>
      (a.order.expected_completion ?? "9999-99-99").localeCompare(
        b.order.expected_completion ?? "9999-99-99",
      ),
    );
  }, [skuId, factoryOrders, freightLineItems]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          onMouseEnter={() => setOpen(true)}
          onMouseLeave={() => setOpen(false)}
          className="block w-full px-3 py-2 text-right tabular-nums hover:text-primary transition-colors"
        >
          {totalUnits.toLocaleString()}
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        className="w-[320px] p-0"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
      >
        <div className="border-b border-border px-3 py-2">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">On Order Breakdown</p>
          <p className="text-sm font-semibold tabular-nums">{totalUnits.toLocaleString()} units across {orders.length} order{orders.length === 1 ? "" : "s"}</p>
        </div>
        {orders.length === 0 ? (
          <div className="px-3 py-4 text-xs text-muted-foreground text-center">No open factory orders</div>
        ) : (
          <div className="divide-y divide-border/50">
            {orders.map(({ order, quantity }) => {
              const daysLeft = order.expected_completion
                ? differenceInDays(parseISO(order.expected_completion), new Date())
                : null;
              const pill =
                FACTORY_STATUS_PILL[order.status] ?? {
                  label: order.status,
                  dot: "bg-zinc-500",
                  text: "text-zinc-400",
                };
              return (
                <div key={order.id} className="flex items-center gap-3 px-3 py-2">
                  <div className="flex h-8 w-8 items-center justify-center rounded-md bg-orange-400/10 text-orange-400">
                    <Factory className="h-4 w-4" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium truncate">
                      {order.order_number ?? order.supplier?.code ?? "Awaiting #"}
                    </p>
                    <p className="text-[10px] text-muted-foreground">
                      {order.expected_completion ? `ETA ${format(parseISO(order.expected_completion), "MMM d")}` : "ETA —"}
                      {daysLeft !== null && daysLeft >= 0 && ` · ${daysLeft}d`}
                      {daysLeft !== null && daysLeft < 0 && ` · ${Math.abs(daysLeft)}d overdue`}
                    </p>
                    {/* Status pill — dot + label, matching the freight popover. */}
                    <p className={`mt-0.5 inline-flex items-center gap-1 text-[10px] ${pill.text}`}>
                      <span className={`inline-block h-1.5 w-1.5 rounded-full ${pill.dot}`} />
                      {pill.label}
                    </p>
                  </div>
                  <p className="text-sm font-semibold tabular-nums">{quantity.toLocaleString()}</p>
                </div>
              );
            })}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** Width of the red→grey→green gradient band, in days. Band is anchored so
 *  `target` hits full green and `target - BAND_WIDTH` hits full red. */
const DOS_GRADIENT_BAND = 50;

/** DOS Total conditional color: red(target-50) -> grey(target-25) -> green(target). */
function dosTotalStyle(dos: number, target: number): React.CSSProperties {
  const max = target;
  const min = target - DOS_GRADIENT_BAND;
  const mid = target - DOS_GRADIENT_BAND / 2;
  const clamped = Math.max(min, Math.min(max, dos));
  let r: number, g: number, b: number;
  if (clamped <= mid) {
    const t = (clamped - min) / (mid - min);
    r = Math.round(239 + (156 - 239) * t);
    g = Math.round(128 + (156 - 128) * t);
    b = Math.round(128 + (156 - 128) * t);
  } else {
    const t = (clamped - mid) / (max - mid);
    r = Math.round(156 + (134 - 156) * t);
    g = Math.round(156 + (219 - 156) * t);
    b = Math.round(156 + (134 - 156) * t);
  }
  return {
    backgroundColor: `rgba(${r}, ${g}, ${b}, 0.22)`,
    color: `rgb(${r}, ${g}, ${b})`,
    fontWeight: 600,
  };
}

/** Gradient text color for Warehouse DOS: red(0d) -> yellow(25d) -> green(50d+). */
function warehouseDOSStyle(dos: number): React.CSSProperties {
  const min = 0, mid = 25, max = 50;
  const clamped = Math.max(min, Math.min(max, dos));
  let r: number, g: number, b: number;
  if (clamped <= mid) {
    const t = (clamped - min) / (mid - min);
    r = Math.round(239 + (250 - 239) * t);
    g = Math.round(128 + (204 - 128) * t);
    b = Math.round(128 + (21 - 128) * t);
  } else {
    const t = (clamped - mid) / (max - mid);
    r = Math.round(250 + (74 - 250) * t);
    g = Math.round(204 + (222 - 204) * t);
    b = Math.round(21 + (128 - 21) * t);
  }
  return { color: `rgb(${r}, ${g}, ${b})` };
}

/** Gradient color for Transit/OnOrder DOS: neutral (0d) -> green (40d+) */
function incomingDOSStyle(dos: number): React.CSSProperties {
  if (dos <= 0) return { color: "hsl(var(--muted-foreground))" };
  const t = Math.min(1, dos / 40);
  const r = Math.round(148 + (74 - 148) * t);
  const g = Math.round(163 + (222 - 163) * t);
  const b = Math.round(184 + (128 - 184) * t);
  return { color: `rgb(${r}, ${g}, ${b})`, fontWeight: t > 0.5 ? 600 : 500 };
}

export default function InventoryDashboard() {
  const [editMode, setEditMode] = useState(false);
  const [editValues, setEditValues] = useState<Record<string, Record<string, number>>>({});
  const [selectedSKU, setSelectedSKU] = useState<{ product: ProductSKU; inventory: InventoryLevel } | null>(null);

  const { data: inventory = [], isLoading: inventoryLoading } = useInventory();
  const { data: freightShipments = [] } = useFreightShipments();
  const { data: freightLineItems = [] } = useFreightLineItems();
  const { data: factoryOrders = [] } = useFactoryOrders();
  const forecastMap = useForecastDemandMap();
  // Which SKUs carry a manual demand override — the map above already
  // FOLDS the override values in (they win over forecast + baseline);
  // this set only distinguishes the badge ("O" vs "F") in the table.
  const { data: demandOverrides = [] } = useDemandOverrides();
  const overrideIds = useMemo(
    () => new Set(demandOverrides.map((o) => o.sku_id)),
    [demandOverrides],
  );

  // Shared per-SKU maps. Rebuilt whenever any of the three real sources
  // change. Replaces the legacy `inventory_levels.in_transit_* / nancy_* /
  // yx_*` column reads — those columns are no longer maintained after the
  // supplier portal flipped over to writing factory_orders + freight_shipments
  // directly.
  const inTransitMap = useMemo(
    () => buildInTransitMap(freightShipments, freightLineItems),
    [freightShipments, freightLineItems],
  );
  const onOrderMap = useMemo(
    () => buildOnOrderMap(factoryOrders, freightLineItems),
    [factoryOrders, freightLineItems],
  );
  const bulkCycleCount = useBulkCycleCount();
  const { profile } = useAuth();

  // ===== Order builder support =====
  // Suppliers (for grouping/labels) + primary costs (for cost preview and
  // supplier routing). Products come off the joined inventory rows.
  const { data: suppliers = [] } = useSuppliers({ activeOnly: true });
  const { data: primaryCostBySkuId } = useAllPrimarySkuSupplierCosts();
  const orderProducts = useMemo(
    () => inventory.map((i) => i.product).filter(Boolean) as ProductSKU[],
    [inventory],
  );
  // Shared cost + DOS math — identical to the New Factory Order dialog.
  const orderPreview = useMemo(
    () =>
      buildOrderPreview({
        products: orderProducts,
        inventory,
        inTransitMap,
        onOrderMap,
        primaryCostBySkuId,
        forecastMap,
      }),
    [orderProducts, inventory, inTransitMap, onOrderMap, primaryCostBySkuId, forecastMap],
  );

  // Pending-save state — when the user clicks Save, we open a reason dialog
  // because every cycle count must be attributed to a reason code.
  const [reasonDialogOpen, setReasonDialogOpen] = useState(false);
  const [reasonChoice, setReasonChoice] = useState<CycleCountReason>("other");
  const [reasonNotes, setReasonNotes] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);

  const [searchQuery, setSearchQuery] = useUrlFilter<string>("q", "");
  const [categoryFilter, setCategoryFilter] = useUrlFilter("category", "all");
  const [abcFilter, setAbcFilter] = useUrlFilter("abc", "all");
  const [showArchived, setShowArchived] = useUrlBoolFilter("archived", false);

  const [dosTarget, setDosTarget] = useState<number>(() => {
    if (typeof window === "undefined") return 130;
    const saved = window.localStorage.getItem("freeze-pipe-dos-target");
    const n = saved ? parseInt(saved, 10) : NaN;
    return Number.isFinite(n) && n >= 90 && n <= 200 ? n : 130;
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem("freeze-pipe-dos-target", String(dosTarget));
  }, [dosTarget]);

  // ===== Order builder state =====
  // A supplier-agnostic "shopping list" (sku_id -> qty) the user fills while
  // scanning. Persisted so a planning session survives navigation/refresh.
  const [orderMode, setOrderMode] = useState(false);
  const [cart, setCart] = useState<Record<string, number>>(() => {
    if (typeof window === "undefined") return {};
    try {
      return JSON.parse(window.localStorage.getItem("fp-erp-order-cart") || "{}") as Record<string, number>;
    } catch {
      return {};
    }
  });
  const [reviewOpen, setReviewOpen] = useState(false);
  // The supplier group currently being turned into a real factory order.
  const [createGroup, setCreateGroup] = useState<{ supplierId: string | null; items: OrderPreviewLine[] } | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem("fp-erp-order-cart", JSON.stringify(cart));
  }, [cart]);

  function setCartQty(skuId: string, qty: number) {
    setCart((prev) => {
      const next = { ...prev };
      if (qty > 0) next[skuId] = qty;
      else delete next[skuId];
      return next;
    });
  }

  const cartLines = useMemo<OrderPreviewLine[]>(
    () =>
      Object.entries(cart)
        .filter(([, q]) => q > 0)
        .map(([sku_id, quantity]) => ({ sku_id, quantity })),
    [cart],
  );
  const cartTotals = useMemo(() => orderPreview.lineTotals(cartLines), [orderPreview, cartLines]);
  // Group the cart by each SKU's primary supplier so a mixed list becomes one
  // factory order per supplier at create time.
  const cartGroups = useMemo(() => {
    const groups = new Map<string, { supplierId: string | null; supplierName: string; items: OrderPreviewLine[] }>();
    for (const line of cartLines) {
      const sid = orderPreview.supplierIdFor(line.sku_id);
      const key = sid ?? "__none__";
      let g = groups.get(key);
      if (!g) {
        const name = sid
          ? suppliers.find((s) => s.id === sid)?.name ?? "Unknown supplier"
          : "No supplier on file";
        g = { supplierId: sid, supplierName: name, items: [] };
        groups.set(key, g);
      }
      g.items.push(line);
    }
    return [...groups.values()];
  }, [cartLines, orderPreview, suppliers]);

  const aggregated = useMemo(() => {
    let warehouse = 0, transit = 0, onOrder = 0, total = 0, estMonthlyRevenue = 0;
    inventory.forEach(inv => {
      const t = inventoryTotalsReal(inv, inTransitMap, onOrderMap);
      warehouse += t.warehouseTotal;
      transit += t.transitTotal;
      onOrder += t.onOrderTotal;
      total += t.totalUnits;
      // Projected revenue using the SAME demand the per-SKU table shows for
      // each SKU — live forecast where one exists, else the trailing-30d
      // ShipStation baseline (getEffectiveDemand) — × its MSRP. Summed, then
      // /30 for an estimated daily figure.
      const p = inv.product;
      if (p) estMonthlyRevenue += getEffectiveDemand(p.id, p.monthly_demand, forecastMap) * (p.retail_price ?? 0);
    });
    return { warehouse, transit, onOrder, total, estDailySales: estMonthlyRevenue / 30 };
  }, [inventory, inTransitMap, onOrderMap, forecastMap]);

  const categories = useMemo(() => {
    const cats = new Set<string>();
    inventory.forEach(inv => {
      if (inv.product?.display_category) cats.add(inv.product.display_category);
    });
    return Array.from(cats).sort();
  }, [inventory]);

  const rows = useMemo(() => {
    return inventory
      .map(inv => {
        const product = inv.product;
        const totals = inventoryTotalsReal(inv, inTransitMap, onOrderMap);
        const demand = getEffectiveDemand(product.id, product.monthly_demand, forecastMap);
        // "forecast" gates the "F" badge: true when the live forecast (not
        // the trailing-30d baseline) is driving this SKU's demand.
        const forecast = forecastMap.has(product.id);
        // Manual override outranks the forecast — badge as "O", not "F".
        const overridden = overrideIds.has(product.id);
        const overallDOS = computeDOS(totals.totalUnits, demand);
        const warehouseDOS = computeDOS(totals.warehouseTotal, demand);
        const transitDOS = computeDOS(totals.transitTotal, demand);
        const onOrderDOS = computeDOS(totals.onOrderTotal, demand);
        return { inv, product, totals, overallDOS, warehouseDOS, transitDOS, onOrderDOS, demand, forecast, overridden };
      })
      // Sort by display_category in the operational priority order
      // requested by Chase 2026-05-07. Within a category, lowest
      // warehouse DOS (i.e. most-urgent-to-restock) bubbles up. Any
      // SKU whose display_category isn't in the list lands at the
      // bottom in alpha order — surfaces drift in catalog data.
      .sort((a, b) => {
        const pa = displayCategoryRank(a.product.display_category);
        const pb = displayCategoryRank(b.product.display_category);
        if (pa !== pb) return pa - pb;
        return a.warehouseDOS - b.warehouseDOS;
      });
  }, [inventory, inTransitMap, onOrderMap, forecastMap]);

  const filteredRows = useMemo(() => {
    return rows.filter(({ product }) => {
      // "Archived" for visibility = canonical archive_at column set OR
      // is_active flipped off via the eye-icon Deactivate button. Bridges
      // two real cases:
      //   1. Legacy rows archived before migration 008 / before the
      //      archive_sku() RPC was wired into the modal — those have
      //      is_active=false but archived_at=null.
      //   2. Future "deactivated, not formally archived" rows from the
      //      modal's Deactivate button. These shouldn't clutter the
      //      active operational view either.
      // The "Show archived" toggle includes both kinds.
      const archivedAt = (product as ProductSKU & { archived_at?: string | null }).archived_at;
      const isArchived = !!archivedAt || !product.is_active;
      if (isArchived && !showArchived) return false;
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        const matchesSku = product.sku.toLowerCase().includes(q);
        const matchesName = product.product_name.toLowerCase().includes(q);
        if (!matchesSku && !matchesName) return false;
      }
      if (categoryFilter !== "all" && product.display_category !== categoryFilter) return false;
      if (abcFilter !== "all") {
        if (abcFilter === "none") {
          if (product.abc_classification !== null) return false;
        } else {
          if (product.abc_classification !== abcFilter) return false;
        }
      }
      return true;
    });
  }, [rows, searchQuery, categoryFilter, abcFilter, showArchived]);

  // Click-to-sort. Default order (sort === null) keeps the operational
  // category-priority + warehouse-DOS ordering from `rows`. The 999
  // no-demand DOS sentinel maps to null so "no demand" rows always sort
  // last instead of topping a descending DOS sort.
  const { sort, toggleSort } = useTableSort();
  const sortedRows = useMemo(() => {
    const dos = (v: number) => (v === NO_DEMAND_DOS ? null : v);
    type Row = (typeof filteredRows)[number];
    return applySort<Row>(filteredRows, sort, {
      sku: (r) => r.product.sku,
      category: (r) => r.product.display_category,
      abc: (r) => r.product.abc_classification,
      demand: (r) => (r.demand > 0 ? r.demand : null),
      whUnits: (r) => r.totals.warehouseTotal,
      whDOS: (r) => dos(r.warehouseDOS),
      transitUnits: (r) => r.totals.transitTotal,
      transitDOS: (r) => dos(r.transitDOS),
      onOrderUnits: (r) => r.totals.onOrderTotal,
      onOrderDOS: (r) => dos(r.onOrderDOS),
      totalUnits: (r) => r.totals.totalUnits,
      dosTotal: (r) => dos(r.overallDOS),
    });
  }, [filteredRows, sort]);

  function startEdit() {
    const initial: Record<string, Record<string, number>> = {};
    inventory.forEach(inv => {
      initial[inv.id] = {
        warehouse_raw: inv.warehouse_raw ?? 0,
        warehouse_prefilled_raw: inv.warehouse_prefilled_raw ?? 0,
        warehouse_in_production: inv.warehouse_in_production ?? 0,
        warehouse_finished: inv.warehouse_finished ?? 0,
        warehouse_other: inv.warehouse_other ?? 0,
      };
    });
    setEditValues(initial);
    setEditMode(true);
  }

  function cancelEdit() {
    setEditValues({});
    setEditMode(false);
  }

  /**
   * Compute per-field deltas from the current inventory state.
   *
   * CRITICAL: only emit a delta for fields the operator actually touched
   * (i.e. `edited[field] !== undefined`). The prior `?? 0` fallback was
   * silently zeroing every bucket the operator didn't edit — a bong row
   * with raw=100, prefilled_raw=20, in_production=5, other=2, where the
   * operator only changed warehouse_finished, would have emitted FIVE
   * adjustments trying to zero out the four untouched buckets. That data
   * was getting clipped at the RPC layer (prefilled_raw wasn't in the
   * field allow-list pre-2026-05-11-1, so the whole batch failed
   * validation as "invalid_field"). With that allow-list patched, the
   * spurious deltas would have committed.
   */
  function computeAdjustments(): Array<{ skuId: string; field: CycleCountField; delta: number }> {
    const adjustments: Array<{ skuId: string; field: CycleCountField; delta: number }> = [];
    for (const [invId, edited] of Object.entries(editValues)) {
      const inv = inventory.find(i => i.id === invId);
      if (!inv) continue;
      for (const field of ["warehouse_raw", "warehouse_prefilled_raw", "warehouse_in_production", "warehouse_finished", "warehouse_other"] as CycleCountField[]) {
        const newVal = edited[field];
        if (newVal === undefined) continue; // operator never touched this cell — leave it alone
        const oldVal = inv[field] as number;
        const delta = newVal - oldVal;
        if (delta !== 0) {
          adjustments.push({ skuId: inv.sku_id, field, delta });
        }
      }
    }
    return adjustments;
  }

  function saveEdit() {
    // Open the reason dialog. We only hit the DB after the user picks a reason.
    const adjustments = computeAdjustments();
    if (adjustments.length === 0) {
      // Nothing changed — just exit edit mode
      setEditMode(false);
      setEditValues({});
      return;
    }
    setSaveError(null);
    setReasonChoice("other");
    setReasonNotes("");
    setReasonDialogOpen(true);
  }

  async function confirmSave() {
    if (!profile?.id) {
      setSaveError("Not authenticated");
      return;
    }
    const adjustments = computeAdjustments();
    try {
      // The bulk RPC validates the whole batch first; if it returns
      // ok=false, NOTHING was written — no partial commit to back out.
      // Operators get one consolidated failure list and retry after
      // fixing the bad rows.
      const result = await bulkCycleCount.mutateAsync({
        adjustments,
        reason: reasonChoice,
        notes: reasonNotes.trim() || null,
        actorId: profile.id,
      });
      if (!result.ok) {
        if (result.failures.length > 0) {
          setSaveError(
            `${result.failures.length} adjustment(s) rejected (no changes saved): ` +
            result.failures
              .map((f) => {
                const skuShort = f.sku_id.slice(0, 8);
                if (f.reason === "would_go_negative") {
                  return `${skuShort}/${f.field}: would go negative (current ${f.current ?? 0}, delta ${f.delta ?? 0})`;
                }
                return `${skuShort}/${f.field}: ${f.reason}`;
              })
              .join("; "),
          );
        } else {
          setSaveError(result.error || "Save failed");
        }
        return;
      }
      setReasonDialogOpen(false);
      setEditMode(false);
      setEditValues({});
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Save failed");
    }
  }

  function getEditValue(invId: string, field: string) {
    // If the operator has typed something in this cell, show that. Otherwise
    // pre-populate with the row's current inventory level — showing "0" by
    // default was misleading and made operators think buckets were empty
    // when they weren't.
    const edited = editValues[invId]?.[field];
    if (edited !== undefined) return edited;
    const inv = inventory.find(i => i.id === invId);
    return ((inv?.[field as keyof typeof inv] as number | undefined) ?? 0);
  }

  function setEditFieldValue(invId: string, field: string, value: string) {
    setEditValues(prev => ({
      ...prev,
      [invId]: { ...prev[invId], [field]: parseInt(value, 10) || 0 },
    }));
  }

  if (inventoryLoading) {
    return (
      <div className="flex items-center justify-center h-64 text-muted-foreground text-sm">
        Loading inventory…
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Inventory</h1>
          <p className="text-muted-foreground">Stock levels across all locations</p>
        </div>
        <div className="flex items-center gap-2">
          {editMode ? (
            <>
              <Button variant="ghost" size="sm" onClick={cancelEdit}>
                <X className="mr-1.5 h-4 w-4" />
                Cancel
              </Button>
              <Button size="sm" onClick={saveEdit} disabled={bulkCycleCount.isPending}>
                <Save className="mr-1.5 h-4 w-4" />
                {bulkCycleCount.isPending ? "Saving…" : "Save Cycle Count"}
              </Button>
            </>
          ) : orderMode ? (
            <>
              <Button variant="ghost" size="sm" onClick={() => setOrderMode(false)}>
                <X className="mr-1.5 h-4 w-4" />
                Done
              </Button>
              <Button size="sm" onClick={() => setReviewOpen(true)} disabled={cartLines.length === 0}>
                <ShoppingCart className="mr-1.5 h-4 w-4" />
                Review &amp; create
                {cartLines.length > 0 && (
                  <span className="ml-1.5 rounded-full bg-primary-foreground/20 px-1.5 text-xs tabular-nums">
                    {cartLines.length}
                  </span>
                )}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" size="sm" onClick={() => setOrderMode(true)}>
                <ShoppingCart className="mr-1.5 h-4 w-4" />
                Build order
                {cartLines.length > 0 && (
                  <span className="ml-1.5 rounded-full bg-muted px-1.5 text-xs tabular-nums text-muted-foreground">
                    {cartLines.length}
                  </span>
                )}
              </Button>
              <Button variant="outline" size="sm" onClick={startEdit}>
                <Pencil className="mr-1.5 h-4 w-4" />
                Edit
              </Button>
            </>
          )}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard title="In Warehouse" value={aggregated.warehouse.toLocaleString()} subtitle="Total units" icon={Warehouse} iconColor="text-green-400" />
        <StatCard title="In Transit" value={aggregated.transit.toLocaleString()} subtitle="Air + Sea" icon={Ship} iconColor="text-blue-400" />
        <StatCard title="On Order" value={aggregated.onOrder.toLocaleString()} subtitle="Nancy + YX" icon={Factory} iconColor="text-orange-400" />
        <StatCard title="Est. Sales/Day" value={`$${Math.round(aggregated.estDailySales).toLocaleString()}`} subtitle="per-SKU demand (forecast / 30-day) × MSRP ÷ 30" icon={DollarSign} iconColor="text-emerald-400" />
      </div>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <CardTitle className="text-base">Inventory by SKU</CardTitle>
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder="Search SKU or name..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="h-8 w-[180px] pl-8 text-xs"
                />
              </div>
              <Select value={categoryFilter} onValueChange={setCategoryFilter}>
                <SelectTrigger className="h-8 w-[150px] text-xs">
                  <SelectValue placeholder="Category" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Categories</SelectItem>
                  {categories.map(cat => (
                    <SelectItem key={cat} value={cat}>{cat}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={abcFilter} onValueChange={setAbcFilter}>
                <SelectTrigger className="h-8 w-[110px] text-xs">
                  <SelectValue placeholder="ABC" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All ABC</SelectItem>
                  <SelectItem value="A">A</SelectItem>
                  <SelectItem value="B">B</SelectItem>
                  <SelectItem value="C">C</SelectItem>
                  <SelectItem value="none">Unclassified</SelectItem>
                </SelectContent>
              </Select>
              {(searchQuery || categoryFilter !== "all" || abcFilter !== "all" || showArchived) && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 px-2 text-xs text-muted-foreground"
                  onClick={() => { setSearchQuery(""); setCategoryFilter("all"); setAbcFilter("all"); setShowArchived(false); }}
                >
                  <X className="mr-1 h-3 w-3" />
                  Clear
                </Button>
              )}
              <label className="flex items-center gap-1.5 cursor-pointer text-xs text-muted-foreground hover:text-foreground select-none">
                <input
                  type="checkbox"
                  checked={showArchived}
                  onChange={e => setShowArchived(e.target.checked)}
                  className="h-3.5 w-3.5 rounded border-border bg-muted accent-primary"
                />
                Show archived
              </label>
              <span className="text-xs text-muted-foreground ml-1">
                {filteredRows.length} of {rows.length}
              </span>
              <div className="flex items-center gap-2 pl-3 ml-1 border-l border-border/60">
                <label htmlFor="dos-target" className="text-xs text-muted-foreground whitespace-nowrap">
                  DOS target
                </label>
                <input
                  id="dos-target"
                  type="range"
                  min={90}
                  max={200}
                  step={5}
                  value={dosTarget}
                  onChange={(e) => setDosTarget(parseInt(e.target.value, 10))}
                  className="h-1.5 w-[120px] cursor-pointer appearance-none rounded-full bg-muted accent-primary"
                  aria-label="DOS Total target days"
                />
                <span className="text-xs font-medium tabular-nums w-9 text-right">{dosTarget}d</span>
              </div>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <ScrollArea className="w-full">
            <div className="min-w-[900px]">
              <table className="w-full text-sm">
                <thead>
                  {editMode ? (
                    <tr className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                      <th className="sticky left-0 bg-card px-4 py-3 z-10">SKU</th>
                      <th className="px-3 py-3 text-center">Category</th>
                      <th className="px-3 py-3 text-center">ABC</th>
                      <th className="px-3 py-3 text-center border-l border-border/50">Raw</th>
                      <th className="px-3 py-3 text-center">Pre-filled</th>
                      <th className="px-3 py-3 text-center">WIP</th>
                      <th className="px-3 py-3 text-center">Finished</th>
                    </tr>
                  ) : (
                    <>
                      <tr className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                        <SortableTh sortKey="sku" sort={sort} onToggle={toggleSort} className="sticky left-0 bg-card px-4 py-3 z-10">SKU</SortableTh>
                        <SortableTh sortKey="category" sort={sort} onToggle={toggleSort} className="px-3 py-3 text-center">Category</SortableTh>
                        <SortableTh sortKey="abc" sort={sort} onToggle={toggleSort} className="px-3 py-3 text-center">ABC</SortableTh>
                        <SortableTh sortKey="demand" sort={sort} onToggle={toggleSort} className="px-3 py-3 text-right">Demand/mo</SortableTh>
                        <th className="px-3 py-3 text-center border-l border-border/50" colSpan={2}>Warehouse</th>
                        <th className="px-3 py-3 text-center border-l border-border/50" colSpan={2}>In Transit</th>
                        <th className="px-3 py-3 text-center border-l border-border/50" colSpan={2}>On Order</th>
                        <th className="px-3 py-3 text-center border-l border-border/50" colSpan={2}>Total</th>
                        {orderMode && (
                          <th className="px-3 py-3 text-center border-l border-border/50 text-primary">Order</th>
                        )}
                      </tr>
                      <tr className="border-b border-border text-[10px] text-muted-foreground">
                        <th className="sticky left-0 bg-card px-4 py-1 z-10" />
                        <th className="px-3 py-1" />
                        <th className="px-3 py-1" />
                        <th className="px-3 py-1" />
                        <SortableTh sortKey="whUnits" sort={sort} onToggle={toggleSort} className="px-3 py-1 text-right border-l border-border/50">Units</SortableTh>
                        <SortableTh sortKey="whDOS" sort={sort} onToggle={toggleSort} className="px-3 py-1 text-right">DOS</SortableTh>
                        <SortableTh sortKey="transitUnits" sort={sort} onToggle={toggleSort} className="px-3 py-1 text-right border-l border-border/50">Units</SortableTh>
                        <SortableTh sortKey="transitDOS" sort={sort} onToggle={toggleSort} className="px-3 py-1 text-right">DOS</SortableTh>
                        <SortableTh sortKey="onOrderUnits" sort={sort} onToggle={toggleSort} className="px-3 py-1 text-right border-l border-border/50">Units</SortableTh>
                        <SortableTh sortKey="onOrderDOS" sort={sort} onToggle={toggleSort} className="px-3 py-1 text-right">DOS</SortableTh>
                        <SortableTh sortKey="totalUnits" sort={sort} onToggle={toggleSort} className="px-3 py-1 text-right border-l border-border/50">Units</SortableTh>
                        <SortableTh sortKey="dosTotal" sort={sort} onToggle={toggleSort} className="px-4 py-1 text-right">DOS</SortableTh>
                        {orderMode && <th className="px-3 py-1 border-l border-border/50" />}
                      </tr>
                    </>
                  )}
                </thead>
                <tbody>
                  {sortedRows.map(({ inv, product, totals, overallDOS, warehouseDOS, transitDOS, onOrderDOS, demand, forecast, overridden }) => (
                    <tr
                      key={inv.id}
                      className={`border-b border-border/50 hover:bg-muted/50 ${editMode ? "" : "cursor-pointer"}`}
                      onClick={editMode ? undefined : () => setSelectedSKU({ product, inventory: inv })}
                    >
                      <td className="sticky left-0 bg-card px-4 py-2 z-10">
                        <div>
                          <div className="flex items-center gap-1.5">
                            <p className={`font-medium ${(product as ProductSKU & { archived_at?: string | null }).archived_at ? "text-muted-foreground line-through" : ""}`}>
                              {product.sku}
                            </p>
                            {(product as ProductSKU & { archived_at?: string | null }).archived_at && (
                              <Badge variant="outline" className="text-[9px] border-amber-500/60 text-amber-400">
                                Archived
                              </Badge>
                            )}
                          </div>
                          <p className="text-xs text-muted-foreground truncate max-w-[140px]">{product.product_name}</p>
                        </div>
                      </td>
                      <td className="px-3 py-2 text-center">
                        <span className="text-xs text-muted-foreground">{product.display_category}</span>
                      </td>
                      <td className="px-3 py-2 text-center">
                        {product.abc_classification ? (
                          <Badge variant="outline" className={
                            product.abc_classification === "A" ? "border-green-500 text-green-400" :
                            product.abc_classification === "B" ? "border-yellow-500 text-yellow-400" :
                            "border-muted text-muted-foreground"
                          }>
                            {product.abc_classification}
                          </Badge>
                        ) : (
                          <span className="text-xs text-muted-foreground/50">-</span>
                        )}
                      </td>
                      {editMode ? (
                        <>
                          <td className="px-2 py-1 text-center border-l border-border/50">
                            <Input type="number" className="h-8 w-20 text-center text-xs" value={getEditValue(inv.id, "warehouse_raw")} onChange={e => setEditFieldValue(inv.id, "warehouse_raw", e.target.value)} />
                          </td>
                          <td className="px-2 py-1 text-center">
                            <Input type="number" className="h-8 w-20 text-center text-xs" value={getEditValue(inv.id, "warehouse_prefilled_raw")} onChange={e => setEditFieldValue(inv.id, "warehouse_prefilled_raw", e.target.value)} />
                          </td>
                          <td className="px-2 py-1 text-center">
                            <Input type="number" className="h-8 w-20 text-center text-xs" value={getEditValue(inv.id, "warehouse_in_production")} onChange={e => setEditFieldValue(inv.id, "warehouse_in_production", e.target.value)} />
                          </td>
                          <td className="px-2 py-1 text-center">
                            <Input type="number" className="h-8 w-20 text-center text-xs" value={getEditValue(inv.id, "warehouse_finished")} onChange={e => setEditFieldValue(inv.id, "warehouse_finished", e.target.value)} />
                          </td>
                        </>
                      ) : (
                        <>
                          <td className="px-3 py-2 text-right tabular-nums">
                            {overridden ? (
                              <span className="group relative">
                                <span className="font-medium">{demand}</span>
                                <span className="ml-0.5 text-[10px] text-amber-400">O</span>
                                <span className="absolute bottom-full right-0 mb-1 hidden group-hover:block z-20 whitespace-nowrap rounded bg-popover border border-border px-2 py-1 text-xs shadow-md">
                                  <span className="block">Manual override: {demand}/mo · Recent (30d): {product.monthly_demand ?? 0}/mo</span>
                                </span>
                              </span>
                            ) : forecast ? (
                              <span className="group relative">
                                <span className="font-medium">{demand}</span>
                                <span className="ml-0.5 text-[10px] text-blue-400">F</span>
                                <span className="absolute bottom-full right-0 mb-1 hidden group-hover:block z-20 whitespace-nowrap rounded bg-popover border border-border px-2 py-1 text-xs shadow-md">
                                  <span className="block">Forecast: {demand}/mo · Recent (30d): {product.monthly_demand}/mo</span>
                                </span>
                              </span>
                            ) : (
                              <span className="text-muted-foreground">{product.monthly_demand ?? "—"}</span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums border-l border-border/50 font-medium">
                            {totals.warehouseTotal.toLocaleString()}
                          </td>
                          <td
                            className="px-3 py-2 text-right tabular-nums font-medium"
                            style={warehouseDOS === NO_DEMAND_DOS ? undefined : warehouseDOSStyle(warehouseDOS)}
                          >
                            {warehouseDOS === NO_DEMAND_DOS ? (
                              <span className="text-[10px] text-muted-foreground/70 italic" title="No monthly demand on file — DOS can't be computed">
                                No demand data
                              </span>
                            ) : (
                              `${warehouseDOS}d`
                            )}
                          </td>
                          <td className="text-right tabular-nums border-l border-border/50">
                            {totals.transitTotal > 0 ? (
                              <TransitBreakdownPopover
                                skuId={product.id}
                                totalUnits={totals.transitTotal}
                                freightShipments={freightShipments}
                                freightLineItems={freightLineItems}
                              />
                            ) : (
                              <span className="block px-3 py-2 text-muted-foreground/50">-</span>
                            )}
                          </td>
                          <td
                            className="px-3 py-2 text-right tabular-nums"
                            style={transitDOS === NO_DEMAND_DOS ? undefined : incomingDOSStyle(transitDOS)}
                          >
                            {transitDOS === NO_DEMAND_DOS ? (
                              <span className="text-[10px] text-muted-foreground/70 italic">No demand data</span>
                            ) : transitDOS > 0 ? (
                              `${transitDOS}d`
                            ) : (
                              <span className="text-muted-foreground/50">-</span>
                            )}
                          </td>
                          <td className="text-right tabular-nums border-l border-border/50">
                            {totals.onOrderTotal > 0 ? (
                              <OnOrderBreakdownPopover
                                skuId={product.id}
                                totalUnits={totals.onOrderTotal}
                                factoryOrders={factoryOrders}
                                freightLineItems={freightLineItems}
                              />
                            ) : (
                              <span className="block px-3 py-2 text-muted-foreground/50">-</span>
                            )}
                          </td>
                          <td
                            className="px-3 py-2 text-right tabular-nums"
                            style={onOrderDOS === NO_DEMAND_DOS ? undefined : incomingDOSStyle(onOrderDOS)}
                          >
                            {onOrderDOS === NO_DEMAND_DOS ? (
                              <span className="text-[10px] text-muted-foreground/70 italic">No demand data</span>
                            ) : onOrderDOS > 0 ? (
                              `${onOrderDOS}d`
                            ) : (
                              <span className="text-muted-foreground/50">-</span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums border-l border-border/50 font-medium">
                            {totals.totalUnits.toLocaleString()}
                          </td>
                          <td
                            className="px-4 py-2 text-center tabular-nums text-base"
                            style={overallDOS === NO_DEMAND_DOS ? undefined : dosTotalStyle(overallDOS, dosTarget)}
                          >
                            {overallDOS === NO_DEMAND_DOS ? (
                              <span className="text-[10px] text-muted-foreground/70 italic" title="No monthly demand on file — DOS can't be computed">
                                No demand data
                              </span>
                            ) : (
                              `${overallDOS}d`
                            )}
                          </td>
                          {orderMode && (
                            <td
                              className="px-3 py-2 border-l border-border/50 align-middle"
                              onClick={(e) => e.stopPropagation()}
                            >
                              {(() => {
                                const qty = cart[product.id] ?? 0;
                                const projected = orderPreview.dosFor(product.id, qty);
                                const showProjection = qty > 0 && overallDOS !== NO_DEMAND_DOS;
                                const noCost = qty > 0 && orderPreview.rawCostFor(product.id) === null;
                                return (
                                  <div className="flex items-center justify-end gap-2">
                                    {/* Projected DOS Total — styled like the real
                                        DOS Total column so the effect of this order
                                        reads at a glance. */}
                                    <div className="flex flex-col items-center leading-tight w-[58px]">
                                      {showProjection && (
                                        <>
                                          <span
                                            className="rounded px-2 py-1 text-base tabular-nums"
                                            style={dosTotalStyle(projected, dosTarget)}
                                          >
                                            {projected}d
                                          </span>
                                          <span className="text-[10px] text-green-400 tabular-nums">
                                            +{Math.round(projected - overallDOS)}
                                          </span>
                                        </>
                                      )}
                                    </div>
                                    <div className="flex flex-col items-end gap-0.5">
                                      <Input
                                        type="number"
                                        min={0}
                                        value={cart[product.id] ?? ""}
                                        placeholder="0"
                                        onChange={(e) =>
                                          setCartQty(product.id, Math.max(0, parseInt(e.target.value, 10) || 0))
                                        }
                                        className="h-8 w-20 text-right tabular-nums"
                                      />
                                      {noCost && (
                                        <span
                                          className="text-[10px] text-amber-400"
                                          title="No primary supplier cost on file — this line will be created with no cost."
                                        >
                                          no cost data
                                        </span>
                                      )}
                                    </div>
                                  </div>
                                );
                              })()}
                            </td>
                          )}
                        </>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </ScrollArea>
          {orderMode && (
            <div className="sticky bottom-0 z-20 flex flex-wrap items-center justify-between gap-4 border-t border-border bg-card/95 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-card/80">
              <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
                <span><span className="text-muted-foreground">Lines </span><span className="font-semibold tabular-nums">{cartLines.length}</span></span>
                <span><span className="text-muted-foreground">Units </span><span className="font-semibold tabular-nums">{cartTotals.units.toLocaleString()}</span></span>
                <span><span className="text-muted-foreground">Est. cost </span><span className="font-semibold tabular-nums">${Math.round(cartTotals.rawCost).toLocaleString()}</span></span>
                <span><span className="text-muted-foreground">Splits into </span><span className="font-semibold tabular-nums">{cartGroups.length === 0 ? "—" : `${cartGroups.length} order${cartGroups.length > 1 ? "s" : ""}`}</span></span>
                {cartLines.length === 0 && (
                  <span className="text-xs text-muted-foreground italic">Enter quantities in the Order column to start a draft.</span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {cartLines.length > 0 && (
                  <Button variant="ghost" size="sm" onClick={() => setCart({})}>
                    <Trash2 className="mr-1.5 h-4 w-4" />
                    Clear
                  </Button>
                )}
                <Button size="sm" onClick={() => setReviewOpen(true)} disabled={cartLines.length === 0}>
                  Review &amp; create
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {selectedSKU && (
        <SKUDetailModal
          product={selectedSKU.product}
          inventory={selectedSKU.inventory}
          open={!!selectedSKU}
          onOpenChange={(open) => { if (!open) setSelectedSKU(null); }}
        />
      )}

      {/* Order builder — review the draft, then create one factory order per
          supplier group via the shared New Factory Order dialog. */}
      <Dialog open={reviewOpen} onOpenChange={setReviewOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Review draft order</DialogTitle>
            <DialogDescription>
              {cartGroups.length <= 1
                ? "Review cost and days-of-stock, then create the factory order."
                : `This draft spans ${cartGroups.length} suppliers — create one factory order per group below.`}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 max-h-[60vh] overflow-y-auto">
            {cartGroups.length === 0 && (
              <p className="text-sm text-muted-foreground">Your draft is empty.</p>
            )}
            {cartGroups.map((g) => {
              const t = orderPreview.lineTotals(g.items);
              return (
                <div key={g.supplierId ?? "__none__"} className="rounded-lg border border-border p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium">{g.supplierName}</p>
                      <p className="text-xs text-muted-foreground tabular-nums">
                        {g.items.length} SKU{g.items.length > 1 ? "s" : ""} · {t.units.toLocaleString()} units · ${Math.round(t.rawCost).toLocaleString()} est. cost
                      </p>
                    </div>
                    <Button size="sm" onClick={() => setCreateGroup({ supplierId: g.supplierId, items: g.items })}>
                      Create order
                      <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
                    </Button>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {g.items.map((it) => {
                      const p = orderProducts.find((x) => x.id === it.sku_id);
                      return (
                        <span key={it.sku_id} className="rounded bg-muted px-1.5 py-0.5 text-[11px] tabular-nums">
                          <span className="font-mono">{p?.sku ?? it.sku_id.slice(0, 8)}</span> ×{it.quantity.toLocaleString()}
                        </span>
                      );
                    })}
                  </div>
                  {g.supplierId === null && (
                    <p className="mt-2 text-[11px] text-amber-400">
                      No primary supplier on file for these SKUs — you'll pick a supplier in the order form.
                    </p>
                  )}
                </div>
              );
            })}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReviewOpen(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <NewFactoryOrderDialog
        open={createGroup !== null}
        onOpenChange={(o) => { if (!o) setCreateGroup(null); }}
        initialSupplierId={createGroup?.supplierId ?? undefined}
        initialItems={createGroup?.items}
        lockSupplier={!!createGroup?.supplierId}
        onCreated={() => {
          // Drop the just-created group's SKUs from the draft so the review
          // list shrinks as each supplier order is placed.
          setCart((prev) => {
            if (!createGroup) return prev;
            const next = { ...prev };
            for (const it of createGroup.items) delete next[it.sku_id];
            return next;
          });
          setCreateGroup(null);
        }}
      />

      {/* Reason dialog — every cycle count adjustment must have a reason code.
          The RPC writes an audit entry per changed field. */}
      <AlertDialog
        open={reasonDialogOpen}
        onOpenChange={(o) => { if (!o) setReasonDialogOpen(false); }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Record cycle count reason</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                <p className="text-sm">
                  Every inventory adjustment is logged in the audit trail with a reason
                  code. Pick the closest match. Notes are optional but help future you.
                </p>
                {(() => {
                  const adj = computeAdjustments();
                  return (
                    <div className="rounded-md border border-border/60 bg-muted/30 p-2 text-xs">
                      <p className="font-medium mb-1">{adj.length} field change(s) will be logged:</p>
                      <ul className="space-y-0.5 max-h-28 overflow-y-auto">
                        {adj.map((a, i) => (
                          <li key={i} className="tabular-nums">
                            <span className="font-medium">{inventory.find(x => x.sku_id === a.skuId)?.product?.sku ?? a.skuId}</span>
                            {" · "}
                            <span className="text-muted-foreground">{a.field}</span>
                            {" · "}
                            <span className={a.delta > 0 ? "text-green-400" : "text-red-400"}>
                              {a.delta > 0 ? "+" : ""}{a.delta}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  );
                })()}
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground" htmlFor="reason">Reason</label>
                  <Select value={reasonChoice} onValueChange={v => setReasonChoice(v as CycleCountReason)}>
                    <SelectTrigger id="reason" className="h-9">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="breakage">Breakage</SelectItem>
                      <SelectItem value="mispick">Mispick</SelectItem>
                      <SelectItem value="theft">Theft</SelectItem>
                      <SelectItem value="receiving_error">Receiving error</SelectItem>
                      <SelectItem value="other">Other</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground" htmlFor="reason-notes">Notes (optional)</label>
                  <Textarea
                    id="reason-notes"
                    value={reasonNotes}
                    onChange={e => setReasonNotes(e.target.value)}
                    rows={2}
                    placeholder="Any context worth preserving"
                  />
                </div>
                {saveError && (
                  <p className="text-xs text-red-400">{saveError}</p>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setSaveError(null)}>Cancel</AlertDialogCancel>
            {/* preventDefault on the click handler so Radix's AlertDialog
                doesn't auto-close before the async save finishes. Without
                this, a failed save would dismiss the dialog instantly and
                the operator never sees the saveError message — looks like
                a silent no-op. confirmSave is responsible for calling
                setReasonDialogOpen(false) itself on success. */}
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void confirmSave();
              }}
              disabled={bulkCycleCount.isPending}
            >
              {bulkCycleCount.isPending ? "Saving…" : "Record adjustment"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
