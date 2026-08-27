import { useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Plus, Rocket, Pencil, Trash2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useLaunches, useDeleteLaunch, useInventory, useFactoryOrders, useFreightShipments, useFreightLineItems, type MktLaunchWithMembers } from "@/lib/hooks";
import { useSetLaunchApproval } from "@/lib/hooks/use-marketing-signals";
import { useAuth } from "@/lib/auth-context";
import { LaunchFormDialog } from "@/components/marketing/LaunchFormDialog";
import { ConfirmCell } from "@/components/marketing/ConfirmCell";
import { launchPhase, LAUNCH_PHASE_COLOR, LAUNCH_PHASE_LABEL, isPastKey, dayKeyOf } from "@/lib/marketing-format";
import { toast } from "@/hooks/use-toast";
import { describeError } from "@/lib/supabase-error";
import { format, parseISO, addDays } from "date-fns";
import { orderByFromReadyBy } from "@/lib/marketing/workback";

function fmt(d: string | null): string {
  if (!d) return "—";
  try { return format(parseISO(d), "MMM d, yyyy"); } catch { return d; }
}

/**
 * The single most urgent stock signal for an upcoming launch, in priority
 * order: SKUs the incoming pipeline won't cover → order window passed →
 * order-by inside 14d → covered by incoming freight/orders → stock on hand
 * → a quiet order-by date. One chip per row — the old page stacked several.
 */
function stockSignal(
  l: MktLaunchWithMembers,
  realMembers: MktLaunchWithMembers["skus"],
  onHandBySku: Map<string, number>,
  incomingBySku: Map<string, string>,
  todayKey: string,
): ReactNode {
  const launchDay = l.launch_date;
  const orderBy = l.inventory_ready_by ? orderByFromReadyBy(l.inventory_ready_by) : null;
  const dry = launchDay ? realMembers.filter((m) => (onHandBySku.get(m.sku_id!) ?? 0) <= 0) : [];
  const uncovered = dry.filter((m) => {
    const eta = incomingBySku.get(m.sku_id!);
    return !eta || (launchDay && eta > launchDay);
  });

  if (launchDay && realMembers.length > 0 && uncovered.length > 0) {
    return (
      <span className="w-fit rounded border border-red-500/40 bg-red-500/10 px-1.5 py-0.5 text-[10px] text-red-400"
        title={uncovered.map((m) => m.product?.sku ?? m.planned_name ?? "?").join(", ")}>
        ⚠ {uncovered.length} SKU{uncovered.length > 1 ? "s" : ""} not covered by launch
      </span>
    );
  }
  if (orderBy && todayKey > orderBy && dry.some((m) => !incomingBySku.has(m.sku_id!))) {
    return <span className="w-fit rounded border border-red-500/40 bg-red-500/10 px-1.5 py-0.5 text-[10px] text-red-400">order window passed ({fmt(orderBy)})</span>;
  }
  if (orderBy && todayKey <= orderBy && format(addDays(new Date(), 14), "yyyy-MM-dd") >= orderBy) {
    return <span className="w-fit rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-400">order by {fmt(orderBy)}</span>;
  }
  if (launchDay && dry.length > 0) {
    const latest = dry.map((m) => incomingBySku.get(m.sku_id!)!).sort().pop()!;
    return <span className="w-fit rounded border border-cyan-500/30 bg-cyan-500/10 px-1.5 py-0.5 text-[10px] text-cyan-300">incoming by {fmt(latest)}</span>;
  }
  if (launchDay && realMembers.length > 0) {
    return <span className="w-fit rounded border border-green-500/30 bg-green-500/10 px-1.5 py-0.5 text-[10px] text-green-400">stock on hand</span>;
  }
  if (orderBy && todayKey <= orderBy) {
    return <span className="w-fit rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">order by {fmt(orderBy)}</span>;
  }
  return null;
}

