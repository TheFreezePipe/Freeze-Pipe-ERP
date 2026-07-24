import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import {
  AlertTriangle,
  CheckCircle2,
  Minus,
  Package,
  PackageCheck,
  Plus,
} from "lucide-react";
import { format, formatDistanceToNow, parseISO } from "date-fns";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { describeError } from "@/lib/supabase-error";
import { useAuth } from "@/lib/auth-context";
import {
  useRecordFreightReceipt,
  type CartonGroupWithSkus,
  type FreightLineItemWithProduct,
} from "@/lib/hooks";
import type { FreightShipment } from "@/types/database";

// ---------------------------------------------------------------------------
// ShipmentManifest — broker-style manifest table for the freight detail page.
// Replaces both the old Line Items card and the ReceivingPanel rows: one row
// per carton group (legacy shipments without groups fall back to one row per
// catalog line item), with the dock check-in banner above the table and the
// Received column + steppers appearing only while receiving is active.
//
// Columns: Item / Qty / Pack / Ctns / From order / [Received].
//   * Single-SKU groups label with the SKU (+ "pre-filled" tag when the
//     group's split is pre-filled); multi-SKU groups read "Mixed carton"
//     with a per-carton SKU breakdown subline.
//   * Pack shows "12/ctn" when the group's units divide evenly by its
//     cartons, else "mixed".
//   * From order links to the factory order(s) the group's SKUs were
//     sourced from (via line items' source_factory_order_item_id).
//   * Non-catalog (sample) lines render muted at the bottom — quantity
//     only, never credited to inventory.
// ---------------------------------------------------------------------------

// The receiving-active rule (owner decision) lives in
// @/lib/freight/receiving — FreightDetail computes it once and passes it in
// via the `receivingActive` prop so header chip, banner, Received column and
// close-short button all agree.

interface FoRef {
  id: string;
  number: string | null;
}

interface Props {
  shipment: FreightShipment;
  lineItems: FreightLineItemWithProduct[];
  groups: CartonGroupWithSkus[];
  receivingActive: boolean;
  /** factory_order_items.id → its parent factory order, for "From order" links. */
  foItemIdToOrder: Map<string, FoRef>;
}

/** Per-carton SKU breakdown for a multi-SKU group's subline: "SKU ×12 + SKU ×6",
 *  with a cyan pre-filled marker per SKU that carries it. Non-integral splits
 *  fall back to the group total so we never show a fake fraction (same rule
 *  the old ReceivingPanel used). */
function mixedCartonSubline(group: CartonGroupWithSkus): React.ReactNode {
  return group.skus.map((s, i) => {
    const sku = s.product?.sku ?? "Unknown SKU";
    const perCarton = s.units_total / group.carton_qty;
    const label = Number.isInteger(perCarton)
      ? `${sku} ×${perCarton}`
      : `${sku} · ${s.units_total.toLocaleString()} total`;
    return (
      <span key={s.id ?? `${sku}-${i}`}>
        {i > 0 && " + "}
        {label}
        {s.pre_filled && <span className="text-cyan-400"> (pre-filled)</span>}
      </span>
    );
  });
}

/** Units credited so far for a group — mirrors the RPC's cumulative-rounding
 *  math (round(units_total * received / carton_qty) per SKU) so the microcopy
 *  matches what the server actually credited. */
function groupUnitsCredited(group: CartonGroupWithSkus): number {
  return group.skus.reduce(
    (sum, s) => sum + Math.round((s.units_total * group.received_cartons) / group.carton_qty),
    0,
  );
}

