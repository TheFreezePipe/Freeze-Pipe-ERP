import { useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ReferenceLine,
  ResponsiveContainer,
} from "recharts";
import {
  useInventory,
  useFreightShipments,
  useFreightLineItems,
  useFactoryOrders,
  useAllSkuEconomics,
  useAllPrimarySkuSupplierCosts,
  useForecastDemandMap,
  useRetailValueHistory,
} from "@/lib/hooks";
import { buildRetailValueBreakdown } from "@/lib/retail-value";
import { getEffectiveDemand } from "@/lib/demand";
import { useTableSort, applySort, SortableTh } from "@/components/shared/table-sort";
import { format, parseISO } from "date-fns";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const WAREHOUSE_COLOR = "hsl(120, 45%, 50%)";
const TRANSIT_COLOR = "hsl(45, 85%, 55%)";
const ON_ORDER_COLOR = "hsl(0, 65%, 70%)";

const RANGES = [
  { label: "30 days", days: 30 },
  { label: "90 days", days: 90 },
  { label: "6 months", days: 180 },
  { label: "1 year", days: 365 },
];

function fmtUsd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${Math.round(n / 1000)}k`;
  return `$${Math.round(n)}`;
}
function fmtUsdFull(n: number): string {
  return `$${Math.round(n).toLocaleString()}`;
}

/**
 * Retail Value detail report. Centerpiece is a stacked-area history of the
 * three pipeline stages (top of the stack = total). Plus a retail-vs-cost
 * headline, by-SKU concentration (Pareto), and dead/slow capital.
 */
export function RetailValueDetailModal({ open, onOpenChange }: Props) {
  const { data: inventory = [] } = useInventory();
  const { data: shipments = [] } = useFreightShipments();
  const { data: freightLines = [] } = useFreightLineItems();
  const { data: factoryOrders = [] } = useFactoryOrders();
  const { data: economicsById } = useAllSkuEconomics();
  const { data: primaryCostBySkuId } = useAllPrimarySkuSupplierCosts();
  const forecastMap = useForecastDemandMap();

  const [days, setDays] = useState(90);
  const { data: history = [], isLoading } = useRetailValueHistory(days);

  // Current breakdown — same engine as the summary bar, so the headline
  // here always matches the card the user clicked.
  const b = useMemo(
    () =>
      buildRetailValueBreakdown(
        inventory,
        shipments,
        freightLines,
        factoryOrders,
        economicsById,
        primaryCostBySkuId,
      ),
    [inventory, shipments, freightLines, factoryOrders, economicsById, primaryCostBySkuId],
  );

  const markup = b.totalCash > 0 ? b.total / b.totalCash : 0;
  const firstSnapshotDay = useMemo(
    () => history.find((h) => h.isSnapshot)?.day ?? null,
    [history],
  );

  // ---- By-SKU concentration (Pareto) ----
  const skuRows = useMemo(
    () =>
      b.rows
        .filter((r) => r.totalRetail > 0)
        .map((r) => ({
          sku: r.sku,
          name: r.name,
          units: r.totalUnits,
          retail: r.totalRetail,
          pct: b.total > 0 ? (r.totalRetail / b.total) * 100 : 0,
        })),
    [b.rows, b.total],
  );

  const { sort, toggleSort } = useTableSort();
  const sortedSku = useMemo(
    () =>
      applySort(skuRows, sort ?? { key: "retail", dir: "desc" }, {
        sku: (r) => r.sku,
        units: (r) => r.units,
        retail: (r) => r.retail,
        pct: (r) => r.pct,
      }),
    [skuRows, sort],
  );
  // Cumulative % follows the displayed order.
  const sortedSkuCum = useMemo(() => {
    let run = 0;
    return sortedSku.map((r) => {
      run += r.pct;
      return { ...r, cum: run };
    });
  }, [sortedSku]);

  // Pareto callout: how concentrated is value in the top SKUs?
  const concentration = useMemo(() => {
    const byVal = [...skuRows].sort((a, c) => c.retail - a.retail);
    const topN = Math.min(10, byVal.length);
    const topShare = byVal.slice(0, topN).reduce((s, r) => s + r.pct, 0);
    return { topN, topShare, count: byVal.length };
  }, [skuRows]);

  // ---- Dead / slow capital: value held in SKUs with no demand signal ----
  const dead = useMemo(() => {
    const rows = b.rows
      .filter((r) => r.totalRetail > 0 && getEffectiveDemand(r.skuId, r.monthlyDemand, forecastMap) <= 0)
      .map((r) => ({ sku: r.sku, name: r.name, units: r.totalUnits, retail: r.totalRetail }))
      .sort((a, c) => c.retail - a.retail);
    const total = rows.reduce((s, r) => s + r.retail, 0);
    return { rows, total, count: rows.length };
  }, [b.rows, forecastMap]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[88vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-baseline gap-2">
            Inventory Retail Value
            <span className="text-sm font-normal text-muted-foreground">
              value across the pipeline &middot; warehouse, in transit &amp; on order
            </span>
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-6">
          {/* Headline: retail vs cost */}
          <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
            <div>
              <p className="text-3xl font-bold tabular-nums">{fmtUsdFull(b.total)}</p>
              <p className="text-xs text-muted-foreground">total retail value</p>
            </div>
            <div>
              <p className="text-lg font-bold tabular-nums text-amber-400">{fmtUsdFull(b.totalCash)}</p>
              <p className="text-xs text-muted-foreground">
                cash outlay
                {b.skusMissingCost > 0 && (
                  <span
                    className="ml-1 text-amber-400/70"
                    title="SKUs with inventory but no cost data are excluded from cash — it's a lower bound."
                  >
                    ({b.skusMissingCost} missing cost)
                  </span>
                )}
              </p>
            </div>
            <div>
              <p className="text-lg font-bold tabular-nums">
                {markup > 0 ? `${markup.toFixed(1)}×` : "—"}
              </p>
              <p className="text-xs text-muted-foreground">retail-to-cash markup</p>
            </div>
            <div>
              <p className="text-lg font-bold tabular-nums text-green-400">
                {fmtUsdFull(b.total - b.totalCash)}
              </p>
              <p className="text-xs text-muted-foreground">unrealized margin</p>
            </div>
          </div>

          {/* Retail value over time — stacked area */}
          <div>
            <div className="mb-2 flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Retail value over time</p>
                <p className="text-[11px] text-muted-foreground">
                  stacked by stage &mdash; top of the stack is total value
                </p>
              </div>
              <div className="flex gap-1">
                {RANGES.map((r) => (
                  <Button
                    key={r.days}
                    size="sm"
                    variant={days === r.days ? "default" : "outline"}
                    className="h-7 px-2.5 text-xs"
                    onClick={() => setDays(r.days)}
                  >
                    {r.label}
                  </Button>
                ))}
              </div>
            </div>
            <ResponsiveContainer width="100%" height={260}>
              <AreaChart data={history} margin={{ top: 8, right: 12, left: 4, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(0,0%,18%)" vertical={false} />
                <XAxis
                  dataKey="day"
                  tick={{ fontSize: 10, fill: "hsl(0,0%,55%)" }}
                  tickFormatter={(v: string) => {
                    try {
                      return format(parseISO(v), "MMM d");
                    } catch {
                      return v;
                    }
                  }}
                  interval="preserveStartEnd"
                  minTickGap={44}
                />
                <YAxis
                  width={52}
                  tick={{ fontSize: 10, fill: "hsl(0,0%,55%)" }}
                  tickFormatter={(v: number) => fmtUsd(v)}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: "hsl(0,0%,10%)",
                    border: "1px solid hsl(0,0%,18%)",
                    borderRadius: 8,
                    color: "hsl(0,0%,95%)",
                    fontSize: 12,
                  }}
                  labelFormatter={(v: string) => {
                    try {
                      return format(parseISO(v), "MMM d, yyyy");
                    } catch {
                      return v;
                    }
                  }}
                  formatter={(value: number, name: string) => [fmtUsdFull(value), name]}
                  itemSorter={(item: { value?: number }) => -(item?.value ?? 0)}
                />
                <Legend wrapperStyle={{ fontSize: 11, paddingTop: 4 }} />
                {firstSnapshotDay && history.length > 1 && firstSnapshotDay !== history[0].day && (
                  <ReferenceLine
                    x={firstSnapshotDay}
                    stroke="hsl(0,0%,55%)"
                    strokeDasharray="3 3"
                    label={{ value: "exact tracking", fill: "hsl(0,0%,60%)", fontSize: 9, position: "insideTopRight" }}
                  />
                )}
                <Area
                  type="monotone"
                  dataKey="warehouse"
                  stackId="1"
                  name="In Warehouse"
                  stroke={WAREHOUSE_COLOR}
                  fill={WAREHOUSE_COLOR}
                  fillOpacity={0.65}
                />
                <Area
                  type="monotone"
                  dataKey="transit"
                  stackId="1"
                  name="In Transit"
                  stroke={TRANSIT_COLOR}
                  fill={TRANSIT_COLOR}
                  fillOpacity={0.65}
                />
                <Area
                  type="monotone"
                  dataKey="onOrder"
                  stackId="1"
                  name="On Order"
                  stroke={ON_ORDER_COLOR}
                  fill={ON_ORDER_COLOR}
                  fillOpacity={0.65}
                />
              </AreaChart>
            </ResponsiveContainer>
            {isLoading && (
              <p className="text-center text-xs text-muted-foreground">Loading history…</p>
            )}
            <p className="mt-1 text-[10px] text-muted-foreground/70">
              Exact daily snapshots begin at the dashed line; earlier dates are reconstructed from records and valued at current prices.
            </p>
          </div>

          {/* By-SKU concentration */}
          <div>
            <div className="mb-2 flex items-baseline justify-between gap-2">
              <p className="text-sm font-medium">Where the value sits</p>
              {concentration.count > 0 && (
                <p className="text-[11px] text-muted-foreground">
                  top {concentration.topN} SKUs hold {Math.round(concentration.topShare)}% of value
                </p>
              )}
            </div>
            <div className="max-h-72 overflow-y-auto rounded-md border border-border/50">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-muted/40 text-muted-foreground">
                  <tr className="text-left">
                    <SortableTh sortKey="sku" sort={sort} onToggle={toggleSort} className="px-3 py-1.5 font-medium">SKU</SortableTh>
                    <SortableTh sortKey="units" sort={sort} onToggle={toggleSort} className="px-2 py-1.5 text-right font-medium">Units held</SortableTh>
                    <SortableTh sortKey="retail" sort={sort} onToggle={toggleSort} className="px-2 py-1.5 text-right font-medium">Retail value</SortableTh>
                    <SortableTh sortKey="pct" sort={sort} onToggle={toggleSort} className="px-2 py-1.5 text-right font-medium">% of total</SortableTh>
                    <th className="px-3 py-1.5 text-right font-medium">Cumulative</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedSkuCum.map((r) => (
                    <tr key={r.sku} className="border-t border-border/40">
                      <td className="px-3 py-1.5">
                        <span className="font-medium">{r.sku}</span>
                        <span className="ml-1.5 text-muted-foreground/70 hidden sm:inline">{r.name}</span>
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">{r.units.toLocaleString()}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{fmtUsdFull(r.retail)}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{r.pct.toFixed(1)}%</td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">{Math.round(r.cum)}%</td>
                    </tr>
                  ))}
                  {sortedSkuCum.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-3 py-6 text-center text-muted-foreground">
                        No inventory value to show.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Dead / slow capital */}
          <div>
            <div className="mb-2 flex items-baseline justify-between gap-2">
              <p className="text-sm font-medium">Capital with no demand signal</p>
              <p className="text-[11px] text-muted-foreground">
                {dead.count > 0
                  ? `${fmtUsdFull(dead.total)} across ${dead.count} SKU${dead.count === 1 ? "" : "s"}`
                  : "none — every stocked SKU has demand"}
              </p>
            </div>
            {dead.count > 0 && (
              <div className="max-h-56 overflow-y-auto rounded-md border border-border/50">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-muted/40 text-muted-foreground">
                    <tr className="text-left">
                      <th className="px-3 py-1.5 font-medium">SKU</th>
                      <th className="px-2 py-1.5 text-right font-medium">Units held</th>
                      <th className="px-3 py-1.5 text-right font-medium">Retail value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dead.rows.map((r) => (
                      <tr key={r.sku} className="border-t border-border/40">
                        <td className="px-3 py-1.5">
                          <span className="font-medium">{r.sku}</span>
                          <span className="ml-1.5 text-muted-foreground/70 hidden sm:inline">{r.name}</span>
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">{r.units.toLocaleString()}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums text-orange-400">{fmtUsdFull(r.retail)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="mt-1 text-[10px] text-muted-foreground/70">
              SKUs with stock but no recent sales or forecast demand — candidates for promotion or write-down.
            </p>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
