import { useState } from "react";
import { F, addDays, dow } from "@/lib/marketing/sale-format";
import { COMPARE, VIEW, type CompareKey, type ViewKey } from "@/lib/marketing/sale-labels";
import { judge, type SaleMetrics } from "@/lib/marketing/sale-metrics";
import { bandWord } from "@/lib/marketing/sale-metrics";
import { HatchDefs, ModuleCard, Skeleton, Tile } from "./sale-ui";
import { rangeDays, type RangeState } from "./sale-view";

interface Props {
  M: SaleMetrics;
  loading?: boolean;
  range: RangeState;
  compare: CompareKey;
  view: ViewKey;
  onView: (v: ViewKey) => void;
  hoverDay: string | null;
  onHover: (k: string | null) => void;
  onSendClick: (sendId: string) => void;
}

const W = 634, H = 200, PL = 36, PR = 8;

/**
 * Daily chart: actual columns (solid; hatched for the partial day), plan
 * outlines, dotted baseline step, a variance panel, phase brackets and send
 * dots. Fills follow IBCS: actual solid, plan outlined, forecast hatched.
 */
export function DailyChart({ M, loading, range, compare, view, onView, hoverDay, onHover, onSendClick }: Props) {
  const S = M.input.sale;
  const days = rangeDays(M, range);
  const n = Math.max(1, days.length);
  const slot = (W - PL - PR) / n;
  const small = slot < 16;
  const cum = view === "cum";
  const key: "orders" | "units" = view === "orders" ? "orders" : "units";
  const paidView = view === "paid";

  type Pt = { d: (typeof days)[number]; a: number | null; b: number; p: number };
  let series: Pt[] = days.map((d) => ({ d, a: paidView || cum ? null : d[key], b: key === "units" ? d.base.unitsFull : d.base.orders, p: d.plan[key] }));
  if (cum) {
    let ca = 0, cb = 0, cp = 0;
    series = days.map((d) => {
      cb += d.base.orders; cp += d.plan.orders;
      if (!d.future && d.orders != null) ca += d.orders;
      return { d, a: d.future ? null : ca, b: cb, p: cp };
    });
  }
  const top = Math.max(1, ...series.map((s) => Math.max(s.a || 0, s.b, s.p))) * 1.1;
  const Y = (v: number) => 8 + (1 - v / top) * 112;
  const X = (i: number) => PL + i * slot;
  const step = top > 2000 ? 1000 : top > 800 ? 500 : top > 300 ? 200 : top > 150 ? 100 : 50;
  const grid: React.ReactNode[] = [];
  for (let v = step; v < top; v += step) {
    grid.push(<line key={"g" + v} x1={PL} x2={W - PR} y1={Y(v)} y2={Y(v)} stroke="#262626" />);
    grid.push(<text key={"t" + v} x={PL - 4} y={Y(v) - 3} fill="#9a9a9a" fontSize="10" textAnchor="end">{v >= 1000 ? v / 1000 + "k" : v}</text>);
  }
  const cw = Math.max(2, (slot * 2) / 3);
  const cx = (i: number) => X(i) + (slot - cw) / 2;
  const hid = "hatchD" + S.id.slice(0, 8);

  const bars: React.ReactNode[] = [];
  if (!cum && !paidView) {
    series.forEach((s, i) => {
      const d = s.d;
      const dim = hoverDay != null && hoverDay !== d.k ? 0.6 : 1;
      if (compare === "plan" && d.phase !== "pre" && d.phase !== "post" && !d.future)
        bars.push(<rect key={"p" + i} x={cx(i)} y={Y(s.p)} width={cw} height={Y(0) - Y(s.p)} fill="none" stroke="#9a9a9a" strokeDasharray="2 2" />);
      if (s.a != null && !d.partial) bars.push(<rect key={"a" + i} x={cx(i)} y={Y(s.a)} width={cw} height={Y(0) - Y(s.a)} fill="#d4d4d4" fillOpacity={dim} />);
      else if (d.partial && d[key] != null) {
        const v = d[key] as number;
        bars.push(<rect key={"a" + i} x={cx(i)} y={Y(v)} width={cw} height={Y(0) - Y(v)} fill={`url(#${hid})`} fillOpacity={dim} />);
        bars.push(<line key={"h" + i} x1={X(i) + slot * M.h} x2={X(i) + slot * M.h} y1={Y(0) - 112} y2={Y(0)} stroke="#9a9a9a" />);
      } else if (d.future && (d.phase === "ea" || d.phase === "main"))
        bars.push(small
          ? <line key={"f" + i} x1={cx(i)} x2={cx(i) + cw} y1={Y(s.p)} y2={Y(s.p)} stroke="#9a9a9a" />
          : <rect key={"f" + i} x={cx(i)} y={Y(s.p)} width={cw} height={Y(0) - Y(s.p)} fill="none" stroke="#9a9a9a" strokeDasharray="2 2" />);
    });
    if (compare === "baseline")
      bars.push(<path key="base" d={series.map((s, i) => (i ? "L" : "M") + X(i) + " " + Y(s.b) + "L" + (X(i) + slot) + " " + Y(s.b)).join("")} fill="none" stroke="#9a9a9a" strokeWidth="1.5" strokeDasharray="1.5 3" />);
  }
  if (cum) {
    const pts = series.filter((s) => s.a != null);
    bars.push(<path key="plan" d={series.map((s, i) => (i ? "L" : "M") + (X(i) + slot / 2) + " " + Y(s.p)).join("")} fill="none" stroke="#9a9a9a" strokeDasharray="3 2" />);
    if (compare === "baseline") bars.push(<path key="base" d={series.map((s, i) => (i ? "L" : "M") + (X(i) + slot / 2) + " " + Y(s.b)).join("")} fill="none" stroke="#9a9a9a" strokeDasharray="1.5 3" />);
    if (pts.length) bars.push(<path key="act" d={pts.map((s, i) => (i ? "L" : "M") + (X(series.indexOf(s)) + slot / 2) + " " + Y(s.a as number)).join("")} fill="none" stroke="#d4d4d4" strokeWidth="1.8" />);
    if (M.projected != null && M.status.pace !== "reading" && pts.length) {
      const last = pts[pts.length - 1];
      const endI = series.findIndex((s) => s.d.k === S.end);
      if (endI >= 0) bars.push(<path key="proj" d={"M" + (X(series.indexOf(last)) + slot / 2) + " " + Y(last.a as number) + "L" + (X(endI) + slot / 2) + " " + Y(M.projected)} fill="none" stroke="#d4d4d4" strokeWidth="1.5" strokeDasharray="2 3" />);
    }
  }

  // Variance panel.
  const vp: React.ReactNode[] = [<line key="vz" x1={PL} x2={W - PR} y1="136" y2="136" stroke="#3d3d3d" />];
  if (compare !== "none" && !paidView && !cum)
    series.forEach((s, i) => {
      if (s.a == null) return;
      const ref = compare === "plan" ? s.p * (s.d.partial ? M.h : 1) : s.d.partial ? s.b * M.h : s.b;
      if (!ref) return;
      const dl = Math.max(-1, Math.min(1, s.a / ref - 1));
      const j = compare === "plan" ? judge(s.a, ref, { mode: "band" }) : judge(s.a, ref);
      const col = j.tone === "g" ? "#4ade80" : j.tone === "r" ? "#f87171" : "#6b6b6b";
      vp.push(<rect key={"v" + i} x={cx(i)} y={dl >= 0 ? 136 - dl * 14 : 136} width={cw} height={Math.max(1, Math.abs(dl) * 14)} fill={col} />);
    });

  // Axis labels, phase brackets, send dots.
  const xl: React.ReactNode[] = [];
  days.forEach((d, i) => {
    const mark = dow(d.k) === 1 || i === 0 || d.k === S.d1 || d.k === S.start || d.k === S.end || i === n - 1;
    if (mark && (!small || dow(d.k) === 1 || i === 0)) xl.push(<text key={d.k} x={X(i) + slot / 2} y="166" fill="#9a9a9a" fontSize="10" textAnchor="middle">{F.md(d.k)}</text>);
  });
  const phases: Array<[string, string, string]> = [["pre", "Pre 7", "#9a9a9a"], ["ea", "EA", "#a78bfa"], ["main", "Public", "#4ade80"], ["post", "After 14", "#fbbf24"]];
  const br: React.ReactNode[] = [];
  phases.forEach(([ph, lab, col]) => {
    const idx = days.map((d, i) => (d.phase === ph ? i : -1)).filter((i) => i >= 0);
    if (!idx.length) return;
    const x0 = X(idx[0]) + 2, x1 = X(idx[idx.length - 1] + 1) - 2;
    br.push(<path key={"b" + ph} d={`M${x0} 175v5h${x1 - x0}v-5`} fill="none" stroke={col} strokeOpacity=".8" />);
    br.push(<text key={"bt" + ph} x={(x0 + x1) / 2} y="188" fill={col} fontSize="9.5" textAnchor="middle" fillOpacity=".9">{lab}</text>);
  });
  const dots: React.ReactNode[] = [];
  days.forEach((d, i) => {
    if (d.sends.length)
      dots.push(
        <circle key={"s" + d.k} className="cursor-pointer" cx={X(i) + slot / 2} cy="195" r={d.sends.length > 1 ? 3 : 2} fill="#f2f2f2" onClick={() => onSendClick(d.sends[0].id)}>
          <title>{d.sends.map((s) => s.campaign + " " + s.time).join(", ")}</title>
        </circle>,
      );
  });

  const title = (cum ? "Cumulative orders" : "Daily " + VIEW[view]) + (compare !== "none" ? " vs " + COMPARE[compare] : "");
  const Fu = M.G.full;
  const tiles = (
    <>
      <Tile k={"Gross lift" + (M.live ? " to date" : "")} value={Fu.lift.units.delta == null ? "—" : F.signed(Fu.lift.units.delta)} sub={Fu.lift.units.delta == null ? "no actuals yet" : (M.status.liftBand ?? "") + " · " + F.int(M.margin.incUnits) + " units"} />
      <Tile k="Net lift" value={M.margin.post14 == null ? "—" : F.signed(Fu.B.units > 0 ? M.margin.netInc / Fu.B.units : null)} sub={M.margin.post14 == null ? "after " + F.md(addDays(S.end, 14)) : "after-dip " + F.dec2(M.margin.post14)} />
      <Tile k="Base / day" value={F.int(M.base.unitsDay)} sub={"units · " + F.int(M.base.ordersDay) + " orders"} />
      <Tile k="Clean days" value={M.base.days + ""} sub={M.base.from && M.base.to ? F.md(M.base.from) + " – " + F.md(M.base.to) : "—"} />
    </>
  );
  const words = [
    <>Early access <b>{M.G.ea.lift.units.delta == null ? "—" : F.signed(M.G.ea.lift.units.delta)}</b> units · {M.G.ea.lift.orders.delta == null ? "—" : F.signed(M.G.ea.lift.orders.delta)} orders{M.G.ea.lift.orders.z != null && M.G.ea.done ? " · " + bandWord(M.G.ea.lift.orders.z) : ""}</>,
    <>Public{M.live ? " to date" : ""} <b>{M.G.main.lift.units.delta == null ? "—" : F.signed(M.G.main.lift.units.delta)}</b> units · {M.G.main.lift.orders.delta == null ? "—" : F.signed(M.G.main.lift.orders.delta)} orders</>,
    <>Pre-7 <b>{M.G.pre.lift.units.delta == null ? "—" : F.signed(M.G.pre.lift.units.delta)}</b></>,
    <>After-14 <b>{M.margin.post14 == null ? "—" : F.dec2(M.margin.post14)}</b></>,
  ];

  const [hoverInfo, setHoverInfo] = useState<{ x: number; k: string } | null>(null);
  const hovered = hoverInfo ? days.find((d) => d.k === hoverInfo.k) : null;

  return (
    <ModuleCard
      id="daily"
      title={title}
      right={
        <>
          <span className="inline-flex overflow-hidden rounded border border-border/60">
            {(["units", "orders", "paid", "cum"] as ViewKey[]).map((v) => (
              <button key={v} type="button" aria-pressed={view === v} onClick={() => onView(v)} disabled={v === "paid"} title={v === "paid" ? "Revenue source pending" : undefined}
                className={"h-6 px-2 text-[11px] " + (view === v ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground") + (v === "paid" ? " opacity-40" : "")}>
                {v === "cum" ? "Cumulative" : v[0].toUpperCase() + v.slice(1)}
              </button>
            ))}
          </span>
          <span className="ml-2 inline-flex items-center gap-1 text-[11px]"><i className="inline-block h-2.5 w-2.5 bg-[#d4d4d4]" />Actual</span>
          {compare === "plan" || !cum ? <span className="inline-flex items-center gap-1 text-[11px]"><i className="inline-block h-2.5 w-2.5 border border-dashed border-[#9a9a9a]" />Plan</span> : null}
          {compare === "baseline" ? <span className="inline-flex items-center gap-1 text-[11px]"><i className="inline-block h-0 w-3 border-t border-dotted border-[#9a9a9a]" />Baseline</span> : null}
        </>
      }
      strip={words}
    >
      {loading ? (
        <Skeleton h={232} />
      ) : (
        <div className="grid grid-cols-[1fr_316px] gap-4 p-4">
          <div className="relative">
            <svg className="block w-full" viewBox={`0 0 ${W} ${H}`} aria-hidden="true" onMouseLeave={() => { setHoverInfo(null); onHover(null); }}>
              <HatchDefs id={hid} />
              {grid}
              <line x1={PL} x2={W - PR} y1={Y(0)} y2={Y(0)} stroke="#3d3d3d" />
              {bars}
              {vp}
              {xl}
              {br}
              {dots}
              {paidView ? <text x={PL + (W - PL - PR) / 2} y="70" fill="#9a9a9a" fontSize="12" textAnchor="middle">Paid $ needs a revenue source</text> : null}
              {M.upcoming ? <text x={PL + (W - PL - PR) / 2} y="70" fill="#9a9a9a" fontSize="12" textAnchor="middle">No orders yet · opens {F.md(S.d1)}</text> : null}
              {hoverInfo ? <line x1={hoverInfo.x} x2={hoverInfo.x} y1="8" y2="152" stroke="#9a9a9a" strokeDasharray="2 2" /> : null}
              {days.map((d, i) => (
                <rect key={"hit" + d.k} x={X(i)} y="0" width={slot} height="172" fill="transparent"
                  onMouseEnter={() => { setHoverInfo({ x: X(i) + slot / 2, k: d.k }); onHover(d.k); }} />
              ))}
            </svg>
            {hovered ? (
              <div className="pointer-events-none absolute -top-1 rounded border border-border bg-popover px-2.5 py-1.5 text-xs shadow-md" style={{ left: `${(hoverInfo!.x / W) * 100}%`, transform: "translate(-50%, -100%)" }}>
                <div className="mb-0.5 font-semibold">{F.dayDow(hovered.k)} · {hovered.phase === "ea" ? "EA " : hovered.phase === "main" ? "Day " : hovered.phase === "pre" ? "Pre " : "After "}{M.G[hovered.phase].rows.indexOf(hovered) + 1}{hovered.partial ? " · to " + M.asOfTime : ""}</div>
                <div className="flex justify-between gap-4"><span>Actual</span><span className="tabular-nums">{hovered[key] == null ? "—" : F.int(hovered[key])}</span></div>
                {hovered.phase === "ea" || hovered.phase === "main" ? <div className="flex justify-between gap-4"><span>Plan</span><span className="tabular-nums">{F.int(hovered.plan[key])}</span></div> : null}
                <div className="flex justify-between gap-4"><span>Baseline</span><span className="tabular-nums">{F.int(key === "units" ? hovered.base.unitsFull : hovered.base.orders)}</span></div>
                {hovered.sends.length ? <div className="flex justify-between gap-4"><span>Send</span><span>{hovered.sends.map((s) => s.campaign + " " + s.time).join(", ")}</span></div> : null}
              </div>
            ) : null}
          </div>
          <div className="grid grid-cols-2 gap-2 content-start">{tiles}</div>
        </div>
      )}
    </ModuleCard>
  );
}
