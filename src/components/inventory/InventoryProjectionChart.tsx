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
import { useFreightShipments, useFreightLineItems } from "@/lib/hooks";

interface Props {
  product: ProductSKU;
  inventory: InventoryLevel;
  demandOverride?: number;
}

/**
 * Forward-projection chart for finished-goods inventory. Shows current
 * level + 60 days of projected burn-down with arriving-freight bumps
 * marked. Historical data is intentionally NOT plotted: there's no
 * persistent daily snapshot of warehouse_finished anywhere in the
 * schema, so any "history" line would be synthesized noise. Showing
 * fabricated history as if it were real misled operators into reading
 * trends that didn't exist.
 *
 * When/if we start storing daily snapshots (e.g. an
 * `inventory_levels_history` table populated by a nightly cron),
 * surface that data here as a real second series.
 */
export function InventoryProjectionChart({ product, inventory, demandOverride }: Props) {
  const { data: freight = [] } = useFreightShipments();
  const { data: freightLineItems = [] } = useFreightLineItems();

  const chartData = useMemo(() => {
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

    // Forward projection — current finished level burns down at daily
    // demand rate, with arriving-freight quantities added on their ETA
    // dates. Today is the leftmost point so the chart shows "where we
    // are today" + "where we'll be over the next 60 days."
    const projected: { date: string; projected: number }[] = [];
    let currentValue = inventory.warehouse_finished;

    // Anchor point: today.
    const todayStr = new Date().toISOString().split("T")[0];
    projected.push({ date: todayStr, projected: currentValue });

    for (let d = 1; d <= 60; d++) {
      const date = new Date();
      date.setDate(date.getDate() + d);
      const dateStr = date.toISOString().split("T")[0];

      const arriving = arrivingFreight
        .filter((af) => af.date === dateStr)
        .reduce((sum, af) => sum + af.qty, 0);

      currentValue = Math.max(0, currentValue - dailyBurn + arriving);
      projected.push({ date: dateStr, projected: Math.round(currentValue) });
    }

    return { projected, arrivingFreight, reorderPoint: Math.round(dailyBurn * 15) };
  }, [product, inventory, demandOverride, freight, freightLineItems]);

  return (
    <ResponsiveContainer width="100%" height={280}>
      <AreaChart data={chartData.projected} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
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
          y={chartData.reorderPoint}
          stroke="hsl(0,70%,50%)"
          strokeDasharray="5 5"
          label={{
            value: "Reorder",
            fill: "hsl(0,70%,50%)",
            fontSize: 10,
            position: "insideTopRight",
          }}
        />
        {chartData.arrivingFreight.map((af, i) => (
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
        <Area
          type="monotone"
          dataKey="projected"
          stroke="hsl(270,67%,56%)"
          fill="hsl(270,67%,56%)"
          fillOpacity={0.12}
          strokeWidth={2}
          name="Projected finished stock"
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
