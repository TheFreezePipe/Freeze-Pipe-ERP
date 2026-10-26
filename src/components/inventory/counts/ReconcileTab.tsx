import { useState } from "react";
import { Loader2, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth-context";
import type { WhBucket, WhReconcileResult } from "@/lib/hooks";
import { BUCKET_WORDS, useWhReconcileLatest, useWhRunReconcile } from "@/lib/hooks/use-warehouse-counts";
import { COUNT_STATUS_COLORS } from "@/lib/status-colors";
import { cn } from "@/lib/utils";
import { Chip, TableShell, Tile } from "./shared";
import { ago, errorText, signed, TD, TH, varianceClass, when } from "./format";

/**
 * The nightly physical reconciliation (§6). Per SKU: P physical on-hand,
 * O units deducted for open orders, H held for cancelled orders, S deducted
 * on shipped orders but not yet settled, L the ledger's level. The settled
 * identity is P − O = L; the residual R = P − O − H − S − L is the
 * discrepancy (other buckets: R = P − L). Lines link to the counts the run
 * opened. Admins can run it now, optionally as a dry read.
 */
export function ReconcileTab({ live, onOpenTask }: { live: boolean; onOpenTask: (id: string) => void }) {
  const { toast } = useToast();
  const { hasRole } = useAuth();
  const isAdmin = hasRole("admin");
  const { data, isLoading, error } = useWhReconcileLatest();
  const runNow = useWhRunReconcile();
  const [dryRead, setDryRead] = useState(true);
  const [result, setResult] = useState<WhReconcileResult | null>(null);
  const run = data?.run ?? null;
  const lines = data?.lines ?? [];

  function start() {
    runNow.mutate(
      { createCounts: !dryRead },
      {
        onSuccess: (res) => {
          setResult(res);
          toast({
            title: "Reconcile finished",
            description: `${res.mismatched_skus} SKU${res.mismatched_skus === 1 ? "" : "s"} off · ${res.counts_created} count${res.counts_created === 1 ? "" : "s"} opened`,
          });
        },
        onError: (err) => toast({ title: "Couldn't run the reconcile", description: errorText(err, "Unknown error"), variant: "destructive" }),
      },
    );
  }

  return (
    <div className="space-y-4">
      {!live && (
        <p className="rounded-md border border-border/60 px-3 py-2 text-xs text-muted-foreground">
          The physical layer is not live, so a run records its numbers but opens no counts and sweeps no settlements, and
          the nightly job does not run. Settings › Warehouse › Physical layer sets it live.
        </p>
      )}

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : error ? (
        <p className="text-sm text-destructive">{errorText(error, "Couldn't load the reconcile")}</p>
      ) : !run ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">No reconcile has run yet.</CardContent>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <Tile label="Run" value={ago(run.run_at)} sub={when(run.run_at)} />
            <Tile label="SKUs checked" value={run.skus_checked.toLocaleString()} />
            <Tile label="Off-by SKUs" value={run.mismatched_skus} tone={run.mismatched_skus > 0 ? "warn" : "ok"} />
            <Tile label="Σ |residual|" value={run.abs_residual_units.toLocaleString()} sub="units" tone={run.abs_residual_units > 0 ? "warn" : "ok"} />
            <Tile label="Unlocated" value={run.unlocated_units.toLocaleString()} sub="Σ |on hand| at UNLOCATED" />
            <Tile label="RTS not placed" value={run.rts_unplaced_cartons} sub="green cartons at the line > 2 h" />
          </div>

          {lines.length === 0 ? (
            <Card>
              <CardContent className="py-8 text-center text-sm text-muted-foreground">
                Every SKU reconciled: nothing off, held or unsettled.
              </CardContent>
            </Card>
          ) : (
            <TableShell minWidth={980}>
              <thead className="border-b border-border/50">
                <tr>
                  <th className={TH}>SKU</th>
                  <th className={TH}>Bucket</th>
                  <th className={cn(TH, "text-right")} title="Physical on hand at every active location">P</th>
                  <th className={cn(TH, "text-right")} title="Deducted for open orders">O</th>
                  <th className={cn(TH, "text-right")} title="Held for cancelled orders">H</th>
                  <th className={cn(TH, "text-right")} title="Deducted on shipped orders, not yet settled">S</th>
                  <th className={cn(TH, "text-right")} title="inventory_levels">L</th>
                  <th className={cn(TH, "text-right")} title="R = P − O − H − S − L">R</th>
                  <th className={TH}>Counts opened</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.id} className="border-b border-border/40 last:border-0">
                    <td className={TD}>
                      <span className="font-medium">{l.sku?.sku ?? "?"}</span>
                      <span className="block max-w-[14rem] truncate text-xs text-muted-foreground">{l.sku?.product_name}</span>
                    </td>
                    <td className={cn(TD, "text-muted-foreground")}>{BUCKET_WORDS[l.bucket as WhBucket] ?? l.bucket}</td>
                    <td className={cn(TD, "text-right tabular-nums")}>{l.physical.toLocaleString()}</td>
                    <td className={cn(TD, "text-right tabular-nums text-muted-foreground")}>{l.open_order_units.toLocaleString()}</td>
                    <td className={cn(TD, "text-right tabular-nums text-muted-foreground")}>{l.cancelled_held_units.toLocaleString()}</td>
                    <td className={cn(TD, "text-right tabular-nums text-muted-foreground")}>{l.unsettled_units.toLocaleString()}</td>
                    <td className={cn(TD, "text-right tabular-nums")}>{l.levels_value.toLocaleString()}</td>
                    <td className={cn(TD, "text-right font-semibold tabular-nums", varianceClass(l.residual))}>{signed(l.residual)}</td>
                    <td className={TD}>
                      {(l.count_task_ids ?? []).length === 0 ? (
                        <span className="text-xs text-muted-foreground">—</span>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {(l.count_task_ids ?? []).map((id) => {
                            const c = data?.counts[id];
                            return (
                              <button key={id} type="button" onClick={() => onOpenTask(id)} className="hover:opacity-80" title="Open in Count tasks">
                                <Chip className={COUNT_STATUS_COLORS[c?.status ?? ""] ?? "border-border text-muted-foreground"}>
                                  {c?.code ?? "count"} · {c?.status ?? "?"}
                                </Chip>
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </TableShell>
          )}

          {data && data.history.length > 1 && (
            <div className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground">Recent runs</p>
              <div className="flex flex-wrap gap-1.5">
                {data.history.map((h) => (
                  <span key={h.id} className="rounded-md border border-border/50 px-2 py-1 text-xs tabular-nums text-muted-foreground" title={when(h.run_at)}>
                    {when(h.run_at)} · {h.mismatched_skus} off · Σ{h.abs_residual_units}
                  </span>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {isAdmin && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Run reconcile now</CardTitle>
            <CardDescription>
              Runs nightly at 09:00 UTC once live. A run records its numbers, prunes zero balances and, when live, sweeps
              ship settlements. A dry read opens no count tasks.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-2">
              <Switch id="wh-rec-dry" checked={dryRead} onCheckedChange={setDryRead} />
              <Label htmlFor="wh-rec-dry">Dry read (no counts)</Label>
            </div>
            <Button size="sm" variant="outline" disabled={runNow.isPending} onClick={start}>
              {runNow.isPending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Play className="mr-1.5 h-4 w-4" />}
              Run reconcile now
            </Button>
            {result && (
              <p className="text-xs text-muted-foreground">
                Last run here: {result.skus_checked} SKUs checked, {result.mismatched_skus} off, Σ|R| {result.abs_residual_units},{" "}
                {result.counts_created} counts opened{result.counts_enabled ? "" : " (counts off)"}, {result.pruned_balances} zero
                balances pruned
                {result.live ? `, ${result.sweep.orders} orders swept` : ""}.
              </p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
