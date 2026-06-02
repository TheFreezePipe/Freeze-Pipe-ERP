import { Link, useNavigate } from "react-router-dom";
import { useMemo, useState } from "react";
import { format, parseISO } from "date-fns";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  useSupplierFactoryOrders,
  useSupplierFreightRollupByItem,
  useProductBoms,
  useFactoryOrderComponentStatusBatch,
  missingComponentsForSku,
  isItemOverdue,
  type SupplierFactoryOrderRow,
  type SupplierFactoryOrderItemRow,
  type SupplierFactoryOrderWithItems,
  type ProductBomRow,
  type FactoryOrderComponentStatus,
} from "@/lib/hooks";
import {
  Plus,
  AlarmClock,
  ChevronDown,
  ChevronRight,
  Link as LinkIcon,
  AlertTriangle,
} from "lucide-react";

/** Freight rollup shape, exposed so the row component can render it. */
type FreightLine = {
  quantity: number;
  shipment: { id: string; shipment_number: string | null; status: string } | null;
};
type FreightMap = Map<string, FreightLine[]>;

const STATUS_COLOR: Record<SupplierFactoryOrderRow["status"], string> = {
  ordered: "bg-blue-500/10 text-blue-400 border-blue-500/30",
  in_production: "bg-amber-500/10 text-amber-400 border-amber-500/30",
  finished: "bg-green-500/10 text-green-400 border-green-500/30",
  shipped: "bg-slate-500/10 text-slate-400 border-slate-500/30",
  canceled: "bg-red-500/10 text-red-400 border-red-500/30",
};

/**
 * Per-item rollup in the order × SKU view. Shipped is derived from freight
 * lines (sum of `quantity` across freight_line_items linked to this item).
 * Finished-awaiting = producer's reported finished count minus what's
 * already been shipped. In-production = everything not yet finished.
 *
 * Breakage isn't its own column here — it's the "dead" segment of the
 * progress bar (total - inProd - finished - shipped).
 */
interface ItemRollup {
  total: number;
  inProduction: number;
  finishedAwaiting: number;
  shipped: number;
  breakage: number;
  shipments: Array<{ id: string; shipment_number: string | null; status: string }>;
  /** True when this line has nothing left to ship (finished, received and fully shipped). */
  fullyShipped: boolean;
}

function rollupForItem(
  item: SupplierFactoryOrderItemRow,
  parent: SupplierFactoryOrderRow,
  freightMap: FreightMap,
): ItemRollup {
  const total = item.quantity_ordered;
  const breakage = item.quantity_breakage ?? 0;

  const shipmentMap = new Map<string, { id: string; shipment_number: string | null; status: string }>();
  let shippedQty = 0;
  for (const line of freightMap.get(item.id) ?? []) {
    shippedQty += line.quantity;
    if (line.shipment) shipmentMap.set(line.shipment.id, line.shipment);
  }

  // Effective finished count. Two data sources:
  //   1. item.quantity_finished — authoritative per-item signal from
  //      rpc_supplier_report_item_finished (migration 030).
  //   2. parent.status — orders moved to 'finished'/'shipped' without a
  //      per-item backfill imply the non-breakage balance is finished.
  const reportedFinished = item.quantity_finished ?? 0;
  const statusImpliesFinished = parent.status === "finished" || parent.status === "shipped";
  // Shipped units have necessarily been finished — floor completion at the
  // shipped count so shipped units aren't double-counted as in-production
  // (which renders a half-grey/half-amber bar) when quantity_finished
  // wasn't backfilled before freight was attributed.
  const effectiveFinished = statusImpliesFinished
    ? Math.max(reportedFinished, total - breakage)
    : Math.max(reportedFinished, shippedQty);

  const finishedAwaiting = Math.max(0, effectiveFinished - shippedQty);
  const inProduction = Math.max(0, total - effectiveFinished - breakage);
  const accountedFor = shippedQty + breakage;
  const fullyShipped = total > 0 && accountedFor >= total;

  return {
    total,
    inProduction,
    finishedAwaiting,
    shipped: shippedQty,
    breakage,
    shipments: Array.from(shipmentMap.values()),
    fullyShipped,
  };
}

