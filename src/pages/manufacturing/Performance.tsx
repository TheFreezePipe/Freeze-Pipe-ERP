import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { StatCard } from "@/components/shared/StatCard";
import { Package, ListChecks, Boxes, Gauge, Users, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth-context";
import { useTaskLogs } from "@/lib/hooks";
import {
  rangeToSearchParams,
  rangeFromSearchParams,
  rangeLabel,
  type DateRange,
} from "@/lib/performance/date-ranges";
import {
  filterByRange,
  computeKpis,
  bucketByTime,
  summarizeByEmployee,
  summarizeBySku,
} from "@/lib/performance/aggregate";
import { computeLaborHours } from "@/lib/performance/use-labor-hours";
import { DateRangeSelector } from "@/components/manufacturing/DateRangeSelector";
import { TeamPerformanceChart } from "@/components/manufacturing/TeamPerformanceChart";
import { TeamLeaderboard } from "@/components/manufacturing/TeamLeaderboard";
import { SKUInsights } from "@/components/manufacturing/SKUInsights";

/**
 * Performance dashboard for senior leadership + manufacturing managers.
 *
 * Data flow (all derived from a single DateRange):
 *   URL params ──▶ DateRange
 *                  │
 *                  ▼
 *          filterByRange(logs, range)
 *                  │
 *       ┌──────────┼──────────┬──────────┐
 *       ▼          ▼          ▼          ▼
 *      KPIs      Chart   Leaderboard   SKUs
 */
export default function Performance() {
  const [searchParams, setSearchParams] = useSearchParams();
  const range: DateRange = useMemo(() => rangeFromSearchParams(searchParams), [searchParams]);
  // Staff see ONLY their own numbers — no leaderboard, no team scope
  // (owner decision 2026-07-15, superseding the earlier leaderboard-for-
  // everyone call). Leadership keeps the Team/Just-me toggle + leaderboard.
  const { profile, isAdmin, isManager } = useAuth();
  const isLeadership = isAdmin || isManager;
  const [scopeOverride, setScopeOverride] = useState<"team" | "me" | null>(null);
  const scope = isLeadership ? (scopeOverride ?? "team") : "me";
  // Use the hook's default limit (5000) so the entire post-import
  // history is fetched, not a recent slice. The page filters down by
  // DateRange in-memory below; the hook just needs to deliver enough
  // raw rows for that filter to find matches across arbitrary ranges.
  const { data: taskLogs = [] } = useTaskLogs();

  function setRange(next: DateRange) {
    const sp = rangeToSearchParams(next);
    setSearchParams(sp, { replace: false });
  }

  const { kpis, buckets, leaderboard, skus } = useMemo(() => {
    // useTaskLogs returns nested joins (`employee.full_name`,
    // `product.product_name`); the aggregate module expects flat
    // `employee_name` / `sku_name` strings on each row. Flatten here at
    // the page boundary so aggregate.ts stays a pure input-shape module
    // (and the existing test fixtures keep matching). Without this, the
    // leaderboard fell back to displaying employee_id UUIDs.
    const flattened = taskLogs.map((t) => ({
      ...t,
      employee_name: t.employee?.full_name ?? undefined,
      sku_name: t.product?.product_name ?? undefined,
    }));
    const teamFiltered = filterByRange(flattened, range);
    // "Just me" narrows KPIs / chart / SKU breakdown to the signed-in
    // employee; the leaderboard always aggregates the whole team.
    const scoped =
      scope === "me" && profile?.id
        ? teamFiltered.filter((t) => t.employee_id === profile.id)
        : teamFiltered;
    const teamLabor = computeLaborHours(teamFiltered, range);
    const scopedLabor = scoped === teamFiltered ? teamLabor : computeLaborHours(scoped, range);
    return {
      kpis: computeKpis(scoped, scopedLabor),
      buckets: bucketByTime(scoped, range),
      // Leadership-only: staff never see teammates' numbers.
      leaderboard: isLeadership ? summarizeByEmployee(teamFiltered, teamLabor) : [],
      skus: summarizeBySku(scoped),
    };
  }, [taskLogs, range, scope, profile?.id, isLeadership]);

  const label = rangeLabel(range);

  return (
    <div className="space-y-4 md:space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold">Performance</h1>
          <p className="text-muted-foreground">
            {scope === "me" ? "Your output and productivity" : "Team output and productivity metrics"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {isLeadership && (
            <div className="flex overflow-hidden rounded-md border border-border">
              <Button
                variant={scope === "team" ? "secondary" : "ghost"}
                size="sm"
                className="h-9 rounded-none px-3"
                onClick={() => setScopeOverride("team")}
              >
                <Users className="mr-1.5 h-3.5 w-3.5" /> Team
              </Button>
              <Button
                variant={scope === "me" ? "secondary" : "ghost"}
                size="sm"
                className="h-9 rounded-none px-3"
                onClick={() => setScopeOverride("me")}
              >
                <UserRound className="mr-1.5 h-3.5 w-3.5" /> Just me
              </Button>
            </div>
          )}
          <DateRangeSelector value={range} onChange={setRange} />
        </div>
      </div>

      {/* KPI cards */}
      <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
        <StatCard
          title="Units Completed"
          value={kpis.unitsCompleted.toLocaleString()}
          subtitle="RTSing + Pre-Filled RTSing"
          icon={Package}
          iconColor="text-green-400"
        />
        <StatCard
          title="Total Tasks"
          value={kpis.totalTasks.toLocaleString()}
          subtitle={`${label}`}
          icon={ListChecks}
          iconColor="text-blue-400"
        />
        <StatCard
          title="Items Processed"
          value={kpis.itemsProcessed.toLocaleString()}
          subtitle="All task types"
          icon={Boxes}
          iconColor="text-orange-400"
        />
        {/* Avg Tasks / Hr — disabled pending the Homebase API integration.
            The aggregate code can compute a fallback from task time-spans,
            but that estimate isn't trustworthy enough to display as an
            operational metric. Greyed out until labor hours flow from the
            real time-clock source. */}
        <StatCard
          title="Avg Tasks / Hr"
          value="—"
          subtitle="Awaiting Homebase API integration"
          icon={Gauge}
          iconColor="text-purple-400"
          disabled
        />
      </div>

      {/* Charts & breakdowns, stacked */}
      <TeamPerformanceChart
        data={buckets}
        rangeLabel={scope === "me" ? `${label} — just you` : label}
        title={scope === "me" ? "My Performance Over Time" : undefined}
      />
      {isLeadership && (
        <TeamLeaderboard summaries={leaderboard} rangeLabel={label} currentEmployeeId={profile?.id} />
      )}
      <SKUInsights summaries={skus} rangeLabel={scope === "me" ? `${label} — just you` : label} />
    </div>
  );
}
