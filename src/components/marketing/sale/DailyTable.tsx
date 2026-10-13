import { Fragment } from "react";
import { F } from "@/lib/marketing/sale-format";
import { COLUMN_DEF, type CompareKey } from "@/lib/marketing/sale-labels";
import { bandWord, judge, type SaleDay, type SaleGroup, type SaleMetrics } from "@/lib/marketing/sale-metrics";
import { cn } from "@/lib/utils";
import { ExpandCell, ModuleCard, Pair, Pin, Skeleton, Th } from "./sale-ui";
import { NONE, TD, colgroup } from "./sale-tokens";
import { judgeDay, rangeDays, rangeLabel, refOf, type RangeState } from "./sale-view";

interface Props {
  M: SaleMetrics;
  loading?: boolean;
  range: RangeState;
  compare: CompareKey;
  open: ReadonlySet<string>;
  onToggle: (id: string) => void;
  hoverDay: string | null;
  onHover: (k: string | null) => void;
}

/** Daily: one row per day, two-token cells (actual · reference), phase totals, Pre/After groups collapsed. Day rows do not expand. */
export function DailyTable({ M, loading, range, compare, open, onToggle, hoverDay, onHover }: Props) {
  const days = rangeDays(M, range);
  const showPre = days.some((d) => d.phase === "pre");
  const showPost = days.some((d) => d.phase === "post");
  const deltaHead = compare === "plan" ? "Δ Plan" : "Δ Base";

  const dayRow = (d: SaleDay, label: string) => {
    if (d.future)
      return (
        <tr key={d.k} className="border-t border-border/40 text-muted-foreground/70">
          <td className={TD + " w-6 px-1.5"} />
          <td className={TD}>{label}</td>
          <td className={TD}>{F.dayDow(d.k)}</td>
          {Array.from({ length: 6 }, (_, i) => <td key={i} className={TD + " text-right"}>{NONE}</td>)}
          <td className={TD + " text-xs"}>{d.sends.map((b) => b.campaign).join(" · ")}</td>
        </tr>
      );
    return (
      <tr
        key={d.k}
        data-day={d.k}
        onMouseEnter={() => onHover(d.k)}
        onMouseLeave={() => onHover(null)}
        className={cn("border-t border-border/40", hoverDay === d.k && "bg-muted/40", d.partial && "bg-[repeating-linear-gradient(45deg,transparent,transparent_5px,rgba(255,255,255,.04)_5px,rgba(255,255,255,.04)_6px)]")}
      >
        <td className={TD + " w-6 px-1.5"} />
        <td className={TD + (d.phase === "ea" ? " text-violet-400" : "")}>{label}</td>
        <td className={TD}>
          {F.dayDow(d.k)}
          {d.partial ? <span className="ml-1.5 text-[11.5px] text-muted-foreground">to {M.asOfTime}</span> : null}
        </td>
        <td className={TD + " text-right"}><Pair a={d.orders} b={refOf(d, "orders", compare)} /></td>
        <td className={TD + " text-right"}>{compare === "none" ? NONE : <Pin j={judgeDay(d.orders, d, "orders", compare, M.h)} />}</td>
        <td className={TD + " text-right"}><Pair a={d.units} b={d.units == null ? null : refOf(d, "units", compare)} /></td>
        <td className={TD + " text-right"}>{d.units == null || compare === "none" ? NONE : <Pin j={judgeDay(d.units, d, "units", compare, M.h)} />}</td>
        <td className={TD + " text-right"}>{d.orders ? F.pct0((d.new ?? 0) / d.orders) : NONE}</td>
        <td className={TD + " text-right"}>{d.awaiting ? <span className="text-xs text-muted-foreground">{F.int(d.awaiting)} awaiting</span> : NONE}</td>
        <td className={TD + " text-xs"}>
          {d.sends.map((b, i) => (
            <a key={b.id} href="#m-sends" className="text-muted-foreground hover:text-foreground">{i ? " · " : ""}<span className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-foreground" />{b.campaign}</a>
          ))}
        </td>
      </tr>
    );
  };

  const totals = (label: string, G: SaleGroup, word: string, id?: string) => {
    const A = G.A, Bt = G.B, P = G.P;
    const ref = (k: "orders" | "units") => (compare === "plan" ? (M.live ? G.PtD[k] : P[k]) : compare === "baseline" ? Bt[k] : null);
    const jo = compare === "plan" ? judge(A.orders, M.live ? G.PtD.orders : P.orders, { mode: "band" }) : judge(A.orders, Bt.orders);
    const ju = compare === "plan" ? judge(A.units, M.live ? G.PtD.units : P.units, { mode: "band" }) : judge(A.units, Bt.units);
    const has = G.done > 0;
    const isOpen = !!id && open.has(id);
    return (
      <tr key={label} className="border-t border-border/40 bg-background/40 font-semibold">
        {id ? <ExpandCell open={isOpen} onToggle={() => onToggle(id)} label={label} /> : <td className={TD + " w-6 px-1.5"} />}
        <td className={TD} colSpan={2}>{label}</td>
        <td className={TD + " text-right"}>{has ? <Pair a={A.orders} b={ref("orders")} /> : NONE}</td>
        <td className={TD + " text-right"}>{has && compare !== "none" ? <Pin j={jo} /> : NONE}</td>
        <td className={TD + " text-right"}>{has && A.units ? <Pair a={A.units} b={ref("units")} /> : NONE}</td>
        <td className={TD + " text-right"}>{has && A.units && compare !== "none" ? <Pin j={ju} /> : NONE}</td>
        <td className={TD + " text-right"}>{has && A.orders ? F.pct0(A.new / A.orders) : NONE}</td>
        <td className={TD} />
        <td className={TD + " text-xs font-normal text-muted-foreground"}>{word}</td>
      </tr>
    );
  };

  const rows: React.ReactNode[] = [];
  if (showPre) {
    rows.push(totals("Pre · 7 days", M.G.pre, F.range(M.G.pre.rows[0].k, M.G.pre.rows[6].k), "pre"));
    if (open.has("pre")) M.G.pre.rows.forEach((d, i) => rows.push(dayRow(d, "Pre " + (i + 1))));
  }
  const eaRows = days.filter((d) => d.phase === "ea");
  if (eaRows.length) {
    eaRows.forEach((d) => rows.push(dayRow(d, "EA " + (M.G.ea.rows.indexOf(d) + 1))));
    rows.push(totals("Early access", M.G.ea, M.G.ea.done ? bandWord(M.G.ea.lift.orders.z) : ""));
  }
  const mainRows = days.filter((d) => d.phase === "main");
  if (mainRows.length) {
    mainRows.forEach((d) => rows.push(dayRow(d, "Day " + (M.G.main.rows.indexOf(d) + 1))));
    rows.push(totals("Public" + (M.live ? " to date" : ""), M.G.main, M.G.main.done ? (M.status.pace === "reading" ? "Reading" : bandWord(M.G.main.lift.orders.z)) : ""));
  }
  if (showPost) {
    rows.push(totals("After · 14 days", M.G.post, M.G.post.done === 14 ? "" : F.range(M.G.post.rows[0].k, M.G.post.rows[13].k), "after"));
    if (open.has("after")) M.G.post.rows.forEach((d, i) => rows.push(dayRow(d, "After " + (i + 1))));
  }

  return (
    <ModuleCard id="dailytable" title="Daily" right={<span>{rangeLabel(range)}</span>}>
      {loading ? (
        <Skeleton h={290} rows={9} />
      ) : (
        <table className="w-full table-fixed text-[13px]">
          {colgroup([24, 64, 150, 110, 70, 110, 70, 64, 90, "auto"])}
          <thead>
            <tr>
              <th />
              <Th>Day</Th>
              <Th>Date (ET)</Th>
              <Th right tip={COLUMN_DEF.Orders}>Orders</Th>
              <Th right tip={COLUMN_DEF[deltaHead]}>{deltaHead}</Th>
              <Th right tip={COLUMN_DEF.Units}>Units</Th>
              <Th right tip={COLUMN_DEF[deltaHead]}>{deltaHead}</Th>
              <Th right tip={COLUMN_DEF["New %"]}>New %</Th>
              <Th right tip="Orders placed but not yet shipped; they count already.">Queue</Th>
              <Th>Sends</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => <Fragment key={i}>{r}</Fragment>)}
          </tbody>
        </table>
      )}
    </ModuleCard>
  );
}
