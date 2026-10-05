/**
 * Launches page — a launch's products, expanded under its row, as a supply
 * ledger. One summary row per product (launchProducts): the coverage bar,
 * units in the building by the first selling day against the basis, the
 * all-in date and one verdict. A click opens the product's dated supply list
 * (ledgerLines: stock first, then every delivery in arrival order with a
 * running total, the milestone bands, the remainder) or its chart. A card
 * row still without a SKU reads its development state instead (stage chip,
 * next deadline, risk dot). Every ledger starts closed. The components hold
 * no math: every number and word comes from launch-supply.
 */
import { Fragment, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronDown, ChevronRight, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ModeTile } from "@/components/shared/ModeTile";
import { MiniStepper } from "@/components/freight/ShipmentStepper";
import { cn } from "@/lib/utils";
import { followsLaunch, isArrived, pdStageLabel, type MemberState } from "@/lib/marketing/launch-link";
import {
  LAUNCH_SUPPLY_LABEL,
  airAltText,
  allInText,
  arrivesText,
  bandText,
  coverageText,
  driftText,
  factorySubText,
  fmtUnits,
  ledgerLines,
  pastDueText,
  prefilledText,
  referenceHref,
  referenceLabel,
  referenceText,
  slackDays,
  slackText,
  warehouseSplitParts,
  type LaunchProduct,
  type LaunchSupplyLaunch,
  type MilestoneBand,
  type SupplyLedger,
  type SupplyRow,
  type Tone,
  type Verdict,
} from "@/lib/marketing/launch-supply";
import type { MktLaunchCard } from "@/lib/hooks";
import { fmtDay, relDays } from "./launch-format";
import { CoverageBar } from "./CoverageBar";
import { LaunchSupplyChart } from "./LaunchSupplyChart";
import { OwnDateChip, RiskDotMark, StageChip, VerdictMark } from "./LaunchLinkParts";

interface Props {
  launch: LaunchSupplyLaunch;
  /** launchProducts(...) for this launch — the same array the collapsed row's rollup read. */
  products: readonly LaunchProduct<MktLaunchCard>[];
  todayIso: string;
  canEdit: boolean;
  onAddProducts: () => void;
}

type View = "table" | "chart";
const VIEWS: readonly View[] = ["table", "chart"];
const VIEW_LABEL: Record<View, string> = { table: "Table", chart: "Chart" };

const PRODUCT_GRID = "grid grid-cols-[minmax(0,1fr)_230px_104px_104px_124px] items-center gap-x-3.5 px-4";
const LEDGER_GRID = "grid grid-cols-[116px_208px_minmax(0,1fr)_66px_80px_92px_112px] items-center gap-x-3 pl-10 pr-4";
const LEDGER_ROW = `${LEDGER_GRID} min-h-[34px] border-t border-border/40 py-[5px] text-[13px] tabular-nums`;

const TONE_TEXT: Record<Tone, string> = { g: "text-green-400", a: "text-amber-400", r: "text-red-400" };

const NONE = <span className="text-muted-foreground/60">—</span>;

