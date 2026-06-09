import { useMemo } from "react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
} from "recharts";
import type { ProductSKU, InventoryLevel } from "@/types/database";
import { format, parseISO } from "date-fns";
import {
  useFreightShipments,
  useFreightLineItems,
  useSkuWarehouseTotalHistory,
} from "@/lib/hooks";

interface Props {
  product: ProductSKU;
  inventory: InventoryLevel;
  demandOverride?: number;
}

const HISTORY_DAYS = 30;
const PROJECTION_DAYS = 60;

/**
 * Combined history + projection chart for total warehouse inventory.
 *
 * Left half (HISTORY_DAYS): reconstructed from inventory_transactions —
 * we anchor at today's TOTAL warehouse balance (sum across all five
 * buckets: raw / prefilled_raw / in_production / finished / other) and
 * walk backwards subtracting each tx's delta. Daily snapshots aren't
 * stored in the schema; the reconstructed series is exact-as-the-tx-log.
 *
 * Right half (PROJECTION_DAYS): forward burn-down at daily demand
 * (sales reduce total), with arriving-freight quantities added on their
 * ETA dates (freight enters warehouse_raw → increases total). Internal
 * raw → finished movement doesn't affect total; we don't model it.
 *
 * "Today" is marked with a vertical reference line. The historical
 * portion uses a stepped line (inventory is discrete; balances stay
 * flat between transactions) while the projection uses a smooth curve.
 *
 * Note on early days: until the system has accumulated HISTORY_DAYS of
 * transaction data, the historical reconstruction can only go back as
 * far as the first transaction for the SKU (or the system genesis).
 * Days before that show as flat at the earliest known balance — which
 * is accurate, since "no transactions" means "no change."
 */
