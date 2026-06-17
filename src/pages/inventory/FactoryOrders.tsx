import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useUrlFilter } from "@/lib/use-url-filter";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Plus,
  Building2,
  Hourglass,
  PackageCheck,
  DollarSign,
  Pencil,
  Check,
  X,
  AlarmClock,
  AlertTriangle,
  Link as LinkIcon,
  Unlink,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { format, differenceInDays, parseISO } from "date-fns";
import { StatCard } from "@/components/shared/StatCard";
import { NewFactoryOrderDialog } from "@/components/manufacturing/NewFactoryOrderDialog";
import { type FactoryOrderStatus } from "@/lib/constants";
import {
  useFactoryOrders,
  useUpdateFactoryOrder,
  useFreightLineItems,
  useProducts,
  useProductBoms,
  useLinkFactoryOrderToParent,
  useUnlinkFactoryOrderFromParent,
  computeMissingComponents,
  type FactoryOrderWithItems,
  type FreightLineItemWithProduct,
  type ProductBomRow,
} from "@/lib/hooks";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// Supplier code → display label for filter tabs. The DB-authoritative source
// is `suppliers.name` via the join on FactoryOrderWithItems.supplier, but the
// filter tabs need a stable set at render time. Keep this tiny and explicit —
// if a third supplier comes online, extend here.
const FILTERABLE_SUPPLIERS = [
  { code: "NANCY", label: "Nancy" },
  { code: "YX", label: "YX" },
] as const;
type SupplierFilterCode = (typeof FILTERABLE_SUPPLIERS)[number]["code"];

// Derived-status badge colors. Mirrors the supplier portal's STATUS_COLOR
// map so the two views read consistently.
const STATUS_COLOR: Record<string, string> = {
  in_production: "bg-amber-500/10 text-amber-400 border-amber-500/30",
  finished: "bg-blue-500/10 text-blue-400 border-blue-500/30",
  shipped: "bg-green-500/10 text-green-400 border-green-500/30",
};

// Completed (fully-shipped) orders shipped within this many days stay
// visible at the bottom; older ones collapse behind "Show older orders".
const RECENT_COMPLETED_DAYS = 3;

type FilterValue = "all" | SupplierFilterCode | FactoryOrderStatus;

// Map<factory_order_item_id, freight_line_items[]>. Built once per render
// from useFreightLineItems and used to derive accurate per-line shipped
// quantities. Replaces the old admin behavior where shipped was hardcoded
// to 0 (rollup ignored freight entirely).
type FreightMap = Map<string, FreightLineItemWithProduct[]>;

interface ItemRollup {
  total: number;
  inProduction: number;
  finishedAwaiting: number;
  shipped: number;
  breakage: number;
}

/**
 * Per-item rollup matching the supplier portal's bucketing:
 *   total      = quantity_ordered
 *   shipped    = sum of freight_line_items.quantity tied to this item
 *   finished   = quantity_finished − shipped (i.e. ready but not yet shipped)
 *   inProduction = ordered − breakage − effective_finished
 *   breakage   = quantity_breakage
 *
 * Order-level status auto-fills finished if the parent order is in
 * 'finished' or 'shipped' state without per-item backfill — same logic the
 * supplier card uses (rollupForItem in src/pages/supplier/FactoryOrdersList).
 */
function rollupForItem(
  item: FactoryOrderWithItems["items"][0],
  parent: FactoryOrderWithItems,
  freightMap: FreightMap,
): ItemRollup {
  const total = item.quantity_ordered;
  const breakage = item.quantity_breakage ?? 0;

  let shippedQty = (item.quantity_shipped_manual ?? 0) + (item.quantity_consumed_by_parent ?? 0);
  for (const line of freightMap.get(item.id) ?? []) {
    shippedQty += line.quantity ?? 0;
  }

  const reportedFinished = item.quantity_finished ?? 0;
  const statusImpliesFinished = parent.status === "finished" || parent.status === "shipped";
  // Shipped units have necessarily been finished — you can't ship what
  // isn't made. So completion is at least the shipped count, even when the
  // order is still 'ordered' and quantity_finished was never backfilled
  // (common once freight is attributed before the FO status is advanced).
  // Without this floor, shipped units get double-counted: once as `shipped`
  // and again as `inProduction`, rendering a half-grey/half-amber bar.
  const effectiveFinished = statusImpliesFinished
    ? Math.max(reportedFinished, total - breakage)
    : Math.max(reportedFinished, shippedQty);

  const finishedAwaiting = Math.max(0, effectiveFinished - shippedQty);
  const inProduction = Math.max(0, total - effectiveFinished - breakage);

  return {
    total,
    inProduction,
    finishedAwaiting,
    shipped: shippedQty,
    breakage,
  };
}