export function LaunchSupplyTable({ launch, products, todayIso, canEdit, onAddProducts }: Props) {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const [views, setViews] = useState<ReadonlyMap<string, View>>(() => new Map());
  const hasEa = !!launch.early_access_date;

  function toggle(key: string) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <div className="overflow-hidden rounded-lg border border-border/60">
      {products.length > 0 && (
        <div className={`${PRODUCT_GRID} h-[30px] border-b border-border/60 bg-muted/30 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground`}>
          <span>Product</span>
          <span>Coverage</span>
          <span className="text-right">{hasEa ? "By EA" : "By launch"}</span>
          <span className="text-right">All in</span>
          <span>Status</span>
        </div>
      )}
      {products.map((p) => {
        const isOpen = !!p.ledger && open.has(p.key);
        const view = views.get(p.key) ?? "table";
        return (
          <Fragment key={p.key}>
            <ProductRow product={p} isOpen={isOpen} onToggle={p.ledger ? () => toggle(p.key) : null} />
            {isOpen && p.ledger && (
              <div className="border-b border-border/40 bg-background/40">
                <div className="flex justify-end px-4 pt-1.5">
                  <ViewToggle value={view} onChange={(v) => setViews((prev) => new Map(prev).set(p.key, v))} />
                </div>
                {view === "table" ? (
                  <Ledger ledger={p.ledger} hasEa={hasEa} todayIso={todayIso} />
                ) : (
                  <div className="pb-2.5 pl-10 pr-4 pt-1.5">
                    <LaunchSupplyChart ledger={p.ledger} launch={launch} todayIso={todayIso} />
                  </div>
                )}
              </div>
            )}
          </Fragment>
        );
      })}
      {canEdit && (
        <div className="flex justify-end px-3 py-2">
          <Button variant="outline" size="sm" className="h-7" onClick={onAddProducts}>
            <Plus className="mr-1.5 h-3.5 w-3.5" /> Add products
          </Button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Product summary row
// ---------------------------------------------------------------------------

function ProductRow({ product: p, isOpen, onToggle }: { product: LaunchProduct<MktLaunchCard>; isOpen: boolean; onToggle: (() => void) | null }) {
  const { ledger, card, development } = p;
  // A card still being developed shows its stage; ordered and arrived cards read through the ledger alone.
  const stage = card && !isArrived(card) && card.stage !== "ordered" ? pdStageLabel(card.stage) : null;
  const cells = (
    <>
      <span className="flex min-w-0 items-center gap-2 whitespace-nowrap">
        {onToggle ? (
          isOpen ? <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
        ) : (
          <span className="w-3 shrink-0" />
        )}
        {p.sku && <span className="shrink-0 font-mono text-xs">{p.sku}</span>}
        <span className={cn("min-w-0 truncate", p.sku ? "text-[13px] text-muted-foreground" : "font-medium")} title={p.name}>
          {p.name}
        </span>
        {stage && <StageChip label={stage} />}
        {stage && card && !followsLaunch(card) && <OwnDateChip date={card.target_launch_date} />}
      </span>
      <span>{ledger ? <CoverageBar ledger={ledger} /> : NONE}</span>
      <span className={cn("text-right", ledger?.sellStart && ledger.bySell < ledger.basis && "text-red-400")}>
        {ledger?.sellStart ? coverageText(ledger) : NONE}
      </span>
      <span className={cn("text-right", ledger?.allIn?.kind === "date" && ledger.allIn.estimated && "text-muted-foreground")}>
        {ledger ? allInText(ledger.allIn) : NONE}
      </span>
      <span>{ledger ? <VerdictCell verdict={ledger.verdict} /> : development ? <DevelopmentCell state={development} /> : NONE}</span>
    </>
  );
  const cls = `${PRODUCT_GRID} h-[42px] border-b border-border/40 text-sm tabular-nums`;
  if (!onToggle) return <div className={cls}>{cells}</div>;
  return (
    <button type="button" onClick={onToggle} aria-expanded={isOpen} className={`${cls} w-full text-left hover:bg-muted/20`}>
      {cells}
    </button>
  );
}

function VerdictCell({ verdict }: { verdict: Verdict | null }) {
  if (!verdict) return NONE;
  return (
    <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap text-[12.5px] font-semibold", TONE_TEXT[verdict.tone])}>
      <VerdictMark tone={verdict.tone} />
      {verdict.text}
    </span>
  );
}

/** A development row's status: the risk dot and its next deadline ("Order by Oct 10" over "in 5d"); an arrived card the day it landed. */
function DevelopmentCell({ state }: { state: MemberState }) {
  if (state.kind === "halted" || state.kind === "plain" || !state.date) return NONE;
  return (
    <span className="flex items-center gap-1.5 whitespace-nowrap text-xs">
      <RiskDotMark dot={state.risk} />
      <span className="flex flex-col">
        <span>
          {state.date.label} {fmtDay(state.date.value)}
        </span>
        {state.kind !== "arrived" && <span className="text-[10px] text-muted-foreground">{relDays(state.date.days)}</span>}
      </span>
    </span>
  );
}

function ViewToggle({ value, onChange }: { value: View; onChange: (v: View) => void }) {
  return (
    <span className="inline-flex overflow-hidden rounded border border-border/60 text-[11px]">
      {VIEWS.map((v, i) => (
        <button
          key={v}
          type="button"
          aria-pressed={value === v}
          onClick={() => onChange(v)}
          className={cn(
            "h-[22px] px-2.5",
            i > 0 && "border-l border-border/60",
            value === v ? "bg-muted/60 text-foreground" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {VIEW_LABEL[v]}
        </button>
      ))}
    </span>
  );
}

// ---------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------

function Ledger({ ledger, hasEa, todayIso }: { ledger: SupplyLedger; hasEa: boolean; todayIso: string }) {
  return (
    <div className="pb-1.5">
      <div className={`${LEDGER_GRID} h-7 text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground/70`}>
        <span>Arrives</span>
        <span>Where</span>
        <span>Reference</span>
        <span className="text-right">Units</span>
        <span className="text-right">Cartons</span>
        <span className="text-right">Total by then</span>
        <span className="text-right">{hasEa ? "vs EA" : "vs Launch"}</span>
      </div>
      {ledgerLines(ledger, todayIso).map((line) =>
        line.kind === "row" ? (
          <LedgerRow key={line.row.key} row={line.row} sellStart={ledger.sellStart} todayIso={todayIso} />
        ) : line.kind === "band" ? (
          <BandLine key={`band:${line.band.key}`} band={line.band} />
        ) : (
          <RemainderLine key="remainder" units={line.units} />
        ),
      )}
    </div>
  );
}

function LedgerRow({ row, sellStart, todayIso }: { row: SupplyRow; sellStart: string | null; todayIso: string }) {
  const drift = driftText(row);
  const air = airAltText(row);
  const slack = slackDays(row, sellStart);
  const pastDue = pastDueText(row);
  const overdue = row.kind === "freight" && row.overdueDays > 0;
  return (
    <div className={LEDGER_ROW}>
      <span className={cn("whitespace-nowrap", row.estimated && "text-muted-foreground", overdue && "text-amber-400")}>
        {arrivesText(row, todayIso)}
        {drift && (
          <span className={cn("ml-1.5 rounded px-1 text-[10.5px]", drift.startsWith("+") ? "bg-amber-400/10 text-amber-400" : "text-muted-foreground")}>
            {drift}
          </span>
        )}
        {air && <span className="block text-[11.5px] text-muted-foreground/70">{air}</span>}
      </span>
      <span className="flex min-w-0 items-center gap-2 whitespace-nowrap">
        <ModeTile mode={row.mode} size="sm" />
        <span>{row.whereLabel}</span>
        {row.kind === "freight" && <MiniStepper shipment={row.shipment} />}
      </span>
      <ReferenceCell row={row} />
      <span className="text-right">{fmtUnits(row.units)}</span>
      <span className="text-right">{row.cartons == null ? NONE : fmtUnits(row.cartons)}</span>
      <span className="text-right">{fmtUnits(row.runningTotal)}</span>
      <span className="whitespace-nowrap text-right text-[12.5px]">
        {slack != null && slack > 0 ? (
          <span className="inline-flex items-center gap-1 text-red-400">
            <VerdictMark tone="r" />
            {slackText(slack)}
          </span>
        ) : (
          <span className="text-muted-foreground">{slackText(slack)}</span>
        )}
        {pastDue && <span className="block text-[11px] text-red-400">{pastDue}</span>}
      </span>
    </div>
  );
}

/** The warehouse split ("Finished 18 · WIP 48 · Raw 234"), a shipment link with its carrier and pre-filled tag, or a factory order link over its ordered / shipped line. */
function ReferenceCell({ row }: { row: SupplyRow }) {
  const title = referenceText(row);
  if (row.kind === "warehouse") {
    const parts = warehouseSplitParts(row.split);
    return (
      <span className="min-w-0 truncate whitespace-nowrap" title={title}>
        {parts.length === 0
          ? NONE
          : parts.map((part, i) => (
              <Fragment key={part.label}>
                {i > 0 && <span className="text-muted-foreground/60"> · </span>}
                {part.label} <span className="font-semibold">{fmtUnits(part.units)}</span>
              </Fragment>
            ))}
      </span>
    );
  }
  const link = (
    <Link to={referenceHref(row)!} onClick={(e) => e.stopPropagation()} className="hover:underline">
      {referenceLabel(row)}
    </Link>
  );
  if (row.kind === "factory") {
    return (
      <span className="min-w-0 whitespace-nowrap" title={title}>
        <span className="block truncate">{link}</span>
        <span className="block truncate text-[11.5px] text-muted-foreground">{factorySubText(row)}</span>
      </span>
    );
  }
  const prefilled = prefilledText(row);
  return (
    <span className="min-w-0 truncate whitespace-nowrap" title={title}>
      {link}
      {row.shipment.carrier_name && <span className="text-muted-foreground"> · {row.shipment.carrier_name}</span>}
      {prefilled && (
        <span className="ml-1.5 rounded border border-cyan-400/40 px-1 text-[9.5px] font-bold tracking-wider text-cyan-400">{prefilled}</span>
      )}
    </span>
  );
}

/** "Ready by Oct 20 … 2 of 300": the goal reads amber when short, the selling days red. */
function BandLine({ band }: { band: MilestoneBand }) {
  const { label, count } = bandText(band);
  return (
    <div className="flex h-[26px] items-center gap-2.5 border-t border-border/60 bg-muted/30 pl-10 pr-4 text-xs tabular-nums">
      <span className={cn("whitespace-nowrap font-semibold", band.key === "ea" && "text-violet-400")}>{label}</span>
      <span className={cn("ml-auto whitespace-nowrap", band.tone === "a" && "font-semibold text-amber-400", band.tone === "r" && "font-semibold text-red-400")}>
        {count}
      </span>
    </div>
  );
}

function RemainderLine({ units }: { units: number }) {
  return (
    <div className={LEDGER_ROW}>
      <span className="whitespace-nowrap italic text-red-400">{LAUNCH_SUPPLY_LABEL.remainder}</span>
      <span />
      <span />
      <span className="text-right italic text-red-400">{fmtUnits(units)}</span>
      <span />
      <span />
      <span />
    </div>
  );
}
