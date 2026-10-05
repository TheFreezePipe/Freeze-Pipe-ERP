/**
 * The ledger's Chart view: units in the building over time as a step line
 * (solid while the arrivals are firm, dashed once they are estimates), the
 * need as a dashed level and the launch's days — Today, Ready by, Early
 * access, Launch — as vertical marks. The x axis runs from the earlier of
 * today and the ready-by date to four days past the later of the launch and
 * the last arrival. Every value is the ledger's own (running totals per
 * row); this file only places them.
 */
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, XAxis, YAxis } from "recharts";
import { addDaysIso, daysBetween } from "@/lib/marketing/workback";
import { fmtDay } from "@/lib/marketing/format-day";
import { fmtUnits, LAUNCH_SUPPLY_LABEL, type LaunchSupplyLaunch, type SupplyLedger } from "@/lib/marketing/launch-supply";

interface Props {
  ledger: SupplyLedger;
  launch: LaunchSupplyLaunch;
  todayIso: string;
}

/** Recharts takes colours, not classes: Tailwind green-400 for the line, violet-400 for early access, greys from the theme. */
const LINE = "#4ade80";
const GRID = "#262626";
const AXIS = "#3d3d3d";
const TICK = "#6b6b6b";
const NEED = "#f2f2f2";
const NEED_TEXT = "#d4d4d4";
const MARK = { today: "#9a9a9a", ready: "#d4d4d4", ea: "#a78bfa", launch: "#f2f2f2" } as const;

const MARK_LABEL = { today: "Today", ready: LAUNCH_SUPPLY_LABEL.milestone.ready, ea: "EA", launch: LAUNCH_SUPPLY_LABEL.milestone.launch } as const;

const HEIGHT = 190;

type Point = { t: number; firm?: number; est?: number };

const laterOf = (a: string, b: string): string => (a > b ? a : b);

export function LaunchSupplyChart({ ledger, launch, todayIso }: Props) {
  const launchDate = launch.launch_date?.slice(0, 10) ?? null;
  const eaDate = launch.early_access_date?.slice(0, 10) ?? null;
  const start = ledger.readyBy && ledger.readyBy < todayIso ? ledger.readyBy : todayIso;
  const lastRow = ledger.rows.reduce((m, r) => laterOf(m, r.date), todayIso);
  const end = addDaysIso(laterOf(launchDate ?? lastRow, lastRow), 4);
  const span = Math.max(1, daysBetween(start, end));
  const t = (date: string) => daysBetween(start, date);

  // One point per ledger row at its arrival day (stock and dock rows at the
  // start), carrying the running total after it. Rows feed the solid series
  // until the first estimate; from there every row feeds the dashed one (a
  // running total that includes an estimated arrival is itself an estimate,
  // and a series with a gap would not draw). The last firm point is repeated
  // in the dashed series so the two join, and the final total runs to the
  // right edge.
  const data: Point[] = [];
  if (ledger.rows.length === 0 || !ledger.rows[0].here) data.push({ t: 0, firm: 0 });
  let lastFirm = data.length - 1;
  let anyEst = false;
  for (const row of ledger.rows) {
    const x = row.here ? 0 : t(row.date);
    if (row.estimated || anyEst) {
      if (!anyEst && lastFirm >= 0) data[lastFirm].est = data[lastFirm].firm;
      anyEst = true;
      data.push({ t: x, est: row.runningTotal });
    } else {
      data.push({ t: x, firm: row.runningTotal });
      lastFirm = data.length - 1;
    }
  }
  data.push(anyEst ? { t: span, est: ledger.total } : { t: span, firm: ledger.total });

  const peak = Math.max(ledger.basis, ledger.total);
  const top = peak * 1.12 || 1;
  const yTicks = peak > 0 ? [Math.round(peak / 2), peak] : [0];

  const marks: { key: keyof typeof MARK; date: string }[] = [{ key: "today", date: todayIso }];
  if (ledger.readyBy) marks.push({ key: "ready", date: ledger.readyBy });
  if (eaDate) marks.push({ key: "ea", date: eaDate });
  if (launchDate) marks.push({ key: "launch", date: launchDate });

  return (
    <ResponsiveContainer width="100%" height={HEIGHT}>
      <LineChart data={data} margin={{ top: 10, right: 14, bottom: 0, left: 0 }}>
        <CartesianGrid horizontal vertical={false} stroke={GRID} />
        <XAxis dataKey="t" type="number" domain={[0, span]} tick={false} tickLine={false} axisLine={{ stroke: AXIS }} height={18} />
        <YAxis
          type="number"
          domain={[0, top]}
          ticks={yTicks}
          width={40}
          tick={{ fontSize: 10, fill: TICK }}
          tickLine={false}
          axisLine={false}
          tickFormatter={(v: number) => fmtUnits(v)}
        />
        {marks.map((m) => (
          <ReferenceLine
            key={m.key}
            x={t(m.date)}
            stroke={MARK[m.key]}
            strokeOpacity={0.6}
            strokeDasharray={m.key === "launch" ? undefined : "3 3"}
            label={{ value: `${MARK_LABEL[m.key]} ${fmtDay(m.date)}`, position: "bottom", fill: MARK[m.key], fontSize: 10 }}
          />
        ))}
        {ledger.need != null && (
          <ReferenceLine
            y={ledger.need}
            stroke={NEED}
            strokeOpacity={0.7}
            strokeDasharray="5 4"
            label={{ value: `Need ${fmtUnits(ledger.need)}`, position: "insideTopRight", fill: NEED_TEXT, fontSize: 10 }}
          />
        )}
        <Line type="stepAfter" dataKey="firm" stroke={LINE} strokeWidth={2} dot={false} isAnimationActive={false} />
        <Line type="stepAfter" dataKey="est" stroke={LINE} strokeWidth={2} strokeOpacity={0.7} strokeDasharray="4 3" dot={false} isAnimationActive={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}
