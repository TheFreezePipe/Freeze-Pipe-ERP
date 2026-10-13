import { useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { F } from "@/lib/marketing/sale-format";
import { COLUMN_DEF, PACE, PLAN_RESULT } from "@/lib/marketing/sale-labels";
import type { SaleMetrics, ScorecardRow } from "@/lib/marketing/sale-metrics";
import { Chip, ModuleCard, Pin, Skeleton, Th } from "./sale-ui";
import { NONE, TD, colgroup } from "./sale-tokens";

interface Props {
  M: SaleMetrics;
  loading?: boolean;
  canEdit: boolean;
  onSetSetting: (key: "plan_orders" | "season_index", value: unknown) => void;
  pending?: boolean;
}

/**
 * Scorecard: five rows of Actual · Δ Plan · Δ Base · Reference. The three
 * header chips are the recorded settings (baseline window, season index,
 * plan source); each opens its rule and, for admins, its control.
 */
export function SaleScorecard({ M, loading, canEdit, onSetSetting, pending }: Props) {
  const S = M.input.sale;
  const td = M.live ? " to date" : "";
  const hidePlanPin = M.status.pace === "reading" || M.status.pace === "ea" || M.upcoming;

  const row = (r: ScorecardRow) => {
    const fmt = r.money ? F.money : F.int;
    return (
      <tr key={r.key} className="border-t border-border/40">
        <td className={TD}><b className="font-semibold">{r.label}</b></td>
        <td className={TD + " text-right text-[15px] font-bold tabular-nums"}>
          {r.pending ? <span className="text-sm font-normal text-muted-foreground">pending</span> : r.actual == null ? NONE : fmt(r.actual)}
        </td>
        <td className={TD + " text-right"}>{r.plan == null || hidePlanPin ? NONE : <Pin j={r.planD} />}</td>
        <td className={TD + " text-right"}>{r.base.delta == null ? NONE : <Pin j={r.base} />}</td>
        <td className={TD + " truncate text-xs text-muted-foreground"}>{r.note.filter(Boolean).join(" · ")}</td>
      </tr>
    );
  };

  const words = [
    <>Lift <b>{M.status.liftBand ?? "—"}</b></>,
    <>
      Plan{" "}
      <b>
        {M.upcoming
          ? F.int(M.planOrders) + " orders"
          : M.live
            ? PACE[M.status.pace ?? "reading"][0]
            : M.status.planResult
              ? PLAN_RESULT[M.status.planResult][0] + " " + F.signed(M.scorecard.orders.planD.delta) + " orders"
              : "—"}
      </b>
    </>,
    <>
      Margin{" "}
      <b className={M.scorecard.margin.actual == null ? "" : M.margin.net >= 0 ? "!text-green-400" : "!text-red-400"}>
        {M.scorecard.margin.actual == null ? "—" : M.margin.net >= 0 ? "Positive" : "Negative"}
      </b>
      {M.live ? <span className="text-muted-foreground"> to date</span> : null}
      <span className="text-muted-foreground"> · modeled at list</span>
    </>,
  ];

  return (
    <ModuleCard
      id="scorecard"
      title={"Scorecard" + td}
      right={
        <>
          <Chip
            tone={M.base.short ? "a" : "k"}
            label={"Baseline " + (M.upcoming ? "preview · " : "") + M.base.days + " clean days"}
            tip={M.base.from && M.base.to ? F.md(M.base.from) + " – " + F.md(M.base.to) + (M.base.frozen ? " · frozen" : " · recomputes until the sale opens") : "no clean days"}
          />
          <SeasonChip M={M} canEdit={canEdit} onSet={(v) => onSetSetting("season_index", v)} pending={pending} />
          <PlanChip M={M} canEdit={canEdit} onSet={(v) => onSetSetting("plan_orders", v)} pending={pending} />
          {S.ea ? null : <Chip tone="k" label="No early access" />}
        </>
      }
      strip={words}
    >
      {loading ? (
        <Skeleton h={196} rows={5} />
      ) : (
        <table className="w-full table-fixed text-[13px]">
          {colgroup([220, 120, 96, 96, "auto"])}
          <thead>
            <tr>
              <Th>Metric</Th>
              <Th right>Actual</Th>
              <Th right tip={COLUMN_DEF["Δ Plan"]}>{M.live ? "Δ Plan to date" : "Δ Plan"}</Th>
              <Th right tip={COLUMN_DEF["Δ Base"]}>Δ Base</Th>
              <Th tip={COLUMN_DEF.Reference}>Reference</Th>
            </tr>
          </thead>
          <tbody>{(["margin", "orders", "units", "paid", "new"] as const).map((k) => row(M.scorecard[k]))}</tbody>
        </table>
      )}
    </ModuleCard>
  );
}

function SeasonChip({ M, canEdit, onSet, pending }: { M: SaleMetrics; canEdit: boolean; onSet: (v: number) => void; pending?: boolean }) {
  const [val, setVal] = useState(String(M.season.toFixed(2)));
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className="rounded focus:outline-none focus-visible:ring-1 focus-visible:ring-ring">
          <Chip tone="k" label={"Season ×" + M.season.toFixed(2)} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 space-y-2 text-xs">
        <p className="font-semibold">Season index</p>
        <p className="text-muted-foreground">
          Multiplies the clean-day baseline. ×1.00 compares the sale with the weeks right before it. A higher index
          credits part of the lift to the time of year rather than the promotion.
        </p>
        <div className="flex justify-between border-t border-border/60 pt-2"><span>Applied</span><span className="tabular-nums">×{M.season.toFixed(2)}</span></div>
        <div className="flex justify-between"><span>Units lift at this index</span><span className="tabular-nums">{F.signed(M.G.full.lift.units.delta)}</span></div>
        {canEdit ? (
          <div className="flex items-center gap-2 pt-1">
            <Input value={val} onChange={(e) => setVal(e.target.value)} className="h-7 w-20 text-xs" inputMode="decimal" />
            <Button size="sm" className="h-7" disabled={pending || !(Number(val) > 0)} onClick={() => onSet(Number(val))}>Apply</Button>
            <Button size="sm" variant="outline" className="h-7" disabled={pending} onClick={() => { setVal("1.00"); onSet(1); }}>×1.00</Button>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

function PlanChip({ M, canEdit, onSet, pending }: { M: SaleMetrics; canEdit: boolean; onSet: (v: number | null) => void; pending?: boolean }) {
  const [val, setVal] = useState(M.input.sale.plan_orders ? String(M.input.sale.plan_orders) : "");
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className="rounded focus:outline-none focus-visible:ring-1 focus-visible:ring-ring">
          <Chip tone="k" label={"Plan " + (M.planSource === "planner" ? "Planner" : "Derived")} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 space-y-2 text-xs">
        <p className="font-semibold">Plan</p>
        <p className="text-muted-foreground">
          Expected orders across early access and the public window. Pace reads ±10% of the plan to date. Without a
          typed number the plan is derived from the baseline and the offers' expected uplift.
        </p>
        <div className="flex justify-between border-t border-border/60 pt-2"><span>Plan orders</span><span className="tabular-nums">{F.int(M.planOrders)}{M.planSource === "derived" ? " · derived" : ""}</span></div>
        <div className="flex justify-between"><span>Plan units</span><span className="tabular-nums">{F.int(M.planUnits)}</span></div>
        {canEdit ? (
          <div className="flex items-center gap-2 pt-1">
            <Input value={val} onChange={(e) => setVal(e.target.value)} placeholder="orders" className="h-7 w-24 text-xs" inputMode="numeric" />
            <Button size="sm" className="h-7" disabled={pending || !(Number(val) > 0)} onClick={() => onSet(Math.round(Number(val)))}>Set</Button>
            {M.input.sale.plan_orders ? <Button size="sm" variant="outline" className="h-7" disabled={pending} onClick={() => { setVal(""); onSet(null); }}>Derive</Button> : null}
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