export function ShipmentManifest({
  shipment,
  lineItems,
  groups,
  receivingActive,
  foItemIdToOrder,
}: Props) {
  const navigate = useNavigate();
  const { isAdmin, isManager, user } = useAuth();
  const canEdit = isAdmin || isManager;
  const { toast } = useToast();
  const record = useRecordFreightReceipt();

  // Which stepper is in flight ("<groupId>:+1" / "<groupId>:-1") or which
  // line's Record button ("<lineId>") — lets the tapped control show its
  // pending state while all write controls stay disabled during the call.
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const catalogLines = lineItems.filter((l) => l.sku_id);
  const customLines = lineItems.filter((l) => !l.sku_id);
  const totalUnits = catalogLines.reduce((s, l) => s + l.quantity, 0);
  const receivedUnits = catalogLines.reduce((s, l) => s + (l.quantity_received ?? 0), 0);

  const cartonMode = groups.length > 0;
  const totalCartons = groups.reduce((s, g) => s + g.carton_qty, 0);
  const receivedCartons = groups.reduce((s, g) => s + g.received_cartons, 0);

  const isConfirmed = !!shipment.receipt_confirmed_at;
  const isClosedShort = !!shipment.closed_short_at;

  // Sample-only shipments have nothing receivable — suppress all receiving UI
  // even if the receiving-active rule fires.
  const hasReceivable = cartonMode || catalogLines.length > 0;
  const showActiveReceiving = receivingActive && hasReceivable;
  // Received column: live (steppers) while receiving is active, read-only
  // values after receipt confirmation, absent entirely before receiving.
  const showReceivedColumn = showActiveReceiving || (isConfirmed && hasReceivable);
  const columnCount = 5 + (showReceivedColumn ? 1 : 0);

  const anyPending = record.isPending;

  async function tapCarton(group: CartonGroupWithSkus, delta: 1 | -1) {
    if (!user) return;
    setPendingKey(`${group.id}:${delta > 0 ? "+1" : "-1"}`);
    try {
      const result = await record.mutateAsync({
        shipmentId: shipment.id,
        actorId: user.id,
        entries: [{ carton_group_id: group.id, cartons: delta }],
      });
      if (result.fully_received) {
        toast({
          title: "All cartons checked in",
          description: "Shipment fully received — inventory credited and receipt confirmed.",
        });
      }
    } catch (err) {
      toast({
        title: "Couldn't record carton",
        description: describeError(err),
        variant: "destructive",
      });
    } finally {
      setPendingKey(null);
    }
  }

  async function recordUnits(line: FreightLineItemWithProduct) {
    if (!user) return;
    const raw = (drafts[line.id] ?? "").trim();
    const units = Number(raw);
    if (raw === "" || !Number.isInteger(units) || units === 0) {
      toast({
        title: "Enter a whole number of units",
        description: "Positive to receive, negative to correct a previous entry.",
        variant: "destructive",
      });
      return;
    }
    const received = line.quantity_received ?? 0;
    if (received + units < 0) {
      toast({
        title: "Correction too large",
        description: `Only ${received} units are checked in on this line.`,
        variant: "destructive",
      });
      return;
    }
    setPendingKey(line.id);
    try {
      const result = await record.mutateAsync({
        shipmentId: shipment.id,
        actorId: user.id,
        entries: [{ line_item_id: line.id, units }],
      });
      setDrafts((d) => ({ ...d, [line.id]: "" }));
      if (result.fully_received) {
        toast({
          title: "All units checked in",
          description: "Shipment fully received — inventory credited and receipt confirmed.",
        });
      } else {
        toast({
          title: units > 0 ? `Recorded ${units} units` : `Reversed ${-units} units`,
          description: `${line.product?.sku ?? "line"} now at ${received + units} of ${line.quantity}`,
        });
      }
    } catch (err) {
      toast({
        title: "Couldn't record units",
        description: describeError(err),
        variant: "destructive",
      });
    } finally {
      setPendingKey(null);
    }
  }

  /** Unique factory orders feeding a set of SKU ids (via this shipment's
   *  line items' source_factory_order_item_id). */
  function ordersForSkus(skuIds: Set<string>): FoRef[] {
    const seen = new Map<string, FoRef>();
    for (const line of catalogLines) {
      if (!line.sku_id || !skuIds.has(line.sku_id) || !line.source_factory_order_item_id) continue;
      const fo = foItemIdToOrder.get(line.source_factory_order_item_id);
      if (fo && !seen.has(fo.id)) seen.set(fo.id, fo);
    }
    return [...seen.values()];
  }

  function renderFoLinks(orders: FoRef[]) {
    if (orders.length === 0) return <span className="text-muted-foreground">—</span>;
    return (
      <span>
        {orders.map((o, i) => (
          <span key={o.id}>
            {i > 0 && <span className="text-muted-foreground">, </span>}
            <button
              type="button"
              onClick={() => navigate(`/inventory/factory-orders/${o.id}`)}
              className="text-cyan-400 hover:underline"
              title="Open the source factory order"
            >
              {o.number ?? o.id.slice(0, 8)}
            </button>
          </span>
        ))}
      </span>
    );
  }

  // ---- Dock check-in banner (carried over from the old ReceivingPanel) ----
  // State A (action): carrier has delivered more pieces than cartons checked
  // in — lead with the gap. State B (calm): check-ins have caught up with the
  // carrier's delivered count. Neutral: no piece data or unit mode.
  const headlineDone = cartonMode
    ? totalCartons > 0 && receivedCartons >= totalCartons
    : totalUnits > 0 && receivedUnits >= totalUnits;
  const piecesDelivered = shipment.carrier_pieces_delivered;
  const piecesTotal = shipment.carrier_pieces_total;
  const piecesOnVehicle = shipment.carrier_pieces_on_vehicle;
  const piecesUpdatedAt = shipment.carrier_pieces_updated_at;
  const awaitingCheckIn = piecesDelivered != null ? piecesDelivered - receivedCartons : 0;
  const bannerState: "action" | "calm" | "neutral" =
    cartonMode && !headlineDone && piecesDelivered != null
      ? awaitingCheckIn > 0
        ? "action"
        : "calm"
      : "neutral";
  const carrierDetail =
    piecesDelivered == null
      ? null
      : [
          piecesTotal != null
            ? `Carrier delivered ${piecesDelivered.toLocaleString()} of ${piecesTotal.toLocaleString()} pieces`
            : `Carrier delivered ${piecesDelivered.toLocaleString()} pieces`,
          piecesOnVehicle != null && piecesOnVehicle > 0
            ? `${piecesOnVehicle.toLocaleString()} on a truck`
            : null,
          piecesUpdatedAt
            ? `updated ${formatDistanceToNow(parseISO(piecesUpdatedAt), { addSuffix: true })}`
            : null,
        ]
          .filter(Boolean)
          .join(" · ");
  const stillInTransit =
    piecesTotal != null && piecesDelivered != null ? piecesTotal - piecesDelivered : null;
  const recordedAheadOfScans = piecesDelivered != null && receivedCartons > piecesDelivered;
  const unitModeCarrierLine =
    !cartonMode && piecesDelivered != null
      ? piecesTotal != null
        ? `Carrier: ${piecesDelivered.toLocaleString()} of ${piecesTotal.toLocaleString()} pieces delivered`
        : `Carrier: ${piecesDelivered.toLocaleString()} pieces delivered`
      : null;

  const noun = cartonMode ? "carton" : "unit";
  const headlineReceived = cartonMode ? receivedCartons : receivedUnits;
  const headlineTotal = cartonMode ? totalCartons : totalUnits;

  return (
    <div className="space-y-4">
      {/* Closed short — amber note above the manifest (copy carried over). */}
      {isClosedShort && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 flex items-start gap-3">
          <AlertTriangle className="h-5 w-5 text-amber-400 shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-semibold text-amber-300">
              Closed short on {format(parseISO(shipment.closed_short_at!), "MMM d, yyyy")}
              {shipment.closed_short_reason && <> — {shipment.closed_short_reason}</>}
            </p>
            <p className="text-[13px] text-muted-foreground mt-1">
              {receivedUnits.toLocaleString()} units checked in. Missing units were returned to
              on-order and shortage variances filed.
            </p>
          </div>
        </div>
      )}

      {/* Dock check-in banner — only while receiving is active. */}
      {showActiveReceiving && (
        bannerState === "action" ? (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 flex items-center gap-4">
            <div className="text-4xl font-bold tabular-nums leading-none shrink-0 text-amber-400">
              {awaitingCheckIn.toLocaleString()}
            </div>
            <div>
              <p className="text-sm font-semibold">
                {awaitingCheckIn === 1 ? "carton" : "cartons"} on your dock awaiting check-in
              </p>
              {carrierDetail && (
                <p className="text-[13px] text-muted-foreground">{carrierDetail}</p>
              )}
            </div>
          </div>
        ) : bannerState === "calm" ? (
          <div className="rounded-lg border border-green-500/30 bg-green-500/10 p-4 flex items-center gap-4">
            <PackageCheck className="h-7 w-7 text-green-400 shrink-0" />
            <div>
              <p className="text-sm font-semibold text-green-300">
                All delivered cartons are checked in — {receivedCartons.toLocaleString()} of{" "}
                {(piecesDelivered ?? 0).toLocaleString()}
              </p>
              {stillInTransit != null && stillInTransit > 0 && (
                <p className="text-[13px] text-muted-foreground">
                  {stillInTransit.toLocaleString()} piece{stillInTransit === 1 ? "" : "s"} still
                  in transit
                </p>
              )}
              {recordedAheadOfScans && (
                <p className="text-[11px] text-muted-foreground/70">
                  recorded ahead of carrier scans
                </p>
              )}
            </div>
          </div>
        ) : (
          <div
            className={cn(
              "rounded-lg border p-4 flex items-center gap-4",
              headlineDone
                ? "border-green-500/30 bg-green-500/10"
                : "border-amber-500/30 bg-amber-500/10",
            )}
          >
            <div
              className={cn(
                "text-4xl font-bold tabular-nums leading-none shrink-0",
                headlineDone ? "text-green-400" : "text-amber-400",
              )}
            >
              {headlineReceived.toLocaleString()}
              <span className="text-xl font-semibold text-muted-foreground">
                {" "}/ {headlineTotal.toLocaleString()}
              </span>
            </div>
            <div>
              <p className="text-sm font-semibold">
                {headlineDone
                  ? `All ${noun}s checked in`
                  : `${headlineReceived.toLocaleString()} of ${headlineTotal.toLocaleString()} ${noun}s checked in`}
              </p>
              <p className="text-[13px] text-muted-foreground">
                {receivedUnits.toLocaleString()} of {totalUnits.toLocaleString()} units credited to
                inventory
              </p>
              {unitModeCarrierLine && (
                <p className="text-[13px] text-muted-foreground">{unitModeCarrierLine}</p>
              )}
            </div>
          </div>
        )
      )}

      {/* Manifest table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Package className="h-4 w-4" />
            Manifest
            <span className="font-normal text-xs text-muted-foreground">
              {cartonMode
                ? `${groups.length} carton group${groups.length === 1 ? "" : "s"}`
                : `${catalogLines.length} line${catalogLines.length === 1 ? "" : "s"}`}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                  <th className="px-4 py-3">Item</th>
                  <th className="px-3 py-3 text-right">Qty</th>
                  <th className="px-3 py-3 text-right">Pack</th>
                  <th className="px-3 py-3 text-right">Ctns</th>
                  <th className="px-3 py-3">From order</th>
                  {showReceivedColumn && <th className="px-4 py-3 text-right">Received</th>}
                </tr>
              </thead>
              <tbody>
                {cartonMode
                  ? groups.map((group) => {
                      const groupUnits = group.skus.reduce((s, sk) => s + sk.units_total, 0);
                      const perCarton = group.carton_qty > 0 ? groupUnits / group.carton_qty : NaN;
                      const pack = Number.isInteger(perCarton) ? `${perCarton}/ctn` : "mixed";
                      const done = group.received_cartons >= group.carton_qty;
                      const credited = groupUnitsCredited(group);
                      const single = group.skus.length === 1;
                      const orders = ordersForSkus(new Set(group.skus.map((s) => s.sku_id)));
                      return (
                        <tr key={group.id} className="border-b border-border/50">
                          <td className="px-4 py-3">
                            {single ? (
                              <>
                                <p className="font-medium inline-flex items-center gap-1.5">
                                  {group.skus[0].product?.sku ?? "Unknown SKU"}
                                  {group.skus[0].pre_filled && (
                                    <span className="rounded border border-cyan-500/50 px-1 py-px text-[9px] uppercase tracking-wide text-cyan-400">
                                      pre-filled
                                    </span>
                                  )}
                                </p>
                                <p className="text-xs text-muted-foreground">
                                  {group.skus[0].product?.product_name ?? ""}
                                </p>
                              </>
                            ) : (
                              <>
                                <p className="font-medium">Mixed carton</p>
                                <p className="text-xs text-muted-foreground">
                                  {mixedCartonSubline(group)}
                                </p>
                              </>
                            )}
                            {group.notes && (
                              <p className="text-[11px] text-muted-foreground truncate">{group.notes}</p>
                            )}
                          </td>
                          <td className="px-3 py-3 text-right tabular-nums">{groupUnits.toLocaleString()}</td>
                          <td className="px-3 py-3 text-right tabular-nums">{pack}</td>
                          <td className="px-3 py-3 text-right tabular-nums">{group.carton_qty.toLocaleString()}</td>
                          <td className="px-3 py-3 text-xs">{renderFoLinks(orders)}</td>
                          {showReceivedColumn && (
                            <td className="px-4 py-3">
                              {done ? (
                                <div className="flex items-center justify-end gap-1.5 text-green-400 text-xs tabular-nums whitespace-nowrap">
                                  <CheckCircle2 className="h-4 w-4 shrink-0" />
                                  {group.received_cartons}/{group.carton_qty} · {credited.toLocaleString()} credited
                                  {/* Keep the −1 correction available on completed rows while
                                      receiving is still open (parity with the old panel). */}
                                  {showActiveReceiving && canEdit && (
                                    <Button
                                      size="icon"
                                      variant="ghost"
                                      className="h-6 w-6 text-muted-foreground hover:text-foreground"
                                      onClick={() => tapCarton(group, -1)}
                                      disabled={anyPending}
                                      title="Remove one carton (correction)"
                                    >
                                      <Minus className={cn("h-3 w-3", pendingKey === `${group.id}:-1` && "animate-pulse")} />
                                    </Button>
                                  )}
                                </div>
                              ) : (
                                <div className="flex items-center justify-end gap-2">
                                  <Progress
                                    value={group.carton_qty > 0 ? (group.received_cartons / group.carton_qty) * 100 : 0}
                                    className="h-1.5 w-16 [&>div]:bg-amber-500"
                                  />
                                  <span className="text-xs tabular-nums text-muted-foreground whitespace-nowrap">
                                    {group.received_cartons}/{group.carton_qty}
                                  </span>
                                  {showActiveReceiving && canEdit && (
                                    <div className="flex items-center gap-1 shrink-0">
                                      <Button
                                        size="icon"
                                        variant="outline"
                                        className="h-7 w-7"
                                        onClick={() => tapCarton(group, -1)}
                                        disabled={anyPending || group.received_cartons <= 0}
                                        title="Remove one carton (correction)"
                                      >
                                        <Minus className={cn("h-3.5 w-3.5", pendingKey === `${group.id}:-1` && "animate-pulse")} />
                                      </Button>
                                      <Button
                                        size="icon"
                                        variant="outline"
                                        className="h-7 w-7 border-green-500/40 text-green-400 hover:text-green-300"
                                        onClick={() => tapCarton(group, 1)}
                                        disabled={anyPending}
                                        title="Check in one carton"
                                      >
                                        <Plus className={cn("h-3.5 w-3.5", pendingKey === `${group.id}:+1` && "animate-pulse")} />
                                      </Button>
                                    </div>
                                  )}
                                </div>
                              )}
                            </td>
                          )}
                        </tr>
                      );
                    })
                  : catalogLines.map((line) => {
                      const received = line.quantity_received ?? 0;
                      const done = received >= line.quantity;
                      const orders = line.source_factory_order_item_id
                        ? (() => {
                            const fo = foItemIdToOrder.get(line.source_factory_order_item_id);
                            return fo ? [fo] : [];
                          })()
                        : [];
                      return (
                        <tr key={line.id} className="border-b border-border/50">
                          <td className="px-4 py-3">
                            <p className="font-medium inline-flex items-center gap-1.5">
                              {line.product?.sku ?? line.sku_id}
                              {/* Legacy lines carry prefill on the line itself
                                  (quantity_prefilled), possibly partial. */}
                              {(line.quantity_prefilled ?? 0) > 0 && (
                                <span className="rounded border border-cyan-500/50 px-1 py-px text-[9px] uppercase tracking-wide text-cyan-400">
                                  {(line.quantity_prefilled ?? 0) >= line.quantity
                                    ? "pre-filled"
                                    : `${(line.quantity_prefilled ?? 0).toLocaleString()} pre-filled`}
                                </span>
                              )}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {line.product?.product_name ?? ""}
                            </p>
                          </td>
                          <td className="px-3 py-3 text-right tabular-nums">{line.quantity.toLocaleString()}</td>
                          <td className="px-3 py-3 text-right text-muted-foreground">—</td>
                          <td className="px-3 py-3 text-right text-muted-foreground">—</td>
                          <td className="px-3 py-3 text-xs">{renderFoLinks(orders)}</td>
                          {showReceivedColumn && (
                            <td className="px-4 py-3">
                              <div className="flex items-center justify-end gap-2 flex-wrap">
                                <span
                                  className={cn(
                                    "text-xs tabular-nums whitespace-nowrap inline-flex items-center gap-1",
                                    done ? "text-green-400" : "text-muted-foreground",
                                  )}
                                >
                                  {done && <CheckCircle2 className="h-4 w-4 shrink-0" />}
                                  {received.toLocaleString()}/{line.quantity.toLocaleString()}
                                </span>
                                {showActiveReceiving && canEdit && (
                                  <div className="flex items-center gap-1.5 shrink-0">
                                    <Input
                                      type="number"
                                      step={1}
                                      value={drafts[line.id] ?? ""}
                                      onChange={(e) => setDrafts((d) => ({ ...d, [line.id]: e.target.value }))}
                                      onKeyDown={(e) => {
                                        if (e.key === "Enter") recordUnits(line);
                                      }}
                                      placeholder="± units"
                                      className="h-7 w-20 text-right tabular-nums"
                                      disabled={anyPending}
                                    />
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      className="h-7 px-2.5 text-xs"
                                      onClick={() => recordUnits(line)}
                                      disabled={anyPending || (drafts[line.id] ?? "").trim() === ""}
                                    >
                                      {pendingKey === line.id ? "Recording…" : "Record"}
                                    </Button>
                                  </div>
                                )}
                              </div>
                            </td>
                          )}
                        </tr>
                      );
                    })}

                {/* Non-catalog (sample) lines — muted, quantity only, never credited. */}
                {customLines.map((line) => (
                  <tr key={line.id} className="border-b border-border/40 opacity-60">
                    <td className="px-4 py-2.5">
                      <p className="text-sm inline-flex items-center gap-1.5">
                        {line.custom_description ?? "Non-catalog item"}
                        <span className="rounded border border-amber-500/50 px-1 py-px text-[9px] uppercase tracking-wide text-amber-400">
                          sample
                        </span>
                      </p>
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{line.quantity.toLocaleString()}</td>
                    <td className="px-3 py-2.5 text-right text-muted-foreground">—</td>
                    <td className="px-3 py-2.5 text-right text-muted-foreground">—</td>
                    <td className="px-3 py-2.5 text-muted-foreground text-xs">—</td>
                    {showReceivedColumn && (
                      <td className="px-4 py-2.5 text-right text-[11px] italic text-muted-foreground whitespace-nowrap">
                        sample — not credited
                      </td>
                    )}
                  </tr>
                ))}

                {lineItems.length === 0 && groups.length === 0 && (
                  <tr>
                    <td colSpan={columnCount} className="px-4 py-6 text-center text-sm text-muted-foreground">
                      No line items on this shipment.
                    </td>
                  </tr>
                )}
              </tbody>
              <tfoot>
                <tr className="border-t border-border bg-muted/20 text-xs">
                  <td className="px-4 py-2.5 font-medium">Totals</td>
                  <td className="px-3 py-2.5 text-right tabular-nums font-medium">
                    {totalUnits.toLocaleString()} units
                  </td>
                  <td className="px-3 py-2.5" />
                  <td className="px-3 py-2.5 text-right tabular-nums font-medium">
                    {cartonMode ? `${totalCartons.toLocaleString()} ctns` : "—"}
                  </td>
                  <td className="px-3 py-2.5" />
                  {showReceivedColumn && (
                    <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground whitespace-nowrap">
                      {cartonMode
                        ? `${receivedCartons.toLocaleString()} ctns · ${receivedUnits.toLocaleString()} units in`
                        : `${receivedUnits.toLocaleString()} units in`}
                    </td>
                  )}
                </tr>
              </tfoot>
            </table>
          </div>
          {showActiveReceiving && !cartonMode && canEdit && (
            <p className="px-4 py-2 text-[11px] text-muted-foreground border-t border-border/40">
              Enter a negative number to correct a previous entry.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
