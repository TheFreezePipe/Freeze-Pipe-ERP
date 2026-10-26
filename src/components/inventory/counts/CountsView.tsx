import { useSearchParams } from "react-router-dom";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { useWarehouseSettings, useWhOverview } from "@/lib/hooks";
import { readPhysicalLayer } from "@/lib/hooks/use-warehouse-counts";
import { Tile } from "./shared";
import { ago, COUNTS_TABS, type CountsTab } from "./format";
import { VariancesTab } from "./VariancesTab";
import { CountTasksTab } from "./CountTasksTab";
import { ScheduleTab } from "./ScheduleTab";
import { MovesTab } from "./MovesTab";
import { ReconcileTab } from "./ReconcileTab";

const TAB_LABELS: Record<CountsTab, string> = {
  variances: "Variances",
  tasks: "Count tasks",
  schedule: "Schedule",
  moves: "Moves",
  reconcile: "Reconcile",
  replenishment: "Replenishment",
};

interface LastReconcile {
  run_at?: string;
  mismatched_skus?: number;
  abs_residual_units?: number;
}

/**
 * Stock › Counts (design §8 desktop, §6 reconcile; wireframe Counts): the
 * work that keeps bins honest. Tabs live in `?tab=` beside `?view=counts`:
 * Variances (approve, misplaced, write off, recount), Count tasks (and New
 * count), Schedule (the A/B/C cadence), Moves (putaway, replenish, move),
 * Reconcile (the nightly P − O − H − S − L check). Replenishment is Phase 2.
 */
export function CountsView() {
  const [params, setParams] = useSearchParams();
  const raw = params.get("tab") as CountsTab | null;
  const tab: CountsTab = raw && COUNTS_TABS.includes(raw) ? raw : "variances";
  const { data: overview } = useWhOverview();
  const { data: settings } = useWarehouseSettings();
  const layer = readPhysicalLayer(settings?.physical_layer);
  const last = (overview?.last_reconcile ?? null) as LastReconcile | null;

  function setTab(next: CountsTab, extra: Record<string, string | null> = {}) {
    setParams(
      (prev) => {
        const sp = new URLSearchParams(prev);
        if (next === "variances") sp.delete("tab");
        else sp.set("tab", next);
        // A highlighted task only makes sense on the tab that opened it.
        sp.delete("task");
        for (const [k, v] of Object.entries(extra)) {
          if (v == null) sp.delete(k);
          else sp.set(k, v);
        }
        return sp;
      },
      { replace: true },
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Tile label="Counts due" value={overview ? overview.counts_due : "—"} sub="open or counting, due by today" />
        <Tile
          label="Variances to approve"
          value={overview ? overview.variances : "—"}
          tone={overview && overview.variances > 0 ? "warn" : undefined}
          sub="submitted counts"
        />
        <Tile label="Open putaways" value={overview ? overview.putaways_open : "—"} sub={overview ? `${overview.putaways_over_24h} over 24 h` : undefined} />
        <Tile
          label="Unlocated units"
          value={overview ? overview.unlocated_units.toLocaleString() : "—"}
          tone={overview && overview.unlocated_units !== 0 ? "warn" : undefined}
          sub="net at UNLOCATED"
        />
        <Tile
          label="Off-by SKUs"
          value={last?.mismatched_skus ?? "—"}
          tone={last?.mismatched_skus ? "warn" : last ? "ok" : "muted"}
          sub={last?.run_at ? `reconcile ${ago(last.run_at)}` : "no reconcile yet"}
        />
        <Tile
          label="Physical layer"
          value={layer.live ? "Live" : "Practice"}
          tone={layer.live ? "ok" : "muted"}
          sub={layer.live ? `since ${ago(layer.live_since)}` : "mirror and settlement dormant"}
        />
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as CountsTab)}>
        <TabsList aria-label="Counts" className="h-auto flex-wrap">
          {COUNTS_TABS.map((t) => (
            <TabsTrigger key={t} value={t} className={t === "replenishment" ? "text-muted-foreground/70" : undefined}>
              {TAB_LABELS[t]}
              {t === "variances" && overview && overview.variances > 0 && (
                <span className="ml-1.5 rounded-full bg-amber-500/20 px-1.5 text-[10px] font-semibold tabular-nums text-amber-300">
                  {overview.variances}
                </span>
              )}
              {t === "replenishment" && (
                <Badge variant="outline" className="ml-1.5 px-1.5 py-0 text-[9px] text-muted-foreground">
                  Phase 2
                </Badge>
              )}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="variances" className="mt-4">
          <VariancesTab onOpenTasks={() => setTab("tasks")} />
        </TabsContent>
        <TabsContent value="tasks" className="mt-4">
          <CountTasksTab highlight={params.get("task")} />
        </TabsContent>
        <TabsContent value="schedule" className="mt-4">
          <ScheduleTab />
        </TabsContent>
        <TabsContent value="moves" className="mt-4">
          <MovesTab />
        </TabsContent>
        <TabsContent value="reconcile" className="mt-4">
          <ReconcileTab live={layer.live} onOpenTask={(id) => setTab("tasks", { task: id })} />
        </TabsContent>
        <TabsContent value="replenishment" className="mt-4">
          <Card className="bg-muted/20">
            <CardContent className="space-y-1 p-6">
              <p className="text-sm font-medium text-muted-foreground">Replenishment arrives in Phase 2</p>
              <p className="max-w-2xl text-sm text-muted-foreground">
                Pick faces below their minimum, with a move from reserve to bring a carton down, come with picking. Until
                then, open a carton at its face from Floor › Put away, or move stock with a manual move.
              </p>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