export default function Launches() {
  const { data: launches = [], isLoading } = useLaunches();
  const { data: inventory = [] } = useInventory();
  const { isAdmin, isManager, profile } = useAuth();
  const canEdit = isAdmin || isManager;
  const del = useDeleteLaunch();
  const todayKey = format(new Date(), "yyyy-MM-dd");
  const setApproval = useSetLaunchApproval();

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

  // Earliest incoming date per SKU — open factory-order expected completion
  // or in-transit freight ETA. Drives the derived stock-readiness chips
  // (no manual linking; consistent with the derived-signals philosophy).
  const { data: factoryOrders = [] } = useFactoryOrders();
  const { data: freightShipments = [] } = useFreightShipments();
  const { data: freightLines = [] } = useFreightLineItems();
  const incomingBySku = useMemo(() => {
    const m = new Map<string, string>();
    const consider = (sku: string | null, date: string | null | undefined) => {
      if (!sku || !date) return;
      const cur = m.get(sku);
      if (!cur || date < cur) m.set(sku, date);
    };
    for (const fo of factoryOrders) {
      if (fo.status === "shipped" || fo.status === "canceled") continue;
      for (const it of fo.items ?? []) consider(it.sku_id, fo.expected_completion);
    }
    const live = new Set(freightShipments.filter((s) => s.status !== "delivered").map((s) => s.id));
    for (const li of freightLines) {
      if (!li.sku_id || !live.has(li.freight_shipment_id)) continue;
      consider(li.sku_id, freightShipments.find((s) => s.id === li.freight_shipment_id)?.eta);
    }
    return m;
  }, [factoryOrders, freightShipments, freightLines]);

  // Upcoming first (soonest on top, undated leading — they need a date),
  // then past newest-first under a quiet divider.
  const { upcoming, past } = useMemo(() => {
    const up: MktLaunchWithMembers[] = [];
    const pa: MktLaunchWithMembers[] = [];
    for (const l of launches) {
      (l.launch_date && isPastKey(dayKeyOf(l.launch_date), todayKey) ? pa : up).push(l);
    }
    up.sort((a, b) => (a.launch_date ?? "").localeCompare(b.launch_date ?? ""));
    pa.sort((a, b) => (b.launch_date ?? "").localeCompare(a.launch_date ?? ""));
    return { upcoming: up, past: pa };
  }, [launches, todayKey]);

  async function handleDelete(l: MktLaunchWithMembers) {
    if (!window.confirm(`Delete "${l.name}"?`)) return;
    try {
      await del.mutateAsync(l.id);
      toast({ title: "Launch deleted" });
    } catch (err) {
      toast({ title: "Couldn't delete", description: describeError(err), variant: "destructive" });
    }
  }

  function Row({ l }: { l: MktLaunchWithMembers }) {
    const memberLabels = l.skus.map((m) => m.product?.sku || m.planned_name || "?");
    const realMembers = l.skus.filter((m) => m.sku_id);
    const soldCount = realMembers.filter((m) => (onHandBySku.get(m.sku_id!) ?? 0) <= 0).length;
    const total = realMembers.length;
    const allSold = total > 0 && soldCount === total;
    const phase = launchPhase(l.launch_date, todayKey, allSold);
    return (
      <tr className="border-t border-border/40 hover:bg-muted/20">
        <td className="px-4 py-3">
          <p className="font-medium">
            {l.name}
            {/* Drafted from a Product Development card — link back to it. */}
            {l.pd_project_id && (
              <Link
                to={`/marketing/product-development?card=${l.pd_project_id}`}
                onClick={(e) => e.stopPropagation()}
                className="ml-2 rounded border border-primary/40 px-1.5 py-0.5 text-[10px] font-normal text-primary hover:bg-primary/10"
              >
                from PD
              </Link>
            )}
          </p>
          <p className="mt-0.5 truncate text-xs text-muted-foreground" title={memberLabels.join(", ")}>
            <span className="capitalize">{l.kind.replace("_", " ")}</span>
            {memberLabels.length > 0 && <> · {memberLabels.join(", ")}</>}
          </p>
        </td>
        <td className="px-4 py-3 tabular-nums">
          {fmt(l.launch_date)}
          {l.inventory_ready_by && (
            <p className="text-[10px] text-muted-foreground">ready by {fmt(l.inventory_ready_by)}</p>
          )}
        </td>
        <td className="px-4 py-3">
          {!phase ? (
            <span className="text-xs text-muted-foreground/60">no date</span>
          ) : (
            <div className="flex flex-col gap-0.5">
              <span className={`w-fit rounded px-2 py-0.5 text-xs ${LAUNCH_PHASE_COLOR[phase]}`}>{LAUNCH_PHASE_LABEL[phase]}</span>
              {phase === "launched" && soldCount > 0 && (
                <span className="text-[10px] text-amber-400/80">{soldCount} of {total} sold out</span>
              )}
              {phase === "upcoming" && stockSignal(l, realMembers, onHandBySku, incomingBySku, todayKey)}
              {/* Outcomes once the 30d window has elapsed */}
              {phase !== "upcoming" && realMembers.some((m) => m.actual_first_30d_units != null || m.sold_out_at) && (
                <div className="text-[10px] text-muted-foreground space-y-0">
                  {realMembers.filter((m) => m.actual_first_30d_units != null || m.sold_out_at).map((m) => (
                    <p key={m.id}>
                      <span className="font-mono">{m.product?.sku ?? "?"}</span>
                      {m.actual_first_30d_units != null && (
                        <> · 30d: <span className="text-foreground">{m.actual_first_30d_units}</span>{m.expected_first_30d_units != null && <> vs {m.expected_first_30d_units} expected</>}</>
                      )}
                      {m.sold_out_at && <> · <span className="text-amber-400">sold out {fmt(m.sold_out_at)}</span></>}
                    </p>
                  ))}
                </div>
              )}
            </div>
          )}
        </td>
        <td className="px-4 py-3">
          <ConfirmCell
            status={(l as MktLaunchWithMembers & { approval_status?: string }).approval_status}
            canEdit={canEdit && !!profile?.id}
            pending={setApproval.isPending}
            onSet={(confirmed) =>
              setApproval.mutate({ id: l.id, status: confirmed ? "confirmed" : "draft", actorId: profile!.id })
            }
          />
        </td>
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
                  <th className="px-4 py-2.5 font-medium">Date</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                  <th className="px-4 py-2.5 font-medium">Confirmed</th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {upcoming.map((l) => <Row key={l.id} l={l} />)}
                {upcoming.length > 0 && past.length > 0 && (
                  <tr className="border-t border-border/40">
                    <td colSpan={5} className="px-4 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">
                      Past
                    </td>
                  </tr>
                )}
                {past.map((l) => <Row key={l.id} l={l} />)}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
