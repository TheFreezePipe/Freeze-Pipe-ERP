import { useParams, useNavigate } from "react-router-dom";
import { useState, useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ArrowLeft,
  Boxes,
  CalendarClock,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  DollarSign,
  ExternalLink,
  FileText,
  MoreVertical,
  Package,
  Pencil,
  Plane,
  RefreshCw,
  Ship,
  ShieldAlert,
  X,
} from "lucide-react";
import { FREIGHT_TYPES } from "@/lib/constants";
import { format, parseISO, formatDistanceToNow, addDays } from "date-fns";
import { cn } from "@/lib/utils";
import { useShipmentTracking } from "@/lib/tracking/use-shipment-tracking";
import { etaDriftDays } from "@/lib/tracking/reconcile";
import { getCarrierTrackingUrl } from "@/lib/tracking/carrier-urls";
import { StatusSelectWithOverride } from "@/components/freight/StatusSelectWithOverride";
import { ShipmentStepper } from "@/components/freight/ShipmentStepper";
import { ShipmentManifest } from "@/components/freight/ShipmentManifest";
import { isReceivingActive } from "@/lib/freight/receiving";
import { CloseShortDialog } from "@/components/freight/CloseShortDialog";
import {
  useFreightShipment,
  useFreightLineItems,
  useUpdateFreightShipment,
  useFactoryOrders,
  useCartonGroups,
} from "@/lib/hooks";
import { useAuth } from "@/lib/auth-context";

// ---------------------------------------------------------------------------
// FreightDetail — owner-approved prototype layout (2026-07):
//   1. Header band: number + type + status chip + derived receiving chip;
//      carrier · tracking (copyable) · shipped subline; override/refresh
//      affordances on the right.
//   2. Metric cards: cartons, units, ETA (with drift chip), total cost.
//   3. Horizontal stepper (Created → Shipped → Customs → Ground → Received)
//      with the collapsed scan history beneath it.
//   4. Dock check-in banner + 5. manifest table (ShipmentManifest — replaces
//      the old ReceivingPanel and Line Items card).
//   6. Cost strip with expandable breakdown + close-short escape hatch.
// ---------------------------------------------------------------------------

