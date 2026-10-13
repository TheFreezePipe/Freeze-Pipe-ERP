import { Fragment } from "react";
import { Link } from "react-router-dom";
import { F } from "@/lib/marketing/sale-format";
import { COLUMN_DEF, RUNWAY } from "@/lib/marketing/sale-labels";
import { judge, type SaleMetrics, type SaleProduct } from "@/lib/marketing/sale-metrics";
import { cn } from "@/lib/utils";
import { ChipFrom, ExpandCell, ModuleCard, Pair, Pin, PinRow, ShareBar, Skeleton, Th } from "./sale-ui";
import { NONE, TD, TH, colgroup } from "./sale-tokens";

interface Props {
  M: SaleMetrics;
  loading?: boolean;
  open: ReadonlySet<string>;
  onToggle: (id: string) => void;
  sort: readonly [string, "asc" | "desc"];
  onSort: (key: string) => void;
}

type SortKey = "sku" | "units" | "base" | "delta" | "share" | "finished" | "rate" | "runs";

function SortTh({ label, k, right = true, tip, sort, onSort }: { label: string; k: SortKey; right?: boolean; tip?: string; sort: readonly [string, "asc" | "desc"]; onSort: (key: string) => void }) {
  const on = sort[0] === k;
  return (
    <th className={cn(TH, right && "text-right", "cursor-pointer select-none hover:text-foreground")} onClick={() => onSort(k)} aria-sort={on ? (sort[1] === "desc" ? "descending" : "ascending") : "none"} title={tip}>
      {label}
      <svg className={cn("ml-1 inline-block h-2.5 w-2.5", on ? "" : "opacity-40")} viewBox="0 0 10 10">
        <path d={on && sort[1] === "asc" ? "M2 6l3-3 3 3" : "M2 4l3 3 3-3"} fill="none" stroke="currentColor" strokeWidth="1.5" />
      </svg>
    </th>
  );
}

