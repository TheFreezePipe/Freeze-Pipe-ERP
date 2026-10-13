import { F, addDays } from "@/lib/marketing/sale-format";
import { MECH } from "@/lib/marketing/sale-labels";
import type { SaleMetrics } from "@/lib/marketing/sale-metrics";
import { Chip, ModuleCard, Skeleton, Tile } from "./sale-ui";

/** Customers: new vs returning (first order in the ERP's history), early access, orders per day. AOV waits on a revenue source. */
export function CustomersTiles({ M, loading }: { M: SaleMetrics; loading?: boolean }) {
  const c = M.customers;
  const b = M.base;
  const S = M.input.sale;
  return (
    <ModuleCard
      id="customers"
      title={"Customers" + (M.live ? " to date" : "")}
      right={
        <>
          {M.status.mechanism ? <Chip tone="k" label={MECH[M.status.mechanism]} tip="New share 5 pts or more over base = acquired. Upsold needs AOV, which waits on a revenue source." /> : null}
          <Chip tone="k" label="New · since May 2026" tip="Order history starts May 2026, so a buyer whose last order was earlier reads as new." />
        </>
      }
    >
      {loading ? (
        <Skeleton h={108} />
      ) : (
        <div className="grid grid-cols-6 gap-2 p-4">
          <Tile k="New · first order" value={c ? F.int(c.new) + " · " + F.pct0(c.newShare) + "%" : "—"} sub={(b.newShare == null ? "" : "base " + F.pct0(b.newShare) + "%") + (c ? " · +" + F.int(c.incNew) + " incremental" : "")} />
          <Tile k="Returning" value={c ? F.int(c.returning) + " · " + F.pct0(c.retShare) + "%" : "—"} sub={b.newShare == null ? "" : "base " + F.pct0(1 - b.newShare) + "%"} />
          <Tile k="Early access" value={c && c.ea ? F.int(c.ea) + " · " + F.pct0(c.eaShare) + "% of sale" : "—"} sub={c && c.ea ? "new " + F.pct0(c.eaNew) + "%" : S.ea ? "opens " + F.md(S.ea) : "no early access"} />
          <Tile k="AOV $" value="—" sub="revenue source pending" />
          <Tile k="Orders / day" value={c ? F.int(c.ordersDay) : "—"} sub={"clean " + F.int(b.ordersDay)} />
          <Tile k="Repeat 90d" value="—" sub={"fills " + F.md(addDays(S.end, 90))} />
        </div>
      )}
    </ModuleCard>
  );
}
