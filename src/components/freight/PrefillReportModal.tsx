import { useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Ship } from "lucide-react";
import { cn } from "@/lib/utils";
import { format, parseISO } from "date-fns";
import { useFreightShipments, useFreightLineItems, useFillPace } from "@/lib/hooks";
import { useTableSort, applySort, SortableTh } from "@/components/shared/table-sort";
import {
  buildPrefillRows,
  buildSkuProof,
  windowTotals,
  monthlyStacks,
  skuRollup,
  inboundSummary,
  workingDaysUntil,
  paceVerdict,
  PREFILL_WINDOWS,
  type PrefillWindowKey,
  type AskRow,
} from "@/lib/freight/prefill-report";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// Two-hue system, validated for the dark surface (categorical checks all
// pass at ΔE 26.8 CVD / 3:1 contrast — see the proposal). Prefilled is the
// calm blue; unfilled is the workload orange, reused across bars, tiles,
// the inbound band, and the table so color always means the same thing.
const PREFILLED_COLOR = "#3987e5";
const UNFILLED_COLOR = "#d95926";
const UNFILLED_TEXT = "text-[#ef8354]";
// Inbound ETA buckets: one hue stepped light→dark, soonest brightest.
const BUCKET_COLORS = ["#e97845", "#c14e20", "#6e3a20"];
const BUCKET_LABELS = ["next 2 weeks", "2–4 weeks", "4+ weeks / unknown"];

const fmt = (n: number) => n.toLocaleString();

/**
 * Pre-filled Rate report, rebuilt to the owner-approved v3 proposal:
 * hero count tiles → monthly unit-stacked bars → on-the-water band →
 * per-SKU table → factory ask list (deliberately last). Arrival basis
 * everywhere backward-looking; small-data guardrails in prefill-report.ts.
 */