/** Products: promoted and gift SKUs with units vs baseline, share of incremental, stock and runway; the rest of the store as one row. */
export function ProductsTable({ M, loading, open, onToggle, sort, onSort }: Props) {
  const [sk, sd] = sort;
  const key = (p: SaleProduct): string | number =>
    sk === "share" ? p.share
      : sk === "units" ? p.units
        : sk === "base" ? p.base
          : sk === "delta" ? (p.judged.delta ?? -9)
            : sk === "finished" ? p.finished
              : sk === "rate" ? (M.upcoming ? p.planRate : p.rate)
                : sk === "runs" ? (p.daysLeft ?? 1e9)
                  : sk === "sku" ? p.sku
                    : p.share;
  const rows = [...M.products].sort((a, b) => {
    const x = key(a), y = key(b);
    const c = typeof x === "string" ? x.localeCompare(String(y)) : x - (y as number);
    return sd === "desc" ? -c : c;
  });
  const shareDefined = M.products.some((p) => p.share > 0);
  // A sitewide offer makes every SKU a member; show the top rows and fold the rest into "All other".
  const LIMIT = 30;
  const shown = rows.slice(0, LIMIT);
  const folded = rows.slice(LIMIT);
  const other = M.other || folded.length
    ? {
        n: (M.other?.n ?? 0) + folded.length,
        units: (M.other?.units ?? 0) + folded.reduce((t, p) => t + p.units, 0),
        base: (M.other?.base ?? 0) + folded.reduce((t, p) => t + p.base, 0),
        share: (M.other?.share ?? 0) + folded.reduce((t, p) => t + p.share, 0),
      }
    : null;

  return (
    <ModuleCard id="products" title={"Products" + (M.live ? " to date" : "")} right={<span>{M.products.length} promoted · {M.other?.n ?? 0} other{M.products.length > LIMIT ? " · top " + LIMIT + " shown" : ""}</span>}>
      {loading ? (
        <Skeleton h={330} rows={10} />
      ) : (
        <table className="w-full table-fixed text-[13px]">
          {colgroup([24, "auto", 80, 64, 64, 130, 100, 100, 90, 90, 100])}
          <thead>
            <tr>
              <th />
              <SortTh label="SKU" k="sku" right={false} sort={sort} onSort={onSort} />
              <Th>Role</Th>
              <SortTh label="Units" k="units" tip={COLUMN_DEF.Units} sort={sort} onSort={onSort} />
              <SortTh label="Baseline" k="base" sort={sort} onSort={onSort} />
              <SortTh label="Δ Base" k="delta" tip={COLUMN_DEF["Δ Base"]} sort={sort} onSort={onSort} />
              <SortTh label="Share" k="share" tip={COLUMN_DEF.Share} sort={sort} onSort={onSort} />
              <SortTh label="Finished · Raw" k="finished" tip="Finished on hand · raw on hand" sort={sort} onSort={onSort} />
              <SortTh label="Rate/d" k="rate" tip={COLUMN_DEF["Rate/d"]} sort={sort} onSort={onSort} />
              <SortTh label="Runs out" k="runs" tip={COLUMN_DEF["Runs out"]} sort={sort} onSort={onSort} />
              <Th>Status</Th>
            </tr>
          </thead>
          <tbody>
            {shown.map((p) => {
              const id = "sku:" + p.skuId;
              const isOpen = open.has(id);
              return (
                <Fragment key={p.skuId}>
                  <tr className="border-t border-border/40">
                    <ExpandCell open={isOpen} onToggle={() => onToggle(id)} has={p.daily.length > 0} label={"Days for " + p.sku} />
                    <td className={TD + " truncate"}>
                      <Link to={"/economics/skus/" + p.skuId} className="font-mono text-xs hover:underline">{p.sku}</Link>
                      <span className="ml-2 truncate text-[11.5px] text-muted-foreground">{p.name}</span>
                    </td>
                    <td className={TD + " text-xs text-muted-foreground"}>{p.role}</td>
                    <td className={TD + " text-right tabular-nums"}>{M.upcoming ? NONE : F.int(p.units)}</td>
                    <td className={TD + " text-right tabular-nums text-muted-foreground"}>{M.upcoming ? NONE : F.int(p.base)}</td>
                    <td className={TD + " text-right"}>{M.upcoming ? NONE : <PinRow j={p.judged} />}</td>
                    <td className={TD + " text-right"}>{M.upcoming || !shareDefined ? NONE : <ShareBar share={p.share} tip={p.sku + " · " + F.pct0(p.share) + "% of gross incremental · +" + F.int(Math.max(0, p.units - p.base)) + " units"} />}</td>
                    <td className={TD + " text-right"}><Pair a={p.finished} b={p.raw} /></td>
                    <td className={TD + " text-right"}><Pair a={M.upcoming ? p.planRate : p.rate} b={p.baseRate} fmt={F.rate} /></td>
                    <td className={TD + " text-right tabular-nums"}>{M.live || M.upcoming ? (p.runsOut == null ? NONE : p.runsOut.startsWith("after") ? <span className="text-muted-foreground">{p.runsOut}</span> : p.runsOut) : NONE}</td>
                    <td className={TD}><ChipFrom def={RUNWAY[p.runway]} /></td>
                  </tr>
                  {isOpen
                    ? p.daily.map(([k, u]) => {
                        const d = M.days.find((x) => x.k === k);
                        const b = p.baseRate * (d && M.base.unitsDay > 0 ? d.base.unitsFull / M.base.unitsDay : 1);
                        return (
                          <tr key={k} className="border-t border-border/30 bg-background/30 text-xs">
                            <td />
                            <td className={TD + " text-muted-foreground"}>{F.dayDow(k)}</td>
                            <td />
                            <td className={TD + " text-right tabular-nums"}>{F.int(u)}</td>
                            <td className={TD + " text-right tabular-nums text-muted-foreground"}>{F.rate(b)}</td>
                            <td className={TD + " text-right"}><Pin j={judge(u, b)} allowSmall /></td>
                            <td colSpan={5} />
                          </tr>
                        );
                      })
                    : null}
                </Fragment>
              );
            })}
            {other ? (
              <tr className="border-t border-border/40 bg-background/40 font-semibold">
                <td />
                <td className={TD} colSpan={2}>All other ({other.n}){folded.length ? <span className="ml-1 text-xs font-normal text-muted-foreground">incl. {folded.length} promoted beyond the top {LIMIT}</span> : null}</td>
                <td className={TD + " text-right tabular-nums"}>{M.upcoming ? NONE : F.int(other.units)}</td>
                <td className={TD + " text-right tabular-nums text-muted-foreground"}>{M.upcoming ? NONE : F.int(other.base)}</td>
                <td className={TD + " text-right"}>{M.upcoming ? NONE : <PinRow j={judge(other.units, other.base)} />}</td>
                <td className={TD + " text-right"}><ShareBar share={shareDefined && !M.upcoming ? other.share : null} /></td>
                <td colSpan={4} />
              </tr>
            ) : null}
          </tbody>
        </table>
      )}
    </ModuleCard>
  );
}
