import { TooltipProvider } from "@/components/ui/tooltip";
import { useSaleMetrics } from "@/lib/hooks/use-sale-metrics";
import { F, addDays, dayT } from "@/lib/marketing/sale-format";
import { PACE, RESULT } from "@/lib/marketing/sale-labels";
import { dayKeyOf } from "@/lib/marketing-format";
import { Chip, ChipFrom, Pin } from "./sale-ui";

interface Props {
  sale: { id: string; starts_at: string | null; ends_at: string | null; early_access_starts_at: string | null };
  todayKey: string;
}

/**
 * Sales list Result column. Only sales whose window is near (from 60 days
 * before early access to 21 days after close) load their metrics; the rest
 * show nothing, so the list never fires a dozen calculations at once.
 */
export function SaleResultCell({ sale, todayKey }: Props) {
  const d1 = dayKeyOf(sale.early_access_starts_at ?? sale.starts_at);
  const d2 = dayKeyOf(sale.ends_at);
  const near = !!d1 && !!d2 && dayT(todayKey) >= dayT(addDays(d1, -60)) && dayT(todayKey) <= dayT(addDays(d2, 21));
  return near ? <Inner saleId={sale.id} /> : <span className="text-xs text-muted-foreground/60">—</span>;
}

function Inner({ saleId }: { saleId: string }) {
  const { metrics: M, isLoading } = useSaleMetrics(saleId);
  if (isLoading) return <span className="text-xs text-muted-foreground">…</span>;
  if (!M) return <span className="text-xs text-muted-foreground/60">—</span>;
  return (
    <TooltipProvider>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {M.upcoming ? (
          <>
            <span className="font-semibold tabular-nums">{F.int(M.planOrders)} orders</span>
            <Chip tone="k" label={M.planSource === "planner" ? "Planner" : "Derived"} />
            <span className="text-muted-foreground">Offers {M.offers.length}{M.alerts.length ? " · " + M.alerts.length + " to fix" : ""}</span>
          </>
        ) : M.live ? (
          <>
            <ChipFrom def={PACE[M.status.pace ?? "reading"]} />
            <span className="relative inline-block h-[7px] w-[120px] rounded-sm bg-muted">
              <i className="absolute left-0 top-0 h-full rounded-sm bg-foreground/80" style={{ width: Math.min(100, (M.G.full.A.orders / (M.planOrders * 1.25)) * 100).toFixed(1) + "%" }} />
              <b className="absolute top-[-3px] h-[13px] w-[2px] bg-foreground" style={{ left: (100 / 1.25).toFixed(1) + "%" }} />
            </span>
            <span className="tabular-nums text-muted-foreground">{F.int(M.G.full.A.orders)} of {F.int(M.planOrders)}</span>
          </>
        ) : (
          <>
            <span>ΔPlan <Pin j={M.scorecard.orders.planD} /></span>
            <span>Units <Pin j={M.G.full.lift.units} /></span>
            {M.status.result ? <ChipFrom def={RESULT[M.status.result]} /> : null}
          </>
        )}
      </div>
    </TooltipProvider>
  );
}
