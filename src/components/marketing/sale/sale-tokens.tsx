/** Sale dashboards — non-component tokens shared by the modules (kept apart from sale-ui.tsx for fast refresh). */
import { NONE_TEXT } from "@/lib/marketing/sale-format";

export const NONE = <span className="text-muted-foreground/60">{NONE_TEXT}</span>;
export const TH = "h-8 whitespace-nowrap px-3 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground";
export const TD = "h-8 whitespace-nowrap px-3 align-middle";
export const R = "text-right tabular-nums";
export const HATCH_ID = "sale-hatch";

export function colgroup(ws: ReadonlyArray<number | "auto">) {
  return (
    <colgroup>
      {ws.map((w, i) => (w === "auto" ? <col key={i} /> : <col key={i} style={{ width: w }} />))}
    </colgroup>
  );
}
