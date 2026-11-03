import { useMemo } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { ShippingMeasureRunRow, SkuShippingMeasuredRow } from "@/lib/hooks/use-shipping-measured";
import { hasActionableShippingFlag, shippingFlagLabel } from "@/lib/shipping-measured";

interface ProductLite { id: string; sku: string; product_name: string; }
interface Exception { order_number: string; ship_date: string; box: string; measured_oz: number; fitted_oz: number; skus: string; }

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  run: ShippingMeasureRunRow | null;
  measured: Map<string, SkuShippingMeasuredRow> | undefined;
  products: readonly ProductLite[];
}

const money = (n: number | null | undefined) => (n == null ? "—" : `$${n.toFixed(2)}`);
const oz = (n: number | null | undefined) => (n == null ? "—" : `${n.toFixed(1)} oz`);
const day = (s: string | null | undefined) =>
  s ? new Date(s).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—";

/**
 * What the weekly shipping solve found: fit quality, SKUs whose measured
 * figure moved or could not be solved cleanly, and orders whose scale
 * weight disagrees with their contents (wrong box, mis-weigh, product change).
 */
export function ShippingMeasureDialog({ open, onOpenChange, run, measured, products }: Props) {
  const bySku = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const flagged = useMemo(() => {
    const rows = [...(measured?.values() ?? [])].filter((m) => m.flags.length > 0 && !(m.flags.length === 1 && m.flags[0] === "no_fit"));
    return rows
      .map((m) => ({ m, p: bySku.get(m.sku_id) }))
      .filter((r) => r.p)
      .sort((a, b) => Number(hasActionableShippingFlag(b.m.flags)) - Number(hasActionableShippingFlag(a.m.flags)) || a.p!.sku.localeCompare(b.p!.sku));
  }, [measured, bySku]);
  const exceptions = (run?.exceptions ?? []) as unknown as Exception[];
  const summary = (run?.summary ?? {}) as Record<string, number | string>;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Shipping · measured {day(run?.completed_at ?? run?.started_at)}</DialogTitle>
          <DialogDescription>
            {run
              ? `${Number(run.orders_kept ?? 0).toLocaleString()} free-shipping orders, ${day(run.window_from)} to ${day(run.window_to)} · fit R² ${run.r2 ?? "—"} · typical error ${run.median_resid_oz ?? "—"} oz · ${summary.boxes ?? "—"} box sizes`
              : "No run recorded yet."}
          </DialogDescription>
        </DialogHeader>

        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Flagged SKUs · {flagged.length}</h3>
          {flagged.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing flagged.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="py-1 pr-3">SKU</th>
                  <th className="py-1 pr-3">Why</th>
                  <th className="py-1 pr-3 text-right">As sold</th>
                  <th className="py-1 pr-3 text-right">Prior</th>
                  <th className="py-1 pr-3 text-right">Item</th>
                  <th className="py-1 text-right">Orders</th>
                </tr>
              </thead>
              <tbody>
                {flagged.map(({ m, p }) => (
                  <tr key={m.sku_id} className="border-t border-border/40">
                    <td className="py-1.5 pr-3">
                      <span className="font-mono text-xs">{p!.sku}</span>
                      <span className="ml-2 text-xs text-muted-foreground">{p!.product_name}</span>
                    </td>
                    <td className={"py-1.5 pr-3 text-xs " + (hasActionableShippingFlag(m.flags) ? "text-amber-400" : "text-muted-foreground")}>
                      {m.flags.map((f) => shippingFlagLabel(f, m.joint_with)).join(" · ")}
                    </td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{money(m.as_sold_cost)}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums text-muted-foreground">{money(m.as_sold_cost_prev)}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums text-muted-foreground">{oz(m.item_oz)}</td>
                    <td className="py-1.5 text-right tabular-nums text-muted-foreground">{m.orders}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="mt-4">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Orders off the fit by more than a pound · {exceptions.length}</h3>
          {exceptions.length === 0 ? (
            <p className="text-sm text-muted-foreground">None.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="py-1 pr-3">Order</th>
                  <th className="py-1 pr-3">Shipped</th>
                  <th className="py-1 pr-3">Box</th>
                  <th className="py-1 pr-3 text-right">Weighed</th>
                  <th className="py-1 pr-3 text-right">Expected</th>
                  <th className="py-1">Contents</th>
                </tr>
              </thead>
              <tbody>
                {exceptions.map((e) => (
                  <tr key={e.order_number + e.ship_date} className="border-t border-border/40">
                    <td className="py-1.5 pr-3 font-mono text-xs">{e.order_number}</td>
                    <td className="py-1.5 pr-3 text-xs text-muted-foreground">{day(e.ship_date)}</td>
                    <td className="py-1.5 pr-3 font-mono text-xs text-muted-foreground">{e.box}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{oz(e.measured_oz)}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums text-muted-foreground">{oz(e.fitted_oz)}</td>
                    <td className="py-1.5 text-xs text-muted-foreground">{e.skus}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </DialogContent>
    </Dialog>
  );
}
