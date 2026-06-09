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
  ResponsiveContainer,
} from "recharts";
import { useMemo, useState } from "react";
import {
  useInventory,
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

export function ManufacturingCompletionModal({ open, onOpenChange }: Props) {
  const { data: inventory = [] } = useInventory();
  const [days, setDays] = useState(30);
  const { data: history = [], isLoading } = useManufacturingCompletionHistory(days);
  // Days-to-clear uses a fixed trailing-30d throughput basis, independent of
  // the chart range toggle above.
  const { data: estimate } = useManufacturingClearEstimate(30);

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
              <p className="text-sm font-medium">Completion % over time</p>
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
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={history} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
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
                  formatter={(value: number, _name, item: { payload?: { complete_units?: number; unfilled_units?: number } }) => [
                    `${Math.round(value)}% — ${(item?.payload?.complete_units ?? 0).toLocaleString()} complete / ${(item?.payload?.unfilled_units ?? 0).toLocaleString()} unfilled`,
                    "Completion",
                  ]}
                />
                <Line
                  type="monotone"
                  dataKey="pct"
                  stroke={PCT_COLOR}
                  strokeWidth={2}
                  dot={false}
                  name="Completion %"
                />
              </LineChart>
            </ResponsiveContainer>
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