export function InventoryProjectionChart({ product, inventory, demandOverride }: Props) {
  const { data: freight = [] } = useFreightShipments();
  const { data: freightLineItems = [] } = useFreightLineItems();

  // Total warehouse = sum of all five bucket columns. Drives the chart's
  // anchor for both the historical reconstruction and the forward
  // projection so the two halves use the same metric.
  const currentTotal =
    (inventory.warehouse_raw ?? 0) +
    (inventory.warehouse_prefilled_raw ?? 0) +
    (inventory.warehouse_in_production ?? 0) +
    (inventory.warehouse_finished ?? 0) +
    (inventory.warehouse_other ?? 0);

  const { data: history = [] } = useSkuWarehouseTotalHistory(
    product.id,
    currentTotal,
    HISTORY_DAYS,
  );

  const { combined, arrivingFreight, reorderPoint, todayStr } = useMemo(() => {
    const demand = demandOverride ?? product.monthly_demand;
    const dailyBurn = demand / 30;

    // Find arriving freight for this SKU (non-delivered, with ETA).
    const arrivingFreight = freight
      .filter((f) => f.status !== "delivered" && f.eta)
      .flatMap((f) => {
        const items = freightLineItems.filter(
          (li) => li.freight_shipment_id === f.id && li.sku_id === product.id,
        );
        return items.map((item) => ({
          date: f.eta!,
          qty: item.quantity,
          shipment: f.shipment_number,
        }));
      });

    // Forward projection — anchored at today's total, then burn down
    // by daily demand and bump up by any arriving freight on its ETA
    // date. Day 0 (today) duplicates the historical anchor so the two
    // series visually meet.
    const todayStr = new Date().toISOString().slice(0, 10);
    const projection: { date: string; projected: number }[] = [
      { date: todayStr, projected: currentTotal },
    ];
    let projValue = currentTotal;
    for (let d = 1; d <= PROJECTION_DAYS; d++) {
      const date = new Date();
      date.setDate(date.getDate() + d);
      const dateStr = date.toISOString().slice(0, 10);
      const arriving = arrivingFreight
        .filter((af) => af.date === dateStr)
        .reduce((sum, af) => sum + af.qty, 0);
      projValue = Math.max(0, projValue - dailyBurn + arriving);
      projection.push({ date: dateStr, projected: Math.round(projValue) });
    }

    // Combine into one ordered series so recharts renders both Area
    // shapes on the same axis. Each row sets either `total` (historical)
    // or `projected` (forward), or both at the today anchor. Recharts
    // skips undefined values within each series so the two paths render
    // cleanly without bleeding into each other.
    type Row = { date: string; total?: number; projected?: number };
    const byDate = new Map<string, Row>();
    for (const h of history) {
      byDate.set(h.date, { date: h.date, total: h.total });
    }
    for (const p of projection) {
      const existing = byDate.get(p.date) ?? { date: p.date };
      byDate.set(p.date, { ...existing, projected: p.projected });
    }
    const combined = Array.from(byDate.values()).sort((a, b) =>
      a.date.localeCompare(b.date),
    );

    return {
      combined,
      arrivingFreight,
      reorderPoint: Math.round(dailyBurn * 15),
      todayStr,
    };
  }, [product, demandOverride, freight, freightLineItems, history, currentTotal]);

  return (
    <ResponsiveContainer width="100%" height={280}>
      {/* top margin leaves headroom for the "Today" / freight-ETA reference
          line labels (position: "top"), which otherwise clip at the SVG edge. */}
      <AreaChart data={combined} margin={{ top: 28, right: 10, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(0,0%,18%)" />
        <XAxis
          dataKey="date"
          tick={{ fontSize: 10, fill: "hsl(0,0%,55%)" }}
          tickFormatter={(val: string) => {
            try {
              return format(parseISO(val), "MMM d");
            } catch {
              return val;
            }
          }}
          interval="preserveStartEnd"
          minTickGap={40}
        />
        <YAxis tick={{ fontSize: 10, fill: "hsl(0,0%,55%)" }} width={40} />
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
              return format(parseISO(val), "MMM d, yyyy");
            } catch {
              return val;
            }
          }}
        />
        <ReferenceLine
          y={reorderPoint}
          stroke="hsl(0,70%,50%)"
          strokeDasharray="5 5"
          label={{
            value: "Reorder",
            fill: "hsl(0,70%,50%)",
            fontSize: 10,
            position: "insideTopRight",
          }}
        />
        {/* "Today" vertical marker. Distinguishes the actual / projected
            halves so the operator doesn't read forward-projected values
            as if they were observed. */}
        <ReferenceLine
          x={todayStr}
          stroke="hsl(0,0%,75%)"
          strokeDasharray="3 3"
          label={{
            value: "Today",
            fill: "hsl(0,0%,75%)",
            fontSize: 10,
            position: "top",
          }}
        />
        {arrivingFreight.map((af, i) => (
          <ReferenceLine
            key={i}
            x={af.date}
            stroke="hsl(142,71%,45%)"
            strokeDasharray="4 4"
            label={{
              value: `+${af.qty}`,
              fill: "hsl(142,71%,45%)",
              fontSize: 9,
              position: "top",
            }}
          />
        ))}
        {/* Historical: stepped (inventory is discrete — flat between txs)
            in cyan, solid stroke. Plots TOTAL warehouse units (sum of
            raw / prefilled_raw / in_production / finished / other). */}
        <Area
          type="stepAfter"
          dataKey="total"
          stroke="hsl(189,94%,56%)"
          fill="hsl(189,94%,56%)"
          fillOpacity={0.18}
          strokeWidth={2}
          name="Actual total warehouse"
          connectNulls={false}
        />
        {/* Projected: smooth curve in purple, dashed stroke to make the
            "this is a forecast, not history" distinction unmistakable.
            Same metric as the historical line: total warehouse units,
            burning down by daily demand and bumping on freight arrivals. */}
        <Area
          type="monotone"
          dataKey="projected"
          stroke="hsl(270,67%,56%)"
          fill="hsl(270,67%,56%)"
          fillOpacity={0.12}
          strokeWidth={2}
          strokeDasharray="6 4"
          name="Projected total warehouse"
          connectNulls={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
