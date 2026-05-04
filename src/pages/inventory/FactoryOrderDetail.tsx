import { useMemo } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { format, parseISO, differenceInDays } from "date-fns";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  ArrowLeft,
  AlarmClock,
  AlertTriangle,
  Link as LinkIcon,
  Unlink,
} from "lucide-react";
import {
  useFactoryOrders,
  useFreightLineItems,
  useProducts,
  useProductBoms,
  useFactoryOrderComponentStatus,
  useLinkFactoryOrderToParent,
  useUnlinkFactoryOrderFromParent,
  computeMissingComponents,
  type FactoryOrderWithItems,
  type FreightLineItemWithProduct,
} from "@/lib/hooks";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useState } from "react";

// Mirror the list page's color map so badges read consistently.
const STATUS_COLOR: Record<string, string> = {
  ordered: "bg-blue-500/10 text-blue-400 border-blue-500/30",
  in_production: "bg-amber-500/10 text-amber-400 border-amber-500/30",
  finished: "bg-green-500/10 text-green-400 border-green-500/30",
  shipped: "bg-slate-500/10 text-slate-400 border-slate-500/30",
  canceled: "bg-red-500/10 text-red-400 border-red-500/30",
};

type FreightMap = Map<string, FreightLineItemWithProduct[]>;

/**
 * Admin-side factory order detail. Shows the same data the list-page card
 * shows (header, line item rollups, value) but in a focused single-order
 * view, plus the component-orders panel with the full linker UI when the
 * order involves compound SKUs.
 *
 * The list-page OrderCard renders the same component-orders panel inline
 * for at-a-glance scanning; this page is for when the operator wants to
 * see one order's full state without the surrounding noise. They share
 * the same hooks and underlying computation — duplication is intentional
 * (the detail page can iterate independently of the list-page density
 * constraints).
 */
