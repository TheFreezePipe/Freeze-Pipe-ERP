import { useState, lazy, Suspense } from "react";
import { CheckCircle2, Printer, RefreshCw, Truck } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CartonLink } from "@/components/warehouse/CartonLink";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { describeError } from "@/lib/supabase-error";
import { useResuggestPutaway, type ShipmentPutawayRow } from "@/lib/hooks";
import { reasonWords } from "./lpn-progress";

// Lazy: LabelSheet pulls in the barcode renderer (~1 MB); load it on first print.
const LabelSheet = lazy(() => import("@/components/warehouse/LabelSheet"));

// ---------------------------------------------------------------------------
// PutawayQueueCard — the shipment page's putaway queue (design §7, §9.3): one
// row per LPN (or per SKU of loose units) with what it holds, the suggested
// bay and why, and where it stands. Re-suggest asks rpc_wh_suggest_putaway
// for another bay, excluding every bay already suggested for that carton
// here; Reprint queues a new label job for the carton (LabelSheet). The phone
// does the putting away; this card follows it live (useShipmentPutaway).
// ---------------------------------------------------------------------------

interface Props {
  rows: ShipmentPutawayRow[];
  /** Re-suggest and Reprint (admin/manager on the dock desktop). */
  canEdit: boolean;
}

const STATUS_CHIP: Record<string, string> = {
  open: "border-amber-500/40 bg-amber-500/10 text-amber-400",
  in_progress: "border-blue-500/40 bg-blue-500/10 text-blue-400",
  done: "border-green-500/40 bg-green-500/10 text-green-400",
  cancelled: "border-border bg-muted/30 text-muted-foreground",
};

function contentsOf(row: ShipmentPutawayRow): string {
  const c = row.container;
  if (!c) return `${row.sku?.sku ?? "?"} · loose`;
  const held = c.balances.filter((b) => b.on_hand > 0);
  if (c.sku_id) return held[0]?.sku?.sku ?? row.sku?.sku ?? "—";
  if (held.length === 0) return "MIXED";
  return "MIXED " + held.map((b) => `${b.sku?.sku ?? "?"}×${b.on_hand}`).join(" + ");
}

function unitsOf(row: ShipmentPutawayRow): number {
  if (!row.container) return row.qty ?? 0;
  return row.container.qty > 0 ? row.container.qty : row.container.qty_initial;
}

function statusText(row: ShipmentPutawayRow): string {
  switch (row.status) {
    case "open":
      return `Waiting at ${row.container?.location?.code ?? "IN-01"}`;
    case "in_progress":
      return "Being put away";
    case "done":
      return `In ${row.to?.code ?? "a bay"}${row.followed_suggestion === false ? " (not the suggestion)" : ""}`;
    default:
      return row.container?.state === "void" ? "Voided" : "Cancelled";
  }
}

