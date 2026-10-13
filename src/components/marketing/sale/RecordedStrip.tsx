import { F } from "@/lib/marketing/sale-format";
import type { SaleMetrics } from "@/lib/marketing/sale-metrics";
import { Chip, ModuleCard } from "./sale-ui";

/** Recorded: what has been written back and when the sale goes final. */
export function RecordedStrip({ M }: { M: SaleMetrics }) {
  const r = M.recorded;
  return (
    <ModuleCard
      id="recorded"
      title="Recorded"
      strip={[
        <>Final <b>{r.finalizedAt ? F.stampET(r.finalizedAt) : "on " + F.md(r.finalOn)}</b>{M.input.sale.has_gift ? <span className="text-muted-foreground"> · 21 days after close (gift)</span> : <span className="text-muted-foreground"> · 14 days after close</span>}</>,
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
