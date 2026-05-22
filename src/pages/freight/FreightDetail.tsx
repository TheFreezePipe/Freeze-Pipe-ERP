import { useParams, useNavigate } from "react-router-dom";
import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { ArrowLeft, Ship, Plane, Package, DollarSign, FileText, RefreshCw, TrendingUp, TrendingDown, Pencil, Check, X, ExternalLink } from "lucide-react";
import { FREIGHT_TYPES, type FreightStatus } from "@/lib/constants";
import { format, parseISO, formatDistanceToNow } from "date-fns";
import { cn } from "@/lib/utils";
import { useShipmentTracking } from "@/lib/tracking/use-shipment-tracking";
import { etaDriftDays } from "@/lib/tracking/reconcile";
import { getCarrierTrackingUrl } from "@/lib/tracking/carrier-urls";
import { StatusSelectWithOverride } from "@/components/freight/StatusSelectWithOverride";
import { useFreightShipment, useFreightLineItems, useUpdateFreightShipment } from "@/lib/hooks";
import { useAuth } from "@/lib/auth-context";

const TIMELINE_STEPS: { status: FreightStatus; label: string }[] = [
  { status: "on_the_water", label: "On the Water" },
  { status: "cleared_customs", label: "Cleared Customs" },
  { status: "tracking", label: "Tracking" },
  { status: "out_for_delivery", label: "Out for Delivery" },
  { status: "delivered", label: "Delivered" },
];

