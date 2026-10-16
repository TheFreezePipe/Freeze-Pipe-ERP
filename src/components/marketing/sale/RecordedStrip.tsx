import { Button } from "@/components/ui/button";
import { useFinalizeSale } from "@/lib/hooks/use-sale-metrics";
import { F } from "@/lib/marketing/sale-format";
import type { SaleMetrics } from "@/lib/marketing/sale-metrics";
import { toast } from "@/hooks/use-toast";
import { describeError } from "@/lib/supabase-error";
import { Chip, ModuleCard } from "./sale-ui";

/**
 * Recorded: what has been written back and when the sale goes final. The
 * nightly job finalizes a sale 14 days after close (21 with a gift); an
 * admin can run it early or again from here.
 */
export function RecordedStrip({ M, canEdit }: { M: SaleMetrics; canEdit: boolean }) {
  const r = M.recorded;
  const finalize = useFinalizeSale();
  const run = () =>
    finalize.mutate(M.input.sale.id, {
      onSuccess: (d) => toast({ title: d.ok ? "Sale finalized" : "Not finalized", description: d.ok ? "Measured rows written to the ledger." : d.reason }),
      onError: (e) => toast({ title: "Couldn't finalize", description: describeError(e), variant: "destructive" }),
    });
  const control =
    canEdit && !M.upcoming && !M.live ? (
      <Button size="sm" variant="outline" className="h-6 text-[11px]" disabled={finalize.isPending} onClick={run}>
        {r.finalizedAt ? "Re-measure" : r.due ? "Finalize now" : "Finalize early"}
      </Button>
    ) : null;
  return (
    <ModuleCard
      id="recorded"
      title="Recorded"
      right={control}
      strip={[
        <>Final <b>{r.finalizedAt ? F.stampET(r.finalizedAt) : "on " + F.md(r.finalOn)}</b>{M.input.sale.has_gift ? <span className="text-muted-foreground"> · 21 days after close (gift)</span> : <span className="text-muted-foreground"> · 14 days after close</span>}</>,
        M.overlap ? <Chip tone="k" label={"Overlap · " + M.overlap} tip="Another sale or launch inside the after-window; the after-dip is not readable." /> : null,
        <>Priors <b>{r.priors}</b> earlier runs in the ledger</>,
        <>Plan accuracy: lift planned <b>{r.planLift == null ? "—" : F.signed(r.planLift)}</b> · public units <b>{r.publicLift == null ? "—" : F.signed(r.publicLift)}</b></>,
        M.lastRun ? <>Last run <b>{M.lastRun.name}</b>{M.lastRun.comparable ? (M.lastRun.liftUnits == null ? "" : " · " + F.signed(M.lastRun.liftUnits) + " units") : " · not comparable"}</> : null,
        M.input.baseline.frozen ? null : <Chip tone="k" label="Baseline recomputes until the sale opens" />,
      ]}
    >
      <span />
    </ModuleCard>
  );
}
