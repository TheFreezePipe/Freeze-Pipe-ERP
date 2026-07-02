import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { AlertTriangle, TrendingDown, TrendingUp, Package, Ship } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { computeDOS } from "@/lib/inventory-math";
import { getEffectiveDemand } from "@/lib/demand";
import {
  buildInTransitMap,
  buildOnOrderMap,
  inventoryTotalsReal,
} from "@/lib/inventory-aggregates";
import { differenceInDays, parseISO } from "date-fns";
import { cn } from "@/lib/utils";
import {
  useInventory,
  useFreightShipments,
  useFreightLineItems,
  useFactoryOrders,
  useForecastDemandMap,
} from "@/lib/hooks";

interface Alert {
  id: string;
  type: "low_stock" | "reorder" | "elevated_demand" | "decreased_demand" | "arriving_freight";
  severity: "red" | "orange" | "yellow" | "blue" | "green";
  title: string;
  description: string;
  navigateTo: string;
  icon: React.ComponentType<{ className?: string }>;
}

const severityColors = {
  red: "border-red-500/30 bg-red-500/5",
  orange: "border-orange-500/30 bg-orange-500/5",
  yellow: "border-yellow-500/30 bg-yellow-500/5",
  blue: "border-blue-500/30 bg-blue-500/5",
  green: "border-green-500/30 bg-green-500/5",
};

const severityTextColors = {
  red: "text-red-400",
  orange: "text-orange-400",
  yellow: "text-yellow-400",
  blue: "text-blue-400",
  green: "text-green-400",
};

// Alert tuning constants. Centralized here so adjusting noise vs.
// signal is a one-line edit. When the system grows a `system_config`
// table these should move there for runtime override.
const ALERT_LOW_STOCK_DOS = 15;        // warehouse DOS triggering "low stock"
const ALERT_REORDER_DOS = 30;          // total DOS triggering "reorder point"
const ALERT_DEMAND_UP_RATIO = 1.2;     // forecast/static threshold for elevated
const ALERT_DEMAND_DOWN_RATIO = 0.8;   // forecast/static threshold for decreased
const ALERT_FREIGHT_ARRIVING_DAYS = 7; // ETA window for "arriving soon"

export function AlertsPanel() {
  const navigate = useNavigate();
  const { data: inventory = [] } = useInventory();
  const { data: freight = [] } = useFreightShipments();
  const { data: freightLines = [] } = useFreightLineItems();
  const { data: factoryOrders = [] } = useFactoryOrders();
  const forecastMap = useForecastDemandMap();

  const alerts = useMemo<Alert[]>(() => {
    // Build per-SKU aggregates once per render — replaces the legacy
    // inventory_levels.in_transit_* / nancy_* / yx_* reads with live
    // data from freight_shipments + factory_orders.
    const inTransitMap = buildInTransitMap(freight, freightLines);
    const onOrderMap = buildOnOrderMap(factoryOrders, freightLines);
    const result: Alert[] = [];

    // Low stock and demand alerts from inventory
    inventory.forEach(inv => {
      const product = inv.product;
      if (!product) return;
      const totals = inventoryTotalsReal(inv, inTransitMap, onOrderMap);
      const demand = getEffectiveDemand(product.id, product.monthly_demand, forecastMap);
      const warehouseDOS = computeDOS(totals.warehouseTotal, demand);

      if (warehouseDOS < ALERT_LOW_STOCK_DOS) {
        result.push({
          id: `low-${product.id}`,
          type: "low_stock",
          severity: "red",
          title: `${product.sku} - Low Stock`,
          description: `Warehouse DOS: ${warehouseDOS}d (${totals.warehouseTotal} units)`,
          navigateTo: "/inventory",
          icon: AlertTriangle,
        });
      }

      const totalDOS = computeDOS(totals.totalUnits, demand);
      if (totalDOS < ALERT_REORDER_DOS && warehouseDOS >= ALERT_LOW_STOCK_DOS) {
        result.push({
          id: `reorder-${product.id}`,
          type: "reorder",
          severity: "orange",
          title: `${product.sku} - Reorder Point`,
          description: `Total DOS: ${totalDOS}d across all stages`,
          navigateTo: "/inventory",
          icon: Package,
        });
      }

      // Compare forecast vs static demand
      const forecastDemand = getEffectiveDemand(product.id, product.monthly_demand, forecastMap);
      const staticDemand = product.monthly_demand ?? 0;
      if (forecastDemand !== staticDemand && staticDemand > 0) {
        const ratio = forecastDemand / staticDemand;
        if (ratio > ALERT_DEMAND_UP_RATIO) {
          result.push({
            id: `demand-up-${product.id}`,
            type: "elevated_demand",
            severity: "yellow",
            title: `${product.sku} - Elevated Demand`,
            description: `Forecast: ${forecastDemand}/mo vs Static: ${staticDemand}/mo (+${Math.round((ratio - 1) * 100)}%)`,
            navigateTo: "/inventory",
            icon: TrendingUp,
          });
        } else if (ratio < ALERT_DEMAND_DOWN_RATIO) {
          result.push({
            id: `demand-down-${product.id}`,
            type: "decreased_demand",
            severity: "blue",
            title: `${product.sku} - Decreased Demand`,
            description: `Forecast: ${forecastDemand}/mo vs Static: ${staticDemand}/mo (${Math.round((ratio - 1) * 100)}%)`,
            navigateTo: "/inventory",
            icon: TrendingDown,
          });
        }
      }
    });

    // Arriving freight (ETA within 7 days)
    freight.forEach(f => {
      if (f.status === "delivered" || !f.eta) return;
      const daysLeft = differenceInDays(parseISO(f.eta), new Date());
      if (daysLeft >= 0 && daysLeft <= ALERT_FREIGHT_ARRIVING_DAYS) {
        result.push({
          id: `freight-${f.id}`,
          type: "arriving_freight",
          severity: "green",
          title: `${f.shipment_number} - Arriving Soon`,
          description: `ETA in ${daysLeft}d (${f.freight_type === "sea" ? "Sea" : "Air"})`,
          navigateTo: `/freight/${f.id}`,
          icon: Ship,
        });
      }
    });

    const order = { red: 0, orange: 1, yellow: 2, blue: 3, green: 4 };
    return result.sort((a, b) => order[a.severity] - order[b.severity]);
  }, [inventory, freight, freightLines, factoryOrders, forecastMap]);

  if (alerts.length === 0) {
    return (
      <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
        No active alerts
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {alerts.map(alert => (
        <button
          key={alert.id}
          className={cn(
            "w-full flex items-center gap-3 rounded-lg border p-3 text-left transition-colors hover:bg-muted/50",
            severityColors[alert.severity]
          )}
          onClick={() => navigate(alert.navigateTo)}
        >
          <alert.icon className={cn("h-4 w-4 shrink-0", severityTextColors[alert.severity])} />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium truncate">{alert.title}</p>
            <p className="text-xs text-muted-foreground truncate">{alert.description}</p>
          </div>
          <Badge variant="outline" className={cn("text-[10px] shrink-0", severityTextColors[alert.severity])}>
            {alert.type.replace("_", " ")}
          </Badge>
        </button>
      ))}
      {alerts.length === 0 && (
        <p className="text-sm text-muted-foreground text-center py-4">No active alerts</p>
      )}
    </div>
  );
}
