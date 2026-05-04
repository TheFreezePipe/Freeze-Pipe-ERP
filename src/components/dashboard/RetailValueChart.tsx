import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend } from "recharts";
import { useMemo } from "react";
import {
  useInventory,
  useFreightShipments,
  useFreightLineItems,
  useFactoryOrders,
} from "@/lib/hooks";
import {
  buildInTransitMap,
  buildOnOrderMap,
  inventoryTotalsReal,
} from "@/lib/inventory-aggregates";

// Colors matching the reference dashboard (green=warehouse, yellow=transit, pink=on order)
const WAREHOUSE_COLOR = "hsl(120, 45%, 50%)";
const TRANSIT_COLOR = "hsl(45, 85%, 55%)";
const ON_ORDER_COLOR = "hsl(0, 65%, 70%)";

export function RetailValueChart() {
  const { data: inventory = [] } = useInventory();
  const { data: shipments = [] } = useFreightShipments();
  const { data: freightLines = [] } = useFreightLineItems();
  const { data: factoryOrders = [] } = useFactoryOrders();

  const chartData = useMemo(() => {
    const inTransitMap = buildInTransitMap(shipments, freightLines);
    const onOrderMap = buildOnOrderMap(factoryOrders, freightLines);
    const byCat: Record<string, { warehouse: number; transit: number; onOrder: number }> = {};

    inventory.forEach(inv => {
      const product = inv.product;
      if (!product) return;
      const totals = inventoryTotalsReal(inv, inTransitMap, onOrderMap);
      const price = product.retail_price;
      const category = product.display_category;

      if (!byCat[category]) {
        byCat[category] = { warehouse: 0, transit: 0, onOrder: 0 };
      }

      byCat[category].warehouse += totals.warehouseTotal * price;
      byCat[category].transit += totals.transitTotal * price;
      byCat[category].onOrder += totals.onOrderTotal * price;
    });

    return Object.entries(byCat)
      .map(([category, vals]) => ({
        category,
        warehouse: Math.round(vals.warehouse),
        transit: Math.round(vals.transit),
        onOrder: Math.round(vals.onOrder),
      }))
      .sort((a, b) => (b.warehouse + b.transit + b.onOrder) - (a.warehouse + a.transit + a.onOrder));
  }, [inventory, shipments, freightLines, factoryOrders]);

  return (
    <ResponsiveContainer width="100%" height={320}>
      <BarChart data={chartData} barCategoryGap="20%">
        <XAxis dataKey="category" tick={{ fontSize: 11, fill: "hsl(0,0%,60%)" }} />
        <YAxis
          tick={{ fontSize: 10, fill: "hsl(0,0%,55%)" }}
          width={70}
          tickFormatter={(v: number) => `$${v >= 1000 ? `${(v / 1000).toFixed(0)}k` : v.toLocaleString()}`}
        />
        <Tooltip
          contentStyle={{
            backgroundColor: "hsl(0,0%,10%)",
            border: "1px solid hsl(0,0%,18%)",
            borderRadius: 8,
            color: "hsl(0,0%,95%)",
          }}
          formatter={(v: number, name: string) => [`$${v.toLocaleString()}`, name]}
        />
        <Legend
          wrapperStyle={{ fontSize: 11, paddingTop: 4 }}
          formatter={(value: string) => <span style={{ color: "hsl(0,0%,70%)" }}>{value}</span>}
        />
        <Bar dataKey="warehouse" name="In Warehouse" stackId="a" fill={WAREHOUSE_COLOR} />
        <Bar dataKey="transit" name="In Transit" stackId="a" fill={TRANSIT_COLOR} />
        <Bar dataKey="onOrder" name="On Order" stackId="a" fill={ON_ORDER_COLOR} radius={[3, 3, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
