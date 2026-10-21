import { CalendarCheck, Clock, Package, ScanBarcode } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { StatCard } from "@/components/shared/StatCard";
import { useBarcodeCoverage, useBaselineKpis } from "@/lib/hooks";
import { formatDays, formatShare } from "@/lib/warehouse/baseline";
import { formatEtYmd } from "@/lib/performance/date-ranges";

const BASELINE_DAYS = 14;

/**
 * Shipping baseline (Warehouse Phase 0): the ShipStation ship-day KPIs that
 * Phase 1 is measured against. Moved unchanged from the old Warehouse
 * overview; its Outbound card now lives under Settings, Warehouse.
 */
export function ShippingBaseline() {
  const { data: coverage } = useBarcodeCoverage();
  const { data: kpis, isLoading: kpisLoading, isError: kpisError } = useBaselineKpis(BASELINE_DAYS);

  const summary = kpis?.summary;
  // Most recent ship day first.
  const days = [...(kpis?.days ?? [])].sort((a, b) => b.ship_day.localeCompare(a.ship_day));
  const coveragePct =
    coverage && coverage.active_total > 0 ? Math.round((coverage.with_code / coverage.active_total) * 100) : null;

  return (
    <Card>
      <CardContent className="space-y-4 p-4">
        <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Shipping baseline · last {BASELINE_DAYS} days
        </h2>

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard
            title="Barcodes"
            value={coverage ? `${coverage.with_code} of ${coverage.active_total}` : "—"}
            subtitle={coveragePct != null ? `${coveragePct}%` : undefined}
            icon={ScanBarcode}
          />
          <StatCard
            title="Orders per ship day"
            value={summary?.median_orders_per_day != null ? Math.round(summary.median_orders_per_day).toLocaleString() : "—"}
            subtitle={`${BASELINE_DAYS}-day median`}
            icon={Package}
            iconColor="text-blue-400"
          />
          <StatCard
            title="Days to ship"
            value={formatDays(summary?.median_days_to_ship)}
            subtitle={`${BASELINE_DAYS}-day median`}
            icon={Clock}
            iconColor="text-amber-400"
          />
          <StatCard
            title="Shipped same day"
            value={formatShare(summary?.same_day_share)}
            subtitle={`Last ${BASELINE_DAYS} days`}
            icon={CalendarCheck}
            iconColor="text-green-400"
          />
        </div>

        {days.length === 0 ? (
          <div className="rounded-md border border-border/50 py-8 text-center text-sm text-muted-foreground">
            {kpisLoading
              ? "Loading…"
              : kpisError
                ? "Couldn't load the ship-day KPIs."
                : `No ship days in the last ${BASELINE_DAYS} days.`}
          </div>
        ) : (
          <div className="overflow-x-auto rounded-md border border-border/50">
            <table className="w-full min-w-[480px] text-sm">
              <thead className="border-b border-border/50 text-left text-xs uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Ship day</th>
                  <th className="px-4 py-2.5 text-right font-medium">Orders</th>
                  <th className="px-4 py-2.5 text-right font-medium">Lines</th>
                  <th className="px-4 py-2.5 text-right font-medium">Days to ship</th>
                  <th className="px-4 py-2.5 text-right font-medium">Same day</th>
                </tr>
              </thead>
              <tbody>
                {days.map((day) => (
                  <tr key={day.ship_day} className="border-b border-border/50 last:border-0">
                    <td className="whitespace-nowrap px-4 py-1.5">
                      {formatEtYmd(day.ship_day, { weekday: "short", month: "short", day: "numeric" })}
                    </td>
                    <td className="px-4 py-1.5 text-right tabular-nums">{day.orders.toLocaleString()}</td>
                    <td className="px-4 py-1.5 text-right tabular-nums">{day.lines.toLocaleString()}</td>
                    <td className="px-4 py-1.5 text-right tabular-nums">{formatDays(day.median_days_to_ship)}</td>
                    <td className="px-4 py-1.5 text-right tabular-nums">{formatShare(day.same_day_share)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
