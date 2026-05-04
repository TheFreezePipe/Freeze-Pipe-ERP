import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";
import { useMemo } from "react";
import { useFreightShipments, useFreightLineItems } from "@/lib/hooks";

export function FreightCostChart() {
  const { data: freight = [] } = useFreightShipments();
  const { data: freightLineItems = [] } = useFreightLineItems();

  const chartData = useMemo(() => {
    return freight
      .filter(f => f.freight_type === "sea")
      .map(f => {
        const lineItems = freightLineItems.filter(li => li.freight_shipment_id === f.id);
        const totalCartons = lineItems.reduce((s, li) => s + li.quantity, 0);
        const totalCost = f.total_cost ?? 0;
        const costPerUnit = totalCartons > 0 ? totalCost / totalCartons : 0;
        return {
          shipment: f.shipment_number.replace("SEA-2026-", ""),
          costPerUnit: parseFloat(costPerUnit.toFixed(2)),
          totalCost,
          status: f.status,
        };
      })
      .sort((a, b) => a.shipment.localeCompare(b.shipment));
  }, [freight, freightLineItems]);

  if (chartData.length === 0) return null;

  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={chartData}>
        <XAxis dataKey="shipment" tick={{ fontSize: 10, fill: "hsl(0,0%,55%)" }} />
        <YAxis tick={{ fontSize: 10, fill: "hsl(0,0%,55%)" }} width={40} tickFormatter={(v: number) => `$${v}`} />
        <Tooltip
          contentStyle={{
            backgroundColor: "hsl(0,0%,10%)",
            border: "1px solid hsl(0,0%,18%)",
            borderRadius: 8,
            color: "hsl(0,0%,95%)",
          }}
          formatter={(v: number) => [`$${v.toFixed(2)}`, "Cost/Unit"]}
     
        />
        <Bar dataKey="costPerUnit" fill="hsl(205,94%,56%)" radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