export function PrefillReportModal({ open, onOpenChange }: Props) {
  const { data: lines = [] } = useFreightLineItems();
  const { data: shipments = [] } = useFreightShipments();
  const { data: pace } = useFillPace();
  const [win, setWin] = useState<PrefillWindowKey>("180");
  // Frozen at mount — keeps render pure for the React Compiler.
  const [todayIso] = useState(() => new Date().toISOString().slice(0, 10));

  const days = PREFILL_WINDOWS.find((w) => w.key === win)?.days ?? 180;
  const rows = useMemo(() => buildPrefillRows(lines, shipments), [lines, shipments]);
  const proof = useMemo(() => buildSkuProof(lines, shipments), [lines, shipments]);
  const totals = useMemo(() => windowTotals(rows, days, todayIso), [rows, days, todayIso]);
  const months = useMemo(() => monthlyStacks(rows, days, todayIso), [rows, days, todayIso]);
  const rollup = useMemo(() => skuRollup(rows, days, todayIso, proof), [rows, days, todayIso, proof]);
  const inbound = useMemo(() => inboundSummary(lines, shipments, todayIso), [lines, shipments, todayIso]);

  const crewDays =
    pace?.unitsPerActiveDay != null ? Math.round(inbound.unfilled / pace.unitsPerActiveDay) : null;
  const runway = inbound.lastEta ? workingDaysUntil(inbound.lastEta, todayIso) : null;
  const verdict = crewDays != null && runway != null ? paceVerdict(crewDays, runway) : null;

  const { sort, toggleSort } = useTableSort();
  const sortedRollup = useMemo(
    () =>
      applySort(rollup, sort ?? { key: "unfilled", dir: "desc" }, {
        sku: (r: AskRow) => r.sku,
        units: (r: AskRow) => r.units,
        prefilled: (r: AskRow) => r.prefilled,
        unfilled: (r: AskRow) => r.unfilled,
        pct: (r: AskRow) => r.pct,
      }),
    [rollup, sort],
  );

  const proven = rollup.filter((r) => r.unfilled > 0 && (r.proof?.prefilledShipments ?? 0) > 0).slice(0, 5);
  const never = rollup.filter((r) => r.unfilled > 0 && (r.proof?.prefilledShipments ?? 0) === 0).slice(0, 4);
  const maxAskUnfilled = Math.max(...rollup.map((r) => r.unfilled), 1);
  const maxMonthUnits = Math.max(...months.map((m) => m.units), 1);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[88vh] overflow-y-auto">
        <DialogHeader>
          <div className="flex items-center gap-3 flex-wrap pr-6">
            <div>
              <DialogTitle>Pre-filled Rate</DialogTitle>
              <p className="text-xs text-muted-foreground mt-0.5">
                fillable units landed prefilled vs. needing fill at our warehouse
              </p>
            </div>
            <div className="inline-flex rounded-lg border border-border bg-muted/60 p-0.5 ml-2">
              {PREFILL_WINDOWS.map((w) => (
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
              {totals.shipmentCount} shipment{totals.shipmentCount === 1 ? "" : "s"} ·{" "}
              {fmt(totals.units)} units
            </Badge>
          </div>
        </DialogHeader>

        {/* Hero — counts headline every tile, shares ride beneath. */}
        <div className="grid gap-2.5 sm:grid-cols-3">
          <Tile label="Fillable units landed" value={fmt(totals.units)} sub="by arrival date" />
          <Tile
            label="Landed unfilled"
            value={fmt(totals.unfilled)}
            valueClass={UNFILLED_TEXT}
            sub={totals.units > 0 ? `${Math.round((100 * totals.unfilled) / totals.units)}% of landed` : "—"}
          />
          <Tile
            label="Landed prefilled"
            value={fmt(totals.prefilled)}
            sub={totals.units > 0 ? `${Math.round((100 * totals.prefilled) / totals.units)}% of landed` : "—"}
          />
        </div>

        {/* Monthly trend — unit-stacked bars, % as a direct label. */}
        <div>
          <p className="text-xs font-semibold mb-1">Units landed by month</p>
          {months.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">
              No arrivals in this window.
            </p>
          ) : (
            <>
              <div className="flex items-end gap-3.5 h-[190px] px-1">
                {months.map((m) => (
                  <div
                    key={m.month}
                    className="flex-1 flex flex-col items-center justify-end h-full min-w-0"
                    title={`${fmtMonth(m.month)}: ${fmt(m.units)} units — ${fmt(m.prefilled)} prefilled, ${fmt(m.unfilled)} unfilled (${m.pct}%)${m.thin ? " · thin month" : ""}`}
                  >
                    <div
                      className={cn(
                        "text-[11px] font-semibold mb-1 tabular-nums",
                        m.thin ? "text-muted-foreground font-medium" : "",
                      )}
                    >
                      {m.pct}%{m.thin ? "*" : ""}
                    </div>
                    <div className="w-full max-w-[88px] flex flex-col gap-[2px]">
                      {m.prefilled > 0 && (
                        <div
                          className="rounded-t-[3px]"
                          style={{
                            height: Math.max(Math.round((140 * m.prefilled) / maxMonthUnits), 3),
                            backgroundColor: PREFILLED_COLOR,
                          }}
                        />
                      )}
                      {m.unfilled > 0 && (
                        <div
                          className={cn(m.prefilled === 0 && "rounded-t-[3px]", "rounded-b-[3px]")}
                          style={{
                            height: Math.max(Math.round((140 * m.unfilled) / maxMonthUnits), 3),
                            backgroundColor: UNFILLED_COLOR,
                          }}
                        />
                      )}
                    </div>
                    <div className="text-[10.5px] text-muted-foreground mt-1.5 font-mono">
                      {fmtMonth(m.month)}
                    </div>
                  </div>
                ))}
              </div>
              <div className="flex gap-4 flex-wrap text-[11px] text-muted-foreground mt-1 px-1">
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-sm" style={{ background: PREFILLED_COLOR }} />
                  landed prefilled
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-sm" style={{ background: UNFILLED_COLOR }} />
                  landed unfilled
                </span>
                {months.some((m) => m.thin) && (
                  <span>* thin month — too few shipments for a confident rate</span>
                )}
              </div>
            </>
          )}
        </div>

        {/* On the water — window-exempt, always current. */}
        <div className="rounded-lg border border-primary/25 bg-primary/5 px-3.5 py-3">
          <div className="flex items-baseline gap-2">
            <span className="text-xs font-semibold text-primary inline-flex items-center gap-1.5">
              <Ship className="h-3.5 w-3.5" /> On the water right now
            </span>
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
              always current
            </span>
          </div>
          <div className="grid gap-2.5 sm:grid-cols-3 mt-2">
            <Tile label="Fillable units in transit" value={fmt(inbound.units)} sub={`${inbound.shipments} shipments`} />
            <Tile
              label="Will need filling"
              value={fmt(inbound.unfilled)}
              valueClass={UNFILLED_TEXT}
              sub={`${fmt(inbound.prefilled)} landing prefilled`}
            />
            {crewDays != null ? (
              <Tile
                label="Fill work inbound"
                value={`≈ ${crewDays}`}
                unit="crew-days"
                sub={`at recent pace · ~${pace?.unitsPerActiveDay} units/active day`}
              />
            ) : (
              <Tile
                label="Fill work inbound"
                value={fmt(inbound.unfilled)}
                unit="units"
                sub="crew-day estimate needs 10+ recent fill days"
              />
            )}
          </div>
          {inbound.unfilled > 0 && (
            <>
              <div
                className="flex h-[22px] rounded-md overflow-hidden gap-[2px] mt-2.5"
                title="Unfilled units by expected arrival"
              >
                {inbound.buckets.map((b, i) =>
                  b > 0 ? (
                    <div
                      key={i}
                      className="flex items-center justify-center text-[10.5px] font-semibold text-white min-w-0"
                      style={{ flex: b, backgroundColor: BUCKET_COLORS[i] }}
                      title={`${BUCKET_LABELS[i]}: ${fmt(b)} unfilled units`}
                    >
                      {b / inbound.unfilled > 0.15 ? fmt(b) : ""}
                    </div>
                  ) : null,
                )}
              </div>
              <div className="flex gap-3.5 flex-wrap text-[10.5px] text-muted-foreground mt-1.5">
                {inbound.buckets.map((b, i) => (
                  <span key={i} className="inline-flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-sm" style={{ background: BUCKET_COLORS[i] }} />
                    {BUCKET_LABELS[i]} · {fmt(b)}
                  </span>
                ))}
              </div>
              {crewDays != null && runway != null && (
                <p className="text-[11.5px] text-muted-foreground mt-2">
                  ≈{crewDays} crew-days landing over the next ~{runway} working days —{" "}
                  <span className="font-semibold text-foreground">
                    {verdict === "room" && "the fill line has room to spare"}
                    {verdict === "par" && "the fill line runs at par"}
                    {verdict === "over" && "more than the fill line clears at recent pace"}
                    {inbound.lastEta && ` through ${format(parseISO(inbound.lastEta), "MMM d")}`}.
                  </span>
                </p>
              )}
            </>
          )}
        </div>

        {/* Per-SKU table — resting sort echoes the ask ranking. */}
        <div className="rounded-lg border border-border overflow-hidden">
          <div className="max-h-52 overflow-y-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-[9.5px] uppercase tracking-wider text-muted-foreground">
                  <SortableTh sortKey="sku" sort={sort} onToggle={toggleSort} className="sticky top-0 bg-muted/80 backdrop-blur px-3 py-2">SKU</SortableTh>
                  <SortableTh sortKey="units" sort={sort} onToggle={toggleSort} className="sticky top-0 bg-muted/80 backdrop-blur px-3 py-2 text-right">Landed</SortableTh>
                  <SortableTh sortKey="prefilled" sort={sort} onToggle={toggleSort} className="sticky top-0 bg-muted/80 backdrop-blur px-3 py-2 text-right">Prefilled</SortableTh>
                  <SortableTh sortKey="unfilled" sort={sort} onToggle={toggleSort} className="sticky top-0 bg-muted/80 backdrop-blur px-3 py-2 text-right">Unfilled</SortableTh>
                  <SortableTh sortKey="pct" sort={sort} onToggle={toggleSort} className="sticky top-0 bg-muted/80 backdrop-blur px-3 py-2 text-right">% prefilled</SortableTh>
                  <th className="sticky top-0 bg-muted/80 backdrop-blur px-3 py-2 text-right">Shipments</th>
                  <th className="sticky top-0 bg-muted/80 backdrop-blur px-3 py-2 text-right">Last shipped</th>
                </tr>
              </thead>
              <tbody>
                {sortedRollup.map((r) => (
                  <tr key={r.sku} className="border-t border-border/60">
                    <td className="px-3 py-1.5">
                      <span className="font-mono">{r.sku}</span>
                      <span className="ml-1.5 text-muted-foreground/70 hidden sm:inline">{r.name}</span>
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono tabular-nums">{fmt(r.units)}</td>
                    <td className="px-3 py-1.5 text-right font-mono tabular-nums text-muted-foreground">{fmt(r.prefilled)}</td>
                    <td className={cn("px-3 py-1.5 text-right font-mono tabular-nums", r.unfilled > 0 && UNFILLED_TEXT)}>
                      {fmt(r.unfilled)}
                    </td>
                    <td className="px-3 py-1.5">
                      <div className="flex items-center gap-2 justify-end">
                        <div className="w-[54px] h-[5px] rounded bg-muted overflow-hidden">
                          <div
                            className="h-full"
                            style={{
                              width: `${r.pct}%`,
                              // Muted fill on single-shipment SKUs — one
                              // shipment isn't a rate, it's an anecdote.
                              backgroundColor: r.shipmentsInWindow < 2 ? "#4a5560" : PREFILLED_COLOR,
                            }}
                          />
                        </div>
                        <span className="font-mono tabular-nums w-[34px] text-right">{r.pct}%</span>
                      </div>
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono tabular-nums text-muted-foreground">
                      {r.shipmentsInWindow}
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono tabular-nums text-muted-foreground">
                      {r.proof?.lastShipDate ? format(parseISO(r.proof.lastShipDate), "M/d") : "—"}
                    </td>
                  </tr>
                ))}
                {sortedRollup.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-3 py-6 text-center text-muted-foreground">
                      No fillable arrivals in this window.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Ask list — deliberately last: a monthly negotiation tool, not a
            daily read (owner decision, proposal v3). */}
        {(proven.length > 0 || never.length > 0) && (
          <div>
            <p className="text-xs font-semibold mb-1.5">
              Who should we ask to pre-fill?{" "}
              <span className="font-normal text-muted-foreground">— unfilled units in window</span>
            </p>
            <div className="space-y-1.5">
              {proven.map((r) => (
                <AskBar key={r.sku} row={r} max={maxAskUnfilled} proven />
              ))}
              {never.length > 0 && (
                <>
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground pt-2 pb-0.5 border-b border-dashed border-border">
                    never pre-filled — verify with factory first
                  </div>
                  {never.map((r) => (
                    <AskBar key={r.sku} row={r} max={maxAskUnfilled} />
                  ))}
                </>
              )}
            </div>
          </div>
        )}

        <p className="text-[10.5px] text-muted-foreground/80">
          Figures use arrival dates. Pre-fill split recorded per fillable line; lines without a
          split are excluded. Data begins May 2026.
        </p>
      </DialogContent>
    </Dialog>
  );
}

function Tile({
  label,
  value,
  unit,
  sub,
  valueClass,
}: {
  label: string;
  value: string;
  unit?: string;
  sub: string;
  valueClass?: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-card px-3.5 py-3 min-w-0">
      <div className="text-[10px] uppercase tracking-widest text-muted-foreground">{label}</div>
      <div className={cn("text-2xl font-semibold mt-0.5 leading-tight tabular-nums", valueClass)}>
        {value}
        {unit && <span className="text-sm text-muted-foreground font-medium"> {unit}</span>}
      </div>
      <div className="text-[11px] text-muted-foreground mt-1 leading-snug">{sub}</div>
    </div>
  );
}

function AskBar({ row, max, proven }: { row: AskRow; max: number; proven?: boolean }) {
  return (
    <div className="grid grid-cols-[118px_1fr_auto] gap-2.5 items-center text-xs">
      <span className="font-mono text-[11.5px] text-right truncate" title={`${row.sku} — ${row.name}`}>
        {row.sku}
      </span>
      <div>
        <div
          className="h-4 rounded-[3px] relative min-w-[2px]"
          style={{ width: `${Math.max(3, Math.round((100 * row.unfilled) / max))}%`, backgroundColor: UNFILLED_COLOR }}
        >
          <span className="absolute left-1.5 top-1/2 -translate-y-1/2 text-[10px] font-semibold text-white">
            {fmt(row.unfilled)}
          </span>
        </div>
      </div>
      <span className="flex gap-1.5 items-center whitespace-nowrap">
        <Badge variant="outline" className="text-[10px] py-0 text-muted-foreground">
          {row.pct}% prefilled
        </Badge>
        <Badge
          variant="outline"
          className={cn(
            "text-[10px] py-0",
            proven ? "border-primary/50 text-primary" : "text-muted-foreground",
          )}
        >
          {proven
            ? `Proven — ${row.proof?.prefilledShipments} of ${row.proof?.shipments} shipments`
            : `0 of ${row.proof?.shipments ?? "?"} shipments`}
        </Badge>
      </span>
    </div>
  );
}

const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function fmtMonth(m: string): string {
  // Label from the month string directly — parseISO+format would shift
  // across timezones for the "-01" day.
  return `${MONTH_LABELS[+m.slice(5, 7) - 1]} '${m.slice(2, 4)}`;
}
