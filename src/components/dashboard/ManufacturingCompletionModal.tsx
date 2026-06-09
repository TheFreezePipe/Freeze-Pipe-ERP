import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ReferenceDot,
  Legend,
  ResponsiveContainer,
} from "recharts";
import { useMemo, useState } from "react";
import {
  useInventory,
  useFreightShipments,
  useFreightLineItems,
  useManufacturingCompletionHistory,
  useManufacturingClearEstimate,
} from "@/lib/hooks";
import { format, parseISO } from "date-fns";
import { cn } from "@/lib/utils";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const RANGES = [
  { label: "7 days", days: 7 },
  { label: "30 days", days: 30 },
  { label: "90 days", days: 90 },
];

// Pipeline-order colors: the two "unfilled" stages (warm) then the two
// "complete" stages (cool), matching the dashboard chart's complete=green.
const RAW_COLOR = "hsl(0, 65%, 70%)"; // raw — not started
const WIP_COLOR = "hsl(30, 90%, 55%)"; // in production — WIP
const PREFILLED_COLOR = "hsl(190, 80%, 55%)"; // pre-filled — needs RTS only
const FINISHED_COLOR = "hsl(120, 45%, 50%)"; // finished — done
const PCT_COLOR = "hsl(120, 45%, 50%)";
const PROJECTED_COLOR = "hsl(270, 67%, 60%)"; // forward projection (dashed)
const SEA_COLOR = "hsl(200, 80%, 55%)"; // sea freight arrival markers
const CHART_BG = "hsl(0,0%,10%)"; // matches tooltip/card bg for "hollow" dots

