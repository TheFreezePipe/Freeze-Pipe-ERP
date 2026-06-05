import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { InventoryProjectionChart } from "./InventoryProjectionChart";
import { Button } from "@/components/ui/button";
import { computeDOS } from "@/lib/inventory-math";
import { getEffectiveDemand } from "@/lib/demand";
import {
  buildInTransitMap,
  buildOnOrderMap,
  inventoryTotalsReal,
} from "@/lib/inventory-aggregates";
import type { ProductSKU, InventoryLevel } from "@/types/database";
import { useAuth } from "@/lib/auth-context";
import {
  useUpdateProduct,
  useArchiveSKU,
  useArchiveSKUForce,
  useRestoreSKU,
  useDemandOverride,
  useSetDemandOverride,
  useFreightShipments,
  useFreightLineItems,
  useFactoryOrders,
  useSkuForecastMap,
  useForecastDemandMap,
} from "@/lib/hooks";
import { useState, useMemo } from "react";
import { Warehouse, Ship, Factory, EyeOff, Eye, Check, Archive, ArchiveRestore, AlertTriangle } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Input as InputBase } from "@/components/ui/input";

interface Props {
  product: ProductSKU;
  inventory: InventoryLevel;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SKUDetailModal({ product, inventory, open, onOpenChange }: Props) {
  const { isAdmin, profile } = useAuth();
  const updateProduct = useUpdateProduct();
  const archiveSKU = useArchiveSKU();
  const archiveSKUForce = useArchiveSKUForce();
  const restoreSKU = useRestoreSKU();
  const { data: currentOverride } = useDemandOverride(product.id);
  const setDemandOverrideMut = useSetDemandOverride();
  // Live-data derivations for the per-SKU In Transit + On Order cards. The
  // legacy `inventory_levels.in_transit_* / nancy_* / yx_*` columns that
  // `computeInventoryTotals` read are no longer maintained post-supplier-portal;
  // pull from freight_shipments + factory_orders directly instead.
  const { data: shipments = [] } = useFreightShipments();
  const { data: freightLines = [] } = useFreightLineItems();
  const { data: factoryOrders = [] } = useFactoryOrders();
  const forecastRowMap = useSkuForecastMap();
  const forecastMap = useForecastDemandMap();
  const totals = useMemo(() => {
    const inTransitMap = buildInTransitMap(shipments, freightLines);
    const onOrderMap = buildOnOrderMap(factoryOrders, freightLines);
    return inventoryTotalsReal(inventory, inTransitMap, onOrderMap);
  }, [inventory, shipments, freightLines, factoryOrders]);
  const forecastData = forecastRowMap.get(product.id);
  // Order of precedence: demand override > forecast > monthly_demand baseline.
  const effectiveDemand =
    currentOverride?.monthly_demand
    ?? getEffectiveDemand(product.id, product.monthly_demand, forecastMap);
  const [forecastOverride, setForecastOverride] = useState<string>(
    currentOverride?.monthly_demand != null ? String(currentOverride.monthly_demand) : "",
  );
  const savedOverride = currentOverride?.monthly_demand;
  const [isActive, setIsActive] = useState(product.is_active);
  // Source-of-truth for "archived" is product_skus.archived_at IS NOT NULL —
  // matches the dashboard's filter and the archive_sku() RPC's contract.
  // Falls back to !is_active for any rare row that pre-dates migration 008.
  const productArchivedAt = (product as ProductSKU & { archived_at?: string | null }).archived_at ?? null;
  const [archived, setArchived] = useState(!!productArchivedAt || !product.is_active);
  const [archiveDialogOpen, setArchiveDialogOpen] = useState(false);
  const [archiveReason, setArchiveReason] = useState("");
  const [archiveForceOpen, setArchiveForceOpen] = useState(false);
  const [archiveOnHand, setArchiveOnHand] = useState<number | null>(null);

  const parsedOverride = forecastOverride.trim() === "" ? null : (parseInt(forecastOverride, 10) || null);
  const overrideDirty = parsedOverride !== (savedOverride ?? null);

  async function handleSaveOverride() {
    if (!profile?.id) return;
    if (parsedOverride !== null && (parsedOverride < 0 || !Number.isInteger(parsedOverride))) return;
    // Writes to the demand_overrides table (separate from the baseline
    // monthly_demand on product_skus). Clears the row when set to null.
    await setDemandOverrideMut.mutateAsync({
      skuId: product.id,
      monthlyDemand: parsedOverride,
      actorId: profile.id,
    });
  }

  async function handleArchiveConfirm() {
    if (!profile?.id) return;
    const onHand = totals.warehouseTotal;
    // Client-side fast path: skip the RPC roundtrip and surface the
    // friendlier "force?" dialog when there's known on-hand stock. The
    // RPC also enforces this server-side as a safety net.
    if (onHand > 0) {
      setArchiveOnHand(onHand);
      setArchiveDialogOpen(false);
      setArchiveForceOpen(true);
      return;
    }
    await archiveSKU.mutateAsync({
      skuId: product.id,
      actorId: profile.id,
      reason: archiveReason.trim() || "(no reason provided)",
    });
    setArchived(true);
    setIsActive(false);
    setArchiveDialogOpen(false);
    setArchiveReason("");
  }

  async function handleArchiveForce() {
    if (!profile?.id) return;
    await archiveSKUForce.mutateAsync({
      skuId: product.id,
      actorId: profile.id,
      reason: archiveReason.trim() || "(forced — on-hand stock present)",
    });
    setArchived(true);
    setIsActive(false);
    setArchiveForceOpen(false);
    setArchiveReason("");
    setArchiveOnHand(null);
  }

  async function handleRestore() {
    if (!profile?.id) return;
    await restoreSKU.mutateAsync({
      skuId: product.id,
      actorId: profile.id,
    });
    setArchived(false);
    setIsActive(true);
  }

  // Honor a literal `0` override — operators use it for discontinued SKUs
  // they expect zero demand on, and the DOS calc beneath should then read
  // ∞ (no consumption), not the baseline. Previous `parseInt(x) || baseline`
  // pattern silently swallowed 0 because it's falsy.
  const forecastValue = (() => {
    if (!forecastOverride.trim()) return effectiveDemand;
    const parsed = parseInt(forecastOverride, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : effectiveDemand;
  })();

  function dosColor(dos: number) {
    if (dos < 15) return "text-red-400";
    if (dos < 30) return "text-yellow-400";
    if (dos < 60) return "text-green-400";
    return "text-muted-foreground";
  }

  const warehouseDOS = computeDOS(totals.warehouseTotal, forecastValue);
  const transitDOS = computeDOS(totals.transitTotal, forecastValue);
  const onOrderDOS = computeDOS(totals.onOrderTotal, forecastValue);
  const overallDOS = computeDOS(totals.totalUnits, forecastValue);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <DialogTitle className="text-lg">{product.sku}</DialogTitle>
            <Badge variant="outline" className={product.category === "fillable" ? "border-blue-500 text-blue-400" : "border-muted text-muted-foreground"}>
              {product.category === "fillable" ? "Fillable" : "Non-Fillable"}
            </Badge>
            <Badge variant="outline" className={
              product.abc_classification === "A" ? "border-green-500 text-green-400" :
              product.abc_classification === "B" ? "border-yellow-500 text-yellow-400" :
              "border-muted text-muted-foreground"
            }>
              {product.abc_classification}
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground">{product.product_name}</p>
        </DialogHeader>

        {/* Inventory summary cards */}
        <div className="grid grid-cols-3 gap-3">
          <Card>
            <CardContent className="p-3 text-center">
              <Warehouse className="h-4 w-4 mx-auto mb-1 text-green-400" />
              <p className="text-xs text-muted-foreground">Warehouse</p>
              <p className="text-lg font-bold">{totals.warehouseTotal.toLocaleString()}</p>
              <p className={`text-xs font-medium ${dosColor(warehouseDOS)}`}>{warehouseDOS}d</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-3 text-center">
              <Ship className="h-4 w-4 mx-auto mb-1 text-blue-400" />
              <p className="text-xs text-muted-foreground">In Transit</p>
              <p className="text-lg font-bold">{totals.transitTotal.toLocaleString()}</p>
              <p className={`text-xs font-medium ${dosColor(transitDOS)}`}>{transitDOS}d</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-3 text-center">
              <Factory className="h-4 w-4 mx-auto mb-1 text-orange-400" />
              <p className="text-xs text-muted-foreground">On Order</p>
              <p className="text-lg font-bold">{totals.onOrderTotal.toLocaleString()}</p>
              <p className={`text-xs font-medium ${dosColor(onOrderDOS)}`}>{onOrderDOS}d</p>
            </CardContent>
          </Card>
        </div>

        {/* Demand section */}
        <div className="space-y-2">
          <h3 className="text-sm font-medium">Monthly Demand</h3>
          <div className="grid grid-cols-3 gap-4">
            <div>
              <Label className="text-xs text-muted-foreground">ShipStation (30-day trailing)</Label>
              <p className="text-lg font-bold tabular-nums">{product.monthly_demand}/mo</p>
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">
                Forecast
                {forecastData && <span className="ml-1 text-blue-400">(auto)</span>}
              </Label>
              <p className="text-lg font-bold tabular-nums">
                {forecastData ? (
                  <span>
                    {forecastData.forecast_30d}/mo
                    <span className="text-xs text-muted-foreground ml-1">
                      ({forecastData.lower_bound}-{forecastData.upper_bound})
                    </span>
                  </span>
                ) : (
                  <span className="text-muted-foreground">-</span>
                )}
              </p>
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">Override</Label>
              {isAdmin ? (
                <div className="flex items-center gap-1.5 mt-1">
                  <Input
                    type="number"
                    value={forecastOverride}
                    onChange={e => setForecastOverride(e.target.value)}
                    placeholder={effectiveDemand.toString()}
                    className="h-8"
                  />
                  <Button
                    type="button"
                    size="icon"
                    variant="outline"
                    className="h-8 w-8 shrink-0"
                    disabled={!overrideDirty}
                    onClick={handleSaveOverride}
                    title="Save override"
                  >
                    <Check className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ) : (
                <p className="text-lg font-bold tabular-nums">
                  {savedOverride ? `${savedOverride}/mo` : <span className="text-muted-foreground">-</span>}
                </p>
              )}
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Overall DOS: <span className={`font-medium ${dosColor(overallDOS)}`}>{overallDOS} days</span>
            {" "} ({totals.totalUnits.toLocaleString()} total units)
          </p>
        </div>

        <Separator />

        {/* 90-day projection chart */}
        <div className="space-y-2">
          <h3 className="text-sm font-medium">90-Day Inventory Projection</h3>
          <p className="text-xs text-muted-foreground">
            Total warehouse units (raw + prefilled-raw + WIP + finished + other): 30 days history + 60 days projected (based on {forecastValue}/mo{forecastData ? " forecast" : ""} demand)
          </p>
          <InventoryProjectionChart
            product={product}
            inventory={inventory}
            demandOverride={forecastValue !== product.monthly_demand ? forecastValue : undefined}
          />
          <div className="flex items-center gap-4 text-xs text-muted-foreground flex-wrap">
            <div className="flex items-center gap-1.5">
              <div className="h-2 w-4 rounded bg-[hsl(189,94%,56%)]" />
              Historical (actual)
            </div>
            <div className="flex items-center gap-1.5">
              <div className="h-2 w-4 rounded bg-[hsl(270,67%,56%)] opacity-60" style={{ backgroundImage: "repeating-linear-gradient(90deg, transparent, transparent 3px, hsl(270,67%,56%) 3px, hsl(270,67%,56%) 6px)" }} />
              Projected
            </div>
            <div className="flex items-center gap-1.5">
              <div className="h-0.5 w-4 bg-[hsl(0,0%,75%)]" style={{ backgroundImage: "repeating-linear-gradient(90deg, transparent, transparent 2px, hsl(0,0%,75%) 2px, hsl(0,0%,75%) 4px)" }} />
              Today
            </div>
            <div className="flex items-center gap-1.5">
              <div className="h-0.5 w-4 bg-[hsl(142,71%,45%)]" style={{ backgroundImage: "repeating-linear-gradient(90deg, transparent, transparent 2px, hsl(142,71%,45%) 2px, hsl(142,71%,45%) 4px)" }} />
              Freight ETA
            </div>
            <div className="flex items-center gap-1.5">
              <div className="h-0.5 w-4 bg-red-500" style={{ backgroundImage: "repeating-linear-gradient(90deg, transparent, transparent 2px, hsl(0,70%,50%) 2px, hsl(0,70%,50%) 4px)" }} />
              Reorder Point
            </div>
          </div>
        </div>

        {/* Warehouse breakdown */}
        <div className="space-y-2">
          <h3 className="text-sm font-medium">Warehouse Breakdown</h3>
          <div className="grid grid-cols-5 gap-2 text-center text-xs">
            <div className="rounded-md bg-muted/50 p-2">
              <p className="text-muted-foreground">Raw</p>
              <p className="text-base font-bold">{inventory.warehouse_raw}</p>
            </div>
            <div className="rounded-md bg-muted/50 p-2">
              <p className="text-muted-foreground">Pre-filled</p>
              <p className="text-base font-bold text-cyan-400">{inventory.warehouse_prefilled_raw ?? 0}</p>
            </div>
            <div className="rounded-md bg-muted/50 p-2">
              <p className="text-muted-foreground">WIP</p>
              <p className="text-base font-bold">{inventory.warehouse_in_production}</p>
            </div>
            <div className="rounded-md bg-muted/50 p-2">
              <p className="text-muted-foreground">Finished</p>
              <p className="text-base font-bold text-green-400">{inventory.warehouse_finished}</p>
            </div>
            <div className="rounded-md bg-muted/50 p-2">
              <p className="text-muted-foreground">Other</p>
              <p className="text-base font-bold">{inventory.warehouse_other || "-"}</p>
            </div>
          </div>
        </div>

        {/* Admin actions: archive + legacy deactivate */}
        {isAdmin && (
          <div className="pt-2 border-t border-border/50 flex items-center gap-4">
            {archived ? (
              <Button
                variant="ghost"
                size="sm"
                className="text-amber-400 hover:text-green-400"
                onClick={handleRestore}
              >
                <ArchiveRestore className="mr-1.5 h-3.5 w-3.5" />
                Restore from archive
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground/60 hover:text-amber-400"
                onClick={() => setArchiveDialogOpen(true)}
              >
                <Archive className="mr-1.5 h-3.5 w-3.5" />
                Archive SKU
              </Button>
            )}
            {!archived && (
              <Button
                variant="ghost"
                size="sm"
                className={isActive ? "text-muted-foreground/60 hover:text-red-400" : "text-red-400 hover:text-green-400"}
                onClick={async () => {
                  const newState = !isActive;
                  setIsActive(newState);
                  await updateProduct.mutateAsync({ id: product.id, updates: { is_active: newState } });
                }}
              >
                {isActive ? (
                  <><EyeOff className="mr-1.5 h-3.5 w-3.5" />Deactivate</>
                ) : (
                  <><Eye className="mr-1.5 h-3.5 w-3.5" />Reactivate</>
                )}
              </Button>
            )}
          </div>
        )}

        {/* Archive confirmation dialog */}
        <AlertDialog open={archiveDialogOpen} onOpenChange={setArchiveDialogOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Archive {product.sku}?</AlertDialogTitle>
              <AlertDialogDescription asChild>
                <div className="space-y-2 text-sm">
                  <p>
                    Archiving hides this SKU from default inventory views while preserving all historical
                    data (transactions, audit trail, cost history). You can restore it at any time.
                  </p>
                  <p className="text-xs text-muted-foreground">
                    The system will refuse if there are on-hand units. Move stock to <em>Other</em> or
                    log breakage via cycle count first.
                  </p>
                  <div className="pt-2">
                    <label className="text-xs text-muted-foreground">Reason</label>
                    <InputBase
                      value={archiveReason}
                      onChange={e => setArchiveReason(e.target.value)}
                      placeholder="e.g. Discontinued by supplier"
                      className="h-8 mt-1"
                    />
                  </div>
                </div>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={handleArchiveConfirm}>Archive</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {/* Force archive dialog — fires when the normal path refuses because of on-hand stock */}
        <AlertDialog open={archiveForceOpen} onOpenChange={setArchiveForceOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle className="flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-red-400" />
                Force-archive {product.sku}?
              </AlertDialogTitle>
              <AlertDialogDescription asChild>
                <div className="space-y-2 text-sm">
                  <p>
                    This SKU still has <strong className="text-red-400">{archiveOnHand?.toLocaleString()} units</strong> on hand.
                    Archiving now leaves orphaned inventory that won't appear in default views.
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Only continue if you're writing this stock off as part of a discontinuation. The
                    action is logged in the audit trail with the <code>sku_archived_force</code> type.
                  </p>
                </div>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel onClick={() => { setArchiveForceOpen(false); setArchiveOnHand(null); }}>
                Cancel
              </AlertDialogCancel>
              <AlertDialogAction onClick={handleArchiveForce} className="bg-red-500 hover:bg-red-600">
                Force archive
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </DialogContent>
    </Dialog>
  );
}
