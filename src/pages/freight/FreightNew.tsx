import { useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { ArrowLeft, Plus, Trash2, Ship, Plane, Package, PackagePlus } from "lucide-react";
import {
  useProducts,
  useFactoryOrders,
  useFreightLineItems,
  useCreateFreightShipment,
  useAllPrimarySkuSupplierCosts,
} from "@/lib/hooks";
import { freightShipmentSchema, safeValidate } from "@/lib/schemas";
import { getOpenFactoryItemsForSku } from "@/lib/freight/open-factory-items";
import { cn } from "@/lib/utils";

/** A single SKU entry within a carton group */
interface CartonSKU {
  id: string;
  sku_id: string;
  quantity: number;
  pre_filled: boolean;
  /** Optional factory_order_item this entry's units are coming from.
   *  When set, the resulting freight_line_item carries the FK so the
   *  factory order's "shipped" rollup includes these units. NULL is
   *  valid for spot purchases, pre-bootstrap orders, or any case the
   *  operator doesn't want to attribute. */
  source_factory_order_item_id: string | null;
}

/** A carton group = N identical cartons, each containing the same SKU(s) */
interface CartonGroup {
  id: string;
  carton_qty: number;
  skus: CartonSKU[];
  notes: string;
}

let idCounter = 0;
function nextId() { return `item-${++idCounter}`; }

export default function FreightNew() {
  const navigate = useNavigate();
  const { data: products = [] } = useProducts();
  const { data: factoryOrders = [] } = useFactoryOrders();
  // Existing freight line items — needed to compute "already shipped"
  // per factory_order_item so the FO picker can show accurate remaining
  // quantities (otherwise we'd suggest pulling from an FO that's already
  // been fully shipped via a previous freight).
  const { data: freightLineItems = [] } = useFreightLineItems();
  // Per-SKU primary supplier unit cost map. Used to populate
  // freight_line_items.unit_cost with real numbers instead of the
  // hardcoded 0 that previously zeroed out every freight movement's
  // cost basis. SKUs without a primary supplier cost on file write
  // NULL — never a fabricated value — matching the pattern in
  // NewFactoryOrderDialog after the RAW_COST_RATIO sweep.
  const { data: primaryCostBySkuId } = useAllPrimarySkuSupplierCosts();
  const createShipment = useCreateFreightShipment();
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Shipment fields
  const [freightType, setFreightType] = useState<"sea" | "air">("sea");
  const [shipmentNumber, setShipmentNumber] = useState("");
  const [carrierName, setCarrierName] = useState("");
  const [forwarderCode, setForwarderCode] = useState("");
  const [trackingNumber, setTrackingNumber] = useState("");
  const [shipDate, setShipDate] = useState("");
  const [eta, setEta] = useState("");
  const [freightCost, setFreightCost] = useState("");
  const [notes, setNotes] = useState("");

  // Carton groups
  const [cartonGroups, setCartonGroups] = useState<CartonGroup[]>([]);

  // Map of sku_id -> units on open (non-shipped) factory orders.
  // SKUs with open orders are surfaced first in the dropdown because
  // those are the ones most likely to actually be loaded onto this shipment.
  const openFactoryUnitsBySKU = useMemo(() => {
    const map = new Map<string, number>();
    for (const order of factoryOrders) {
      if (order.status === "shipped") continue;
      for (const item of order.items ?? []) {
        const open = Math.max(0, item.quantity_ordered - (item.quantity_finished ?? 0));
        if (open === 0) continue;
        map.set(item.sku_id, (map.get(item.sku_id) ?? 0) + open);
      }
    }
    return map;
  }, [factoryOrders]);

  const availableSKUs = useMemo(() => {
    const active = products.filter(p => p.is_active);
    return active.slice().sort((a, b) => {
      const aUnits = openFactoryUnitsBySKU.get(a.id) ?? 0;
      const bUnits = openFactoryUnitsBySKU.get(b.id) ?? 0;
      if (aUnits !== bUnits) return bUnits - aUnits;
      return a.sku.localeCompare(b.sku);
    });
  }, [products, openFactoryUnitsBySKU]);

  // Totals
  const totals = useMemo(() => {
    let totalCartons = 0;
    let totalUnits = 0;
    for (const group of cartonGroups) {
      totalCartons += group.carton_qty;
      for (const sku of group.skus) totalUnits += sku.quantity;
    }
    return { totalCartons, totalUnits };
  }, [cartonGroups]);

  // --- Carton group actions ---
  function addCartonGroup() {
    setCartonGroups(prev => [...prev, {
      id: nextId(),
      carton_qty: 1,
      skus: [{ id: nextId(), sku_id: "", quantity: 0, pre_filled: false, source_factory_order_item_id: null }],
      notes: "",
    }]);
  }

  function removeCartonGroup(groupId: string) {
    setCartonGroups(prev => prev.filter(g => g.id !== groupId));
  }

  function updateCartonGroup(groupId: string, field: "carton_qty" | "notes", value: number | string) {
    setCartonGroups(prev => prev.map(g =>
      g.id === groupId ? { ...g, [field]: value } : g
    ));
  }

  // --- SKU entry actions within a carton group ---
  function addSKUToGroup(groupId: string) {
    setCartonGroups(prev => prev.map(g =>
      g.id === groupId
        ? { ...g, skus: [...g.skus, { id: nextId(), sku_id: "", quantity: 0, pre_filled: false, source_factory_order_item_id: null }] }
        : g
    ));
  }

  function removeSKUFromGroup(groupId: string, skuEntryId: string) {
    setCartonGroups(prev => prev.map(g => {
      if (g.id !== groupId) return g;
      const filtered = g.skus.filter(s => s.id !== skuEntryId);
      // If last SKU removed, remove the whole group
      return filtered.length === 0 ? g : { ...g, skus: filtered };
    }).filter(g => g.skus.length > 0));
  }

  function updateSKUEntry(
    groupId: string,
    skuEntryId: string,
    field: "sku_id" | "quantity" | "pre_filled" | "source_factory_order_item_id",
    value: string | number | boolean | null,
  ) {
    setCartonGroups(prev => prev.map(g => {
      if (g.id !== groupId) return g;
      return {
        ...g,
        skus: g.skus.map(s => {
          if (s.id !== skuEntryId) return s;
          const updated = { ...s, [field]: value };
          // Reset dependent fields when SKU changes — pre_filled and the
          // FO link both reference SKU-specific data that doesn't carry.
          if (field === "sku_id") {
            updated.pre_filled = false;
            updated.source_factory_order_item_id = null;
          }
          return updated;
        }),
      };
    }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitError(null);

    // Parse freight cost defensively. An empty string is fine (treat as 0
    // — "no freight cost yet, will fill in on arrival"); but garbage input
    // like "abc" used to silently coerce to 0 via `parseFloat(x) || 0`,
    // shipping a $0 freight cost the operator never authorized. Now we
    // only accept blank or a finite non-negative number; anything else
    // surfaces a validation error.
    const trimmedFreightCost = freightCost.trim();
    let parsedFreightCost = 0;
    if (trimmedFreightCost !== "") {
      const v = parseFloat(trimmedFreightCost);
      if (!Number.isFinite(v) || v < 0) {
        setSubmitError("Freight cost must be a non-negative number");
        return;
      }
      parsedFreightCost = v;
    }

    // Validate input via zod before touching Supabase.
    const validation = safeValidate(freightShipmentSchema, {
      shipmentNumber,
      freightType,
      carrierName: carrierName || undefined,
      forwarderCode: forwarderCode || undefined,
      trackingNumber: trackingNumber || undefined,
      shipDate: shipDate || undefined,
      eta: eta || undefined,
      freightCost: parsedFreightCost,
      notes: notes || undefined,
      cartonGroups: cartonGroups.map(g => ({
        cartonQty: g.carton_qty,
        notes: g.notes || undefined,
        skus: g.skus
          .filter(s => s.sku_id)
          .map(s => ({ skuId: s.sku_id, quantity: s.quantity, preFilled: s.pre_filled })),
      })),
    });
    if (!validation.ok) {
      setSubmitError(Object.values(validation.errors)[0] ?? "Validation failed");
      return;
    }

    // Flatten to line_items. Aggregate by SKU to satisfy the unique (shipment, sku)
    // index from migration 013 — if a SKU appears across multiple carton groups,
    // sum its quantity into a single line item. quantity_prefilled rolls up
    // the same way: only entries flagged pre_filled contribute.
    const bySku = new Map<
      string,
      {
        sku_id: string;
        quantity: number;
        quantity_prefilled: number;
        /** Tracks whether any contributing entry was fillable. For non-fillable
         * SKUs we send NULL so the column stays null and prefill stats ignore it. */
        is_fillable: boolean;
        /** Primary supplier unit cost looked up at submit time. NULL when no
         * primary cost is on file for this SKU — written as NULL to the DB
         * (column is nullable) so downstream rollups can detect "missing"
         * vs a real $0 cost. Never a fabricated fallback. */
        unit_cost: number | null;
        retail_value: number;
        /** Source factory_order_item_id, carried through aggregation.
         * First non-null wins when multiple carton groups share a SKU
         * (the unique (shipment, sku) index forces aggregation to one
         * line item anyway). If the operator needs to split a SKU
         * across multiple FOs in one shipment, they'd need to take the
         * proportionally-larger qty on the more important FO and leave
         * the others manually noted in the shipment notes. Rare case;
         * not optimizing for it in MVP. */
        source_factory_order_item_id: string | null;
      }
    >();
    for (const group of cartonGroups) {
      for (const s of group.skus) {
        if (!s.sku_id || s.quantity <= 0) continue;
        const product = products.find((p) => p.id === s.sku_id);
        const fillable = product?.category === "fillable";
        const prefilledQty = fillable && s.pre_filled ? s.quantity : 0;
        const existing = bySku.get(s.sku_id);
        if (existing) {
          existing.quantity += s.quantity;
          existing.quantity_prefilled += prefilledQty;
          // First non-null source FO wins. If two carton groups for the
          // same SKU disagree, keep the earlier; the agg-into-one-line
          // constraint means we can't honor both.
          if (!existing.source_factory_order_item_id && s.source_factory_order_item_id) {
            existing.source_factory_order_item_id = s.source_factory_order_item_id;
          }
        } else {
          // primaryCostBySkuId is undefined while the query loads. We treat
          // an undefined map and a missing entry the same — null cost. The
          // submit handler doesn't block on the query because the user can
          // legitimately ship a SKU that has no primary supplier cost yet.
          const primary = primaryCostBySkuId?.get(s.sku_id);
          const unitCost = primary?.unit_cost ?? null;
          bySku.set(s.sku_id, {
            sku_id: s.sku_id,
            quantity: s.quantity,
            quantity_prefilled: prefilledQty,
            is_fillable: fillable,
            unit_cost: unitCost,
            retail_value: product?.retail_price ?? 0,
            source_factory_order_item_id: s.source_factory_order_item_id,
          });
        }
      }
    }

    try {
      const created = await createShipment.mutateAsync({
        shipment: {
          shipment_number: shipmentNumber,
          freight_type: freightType,
          // Pending until a tracking number is on the shipment. With
          // tracking present at creation, jump straight to on_the_water.
          // A DB trigger (auto_promote_pending_on_tracking) also covers
          // the later-add case so admin inline-edits or scripts promote
          // automatically — this duplication keeps the create-with-tracking
          // path from going through a pending blink.
          status: trackingNumber.trim() ? "on_the_water" : "pending",
          carrier_name: carrierName || null,
          broker_name: null,
          forwarder_code: forwarderCode || null,
          tracking_number: trackingNumber || null,
          ship_date: shipDate || null,
          eta: eta || null,
          actual_arrival_date: null,
          freight_cost: parsedFreightCost,
          insurance_cost: 0,
          duties_cost: 0,
          // total_cost is a generated column (freight + insurance + duties)
          // — DB computes it automatically; setting it directly would error.
          total_cartons: totals.totalCartons,
          notes: notes || null,
        },
        lineItems: Array.from(bySku.values()).map((row) => ({
          sku_id: row.sku_id,
          quantity: row.quantity,
          // Non-fillable SKUs carry NULL so the SKU detail prefill stats
          // ignore them. Fillable rows always carry a numeric value (0 if
          // every entry was unfilled, row.quantity if every entry prefilled).
          quantity_prefilled: row.is_fillable ? row.quantity_prefilled : null,
          unit_cost: row.unit_cost,
          retail_value: row.retail_value,
          // Link this line back to its source factory order item, when
          // the operator picked one. Lights up the factory order's
          // shipped/finished/in-production progress bar (already wired
          // up in FactoryOrders.tsx to read this FK).
          source_factory_order_item_id: row.source_factory_order_item_id,
        })),
      });
      navigate(`/freight/${created.id}`);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Failed to create shipment");
    }
  }

  const isValid = shipmentNumber && freightType &&
    cartonGroups.some(g => g.carton_qty > 0 && g.skus.some(s => s.sku_id && s.quantity > 0));

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" onClick={() => navigate("/freight")}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div>
          <h1 className="text-2xl font-bold">New Shipment</h1>
          <p className="text-muted-foreground">Create a new freight shipment</p>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Freight type selector */}
        <div className="grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={() => setFreightType("sea")}
            className={cn(
              "flex items-center justify-center gap-3 rounded-lg border p-4 transition-all",
              freightType === "sea"
                ? "border-primary bg-primary/10 ring-1 ring-primary"
                : "border-border hover:bg-muted/50"
            )}
          >
            <Ship className={cn("h-5 w-5", freightType === "sea" ? "text-blue-400" : "text-muted-foreground")} />
            <span className={cn("font-medium", freightType === "sea" ? "text-foreground" : "text-muted-foreground")}>
              Sea Freight
            </span>
          </button>
          <button
            type="button"
            onClick={() => setFreightType("air")}
            className={cn(
              "flex items-center justify-center gap-3 rounded-lg border p-4 transition-all",
              freightType === "air"
                ? "border-primary bg-primary/10 ring-1 ring-primary"
                : "border-border hover:bg-muted/50"
            )}
          >
            <Plane className={cn("h-5 w-5", freightType === "air" ? "text-cyan-400" : "text-muted-foreground")} />
            <span className={cn("font-medium", freightType === "air" ? "text-foreground" : "text-muted-foreground")}>
              Air Freight
            </span>
          </button>
        </div>

        {/* Shipment details */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Shipment Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="shipment-number">Shipment Number *</Label>
                <Input
                  id="shipment-number"
                  placeholder={freightType === "sea" ? "SEA-2026-0401" : "AIR-2026-0401"}
                  value={shipmentNumber}
                  onChange={e => setShipmentNumber(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="tracking">Tracking Number</Label>
                <Input
                  id="tracking"
                  placeholder="Enter tracking number..."
                  value={trackingNumber}
                  onChange={e => setTrackingNumber(e.target.value)}
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="carrier">Carrier</Label>
                {/* Constrained to the 3 carriers we integrate with for tracking
                    (FedEx live; UPS + DHL stubbed). For sea freight from China,
                    these are the US final-mile carriers — the original ocean
                    carrier (Maersk/COSCO/etc.) is captured in freight_type='sea'
                    and isn't tracked at the carrier_name level here. */}
                <Select value={carrierName} onValueChange={setCarrierName}>
                  <SelectTrigger id="carrier">
                    <SelectValue placeholder="Select carrier" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="FedEx">FedEx</SelectItem>
                    <SelectItem value="UPS">UPS</SelectItem>
                    <SelectItem value="DHL">DHL</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="forwarder">Forwarder ID</Label>
                <Input
                  id="forwarder"
                  placeholder="e.g. FWD-001"
                  value={forwarderCode}
                  onChange={e => setForwarderCode(e.target.value)}
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="ship-date">Ship Date</Label>
                <Input
                  id="ship-date"
                  type="date"
                  value={shipDate}
                  onChange={e => setShipDate(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="eta">Estimated Arrival (ETA)</Label>
                <Input
                  id="eta"
                  type="date"
                  value={eta}
                  onChange={e => setEta(e.target.value)}
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Carton Groups */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-base flex items-center gap-2">
                  <Package className="h-4 w-4" />
                  Cartons
                </CardTitle>
                <CardDescription>Each carton group represents identical cartons. Add multiple SKUs to a group for mixed cartons.</CardDescription>
              </div>
              <Button type="button" variant="outline" size="sm" onClick={addCartonGroup}>
                <Plus className="mr-1.5 h-4 w-4" />
                Add Carton
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {cartonGroups.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
                <Package className="h-8 w-8 mb-2 opacity-40" />
                <p className="text-sm">No cartons yet</p>
                <Button type="button" variant="ghost" size="sm" className="mt-2" onClick={addCartonGroup}>
                  <Plus className="mr-1.5 h-4 w-4" />
                  Add first carton
                </Button>
              </div>
            ) : (
              <>
                {cartonGroups.map((group, gi) => {
                  const isMixed = group.skus.length > 1;
                  const groupUnits = group.skus.reduce((s, sk) => s + sk.quantity, 0);
                  return (
                    <div
                      key={group.id}
                      className={cn(
                        "rounded-lg border p-4 space-y-3",
                        isMixed ? "border-yellow-500/40 bg-yellow-500/5" : "border-border"
                      )}
                    >
                      {/* Carton group header */}
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-3">
                          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                            Carton {gi + 1}
                          </span>
                          {isMixed && (
                            <Badge variant="outline" className="border-yellow-500/60 text-yellow-400 text-[10px]">
                              Mixed
                            </Badge>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          <div className="flex items-center gap-1.5">
                            <span className="text-xs text-muted-foreground">&times;</span>
                            <Input
                              type="number"
                              min={1}
                              className="h-8 w-16 text-center text-sm"
                              value={group.carton_qty || ""}
                              onChange={e => updateCartonGroup(group.id, "carton_qty", parseInt(e.target.value, 10) || 0)}
                            />
                            <span className="text-xs text-muted-foreground">ctns</span>
                          </div>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-muted-foreground hover:text-red-400"
                            onClick={() => removeCartonGroup(group.id)}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </div>

                      {/* SKU rows within this carton group */}
                      {group.skus.map((skuEntry) => {
                        const product = products.find(p => p.id === skuEntry.sku_id);
                        const isFillable = product?.category === "fillable";
                        // Open factory-order items for the picker, computed
                        // per-row. Empty when no SKU selected yet.
                        const openFoItems = skuEntry.sku_id
                          ? getOpenFactoryItemsForSku(skuEntry.sku_id, factoryOrders, freightLineItems)
                          : [];
                        const pickedFoItem = openFoItems.find(
                          (f) => f.factory_order_item_id === skuEntry.source_factory_order_item_id,
                        );
                        const totalUnitsInCartonGroup = skuEntry.quantity * group.carton_qty;
                        const exceedsRemaining =
                          pickedFoItem != null
                          && totalUnitsInCartonGroup > pickedFoItem.remaining;
                        return (
                          <div key={skuEntry.id} className="space-y-1">
                          <div
                            className="grid grid-cols-1 sm:grid-cols-[1fr_90px_auto_32px] gap-2 items-center"
                          >
                            <Select
                              value={skuEntry.sku_id}
                              onValueChange={v => updateSKUEntry(group.id, skuEntry.id, "sku_id", v)}
                            >
                              <SelectTrigger className="h-9">
                                <SelectValue placeholder="Select SKU...">
                                  {product ? (
                                    <span className="flex items-center gap-2">
                                      <span className="font-medium">{product.sku}</span>
                                      <span className="text-xs text-muted-foreground truncate">{product.product_name}</span>
                                    </span>
                                  ) : "Select SKU..."}
                                </SelectValue>
                              </SelectTrigger>
                              <SelectContent>
                                {availableSKUs.map(p => {
                                  const openUnits = openFactoryUnitsBySKU.get(p.id) ?? 0;
                                  return (
                                    <SelectItem key={p.id} value={p.id}>
                                      <span className="font-medium">{p.sku}</span>
                                      <span className="ml-2 text-xs text-muted-foreground">{p.product_name}</span>
                                      <Badge variant="outline" className="ml-2 text-[9px]">
                                        {p.category === "fillable" ? "Fill" : "Non-Fill"}
                                      </Badge>
                                      {openUnits > 0 && (
                                        <Badge variant="outline" className="ml-1 text-[9px] border-yellow-400/50 text-yellow-400">
                                          {openUnits} on order
                                        </Badge>
                                      )}
                                    </SelectItem>
                                  );
                                })}
                              </SelectContent>
                            </Select>
                            <Input
                              type="number"
                              min={0}
                              className="h-9"
                              placeholder="Qty"
                              value={skuEntry.quantity || ""}
                              onChange={e => updateSKUEntry(group.id, skuEntry.id, "quantity", parseInt(e.target.value, 10) || 0)}
                            />
                            {/* Pre-filled checkbox — only for fillable SKUs */}
                            {isFillable ? (
                              <label className="flex items-center gap-1.5 cursor-pointer select-none whitespace-nowrap">
                                <Checkbox
                                  checked={skuEntry.pre_filled}
                                  onCheckedChange={(checked) => updateSKUEntry(group.id, skuEntry.id, "pre_filled", !!checked)}
                                />
                                <span className="text-xs text-muted-foreground">Filled</span>
                              </label>
                            ) : (
                              <div className="w-[60px]" />
                            )}
                            {group.skus.length > 1 ? (
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="h-9 w-9 text-muted-foreground hover:text-red-400"
                                onClick={() => removeSKUFromGroup(group.id, skuEntry.id)}
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            ) : (
                              <div className="h-9 w-9" />
                            )}
                          </div>
                          {/* Factory-order picker — only when a SKU is
                              selected AND that SKU has any open FO items.
                              Empty SKUs OR SKUs with no open FOs skip the
                              picker entirely (no clutter for spot purchases
                              or pre-bootstrap orders). The "(No FO link)"
                              choice always stays available even when FOs
                              exist, for shipments not tied to one. */}
                          {skuEntry.sku_id && openFoItems.length > 0 && (
                            <div className="flex items-center gap-2 pl-1 text-xs">
                              <span className="text-muted-foreground shrink-0">From:</span>
                              <Select
                                value={skuEntry.source_factory_order_item_id ?? "__none__"}
                                onValueChange={(v) =>
                                  updateSKUEntry(
                                    group.id,
                                    skuEntry.id,
                                    "source_factory_order_item_id",
                                    v === "__none__" ? null : v,
                                  )
                                }
                              >
                                <SelectTrigger className="h-7 text-xs flex-1">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="__none__">
                                    <span className="text-muted-foreground">No factory order link</span>
                                  </SelectItem>
                                  {openFoItems.map((fo) => (
                                    <SelectItem
                                      key={fo.factory_order_item_id}
                                      value={fo.factory_order_item_id}
                                    >
                                      <span className="font-mono">{fo.factory_order_number ?? fo.factory_order_id.slice(0, 8)}</span>
                                      <span className="ml-2 text-muted-foreground">
                                        {fo.remaining} of {fo.quantity_ordered} open
                                      </span>
                                      {fo.expected_completion && (
                                        <span className="ml-2 text-muted-foreground">
                                          · ETA {fo.expected_completion}
                                        </span>
                                      )}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                              {exceedsRemaining && (
                                <span
                                  className="text-amber-400 text-[10px]"
                                  title={`Picked FO has ${pickedFoItem!.remaining} units remaining but this line ships ${totalUnitsInCartonGroup}`}
                                >
                                  ⚠ exceeds remaining ({pickedFoItem!.remaining})
                                </span>
                              )}
                            </div>
                          )}
                          </div>
                        );
                      })}

                      {/* Add SKU to this group (makes it mixed) + Notes */}
                      <div className="flex items-center justify-between pt-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-7 text-xs text-muted-foreground hover:text-foreground"
                          onClick={() => addSKUToGroup(group.id)}
                        >
                          <PackagePlus className="mr-1 h-3 w-3" />
                          Add SKU to carton
                        </Button>
                        {groupUnits > 0 && (
                          <span className="text-xs text-muted-foreground tabular-nums">
                            {groupUnits.toLocaleString()} units
                          </span>
                        )}
                      </div>

                      {/* Notes row */}
                      <Input
                        className="h-8 text-xs"
                        placeholder="Notes (optional)"
                        value={group.notes}
                        onChange={e => updateCartonGroup(group.id, "notes", e.target.value)}
                      />
                    </div>
                  );
                })}

                {/* Add another carton — same handler as the header button,
                    placed at the bottom of the list so users with many carton
                    groups don't have to scroll back up to add the next one. */}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="w-full"
                  onClick={addCartonGroup}
                >
                  <Plus className="mr-1.5 h-4 w-4" />
                  Add Carton
                </Button>

                {/* Totals */}
                <Separator />
                <div className="flex items-center justify-between text-sm px-1">
                  <span className="text-muted-foreground">
                    {cartonGroups.length} carton group{cartonGroups.length !== 1 ? "s" : ""}
                    {" "}&middot; {totals.totalUnits.toLocaleString()} units
                  </span>
                  <span className="font-medium tabular-nums">
                    {totals.totalCartons} carton{totals.totalCartons !== 1 ? "s" : ""} total
                  </span>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        {/* Costs */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Shipping Costs</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="max-w-xs space-y-2">
              <Label htmlFor="freight-cost">Freight Cost</Label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
                <Input
                  id="freight-cost"
                  type="number"
                  step="0.01"
                  min={0}
                  className="pl-7"
                  placeholder="0.00"
                  value={freightCost}
                  onChange={e => setFreightCost(e.target.value)}
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Notes */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Notes</CardTitle>
          </CardHeader>
          <CardContent>
            <Textarea
              placeholder="Any additional notes about this shipment..."
              value={notes}
              onChange={e => setNotes(e.target.value)}
              rows={3}
            />
          </CardContent>
        </Card>

        {submitError && (
          <div className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">
            {submitError}
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center justify-between pb-6">
          <Button type="button" variant="outline" onClick={() => navigate("/freight")}>
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={!isValid || createShipment.isPending}
            className="min-w-[140px]"
          >
            {createShipment.isPending ? "Creating…" : "Create Shipment"}
          </Button>
        </div>
      </form>
    </div>
  );
}
