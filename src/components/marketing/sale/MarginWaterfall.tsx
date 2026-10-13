import { F } from "@/lib/marketing/sale-format";
import { QUALITY } from "@/lib/marketing/sale-labels";
import type { SaleMetrics } from "@/lib/marketing/sale-metrics";
import { Chip, HatchDefs, ModuleCard, Skeleton, Tile } from "./sale-ui";

const W = 634, H = 170, CW = 80;

/**
 * Margin waterfall: incremental margin, minus the give-away on baseline
 * demand, minus gift cost, minus the after-dip, to net. Modeled at list
 * price until a revenue source exists; the discount dollars are real.
 */
export function MarginWaterfall({ M, loading }: { M: SaleMetrics; loading?: boolean }) {
  const m = M.margin;
  const none = M.scorecard.margin.actual == null;
  const hatched = m.quality !== "final";
  const items: Array<[string, number | null, string]> = [
    ["Incremental margin", m.incremental, "#d4d4d4"],
    ["Give-away on baseline", -m.giveaway, "#8a8a8a"],
    ["Gift cost", -m.giftCost, "#8a8a8a"],
    ["After-dip margin", m.dipMargin == null ? null : -m.dipMargin, "#8a8a8a"],
    ["Net", m.net, m.net >= 0 ? "#4ade80" : "#f87171"],
  ];
  const gap = (W - 5 * CW - 40) / 4;
  const vals = none ? [] : items.map((i) => i[1] || 0);
  const lo = Math.min(0, ...vals), hi = Math.max(1, ...vals);
  const Y = (v: number) => 18 + (1 - (v - lo) / (hi - lo)) * (H - 44);
  const nodes: React.ReactNode[] = [];
  let run = 0, prevX: number | null = null, prevY = 0;
  items.forEach(([l, v, col], i) => {
    const x = 20 + i * (CW + gap);
    const empty = v == null || none;
    let y0: number, y1: number;
    if (i === 0) { y0 = Y(0); y1 = Y(empty ? 0 : (v as number)); run = empty ? 0 : (v as number); }
    else if (i < 4) { y0 = Y(run); run += empty ? 0 : (v as number); y1 = Y(run); }
    else { y0 = Y(0); y1 = Y(empty ? 0 : (v as number)); }
    const fill = empty ? "none" : hatched ? "url(#hatchW)" : col;
    const tip = l + " · " + (empty ? "—" : F.money(v)) + (i === 1 ? " · sale-code discount $ × baseline share " + F.dec2(m.baseShare) : i === 0 ? " · incremental units × list × (CM − discount rate)" : "");
    nodes.push(
      <rect key={"r" + i} x={x} y={Math.min(y0, y1)} width={CW} height={Math.max(1, Math.abs(y1 - y0))} fill={fill} stroke={empty ? "#9a9a9a" : hatched ? col : "none"} strokeDasharray={empty ? "2 2" : ""}>
        <title>{tip}</title>
      </rect>,
    );
    if (prevX != null) nodes.push(<line key={"c" + i} x1={prevX} x2={x} y1={prevY} y2={prevY} stroke="#3d3d3d" />);
    prevX = x + CW; prevY = i < 4 ? Y(run) : y1;
    nodes.push(<text key={"v" + i} x={x + CW / 2} y={Math.min(y0, y1) - 5} fill="#f2f2f2" fontSize="11" fontWeight="600" textAnchor="middle">{empty ? "—" : F.money(v)}</text>);
    nodes.push(<text key={"l" + i} x={x + CW / 2} y={H - 6} fill="#9a9a9a" fontSize="10" textAnchor="middle">{l}</text>);
  });

  return (
    <ModuleCard
      id="margin"
      title={"Margin" + (M.live ? " to date" : "")}
      right={
        <>
          <Chip tone="k" label={QUALITY[m.quality]} />
          <Chip tone="k" label={"Costs CM " + Math.round(m.cm * 100) + "%"} tip="Contribution margin as a share of list price until landed costs exist." />
          <Chip tone="a" label="Modeled at list" tip="No revenue source yet: prices are list prices; discount dollars come from the ShipStation discount lines." />
        </>
      }
      strip={[
        <>Discount on incremental <b>{F.money(m.discOnInc)}</b></>,
        <>Sale-code discount <b>{F.money(m.saleDisc)}</b> · {F.pct1(m.discRate)}% of list sales</>,
        <>Net incremental margin <b className={m.net >= 0 ? "!text-green-400" : "!text-red-400"}>{none ? "—" : F.money(m.net)}</b></>,
      ]}
    >
      {loading ? (
        <Skeleton h={202} />
      ) : (
        <div className="grid grid-cols-[1fr_316px] gap-4 p-4">
          <svg className="block w-full" viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
            <HatchDefs id="hatchW" />
            {nodes}
          </svg>
          <div className="grid grid-cols-2 gap-2 content-start">
            <Tile k="Promo cost" value={none ? "—" : F.money(m.promoCost)} sub={none ? "modeled before the sale" : "give-away " + F.money(m.giveaway) + " · gift " + F.money(m.giftCost)} />
            <Tile k="ROI" value={none ? "—" : F.x(m.roi)} sub="net margin ÷ promo cost" />
            <Tile k="Cost / incremental order" value={m.perOrder == null ? "—" : "$" + F.dec2(m.perOrder)} sub={F.int(m.incOrders) + " incremental orders"} />
            <Tile k="Cost / incremental new" value={m.perNew == null ? "—" : "$" + F.dec2(m.perNew)} sub={F.int(M.customers?.incNew ?? 0) + " incremental new"} />
          </div>
        </div>
      )}
    </ModuleCard>
  );
}
