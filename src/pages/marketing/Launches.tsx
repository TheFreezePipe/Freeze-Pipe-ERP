import { useMemo, useState } from "react";
import { Plus, Rocket, Pencil, Trash2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useLaunches, useDeleteLaunch, useInventory, type MktLaunchWithMembers } from "@/lib/hooks";
import { useSetLaunchApproval, type ApprovalStatus } from "@/lib/hooks/use-marketing-signals";
import { useAuth } from "@/lib/auth-context";
import { LaunchFormDialog } from "@/components/marketing/LaunchFormDialog";
import { launchPhase, LAUNCH_PHASE_COLOR, LAUNCH_PHASE_LABEL, isPastKey, dayKeyOf } from "@/lib/marketing-format";
import { toast } from "@/hooks/use-toast";
import { describeError } from "@/lib/supabase-error";
import { format, parseISO } from "date-fns";

function fmt(d: string | null): string {
  if (!d) return "—";
  try { return format(parseISO(d), "MMM d, yyyy"); } catch { return d; }
}

export default function Launches() {
  const { data: launches = [], isLoading } = useLaunches();
  const { data: inventory = [] } = useInventory();
  const { isAdmin, isManager, profile } = useAuth();
  const canEdit = isAdmin || isManager;
  const del = useDeleteLaunch();
  const todayKey = format(new Date(), "yyyy-MM-dd");
  const setApproval = useSetLaunchApproval();

  // draft → proposed → confirmed (mirrors SalesList); confirmation stamps
  // who/when and later gates the launch into the forecast overlay.
  function ApprovalCell({ l }: { l: MktLaunchWithMembers }) {
    const status = ((l as MktLaunchWithMembers & { approval_status?: ApprovalStatus }).approval_status ?? "draft") as ApprovalStatus;
    const chip =
      status === "confirmed" ? (
        <span className="rounded border border-green-500/30 bg-green-500/10 px-2 py-0.5 text-xs text-green-400">confirmed</span>
      ) : status === "proposed" ? (
        <span className="rounded border border-dashed border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-xs text-amber-400">proposed</span>
      ) : (
        <span className="rounded border border-dashed border-border px-2 py-0.5 text-xs text-muted-foreground">draft</span>
      );
    const next: ApprovalStatus | null = status === "draft" ? "proposed" : status === "proposed" ? "confirmed" : null;
    return (
      <span className="inline-flex items-center gap-1.5">
        {chip}
        {canEdit && next && profile?.id && (
          <Button
            variant="outline"
            size="sm"
            className="h-6 px-2 text-[11px]"
            disabled={setApproval.isPending}
            onClick={() => setApproval.mutate({ id: l.id, status: next, actorId: profile.id })}
          >
            {next === "proposed" ? "Propose" : "Ops confirm"}
          </Button>
        )}
      </span>
    );
  }

  // Total on-hand units per SKU — a launch reads "Sold out" once its linked
  // SKU has nothing left in the building.
  const onHandBySku = useMemo(() => {
    const m = new Map<string, number>();
    for (const inv of inventory) {
      m.set(
        inv.sku_id,
        (inv.warehouse_raw ?? 0) +
          (inv.warehouse_prefilled_raw ?? 0) +
          (inv.warehouse_in_production ?? 0) +
          (inv.warehouse_finished ?? 0) +
          (inv.warehouse_other ?? 0),
      );
    }
    return m;
  }, [inventory]);
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<MktLaunchWithMembers | null>(null);

  async function handleDelete(l: MktLaunchWithMembers) {
    if (!window.confirm(`Delete "${l.name}"?`)) return;
    try {
      await del.mutateAsync(l.id);
      toast({ title: "Launch deleted" });
    } catch (err) {
      toast({ title: "Couldn't delete", description: describeError(err), variant: "destructive" });
    }
  }

  return (
    <div className="space-y-6 max-w-5xl">
      <LaunchFormDialog open={createOpen} onOpenChange={setCreateOpen} />
      <LaunchFormDialog
        open={!!editing}
        onOpenChange={(o) => !o && setEditing(null)}
        launch={editing}
        datesLocked={!!editing && isPastKey(dayKeyOf(editing.launch_date), todayKey)}
      />

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Launches &amp; Drops</h1>
          <p className="text-muted-foreground">New products, limited drops, and restocks</p>
        </div>
        {canEdit && (
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="mr-2 h-4 w-4" /> New Launch
          </Button>
        )}
      </div>

      {isLoading ? (
        <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">Loading launches…</div>
      ) : launches.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <Rocket className="h-8 w-8 text-muted-foreground/50" />
            <p className="text-sm text-muted-foreground">No launches planned yet.</p>
            {canEdit && (
              <Button variant="outline" size="sm" onClick={() => setCreateOpen(true)}>
                <Plus className="mr-2 h-4 w-4" /> Plan a launch
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead className="border-b border-border/50 text-left text-muted-foreground">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Launch</th>
                  <th className="px-4 py-2.5 font-medium">Type</th>
                  <th className="px-4 py-2.5 font-medium">Date</th>
                  <th className="px-4 py-2.5 font-medium">Ready by</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                  <th className="px-4 py-2.5 font-medium">Approval</th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {launches.map((l) => {
                  const memberLabels = l.skus.map((m) => m.product?.sku || m.planned_name || "?");
                  const realMembers = l.skus.filter((m) => m.sku_id);
                  const soldCount = realMembers.filter((m) => (onHandBySku.get(m.sku_id!) ?? 0) <= 0).length;
                  const total = realMembers.length;
                  const allSold = total > 0 && soldCount === total;
                  const phase = launchPhase(l.launch_date, todayKey, allSold);
                  return (
                  <tr key={l.id} className="border-t border-border/40 hover:bg-muted/20">
                    <td className="px-4 py-3">
                      <p className="font-medium">{l.name}</p>
                      {memberLabels.length > 0 && (
                        <p className="mt-0.5 truncate text-xs text-muted-foreground" title={memberLabels.join(", ")}>
                          {l.skus.length} {l.skus.length === 1 ? "product" : "products"} · {memberLabels.join(", ")}
                        </p>
                      )}
                    </td>
                    <td className="px-4 py-3 capitalize text-muted-foreground">{l.kind.replace("_", " ")}</td>
                    <td className="px-4 py-3 tabular-nums">{fmt(l.launch_date)}</td>
                    <td className="px-4 py-3 tabular-nums text-muted-foreground">{fmt(l.inventory_ready_by)}</td>
                    <td className="px-4 py-3">
                      {!phase ? (
                        <span className="text-xs text-muted-foreground/60">no date</span>
                      ) : (
                        <div className="flex flex-col gap-0.5">
                          <span className={`w-fit rounded px-2 py-0.5 text-xs ${LAUNCH_PHASE_COLOR[phase]}`}>{LAUNCH_PHASE_LABEL[phase]}</span>
                          {phase === "launched" && soldCount > 0 && (
                            <span className="text-[10px] text-amber-400/80">{soldCount} of {total} sold out</span>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3"><ApprovalCell l={l} /></td>
                    <td className="px-4 py-3 text-right">
                      {canEdit && (
                        <div className="flex justify-end gap-1">
                          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setEditing(l)}>
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <Button variant="ghost" size="icon" className="h-7 w-7 text-red-400 hover:text-red-300" onClick={() => handleDelete(l)}>
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      )}
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
