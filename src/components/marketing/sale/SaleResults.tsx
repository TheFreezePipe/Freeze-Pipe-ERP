/**
 * Sale results — one module stack for every phase, rendered from one
 * SaleMetrics object: Scorecard · Offers · Daily chart · Daily · Products ·
 * Margin · Customers · Sends · Recorded. The phase only changes the fill.
 *
 * The control bar's Range drives the chart and the Daily table only; the
 * sale-level modules carry a "to date" suffix while live. Compare switches
 * every Δ between the frozen baseline and the plan.
 */
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { RefreshCw } from "lucide-react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useSaleMetrics, useSetSaleSetting } from "@/lib/hooks/use-sale-metrics";
import { F } from "@/lib/marketing/sale-format";
import { MODULES, PACE, PHASE, RESULT, type CompareKey, type ViewKey } from "@/lib/marketing/sale-labels";
import { toast } from "@/hooks/use-toast";
import { describeError } from "@/lib/supabase-error";
import { Chip, ChipFrom, StatusMark } from "./sale-ui";
import { RANGE_PRESETS, rangeLabel, toggleIn, type RangeState, type SaleViewState } from "./sale-view";
import { SaleScorecard } from "./SaleScorecard";
import { OffersTable } from "./OffersTable";
import { DailyChart } from "./DailyChart";
import { DailyTable } from "./DailyTable";
import { ProductsTable } from "./ProductsTable";
import { MarginWaterfall } from "./MarginWaterfall";
import { CustomersTiles } from "./CustomersTiles";
import { SendsTable } from "./SendsTable";
import { RecordedStrip } from "./RecordedStrip";
import { RANGE } from "@/lib/marketing/sale-labels";

interface Props {
  saleId: string;
  canEdit: boolean;
}