export function PutawayQueueCard({ rows, canEdit }: Props) {
  const { toast } = useToast();
  const resuggest = useResuggestPutaway();
  // Bays already suggested per task here, so Re-suggest walks on instead of bouncing back.
  const [tried, setTried] = useState<Record<string, string[]>>({});
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [labels, setLabels] = useState<{ ids: string[]; title: string } | null>(null);
  const [showClosed, setShowClosed] = useState(false);

  const active = rows.filter((r) => r.status !== "cancelled");
  const done = active.filter((r) => r.status === "done").length;
  const cancelled = rows.length - active.length;
  const visible = showClosed ? rows : rows.filter((r) => r.status === "open" || r.status === "in_progress");
  const openCartonIds = rows
    .filter((r) => (r.status === "open" || r.status === "in_progress") && r.container)
    .map((r) => r.container!.id);
  const allDone = active.length > 0 && done === active.length;

  async function suggestAnother(row: ShipmentPutawayRow) {
    if (!row.container) return;
    const exclude = [...new Set([...(tried[row.id] ?? []), ...(row.suggested_location_id ? [row.suggested_location_id] : [])])];
    setPendingId(row.id);
    try {
      const res = await resuggest.mutateAsync({ containerId: row.container.id, exclude });
      setTried((t) => ({ ...t, [row.id]: exclude }));
      toast({
        title: res.suggestion.code ? `${row.container.code}: try ${res.suggestion.code}` : `${row.container.code}: no other free bay`,
        description: reasonWords(res.suggestion.reason),
      });
    } catch (err) {
      toast({ title: "Couldn't suggest another bay", description: describeError(err), variant: "destructive" });
    } finally {
      setPendingId(null);
    }
  }

  if (rows.length === 0) return null;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
        <CardTitle className="text-base flex items-center gap-2">
          <Truck className="h-4 w-4" />
          Put away
          <span
            className={cn(
              "rounded-full border px-2 py-px text-[11px] font-semibold tabular-nums",
              allDone ? STATUS_CHIP.done : STATUS_CHIP.open,
            )}
          >
            {done} of {active.length}
          </span>
          {cancelled > 0 && (
            <span className="font-normal text-xs text-muted-foreground">{cancelled} voided</span>
          )}
        </CardTitle>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-xs text-muted-foreground"
            onClick={() => setShowClosed((v) => !v)}
          >
            {showClosed ? "Hide put away" : "Show all"}
          </Button>
          {canEdit && openCartonIds.length > 0 && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              onClick={() => setLabels({ ids: openCartonIds, title: `${openCartonIds.length} carton labels` })}
            >
              <Printer className="mr-1.5 h-3.5 w-3.5" /> Reprint waiting
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {visible.length === 0 ? (
          <p className="flex items-center gap-2 px-4 pb-4 text-sm text-green-400">
            <CheckCircle2 className="h-4 w-4" /> Everything from this shipment is on a shelf.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                  <th className="px-4 py-3">LPN</th>
                  <th className="px-3 py-3">Contents</th>
                  <th className="px-3 py-3 text-right">Units</th>
                  <th className="px-3 py-3">Suggested</th>
                  <th className="px-3 py-3">Why</th>
                  <th className="px-3 py-3">Status</th>
                  {canEdit && <th className="px-4 py-3" />}
                </tr>
              </thead>
              <tbody>
                {visible.map((row) => {
                  const live = row.status === "open" || row.status === "in_progress";
                  return (
                    <tr key={row.id} className={cn("border-b border-border/50", !live && "opacity-70")}>
                      <td className="px-4 py-2.5 font-mono text-xs font-semibold whitespace-nowrap">
                        {row.container?.code ? (
                          <CartonLink code={row.container.code} />
                        ) : (
                          <span className="font-sans font-normal text-muted-foreground">Loose units</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-xs">{contentsOf(row)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{unitsOf(row).toLocaleString()}</td>
                      <td className="px-3 py-2.5 font-mono text-xs whitespace-nowrap">
                        {row.suggested?.code ?? (live ? <span className="font-sans text-amber-400">any bay</span> : "—")}
                      </td>
                      <td className="px-3 py-2.5 text-xs text-muted-foreground">{reasonWords(row.suggestion_reason)}</td>
                      <td className="px-3 py-2.5">
                        <span
                          className={cn(
                            "inline-flex rounded-full border px-2 py-px text-[11px] font-medium whitespace-nowrap",
                            STATUS_CHIP[row.status] ?? STATUS_CHIP.cancelled,
                          )}
                        >
                          {statusText(row)}
                        </span>
                      </td>
                      {canEdit && (
                        <td className="px-4 py-2.5">
                          {row.container && (
                            <div className="flex items-center justify-end gap-1">
                              {live && (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="h-7 px-2 text-xs"
                                  onClick={() => suggestAnother(row)}
                                  disabled={pendingId !== null}
                                  title="Suggest another bay"
                                >
                                  <RefreshCw className={cn("mr-1 h-3 w-3", pendingId === row.id && "animate-spin")} />
                                  Re-suggest
                                </Button>
                              )}
                              {row.container.state !== "void" && (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="h-7 px-2 text-xs"
                                  onClick={() => setLabels({ ids: [row.container!.id], title: `label ${row.container!.code}` })}
                                  title="Print this carton's label again"
                                >
                                  <Printer className="mr-1 h-3 w-3" /> Reprint
                                </Button>
                              )}
                            </div>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
      {labels && (
        <Suspense fallback={null}>
          <LabelSheet
            open
            onOpenChange={(open) => !open && setLabels(null)}
            kind="lpn"
            ids={labels.ids}
            from="dock"
            title={labels.title}
          />
        </Suspense>
      )}
    </Card>
  );
}
