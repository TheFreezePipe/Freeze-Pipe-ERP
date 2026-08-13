import { useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Ship, AlertTriangle } from "lucide-react";
import { format, parseISO } from "date-fns";
import { cn } from "@/lib/utils";
import { useFreightShipments } from "@/lib/hooks";
import {
  buildTransitRows,
  windowStats,
  trailingMedianSeries,
  transitBand,
  inTransitSummary,
  REPORT_WINDOWS,
  ON_TIME_GRACE_DAYS,
  type ReportWindowKey,
  type TransitRow,
} from "@/lib/freight/transit-report";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// Chart geometry — fixed viewBox, responsive via width 100%.
const CW = 830;
const CH = 236;
const X0 = 46, X1 = CW - 14, Y0 = 12, Y1 = CH - 40;

const fmt1 = (n: number) => (Math.round(n * 10) / 10).toLocaleString();
const md = (iso: string) => format(parseISO(iso), "MMM d");

/**
 * Sea Transit report — drill-down behind the dashboard transit card.
 * Small-sample honesty rules (why medians headline, why P90/trend
 * suppress, why there are no delta arrows) live in transit-report.ts.
 */
export function TransitReportModal({ open, onOpenChange }: Props) {
  const { data: shipments = [] } = useFreightShipments();
  // Default 90D: the report earns its keep at ~40 arrivals, and the 30D
  // number the user clicked is one tap away (owner-approved default).
  const [win, setWin] = useState<ReportWindowKey>("90");
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [tipPos, setTipPos] = useState<{ x: number; y: number } | null>(null);
  // Frozen at mount (lazy initializer keeps render pure per the React
  // Compiler); only goes stale across midnight, which a reload fixes.
  const [todayIso] = useState(() => new Date().toISOString().slice(0, 10));

  const rows = useMemo(() => buildTransitRows(shipments), [shipments]);
  const band = useMemo(() => transitBand(rows), [rows]);
  const trail = useMemo(() => trailingMedianSeries(rows), [rows]);
  const onWater = useMemo(() => inTransitSummary(shipments, todayIso), [shipments, todayIso]);

  const days = REPORT_WINDOWS.find((w) => w.key === win)?.days ?? 90;
  const stats = useMemo(() => windowStats(rows, days, todayIso), [rows, days, todayIso]);
  const cutoff = useMemo(
    // Same cutoff windowStats used, so dot dimming and the table agree
    // with the tiles.
    () =>
      new Date(Date.parse(todayIso + "T00:00:00Z") - days * 86_400_000)
        .toISOString()
        .slice(0, 10),
    [days, todayIso],
  );
  const inWin = (r: TransitRow) => r.arrivalDate >= cutoff;
  const windowRows = rows.filter(inWin);

  // X spans full history (context never crops); Y padded to the data.
  const scale = useMemo(() => {
    if (rows.length === 0) return null;
    const tMin = Date.parse(rows[0].arrivalDate) - 5 * 86_400_000;
    const tMax = Date.parse(todayIso + "T23:59:59Z");
    const vAll = rows.map((r) => r.transitDays);
    const vMin = Math.max(Math.min(...vAll) - 4, 0);
    const vMax = Math.max(...vAll) + 4;
    return {
      x: (iso: string) => X0 + ((Date.parse(iso) - tMin) / (tMax - tMin)) * (X1 - X0),
      y: (v: number) => Y1 - ((v - vMin) / (vMax - vMin)) * (Y1 - Y0),
      yTicks: gridTicks(vMin, vMax),
      monthTicks: monthStarts(tMin, tMax),
    };
  }, [rows, todayIso]);

  // Same-day arrivals jitter right so every dot stays visible.
  const jitter = useMemo(() => {
    const seen = new Map<string, number>();
    return rows.map((r) => {
      const k = seen.get(r.arrivalDate) ?? 0;
      seen.set(r.arrivalDate, k + 1);
      return k * 5.5;
    });
  }, [rows]);

  const hovered = hoverId ? rows.find((r) => r.id === hoverId) : null;
  const sixMoNote = days >= 180 && rows.length > 0 && windowRows.length === rows.length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[88vh] overflow-y-auto">
        <DialogHeader>
          <div className="flex items-center gap-3 flex-wrap pr-6">
            <div>
              <DialogTitle>Sea Transit</DialogTitle>
              <p className="text-xs text-muted-foreground mt-0.5">
                China → US warehouse · arrivals only
              </p>
            </div>
            <div className="inline-flex rounded-lg border border-border bg-muted/60 p-0.5 ml-2">
              {REPORT_WINDOWS.map((w) => (
                <button
                  key={w.key}
                  type="button"
                  onClick={() => setWin(w.key)}
                  className={cn(
                    "px-3 py-1 rounded-md text-xs font-semibold transition-colors",
                    win === w.key
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {w.label}
                </button>
              ))}
            </div>
            <Badge variant="outline" className="tabular-nums">
              {stats.n} arrival{stats.n === 1 ? "" : "s"}
            </Badge>
          </div>
        </DialogHeader>

        {onWater && (
          <div className="flex items-center gap-2 rounded-lg border border-primary/25 bg-primary/5 px-3 py-2 text-xs text-muted-foreground">
            <Ship className="h-3.5 w-3.5 text-primary shrink-0" />
            <span>
              <span className="text-foreground font-medium">
                {onWater.count} shipment{onWater.count === 1 ? "" : "s"} on the water now
              </span>{" "}
              — oldest shipped {onWater.oldestDays}d ago (#{onWater.oldestNumber}
              {onWater.oldestHighRisk && (
                <span className="text-red-400">, high risk</span>
              )}
              ). In-transit shipments are excluded from every stat below.
            </span>
          </div>
        )}

        {stats.n === 0 ? (
          <EmptyState rows={rows} todayIso={todayIso} onView90={() => setWin("90")} />
        ) : (
          <>
            <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
              <Tile label="Typical transit" value={fmt1(stats.medianTransit)} unit="days">
                avg {fmt1(stats.avgTransit)}d · range{" "}
                <em className="not-italic font-semibold text-foreground/90">
                  {stats.minTransit}–{stats.maxTransit}d
                </em>
              </Tile>
              <Tile label="Ship → sellable" value={fmt1(stats.s2sMedian)} unit="days">
                {stats.s2sP90 != null ? (
                  <>
                    plan on{" "}
                    <em className="not-italic font-semibold text-foreground/90">
                      {Math.round(stats.s2sP90)}d
                    </em>{" "}
                    (P90) for PO timing
                  </>
                ) : stats.s2sWorst ? (
                  <>
                    worst:{" "}
                    <em className="not-italic font-semibold text-foreground/90">
                      {stats.s2sWorst.days}d
                    </em>{" "}
                    (#{stats.s2sWorst.number}) — P90 needs 15+ arrivals
                  </>
                ) : (
                  "awaiting first check-in"
                )}
              </Tile>
              <Tile
                label="On-time to promise"
                value={`${stats.onTimeCount}`}
                unit={`of ${stats.withPromise}`}
              >
                {stats.n >= 5 && stats.withPromise > 0 && (
                  <span className="relative block h-[5px] rounded bg-muted mt-1 mb-1.5">
                    <span
                      className="absolute inset-y-0 left-0 rounded"
                      style={{
                        width: `${Math.round((100 * stats.onTimeCount) / stats.withPromise)}%`,
                        backgroundColor: "hsl(var(--chart-1))",
                      }}
                    />
                    <span
                      className="absolute -top-[3px] -bottom-[3px] w-[2px] bg-muted-foreground/70"
                      style={{ left: "60%" }}
                      title="ocean freight industry ~60%"
                    />
                  </span>
                )}
                within {ON_TIME_GRACE_DAYS}d of promise
                {stats.withPromise > 0 &&
                  ` (${Math.round((100 * stats.onTimeCount) / stats.withPromise)}%)`}
                {stats.lateMedianSlip != null && (
                  <>
                    {" "}· late ones ran{" "}
                    <em className="not-italic font-semibold text-foreground/90">
                      +{fmt1(stats.lateMedianSlip)}d
                    </em>{" "}
                    median
                  </>
                )}
              </Tile>
              <Tile label="Dock → stock" value={fmt1(stats.dwellMedian)} unit="days">
                {stats.dwellMax > 5 ? (
                  <span className="text-amber-400 inline-flex items-center gap-1">
                    <AlertTriangle className="h-3 w-3" />#{stats.dwellMaxNumber} sat{" "}
                    {stats.dwellMax}d unchecked
                  </span>
                ) : (
                  <>
                    longest {stats.dwellMax}d
                    {stats.dwellMax > 0 && stats.dwellMaxNumber
                      ? ` (#${stats.dwellMaxNumber})`
                      : ""}{" "}
                    — crew is fast
                  </>
                )}
              </Tile>
            </div>

            {scale && (
              <div className="relative">
                <div className="flex items-baseline gap-2.5 mb-0.5">
                  <span className="text-xs font-semibold">Every arrival, ship→door days</span>
                  <span className="text-[11px] text-muted-foreground">
                    {sixMoNote && "6M and 1Y are identical until data ages past Mar 2026 · "}
                    dots outside the selected window are dimmed
                  </span>
                </div>
                <svg
                  viewBox={`0 0 ${CW} ${CH}`}
                  className="w-full"
                  role="img"
                  aria-label="Dot timeline of transit days per arrival"
                  onMouseLeave={() => setHoverId(null)}
                >
                  {/* typical-range band + grid */}
                  <rect
                    x={X0}
                    y={scale.y(band.p75)}
                    width={X1 - X0}
                    height={scale.y(band.p25) - scale.y(band.p75)}
                    className="fill-foreground/[0.05]"
                  />
                  {scale.yTicks.map((g) => (
                    <g key={g}>
                      <line x1={X0} x2={X1} y1={scale.y(g)} y2={scale.y(g)} className="stroke-foreground/10" />
                      <text x={X0 - 8} y={scale.y(g) + 3.5} textAnchor="end" className="fill-muted-foreground text-[10.5px] font-mono">
                        {g}d
                      </text>
                    </g>
                  ))}
                  {scale.monthTicks.map((m) => (
                    <g key={m.iso}>
                      <line x1={scale.x(m.iso)} x2={scale.x(m.iso)} y1={Y0} y2={Y1} className="stroke-foreground/5" />
                      <text x={scale.x(m.iso) + 4} y={Y1 + 16} className="fill-muted-foreground text-[10.5px] font-mono">
                        {m.label}
                      </text>
                    </g>
                  ))}
                  {/* trailing-5 median — hidden for very thin windows */}
                  {stats.showTrend && (
                    <polyline
                      fill="none"
                      strokeWidth={2}
                      strokeLinejoin="round"
                      className="stroke-primary opacity-85"
                      points={rows.map((r, i) => `${scale.x(r.arrivalDate) + jitter[i]},${scale.y(trail[i])}`).join(" ")}
                    />
                  )}
                  {rows.map((r, i) => {
                    const cx = scale.x(r.arrivalDate) + jitter[i];
                    const cy = scale.y(r.transitDays);
                    const dim = !inWin(r);
                    return (
                      <g
                        key={r.id}
                        className={cn("cursor-pointer", dim && "opacity-30")}
                        onMouseEnter={(e) => {
                          setHoverId(r.id);
                          const box = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
                          setTipPos({
                            x: Math.min(e.clientX - box.left + 14, box.width - 205),
                            y: e.clientY - box.top - 10,
                          });
                        }}
                      >
                        {r.customsDelay && (
                          <circle cx={cx} cy={cy} r={8} fill="none" stroke="#fbbf24" strokeWidth={2} />
                        )}
                        <circle
                          cx={cx}
                          cy={cy}
                          r={4.5}
                          fill="hsl(var(--chart-1))"
                          className={cn("stroke-background", hoverId === r.id && "stroke-foreground")}
                          strokeWidth={1.5}
                        />
                        <circle cx={cx} cy={cy} r={11} fill="transparent" />
                      </g>
                    );
                  })}
                </svg>
                <div className="flex gap-4 flex-wrap text-[11px] text-muted-foreground mt-1">
                  <span className="inline-flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full" style={{ background: "hsl(var(--chart-1))" }} />
                    arrival (transit days)
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full border-2 border-amber-400" />
                    customs hold
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="h-2 w-3 bg-foreground/10 rounded-sm" />
                    typical range (middle 50%)
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="h-0.5 w-3.5 bg-primary" />
                    trailing-5 median
                  </span>
                </div>
                {hovered && tipPos && (
                  <div
                    className="absolute z-10 w-[200px] rounded-lg border border-border bg-popover px-3 py-2 text-[11.5px] shadow-xl pointer-events-none"
                    style={{ left: tipPos.x, top: tipPos.y }}
                  >
                    <span className="font-semibold text-[12.5px]">Sea Freight {hovered.number}</span>
                    {hovered.customsDelay && (
                      <span className="text-amber-400"> · customs hold</span>
                    )}
                    <br />
                    <span className="text-muted-foreground">Shipped</span> {md(hovered.shipDate)} →{" "}
                    <span className="text-muted-foreground">arrived</span> {md(hovered.arrivalDate)}
                    <br />
                    <span className="font-semibold">{hovered.transitDays} days</span>{" "}
                    <span className="text-muted-foreground">
                      {hovered.slipDays != null &&
                        `· promise ${hovered.slipDays > 0 ? "+" : ""}${hovered.slipDays}d `}
                      {hovered.dwellDays != null && `· check-in ${hovered.dwellDays}d`}
                    </span>
                  </div>
                )}
              </div>
            )}

            <div className="rounded-lg border border-border overflow-hidden">
              <div className="max-h-52 overflow-y-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-[9.5px] uppercase tracking-wider text-muted-foreground">
                      <th className="sticky top-0 bg-muted/80 backdrop-blur px-3 py-2">Shipment</th>
                      <th className="sticky top-0 bg-muted/80 backdrop-blur px-3 py-2">Shipped</th>
                      <th className="sticky top-0 bg-muted/80 backdrop-blur px-3 py-2">Arrived</th>
                      <th className="sticky top-0 bg-muted/80 backdrop-blur px-3 py-2 text-right">Transit</th>
                      <th className="sticky top-0 bg-muted/80 backdrop-blur px-3 py-2 text-right">vs Promise</th>
                      <th className="sticky top-0 bg-muted/80 backdrop-blur px-3 py-2 text-right">Check-in</th>
                      <th className="sticky top-0 bg-muted/80 backdrop-blur px-3 py-2">Flags</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...windowRows].reverse().map((r) => (
                      <tr
                        key={r.id}
                        data-row={r.id}
                        onMouseEnter={() => setHoverId(r.id)}
                        onMouseLeave={() => setHoverId(null)}
                        className={cn(
                          "border-t border-border/60",
                          hoverId === r.id && "bg-primary/10",
                        )}
                      >
                        <td className="px-3 py-1.5 font-mono">{r.number}</td>
                        <td className="px-3 py-1.5 text-muted-foreground">{md(r.shipDate)}</td>
                        <td className="px-3 py-1.5 text-muted-foreground">{md(r.arrivalDate)}</td>
                        <td
                          className={cn(
                            "px-3 py-1.5 text-right font-mono tabular-nums",
                            r.transitDays >= band.p90
                              ? "text-red-400"
                              : r.transitDays > band.p75
                                ? "text-amber-400"
                                : r.transitDays < band.p25
                                  ? "text-green-400"
                                  : "",
                          )}
                        >
                          {r.transitDays}d
                        </td>
                        <td
                          className={cn(
                            "px-3 py-1.5 text-right font-mono tabular-nums",
                            r.slipDays == null
                              ? "text-muted-foreground/60"
                              : r.slipDays > ON_TIME_GRACE_DAYS
                                ? "text-amber-400"
                                : r.slipDays < 0
                                  ? "text-green-400"
                                  : "text-muted-foreground",
                          )}
                        >
                          {r.slipDays == null ? "—" : `${r.slipDays > 0 ? "+" : ""}${r.slipDays}d`}
                        </td>
                        <td className="px-3 py-1.5 text-right font-mono tabular-nums text-muted-foreground">
                          {r.dwellDays == null ? "—" : `${r.dwellDays}d`}
                        </td>
                        <td className="px-3 py-1.5">
                          {r.customsDelay && (
                            <Badge
                              variant="outline"
                              className="border-amber-500/50 text-amber-400 text-[10px] py-0"
                            >
                              customs
                            </Badge>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}

        <p className="text-[10.5px] text-muted-foreground/80">
          Transit = ship date → carrier arrival. Check-in = arrival → receipt confirmed. On-time =
          within {ON_TIME_GRACE_DAYS} days of the originally promised ETA. Data begins Mar 2026.
        </p>
      </DialogContent>
    </Dialog>
  );
}

function Tile({
  label,
  value,
  unit,
  children,
}: {
  label: string;
  value: string;
  unit: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border bg-card px-3.5 py-3 min-w-0">
      <div className="text-[10px] uppercase tracking-widest text-muted-foreground">{label}</div>
      <div className="text-2xl font-semibold mt-0.5 leading-tight">
        {value} <span className="text-sm text-muted-foreground font-medium">{unit}</span>
      </div>
      <div className="text-[11px] text-muted-foreground mt-1 leading-snug">{children}</div>
    </div>
  );
}

function EmptyState({
  rows,
  todayIso,
  onView90,
}: {
  rows: TransitRow[];
  todayIso: string;
  onView90: () => void;
}) {
  const last = rows[rows.length - 1];
  const ago = last
    ? Math.round((Date.parse(todayIso) - Date.parse(last.arrivalDate)) / 86_400_000)
    : null;
  return (
    <div className="rounded-lg border border-border bg-card px-6 py-10 text-center text-sm text-muted-foreground">
      <p>
        No sea arrivals in this window
        {last && (
          <>
            {" "}— last arrival {md(last.arrivalDate)} ({ago}d ago)
          </>
        )}
        .
      </p>
      <Button variant="outline" size="sm" className="mt-3" onClick={onView90}>
        View 90 days
      </Button>
    </div>
  );
}

function gridTicks(vMin: number, vMax: number): number[] {
  const step = vMax - vMin > 40 ? 10 : 5;
  const out: number[] = [];
  for (let g = Math.ceil(vMin / step) * step; g <= vMax; g += step) out.push(g);
  return out;
}

const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function monthStarts(tMin: number, tMax: number): { iso: string; label: string }[] {
  const out: { iso: string; label: string }[] = [];
  const d = new Date(tMin);
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + 1);
  while (d.getTime() <= tMax) {
    // Label from the UTC month directly — format() would render in the
    // browser's timezone and shift "Jun 1" back to "May" for US users.
    out.push({ iso: d.toISOString().slice(0, 10), label: MONTH_LABELS[d.getUTCMonth()] });
    d.setUTCMonth(d.getUTCMonth() + 1);
  }
  return out;
}
