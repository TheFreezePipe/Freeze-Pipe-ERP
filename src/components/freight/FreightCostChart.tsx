import { useMemo, useState } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";
import { startOfWeek, startOfMonth, format, parseISO } from "date-fns";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useFreightShipments } from "@/lib/hooks";

type GroupBy = "week" | "month";

/**
 * Sea-freight cost-per-carton, grouped by ship-date week or month.
 *
 * Aggregation is **weighted** (sum of freight_cost / sum of total_cartons
 * across all shipments in the period) rather than averaged across
 * shipments. A weighted blend reflects the actual blended rate paid per
 * carton — a tiny outlier shipment can't drag a busy week's average
 * around the way a simple mean would.
 *
 * Data set: every sea shipment with both ship_date and total_cartons set,
 * regardless of status. Shipments missing either column can't contribute
 * a meaningful per-carton cost so they're skipped silently.
 */
export function FreightCostChart() {
  const [groupBy, setGroupBy] = useState<GroupBy>("week");
  const { data: freight = [] } = useFreightShipments();

  const chartData = useMemo(() => {
    // Bucket key → running totals. Ordered insertion is fine because we
    // sort on output anyway, but a plain object works because we sort
    // explicitly at the end.
    type Bucket = { cost: number; cartons: number; shipments: number };
    const byBucket = new Map<string, Bucket>();

    for (const f of freight) {
      if (f.freight_type !== "sea") continue;
      if (!f.ship_date) continue;
      // total_cartons is what we divide by — skip rows where it's
      // null/0 to avoid divide-by-zero or fabricated $/ctn=∞ points.
      if (!f.total_cartons || f.total_cartons <= 0) continue;
      // Skip rows with no recorded freight cost — they'd render as $0
      // and pull the visual blend toward zero falsely.
      if (f.freight_cost == null || f.freight_cost <= 0) continue;

      const shipDate = parseISO(f.ship_date);
      // weekStartsOn=1 (Monday) matches ISO weeks; an operator looking at
      // "the week of May 4" expects Monday-Sunday, not US Sunday-Saturday.
      const bucketStart =
        groupBy === "week"
          ? startOfWeek(shipDate, { weekStartsOn: 1 })
          : startOfMonth(shipDate);
      const bucketKey = bucketStart.toISOString().slice(0, 10);

      const existing = byBucket.get(bucketKey) ?? { cost: 0, cartons: 0, shipments: 0 };
      existing.cost += Number(f.freight_cost);
      existing.cartons += f.total_cartons;
      existing.shipments += 1;
      byBucket.set(bucketKey, existing);
    }

    return Array.from(byBucket.entries())
      .map(([bucketKey, b]) => ({
        bucket: bucketKey,
        costPerCarton: parseFloat((b.cost / b.cartons).toFixed(2)),
        totalCost: b.cost,
        totalCartons: b.cartons,
        shipmentCount: b.shipments,
      }))
      .sort((a, b) => a.bucket.localeCompare(b.bucket));
  }, [freight, groupBy]);

  // Format the X-axis tick label per groupBy. Week labels use "Apr 28"
  // (start-of-week, MM d); month labels use "Apr 2026" (MMM y).
  function formatTick(bucketKey: string): string {
    try {
      const d = parseISO(bucketKey);
      return groupBy === "week" ? format(d, "MMM d") : format(d, "MMM yyyy");
    } catch {
      return bucketKey;
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <Tabs
          value={groupBy}
          onValueChange={(v) => setGroupBy(v as GroupBy)}
          className="w-auto"
        >
          <TabsList className="h-8">
            <TabsTrigger value="week" className="text-xs px-3">
              By Week
            </TabsTrigger>
            <TabsTrigger value="month" className="text-xs px-3">
              By Month
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <span className="text-xs text-muted-foreground tabular-nums">
          {chartData.length} {chartData.length === 1 ? groupBy : `${groupBy}s`} ·{" "}
          {chartData.reduce((s, d) => s + d.shipmentCount, 0)} shipments
        </span>
      </div>

      {chartData.length === 0 ? (
        <p className="text-xs text-muted-foreground italic py-8 text-center">
          No sea shipments with both ship date and carton count yet.
        </p>
      ) : (
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={chartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(0,0%,18%)" />
            <XAxis
              dataKey="bucket"
              tick={{ fontSize: 10, fill: "hsl(0,0%,55%)" }}
              tickFormatter={formatTick}
              interval="preserveStartEnd"
              minTickGap={30}
            />
            <YAxis
              tick={{ fontSize: 10, fill: "hsl(0,0%,55%)" }}
              width={48}
              tickFormatter={(v: number) => `$${v}`}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: "hsl(0,0%,10%)",
                border: "1px solid hsl(0,0%,18%)",
                borderRadius: 8,
                color: "hsl(0,0%,95%)",
                fontSize: 12,
              }}
              labelFormatter={(val: string) => {
                try {
                  const d = parseISO(val);
                  return groupBy === "week"
                    ? `Week of ${format(d, "MMM d, yyyy")}`
                    : format(d, "MMMM yyyy");
                } catch {
                  return val;
                }
              }}
              formatter={(_v: unknown, _name: string, item: { payload?: typeof chartData[number] }) => {
                const p = item.payload;
                if (!p) return ["", ""];
                return [
                  `$${p.costPerCarton.toFixed(2)}/ctn`,
                  `${p.shipmentCount} shipment${p.shipmentCount === 1 ? "" : "s"} · ${p.totalCartons.toLocaleString()} ctn · $${p.totalCost.toLocaleString()} total`,
                ];
              }}
            />
            <Bar dataKey="costPerCarton" fill="hsl(205,94%,56%)" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
