import { useMemo } from "react";
import { useInventory } from "@/lib/hooks";

export function ManufacturingCompletionChart() {
  const { data: inventory = [] } = useInventory();

  const { unfilled, complete, pct } = useMemo(() => {
    let totalUnfilled = 0;
    let totalComplete = 0;

    inventory.forEach(inv => {
      if (inv.product?.category !== "fillable") return;
      // Pre-filled raw counts as "complete" — units arrived already filled
      // and just need a fast RTS step (no manufacturing work). Lumping it
      // with unfilled would inflate the work-remaining metric incorrectly.
      totalUnfilled += (inv.warehouse_raw ?? 0) + (inv.warehouse_in_production ?? 0);
      totalComplete += (inv.warehouse_finished ?? 0) + (inv.warehouse_prefilled_raw ?? 0);
    });

    const total = totalUnfilled + totalComplete;
    const pct = total > 0 ? (totalComplete / total) * 100 : 0;

    return { unfilled: totalUnfilled, complete: totalComplete, pct };
  }, [inventory]);

  const total = unfilled + complete;
  const unfilledPct = total > 0 ? (unfilled / total) * 100 : 0;
  const completePct = total > 0 ? (complete / total) * 100 : 0;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-end gap-4 text-xs">
        <div className="flex items-center gap-1.5">
          <div className="h-3 w-3 rounded-sm" style={{ backgroundColor: "hsl(0, 65%, 70%)" }} />
          <span className="text-muted-foreground">Unfilled</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="h-3 w-3 rounded-sm" style={{ backgroundColor: "hsl(120, 45%, 50%)" }} />
          <span className="text-muted-foreground">Complete</span>
        </div>
      </div>

      <div className="flex h-10 w-full overflow-hidden rounded-lg">
        {unfilledPct > 0 && (
          <div
            className="flex items-center justify-center text-xs font-bold text-white"
            style={{
              width: `${unfilledPct}%`,
              backgroundColor: "hsl(0, 65%, 70%)",
              minWidth: unfilledPct > 5 ? undefined : "40px",
            }}
          >
            {unfilled.toLocaleString()}
          </div>
        )}
        {completePct > 0 && (
          <div
            className="flex items-center justify-center text-xs font-bold text-white"
            style={{
              width: `${completePct}%`,
              backgroundColor: "hsl(120, 45%, 50%)",
              minWidth: completePct > 5 ? undefined : "40px",
            }}
          >
            {complete.toLocaleString()}
          </div>
        )}
      </div>

      <div className="flex justify-between text-[10px] text-muted-foreground px-0.5">
        <span>0%</span>
        <span>25%</span>
        <span>50%</span>
        <span>75%</span>
        <span>100%</span>
      </div>

      <p className="text-center text-sm text-muted-foreground">
        <span className="font-bold text-foreground">{Math.round(pct)}%</span> complete
        <span className="mx-1">&middot;</span>
        {complete.toLocaleString()} of {total.toLocaleString()} units
      </p>
    </div>
  );
}
