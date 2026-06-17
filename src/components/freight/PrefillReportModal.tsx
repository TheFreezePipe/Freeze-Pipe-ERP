import { useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";
import { useFreightShipments, useFreightLineItems } from "@/lib/hooks";
import { useTableSort, applySort, SortableTh } from "@/components/shared/table-sort";
import { format, parseISO } from "date-fns";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type WindowKey = "all" | "90d" | "ytd";
const WINDOWS: { key: WindowKey; label: string }[] = [
  { key: "all", label: "All-time" },
  { key: "90d", label: "Last 90 days" },
  { key: "ytd", label: "This year" },
];

const BAR_COLOR = "hsl(190, 80%, 55%)";

/**
 * Prefilled % report. Of fillable units shipped on freight (where the
 * pre-filled split is recorded per line), what share arrived pre-filled
 * at the factory vs. needs filling at our warehouse. All computed
 * client-side from freight lines + shipments.
 */
export function PrefillReportModal({ open, onOpenChange }: Props) {
  const { data: lines = [] } = useFreightLineItems();
  const { data: shipments = [] } = useFreightShipments();
  const [win, setWin] = useState<WindowKey>("all");

  // Flatten to fillable, prefill-tracked lines annotated with ship date.
  const allRows = useMemo(() => {
    const shipById = new Map(shipments.map((s) => [s.id, s]));
    return lines
      .filter((l) => l.product?.category === "fillable" && l.quantity_prefilled != null && l.sku_id)
      .map((l) => {
        const ship = shipById.get(l.freight_shipment_id);
        return {
          sku: l.product!.sku,
          name: l.product!.product_name,
          qty: l.quantity ?? 0,
          prefilled: l.quantity_prefilled ?? 0,
          shipDate: ship?.ship_date ?? null,
        };
      });
  }, [lines, shipments]);

  const windowed = useMemo(() => {
    if (win === "all") return allRows;
    const now = new Date();
    const cutoff =
      win === "90d"
        ? new Date(now.getTime() - 90 * 86_400_000).toISOString().slice(0, 10)
        : `${now.getFullYear()}-01-01`;
    return allRows.filter((r) => r.shipDate != null && r.shipDate >= cutoff);
  }, [allRows, win]);

  const headline = useMemo(() => {
    const total = windowed.reduce((s, r) => s + r.qty, 0);
    const prefilled = windowed.reduce((s, r) => s + r.prefilled, 0);
    const dates = windowed.map((r) => r.shipDate).filter((d): d is string => !!d).sort();
    return {
      total,
      prefilled,
      unfilled: total - prefilled,
      pct: total > 0 ? (prefilled / total) * 100 : 0,
      first: dates[0] ?? null,
      last: dates[dates.length - 1] ?? null,
    };
  }, [windowed]);

  // Monthly trend (by ship month). Lines without a ship date can't be bucketed.
  const trend = useMemo(() => {
    const byMonth = new Map<string, { total: number; prefilled: number }>();
    for (const r of windowed) {
      if (!r.shipDate) continue;
      const m = r.shipDate.slice(0, 7); // YYYY-MM
      const cur = byMonth.get(m) ?? { total: 0, prefilled: 0 };
      cur.total += r.qty;
      cur.prefilled += r.prefilled;
      byMonth.set(m, cur);
    }
    return Array.from(byMonth.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([month, v]) => ({
        month,
        pct: v.total > 0 ? Math.round((v.prefilled / v.total) * 100) : 0,
        total: v.total,
        prefilled: v.prefilled,
      }));
  }, [windowed]);

  const bySku = useMemo(() => {
    const m = new Map<string, { sku: string; name: string; qty: number; prefilled: number }>();
    for (const r of windowed) {
      const cur = m.get(r.sku) ?? { sku: r.sku, name: r.name, qty: 0, prefilled: 0 };
      cur.qty += r.qty;
      cur.prefilled += r.prefilled;
      m.set(r.sku, cur);
    }
    return Array.from(m.values()).map((r) => ({
      ...r,
      pct: r.qty > 0 ? (r.prefilled / r.qty) * 100 : 0,
    }));
  }, [windowed]);

  const { sort, toggleSort } = useTableSort();
  const sortedBySku = useMemo(
    () =>
      applySort(bySku, sort ?? { key: "qty", dir: "desc" }, {
        sku: (r) => r.sku,
        qty: (r) => r.qty,
        prefilled: (r) => r.prefilled,
        pct: (r) => r.pct,
      }),
    [bySku, sort],
  );

  const fmtMonth = (m: string) => {
    try {
      return format(parseISO(`${m}-01`), "MMM yyyy");
    } catch {
      return m;
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[88vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-baseline gap-2">
            Pre-filled Rate
            <span className="text-sm font-normal text-muted-foreground">
              fillable units shipped pre-filled vs. needing fill at our warehouse
            </span>
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-6">
          {/* Window selector + headline */}
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="text-3xl font-bold tabular-nums">{Math.round(headline.pct)}%</p>
              <p className="text-xs text-muted-foreground">
                {headline.prefilled.toLocaleString()} pre-filled of {headline.total.toLocaleString()} fillable units
                {" · "}
                {headline.unfilled.toLocaleString()} shipped unfilled
                {headline.first && headline.last && (
                  <> {" · "}{format(parseISO(headline.first), "MMM d, yyyy")} – {format(parseISO(headline.last), "MMM d, yyyy")}</>
                )}
              </p>
            </div>
            <div className="flex gap-1">
              {WINDOWS.map((w) => (
                <Button
                  key={w.key}
                  size="sm"
                  variant={win === w.key ? "default" : "outline"}
                  className="h-7 px-2.5 text-xs"
                  onClick={() => setWin(w.key)}
                >
                  {w.label}
                </Button>
              ))}
            </div>
          </div>

          {/* Monthly trend */}
          <div>
            <p className="mb-2 text-sm font-medium">Pre-filled % by month shipped</p>
            {trend.length === 0 ? (
              <p className="text-sm text-muted-foreground">No shipments in this window.</p>
            ) : (
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={trend} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(0,0%,18%)" vertical={false} />
                  <XAxis
                    dataKey="month"
                    tick={{ fontSize: 10, fill: "hsl(0,0%,55%)" }}
                    tickFormatter={fmtMonth}
                  />
                  <YAxis
                    domain={[0, 100]}
                    width={36}
                    tick={{ fontSize: 10, fill: "hsl(0,0%,55%)" }}
                    tickFormatter={(v: number) => `${v}%`}
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: "hsl(0,0%,10%)",
                      border: "1px solid hsl(0,0%,18%)",
                      borderRadius: 8,
                      color: "hsl(0,0%,95%)",
                      fontSize: 12,
                    }}
                    labelFormatter={(m: string) => fmtMonth(m)}
                    formatter={(value: number, _n, item: { payload?: { prefilled?: number; total?: number } }) => [
                      `${value}% — ${(item?.payload?.prefilled ?? 0).toLocaleString()} of ${(item?.payload?.total ?? 0).toLocaleString()} units`,
                      "Pre-filled",
                    ]}
                  />
                  <Bar dataKey="pct" fill={BAR_COLOR} radius={[3, 3, 0, 0]} name="Pre-filled %" />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>

          {/* By SKU */}
          <div>
            <p className="mb-2 text-sm font-medium">By SKU</p>
            <div className="max-h-72 overflow-y-auto rounded-md border border-border/50">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-muted/40 text-muted-foreground">
                  <tr className="text-left">
                    <SortableTh sortKey="sku" sort={sort} onToggle={toggleSort} className="px-3 py-1.5 font-medium">SKU</SortableTh>
                    <SortableTh sortKey="qty" sort={sort} onToggle={toggleSort} className="px-2 py-1.5 text-right font-medium">Shipped</SortableTh>
                    <SortableTh sortKey="prefilled" sort={sort} onToggle={toggleSort} className="px-2 py-1.5 text-right font-medium">Pre-filled</SortableTh>
                    <SortableTh sortKey="pct" sort={sort} onToggle={toggleSort} className="px-3 py-1.5 text-right font-medium">% pre-filled</SortableTh>
                  </tr>
                </thead>
                <tbody>
                  {sortedBySku.map((r) => (
                    <tr key={r.sku} className="border-t border-border/40">
                      <td className="px-3 py-1.5">
                        <span className="font-medium">{r.sku}</span>
                        <span className="ml-1.5 text-muted-foreground/70 hidden sm:inline">{r.name}</span>
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{r.qty.toLocaleString()}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">{r.prefilled.toLocaleString()}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">
                        <span
                          className={
                            r.pct >= 75 ? "text-green-400" : r.pct >= 25 ? "text-yellow-400" : "text-muted-foreground"
                          }
                        >
                          {Math.round(r.pct)}%
                        </span>
                      </td>
                    </tr>
                  ))}
                  {sortedBySku.length === 0 && (
                    <tr>
                      <td colSpan={4} className="px-3 py-6 text-center text-muted-foreground">
                        No fillable shipments in this window.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              Low-% high-volume SKUs are the best candidates to ask the factory to pre-fill.
            </p>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
