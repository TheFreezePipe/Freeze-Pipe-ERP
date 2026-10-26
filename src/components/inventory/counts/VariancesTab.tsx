import { useMemo, useState } from "react";
import { AlertTriangle, Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth-context";
import {
  BUCKET_WORDS,
  COUNT_KIND_WORDS,
  likelyCause,
  useWhApproveVariance,
  useWhCountTask,
  useWhCountTasks,
  type WhCountLine,
  type WhCountResolution,
  type WhCountTaskRow,
} from "@/lib/hooks/use-warehouse-counts";
import type { WhBucket } from "@/lib/hooks";
import type { WhCountKind } from "@/lib/hooks/use-warehouse-map";
import { WH_ZONE_COLORS } from "@/lib/status-colors";
import { LocationCode } from "@/components/warehouse/LocationCode";
import { cn } from "@/lib/utils";
import { Chip, TableShell } from "./shared";
import { errorText, signed, TD, TH, varianceClass, when } from "./format";

const RESOLUTIONS: { value: WhCountResolution; label: string; hint: string }[] = [
  { value: "accept", label: "Approve", hint: "Set the bin to the count and move the SKU total by the difference" },
  { value: "misplaced", label: "Misplaced", hint: "Set the bin to the count; the difference goes to or from UNLOCATED, the SKU total stays" },
  { value: "write_off", label: "Write off", hint: "Short only: take the missing units off the bin and the SKU total as a write-off" },
  { value: "recount", label: "Recount", hint: "Change nothing on this line and open a recount of the location" },
];

function needsDecision(line: Pick<WhCountLine, "variance" | "counted_qty" | "expected_qty" | "found_container_elsewhere">): boolean {
  const v = line.variance ?? line.counted_qty - line.expected_qty;
  return v !== 0 || line.found_container_elsewhere;
}

/**
 * Submitted counts waiting for a manager (§8 desktop): per line expected,
 * counted, variance, the label flag and a likely cause; per line Approve,
 * Misplaced, Write off or Recount, sent together, or Approve all.
 */
export function VariancesTab({ onOpenTasks }: { onOpenTasks: () => void }) {
  const { data: tasks = [], isLoading, error } = useWhCountTasks("submitted");
  const { hasRole } = useAuth();
  const canApprove = hasRole("admin", "manager");
  const sorted = useMemo(
    () => [...tasks].sort((a, b) => (a.submitted_at ?? a.created_at).localeCompare(b.submitted_at ?? b.created_at)),
    [tasks],
  );

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (error) return <p className="text-sm text-destructive">{errorText(error, "Couldn't load the counts")}</p>;
  if (sorted.length === 0) {
    return (
      <Card>
        <CardContent className="space-y-1 py-10 text-center">
          <p className="text-base font-semibold">No variances to approve</p>
          <p className="text-sm text-muted-foreground">
            A count with any difference waits here; a count that matches approves itself.{" "}
            <button type="button" className="text-primary hover:underline" onClick={onOpenTasks}>
              Open count tasks
            </button>
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {!canApprove && (
        <p className="text-sm text-muted-foreground">Read only: approving a count needs a manager or admin.</p>
      )}
      {sorted.map((t) => (
        <VarianceCard key={t.id} task={t} canApprove={canApprove} />
      ))}
      <p className="text-xs text-muted-foreground">
        Approve sets the bin to what was counted and posts the difference to the SKU's stock as a warehouse count
        adjustment. Misplaced moves the difference to or from UNLOCATED and leaves the SKU total alone. Write off (short
        lines only) posts a write-off. Recount changes nothing and opens a recount of the location.
      </p>
    </div>
  );
}

function VarianceCard({ task, canApprove }: { task: WhCountTaskRow; canApprove: boolean }) {
  const { toast } = useToast();
  const { data, isLoading, error } = useWhCountTask(task.id);
  const approve = useWhApproveVariance();
  const [choices, setChoices] = useState<Record<string, WhCountResolution>>({});
  const lines = data?.lines ?? [];
  const movements = data?.movements ?? [];
  const differing = lines.filter(needsDecision);
  const zone = task.location?.zone ?? "";

  function send(all: boolean) {
    const decisions = all
      ? []
      : Object.entries(choices)
          .filter(([, r]) => r !== "accept")
          .map(([line_id, resolution]) => ({ line_id, resolution }));
    approve.mutate(
      { countTaskId: task.id, decisions },
      {
        onSuccess: (res) => {
          const parts = [
            `${res.adjusted_units} unit${res.adjusted_units === 1 ? "" : "s"} adjusted in the bin`,
            res.levels_delta !== 0 ? `SKU stock ${signed(res.levels_delta)}` : "SKU stock unchanged",
          ];
          if (res.recounts.length > 0) parts.push("a recount is open");
          toast({ title: `${task.location?.code ?? "Count"} approved`, description: parts.join(" · ") });
        },
        onError: (err) =>
          toast({ title: "Couldn't approve the count", description: errorText(err, "Unknown error"), variant: "destructive" }),
      },
    );
  }

  const nonDefault = Object.values(choices).filter((r) => r !== "accept").length;

  return (
    <Card className={cn(task.moved_during_count && "border-amber-500/45")}>
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <LocationCode code={task.location?.code ?? "?"} size="small" className="text-xl font-bold" />
            {zone && <Chip className={WH_ZONE_COLORS[zone] ?? "border-border text-muted-foreground"}>{zone}</Chip>}
            <Chip className="border-border text-muted-foreground">{COUNT_KIND_WORDS[task.kind as WhCountKind] ?? task.kind}</Chip>
            {task.moved_during_count && (
              <Chip className="border-amber-500/40 bg-amber-500/10 text-amber-300" title="Stock moved at this location while it was being counted">
                <AlertTriangle className="mr-1 h-3 w-3" /> moved during count
              </Chip>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            Counted by <span className="text-foreground">{task.submitter?.full_name ?? "—"}</span> · {when(task.submitted_at)}
            {task.reason ? ` · ${task.reason}` : ""}
          </p>
        </div>

        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading lines…</p>
        ) : error ? (
          <p className="text-sm text-destructive">{errorText(error, "Couldn't load the lines")}</p>
        ) : (
          <TableShell minWidth={960}>
            <thead className="border-b border-border/50">
              <tr>
                <th className={TH}>SKU</th>
                <th className={TH}>Carton</th>
                <th className={cn(TH, "text-right")}>Expected</th>
                <th className={cn(TH, "text-right")}>Counted</th>
                <th className={cn(TH, "text-right")}>Variance</th>
                <th className={TH}>Likely cause</th>
                <th className={TH}>{canApprove ? "Decision" : "Status"}</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => {
                const v = l.variance ?? l.counted_qty - l.expected_qty;
                const open = needsDecision(l);
                const choice = choices[l.id] ?? "accept";
                return (
                  <tr key={l.id} className="border-b border-border/40 last:border-0">
                    <td className={TD}>
                      <span className="font-medium">{l.sku?.sku ?? "?"}</span>
                      <span className="block max-w-[14rem] truncate text-xs text-muted-foreground">
                        {l.sku?.product_name} · {BUCKET_WORDS[l.bucket as WhBucket] ?? l.bucket}
                      </span>
                    </td>
                    <td className={TD}>
                      {l.container ? (
                        <span className="font-mono text-xs tabular-nums">{l.container.code}</span>
                      ) : (
                        <span className="text-xs text-muted-foreground">loose</span>
                      )}
                      {l.label_flag && (
                        <Chip className="ml-1.5 border-amber-500/40 bg-amber-500/10 text-amber-300">
                          {l.label_flag === "needs_green" ? "needs green label" : "needs white label"}
                        </Chip>
                      )}
                      {l.found_container_elsewhere && (
                        <Chip className="ml-1.5 border-blue-500/40 bg-blue-500/10 text-blue-300">found elsewhere</Chip>
                      )}
                    </td>
                    <td className={cn(TD, "text-right tabular-nums")}>{l.expected_qty.toLocaleString()}</td>
                    <td className={cn(TD, "text-right tabular-nums")}>{l.counted_qty.toLocaleString()}</td>
                    <td className={cn(TD, "text-right font-semibold tabular-nums", varianceClass(v))}>{signed(v)}</td>
                    <td className={cn(TD, "max-w-[18rem] text-xs text-muted-foreground")}>
                      {likelyCause(task, l, movements)}
                    </td>
                    <td className={TD}>
                      {!open ? (
                        <span className="inline-flex items-center gap-1 text-xs text-green-400">
                          <Check className="h-3.5 w-3.5" /> matches
                        </span>
                      ) : canApprove ? (
                        <div className="flex flex-wrap gap-1" role="radiogroup" aria-label={`Decision for ${l.sku?.sku ?? "line"}`}>
                          {RESOLUTIONS.map((r) => {
                            const disabled = r.value === "write_off" && (v >= 0 || l.found_container_elsewhere);
                            return (
                              <button
                                key={r.value}
                                type="button"
                                role="radio"
                                aria-checked={choice === r.value}
                                disabled={disabled || approve.isPending}
                                title={r.hint}
                                onClick={() => setChoices((c) => ({ ...c, [l.id]: r.value }))}
                                className={cn(
                                  "h-7 rounded-md border px-2 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-40",
                                  choice === r.value
                                    ? "border-primary bg-primary/15 text-foreground"
                                    : "border-border text-muted-foreground hover:bg-muted/50",
                                )}
                              >
                                {r.label}
                              </button>
                            );
                          })}
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground">waiting</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </TableShell>
        )}

        {canApprove && !isLoading && !error && (
          <div className="flex flex-wrap items-center justify-end gap-2">
            <p className="mr-auto text-xs text-muted-foreground">
              {differing.length} line{differing.length === 1 ? "" : "s"} differ
              {nonDefault > 0 ? ` · ${nonDefault} not plain approve` : ""}
            </p>
            {nonDefault > 0 && (
              <Button size="sm" variant="outline" disabled={approve.isPending} onClick={() => send(false)}>
                {approve.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
                Apply decisions
              </Button>
            )}
            <Button size="sm" disabled={approve.isPending} onClick={() => send(true)}>
              {approve.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              Approve all
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
