import { useParams, Link } from "react-router-dom";
import { useState, useEffect } from "react";
import { format, parseISO } from "date-fns";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  useSupplierFreightShipment,
  useUpdateSupplierShipmentTracking,
  type SupplierFreightShipmentRow,
  type SupplierFreightLineItemRow,
} from "@/lib/hooks";
import { ArrowLeft, Save, Ship, Plane } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

const STATUS_COLOR: Record<SupplierFreightShipmentRow["status"], string> = {
  pending: "bg-slate-500/10 text-slate-400 border-slate-500/30",
  on_the_water: "bg-indigo-500/10 text-indigo-400 border-indigo-500/30",
  high_risk: "bg-amber-500/10 text-amber-400 border-amber-500/30",
  cleared_customs: "bg-teal-500/10 text-teal-400 border-teal-500/30",
  tracking: "bg-purple-500/10 text-purple-400 border-purple-500/30",
  delivered: "bg-green-500/10 text-green-400 border-green-500/30",
};

/**
 * Supplier-side shipment detail. Editable while pending or on_the_water;
 * locked once the shipment has cleared customs. Inline editing saves via
 * rpc_supplier_update_shipment_tracking — each field is an independent
 * state-mirror that writes back when the user clicks Save.
 *
 * When a pending shipment gets a tracking number + carrier saved, the
 * RPC auto-promotes status to on_the_water (migration 035). No separate
 * "book" step — the act of entering tracking info IS the booking.
 */