/** Whole-dollar money for the strip + metric card ("$12,340"). */
function fmtUsd(n: number): string {
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

export default function FreightDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { isAdmin, isManager } = useAuth();
  const canEdit = isAdmin || isManager;

  const { data: shipment, isLoading: shipmentLoading } = useFreightShipment(id ?? "");
  const { data: lineItemsRaw = [], isLoading: lineItemsLoading } = useFreightLineItems(id);
  const { data: groups = [], isLoading: groupsLoading } = useCartonGroups(id ?? "");
  // Factory orders — needed to derive the manifest's "From order" links from
  // each line item's source_factory_order_item_id. Building a tiny lookup map
  // below is cheaper than per-row hooks.
  const { data: factoryOrders = [] } = useFactoryOrders();
  const foItemIdToOrder = useMemo(() => {
    const map = new Map<string, { id: string; number: string | null }>();
    for (const order of factoryOrders) {
      for (const item of order.items ?? []) {
        map.set(item.id, { id: order.id, number: order.order_number });
      }
    }
    return map;
  }, [factoryOrders]);

  const tracking = useShipmentTracking(shipment);
  const updateShipment = useUpdateFreightShipment();

  // Inline edits for carrier_name + tracking_number — same pencil → input
  // → check (save) / x (cancel) pattern as SKUDetail. Empty input clears
  // the field to NULL (rather than persisting empty string), letting
  // operators undo a previous entry. Errors surface inline next to the
  // input so the user sees them without scrolling.
  const [editingCarrier, setEditingCarrier] = useState(false);
  const [carrierDraft, setCarrierDraft] = useState("");
  const [carrierError, setCarrierError] = useState<string | null>(null);
  const [editingTracking, setEditingTracking] = useState(false);
  const [trackingDraft, setTrackingDraft] = useState("");
  const [trackingError, setTrackingError] = useState<string | null>(null);
  // Inline edit for freight_cost — same pencil pattern, but parses to a
  // number. Empty input clears to NULL so the cost-breakdown row falls
  // back to "$0" rather than a literal zero (matches the convention used
  // by the supplier-portal RPC's `p_clear_freight_cost` flag).
  const [editingCost, setEditingCost] = useState(false);
  const [costDraft, setCostDraft] = useState("");
  const [costError, setCostError] = useState<string | null>(null);
  // Cost strip breakdown — collapsed one-liner by default.
  const [costOpen, setCostOpen] = useState(false);
  const [closeShortOpen, setCloseShortOpen] = useState(false);
  const [trackingCopied, setTrackingCopied] = useState(false);

  function startCarrierEdit() {
    setCarrierDraft(shipment?.carrier_name ?? "");
    setEditingCarrier(true);
    setCarrierError(null);
  }
  function cancelCarrierEdit() {
    setEditingCarrier(false);
    setCarrierDraft("");
    setCarrierError(null);
  }
  async function saveCarrierEdit() {
    if (!shipment) return;
    setCarrierError(null);
    const next = carrierDraft.trim();
    const nextValue = next === "" ? null : next;
    if (nextValue === (shipment.carrier_name ?? null)) {
      setEditingCarrier(false);
      return;
    }
    try {
      await updateShipment.mutateAsync({
        id: shipment.id,
        updates: { carrier_name: nextValue },
      });
      setEditingCarrier(false);
      setCarrierDraft("");
    } catch (err) {
      setCarrierError(err instanceof Error ? err.message : "Failed to save carrier");
    }
  }

  // China Customs Inspection: push the ETA out 7 days and flag the shipment.
  // Repeatable — each inspection adds another 7 days.
  async function markChinaCustomsInspection() {
    if (!shipment) return;
    if (!window.confirm("Log a China Customs Inspection?\n\nThis pushes the ETA out by 7 days and flags the shipment with a China Customs Delay marker.")) return;
    const base = shipment.eta ? parseISO(shipment.eta) : new Date();
    const newEta = format(addDays(base, 7), "yyyy-MM-dd");
    try {
      await updateShipment.mutateAsync({
        id: shipment.id,
        updates: { eta: newEta, china_customs_delay: true },
      });
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Failed to log inspection");
    }
  }

  function startTrackingEdit() {
    setTrackingDraft(shipment?.tracking_number ?? "");
    setEditingTracking(true);
    setTrackingError(null);
  }
  function cancelTrackingEdit() {
    setEditingTracking(false);
    setTrackingDraft("");
    setTrackingError(null);
  }
  async function saveTrackingEdit() {
    if (!shipment) return;
    setTrackingError(null);
    const next = trackingDraft.trim();
    const nextValue = next === "" ? null : next;
    if (nextValue === (shipment.tracking_number ?? null)) {
      setEditingTracking(false);
      return;
    }
    try {
      await updateShipment.mutateAsync({
        id: shipment.id,
        updates: { tracking_number: nextValue },
      });
      setEditingTracking(false);
      setTrackingDraft("");
    } catch (err) {
      setTrackingError(err instanceof Error ? err.message : "Failed to save tracking number");
    }
  }

  function startCostEdit() {
    setCostDraft(shipment?.freight_cost?.toString() ?? "");
    setEditingCost(true);
    setCostError(null);
  }
  function cancelCostEdit() {
    setEditingCost(false);
    setCostDraft("");
    setCostError(null);
  }
  async function saveCostEdit() {
    if (!shipment) return;
    setCostError(null);
    const trimmed = costDraft.trim();
    let nextValue: number | null;
    if (trimmed === "") {
      nextValue = null;
    } else {
      const n = parseFloat(trimmed);
      if (!Number.isFinite(n) || n < 0) {
        setCostError("Cost must be a non-negative number");
        return;
      }
      nextValue = n;
    }
    if (nextValue === (shipment.freight_cost ?? null)) {
      setEditingCost(false);
      return;
    }
    try {
      await updateShipment.mutateAsync({
        id: shipment.id,
        updates: { freight_cost: nextValue },
      });
      setEditingCost(false);
      setCostDraft("");
    } catch (err) {
      setCostError(err instanceof Error ? err.message : "Failed to save freight cost");
    }
  }

  async function copyTrackingNumber() {
    if (!shipment?.tracking_number) return;
    try {
      await navigator.clipboard.writeText(shipment.tracking_number);
      setTrackingCopied(true);
      window.setTimeout(() => setTrackingCopied(false), 1500);
    } catch {
      // Clipboard unavailable (permissions / non-secure context) — no-op.
    }
  }

  if (shipmentLoading || lineItemsLoading || groupsLoading) {
    return (
      <div className="flex items-center justify-center h-64 text-muted-foreground text-sm">
        Loading shipment…
      </div>
    );
  }

  if (!shipment) return <div className="p-8 text-muted-foreground">Shipment not found</div>;

  const drift = etaDriftDays(shipment);
  const isLate = drift > 0;
  const isEarly = drift < 0;
  const lastChecked = shipment.eta_last_checked_at;

  // Generated FreightShipment widens enums to plain string even though the
  // DB CHECKs narrow them; cast at the indexing sites.
  const typeInfo = FREIGHT_TYPES[shipment.freight_type as keyof typeof FREIGHT_TYPES];
  const isSea = shipment.freight_type === "sea";

  const catalogLines = lineItemsRaw.filter((l) => l.sku_id);
  const totalUnits = catalogLines.reduce((s, l) => s + l.quantity, 0);
  const receivedUnits = catalogLines.reduce((s, l) => s + (l.quantity_received ?? 0), 0);
  const cartonMode = groups.length > 0;
  const totalCartons = groups.reduce((s, g) => s + g.carton_qty, 0);
  const receivedCartons = groups.reduce((s, g) => s + g.received_cartons, 0);

  const isConfirmed = !!shipment.receipt_confirmed_at;
  const isClosedShort = !!shipment.closed_short_at;
  const receivingActive = isReceivingActive(shipment, lineItemsRaw);
  const hasReceivable = cartonMode || catalogLines.length > 0;
  const fullyDone = cartonMode
    ? totalCartons > 0 && receivedCartons >= totalCartons
    : totalUnits > 0 && receivedUnits >= totalUnits;
  const partiallyReceived = receivedUnits > 0 && !fullyDone;

  const totalCostLineItems = lineItemsRaw.reduce((s, li) => s + (li.unit_cost ?? 0) * li.quantity, 0);
  const totalRetailValue = lineItemsRaw.reduce((s, li) => s + (li.retail_value ?? 0) * li.quantity, 0);
  const freightCost = shipment.freight_cost ?? 0;
  const dutiesCost = shipment.duties_cost ?? 0;
  const insuranceCost = shipment.insurance_cost ?? 0;
  const totalLandedCost = freightCost + dutiesCost + insuranceCost;

  const trackingHref = getCarrierTrackingUrl(shipment.carrier_name, shipment.tracking_number);
  const showRefresh = shipment.status !== "delivered" && !!shipment.tracking_number;
  const showChinaCustoms = shipment.status !== "delivered";

  return (
    <div className="space-y-6">
      {/* ---- 1. Header band ------------------------------------------------ */}
      <div className="flex items-start gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate("/freight")}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2.5 flex-wrap">
            <h1 className="text-2xl font-bold">{shipment.shipment_number}</h1>
            <Badge variant="outline" className="text-xs gap-1">
              {isSea ? (
                <Ship className="h-3 w-3 text-blue-400" />
              ) : (
                <Plane className="h-3 w-3 text-cyan-400" />
              )}
              {typeInfo.label}
            </Badge>
            <StatusSelectWithOverride shipment={shipment} variant="compact" />
            {/* Derived receiving chip */}
            {isClosedShort ? (
              <Badge
                variant="outline"
                className="border-amber-500/50 text-amber-400 bg-amber-500/10"
                title={`Closed short ${format(parseISO(shipment.closed_short_at!), "MMM d, yyyy")}${shipment.closed_short_reason ? ` — ${shipment.closed_short_reason}` : ""}`}
              >
                Closed short
              </Badge>
            ) : isConfirmed ? (
              <Badge
                variant="outline"
                className="border-green-500/50 text-green-400 bg-green-500/10"
                title={`Received in full · confirmed ${format(parseISO(shipment.receipt_confirmed_at!), "MMM d, yyyy")}`}
              >
                Received
              </Badge>
            ) : receivingActive && hasReceivable ? (
              <Badge variant="outline" className="border-amber-500/50 text-amber-400 bg-amber-500/10 tabular-nums">
                {cartonMode
                  ? `Receiving · ${receivedCartons.toLocaleString()} of ${totalCartons.toLocaleString()} ctns`
                  : `Receiving · ${receivedUnits.toLocaleString()} of ${totalUnits.toLocaleString()} units`}
              </Badge>
            ) : null}
            {shipment.china_customs_delay && (
              <Badge variant="outline" className="border-amber-500 text-amber-400">China Customs Delay</Badge>
            )}
          </div>
          {/* Subline: carrier · tracking · shipped · forwarder */}
          <div className="mt-1 flex items-center gap-1.5 flex-wrap text-sm text-muted-foreground">
            {editingCarrier ? (
              <span className="inline-flex items-center gap-1">
                <Input
                  value={carrierDraft}
                  onChange={(e) => setCarrierDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") saveCarrierEdit();
                    if (e.key === "Escape") cancelCarrierEdit();
                  }}
                  autoFocus
                  placeholder={isSea ? "e.g. Maersk" : "e.g. FedEx"}
                  className="h-6 w-36 text-sm"
                  disabled={updateShipment.isPending}
                />
                <Button size="icon" variant="ghost" className="h-6 w-6 shrink-0" onClick={saveCarrierEdit} disabled={updateShipment.isPending} title="Save (Enter)">
                  <Check className="h-3.5 w-3.5 text-green-400" />
                </Button>
                <Button size="icon" variant="ghost" className="h-6 w-6 shrink-0" onClick={cancelCarrierEdit} disabled={updateShipment.isPending} title="Cancel (Escape)">
                  <X className="h-3.5 w-3.5 text-muted-foreground" />
                </Button>
              </span>
            ) : canEdit ? (
              <button
                type="button"
                onClick={startCarrierEdit}
                className="group inline-flex items-center gap-1 hover:text-foreground"
                title="Click to edit carrier"
              >
                <span>{shipment.carrier_name ?? <span className="italic">No carrier</span>}</span>
                <Pencil className="h-3 w-3 opacity-0 group-hover:opacity-100 transition-opacity" />
              </button>
            ) : (
              <span>{shipment.carrier_name ?? "No carrier"}</span>
            )}
            <span>·</span>
            {editingTracking ? (
              <span className="inline-flex items-center gap-1">
                <Input
                  value={trackingDraft}
                  onChange={(e) => setTrackingDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") saveTrackingEdit();
                    if (e.key === "Escape") cancelTrackingEdit();
                  }}
                  autoFocus
                  placeholder="Tracking number"
                  className="h-6 w-44 text-xs font-mono"
                  disabled={updateShipment.isPending}
                />
                <Button size="icon" variant="ghost" className="h-6 w-6 shrink-0" onClick={saveTrackingEdit} disabled={updateShipment.isPending} title="Save (Enter)">
                  <Check className="h-3.5 w-3.5 text-green-400" />
                </Button>
                <Button size="icon" variant="ghost" className="h-6 w-6 shrink-0" onClick={cancelTrackingEdit} disabled={updateShipment.isPending} title="Cancel (Escape)">
                  <X className="h-3.5 w-3.5 text-muted-foreground" />
                </Button>
              </span>
            ) : (
              <span className="inline-flex items-center gap-1">
                {shipment.tracking_number ? (
                  <>
                    {trackingHref ? (
                      <a
                        href={trackingHref}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-mono text-xs text-primary hover:underline inline-flex items-center gap-1"
                        title={`Open ${shipment.carrier_name} tracking page`}
                      >
                        {shipment.tracking_number}
                        <ExternalLink className="h-3 w-3 opacity-60" />
                      </a>
                    ) : (
                      <span className="font-mono text-xs text-foreground/90">{shipment.tracking_number}</span>
                    )}
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-5 w-5 text-muted-foreground hover:text-foreground"
                      onClick={copyTrackingNumber}
                      title="Copy tracking number"
                    >
                      {trackingCopied ? (
                        <Check className="h-3 w-3 text-green-400" />
                      ) : (
                        <Copy className="h-3 w-3" />
                      )}
                    </Button>
                  </>
                ) : (
                  <span className="italic text-xs">No tracking</span>
                )}
                {canEdit && (
                  <button
                    type="button"
                    onClick={startTrackingEdit}
                    className="text-muted-foreground hover:text-foreground"
                    title="Edit tracking number"
                  >
                    <Pencil className="h-3 w-3" />
                  </button>
                )}
              </span>
            )}
            {shipment.ship_date && (
              <>
                <span>·</span>
                <span>shipped {format(parseISO(shipment.ship_date), "MMM d, yyyy")}</span>
              </>
            )}
            {shipment.forwarder_code && (
              <>
                <span>·</span>
                <span title="Forwarder">fwd {shipment.forwarder_code}</span>
              </>
            )}
          </div>
          {(carrierError || trackingError) && (
            <p className="text-[11px] text-red-400 mt-0.5">{carrierError ?? trackingError}</p>
          )}
        </div>
        {/* Right side: refresh tracking + overflow actions */}
        <div className="flex items-center gap-1 shrink-0">
          {showRefresh && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-muted-foreground hover:text-foreground"
              onClick={() => tracking.refetch()}
              disabled={tracking.isFetching}
              title="Check carrier for updated ETA"
            >
              <RefreshCw className={cn("h-4 w-4", tracking.isFetching && "animate-spin")} />
            </Button>
          )}
          {showChinaCustoms && canEdit && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-foreground" title="More actions">
                  <MoreVertical className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  onClick={markChinaCustomsInspection}
                  disabled={updateShipment.isPending}
                  className="text-amber-400 focus:text-amber-300"
                >
                  <ShieldAlert className="mr-2 h-3.5 w-3.5" />
                  China Customs Inspection (+7 days)
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>

      {/* ---- 2. Metric cards ------------------------------------------------ */}
      <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
        {cartonMode && (
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <p className="text-xs text-muted-foreground">Cartons</p>
                <Boxes className="h-4 w-4 text-blue-400" />
              </div>
              <p className="text-2xl font-bold tabular-nums mt-1">
                {receivedCartons.toLocaleString()}
                <span className="text-base font-semibold text-muted-foreground"> / {totalCartons.toLocaleString()}</span>
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">received / total</p>
            </CardContent>
          </Card>
        )}
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <p className="text-xs text-muted-foreground">Units</p>
              <Package className="h-4 w-4 text-primary" />
            </div>
            <p className="text-2xl font-bold tabular-nums mt-1">
              {receivedUnits.toLocaleString()}
              <span className="text-base font-semibold text-muted-foreground"> / {totalUnits.toLocaleString()}</span>
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">received / total (catalog)</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <p className="text-xs text-muted-foreground">ETA</p>
              <CalendarClock className="h-4 w-4 text-cyan-400" />
            </div>
            <div className="flex items-center gap-2 mt-1 flex-wrap">
              <p className="text-2xl font-bold tabular-nums">
                {shipment.eta ? format(parseISO(shipment.eta), "MMM d") : "—"}
              </p>
              {drift !== 0 && shipment.eta_original && (
                <span
                  className={cn(
                    "rounded px-1.5 py-0.5 text-[11px] font-medium tabular-nums",
                    isLate && "bg-amber-500/10 text-amber-400",
                    isEarly && "bg-green-500/10 text-green-400",
                  )}
                  title={`Originally ${format(parseISO(shipment.eta_original), "MMM d, yyyy")}`}
                >
                  {isLate ? `+${drift}d` : `−${Math.abs(drift)}d`}
                </span>
              )}
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              {shipment.actual_arrival_date
                ? `arrived ${format(parseISO(shipment.actual_arrival_date), "MMM d")}`
                : lastChecked
                  ? `checked ${formatDistanceToNow(parseISO(lastChecked), { addSuffix: true })}`
                  : tracking.isFetching
                    ? "checking carrier…"
                    : "not yet checked"}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <p className="text-xs text-muted-foreground">Total cost</p>
              <DollarSign className="h-4 w-4 text-yellow-400" />
            </div>
            <p className="text-2xl font-bold tabular-nums mt-1">{fmtUsd(totalLandedCost)}</p>
            <p className="text-xs text-muted-foreground mt-0.5">freight + duties + insurance</p>
          </CardContent>
        </Card>
      </div>

      {/* ---- 3. Stepper + scan history -------------------------------------- */}
      <ShipmentStepper shipment={shipment} />

      {/* ---- 4 + 5. Dock banner + manifest ---------------------------------- */}
      <ShipmentManifest
        shipment={shipment}
        lineItems={lineItemsRaw}
        groups={groups}
        receivingActive={receivingActive}
        foItemIdToOrder={foItemIdToOrder}
      />

      {/* ---- 6. Cost strip --------------------------------------------------- */}
      <Card>
        <CardContent className="py-3 px-4">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <button
              type="button"
              onClick={() => setCostOpen((o) => !o)}
              className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
              aria-expanded={costOpen}
            >
              {costOpen ? (
                <ChevronDown className="h-4 w-4 shrink-0" />
              ) : (
                <ChevronRight className="h-4 w-4 shrink-0" />
              )}
              <span className="tabular-nums text-left">
                Freight <span className="font-medium text-foreground">{fmtUsd(freightCost)}</span>
                {" · "}
                Duties <span className="font-medium text-foreground">{fmtUsd(dutiesCost)}</span>
                {" · "}
                Insurance <span className="font-medium text-foreground">{fmtUsd(insuranceCost)}</span>
                {" · "}
                <span className="font-bold text-primary">Total {fmtUsd(totalLandedCost)}</span>
              </span>
            </button>
            {receivingActive && partiallyReceived && canEdit && (
              <Button
                variant="ghost"
                size="sm"
                className="text-red-400 hover:text-red-300 hover:bg-red-500/10 h-7 text-xs"
                onClick={() => setCloseShortOpen(true)}
              >
                Close short…
              </Button>
            )}
          </div>
          {costOpen && (
            <div className="mt-3 border-t border-border/50 pt-3 space-y-2 text-sm max-w-md">
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground">Freight</span>
                {editingCost ? (
                  <div className="flex items-center gap-1">
                    <span className="text-xs text-muted-foreground">$</span>
                    <Input
                      type="number"
                      step="0.01"
                      min={0}
                      value={costDraft}
                      onChange={(e) => setCostDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") saveCostEdit();
                        if (e.key === "Escape") cancelCostEdit();
                      }}
                      autoFocus
                      placeholder="0.00"
                      className="h-7 w-32 text-right tabular-nums"
                      disabled={updateShipment.isPending}
                    />
                    <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0" onClick={saveCostEdit} disabled={updateShipment.isPending} title="Save (Enter)">
                      <Check className="h-3.5 w-3.5 text-green-400" />
                    </Button>
                    <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0" onClick={cancelCostEdit} disabled={updateShipment.isPending} title="Cancel (Escape)">
                      <X className="h-3.5 w-3.5 text-muted-foreground" />
                    </Button>
                  </div>
                ) : canEdit ? (
                  <button
                    type="button"
                    onClick={startCostEdit}
                    className="group inline-flex items-center gap-1 tabular-nums hover:text-foreground"
                    title="Click to edit freight cost"
                  >
                    <span>${freightCost.toLocaleString()}</span>
                    <Pencil className="h-3 w-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                  </button>
                ) : (
                  <span className="tabular-nums">${freightCost.toLocaleString()}</span>
                )}
              </div>
              {costError && (
                <p className="text-[11px] text-red-400 text-right -mt-1" title={costError}>{costError}</p>
              )}
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground">Duties</span>
                <span className="tabular-nums">${dutiesCost.toLocaleString()}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground">Insurance</span>
                <span className="tabular-nums">${insuranceCost.toLocaleString()}</span>
              </div>
              <div className="flex justify-between font-bold">
                <span>Total</span>
                <span className="tabular-nums text-primary">${totalLandedCost.toLocaleString()}</span>
              </div>
              <Separator />
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>Product Cost (line items)</span>
                <span className="tabular-nums">${totalCostLineItems.toLocaleString()}</span>
              </div>
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>Retail Value</span>
                <span className="tabular-nums">${totalRetailValue.toLocaleString()}</span>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Notes */}
      {shipment.notes && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <FileText className="h-4 w-4" />
              Notes
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground whitespace-pre-wrap">{shipment.notes}</p>
          </CardContent>
        </Card>
      )}

      <CloseShortDialog
        open={closeShortOpen}
        onOpenChange={setCloseShortOpen}
        shipment={shipment}
        lineItems={lineItemsRaw}
      />
    </div>
  );
}