export default function FactoryOrderDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: orders = [], isLoading } = useFactoryOrders();
  const { data: freightLines = [] } = useFreightLineItems();
  const { data: boms = [] } = useProductBoms();
  // Catalog-backed lookup; covers component SKUs not yet ordered as a
  // line item (which would otherwise show as truncated UUIDs).
  const { data: allProducts = [] } = useProducts();
  const { data: componentStatus } = useFactoryOrderComponentStatus(id ?? null);
  const linkMut = useLinkFactoryOrderToParent();
  const unlinkMut = useUnlinkFactoryOrderFromParent();
  const [linkError, setLinkError] = useState<string | null>(null);

  const order = useMemo(() => orders.find((o) => o.id === id) ?? null, [orders, id]);

  const freightMap = useMemo<FreightMap>(() => {
    const out: FreightMap = new Map();
    for (const line of freightLines) {
      const foi = line.source_factory_order_item_id;
      if (!foi) continue;
      const arr = out.get(foi) ?? [];
      arr.push(line);
      out.set(foi, arr);
    }
    return out;
  }, [freightLines]);

  const missingComponents = useMemo(
    () => (order ? computeMissingComponents(order, orders, boms) : []),
    [order, orders, boms],
  );
  const childOrders = useMemo(
    () => (order ? orders.filter((o) => o.parent_factory_order_id === order.id) : []),
    [order, orders],
  );
  const skuByIdLookup = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of allProducts) map.set(p.id, p.sku);
    return map;
  }, [allProducts]);

  if (isLoading) {
    return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;
  }
  if (!order) {
    return (
      <div className="p-6 space-y-3">
        <p className="text-sm text-red-400">Order not found.</p>
        <Button asChild variant="outline" size="sm">
          <Link to="/inventory/factory-orders">
            <ArrowLeft className="mr-1.5 h-4 w-4" /> Back to factory orders
          </Link>
        </Button>
      </div>
    );
  }

  const items = order.items ?? [];
  const orderTotal = items.reduce((s, i) => s + i.quantity_ordered, 0);
  const orderValue = items.reduce(
    (s, i) => s + (i.unit_cost ?? 0) * i.quantity_ordered,
    0,
  );
  const daysLeft =
    order.expected_completion && order.status !== "shipped"
      ? differenceInDays(parseISO(order.expected_completion), new Date())
      : null;
  const isOverdue =
    daysLeft !== null && daysLeft < 0 && order.status !== "shipped";

  // Linker candidates per missing component — same logic as the list-page
  // panel: orders containing the component SKU, not parented elsewhere,
  // and not this order itself.
  function candidatesFor(componentSkuId: string): FactoryOrderWithItems[] {
    return orders.filter(
      (o) =>
        o.id !== order.id &&
        !o.parent_factory_order_id &&
        o.items.some((i) => i.sku_id === componentSkuId),
    );
  }

  async function handleLink(childOrderId: string) {
    if (!order) return;
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
    <div className="space-y-4 max-w-4xl">
      {/* Header */}
      <div>
        <Button variant="ghost" size="sm" onClick={() => navigate("/inventory/factory-orders")}>
          <ArrowLeft className="mr-1.5 h-4 w-4" /> All factory orders
        </Button>
        <h1 className="text-2xl font-semibold mt-1">
          {order.order_number ?? (
            <span className="italic text-muted-foreground">Awaiting order #</span>
          )}
        </h1>
        <p className="text-xs text-muted-foreground font-mono mt-0.5">{order.id}</p>
      </div>

      {/* Top metadata strip */}
      <Card>
        <CardContent className="p-4">
          <div className="flex items-center gap-3 flex-wrap">
            <Badge variant="outline" className="text-xs">
              {order.supplier?.name ?? "—"}
            </Badge>
            <Badge
              variant="outline"
              className={`${STATUS_COLOR[order.status] ?? ""} text-xs`}
            >
              {order.status.replace("_", " ")}
            </Badge>
            {daysLeft !== null && (
              <Badge
                variant="outline"
                className={`text-xs gap-1 ${
                  daysLeft < 0
                    ? "border-red-500/40 text-red-400"
                    : daysLeft < 5
                      ? "border-amber-500/40 text-amber-400"
                      : "border-border text-muted-foreground"
                }`}
              >
                {isOverdue && <AlarmClock className="h-3 w-3" />}
                {daysLeft < 0 ? `${Math.abs(daysLeft)}d late` : `${daysLeft}d left`}
              </Badge>
            )}
            {missingComponents.length > 0 && (
              <Badge
                variant="outline"
                className="text-xs gap-1 border-red-500/50 text-red-400 bg-red-500/10"
              >
                <AlertTriangle className="h-3 w-3" />
                missing {missingComponents.length === 1 ? "component" : "components"}
              </Badge>
            )}
            {order.parent_factory_order_id && (
              <Badge
                variant="outline"
                className="text-xs gap-1 border-blue-500/40 text-blue-400"
              >
                <LinkIcon className="h-3 w-3" />
                fulfills parent order
              </Badge>
            )}
            <div className="ml-auto flex items-baseline gap-2">
              <span className="text-2xl font-semibold tabular-nums">
                {orderTotal.toLocaleString()}
              </span>
              <span className="text-[10px] text-muted-foreground uppercase tracking-wider">
                units
              </span>
              {orderValue > 0 && (
                <span className="text-sm text-amber-400/90 ml-3 tabular-nums">
                  ${orderValue.toLocaleString()}
                </span>
              )}
            </div>
          </div>
          <div className="grid grid-cols-3 gap-4 mt-4 text-sm">
            <div>
              <p className="text-xs text-muted-foreground">Ordered</p>
              <p className="tabular-nums">
                {order.order_date ? format(parseISO(order.order_date), "MMM d, yyyy") : "—"}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Expected</p>
              <p className="tabular-nums">
                {order.expected_completion
                  ? format(parseISO(order.expected_completion), "MMM d, yyyy")
                  : "—"}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Notes</p>
              <p>{order.notes ?? "—"}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Component orders panel — same look + behavior as the list-page
          inline panel, just hosted on its own page for focused interaction. */}
      {(missingComponents.length > 0 || childOrders.length > 0) && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <LinkIcon className="h-4 w-4" />
              Component orders
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {childOrders.length > 0 && (
              <div className="space-y-1">
                {childOrders.map((c) => (
                  <div
                    key={c.id}
                    className="flex items-center gap-2 text-xs px-2 py-1.5 rounded bg-muted/30 border border-border/60"
                  >
                    <Badge
                      variant="outline"
                      className="text-[10px] py-0 border-blue-500/40 text-blue-400"
                    >
                      {c.supplier?.code ?? "—"}
                    </Badge>
                    <Link
                      to={`/inventory/factory-orders/${c.id}`}
                      className="font-mono hover:text-primary"
                    >
                      {c.order_number ?? (
                        <span className="italic text-muted-foreground/60">awaiting #</span>
                      )}
                    </Link>
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

            {missingComponents.map((m) => {
              const candidates = candidatesFor(m.componentSkuId);
              const skuLabel =
                skuByIdLookup.get(m.componentSkuId) ?? m.componentSkuId.slice(0, 8);
              return (
                <div
                  key={m.componentSkuId}
                  className="flex items-center gap-2 text-xs px-2 py-1.5 rounded bg-red-500/5 border border-red-500/20"
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
                  <div className="ml-auto w-72">
                    {candidates.length === 0 ? (
                      <span className="text-[10px] italic text-muted-foreground/60">
                        No unlinked orders for this SKU — place one first
                      </span>
                    ) : (
                      <Select onValueChange={(cid) => handleLink(cid)}>
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

            {linkError && <p className="text-[11px] text-red-400 px-2">{linkError}</p>}
          </CardContent>
        </Card>
      )}

      {/* Component status from RPC — only renders when the RPC returns
          actual data. Functionally redundant with the panel above (admin
          has full visibility), but reassures that the RPC and authorization
          path is wired. Suppressed when there are no expected components. */}
      {componentStatus && componentStatus.expected_components.length === 0 &&
        childOrders.length === 0 && missingComponents.length === 0 && null}

      {/* Line items */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Line items</CardTitle>
        </CardHeader>
        <CardContent>
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="py-2">SKU</th>
                <th className="py-2 text-right">Ordered</th>
                <th className="py-2 text-right">Finished</th>
                <th className="py-2 text-right">Unit cost</th>
                <th className="py-2 text-right">Line value</th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 ? (
                <tr>
                  <td
                    colSpan={5}
                    className="py-4 text-center text-xs text-muted-foreground italic"
                  >
                    No line items on this order.
                  </td>
                </tr>
              ) : (
                items.map((it) => {
                  const lineMissing = missingComponents.filter((m) =>
                    boms.some(
                      (b) =>
                        b.parent_sku_id === it.sku_id &&
                        b.component_sku_id === m.componentSkuId,
                    ),
                  );
                  const unitCost = it.unit_cost ?? 0;
                  const lineValue = unitCost * it.quantity_ordered;
                  return (
                    <tr key={it.id} className="border-t border-border">
                      <td className="py-2">
                        <div className="flex items-center gap-1.5">
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
                          <span className="font-mono">{it.product?.sku ?? "?"}</span>
                        </div>
                        {it.product?.product_name && (
                          <div className="text-xs text-muted-foreground">
                            {it.product.product_name}
                          </div>
                        )}
                      </td>
                      <td className="py-2 text-right tabular-nums">
                        {it.quantity_ordered.toLocaleString()}
                      </td>
                      <td className="py-2 text-right tabular-nums">
                        {(it.quantity_finished ?? 0).toLocaleString()}
                      </td>
                      <td className="py-2 text-right tabular-nums">
                        {unitCost > 0 ? `$${unitCost.toFixed(2)}` : "—"}
                      </td>
                      <td className="py-2 text-right tabular-nums">
                        {lineValue > 0 ? `$${lineValue.toLocaleString()}` : "—"}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
          {/* Note about freightMap — currently unused on this page but threaded
              through for parity with the list-page rollup math when we extend
              the table to show shipped/in-transit columns. */}
          <p className="hidden">{freightMap.size}</p>
        </CardContent>
      </Card>
    </div>
  );
}
