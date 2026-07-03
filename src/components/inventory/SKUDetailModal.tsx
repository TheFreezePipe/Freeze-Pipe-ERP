import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
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
import { useState, useMemo, useEffect } from "react";
import { FORECAST_HIGH_VOLUME_MONTHLY } from "@/lib/hooks/use-forecasts";
import type { DemandSourceMode } from "@/lib/hooks/use-demand-overrides";
import { Warehouse, Ship, Factory, Boxes, Check, Archive, ArchiveRestore, AlertTriangle } from "lucide-react";
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
  const archiveSKU = useArchiveSKU();
  const archiveSKUForce = useArchiveSKUForce();
  const restoreSKU = useRestoreSKU();
  const { data: currentOverride } = useDemandOverride(product.id);
  const setDemandOverrideMut = useSetDemandOverride();
  // Live-data derivations for the per-SKU In Transit + On Order cards,
  // pulled from freight_shipments + factory_orders (the legacy
  // inventory_levels.in_transit_*/nancy_*/yx_* columns were dropped in
  // migration 041).
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
  // The shared map already resolves pins (manual/trailing/forecast) and the
  // auto chain — this is the value every other surface sees for this SKU.
  const effectiveDemand = getEffectiveDemand(product.id, product.monthly_demand, forecastMap);
  // Demand-source picker state: selectedMode mirrors the saved pin;
  // manualInput previews unsaved typing before commit.
  const savedMode: DemandSourceMode | "auto" = currentOverride?.mode ?? "auto";
  const [selectedMode, setSelectedMode] = useState<DemandSourceMode | "auto">(savedMode);
  const [manualInput, setManualInput] = useState<string>(
    currentOverride?.mode === "manual" && currentOverride.monthly_demand != null
      ? String(currentOverride.monthly_demand)
      : "",
  );
  useEffect(() => {
    setSelectedMode(currentOverride?.mode ?? "auto");
    setManualInput(
      currentOverride?.mode === "manual" && currentOverride.monthly_demand != null
        ? String(currentOverride.monthly_demand)
        : "",
    );
  }, [currentOverride]);
  // Source-of-truth for "archived" is product_skus.archived_at IS NOT NULL —
  // matches the dashboard's filter and the archive_sku() RPC's contract.
  // Falls back to !is_active for any rare row that pre-dates migration 008.
  const productArchivedAt = (product as ProductSKU & { archived_at?: string | null }).archived_at ?? null;
  const [archived, setArchived] = useState(!!productArchivedAt || !product.is_active);
  const [archiveDialogOpen, setArchiveDialogOpen] = useState(false);
  const [archiveReason, setArchiveReason] = useState("");
  const [archiveForceOpen, setArchiveForceOpen] = useState(false);
  const [archiveOnHand, setArchiveOnHand] = useState<number | null>(null);

  const parsedManual = manualInput.trim() === "" ? null : parseInt(manualInput, 10);
  const manualValid = parsedManual != null && Number.isInteger(parsedManual) && parsedManual >= 0;
  const manualDirty =
    selectedMode === "manual" &&
    (savedMode !== "manual" || parsedManual !== (currentOverride?.monthly_demand ?? null));

  // Picking Auto / Trailing / Forecast saves immediately; Manual arms the
  // input and commits via the check button once a valid number is entered.
  async function handlePickSource(mode: DemandSourceMode | "auto") {
    if (!isAdmin || !profile?.id) return;
    setSelectedMode(mode);
    if (mode === "manual") return; // committed via handleSaveManual
    if (mode === savedMode) return;
    await setDemandOverrideMut.mutateAsync({ skuId: product.id, mode, actorId: profile.id });
  }
  async function handleSaveManual() {
    if (!profile?.id || !manualValid) return;
    await setDemandOverrideMut.mutateAsync({
      skuId: product.id,
      mode: "manual",
      monthlyDemand: parsedManual,
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
  }

  // Demand preview for the DOS tiles + projection chart below: reflects the
  // SELECTED (possibly unsaved) source so the operator sees the effect
  // before committing. A literal 0 is honored (discontinued SKUs → DOS ∞).
  const trailingValue = product.monthly_demand ?? 0;
  const autoValue =
    forecastData && (forecastData.forecast_30d ?? 0) >= FORECAST_HIGH_VOLUME_MONTHLY
      ? forecastData.forecast_30d
      : trailingValue;
  const forecastValue = (() => {
    switch (selectedMode) {
      case "trailing":
        return trailingValue;
      case "forecast":
        return forecastData?.forecast_30d ?? trailingValue;
      case "manual":
        return manualValid ? parsedManual : (currentOverride?.monthly_demand ?? effectiveDemand);
      default:
        return autoValue;
    }
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
              {product.abc_classification ?? "—"}
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground">{product.product_name}</p>
        </DialogHeader>

        {/* Inventory summary cards */}
        <div className="grid grid-cols-4 gap-3">
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
          <Card className="border-primary/30">
            <CardContent className="p-3 text-center">
              <Boxes className="h-4 w-4 mx-auto mb-1 text-purple-400" />
              <p className="text-xs text-muted-foreground">Overall</p>
              <p className="text-lg font-bold">{totals.totalUnits.toLocaleString()}</p>
              <p className={`text-xs font-medium ${dosColor(overallDOS)}`}>{overallDOS}d</p>
            </CardContent>
          </Card>
        </div>

        {/* Demand source picker — pins which number drives this SKU's demand
            EVERYWHERE (DOS, order builder, auto-allocator, alerts, pipeline
            priority, daily report), not just this modal. */}
        <div className="space-y-2">
          <div className="flex items-baseline justify-between gap-3 flex-wrap">
            <h3 className="text-sm font-medium">Monthly Demand — source</h3>
            <span className="text-[11px] text-muted-foreground">
              {isAdmin ? "Click a card to pin the source for this SKU" : "Source is set by admins"}
            </span>
          </div>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
            {/* Auto */}
            <button
              type="button"
              onClick={() => handlePickSource("auto")}
              disabled={!isAdmin}
              className={`rounded-lg border p-3 text-left transition-colors ${
                selectedMode === "auto"
                  ? "border-primary bg-primary/5 ring-1 ring-primary"
                  : "border-border hover:bg-muted/40"
              } ${!isAdmin ? "cursor-default" : ""}`}
            >
              <div className="flex items-center justify-between gap-1">
                <span className="text-xs font-medium">Auto</span>
                {savedMode === "auto" && (
                  <Badge variant="outline" className="text-[9px] py-0 border-green-500/40 text-green-400">active</Badge>
                )}
              </div>
              <p className="text-lg font-bold tabular-nums">{autoValue}/mo</p>
              <p className="text-[10px] text-muted-foreground leading-snug">
                Forecast when trusted (≥{FORECAST_HIGH_VOLUME_MONTHLY}/mo), else trailing
              </p>
            </button>

            {/* Trailing 30d */}
            <button
              type="button"
              onClick={() => handlePickSource("trailing")}
              disabled={!isAdmin}
              className={`rounded-lg border p-3 text-left transition-colors ${
                selectedMode === "trailing"
                  ? "border-primary bg-primary/5 ring-1 ring-primary"
                  : "border-border hover:bg-muted/40"
              } ${!isAdmin ? "cursor-default" : ""}`}
            >
              <div className="flex items-center justify-between gap-1">
                <span className="text-xs font-medium">Trailing 30d</span>
                {savedMode === "trailing" && (
                  <Badge variant="outline" className="text-[9px] py-0 border-green-500/40 text-green-400">active</Badge>
                )}
              </div>
              <p className="text-lg font-bold tabular-nums">{trailingValue}/mo</p>
              <p className="text-[10px] text-muted-foreground leading-snug">
                ShipStation actuals · updates nightly
              </p>
            </button>

            {/* Forecast */}
            <button
              type="button"
              onClick={() => handlePickSource("forecast")}
              disabled={!isAdmin || !forecastData}
              className={`rounded-lg border p-3 text-left transition-colors ${
                selectedMode === "forecast"
                  ? "border-primary bg-primary/5 ring-1 ring-primary"
                  : "border-border hover:bg-muted/40"
              } ${!isAdmin || !forecastData ? "cursor-default opacity-70" : ""}`}
            >
              <div className="flex items-center justify-between gap-1">
                <span className="text-xs font-medium">Forecast</span>
                {savedMode === "forecast" && (
                  <Badge variant="outline" className="text-[9px] py-0 border-green-500/40 text-green-400">active</Badge>
                )}
              </div>
              <p className="text-lg font-bold tabular-nums">
                {forecastData ? (
                  <>
                    {forecastData.forecast_30d}/mo
                    <span className="text-xs text-muted-foreground ml-1 font-normal">
                      ({forecastData.lower_bound}-{forecastData.upper_bound})
                    </span>
                  </>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </p>
              <p className="text-[10px] text-muted-foreground leading-snug">
                {forecastData
                  ? (forecastData.forecast_30d ?? 0) >= FORECAST_HIGH_VOLUME_MONTHLY
                    ? "Engine · updates weekly"
                    : "Engine · below trust gate — pin to use anyway"
                  : "No forecast for this SKU yet"}
              </p>
            </button>

            {/* Manual */}
            <div
              role="button"
              tabIndex={isAdmin ? 0 : -1}
              onClick={() => handlePickSource("manual")}
              className={`rounded-lg border p-3 text-left transition-colors ${
                selectedMode === "manual"
                  ? "border-primary bg-primary/5 ring-1 ring-primary"
                  : "border-border hover:bg-muted/40"
              } ${!isAdmin ? "cursor-default" : "cursor-pointer"}`}
            >
              <div className="flex items-center justify-between gap-1">
                <span className="text-xs font-medium">Manual</span>
                {savedMode === "manual" && (
                  <Badge variant="outline" className="text-[9px] py-0 border-green-500/40 text-green-400">active</Badge>
                )}
              </div>
              {isAdmin ? (
                <div className="flex items-center gap-1.5 mt-1" onClick={(e) => e.stopPropagation()}>
                  <Input
                    type="number"
                    min={0}
                    value={manualInput}
                    onChange={(e) => { setManualInput(e.target.value); setSelectedMode("manual"); }}
                    placeholder={String(effectiveDemand ?? 0)}
                    className="h-8"
                  />
                  <Button
                    type="button"
                    size="icon"
                    variant="outline"
                    className="h-8 w-8 shrink-0"
                    disabled={!manualValid || !manualDirty || setDemandOverrideMut.isPending}
                    onClick={handleSaveManual}
                    title="Save manual demand"
                  >
                    <Check className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ) : (
                <p className="text-lg font-bold tabular-nums">
                  {currentOverride?.mode === "manual" && currentOverride.monthly_demand != null
                    ? `${currentOverride.monthly_demand}/mo`
                    : <span className="text-muted-foreground">—</span>}
                </p>
              )}
              <p className="text-[10px] text-muted-foreground leading-snug mt-1">
                Your number until you change it
              </p>
            </div>
          </div>
        </div>

        <Separator />

        {/* 90-day projection chart */}
        <div className="space-y-2">
          <h3 className="text-sm font-medium">90-Day Inventory Projection</h3>
          <p className="text-xs text-muted-foreground">
            Total warehouse units (raw + prefilled-raw + WIP + finished + other): 30 days history + 60 days projected (based on {forecastValue}/mo demand from the selected source)
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

        {/* Admin actions: archive / restore. (The legacy Deactivate flip
            was removed 2026-06-10 — Archive is the single retire path:
            audited, reasoned, stock-guarded, and reversible via Restore.) */}
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
