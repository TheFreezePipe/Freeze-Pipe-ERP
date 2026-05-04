import { Link } from "react-router-dom";
import { useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  useSupplierFactoryOrders,
  useSupplierFreightShipments,
  isItemOverdue,
  effectiveItemEta,
  type SupplierFactoryOrderWithItems,
  type SupplierFactoryOrderItemRow,
} from "@/lib/hooks";
import { ClipboardList, PackageOpen, AlarmClock } from "lucide-react";

/**
 * Supplier overview. Counts of open work at a glance + quick links.
 * All data comes through RLS — a supplier only sees their own scope.
 */
export default function SupplierDashboard() {
  const orders = useSupplierFactoryOrders();
  const shipments = useSupplierFreightShipments();

  const todayIso = useMemo(() => new Date().toISOString().slice(0, 10), []);

  const activeOrders = useMemo(
    () =>
      (orders.data ?? []).filter(
        (o) => o.status !== "canceled" && o.status !== "shipped",
      ),
    [orders.data],
  );

  const pendingShipments = (shipments.data ?? []).filter(
    (s) => s.status === "pending",
  );

  // Flatten every overdue item across all orders so the dialog can show SKU + source order.
  const overdueItems = useMemo(() => {
    const out: Array<{
      order: SupplierFactoryOrderWithItems;
      item: SupplierFactoryOrderItemRow;
      effectiveEta: string | null;
    }> = [];
    for (const order of orders.data ?? []) {
      for (const item of order.items ?? []) {
        if (isItemOverdue(item, order, todayIso)) {
          out.push({
            order,
            item,
            effectiveEta: effectiveItemEta(item, order),
          });
        }
      }
    }
    // Oldest-due first so the list reads as "worst at the top."
    return out.sort((a, b) => (a.effectiveEta ?? "").localeCompare(b.effectiveEta ?? ""));
  }, [orders.data, todayIso]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Supplier Portal</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Log production runs, create shipments, and keep the line on schedule.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        <Link to="/supplier/orders">
          <Card className="hover:bg-accent/50 transition-colors h-full">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center justify-between text-sm font-medium text-muted-foreground">
                Active Orders
                <ClipboardList className="h-4 w-4" />
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-baseline gap-2">
                <span className="text-3xl font-semibold">{activeOrders.length}</span>
                {activeOrders.length > 0 && (
                  <Badge variant="outline" className="text-[10px]">in flight</Badge>
                )}
              </div>
              <p className="text-xs text-muted-foreground mt-1">Production runs in flight.</p>
            </CardContent>
          </Card>
        </Link>

        <Link to="/supplier/shipments">
          <Card className="hover:bg-accent/50 transition-colors h-full">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center justify-between text-sm font-medium text-muted-foreground">
                Pending Shipments
                <PackageOpen className="h-4 w-4" />
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-baseline gap-2">
                <span className="text-3xl font-semibold">{pendingShipments.length}</span>
                {pendingShipments.length > 0 && (
                  <Badge variant="outline" className="text-[10px]">open</Badge>
                )}
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                Drafted — awaiting tracking info.
              </p>
            </CardContent>
          </Card>
        </Link>

        <OverdueCard itemCount={overdueItems.length} overdueItems={overdueItems} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Overdue card — clickable; opens a dialog listing each overdue (SKU, order,
// effective ETA). Hover also shows a condensed summary for a quick glance.
// ---------------------------------------------------------------------------
function OverdueCard({
  itemCount,
  overdueItems,
}: {
  itemCount: number;
  overdueItems: Array<{
    order: SupplierFactoryOrderWithItems;
    item: SupplierFactoryOrderItemRow;
    effectiveEta: string | null;
  }>;
}) {
  const [open, setOpen] = useState(false);
  const hoverTitle = useMemo(() => {
    if (itemCount === 0) return "Nothing overdue — nice.";
    return overdueItems
      .slice(0, 10)
      .map((r) => {
        const sku = r.item.sku?.sku ?? r.item.sku_id.slice(0, 8);
        return `${sku} · ${r.item.quantity_ordered} · due ${r.effectiveEta ?? "—"}`;
      })
      .join("\n") + (itemCount > 10 ? `\n…+${itemCount - 10} more` : "");
  }, [itemCount, overdueItems]);

  const card = (
    <Card
      className="hover:bg-accent/50 transition-colors h-full cursor-pointer"
      title={hoverTitle}
    >
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between text-sm font-medium text-muted-foreground">
          Overdue Items
          <AlarmClock className={`h-4 w-4 ${itemCount > 0 ? "text-red-400" : ""}`} />
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex items-baseline gap-2">
          <span className={`text-3xl font-semibold ${itemCount > 0 ? "text-red-400" : ""}`}>
            {itemCount}
          </span>
          {itemCount > 0 && (
            <Badge variant="outline" className="text-[10px] border-red-500/40 text-red-400">
              past ETA
            </Badge>
          )}
        </div>
        <p className="text-xs text-muted-foreground mt-1">
          {itemCount === 0
            ? "All items are on schedule."
            : "Click for details. Hover for a quick list."}
        </p>
      </CardContent>
    </Card>
  );

  if (itemCount === 0) {
    // Nothing to show — render the card non-interactive.
    return <div className="h-full">{card}</div>;
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <div>{card}</div>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Overdue items</DialogTitle>
          <DialogDescription>
            Items past their effective ETA (per-item override if set, otherwise the order's ETA)
            and not yet received by the consolidator.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] overflow-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left text-xs uppercase text-muted-foreground sticky top-0">
              <tr>
                <th className="px-3 py-2">SKU</th>
                <th className="px-3 py-2">Qty</th>
                <th className="px-3 py-2">Due</th>
                <th className="px-3 py-2">Order</th>
              </tr>
            </thead>
            <tbody>
              {overdueItems.map(({ order, item, effectiveEta }) => (
                <tr key={item.id} className="border-t border-border hover:bg-accent/30">
                  <td className="px-3 py-2">
                    {item.sku ? (
                      <>
                        <span className="font-mono text-xs">{item.sku.sku}</span>
                        <span className="ml-2 text-muted-foreground">{item.sku.product_name}</span>
                      </>
                    ) : (
                      <span className="font-mono text-xs text-muted-foreground">
                        {item.sku_id.slice(0, 8)}…
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 tabular-nums">{item.quantity_ordered}</td>
                  <td className="px-3 py-2 text-red-400">
                    {effectiveEta ?? "—"}
                  </td>
                  <td className="px-3 py-2">
                    <Link
                      to={`/supplier/orders/${order.id}`}
                      className="text-primary hover:underline text-xs"
                      onClick={() => setOpen(false)}
                    >
                      {order.order_date} → open
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </DialogContent>
    </Dialog>
  );
}
