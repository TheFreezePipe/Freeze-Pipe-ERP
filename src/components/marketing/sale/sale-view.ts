/** View state shared by the sale modules; the URL carries range, compare and view. */
import { judge, type Judged, type SaleDay, type SaleMetrics } from "@/lib/marketing/sale-metrics";
import { F } from "@/lib/marketing/sale-format";
import { RANGE, type CompareKey, type RangeKey, type ViewKey } from "@/lib/marketing/sale-labels";

export type RangeState = RangeKey | { since: string; until: string };

export interface SaleViewState {
  range: RangeState;
  compare: CompareKey;
  view: ViewKey;
  open: ReadonlySet<string>;
  sort: readonly [key: string, dir: "asc" | "desc"];
}

export const RANGE_PRESETS: RangeKey[] = ["ea", "main", "sale", "sale_after", "full"];

export function rangeDays(M: SaleMetrics, range: RangeState): SaleDay[] {
  const r = range;
  const inRange = (d: SaleDay) =>
    r === "full"
      ? true
      : r === "ea"
        ? d.phase === "ea"
        : r === "main"
          ? d.phase === "main"
          : r === "sale"
            ? d.phase === "ea" || d.phase === "main"
            : r === "sale_after"
              ? d.phase !== "pre"
              : d.k >= r.since && d.k <= r.until;
  return M.days.filter(inRange);
}

export const rangeLabel = (range: RangeState): string => (typeof range === "string" ? RANGE[range] : F.range(range.since, range.until));

export type DayKey = "orders" | "units";

export function refOf(d: SaleDay, key: DayKey, compare: CompareKey): number | null {
  return compare === "plan" ? d.plan[key] : compare === "baseline" ? d.base[key] : null;
}

export function judgeDay(a: number | null, d: SaleDay, key: DayKey, compare: CompareKey, h: number): Judged | null {
  if (a == null) return null;
  if (compare === "plan") return judge(a, d.plan[key] * (d.partial ? h : 1), { mode: "band" });
  if (compare === "baseline") return judge(a, d.base[key]);
  return null;
}

export function toggleIn(set: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(set);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}
