import { useMemo } from "react";
import {
  useInventory,
  useFreightShipments,
  useFreightLineItems,
  useFactoryOrders,
  useAllSkuEconomics,
  useAllPrimarySkuSupplierCosts,
} from "@/lib/hooks";
import { buildRetailValueBreakdown } from "@/lib/retail-value";

const WAREHOUSE_COLOR = "hsl(120, 45%, 50%)";
const TRANSIT_COLOR = "hsl(45, 85%, 55%)";
const ON_ORDER_COLOR = "hsl(0, 65%, 70%)";

function formatDollars(n: number, compact = false) {
  if (compact || n >= 1_000_000) {
    if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `$${Math.round(n / 1000)}k`;
    return `$${Math.round(n)}`;
  }
  return `$${Math.round(n).toLocaleString()}`;
}

export function RetailValueSummaryBar() {
  // Six queries: inventory + factory_orders + freight to derive bucket
  // unit counts; sku_economics + sku_supplier_costs to derive real
  // per-SKU costs. Cash-outlay numbers below are computed from these
  // sources, not from the legacy retail × hardcoded-ratio estimate that
  // was here previously (RAW_RATIO=0.25 etc.) — that approach silently
  // fabricated cash numbers that drove planning decisions.
  const { data: inventory = [] } = useInventory();
  const { data: shipments = [] } = useFreightShipments();
  const { data: freightLines = [] } = useFreightLineItems();
  const { data: factoryOrders = [] } = useFactoryOrders();
  const { data: economicsById } = useAllSkuEconomics();
  const { data: primaryCostBySkuId } = useAllPrimarySkuSupplierCosts();

  const {
    total,
    warehouse,
    transit,
    onOrder,
    cashWarehouse,
    cashTransit,
    cashOnOrder,
    totalCash,
    skusMissingCost,
  } = useMemo(
    () =>
      buildRetailValueBreakdown(
        inventory,
        shipments,
        freightLines,
        factoryOrders,
        economicsById,
        primaryCostBySkuId,
      ),
    [inventory, shipments, freightLines, factoryOrders, economicsById, primaryCostBySkuId],
  );

  const warehousePct = total > 0 ? (warehouse / total) * 100 : 0;
  const transitPct = total > 0 ? (transit / total) * 100 : 0;
  const onOrderPct = total > 0 ? (onOrder / total) * 100 : 0;

  return (
    <div className="space-y-4">
      <div className="flex items-baseline gap-3">
        <span className="text-sm font-medium text-muted-foreground">Total Retail Value</span>
        <span className="text-3xl font-bold tabular-nums tracking-tight">
          {formatDollars(total)}
        </span>
      </div>
      <div className="flex items-baseline gap-3 -mt-2">
        <span className="text-xs font-medium text-muted-foreground">Total Cash Outlay</span>
        <span className="text-lg font-bold tabular-nums tracking-tight text-amber-400">
          {formatDollars(totalCash)}
        </span>
        {/* Surface the integrity of the cash number. If any in-stock SKU
            is missing economics data, its contribution is zero — the
            displayed cash is a lower bound, and the operator needs to
            know which SKUs to populate. */}
        {skusMissingCost > 0 && (
          <span
            className="text-[11px] text-amber-400/70"
            title="These SKUs have inventory but no sku_economics row; their cash contribution is excluded. Add costs on each SKU's detail page."
          >
            ({skusMissingCost} SKU{skusMissingCost === 1 ? "" : "s"} missing cost data)
          </span>
        )}
      </div>

      <div className="relative">
        <div className="flex h-10 w-full overflow-hidden rounded-lg">
          {warehousePct > 0 && (
            <div
              className="flex items-center justify-center text-xs font-semibold text-white transition-all"
              style={{ width: `${warehousePct}%`, backgroundColor: WAREHOUSE_COLOR, minWidth: warehousePct > 3 ? undefined : "48px" }}
            >
              {formatDollars(warehouse)}
            </div>
          )}
          {transitPct > 0 && (
            <div
              className="flex items-center justify-center text-xs font-semibold text-white transition-all"
              style={{ width: `${transitPct}%`, backgroundColor: TRANSIT_COLOR, minWidth: transitPct > 3 ? undefined : "48px" }}
            >
              {formatDollars(transit)}
            </div>
          )}
          {onOrderPct > 0 && (
            <div
              className="flex items-center justify-center text-xs font-semibold text-white transition-all"
              style={{ width: `${onOrderPct}%`, backgroundColor: ON_ORDER_COLOR, minWidth: onOrderPct > 3 ? undefined : "48px" }}
            >
              {formatDollars(onOrder)}
            </div>
          )}
        </div>

        <div className="flex justify-between mt-1.5 text-[10px] text-muted-foreground/50 tabular-nums px-0.5">
          <span>$0</span>
          <span>{formatDollars(total * 0.25, true)}</span>
          <span>{formatDollars(total * 0.5, true)}</span>
          <span>{formatDollars(total * 0.75, true)}</span>
          <span>{formatDollars(total, true)}</span>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <div className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: WAREHOUSE_COLOR }} />
            <span className="text-xs text-muted-foreground">In Warehouse</span>
          </div>
          <p className="text-lg font-bold tabular-nums">{formatDollars(warehouse)}</p>
          <p className="text-[11px] text-muted-foreground tabular-nums">{Math.round(warehousePct)}% of total</p>
          <p className="text-[11px] text-amber-400/80 tabular-nums">{formatDollars(cashWarehouse)} cash</p>
        </div>
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <div className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: TRANSIT_COLOR }} />
            <span className="text-xs text-muted-foreground">In Transit</span>
          </div>
          <p className="text-lg font-bold tabular-nums">{formatDollars(transit)}</p>
          <p className="text-[11px] text-muted-foreground tabular-nums">{Math.round(transitPct)}% of total</p>
          <p className="text-[11px] text-amber-400/80 tabular-nums">{formatDollars(cashTransit)} cash</p>
        </div>
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <div className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: ON_ORDER_COLOR }} />
            <span className="text-xs text-muted-foreground">On Order</span>
          </div>
          <p className="text-lg font-bold tabular-nums">{formatDollars(onOrder)}</p>
          <p className="text-[11px] text-muted-foreground tabular-nums">{Math.round(onOrderPct)}% of total</p>
          <p className="text-[11px] text-amber-400/80 tabular-nums">{formatDollars(cashOnOrder)} cash</p>
        </div>
      </div>
    </div>
  );
}
