import { Link } from "react-router-dom";
import { F } from "@/lib/marketing/sale-format";
import { COLUMN_DEF, SEND_STATUS } from "@/lib/marketing/sale-labels";
import type { SaleMetrics } from "@/lib/marketing/sale-metrics";
import { Chip, ChipFrom, ModuleCard, Skeleton, Th } from "./sale-ui";
import { NONE, TD, colgroup } from "./sale-tokens";

/** Sends: the sale's broadcasts as entered, attributed results beside the sale and never added into it. */
export function SendsTable({ M, loading, highlight }: { M: SaleMetrics; loading?: boolean; highlight: string | null }) {
  return (
    <ModuleCard
      id="sends"
      title="Sends"
      right={M.sendsEnteredAt ? <span>Entered {F.stampET(M.sendsEnteredAt)}</span> : <Chip tone="k" mark="ring" label="Nothing entered" />}
    >
      {loading ? (
        <Skeleton h={160} rows={4} />
      ) : (
        <table className="w-full table-fixed text-[13px]">
          {colgroup([130, "auto", 90, 70, 70, 70, 90, 70, 130])}
          <thead>
            <tr>
              <Th>Sent (ET)</Th>
              <Th>Campaign</Th>
              <Th right tip={COLUMN_DEF.Recipients}>Recipients</Th>
              <Th right>Open %</Th>
              <Th right>Click %</Th>
              <Th right>Orders</Th>
              <Th right>Revenue $</Th>
              <Th right tip={COLUMN_DEF["RPR $"]}>RPR $</Th>
              <Th>Window</Th>
            </tr>
          </thead>
          <tbody>
            {M.sends.length === 0 ? (
              <tr className="border-t border-border/40"><td className={TD + " text-xs text-muted-foreground"} colSpan={9}>No sends linked to this sale. <Link to="/marketing/broadcasts" className="underline">Enter sends</Link> and link them to the sale.</td></tr>
            ) : null}
            {M.sends.map((b) => (
              <tr key={b.id} id={"send-" + b.id} className={"border-t border-border/40 " + (b.status === "scheduled" ? "text-muted-foreground/70" : "") + (highlight === b.id ? " bg-muted/40" : "")}>
                <td className={TD + " tabular-nums"}>{b.dayKey ? F.md(b.dayKey) + " " + b.time : NONE}</td>
                <td className={TD + " truncate"}>{b.campaign}{b.channel !== "email" ? <span className="ml-1.5 text-[11px] uppercase text-muted-foreground">{b.channel}</span> : null}</td>
                <td className={TD + " text-right tabular-nums"}>{b.recipients == null ? NONE : F.int(b.recipients)}</td>
                <td className={TD + " text-right tabular-nums"}>{b.open == null ? NONE : F.pct0(b.open)}</td>
                <td className={TD + " text-right tabular-nums"}>{b.click == null ? NONE : F.pct1(b.click)}</td>
                <td className={TD + " text-right tabular-nums"}>{b.orders == null ? NONE : F.int(b.orders)}</td>
                <td className={TD + " text-right tabular-nums"}>{b.revenue == null ? NONE : F.cell(b.revenue)}</td>
                <td className={TD + " text-right tabular-nums"}>{b.rpr == null ? NONE : F.dec2(b.rpr)}</td>
                <td className={TD}><ChipFrom def={SEND_STATUS[b.status]} suffix={b.status === "closes" && b.closes ? "" : ""} /></td>
              </tr>
            ))}
            {M.sends.length ? (
              <tr className="border-t border-border/40 bg-background/40 font-semibold">
                <td className={TD} colSpan={5}>Entered · Placed Order · 5-day</td>
                <td className={TD + " text-right tabular-nums"}>{M.attributed.orders ? F.int(M.attributed.orders) : NONE}</td>
                <td className={TD + " text-right tabular-nums"}>{M.attributed.revenue ? F.cell(M.attributed.revenue) : NONE}</td>
                <td className={TD + " text-right text-xs font-normal text-muted-foreground"}>beside, not added</td>
                <td />
              </tr>
            ) : null}
          </tbody>
        </table>
      )}
    </ModuleCard>
  );
}
