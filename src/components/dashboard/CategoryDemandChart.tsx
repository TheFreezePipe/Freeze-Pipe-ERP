import { useMemo } from "react";
import { getCategoryForecasts } from "@/lib/category-demand";

const BAR_COLORS: Record<string, string> = {
  Pipes: "hsl(205, 94%, 56%)",
  Bongs: "hsl(142, 71%, 45%)",
  Bubblers: "hsl(31, 97%, 56%)",
  "Joint Chiller": "hsl(270, 67%, 56%)",
  "Ash Catchers": "hsl(340, 65%, 55%)",
  "Dab Rigs": "hsl(190, 80%, 50%)",
  Bowls: "hsl(45, 85%, 55%)",
  Accessories: "hsl(0, 0%, 55%)",
  Coils: "hsl(160, 60%, 50%)",
  Bases: "hsl(20, 60%, 50%)",
  Studio: "hsl(280, 50%, 60%)",
};

function formatDollars(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${Math.round(n / 1000).toLocaleString()}k`;
  return `$${Math.round(n).toLocaleString()}`;
}

export function CategoryDemandChart() {
  const categories = useMemo(() => getCategoryForecasts(), []);
  const maxValue = Math.max(...categories.map(c => c.forecastRetailValue), 1);
  const totalRetail = categories.reduce((sum, c) => sum + c.forecastRetailValue, 0);

  return (
    <div className="space-y-2.5">
      <div className="flex items-baseline gap-2 mb-3">
        <span className="text-2xl font-bold tabular-nums tracking-tight">{formatDollars(totalRetail)}</span>
        <span className="text-xs text-muted-foreground">total forecasted retail value / 30 days</span>
      </div>
      {categories.map(cat => {
        const pct = (cat.forecastRetailValue / maxValue) * 100;
        const color = BAR_COLORS[cat.category] ?? "hsl(0, 0%, 50%)";
        return (
          <div key={cat.category} className="group">
            <div className="flex items-center justify-between mb-0.5">
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium">{cat.category}</span>
                <span className="text-[10px] text-muted-foreground">{cat.skuCount}/{cat.totalSkuCount} SKUs</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-xs font-bold tabular-nums">{formatDollars(cat.forecastRetailValue)}</span>
              </div>
            </div>
            <div className="h-5 w-full rounded bg-muted/30 overflow-hidden">
              <div
                className="h-full rounded flex items-center justify-end pr-1.5 transition-all"
                style={{ width: `${Math.max(pct, 2)}%`, backgroundColor: color }}
              >
                {pct > 18 && (
                  <span className="text-[10px] font-semibold text-white tabular-nums">
                    {formatDollars(cat.forecastRetailValue)}
                  </span>
                )}
              </div>
            </div>
            <div className="hidden group-hover:flex gap-3 mt-0.5 text-[10px] text-muted-foreground">
              <span>{cat.forecast30d.toLocaleString()} units</span>
              <span>Seasonal: {cat.avgSeasonalIndex.toFixed(2)}×</span>
              <span>Trend: {cat.avgTrendMultiplier > 1 ? "+" : ""}{((cat.avgTrendMultiplier - 1) * 100).toFixed(0)}%</span>
              {cat.lowerBoundRetail !== null && cat.upperBoundRetail !== null ? (
                <span>Range: {formatDollars(cat.lowerBoundRetail)}–{formatDollars(cat.upperBoundRetail)}</span>
              ) : (
                <span className="italic text-muted-foreground/60" title="Static estimate from monthly_demand — no per-SKU forecast data, so no confidence band">
                  Range: not enough data
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