export function ManufacturingCompletionModal({ open, onOpenChange }: Props) {
  const { data: inventory = [] } = useInventory();
  const [days, setDays] = useState(30);
  const { data: history = [], isLoading } = useManufacturingCompletionHistory(days);
  // Days-to-clear uses a fixed trailing-30d throughput basis, independent of
  // the chart range toggle above.
  const { data: estimate } = useManufacturingClearEstimate(30);
  const { data: shipments = [] } = useFreightShipments();
  const { data: freightLines = [] } = useFreightLineItems();

  const todayStr = new Date().toISOString().slice(0, 10);

  // Current snapshot across fillable SKUs (stages + per-SKU breakdown).
  const snap = useMemo(() => {
    let raw = 0;
    let wip = 0;
    let prefilled = 0;
    let finished = 0;
    const bySku: {
      sku: string;
      name: string;
      unfilled: number;
      complete: number;
      total: number;
      pct: number;
    }[] = [];

    for (const inv of inventory) {
      if (inv.product?.category !== "fillable") continue;
      const r = inv.warehouse_raw ?? 0;
      const w = inv.warehouse_in_production ?? 0;
      const pf = inv.warehouse_prefilled_raw ?? 0;
      const fin = inv.warehouse_finished ?? 0;
      raw += r;
      wip += w;
      prefilled += pf;
      finished += fin;
      const unfilled = r + w;
      const complete = pf + fin;
      const total = unfilled + complete;
      if (total > 0) {
        bySku.push({
          sku: inv.product.sku,
          name: inv.product.product_name,
          unfilled,
          complete,
          total,
          pct: (complete / total) * 100,
        });
      }
    }

    const unfilled = raw + wip;
    const complete = prefilled + finished;
    const total = unfilled + complete;
    bySku.sort((a, b) => b.unfilled - a.unfilled);
    return {
      raw,
      wip,
      prefilled,
      finished,
      unfilled,
      complete,
      total,
      pct: total > 0 ? (complete / total) * 100 : 0,
      bySku,
    };
  }, [inventory]);

  // Days-to-clear: throughput-based queue drain. Total fillable units that
  // still need to be made ready (on-hand unfilled + pre-filled, plus inbound
  // freight) divided by the team's combined make-ready rate (rtsing +
  // prefilled_rtsing, trailing 30 days). Folds manufacturing + RTS into one
  // figure. Null rate = no recent completion activity to estimate from.
  const clear = useMemo(() => {
    if (!estimate) return null;
    const onHand = estimate.unfilled_now + estimate.prefilled_now;
    const inbound = estimate.incoming_raw + estimate.incoming_prefilled;
    const totalWork = onHand + inbound;
    const rate = estimate.rtsing_per_day + estimate.prefilled_rtsing_per_day;
    return {
      totalWork,
      onHand,
      inbound,
      rate,
      days: rate > 0 ? totalWork / rate : null,
    };
  }, [estimate]);

  // Forward 30-day completion-% projection. Each day, fillable freight lands
  // on its exact ETA (raw -> unfilled, pre-filled -> complete), then rtsing
  // converts unfilled -> complete at the trailing-30d pace. Only rtsing moves
  // the ratio (pre-filled is already "complete"); pre-filled RTS is omitted.
  // Outbound sales are not modeled — this is manufacturing progress on
  // current + inbound stock. Anchored at today's actual so it meets the
  // historical line.
  const fillableIds = useMemo(
    () =>
      new Set(
        inventory.filter((i) => i.product?.category === "fillable").map((i) => i.sku_id),
      ),
    [inventory],
  );

  const projection = useMemo(() => {
    if (!estimate) return [] as { day: string; projectedPct: number }[];

    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toISOString().slice(0, 10);
    const horizon = new Date();
    horizon.setDate(horizon.getDate() + 30);
    const horizonStr = horizon.toISOString().slice(0, 10);

    // Aggregate fillable arrivals by ETA day. Overdue ETAs land "tomorrow";
    // arrivals beyond the 30-day horizon don't show on this curve.
    const arrivals = new Map<string, { raw: number; prefilled: number }>();
    for (const f of shipments) {
      if (f.status === "delivered" || !f.eta) continue;
      let etaDay = f.eta.slice(0, 10);
      if (etaDay < tomorrowStr) etaDay = tomorrowStr;
      if (etaDay > horizonStr) continue;
      for (const li of freightLines) {
        if (li.freight_shipment_id !== f.id || !fillableIds.has(li.sku_id)) continue;
        const qty = li.quantity ?? 0;
        const pf = Math.min(Math.max(li.quantity_prefilled ?? 0, 0), qty);
        const raw = Math.max(qty - pf, 0);
        const cur = arrivals.get(etaDay) ?? { raw: 0, prefilled: 0 };
        cur.raw += raw;
        cur.prefilled += pf;
        arrivals.set(etaDay, cur);
      }
    }

    const rate = estimate.rtsing_per_day; // unfilled -> complete per day
    let complete = snap.complete;
    let unfilled = snap.unfilled;
    const out: { day: string; projectedPct: number }[] = [
      {
        day: todayStr,
        projectedPct: complete + unfilled > 0 ? (complete / (complete + unfilled)) * 100 : 0,
      },
    ];
    for (let d = 1; d <= 30; d++) {
      const date = new Date();
      date.setDate(date.getDate() + d);
      const ds = date.toISOString().slice(0, 10);
      const arr = arrivals.get(ds);
      if (arr) {
        unfilled += arr.raw;
        complete += arr.prefilled;
      }
      const conv = Math.min(rate, unfilled);
      unfilled -= conv;
      complete += conv;
      const total = complete + unfilled;
      out.push({ day: ds, projectedPct: total > 0 ? (complete / total) * 100 : 0 });
    }
    return out;
  }, [estimate, shipments, freightLines, fillableIds, snap, todayStr]);

  // Merge history (solid) + projection (dashed) into one series. The "today"
  // row carries both keys so the two lines visually connect.
  const chartData = useMemo(() => {
    const byDate = new Map<string, { day: string; pct?: number; projectedPct?: number }>();
    for (const h of history) byDate.set(h.day, { day: h.day, pct: h.pct });
    for (const p of projection) {
      const ex = byDate.get(p.day) ?? { day: p.day };
      byDate.set(p.day, { ...ex, projectedPct: p.projectedPct });
    }
    return Array.from(byDate.values()).sort((a, b) => a.day.localeCompare(b.day));
  }, [history, projection]);

  // Sea freight arrival markers (only shipments carrying fillable units, since
  // those are what move this chart). Delivered = actual arrival (filled dot);
  // in-transit = ETA (hollow dot). Overdue ETAs snap to tomorrow; only dates
  // inside the visible chart range are kept.
  const seaArrivals = useMemo(() => {
    if (chartData.length === 0) return [] as { day: string; arrived: boolean; qty: number; id: string }[];
    const domainStart = chartData[0].day;
    const domainEnd = chartData[chartData.length - 1].day;
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toISOString().slice(0, 10);

    const out: { day: string; arrived: boolean; qty: number; id: string }[] = [];
    for (const f of shipments) {
      if (f.freight_type !== "sea") continue;
      let qty = 0;
      for (const li of freightLines) {
        if (li.freight_shipment_id === f.id && fillableIds.has(li.sku_id)) qty += li.quantity ?? 0;
      }
      if (qty === 0) continue;

      let day: string | null = null;
      let arrived = false;
      if (f.status === "delivered") {
        const src = f.actual_arrival_date ?? f.eta;
        day = src ? src.slice(0, 10) : null;
        arrived = true;
      } else if (f.eta) {
        day = f.eta.slice(0, 10);
        if (day < tomorrowStr) day = tomorrowStr;
      }
      if (!day || day < domainStart || day > domainEnd) continue;
      out.push({ day, arrived, qty, id: f.id });
    }
    return out;
  }, [shipments, freightLines, fillableIds, chartData]);

  const stages =
    snap.total > 0
      ? [
          { key: "raw", label: "Raw", value: snap.raw, color: RAW_COLOR, side: "Unfilled" },
          { key: "wip", label: "In Production", value: snap.wip, color: WIP_COLOR, side: "Unfilled" },
          { key: "prefilled", label: "Pre-filled", value: snap.prefilled, color: PREFILLED_COLOR, side: "Complete" },
          { key: "finished", label: "Finished", value: snap.finished, color: FINISHED_COLOR, side: "Complete" },
        ]
      : [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[88vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-baseline gap-2">
            Manufacturing Completion
            <span className="text-sm font-normal text-muted-foreground">
              fillable SKUs &middot; finished + pre-filled vs. raw + in-production
            </span>
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-6">
          {/* Headline + time-to-clear */}
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="text-3xl font-bold tabular-nums">{Math.round(snap.pct)}%</p>
              <p className="text-xs text-muted-foreground">
                {snap.complete.toLocaleString()} complete of {snap.total.toLocaleString()} units
                &middot; {snap.unfilled.toLocaleString()} unfilled
              </p>
            </div>
            <div className="text-right">
              {clear && clear.days != null ? (
                <>
                  <p className="text-sm font-semibold text-foreground tabular-nums">
                    ~{Math.ceil(clear.days)} days to clear
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    {clear.totalWork.toLocaleString()} to make ready
                    ({clear.onHand.toLocaleString()} on hand + {clear.inbound.toLocaleString()} inbound)
                    &divide; {Math.round(clear.rate)}/day
                  </p>
                  <p className="text-[10px] text-muted-foreground/70">
                    at the trailing 30-day rtsing + pre-filled RTS pace
                  </p>
                </>
              ) : clear ? (
                <p className="text-[11px] text-muted-foreground">
                  No recent completion activity to estimate from
                </p>
              ) : null}
            </div>
          </div>

          {/* Completion % over time */}
          <div>
            <div className="mb-2 flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Completion % — history &amp; 30-day projection</p>
                <p className="text-[11px] text-muted-foreground">
                  projection lands freight on its ETA and converts at the trailing-30d rtsing pace
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
            <ResponsiveContainer width="100%" height={230}>
              <LineChart data={chartData} margin={{ top: 24, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(0,0%,18%)" />
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
                  minTickGap={40}
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
                  labelFormatter={(v: string) => {
                    try {
                      return format(parseISO(v), "MMM d, yyyy");
                    } catch {
                      return v;
                    }
                  }}
                  formatter={(value: number, name: string) => [`${Math.round(value)}%`, name]}
                />
                <Legend wrapperStyle={{ fontSize: 11, paddingTop: 4 }} />
                <ReferenceLine
                  x={todayStr}
                  stroke="hsl(0,0%,75%)"
                  strokeDasharray="3 3"
                  label={{ value: "Today", fill: "hsl(0,0%,75%)", fontSize: 10, position: "top" }}
                />
                <Line
                  type="monotone"
                  dataKey="pct"
                  stroke={PCT_COLOR}
                  strokeWidth={2}
                  dot={false}
                  name="Actual"
                  connectNulls={false}
                />
                <Line
                  type="monotone"
                  dataKey="projectedPct"
                  stroke={PROJECTED_COLOR}
                  strokeWidth={2}
                  strokeDasharray="6 4"
                  dot={false}
                  name="Projected"
                  connectNulls={false}
                />
                {/* Sea freight arrival markers — small dots along the bottom.
                    Filled = already arrived, hollow = expected (by ETA). */}
                {seaArrivals.map((m) => (
                  <ReferenceDot
                    key={m.id}
                    x={m.day}
                    y={4}
                    r={3.5}
                    fill={m.arrived ? SEA_COLOR : CHART_BG}
                    stroke={SEA_COLOR}
                    strokeWidth={1.5}
                    ifOverflow="hidden"
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
            <div className="mt-1 flex items-center justify-end gap-3 text-[10px] text-muted-foreground">
              <span className="flex items-center gap-1">
                <span
                  className="inline-block h-2 w-2 rounded-full"
                  style={{ backgroundColor: SEA_COLOR }}
                />
                sea arrival
              </span>
              <span className="flex items-center gap-1">
                <span
                  className="inline-block h-2 w-2 rounded-full border"
                  style={{ borderColor: SEA_COLOR, backgroundColor: "transparent" }}
                />
                expected
              </span>
            </div>
            {isLoading && (
              <p className="text-center text-xs text-muted-foreground">Loading history…</p>
            )}
          </div>

          {/* Pipeline stage breakdown */}
          <div>
            <p className="mb-2 text-sm font-medium">Pipeline stages (now)</p>
            <div className="flex h-8 w-full overflow-hidden rounded-md">
              {stages.map((s) =>
                s.value > 0 ? (
                  <div
                    key={s.key}
                    style={{ width: `${(s.value / snap.total) * 100}%`, backgroundColor: s.color }}
                    title={`${s.label}: ${s.value.toLocaleString()}`}
                  />
                ) : null,
              )}
            </div>
            <div className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-4">
              {stages.map((s) => (
                <div key={s.key} className="flex items-center gap-1.5 text-xs">
                  <span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: s.color }} />
                  <span className="text-muted-foreground">{s.label}</span>
                  <span className="ml-auto font-medium tabular-nums">{s.value.toLocaleString()}</span>
                </div>
              ))}
            </div>
          </div>

          {/* By-SKU breakdown */}
          <div>
            <p className="mb-2 text-sm font-medium">
              By SKU <span className="text-xs text-muted-foreground">— most unfilled work first</span>
            </p>
            <div className="max-h-64 overflow-y-auto rounded-md border border-border/50">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-muted/40 text-muted-foreground">
                  <tr className="text-left">
                    <th className="px-3 py-1.5 font-medium">SKU</th>
                    <th className="px-2 py-1.5 text-right font-medium">Unfilled</th>
                    <th className="px-2 py-1.5 text-right font-medium">Complete</th>
                    <th className="px-3 py-1.5 text-right font-medium">% done</th>
                  </tr>
                </thead>
                <tbody>
                  {snap.bySku.map((s) => (
                    <tr key={s.sku} className="border-t border-border/40">
                      <td className="px-3 py-1.5">
                        <span className="font-medium">{s.sku}</span>
                        <span className="ml-1.5 text-muted-foreground/70 hidden sm:inline">{s.name}</span>
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums">
                        {s.unfilled > 0 ? (
                          <span className="text-orange-400">{s.unfilled.toLocaleString()}</span>
                        ) : (
                          <span className="text-muted-foreground/50">0</span>
                        )}
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">
                        {s.complete.toLocaleString()}
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums">
                        <span
                          className={cn(
                            "font-medium",
                            s.pct >= 90
                              ? "text-green-400"
                              : s.pct >= 60
                                ? "text-yellow-400"
                                : "text-red-400",
                          )}
                        >
                          {Math.round(s.pct)}%
                        </span>
                      </td>
                    </tr>
                  ))}
                  {snap.bySku.length === 0 && (
                    <tr>
                      <td colSpan={4} className="px-3 py-6 text-center text-muted-foreground">
                        No fillable SKU inventory
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