function getOrderRollup(
  order: FactoryOrderWithItems,
  freightMap: FreightMap,
): {
  inProduction: number;
  atFactory: number;
  shipped: number;
  total: number;
  breakage: number;
} {
  let inProduction = 0;
  let atFactory = 0;
  let shipped = 0;
  let total = 0;
  let breakage = 0;
  (order.items ?? []).forEach((i) => {
    const r = rollupForItem(i, order, freightMap);
    inProduction += r.inProduction;
    atFactory += r.finishedAwaiting;
    shipped += r.shipped;
    breakage += r.breakage;
    total += r.total;
  });
  return { inProduction, atFactory, shipped, total, breakage };
}

function deriveOrderStatus(
  order: FactoryOrderWithItems,
  freightMap: FreightMap,
): "in_production" | "finished" | "shipped" {
  const rollup = getOrderRollup(order, freightMap);
  if (rollup.total === 0) return "in_production";
  // Once every orderable unit is accounted for via shipping or breakage,
  // the order is fully shipped from admin's POV.
  if (rollup.shipped + rollup.breakage >= rollup.total) return "shipped";
  if (rollup.atFactory > 0) return "finished";
  return "in_production";
}

export default function FactoryOrders() {
  const [filter, setFilter] = useUrlFilter<FilterValue>("filter", "all");
  const [newDialogOpen, setNewDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [showOlder, setShowOlder] = useState(false);

  const { data: orders = [], isLoading } = useFactoryOrders();
  const { data: freightLines = [] } = useFreightLineItems();
  const { data: boms = [] } = useProductBoms();
  // All SKUs from the catalog. We use this to label component SKUs in the
  // missing-component panel — the order-line-derived lookup misses any
  // component SKU that hasn't been ordered yet (e.g. an HT-5 BoM
  // requirement when no YX order has placed it as a line item), which
  // surfaced as truncated-uuid labels in the popup.
  const { data: allProducts = [] } = useProducts();
  const updateOrder = useUpdateFactoryOrder();

  // Bucket freight lines by source factory_order_item_id. Lines without a
  // source link (legacy / direct-admin-created shipments) don't contribute
  // to any factory order's shipped count, which is correct.
  const freightMap = useMemo<FreightMap>(() => {
    const out: FreightMap = new Map();
    for (const line of freightLines) {
      const foi = line.source_factory_order_item_id;
      if (!foi) continue;
      const arr = out.get(foi);
      if (arr) arr.push(line);
      else out.set(foi, [line]);
    }
    return out;
  }, [freightLines]);

  const todayIso = useMemo(() => new Date().toISOString().slice(0, 10), []);

  function startEdit(orderId: string, currentOrderNumber: string | null) {
    setEditingId(orderId);
    setEditValue(currentOrderNumber ?? "");
  }

  async function saveEdit(orderId: string) {
    await updateOrder.mutateAsync({
      id: orderId,
      updates: { order_number: editValue.trim() || null },
    });
    setEditingId(null);
  }

  const stats = useMemo(() => {
    let openCount = 0;
    let inProductionCount = 0;
    let readyToShipCount = 0;
    let openValue = 0;
    let unitsInProduction = 0;
    let unitsAtFactory = 0;
    let totalOpenUnits = 0;

    orders.forEach((o) => {
      const derived = deriveOrderStatus(o, freightMap);
      if (derived === "shipped") return;
      openCount += 1;
      if (derived === "in_production") inProductionCount += 1;
      if (derived === "finished") readyToShipCount += 1;

      const rollup = getOrderRollup(o, freightMap);
      unitsInProduction += rollup.inProduction;
      unitsAtFactory += rollup.atFactory;
      totalOpenUnits += rollup.inProduction + rollup.atFactory;
      (o.items ?? []).forEach((i) => {
        const r = rollupForItem(i, o, freightMap);
        openValue += (i.unit_cost ?? 0) * (r.inProduction + r.finishedAwaiting);
      });
    });

    const progress = totalOpenUnits > 0 ? (unitsAtFactory / totalOpenUnits) * 100 : 0;
    return {
      openCount,
      inProductionCount,
      readyToShipCount,
      openValue,
      progress,
      unitsInProduction,
      unitsAtFactory,
    };
  }, [orders, freightMap]);

  const { activeRows, shippedVisible, olderHiddenCount } = useMemo(() => {
    let list = orders;
    if (FILTERABLE_SUPPLIERS.some((s) => s.code === filter)) {
      list = list.filter((o) => o.supplier?.code === filter);
    } else if (filter !== "all") {
      list = list.filter((o) => deriveOrderStatus(o, freightMap) === filter);
    }
    const active = list
      .filter((o) => deriveOrderStatus(o, freightMap) !== "shipped")
      .sort((a, b) =>
        (a.expected_completion ?? "").localeCompare(b.expected_completion ?? ""),
      );
    // Completion time: the persisted shipped_at, else updated_at (covers
    // orders that derive as shipped but weren't auto-stamped, e.g. costs
    // missing). Newest-completed first.
    const completedMs = (o: FactoryOrderWithItems) => {
      const d = (o as FactoryOrderWithItems & { shipped_at?: string | null }).shipped_at ?? o.updated_at;
      return d ? new Date(d).getTime() : 0;
    };
    const shipped = list
      .filter((o) => deriveOrderStatus(o, freightMap) === "shipped")
      .sort((a, b) => completedMs(b) - completedMs(a));

    // The "Shipped" tab shows them all; elsewhere collapse the old ones.
    if (filter === "shipped" || showOlder) {
      return { activeRows: active, shippedVisible: shipped, olderHiddenCount: 0 };
    }
    const cutoffMs = Date.now() - RECENT_COMPLETED_DAYS * 86_400_000;
    const recent = shipped.filter((o) => completedMs(o) >= cutoffMs);
    const older = shipped.filter((o) => completedMs(o) < cutoffMs);
    return { activeRows: active, shippedVisible: recent, olderHiddenCount: older.length };
  }, [filter, orders, freightMap, showOlder]);

  const hasAnyRows = activeRows.length > 0 || shippedVisible.length > 0 || olderHiddenCount > 0;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64 text-muted-foreground text-sm">
        Loading factory orders…
      </div>
    );
  }

  const renderCard = (o: FactoryOrderWithItems) => (
    <OrderCard
      key={o.id}
      order={o}
      allOrders={orders}
      allProducts={allProducts}
      boms={boms}
      freightMap={freightMap}
      todayIso={todayIso}
      isEditing={editingId === o.id}
      editValue={editValue}
      onStartEdit={startEdit}
      onChangeEdit={setEditValue}
      onSaveEdit={saveEdit}
      onCancelEdit={() => setEditingId(null)}
    />
  );

  return (
    // max-w-5xl matches the supplier FactoryOrdersList — keeps SKU rows
    // dense and scannable instead of stretching tiny numbers across wide
    // monitors.
    <div className="space-y-6 max-w-5xl">
      <NewFactoryOrderDialog open={newDialogOpen} onOpenChange={setNewDialogOpen} />
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Factory Orders</h1>
          <p className="text-muted-foreground">Orders placed with Nancy and YX</p>
        </div>
        <Button onClick={() => setNewDialogOpen(true)}>
          <Plus className="mr-2 h-4 w-4" />
          New Order
        </Button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard title="Open Orders" value={stats.openCount} subtitle="Not yet fully shipped" icon={Building2} iconColor="text-blue-400" />
        <StatCard title="Units In Production" value={stats.unitsInProduction.toLocaleString()} subtitle="Still being made" icon={Hourglass} iconColor="text-yellow-400" />
        <StatCard title="Units At Factory" value={stats.unitsAtFactory.toLocaleString()} subtitle="Finished, awaiting freight" icon={PackageCheck} iconColor="text-green-400" />
        <StatCard title="Open Value" value={`$${Math.round(stats.openValue).toLocaleString()}`} subtitle={`${Math.round(stats.progress)}% finished at factory`} icon={DollarSign} iconColor="text-amber-400" />
      </div>

      <Tabs value={filter} onValueChange={(v) => setFilter(v as FilterValue)}>
        <TabsList>
          <TabsTrigger value="all">All</TabsTrigger>
          {FILTERABLE_SUPPLIERS.map((s) => (
            <TabsTrigger key={s.code} value={s.code}>
              {s.label}
            </TabsTrigger>
          ))}
          <TabsTrigger value="in_production">In Production</TabsTrigger>
          <TabsTrigger value="finished">Finished at Factory</TabsTrigger>
          <TabsTrigger value="shipped">Shipped</TabsTrigger>
        </TabsList>
      </Tabs>

      {!hasAnyRows ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No factory orders match this filter.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {activeRows.map((o) => renderCard(o))}

          {shippedVisible.length > 0 && activeRows.length > 0 && (
            <div className="flex items-center gap-3 pt-2 text-[11px] uppercase tracking-wider text-muted-foreground">
              <div className="h-px flex-1 bg-border/60" />
              Completed
              <div className="h-px flex-1 bg-border/60" />
            </div>
          )}
          {shippedVisible.map((o) => renderCard(o))}

          {olderHiddenCount > 0 && (
            <button
              type="button"
              onClick={() => setShowOlder(true)}
              className="w-full rounded-lg border border-dashed border-border/60 py-2.5 text-xs text-muted-foreground hover:bg-muted/30 hover:text-foreground transition-colors"
            >
              Show {olderHiddenCount} older completed order{olderHiddenCount === 1 ? "" : "s"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// OrderCard — admin-side card mirroring the supplier portal's layout
// (single-row header with order#, status, dates, total callout; per-SKU
// progress rows with stacked bar + legend dots) with admin-only additions:
// inline order-number edit, supplier badge, per-line cost/value columns.
//
// Cards are clickable: clicking the card body navigates to the admin
// detail page (/inventory/factory-orders/:id). Interactive children
// (the order-number edit input, the unlink button, the linker Select,
// etc.) call e.stopPropagation() so navigation doesn't fire when
// operators want to edit-in-place. Keyboard nav: Enter / Space on the
// focused card activates the same navigation, mirroring the supplier
// portal's pattern.
// ---------------------------------------------------------------------------
function OrderCard({
  order,
  allOrders,
  allProducts,
  boms,
  freightMap,
  todayIso,
  isEditing,
  editValue,
  onStartEdit,
  onChangeEdit,
  onSaveEdit,
  onCancelEdit,
}: {
  order: FactoryOrderWithItems;
  allOrders: FactoryOrderWithItems[];
  allProducts: Array<{ id: string; sku: string }>;
  boms: ProductBomRow[];
  freightMap: FreightMap;
  todayIso: string;
  isEditing: boolean;
  editValue: string;
  onStartEdit: (orderId: string, current: string | null) => void;
  onChangeEdit: (v: string) => void;
  onSaveEdit: (orderId: string) => void;
  onCancelEdit: () => void;
}) {
  const navigate = useNavigate();
  const items = order.items ?? [];
  const rollup = getOrderRollup(order, freightMap);
  const derivedStatus = deriveOrderStatus(order, freightMap);

  function handleCardActivate() {
    navigate(`/inventory/factory-orders/${order.id}`);
  }

  // Compound-SKU sibling-order detection. Pulled in once per render via
  // the page-level boms + allOrders props (no per-card refetch). Drives
  // both the "missing component order" warning chip and the inline
  // linked-children panel rendered below the header.
  const missingComponents = useMemo(
    () => computeMissingComponents(order, allOrders, boms),
    [order, allOrders, boms],
  );
  const childOrders = useMemo(
    () => allOrders.filter((o) => o.parent_factory_order_id === order.id),
    [order.id, allOrders],
  );
  // Lookup for labeling missing components. Built from the full product
  // catalog so it covers component SKUs that have never been ordered as a
  // line item — those wouldn't otherwise resolve and would surface as
  // truncated-uuid placeholders in the warning popup.
  const skuByIdLookup = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of allProducts) map.set(p.id, p.sku);
    return map;
  }, [allProducts]);

  const orderTotal = rollup.total;
  const orderValue = items.reduce(
    (s, i) => s + (i.unit_cost ?? 0) * i.quantity_ordered,
    0,
  );
  const daysLeft =
    order.expected_completion && derivedStatus !== "shipped"
      ? differenceInDays(parseISO(order.expected_completion), new Date())
      : null;
  const isOverdue =
    daysLeft !== null && daysLeft < 0 && derivedStatus !== "shipped";

  const borderTone = derivedStatus === "shipped"
    ? "border-l-4 border-l-green-500/70"
    : isOverdue
      ? "border-l-4 border-l-red-500/70"
      : "border-l-4 border-l-primary/50";

  return (
    <Card
      className={`${borderTone} cursor-pointer transition-colors hover:bg-accent/20 focus-within:ring-2 focus-within:ring-primary/40`}
      role="button"
      tabIndex={0}
      onClick={handleCardActivate}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          // Don't navigate if the user is interacting with an input/select
          // inside the card (the order-number edit input, etc.) — those
          // already trap their own Enter/Escape.
          const target = e.target as HTMLElement;
          if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "BUTTON" || target.tagName === "SELECT") return;
          e.preventDefault();
          handleCardActivate();
        }
      }}
    >
      <CardContent className="p-0">
        {/* Header — single-row dense layout. Identity cluster (order#,
            supplier, status, dates) on the left; total units + value $
            callout on the right. */}
        <div className="flex items-center justify-between gap-4 px-5 py-2.5 border-b border-border/80 bg-muted/30">
          <div className="min-w-0 flex-1 flex items-center gap-3 flex-wrap">
            {/* Order # — inline editable. Pencil shows on hover. The
                wrapper div stops click/keydown propagation so editing
                doesn't trigger the card-level navigation handler. */}
            <div
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
            >
              {isEditing ? (
                <div className="flex items-center gap-1">
                  <Input
                    value={editValue}
                    onChange={(e) => onChangeEdit(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") onSaveEdit(order.id);
                      if (e.key === "Escape") onCancelEdit();
                    }}
                    autoFocus
                    placeholder="e.g. NAN-2026-043"
                    className="h-7 text-xs w-44 font-mono"
                  />
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7"
                    onClick={() => onSaveEdit(order.id)}
                  >
                    <Check className="h-3.5 w-3.5 text-green-400" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7"
                    onClick={onCancelEdit}
                  >
                    <X className="h-3.5 w-3.5 text-muted-foreground" />
                  </Button>
                </div>
              ) : (
                <button
                  onClick={() => onStartEdit(order.id, order.order_number)}
                  className="group inline-flex items-center gap-1.5 font-mono text-sm font-semibold hover:text-primary"
                  title="Click to edit order number"
                >
                  {order.order_number ?? (
                    <span className="italic text-muted-foreground/60 font-normal">
                      awaiting order #
                    </span>
                  )}
                  <Pencil className="h-3 w-3 opacity-0 group-hover:opacity-100 transition-opacity" />
                </button>
              )}
            </div>

            {/* Supplier badge — admin-only context */}
            <Badge variant="outline" className="text-[10px] py-0">
              {order.supplier?.name ?? "—"}
            </Badge>

            {/* Derived status */}
            <Badge
              variant="outline"
              className={`${STATUS_COLOR[derivedStatus] ?? ""} text-[10px] py-0`}
            >
              {derivedStatus.replace("_", " ")}
            </Badge>

            {/* Days-left chip (overdue / warning / muted). Replaces the
                "Days Left" column from the old table. */}
            {daysLeft !== null && (
              <Badge
                variant="outline"
                className={`text-[10px] py-0 tabular-nums gap-1 ${
                  daysLeft < 0
                    ? "border-red-500/40 text-red-400"
                    : daysLeft < 5
                      ? "border-amber-500/40 text-amber-400"
                      : "border-border text-muted-foreground"
                }`}
              >
                {daysLeft < 0 && <AlarmClock className="h-3 w-3" />}
                {daysLeft < 0 ? `${Math.abs(daysLeft)}d late` : `${daysLeft}d left`}
              </Badge>
            )}

            {/* Missing component-order warning. Fires when this order's
                line items have BoM-driven produced components that aren't
                covered by a sibling factory_order parented to this one.
                Click to expand the linker panel below the header. */}
            {missingComponents.length > 0 && (
              <Badge
                variant="outline"
                className="text-[10px] py-0 gap-1 border-red-500/50 text-red-400 bg-red-500/10"
                title={`Missing component orders: ${missingComponents
                  .map(
                    (m) =>
                      `${skuByIdLookup.get(m.componentSkuId) ?? m.componentSkuId.slice(0, 8)} (${m.qtyShort} short)`,
                  )
                  .join(", ")}`}
              >
                <AlertTriangle className="h-3 w-3" />
                missing {missingComponents.length === 1 ? "component" : "components"}
              </Badge>
            )}

            {/* "Fulfills parent" badge — when this order is a child. */}
            {order.parent_factory_order_id && (
              <Badge
                variant="outline"
                className="text-[10px] py-0 gap-1 border-blue-500/40 text-blue-400"
                title="This order fulfills a component requirement of another order"
              >
                <LinkIcon className="h-3 w-3" />
                child order
              </Badge>
            )}

            <span className="text-xs text-muted-foreground tabular-nums">
              <span className="text-muted-foreground/60">Ordered</span>{" "}
              {order.order_date ? format(parseISO(order.order_date), "MMM d") : "—"}
              <span className="mx-1.5 text-border">·</span>
              <span className="text-muted-foreground/60">Expected</span>{" "}
              {order.expected_completion
                ? format(parseISO(order.expected_completion), "MMM d")
                : "—"}
            </span>
          </div>

          {/* Totals callout — units primary, value secondary. Admin-only
              cost visibility lives here. */}
          <div className="text-right shrink-0">
            <div className="text-xl font-semibold tabular-nums leading-none">
              {orderTotal.toLocaleString()}
              <span className="ml-1 text-[10px] text-muted-foreground uppercase tracking-wider font-normal">
                units
              </span>
            </div>
            {orderValue > 0 && (
              <div className="text-xs text-amber-400/90 mt-1 tabular-nums">
                ${orderValue.toLocaleString()}
              </div>
            )}
          </div>
        </div>

        {/* Component-orders panel — only renders for parent orders that
            have BoM-driven components (compound SKUs). Shows linked
            children inline + a linker for any missing components. The
            panel is admin-only context (the supplier portal renders an
            equivalent read-only block on its own order detail). */}
        {(missingComponents.length > 0 || childOrders.length > 0) && (
          <ComponentOrdersPanel
            order={order}
            allOrders={allOrders}
            childOrders={childOrders}
            missingComponents={missingComponents}
            skuByIdLookup={skuByIdLookup}
          />
        )}

        {/* SKU rows — progress-bar driven, same shape as supplier portal
            with an admin-only per-line value column on the right. */}
        <div className="divide-y divide-border/50">
          {items.length === 0 ? (
            <div className="px-5 py-5 text-center text-xs text-muted-foreground italic">
              No line items on this order.
            </div>
          ) : (
            items.map((item) => (
              <SkuRow
                key={item.id}
                item={item}
                parent={order}
                freightMap={freightMap}
                todayIso={todayIso}
                orderMissing={missingComponents}
                boms={boms}
                skuByIdLookup={skuByIdLookup}
              />
            ))
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// SkuRow — SKU left, stacked progress bar + ratio center, per-line value
// $ right. Bar segments mirror the supplier portal: shipped (slate),
// finished-awaiting (green), in-production (amber), breakage (red).
// ---------------------------------------------------------------------------
function SkuRow({
  item,
  parent,
  freightMap,
  todayIso,
  orderMissing,
  boms,
  skuByIdLookup,
}: {
  item: FactoryOrderWithItems["items"][0];
  parent: FactoryOrderWithItems;
  freightMap: FreightMap;
  todayIso: string;
  /** Order-wide missing components, computed once at the OrderCard level. */
  orderMissing: Array<{
    componentSkuId: string;
    qtyNeeded: number;
    qtyOrdered: number;
    qtyShort: number;
  }>;
  boms: ProductBomRow[];
  skuByIdLookup: Map<string, string>;
}) {
  const r = rollupForItem(item, parent, freightMap);
  const { total, inProduction, finishedAwaiting, shipped, breakage } = r;
  const lineValue = (item.unit_cost ?? 0) * item.quantity_ordered;

  // Per-line missing: filter the order-wide missing list down to components
  // whose BoM parent matches THIS line item's sku. A line is flagged if
  // any of its expected components is short across linked child orders.
  const lineMissing = orderMissing.filter((m) =>
    boms.some(
      (b) => b.parent_sku_id === item.sku_id && b.component_sku_id === m.componentSkuId,
    ),
  );

  // Per-line overdue: line-level override (alternate_expected_completion)
  // or parent.expected_completion has passed AND not already accounted
  // for. Same definition as the supplier card.
  const eta = item.alternate_expected_completion ?? parent.expected_completion;
  const accountedFor = finishedAwaiting + shipped + breakage;
  const lineOverdue =
    !!eta && eta < todayIso && accountedFor < total;

  const pct = (n: number) => (total > 0 ? (n / total) * 100 : 0);
  const shippedPct = pct(shipped);
  const finishedPct = pct(finishedAwaiting);
  const inProdPct = pct(inProduction);
  const breakagePct = pct(breakage);

  return (
    <div className={`px-5 py-3.5 ${lineOverdue ? "bg-red-500/5" : ""}`}>
      <div className="flex items-center gap-4">
        {/* SKU identity — fixed left column for visual alignment.
            When this line item's SKU has BoM-driven components missing
            from linked child orders, render an inline warning icon to
            the left of the SKU code so the operator can see at-a-glance
            which line is the problem without reading the chip in the
            header. Tooltip lists every short component + qty. */}
        <div className="w-48 shrink-0 min-w-0">
          {item.product ? (
            <>
              <div className="font-mono text-sm truncate flex items-center gap-1.5">
                {lineMissing.length > 0 && (
                  <span
                    className="inline-flex items-center text-red-400 shrink-0"
                    title={`Missing component order(s): ${lineMissing
                      .map(
                        (m) =>
                          `${skuByIdLookup.get(m.componentSkuId) ?? "?"} (${m.qtyShort.toLocaleString()} short)`,
                      )
                      .join(", ")}`}
                  >
                    <AlertTriangle className="h-3.5 w-3.5" />
                  </span>
                )}
                <span className="truncate">{item.product.sku}</span>
              </div>
              <div className="text-xs text-muted-foreground truncate">
                {item.product.product_name}
              </div>
            </>
          ) : (
            <span className="font-mono text-xs text-muted-foreground">
              {item.sku_id.slice(0, 8)}…
            </span>
          )}
        </div>

        {/* Progress bar + total ratio */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-3">
            <div className="flex-1 h-2.5 rounded-full bg-muted/50 overflow-hidden flex">
              {shippedPct > 0 && (
                <div
                  className="bg-slate-400"
                  style={{ width: `${shippedPct}%` }}
                  title={`${shipped} shipped`}
                />
              )}
              {finishedPct > 0 && (
                <div
                  className="bg-green-500"
                  style={{ width: `${finishedPct}%` }}
                  title={`${finishedAwaiting} finished, awaiting shipment`}
                />
              )}
              {inProdPct > 0 && (
                <div
                  className="bg-amber-500"
                  style={{ width: `${inProdPct}%` }}
                  title={`${inProduction} in production`}
                />
              )}
              {breakagePct > 0 && (
                <div
                  className="bg-red-500/60"
                  style={{ width: `${breakagePct}%` }}
                  title={`${breakage} breakage`}
                />
              )}
            </div>
            <div className="text-sm font-semibold tabular-nums shrink-0 w-24 text-right">
              {(finishedAwaiting + shipped).toLocaleString()}
              <span className="text-muted-foreground font-normal">
                {" / "}
                {total.toLocaleString()}
              </span>
            </div>
          </div>
          <div className="mt-1.5 flex gap-3 text-[11px] tabular-nums flex-wrap">
            {inProduction > 0 && (
              <LegendItem color="bg-amber-500" label={`${inProduction.toLocaleString()} in prod`} />
            )}
            {finishedAwaiting > 0 && (
              <LegendItem color="bg-green-500" label={`${finishedAwaiting.toLocaleString()} at factory`} />
            )}
            {shipped > 0 && (
              <LegendItem color="bg-slate-400" label={`${shipped.toLocaleString()} shipped`} />
            )}
            {breakage > 0 && (
              <LegendItem color="bg-red-500/60" label={`${breakage.toLocaleString()} broken`} />
            )}
          </div>
        </div>

        {/* Per-line value — admin-only cost visibility, replaces the old
            Value column at the order level. */}
        <div className="w-28 shrink-0 text-right">
          {lineValue > 0 ? (
            <>
              <div className="text-sm tabular-nums">${lineValue.toLocaleString()}</div>
              <div className="text-[10px] text-muted-foreground uppercase tracking-wider mt-0.5">
                value
              </div>
            </>
          ) : (
            <span className="text-muted-foreground text-xs">—</span>
          )}
        </div>
      </div>
    </div>
  );
}

function LegendItem({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-muted-foreground">
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${color}`} />
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// ComponentOrdersPanel — inline inside OrderCard. Renders for parent orders
// of compound SKUs (BoM-driven). Two columns visually:
//
//   Left:  list of currently-linked child orders (read-only metadata + an
//          unlink button per row).
//   Right: per missing component, a small Select picker that lets the admin
//          link an existing factory_order to this parent. Picker options are
//          factory_orders that contain the missing component SKU AND are not
//          already parented to anyone else.
//
// Once Phase 2 (auto-create from NewFactoryOrderDialog) lands, the linker
// becomes mostly a backfill / correction affordance — most orders will
// arrive already linked. Today it's the primary mechanism.
// ---------------------------------------------------------------------------
function ComponentOrdersPanel({
  order,
  allOrders,
  childOrders,
  missingComponents,
  skuByIdLookup,
}: {
  order: FactoryOrderWithItems;
  allOrders: FactoryOrderWithItems[];
  childOrders: FactoryOrderWithItems[];
  missingComponents: Array<{
    componentSkuId: string;
    qtyNeeded: number;
    qtyOrdered: number;
    qtyShort: number;
  }>;
  skuByIdLookup: Map<string, string>;
}) {
  const linkMut = useLinkFactoryOrderToParent();
  const unlinkMut = useUnlinkFactoryOrderFromParent();
  const [linkError, setLinkError] = useState<string | null>(null);

  // Candidate orders for linking, per missing component SKU. Filter:
  //   - contains a line item for the component SKU
  //   - has no parent yet (avoid stealing from another order)
  //   - is not the parent itself
  function candidatesFor(componentSkuId: string): FactoryOrderWithItems[] {
    return allOrders.filter(
      (o) =>
        o.id !== order.id &&
        !o.parent_factory_order_id &&
        o.items.some((i) => i.sku_id === componentSkuId),
    );
  }

  async function handleLink(childOrderId: string) {
    setLinkError(null);
    try {
      await linkMut.mutateAsync({ childOrderId, parentOrderId: order.id });
    } catch (err) {
      setLinkError(err instanceof Error ? err.message : "Link failed");
    }
  }

  async function handleUnlink(childOrderId: string) {
    setLinkError(null);
    try {
      await unlinkMut.mutateAsync({ childOrderId });
    } catch (err) {
      setLinkError(err instanceof Error ? err.message : "Unlink failed");
    }
  }

  return (
    <div
      className="px-5 py-3 bg-muted/20 border-b border-border/40 space-y-2"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-muted-foreground/80 font-medium">
        <LinkIcon className="h-3 w-3" />
        Component orders
      </div>

      {/* Linked children */}
      {childOrders.length > 0 && (
        <div className="space-y-1">
          {childOrders.map((c) => (
            <div
              key={c.id}
              className="flex items-center gap-2 text-xs px-2 py-1 rounded bg-background/60 border border-border/60"
            >
              <Badge variant="outline" className="text-[10px] py-0 border-blue-500/40 text-blue-400">
                {c.supplier?.code ?? "—"}
              </Badge>
              <span className="font-mono">
                {c.order_number ?? <span className="italic text-muted-foreground/60">awaiting #</span>}
              </span>
              <span className="text-muted-foreground">·</span>
              <span className="text-muted-foreground">{c.status.replace("_", " ")}</span>
              {c.expected_completion && (
                <>
                  <span className="text-muted-foreground">·</span>
                  <span className="text-muted-foreground tabular-nums">
                    ETA {format(parseISO(c.expected_completion), "MMM d")}
                  </span>
                </>
              )}
              <span className="text-muted-foreground">·</span>
              <span className="tabular-nums">
                {c.items
                  .map((i) => `${i.quantity_ordered} ${i.product?.sku ?? "?"}`)
                  .join(", ")}
              </span>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 ml-auto"
                onClick={() => handleUnlink(c.id)}
                disabled={unlinkMut.isPending}
                title="Unlink this child order"
              >
                <Unlink className="h-3 w-3 text-muted-foreground" />
              </Button>
            </div>
          ))}
        </div>
      )}

      {/* Missing components — one picker row per missing SKU */}
      {missingComponents.map((m) => {
        const candidates = candidatesFor(m.componentSkuId);
        const skuLabel = skuByIdLookup.get(m.componentSkuId) ?? m.componentSkuId.slice(0, 8);
        return (
          <div
            key={m.componentSkuId}
            className="flex items-center gap-2 text-xs px-2 py-1 rounded bg-red-500/5 border border-red-500/20"
          >
            <AlertTriangle className="h-3 w-3 text-red-400 shrink-0" />
            <span className="font-medium text-red-400">{skuLabel}</span>
            <span className="text-muted-foreground tabular-nums">
              need {m.qtyNeeded.toLocaleString()}
              {m.qtyOrdered > 0 && (
                <>
                  , linked {m.qtyOrdered.toLocaleString()}, short{" "}
                  <span className="text-red-400">{m.qtyShort.toLocaleString()}</span>
                </>
              )}
            </span>
            <div className="ml-auto w-64">
              {candidates.length === 0 ? (
                <span className="text-[10px] italic text-muted-foreground/60">
                  No unlinked orders for this SKU — place one first
                </span>
              ) : (
                <Select onValueChange={(id) => handleLink(id)}>
                  <SelectTrigger className="h-7 text-xs">
                    <SelectValue placeholder="Link existing order…" />
                  </SelectTrigger>
                  <SelectContent>
                    {candidates.map((c) => (
                      <SelectItem key={c.id} value={c.id} className="text-xs">
                        <span className="font-mono">{c.order_number ?? "(awaiting #)"}</span>
                        <span className="text-muted-foreground ml-2">
                          {c.supplier?.code} · {c.status.replace("_", " ")}
                          {c.expected_completion && (
                            <> · ETA {format(parseISO(c.expected_completion), "MMM d")}</>
                          )}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          </div>
        );
      })}

      {linkError && (
        <p className="text-[11px] text-red-400 px-2">{linkError}</p>
      )}
    </div>
  );
}
