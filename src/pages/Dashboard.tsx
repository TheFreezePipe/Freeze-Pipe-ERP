import { StatCard } from "@/components/shared/StatCard";
import { AlertTriangle, Ship, Plane, TrendingUp } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getEffectiveDemand } from "@/lib/demand";
import { RetailValueSummaryBar } from "@/components/dashboard/RetailValueSummaryBar";
import { RetailValueChart } from "@/components/dashboard/RetailValueChart";
import { ManufacturingCompletionChart } from "@/components/dashboard/ManufacturingCompletionChart";
import { ManufacturingCompletionModal } from "@/components/dashboard/ManufacturingCompletionModal";
import { AlertsPanel } from "@/components/dashboard/AlertsPanel";
import { FreightCostChart } from "@/components/freight/FreightCostChart";
import { useMemo, useState } from "react";
import { useFreightShipments, useFreightLineItems, useProducts, useForecastDemandMap } from "@/lib/hooks";

export default function Dashboard() {
  const { data: freight = [] } = useFreightShipments();
  const { data: freightLineItems = [] } = useFreightLineItems();
  const { data: products = [] } = useProducts();
  const forecastMap = useForecastDemandMap();
  const [mfgOpen, setMfgOpen] = useState(false);

  const stats = useMemo(() => {
    const highRiskItems = freightLineItems.filter(li => {
      const shipment = freight.find(f => f.id === li.freight_shipment_id);
      return shipment?.status === "high_risk";
    });
    const highRiskRetail = highRiskItems.reduce((s, li) => s + (li.retail_value ?? 0) * li.quantity, 0);

    const activeFreight = freight.filter(f => f.status !== "delivered");
    const activeSea = activeFreight.filter(f => f.freight_type === "sea");
    const activeAir = activeFreight.filter(f => f.freight_type === "air");
    const seaValue = activeSea.reduce((s, f) => s + (f.total_cost ?? 0), 0);
    const airValue = activeAir.reduce((s, f) => s + (f.total_cost ?? 0), 0);

    let totalStatic = 0;
    let totalForecast = 0;
    products.forEach(p => {
      totalStatic += p.monthly_demand;
      totalForecast += getEffectiveDemand(p.id, p.monthly_demand, forecastMap);
    });
    const demandRatio = totalStatic > 0 ? Math.round((totalForecast / totalStatic) * 100) : 100;

    return {
      highRiskRetail,
      seaCount: activeSea.length,
      seaValue,
      airCount: activeAir.length,
      airValue,
      demandRatio,
    };
  }, [freight, freightLineItems, products, forecastMap]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Dashboard</h1>
        <p className="text-muted-foreground">Freeze Pipe operations at a glance</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          title="High Risk Value"
          value={formatHighRiskRetail(stats.highRiskRetail)}
          subtitle="Under inspection"
          icon={AlertTriangle}
          iconColor="text-red-400"
        />
        <StatCard
          title="Active Sea"
          value={stats.seaCount}
          subtitle={`$${stats.seaValue.toLocaleString()} freight cost`}
          icon={Ship}
          iconColor="text-blue-400"
        />
        <StatCard
          title="Active Air"
          value={stats.airCount}
          subtitle={`$${stats.airValue.toLocaleString()} freight cost`}
          icon={Plane}
          iconColor="text-cyan-400"
        />
        <StatCard
          title="Forecast vs Recent"
          value={`${stats.demandRatio}%`}
          subtitle={stats.demandRatio > 100 ? "Demand trending up" : stats.demandRatio < 100 ? "Demand trending down" : "Steady"}
          icon={TrendingUp}
          iconColor={stats.demandRatio > 110 ? "text-yellow-400" : "text-green-400"}
        />
      </div>

      <Card>
        <CardContent className="pt-6 space-y-6">
          <RetailValueSummaryBar />
          <button
            type="button"
            onClick={() => setMfgOpen(true)}
            className="group w-full border-t border-border/50 pt-5 text-left rounded-md transition-colors hover:bg-muted/20 cursor-pointer"
          >
            <div className="mb-3 flex items-start justify-between gap-2">
              <div>
                <p className="text-sm font-medium">Manufacturing Completion</p>
                <p className="text-xs text-muted-foreground">Fillable warehouse inventory progress</p>
              </div>
              <span className="text-xs text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 shrink-0">
                View details &rarr;
              </span>
            </div>
            <ManufacturingCompletionChart />
          </button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Retail Value &amp; 30-Day Demand by Category</CardTitle>
          <p className="text-xs text-muted-foreground">Inventory value stacked by location, with the blue bar showing forecasted 30-day demand (at retail) for coverage at a glance</p>
        </CardHeader>
        <CardContent>
          <RetailValueChart />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-yellow-400" />
            Alerts
          </CardTitle>
        </CardHeader>
        <CardContent className="max-h-[380px] overflow-y-auto">
          <AlertsPanel />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Sea Freight — Cost per Carton</CardTitle>
          <p className="text-xs text-muted-foreground">
            Weighted blend (sum of freight cost ÷ sum of cartons) of all sea
            shipments grouped by ship date.
          </p>
        </CardHeader>
        <CardContent>
          <FreightCostChart />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Active Freight</CardTitle>
          <p className="text-xs text-muted-foreground">In-transit and pending shipments</p>
        </CardHeader>
        <CardContent>
          <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
            {freight.filter(f => f.status !== "delivered").map(f => {
              const lineItems = freightLineItems.filter(li => li.freight_shipment_id === f.id);
              const retailVal = lineItems.reduce((s, li) => s + (li.retail_value ?? 0) * li.quantity, 0);
              const skus = lineItems.map(li => li.product?.sku ?? "").filter(Boolean).join(", ");

              return (
                <div key={f.id} className="flex items-center justify-between rounded-lg border border-border/50 p-3 hover:bg-muted/30 transition-colors">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      {f.freight_type === "sea" ? (
                        <Ship className="h-3.5 w-3.5 text-blue-400 shrink-0" />
                      ) : (
                        <Plane className="h-3.5 w-3.5 text-cyan-400 shrink-0" />
                      )}
                      <span className="text-sm font-medium">{f.shipment_number}</span>
                      {f.status === "high_risk" && (
                        <span className="text-[10px] bg-red-500/10 text-red-400 rounded px-1.5 py-0.5 font-medium">HIGH RISK</span>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5 truncate">
                      {skus} &middot; ETA {f.eta ?? "TBD"}
                    </p>
                  </div>
                  <div className="text-right shrink-0 ml-3">
                    <p className="text-sm font-bold tabular-nums">${retailVal.toLocaleString()}</p>
                    <p className="text-[10px] text-muted-foreground">retail value</p>
                  </div>
                </div>
              );
            })}
          </div>
          {freight.filter(f => f.status !== "delivered").length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-6">No active shipments</p>
          )}
        </CardContent>
      </Card>

      <ManufacturingCompletionModal open={mfgOpen} onOpenChange={setMfgOpen} />
    </div>
  );
}

function formatHighRiskRetail(value: number): string {
  if (value === 0) return "$0";
  if (value >= 1000) return `$${Math.round(value).toLocaleString()}`;
  return `$${value.toFixed(0)}`;
}
