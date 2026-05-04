import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Package } from "lucide-react";
import { TASK_TYPES } from "@/lib/constants";
import type { SkuSummary, TaskType } from "@/lib/performance/aggregate";
import { cn } from "@/lib/utils";

const TASK_TYPE_ORDER: TaskType[] = ["emptying", "filling_capping", "rtsing", "prefilled_rtsing"];

interface Props {
  summaries: SkuSummary[];
  rangeLabel: string;
}

export function SKUInsights({ summaries, rangeLabel }: Props) {
  const [selected, setSelected] = useState<SkuSummary | null>(null);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Package className="h-4 w-4" />
          SKU Insights
        </CardTitle>
        <p className="text-xs text-muted-foreground mt-0.5">{rangeLabel}</p>
      </CardHeader>
      <CardContent>
        {summaries.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            No SKUs processed in this range
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {summaries.map(s => (
              <button
                key={s.skuId}
                type="button"
                onClick={() => setSelected(s)}
                className="text-left rounded-lg border border-border/60 bg-muted/20 p-3 hover:bg-muted/40 hover:border-border transition-colors"
              >
                <div className="flex items-baseline justify-between gap-2 mb-2">
                  <p className="font-semibold text-sm truncate">{s.skuName}</p>
                  <p className="text-[10px] text-muted-foreground shrink-0">{s.totalTasks} {s.totalTasks === 1 ? "task" : "tasks"}</p>
                </div>
                <p className="text-xs text-muted-foreground mb-2">
                  <span className="font-semibold text-foreground tabular-nums">{s.itemsProcessed.toLocaleString()}</span> items processed
                </p>
                <div className="flex flex-wrap gap-1">
                  {TASK_TYPE_ORDER.map(t => {
                    const qty = s.byTaskType[t];
                    if (qty === 0) return null;
                    const info = TASK_TYPES[t];
                    return (
                      <Badge
                        key={t}
                        variant="outline"
                        className={cn("text-[10px] border-0", info.color, info.bgColor)}
                      >
                        {info.label} {qty}
                      </Badge>
                    );
                  })}
                </div>
              </button>
            ))}
          </div>
        )}
      </CardContent>

      <SkuDetailDialog summary={selected} onClose={() => setSelected(null)} rangeLabel={rangeLabel} />
    </Card>
  );
}

interface DialogProps {
  summary: SkuSummary | null;
  onClose: () => void;
  rangeLabel: string;
}

function SkuDetailDialog({ summary, onClose, rangeLabel }: DialogProps) {
  const PAGE_SIZE = 50;
  const [page, setPage] = useState(0);
  const [prevKey, setPrevKey] = useState(summary?.skuId ?? "");
  if (prevKey !== (summary?.skuId ?? "")) {
    setPrevKey(summary?.skuId ?? "");
    setPage(0);
  }

  if (!summary) return null;

  const pageCount = Math.max(1, Math.ceil(summary.tasks.length / PAGE_SIZE));
  const visible = summary.tasks.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  return (
    <Dialog open={!!summary} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>{summary.skuName}</DialogTitle>
          <p className="text-xs text-muted-foreground">{rangeLabel}</p>
        </DialogHeader>

        {/* Overview stats */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center">
          <Stat label="Items Processed" value={summary.itemsProcessed.toLocaleString()} />
          <Stat label="Tasks" value={summary.totalTasks.toString()} />
          {TASK_TYPE_ORDER.filter(t => summary.byTaskType[t] > 0).slice(0, 2).map(t => (
            <Stat key={t} label={TASK_TYPES[t].label} value={summary.byTaskType[t].toLocaleString()} />
          ))}
        </div>

        <div className="overflow-y-auto flex-1 -mx-6 px-6">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-background z-10">
              <tr className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                <th className="py-2">Time</th>
                <th className="py-2">Employee</th>
                <th className="py-2">Task</th>
                <th className="py-2 text-right">Qty</th>
                <th className="py-2 text-right">Duration</th>
                <th className="py-2">Notes</th>
              </tr>
            </thead>
            <tbody>
              {visible.map(t => {
                const info = TASK_TYPES[t.task_type];
                const durationMin = t.time_started && t.time_completed
                  ? Math.round((Date.parse(t.time_completed) - Date.parse(t.time_started)) / 60_000)
                  : null;
                return (
                  <tr key={t.id} className="border-b border-border/40">
                    <td className="py-2 text-xs text-muted-foreground tabular-nums">
                      {formatEtTimestamp(t.time_completed ?? t.created_at)}
                    </td>
                    <td className="py-2 text-xs">{t.employee_name ?? t.employee_id}</td>
                    <td className="py-2">
                      <Badge variant="outline" className={cn("text-[10px] border-0", info.color, info.bgColor)}>
                        {info.label}
                      </Badge>
                    </td>
                    <td className="py-2 text-right tabular-nums font-medium">{t.quantity_processed}</td>
                    <td className="py-2 text-right tabular-nums text-xs text-muted-foreground">
                      {durationMin !== null ? `${durationMin}m` : "-"}
                    </td>
                    <td className="py-2 text-xs text-muted-foreground max-w-[180px] truncate" title={t.notes ?? undefined}>
                      {t.notes ?? "-"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {pageCount > 1 && (
          <div className="flex items-center justify-between pt-2 border-t border-border/50 text-xs">
            <span className="text-muted-foreground">
              Showing {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, summary.tasks.length)} of {summary.tasks.length}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="px-2 py-1 rounded border border-border text-xs disabled:opacity-40"
                disabled={page === 0}
                onClick={() => setPage(p => p - 1)}
              >
                Prev
              </button>
              <span className="text-muted-foreground">{page + 1} / {pageCount}</span>
              <button
                type="button"
                className="px-2 py-1 rounded border border-border text-xs disabled:opacity-40"
                disabled={page >= pageCount - 1}
                onClick={() => setPage(p => p + 1)}
              >
                Next
              </button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border/60 bg-muted/30 p-2">
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="text-lg font-bold tabular-nums">{value}</p>
    </div>
  );
}

function formatEtTimestamp(iso: string | null): string {
  if (!iso) return "-";
  return new Date(iso).toLocaleString("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