function orderFullyShipped(
  order: SupplierFactoryOrderWithItems,
  freightMap: FreightMap,
): boolean {
  const items = order.items ?? [];
  if (items.length === 0) return false;
  return items.every((it) => rollupForItem(it, order, freightMap).fullyShipped);
}

export default function FactoryOrdersList() {
  const { data, isLoading, error } = useSupplierFactoryOrders();
  const { data: boms = [] } = useProductBoms();
  const todayIso = useMemo(() => new Date().toISOString().slice(0, 10), []);

  // Batch component-status RPC across every parent order this supplier
  // can see. Single round trip; result is keyed by parent order id and
  // feeds the per-SKU missing-component icon. Disabled (empty array)
  // when no orders are loaded yet — query won't fire.
  const allParentIds = useMemo(
    () => (data ?? []).map((o) => o.id),
    [data],
  );
  const { data: componentStatusByOrderId = new Map<string, FactoryOrderComponentStatus>() } =
    useFactoryOrderComponentStatusBatch(allParentIds);

  const allItemIds = useMemo(
    () => (data ?? []).flatMap((o) => (o.items ?? []).map((i) => i.id)),
    [data],
  );
  const freightRollup = useSupplierFreightRollupByItem(
    allItemIds.length > 0 ? allItemIds : undefined,
  );
  const freightMap: FreightMap = freightRollup.data ?? new Map();

  const [olderShown, setOlderShown] = useState(0);

  if (isLoading) return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;
  if (error) return <div className="p-6 text-sm text-red-400">Error loading orders.</div>;

  const allOrders = data ?? [];

  const active: SupplierFactoryOrderWithItems[] = [];
  const completed: SupplierFactoryOrderWithItems[] = [];
  for (const o of allOrders) {
    if (orderFullyShipped(o, freightMap)) completed.push(o);
    else active.push(o);
  }
  const cmp = (a: SupplierFactoryOrderWithItems, b: SupplierFactoryOrderWithItems) =>
    a.order_date.localeCompare(b.order_date);
  active.sort(cmp);
  completed.sort((a, b) => b.order_date.localeCompare(a.order_date));

  const revealedCompleted = completed.slice(0, olderShown).slice().sort(cmp);
  const displayed = [...revealedCompleted, ...active].sort(cmp);

  const totalHidden = Math.max(0, completed.length - olderShown);
  const revealBatch = Math.min(10, totalHidden);

  return (
    // max-w-5xl caps the reading width so the SKU rows don't spread into
    // wide-flat strips of tiny numbers on large monitors.
    <div className="space-y-4 max-w-5xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Factory Orders</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Oldest first. Completed orders are hidden — use the button below to bring older ones back.
          </p>
        </div>
        <Button asChild>
          <Link to="/supplier/orders/new">
            <Plus className="mr-2 h-4 w-4" />
            New Order
          </Link>
        </Button>
      </div>

      {displayed.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            {allOrders.length === 0
              ? "No orders yet. Click New Order to create one."
              : "No active orders. Every order has fully shipped — click \"Show older orders\" to review history."}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {displayed.map((order) => (
            <OrderCard
              key={order.id}
              order={order}
              todayIso={todayIso}
              freightMap={freightMap}
              boms={boms}
              componentStatus={componentStatusByOrderId.get(order.id) ?? null}
            />
          ))}
        </div>
      )}

      {totalHidden > 0 && (
        <div className="flex justify-center pt-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setOlderShown((n) => n + revealBatch)}
          >
            <ChevronDown className="mr-1.5 h-4 w-4" />
            Show older orders ({totalHidden} hidden)
          </Button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// OrderCard — one card per order with an emphasized header (order#, status,
// dates, total-units callout) and per-SKU rows that use a stacked progress
// bar to show in-prod / finished-awaiting / shipped proportions at a glance.
// ---------------------------------------------------------------------------
function OrderCard({
  order,
  todayIso,
  freightMap,
  boms,
  componentStatus,
}: {
  order: SupplierFactoryOrderWithItems;
  todayIso: string;
  freightMap: FreightMap;
  boms: ProductBomRow[];
  /** RPC-provided component status for this order. Null when the order
   * has no BoM components, or while the batch RPC is still loading. */
  componentStatus: FactoryOrderComponentStatus | null;
}) {
  const navigate = useNavigate();
  const items = order.items ?? [];
  const overdueCount = items.filter((it) => isItemOverdue(it, order, todayIso)).length;

  // Does this order include any compound SKUs? If so, Nancy needs to
  // check the detail page for YX-side component status before assembly.
  // We only flag presence here (cheap client-side join over already-loaded
  // boms); real fulfilled-vs-needed math lives on the detail panel which
  // calls the cross-supplier RPC.
  const compoundLineCount = items.filter((it) =>
    boms.some((b) => b.parent_sku_id === it.sku_id),
  ).length;

  // Order-level total (for the header callout). Excludes breakage from the
  // "live" count — those units aren't coming.
  const orderTotal = items.reduce((sum, it) => sum + it.quantity_ordered, 0);

  const borderTone =
    overdueCount > 0
      ? "border-l-4 border-l-red-500/70"
      : "border-l-4 border-l-primary/50";

  function handleCardActivate() {
    navigate(`/supplier/orders/${order.id}`);
  }

  return (
    <Card
      className={`${borderTone} cursor-pointer transition-colors hover:bg-accent/20 focus-within:ring-2 focus-within:ring-primary/40`}
      role="button"
      tabIndex={0}
      onClick={handleCardActivate}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          handleCardActivate();
        }
      }}
    >
      <CardContent className="p-0">
        {/* Header block — single-row layout (identity + dates + total) for
            a minimal vertical footprint. */}
        <div className="flex items-center justify-between gap-4 px-5 py-2.5 border-b border-border/80 bg-muted/30">
          <div className="min-w-0 flex-1 flex items-center gap-3 flex-wrap">
            <span className="font-mono text-sm font-semibold">
              {order.order_number ?? (
                <span className="italic text-muted-foreground font-normal">
                  awaiting order #
                </span>
              )}
            </span>
            <Badge
              variant="outline"
              className={`${STATUS_COLOR[order.status]} text-[10px] py-0`}
            >
              {order.status.replace("_", " ")}
            </Badge>
            {overdueCount > 0 && (
              <Badge
                variant="outline"
                className="border-red-500/40 text-red-400 gap-1 text-[10px] py-0"
              >
                <AlarmClock className="h-3 w-3" />
                {overdueCount} overdue
              </Badge>
            )}
            {compoundLineCount > 0 && (
              <Badge
                variant="outline"
                className="border-blue-500/40 text-blue-400 gap-1 text-[10px] py-0"
                title="One or more line items needs component parts from another supplier — open the order to see component status."
              >
                <LinkIcon className="h-3 w-3" />
                assembly required
              </Badge>
            )}
            <span className="text-xs text-muted-foreground tabular-nums">
              <span className="text-muted-foreground/60">Ordered</span>{" "}
              {format(parseISO(order.order_date), "MMM d")}
              <span className="mx-1.5 text-border">·</span>
              <span className="text-muted-foreground/60">Expected</span>{" "}
              {order.expected_completion
                ? format(parseISO(order.expected_completion), "MMM d")
                : "—"}
            </span>
          </div>
          <div className="text-right shrink-0 flex items-baseline gap-1.5">
            <span className="text-xl font-semibold tabular-nums leading-none">
              {orderTotal.toLocaleString()}
            </span>
            <span className="text-[10px] text-muted-foreground uppercase tracking-wider">
              units
            </span>
          </div>
        </div>

        {/* SKU rows — one per line item, progress bar driven */}
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
                todayIso={todayIso}
                freightMap={freightMap}
                componentStatus={componentStatus}
                boms={boms}
              />
            ))
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// SkuRow — SKU info on the left, a stacked progress bar spanning the middle
// with the total/shipped ratio, and shipment chips on the right. Breakdown
// counts appear as a compact legend only when nonzero.
// ---------------------------------------------------------------------------
function SkuRow({
  item,
  parent,
  todayIso,
  freightMap,
  componentStatus,
  boms,
}: {
  item: SupplierFactoryOrderItemRow;
  parent: SupplierFactoryOrderRow;
  todayIso: string;
  freightMap: FreightMap;
  /** RPC-provided component status for the parent order. Null when the
   * order has no BoM components or while loading. */
  componentStatus: FactoryOrderComponentStatus | null;
  boms: ProductBomRow[];
}) {
  const rollup = rollupForItem(item, parent, freightMap);
  const overdue = isItemOverdue(item, parent, todayIso);
  const { total, inProduction, finishedAwaiting, shipped, breakage } = rollup;

  // Per-line missing components — driven by the cross-supplier RPC
  // (Nancy can't directly read YX child orders; the RPC bridges that).
  // Returns [] when this SKU has no BoM rows or all expected components
  // are covered by linked child orders.
  const lineMissing = missingComponentsForSku(
    item.sku_id,
    item.quantity_ordered,
    componentStatus,
    boms,
  );

  // Segment widths as percentages. Order in the bar: shipped (darkest) →
  // finished (green, "ready to ship") → in prod (amber, "still making") →
  // breakage (red, accounted-for-but-dead). Remaining = transparent.
  const pct = (n: number) => (total > 0 ? (n / total) * 100 : 0);
  const shippedPct = pct(shipped);
  const finishedPct = pct(finishedAwaiting);
  const inProdPct = pct(inProduction);
  const breakagePct = pct(breakage);

  return (
    <div className={`px-5 py-3.5 ${overdue ? "bg-red-500/5" : ""}`}>
      <div className="flex items-center gap-4">
        {/* SKU identity — fixed left column so rows line up visually.
            Inline warning icon when the parent order has BoM-driven
            components missing (e.g. Nancy's BW58B line waiting on a
            YX HT-5 order to be placed/linked). Tooltip lists the
            shortfall per component so Nancy knows which part to
            chase. */}
        <div className="w-48 shrink-0 min-w-0">
          {item.sku ? (
            <>
              <div className="font-mono text-sm truncate flex items-center gap-1.5">
                {lineMissing.length > 0 && (
                  <span
                    className="inline-flex items-center text-red-400 shrink-0"
                    title={`Missing component order(s): ${lineMissing
                      .map(
                        (m) =>
                          `${m.componentSku} (${m.qtyShort.toLocaleString()} short)`,
                      )
                      .join(", ")}`}
                  >
                    <AlertTriangle className="h-3.5 w-3.5" />
                  </span>
                )}
                <span className="truncate">{item.sku.sku}</span>
              </div>
              <div className="text-xs text-muted-foreground truncate">
                {item.sku.product_name}
              </div>
            </>
          ) : (
            <span className="font-mono text-xs text-muted-foreground">
              {item.sku_id.slice(0, 8)}…
            </span>
          )}
        </div>

        {/* Progress bar + total callout */}
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
          {/* Compact legend — only shows segments that exist */}
          <div className="mt-1.5 flex gap-3 text-[11px] tabular-nums flex-wrap">
            {inProduction > 0 && (
              <LegendItem color="bg-amber-500" label={`${inProduction.toLocaleString()} in prod`} />
            )}
            {finishedAwaiting > 0 && (
              <LegendItem color="bg-green-500" label={`${finishedAwaiting.toLocaleString()} ready`} />
            )}
            {shipped > 0 && (
              <LegendItem color="bg-slate-400" label={`${shipped.toLocaleString()} shipped`} />
            )}
            {breakage > 0 && (
              <LegendItem color="bg-red-500/60" label={`${breakage.toLocaleString()} broken`} />
            )}
          </div>
        </div>

        {/* Shipment chips — compact, right-aligned */}
        <div className="w-36 shrink-0 text-right">
          {rollup.shipments.length === 0 ? (
            <span className="text-muted-foreground text-xs">—</span>
          ) : (
            <div className="flex flex-wrap gap-1 justify-end">
              {rollup.shipments.map((s) => (
                <Link
                  key={s.id}
                  to={`/supplier/shipments?highlight=${s.id}`}
                  className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[10px] font-mono hover:bg-accent/50 max-w-full"
                  title={`Status: ${s.status.replace(/_/g, " ")}`}
                  onClick={(e) => e.stopPropagation()}
                >
                  <span className="truncate">{s.shipment_number ?? s.id.slice(0, 8)}</span>
                  <ChevronRight className="h-2.5 w-2.5 shrink-0" />
                </Link>
              ))}
            </div>
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