export function SaleResults({ saleId, canEdit }: Props) {
  const { metrics: M, isLoading, isError, error, refetch, isFetching } = useSaleMetrics(saleId);
  const setSetting = useSetSaleSetting();
  const [params, setParams] = useSearchParams();

  const [st, setSt] = useState<SaleViewState>(() => ({
    range: (RANGE_PRESETS as string[]).includes(params.get("range") ?? "") ? (params.get("range") as RangeState) : "full",
    compare: (["baseline", "plan", "none"] as string[]).includes(params.get("compare") ?? "") ? (params.get("compare") as CompareKey) : "baseline",
    view: (["units", "orders", "cum"] as string[]).includes(params.get("view") ?? "") ? (params.get("view") as ViewKey) : "units",
    open: new Set<string>(),
    sort: ["share", "desc"],
  }));
  const [hoverDay, setHoverDay] = useState<string | null>(null);
  const [highlightSend, setHighlightSend] = useState<string | null>(null);

  // Default compare: plan while live or upcoming, baseline when ended (set once the phase is known).
  const [compareSet, setCompareSet] = useState(params.has("compare"));
  useEffect(() => {
    if (!M || compareSet) return;
    setSt((s) => ({ ...s, compare: M.live || M.upcoming ? "plan" : "baseline" }));
    setCompareSet(true);
  }, [M, compareSet]);

  useEffect(() => {
    const next = new URLSearchParams(params);
    if (typeof st.range === "string" && st.range !== "full") next.set("range", st.range); else next.delete("range");
    if (st.compare !== "baseline") next.set("compare", st.compare); else next.delete("compare");
    if (st.view !== "units") next.set("view", st.view); else next.delete("view");
    if (next.toString() !== params.toString()) setParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [st.range, st.compare, st.view]);

  const onToggle = (id: string) => setSt((s) => ({ ...s, open: toggleIn(s.open, id) }));
  const onSort = (k: string) => setSt((s) => ({ ...s, sort: s.sort[0] === k ? [k, s.sort[1] === "desc" ? "asc" : "desc"] : [k, k === "sku" ? "asc" : "desc"] }));
  const jump = (id: string) => document.getElementById("m-" + id)?.scrollIntoView({ behavior: "smooth", block: "start" });

  const onSetSetting = (key: "plan_orders" | "season_index", value: unknown) => {
    setSetting.mutate({ saleId, key, value }, {
      onError: (e) => toast({ title: "Couldn't save", description: describeError(e), variant: "destructive" }),
    });
  };

  const header = useMemo(() => {
    if (!M) return null;
    const S = M.input.sale;
    const ph = PHASE[M.phase];
    const dayN = M.phase === "live"
      ? " · Day " + (M.G.main.rows.findIndex((d) => d.k === M.asOf) + 1) + " of " + M.G.main.total
      : M.phase === "early_access"
        ? " · Day " + (M.G.ea.rows.findIndex((d) => d.k === M.asOf) + 1) + " of " + M.G.ea.total
        : "";
    return (
      <div className="flex flex-wrap items-center gap-2">
        <ChipFrom def={ph} suffix={dayN} />
        {M.status.result ? <ChipFrom def={RESULT[M.status.result]} /> : M.status.pace ? <ChipFrom def={PACE[M.status.pace]} /> : null}
        <span className="text-xs text-muted-foreground">
          {F.range(S.d1, S.end)}{S.ea ? " · early access " + F.md(S.ea) : ""} · {M.input.stores.map((s) => s.name).join(", ")}
        </span>
        {M.lastRun ? (
          <span className="ml-auto text-xs text-muted-foreground">
            {M.lastRun.comparable ? <>Last run <b className="text-foreground">{M.lastRun.name}</b></> : <Chip tone="k" label={"Last run · " + M.lastRun.name} tip={M.lastRun.note} />}
          </span>
        ) : null}
      </div>
    );
  }, [M]);

  if (isError) {
    return (
      <div className="rounded-lg border border-red-500/40 bg-card p-4 text-sm">
        <p className="font-semibold text-red-400">Results could not load</p>
        <p className="mt-1 text-muted-foreground">{describeError(error)}</p>
        <Button size="sm" variant="outline" className="mt-3" onClick={() => void refetch()}>Retry</Button>
      </div>
    );
  }
  if (!M) {
    return <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">{isLoading ? "Loading results…" : "No results."}</div>;
  }

  const loading = false;
  const alerts = M.alerts;
  const asOfRight = M.upcoming
    ? "Opens " + F.md(M.input.sale.d1) + " · Plan " + (M.planSource === "planner" ? "Planner" : "Derived")
    : M.live
      ? "As of " + M.asOfTime + " ET · synced " + (M.syncedAt ? F.timeET(M.syncedAt) : "—")
      : M.phase === "ended"
        ? "Through " + F.md(M.input.sale.end) + " · provisional to " + F.md(M.input.sale.final_on)
        : "Final · " + F.md(M.input.sale.final_on);

  return (
    <TooltipProvider>
      <div className="space-y-3">
        {header}

        {/* Control bar */}
        <div className="sticky top-0 z-20 -mx-1 flex h-10 items-center justify-between gap-3 border-y border-border/60 bg-background/95 px-1 backdrop-blur">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="h-7 text-xs">Jump to ▾</Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {MODULES.map(([id, label]) => (
                <DropdownMenuItem key={id} onSelect={() => jump(id === "daily" ? "daily" : id)} className="text-xs">{label}</DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <div className="flex items-center gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="h-7 text-xs">{rangeLabel(st.range)} ▾</Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="center">
                {RANGE_PRESETS.map((p) => (
                  <DropdownMenuItem key={p} onSelect={() => setSt((s) => ({ ...s, range: p }))} className={"text-xs " + (st.range === p ? "font-semibold" : "")}>{RANGE[p]}</DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              Compare
              <select
                value={st.compare}
                onChange={(e) => setSt((s) => ({ ...s, compare: e.target.value as CompareKey }))}
                className="h-7 rounded border border-border/60 bg-background px-1.5 text-xs text-foreground"
              >
                <option value="baseline">Baseline</option>
                <option value="plan">Plan</option>
                <option value="none">None</option>
              </select>
            </label>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            {M.live ? (
              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => void refetch()} disabled={isFetching} aria-label="Refresh">
                <RefreshCw className={"h-3.5 w-3.5 " + (isFetching ? "animate-spin" : "")} />
              </Button>
            ) : null}
          </div>
        </div>

        {/* Status strip */}
        <div className="flex min-h-8 items-center justify-between gap-3 rounded border border-border/60 bg-background/40 px-3 py-1 text-xs">
          <div className="flex flex-wrap items-center gap-1.5">
            {alerts.length === 0 ? (
              <Chip tone="k" mark="ring" label="No alerts" />
            ) : (
              alerts.map((a) => <Chip key={a.code + a.title} tone={a.tone} mark={a.tone === "k" ? "ring" : "tri"} label={a.title} tip={a.detail + (a.source ? " · " + a.source : "")} />)
            )}
          </div>
          <div className="whitespace-nowrap text-muted-foreground">
            {asOfRight}
            {M.live && M.unresolved > 0 ? <span className="ml-2"><StatusMark mark="ring" /> {M.unresolved} orders waiting on a SKU</span> : null}
          </div>
        </div>

        <SaleScorecard M={M} loading={loading} canEdit={canEdit} onSetSetting={onSetSetting} pending={setSetting.isPending} />
        <OffersTable M={M} loading={loading} open={st.open} onToggle={onToggle} />
        <DailyChart
          M={M}
          loading={loading}
          range={st.range}
          compare={st.compare}
          view={st.view}
          onView={(v) => setSt((s) => ({ ...s, view: v }))}
          hoverDay={hoverDay}
          onHover={setHoverDay}
          onSendClick={(id) => { setHighlightSend(id); document.getElementById("send-" + id)?.scrollIntoView({ behavior: "smooth", block: "center" }); }}
        />
        <DailyTable M={M} loading={loading} range={st.range} compare={st.compare} open={st.open} onToggle={onToggle} hoverDay={hoverDay} onHover={setHoverDay} />
        <ProductsTable M={M} loading={loading} open={st.open} onToggle={onToggle} sort={st.sort} onSort={onSort} />
        <MarginWaterfall M={M} loading={loading} />
        <CustomersTiles M={M} loading={loading} />
        <SendsTable M={M} loading={loading} highlight={highlightSend} />
        <RecordedStrip M={M} />
      </div>
    </TooltipProvider>
  );
}
