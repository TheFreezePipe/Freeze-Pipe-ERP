import { StatCard } from "@/components/shared/StatCard";
import { Factory, Package, PackageCheck, Clock } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { computeManufacturingPriority } from "@/lib/inventory-math";
import { getEffectiveDemand } from "@/lib/demand";
import { useMemo } from "react";
import { cn } from "@/lib/utils";
import { useInventory, useTaskLogs } from "@/lib/hooks";

export default function ManufacturingDashboard() {
  const { data: inventory = [], isLoading: inventoryLoading } = useInventory();
  const { data: taskLogs = [], isLoading: logsLoading } = useTaskLogs(200);

  const stats = useMemo(() => {
    const raw = inventory.reduce((s, i) => s + i.warehouse_raw, 0);
    const wip = inventory.reduce((s, i) => s + i.warehouse_in_production, 0);
    const finished = inventory.reduce((s, i) => s + i.warehouse_finished, 0);
    // "Today" = start of today in the browser's local timezone. Prefer
    // time_completed (when the operator actually finished the task); fall
    // back to created_at for older rows that pre-date the column. Earlier
    // this summed across ALL task_logs returned by the hook, which made the
    // stat a total-lifetime-output count rather than today's.
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const startOfTodayMs = startOfToday.getTime();
    const todayOutput = taskLogs.reduce((s, t) => {
      const when = t.time_completed ?? t.created_at;
      return when && new Date(when).getTime() >= startOfTodayMs
        ? s + t.quantity_processed
        : s;
    }, 0);
    return { raw, wip, finished, todayOutput };
  }, [inventory, taskLogs]);

  const pipelineRows = useMemo(() => {
    return inventory
      .filter(inv => inv.product?.category === "fillable")
      .map(inv => {
        const product = inv.product;
        const total = inv.warehouse_raw + inv.warehouse_in_production + inv.warehouse_finished;
        const priority = computeManufacturingPriority(
          inv.warehouse_raw,
          inv.warehouse_in_production,
          inv.warehouse_finished,
          getEffectiveDemand(product.id, product.monthly_demand),
          product.abc_classification,
        );
        return { inv, product, total, priority };
      })
      .sort((a, b) => b.priority.score - a.priority.score);
  }, [inventory]);

  // DOS color tiers — green > 40d, yellow 20-40, red < 10d. Centralized
  // constants so adjusting the bands is a one-line change.
  const DOS_RED = 10;
  const DOS_YELLOW = 20;
  const DOS_GREEN = 40;
  function dosColor(dos: number) {
    if (dos < DOS_RED) return "text-red-400";
    if (dos < DOS_YELLOW) return "text-yellow-400";
    if (dos < DOS_GREEN) return "text-green-400";
    return "text-muted-foreground";
  }

  // Manufacturing priority score → urgency tier. Bands derived from
  // observed score distribution across the catalog (top ~10% land in
  // Critical, next ~20% in High, etc.). Move to system_config when we
  // need org-level customization.
  const URGENCY_CRITICAL = 0.06;
  const URGENCY_HIGH = 0.03;
  const URGENCY_MEDIUM = 0.015;
  function urgencyLabel(score: number) {
    if (score >= URGENCY_CRITICAL) return { text: "Critical", className: "border-red-500 text-red-400" };
    if (score >= URGENCY_HIGH) return { text: "High", className: "border-orange-500 text-orange-400" };
    if (score >= URGENCY_MEDIUM) return { text: "Medium", className: "border-yellow-500 text-yellow-400" };
    return { text: "Low", className: "border-muted text-muted-foreground" };
  }

  if (inventoryLoading || logsLoading) {
    return (
      <div className="flex items-center justify-center h-64 text-muted-foreground text-sm">
        Loading manufacturing data…
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Manufacturing</h1>
        <p className="text-muted-foreground">Pipeline status and production overview</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard title="Raw Inventory" value={stats.raw.toLocaleString()} subtitle="Awaiting processing" icon={Package} iconColor="text-blue-400" />
        <StatCard title="In Production" value={stats.wip.toLocaleString()} subtitle="Being processed" icon={Factory} iconColor="text-orange-400" />
        <StatCard title="Finished" value={stats.finished.toLocaleString()} subtitle="Ready to ship" icon={PackageCheck} iconColor="text-green-400" />
        <StatCard title="Today's Output" value={stats.todayOutput} subtitle="Units completed" icon={Clock} iconColor="text-purple-400" />
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">Pipeline Status - Fillable SKUs</CardTitle>
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="text-[10px] text-muted-foreground cursor-help border-b border-dashed border-muted-foreground/40">
                    Sorted by priority
                  </span>
                </TooltipTrigger>
                <TooltipContent side="left" className="max-w-xs text-xs">
                  <p className="font-medium mb-1">Priority Score Formula</p>
                  <p className="text-muted-foreground">
                    (demand pressure) &times; (unfilled ratio) &times; (ABC weight)
                  </p>
                  <ul className="mt-1 space-y-0.5 text-muted-foreground">
                    <li><strong>Demand pressure</strong> = daily demand &divide; finished units</li>
                    <li><strong>Unfilled ratio</strong> = unfilled &divide; total warehouse</li>
                    <li><strong>ABC weight</strong> = A: 1.5&times; &middot; B: 1.0&times; &middot; C: 0.5&times;</li>
                  </ul>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {pipelineRows.map(({ inv, product, total, priority }, index) => {
            const rawPct = total > 0 ? (inv.warehouse_raw / total) * 100 : 0;
            const wipPct = total > 0 ? (inv.warehouse_in_production / total) * 100 : 0;
            const finPct = total > 0 ? (inv.warehouse_finished / total) * 100 : 0;
            const urgency = urgencyLabel(priority.score);

            return (
              <div key={inv.id} className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-xs font-bold tabular-nums text-muted-foreground w-4 shrink-0">
                      {index + 1}
                    </span>
                    <span className="font-medium text-sm">{product.sku}</span>
                    <span className="text-xs text-muted-foreground truncate hidden sm:inline">{product.product_name}</span>
                    <Badge variant="outline" className={cn("text-[9px] shrink-0", urgency.className)}>
                      {urgency.text}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-3 shrink-0 text-xs">
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className={cn("tabular-nums font-medium", dosColor(priority.finishedDOS))}>
                            {priority.finishedDOS}d
                          </span>
                        </TooltipTrigger>
                        <TooltipContent className="text-xs">
                          <p>{priority.finishedDOS} days of finished stock at {getEffectiveDemand(product.id, product.monthly_demand)}/mo demand</p>
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                    <span className="text-muted-foreground tabular-nums">
                      {priority.unfilledPct}% unfilled
                    </span>
                  </div>
                </div>
                <div className="flex h-6 w-full overflow-hidden rounded-full bg-muted">
                  {rawPct > 0 && (
                    <div
                      className="flex items-center justify-center bg-blue-500/80 text-[10px] font-medium text-white"
                      style={{ width: `${rawPct}%` }}
                      title={`Raw: ${inv.warehouse_raw}`}
                    >
                      {inv.warehouse_raw}
                    </div>
                  )}
                  {wipPct > 0 && (
                    <div
                      className="flex items-center justify-center bg-orange-500/80 text-[10px] font-medium text-white"
                      style={{ width: `${wipPct}%` }}
                      title={`WIP: ${inv.warehouse_in_production}`}
                    >
                      {inv.warehouse_in_production}
                    </div>
                  )}
                  {finPct > 0 && (
                    <div
                      className="flex items-center justify-center bg-green-500/80 text-[10px] font-medium text-white"
                      style={{ width: `${finPct}%` }}
                      title={`Finished: ${inv.warehouse_finished}`}
                    >
                      {inv.warehouse_finished}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
          <div className="flex items-center gap-6 pt-2 text-xs text-muted-foreground">
            <div className="flex items-center gap-1.5">
              <div className="h-3 w-3 rounded-full bg-blue-500/80" />
              Raw
            </div>
            <div className="flex items-center gap-1.5">
              <div className="h-3 w-3 rounded-full bg-orange-500/80" />
              In Production
            </div>
            <div className="flex items-center gap-1.5">
              <div className="h-3 w-3 rounded-full bg-green-500/80" />
              Finished
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