export default function SupplierShipmentDetail() {
  const { id } = useParams<{ id: string }>();
  const { toast } = useToast();
  const { data, isLoading, error } = useSupplierFreightShipment(id);
  const update = useUpdateSupplierShipmentTracking();

  const [tracking, setTracking] = useState("");
  const [carrier, setCarrier] = useState("");
  const [eta, setEta] = useState("");
  const [shipDate, setShipDate] = useState("");
  const [freightCost, setFreightCost] = useState("");

  useEffect(() => {
    const s = data?.shipment;
    if (!s) return;
    setTracking(s.tracking_number ?? "");
    setCarrier(s.carrier_name ?? "");
    setEta(s.eta ?? "");
    setShipDate(s.ship_date ?? "");
    // Empty string when cost is null/0 so the placeholder shows. Numeric
    // string otherwise so the input renders the prior value.
    setFreightCost(
      s.freight_cost !== null && s.freight_cost !== undefined && s.freight_cost !== 0
        ? s.freight_cost.toString()
        : "",
    );
  }, [data?.shipment]);

  if (isLoading) {
    return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;
  }
  if (error || !data) {
    return (
      <div className="p-6 text-sm text-red-400">
        Shipment not found.{" "}
        <Link to="/supplier/shipments" className="underline">
          Back to list
        </Link>
        .
      </div>
    );
  }

  const shipment = data.shipment;
  const lines = data.lines;
  const totalUnits = lines.reduce((sum, l) => sum + (l.quantity ?? 0), 0);
  // Editable while the supplier still owns the row. Once the shipment
  // has cleared customs, the supplier side goes read-only.
  const editable = shipment.status === "pending" || shipment.status === "on_the_water";

  // Parse freight cost once for both dirty detection and submit.
  const parsedFreightCost =
    freightCost.trim() === "" ? null : Math.max(0, parseFloat(freightCost) || 0);
  const currentFreightCost = shipment.freight_cost ?? 0;

  // Dirty check — keeps the Save button inactive until the user actually
  // changes something so we don't write no-op RPC rounds.
  const dirty =
    (tracking.trim() || null) !== (shipment.tracking_number ?? null) ||
    (carrier.trim() || null) !== (shipment.carrier_name ?? null) ||
    (eta || null) !== (shipment.eta ?? null) ||
    (shipDate || null) !== (shipment.ship_date ?? null) ||
    (parsedFreightCost ?? 0) !== currentFreightCost;

  async function onSave() {
    try {
      await update.mutateAsync({
        shipmentId: shipment.id,
        expectedVersion: shipment.row_version,
        // Null → "clear", empty string from form also → clear.
        trackingNumber: tracking.trim() ? tracking.trim() : null,
        clearTrackingNumber: !tracking.trim() && !!shipment.tracking_number,
        carrier: carrier.trim() ? carrier.trim() : null,
        clearCarrier: !carrier.trim() && !!shipment.carrier_name,
        eta: eta || null,
        clearEta: !eta && !!shipment.eta,
        shipDate: shipDate || null,
        clearShipDate: !shipDate && !!shipment.ship_date,
        // Empty cost → clear to 0. Any numeric value passes through.
        freightCost: parsedFreightCost ?? null,
        clearFreightCost: parsedFreightCost === null && currentFreightCost > 0,
      });
      toast({ title: "Shipment updated" });
    } catch (err) {
      toast({
        title: "Could not update shipment",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    }
  }

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <Button variant="ghost" size="sm" asChild>
          <Link to="/supplier/shipments">
            <ArrowLeft className="mr-1.5 h-4 w-4" /> All shipments
          </Link>
        </Button>
        <div className="mt-2 flex items-start justify-between gap-4">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-2xl font-semibold font-mono">
              {shipment.shipment_number ?? "awaiting number"}
            </h1>
            {shipment.freight_type === "sea" ? (
              <Ship className="h-5 w-5 text-blue-400" />
            ) : (
              <Plane className="h-5 w-5 text-cyan-400" />
            )}
            <Badge variant="outline" className={STATUS_COLOR[shipment.status]}>
              {shipment.status.replace(/_/g, " ")}
            </Badge>
          </div>
          <div className="text-right">
            <div className="text-2xl font-semibold tabular-nums">{totalUnits.toLocaleString()}</div>
            <div className="text-[10px] text-muted-foreground uppercase tracking-wider">
              units · {shipment.total_cartons ?? 0} ctns
            </div>
          </div>
        </div>
      </div>

      {/* Editable details */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Details</CardTitle>
          <CardDescription>
            {editable
              ? shipment.status === "pending"
                ? "Saving tracking number + carrier will mark this shipment as on the water."
                : "Editable until the shipment clears customs. Save to apply changes."
              : "Locked — this shipment has cleared customs. Contact internal team to correct details."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="tracking">Tracking Number</Label>
              <Input
                id="tracking"
                value={tracking}
                onChange={(e) => setTracking(e.target.value)}
                placeholder="Enter tracking number…"
                disabled={!editable}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="carrier">Carrier</Label>
              <Input
                id="carrier"
                value={carrier}
                onChange={(e) => setCarrier(e.target.value)}
                placeholder={shipment.freight_type === "sea" ? "e.g. Maersk" : "e.g. FedEx"}
                disabled={!editable}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="ship-date">Ship Date</Label>
              <Input
                id="ship-date"
                type="date"
                value={shipDate}
                onChange={(e) => setShipDate(e.target.value)}
                disabled={!editable}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="eta">ETA</Label>
              <Input
                id="eta"
                type="date"
                value={eta}
                onChange={(e) => setEta(e.target.value)}
                disabled={!editable}
              />
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="freight-cost">Freight Cost</Label>
              <div className="relative max-w-xs">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                  $
                </span>
                <Input
                  id="freight-cost"
                  type="number"
                  step="0.01"
                  min={0}
                  className="pl-7"
                  placeholder="0.00"
                  value={freightCost}
                  onChange={(e) => setFreightCost(e.target.value)}
                  disabled={!editable}
                />
              </div>
            </div>
          </div>

          {editable && (
            <div className="flex items-center justify-end gap-2">
              <Button onClick={onSave} disabled={!dirty || update.isPending}>
                <Save className="mr-1.5 h-4 w-4" />
                {update.isPending ? "Saving…" : "Save"}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Read-only summary */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Summary</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
          <Summary label="Created" value={fmtDate(shipment.created_at)} />
          <Summary
            label="Ship Date"
            value={shipment.ship_date ? fmtDate(shipment.ship_date) : "—"}
          />
          <Summary
            label="Original ETA"
            value={shipment.eta_original ? fmtDate(shipment.eta_original) : "—"}
          />
          <Summary
            label="Actual Arrival"
            value={shipment.actual_arrival_date ? fmtDate(shipment.actual_arrival_date) : "—"}
          />
        </CardContent>
      </Card>

      {/* Line items */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Line Items</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                <th className="px-4 py-3">SKU</th>
                <th className="px-3 py-3 text-right">Qty</th>
                <th className="px-3 py-3 text-right">Prefilled</th>
              </tr>
            </thead>
            <tbody>
              {lines.length === 0 ? (
                <tr>
                  <td
                    colSpan={3}
                    className="px-4 py-6 text-center text-sm text-muted-foreground italic"
                  >
                    No line items.
                  </td>
                </tr>
              ) : (
                lines.map((l) => <LineRow key={l.id} line={l} />)
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}

function LineRow({ line }: { line: SupplierFreightLineItemRow }) {
  const prefilled = line.quantity_prefilled;
  let prefilledCell: React.ReactNode;
  if (prefilled === null || prefilled === undefined) {
    prefilledCell = <span className="text-muted-foreground">—</span>;
  } else if (prefilled === 0) {
    prefilledCell = <span className="text-muted-foreground">0</span>;
  } else if (prefilled >= line.quantity) {
    prefilledCell = <span className="text-green-400">all</span>;
  } else {
    prefilledCell = (
      <span className="text-amber-400">
        {prefilled.toLocaleString()} / {line.quantity.toLocaleString()}
      </span>
    );
  }
  return (
    <tr className="border-b border-border/50">
      <td className="px-4 py-3">
        {line.sku ? (
          <>
            <span className="font-mono text-xs">{line.sku.sku}</span>
            <span className="ml-2 text-muted-foreground text-xs">{line.sku.product_name}</span>
          </>
        ) : (
          <span className="font-mono text-xs text-muted-foreground">
            {line.sku_id.slice(0, 8)}…
          </span>
        )}
      </td>
      <td className="px-3 py-3 text-right tabular-nums">{line.quantity.toLocaleString()}</td>
      <td className="px-3 py-3 text-right tabular-nums">{prefilledCell}</td>
    </tr>
  );
}

function Summary({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="text-sm">{value}</div>
    </div>
  );
}

function fmtDate(iso: string) {
  return format(parseISO(iso), "MMM d, yyyy");
}