export default function FreightDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { isAdmin, isManager } = useAuth();
  const canEdit = isAdmin || isManager;

  const { data: shipment, isLoading: shipmentLoading } = useFreightShipment(id ?? "");
  const { data: lineItemsRaw = [], isLoading: lineItemsLoading } = useFreightLineItems(id);

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
  // by the supplier-portal RPC's `p_clear_freight_cost` flag). Applies to
  // both air and sea shipments — freight_type doesn't gate the edit since
  // freight_cost lives on the parent shipment row regardless of mode.
  const [editingCost, setEditingCost] = useState(false);
  const [costDraft, setCostDraft] = useState("");
  const [costError, setCostError] = useState<string | null>(null);

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
    // Pre-fill the input with the existing value (or empty string if none).
    // Use the raw number so the operator sees the same thing they'd see
    // in the cost-breakdown row, not a formatted "$1,234.56".
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

  if (shipmentLoading || lineItemsLoading) {
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
  const isHighRisk = shipment.status === "high_risk";

  const statusOrder: FreightStatus[] = ["on_the_water", "cleared_customs", "tracking", "out_for_delivery", "delivered"];
  const currentIndex = isHighRisk ? 0 : statusOrder.indexOf(shipment.status as FreightStatus);

  const totalCostLineItems = lineItemsRaw.reduce((s, li) => s + (li.unit_cost ?? 0) * li.quantity, 0);
  const totalRetailValue = lineItemsRaw.reduce((s, li) => s + (li.retail_value ?? 0) * li.quantity, 0);
  const totalQty = lineItemsRaw.reduce((s, li) => s + li.quantity, 0);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" onClick={() => navigate("/freight")}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex-1">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-2xl font-bold">{shipment.shipment_number}</h1>
            <Badge variant="outline" className="text-xs">{typeInfo.label}</Badge>
            {isHighRisk && (
              <Badge variant="outline" className="border-red-500 text-red-400">High Risk</Badge>
            )}
          </div>
          <p className="text-muted-foreground text-sm">{shipment.carrier_name ?? "No carrier"} &middot; {shipment.tracking_number ?? "No tracking"}</p>
        </div>
        <StatusSelectWithOverride shipment={shipment} variant="full" />
      </div>

      {/* Timeline */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Shipment Timeline</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between">
            {TIMELINE_STEPS.map((step, i) => {
              const isActive = !isHighRisk && currentIndex >= i;
              const isCurrent = !isHighRisk && currentIndex === i;
              return (
                <div key={step.status} className="flex flex-col items-center flex-1">
                  <div className="flex items-center w-full">
                    {i > 0 && (
                      <div className={cn("h-0.5 flex-1", isActive ? "bg-primary" : "bg-muted")} />
                    )}
                    <div className={cn(
                      "h-8 w-8 rounded-full flex items-center justify-center shrink-0 text-xs font-bold",
                      isCurrent ? "bg-primary text-primary-foreground ring-2 ring-primary/30" :
                      isActive ? "bg-primary text-primary-foreground" :
                      "bg-muted text-muted-foreground"
                    )}>
                      {i + 1}
                    </div>
                    {i < TIMELINE_STEPS.length - 1 && (
                      <div className={cn("h-0.5 flex-1", !isHighRisk && currentIndex > i ? "bg-primary" : "bg-muted")} />
                    )}
                  </div>
                  <p className={cn("text-xs mt-2", isCurrent ? "text-primary font-medium" : "text-muted-foreground")}>
                    {step.label}
                  </p>
                </div>
              );
            })}
          </div>
          {isHighRisk && (
            <div className="mt-4 rounded-lg bg-red-500/10 border border-red-500/20 p-3 text-sm text-red-400">
              This shipment is under customs inspection (High Risk). Timeline is paused until cleared.
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Shipment details */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              {shipment.freight_type === "sea" ? <Ship className="h-4 w-4 text-blue-400" /> : <Plane className="h-4 w-4 text-cyan-400" />}
              Shipment Details
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <p className="text-xs text-muted-foreground">Carrier</p>
                {editingCarrier ? (
                  <div className="flex items-center gap-1">
                    <Input
                      value={carrierDraft}
                      onChange={(e) => setCarrierDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") saveCarrierEdit();
                        if (e.key === "Escape") cancelCarrierEdit();
                      }}
                      autoFocus
                      placeholder={shipment.freight_type === "sea" ? "e.g. Maersk" : "e.g. FedEx"}
                      className="h-7 text-sm"
                      disabled={updateShipment.isPending}
                    />
                    <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0" onClick={saveCarrierEdit} disabled={updateShipment.isPending} title="Save (Enter)">
                      <Check className="h-3.5 w-3.5 text-green-400" />
                    </Button>
                    <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0" onClick={cancelCarrierEdit} disabled={updateShipment.isPending} title="Cancel (Escape)">
                      <X className="h-3.5 w-3.5 text-muted-foreground" />
                    </Button>
                  </div>
                ) : canEdit ? (
                  <button
                    type="button"
                    onClick={startCarrierEdit}
                    className="group inline-flex items-center gap-1 font-medium hover:text-foreground"
                    title="Click to edit carrier"
                  >
                    <span>{shipment.carrier_name ?? <span className="text-muted-foreground italic">No carrier</span>}</span>
                    <Pencil className="h-3 w-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                  </button>
                ) : (
                  <p className="font-medium">{shipment.carrier_name ?? "-"}</p>
                )}
                {carrierError && (
                  <p className="text-[11px] text-red-400 mt-0.5" title={carrierError}>{carrierError}</p>
                )}
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Tracking #</p>
                {editingTracking ? (
                  <div className="flex items-center gap-1">
                    <Input
                      value={trackingDraft}
                      onChange={(e) => setTrackingDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") saveTrackingEdit();
                        if (e.key === "Escape") cancelTrackingEdit();
                      }}
                      autoFocus
                      placeholder="Tracking number"
                      className="h-7 text-xs font-mono"
                      disabled={updateShipment.isPending}
                    />
                    <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0" onClick={saveTrackingEdit} disabled={updateShipment.isPending} title="Save (Enter)">
                      <Check className="h-3.5 w-3.5 text-green-400" />
                    </Button>
                    <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0" onClick={cancelTrackingEdit} disabled={updateShipment.isPending} title="Cancel (Escape)">
                      <X className="h-3.5 w-3.5 text-muted-foreground" />
                    </Button>
                  </div>
                ) : (
                  // Read mode: tracking number renders as a carrier-tracking
                  // link when both carrier_name and tracking_number are set
                  // and we have a URL pattern for that carrier. Admin/manager
                  // also gets a separate pencil to enter edit mode — kept
                  // distinct from the link so a click on the number opens
                  // the carrier page (the primary action) rather than the
                  // editor (the rarer one).
                  (() => {
                    const trackingHref = getCarrierTrackingUrl(
                      shipment.carrier_name,
                      shipment.tracking_number,
                    );
                    return (
                      <div className="inline-flex items-center gap-1.5">
                        {shipment.tracking_number ? (
                          trackingHref ? (
                            <a
                              href={trackingHref}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="font-medium font-mono text-xs text-primary hover:underline inline-flex items-center gap-1"
                              title={`Open ${shipment.carrier_name} tracking page`}
                            >
                              {shipment.tracking_number}
                              <ExternalLink className="h-3 w-3 opacity-60" />
                            </a>
                          ) : (
                            <span className="font-medium font-mono text-xs">
                              {shipment.tracking_number}
                            </span>
                          )
                        ) : (
                          <span className="text-muted-foreground italic text-xs">No tracking</span>
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
                      </div>
                    );
                  })()
                )}
                {trackingError && (
                  <p className="text-[11px] text-red-400 mt-0.5" title={trackingError}>{trackingError}</p>
                )}
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Forwarder</p>
                <p className="font-medium">{shipment.forwarder_code ?? "-"}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Ship Date</p>
                <p className="font-medium">{shipment.ship_date ? format(parseISO(shipment.ship_date), "MMM d, yyyy") : "-"}</p>
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <p className="text-xs text-muted-foreground">ETA</p>
                  {shipment.status !== "delivered" && shipment.tracking_number && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-5 w-5 text-muted-foreground hover:text-foreground"
                      onClick={() => tracking.refetch()}
                      disabled={tracking.isFetching}
                      title="Check carrier for updated ETA"
                    >
                      <RefreshCw className={cn("h-3 w-3", tracking.isFetching && "animate-spin")} />
                    </Button>
                  )}
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <p className={cn(
                    "font-medium",
                    isLate && "text-red-400",
                    isEarly && "text-green-400",
                  )}>
                    {shipment.eta ? format(parseISO(shipment.eta), "MMM d, yyyy") : "-"}
                  </p>
                  {isLate && <TrendingUp className="h-3.5 w-3.5 text-red-400" />}
                  {isEarly && <TrendingDown className="h-3.5 w-3.5 text-green-400" />}
                </div>
                {drift !== 0 && shipment.eta_original && (
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Originally <span className="line-through">{format(parseISO(shipment.eta_original), "MMM d")}</span>
                    <span className={cn("ml-1.5 font-medium", isLate ? "text-red-400" : "text-green-400")}>
                      {isLate ? `+${drift}d` : `${drift}d`}
                    </span>
                  </p>
                )}
                {lastChecked ? (
                  <p className="text-[10px] text-muted-foreground mt-0.5">
                    Checked {formatDistanceToNow(parseISO(lastChecked), { addSuffix: true })}
                  </p>
                ) : tracking.isFetching ? (
                  <p className="text-[10px] text-muted-foreground mt-0.5">Checking carrier…</p>
                ) : (
                  <p className="text-[10px] text-muted-foreground mt-0.5">Not yet checked</p>
                )}
              </div>
              {shipment.actual_arrival_date && (
                <div className="col-span-2">
                  <p className="text-xs text-muted-foreground">Actual Arrival</p>
                  <p className="font-medium text-green-400">{format(parseISO(shipment.actual_arrival_date), "MMM d, yyyy")}</p>
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Cost breakdown */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <DollarSign className="h-4 w-4 text-yellow-400" />
              Cost Breakdown
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-2 text-sm">
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
                    <span>${(shipment.freight_cost ?? 0).toLocaleString()}</span>
                    <Pencil className="h-3 w-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                  </button>
                ) : (
                  <span className="tabular-nums">${(shipment.freight_cost ?? 0).toLocaleString()}</span>
                )}
              </div>
              {costError && (
                <p className="text-[11px] text-red-400 text-right -mt-1" title={costError}>{costError}</p>
              )}
              <div className="flex justify-between font-bold">
                <span>Total Cost</span>
                <span className="tabular-nums text-primary">${(shipment.freight_cost ?? 0).toLocaleString()}</span>
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
          </CardContent>
        </Card>
      </div>

      {/* Line items */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Package className="h-4 w-4" />
            Line Items ({totalQty} units total)
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                <th className="px-4 py-3">SKU</th>
                <th className="px-3 py-3 text-right">Qty</th>
                <th className="px-3 py-3 text-right">Unit Cost</th>
                <th className="px-3 py-3 text-right">Subtotal</th>
                <th className="px-3 py-3 text-right">Retail/Unit</th>
                <th className="px-4 py-3 text-right">Retail Value</th>
              </tr>
            </thead>
            <tbody>
              {lineItemsRaw.map(li => (
                <tr key={li.id} className="border-b border-border/50">
                  <td className="px-4 py-3">
                    <p className="font-medium">{li.product?.sku ?? li.sku_id}</p>
                    <p className="text-xs text-muted-foreground">{li.product?.product_name ?? ""}</p>
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums">{li.quantity}</td>
                  <td className="px-3 py-3 text-right tabular-nums">${(li.unit_cost ?? 0).toFixed(2)}</td>
                  <td className="px-3 py-3 text-right tabular-nums font-medium">${((li.unit_cost ?? 0) * li.quantity).toLocaleString()}</td>
                  <td className="px-3 py-3 text-right tabular-nums">${(li.retail_value ?? 0).toFixed(2)}</td>
                  <td className="px-4 py-3 text-right tabular-nums font-medium text-primary">${((li.retail_value ?? 0) * li.quantity).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
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
    </div>
  );
}
