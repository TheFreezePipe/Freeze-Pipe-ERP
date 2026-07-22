import { useState, useMemo, useEffect } from "react";
import { addDays, format, parseISO } from "date-fns";
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
import { ArrowLeft, Plus, Trash2, Ship, Plane, Package, PackagePlus, X } from "lucide-react";
import {
  useProducts,
  useFactoryOrders,
  useFreightLineItems,
  useFreightShipments,
  useCreateFreightShipment,
  useAllPrimarySkuSupplierCosts,
} from "@/lib/hooks";
import { freightShipmentSchema, safeValidate } from "@/lib/schemas";
import { getOpenFactoryItemsForSku } from "@/lib/freight/open-factory-items";
import { buildOnOrderMap } from "@/lib/inventory-aggregates";
import { describeError } from "@/lib/supabase-error";
import { cn } from "@/lib/utils";

/** One allocation of a SKU's units to a source factory order (or none).
 *  A SKU line is split across several of these when a single shipment
 *  carries the same SKU from more than one order. */
interface SkuAllocation {
  id: string;
  quantity: number;
  /** factory_order_item these units come from. NULL = no tracked order
   *  (spot purchase / pre-bootstrap / untracked older order). */
  source_factory_order_item_id: string | null;
}

/** A single SKU entry within a carton group. Units live in `allocations`
 *  — length 1 for the common single-source case, more when the operator
 *  splits the SKU across multiple factory orders. */
interface CartonSKU {
  id: string;
  sku_id: string;
  pre_filled: boolean;
  allocations: SkuAllocation[];
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

/** A fresh, empty SKU entry with a single empty allocation. */
function newCartonSku(): CartonSKU {
  return {
    id: nextId(),
    sku_id: "",
    pre_filled: false,
    allocations: [{ id: nextId(), quantity: 0, source_factory_order_item_id: null }],
  };
}

/** Total units across a SKU entry's allocations. */
function skuTotal(s: CartonSKU): number {
  return s.allocations.reduce((sum, a) => sum + (a.quantity || 0), 0);
}

export default function FreightNew() {
  const navigate = useNavigate();
  const { data: products = [] } = useProducts();
  const { data: factoryOrders = [] } = useFactoryOrders();
  // Existing freight line items — needed to compute "already shipped"
  // per factory_order_item so the FO picker can show accurate remaining
  // quantities (otherwise we'd suggest pulling from an FO that's already
  // been fully shipped via a previous freight).
  const { data: freightLineItems = [] } = useFreightLineItems();
  // Existing shipments — used to auto-suggest the next sea shipment number.
  const { data: allShipments = [] } = useFreightShipments();
  // Per-SKU primary supplier unit cost map. Used to populate
  // freight_line_items.unit_cost with real numbers instead of the
  // hardcoded 0 that previously zeroed out every freight movement's
  // cost basis. SKUs without a primary supplier cost on file write
  // NULL — never a fabricated value — matching the pattern in
  // NewFactoryOrderDialog after the RAW_COST_RATIO sweep.
  const { data: primaryCostBySkuId } = useAllPrimarySkuSupplierCosts();
  const createShipment = useCreateFreightShipment();
  const [submitError, setSubmitError] = useState<string | null>(null);
  // Save-time "you left units unlinked" guard. Populated with the SKU lines
  // that ship units against a SKU which HAS an open factory order but whose
  // allocation was left on "No order link". The AlertDialog asks the operator
  // to go back and link, or confirm they're spot shipments.
  const [spotWarnLines, setSpotWarnLines] = useState<
    Array<{ sku: string; qty: number; orders: string[] }>
  >([]);
  const [showSpotWarn, setShowSpotWarn] = useState(false);

  // Shipment fields
  const [freightType, setFreightType] = useState<"sea" | "air">("sea");
  const [shipmentNumber, setShipmentNumber] = useState("");
  // Once the operator types their own number we stop auto-managing it.
  const [numberTouched, setNumberTouched] = useState(false);

  // Sea shipments are numbered as plain incrementing integers (442, 443…);
  // air uses an "AIR-###" scheme. Suggest the next sea number = highest
  // existing numeric sea number + 1.
  const nextSeaNumber = useMemo(() => {
    let max = 0;
    for (const s of allShipments) {
      if (s.freight_type !== "sea" || !/^\d+$/.test(s.shipment_number)) continue;
      const n = parseInt(s.shipment_number, 10);
      if (n > max) max = n;
    }
    return max > 0 ? String(max + 1) : "";
  }, [allShipments]);

  // Auto-fill the number from the sea progression when sea is selected and
  // the operator hasn't overridden it. Cleared for air (different scheme)
  // so they enter the AIR-### number manually.
  useEffect(() => {
    if (numberTouched) return;
    setShipmentNumber(freightType === "sea" ? nextSeaNumber : "");
  }, [freightType, nextSeaNumber, numberTouched]);
  const [carrierName, setCarrierName] = useState("");
  const [forwarderCode, setForwarderCode] = useState("");
  const [trackingNumber, setTrackingNumber] = useState("");
  const [shipDate, setShipDate] = useState("");
  const [eta, setEta] = useState("");
  // Once the operator edits the ETA themselves we stop auto-suggesting.
  const [etaTouched, setEtaTouched] = useState(false);

  // Sea freight reliably lands ~30 days after the ship date (owner rule,
  // 2026-07-07 — shipments 443/449 both needed this fixed by hand). Suggest
  // ETA = ship date + 30d for sea shipments until the field is manually
  // edited; mirrors the shipment-number auto-suggest pattern.
  useEffect(() => {
    if (etaTouched || freightType !== "sea") return;
    if (!shipDate) { setEta(""); return; }
    const d = parseISO(shipDate);
    if (Number.isNaN(d.getTime())) return;
    setEta(format(addDays(d, 30), "yyyy-MM-dd"));
  }, [shipDate, freightType, etaTouched]);

  // A tracking number means the shipment has already sailed (the form sets
  // status on_the_water from it) — so Ship Date shouldn't sit empty.
  // Default it to today; the sea-ETA effect above then cascades +30d.
  // Root cause of shipments 443/449/455 being created dateless and fixed
  // by hand later. Stops the moment the operator edits the date.
  const [shipDateTouched, setShipDateTouched] = useState(false);
  useEffect(() => {
    if (shipDateTouched || shipDate || !trackingNumber.trim()) return;
    setShipDate(format(new Date(), "yyyy-MM-dd"));
  }, [trackingNumber, shipDate, shipDateTouched]);
  const [freightCost, setFreightCost] = useState("");
  const [notes, setNotes] = useState("");
  // Non-catalog (sample/prototype) items — free-text lines with no SKU.
  // Tracked on the shipment + receipt but never credited to inventory.
  const [customItems, setCustomItems] = useState<
    Array<{ id: string; description: string; quantity: number }>
  >([]);

  // Carton groups
  const [cartonGroups, setCartonGroups] = useState<CartonGroup[]>([]);

  // Map of sku_id -> units still on order, NET of anything already committed
  // to a freight shipment. Uses the app's canonical on-order definition
  // (buildOnOrderMap) so this "on order" badge matches the dashboard /
  // inventory pages AND the per-row "From:" picker below: once units are
  // placed on a freight line they leave the on-order bucket (they're now in
  // transit), so they no longer show here. SKUs with open orders are surfaced
  // first in the dropdown because those are most likely loaded onto a shipment.
  const openFactoryUnitsBySKU = useMemo(
    () => buildOnOrderMap(factoryOrders, freightLineItems),
    [factoryOrders, freightLineItems],
  );

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
      for (const sku of group.skus) totalUnits += skuTotal(sku);
    }
    return { totalCartons, totalUnits };
  }, [cartonGroups]);

  // --- Carton group actions ---
  function addCartonGroup() {
    setCartonGroups(prev => [...prev, {
      id: nextId(),
      carton_qty: 1,
      skus: [newCartonSku()],
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
        ? { ...g, skus: [...g.skus, newCartonSku()] }
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

  function updateSKUField(
    groupId: string,
    skuEntryId: string,
    field: "sku_id" | "pre_filled",
    value: string | boolean,
  ) {
    setCartonGroups(prev => prev.map(g => {
      if (g.id !== groupId) return g;
      return {
        ...g,
        skus: g.skus.map(s => {
          if (s.id !== skuEntryId) return s;
          if (field === "sku_id") {
            // SKU changed — pre_filled and FO links reference SKU-specific
            // data that doesn't carry. Collapse back to a single allocation,
            // preserving any quantity the operator already typed.
            const keptQty = skuTotal(s);
            // Auto-link to the sole open factory order for this SKU, when
            // exactly one exists. This makes "linked" the default for the
            // common case (a SKU with one open order), so units correctly
            // count as shipped against that order instead of silently saving
            // as an unlinked spot shipment. With zero or multiple open
            // orders we leave it unset — the operator picks (and the
            // save-time guard catches a forgotten link).
            const openForSku = getOpenFactoryItemsForSku(
              value as string,
              factoryOrders,
              freightLineItems,
            );
            const autoSource =
              openForSku.length === 1 ? openForSku[0].factory_order_item_id : null;
            return {
              ...s,
              sku_id: value as string,
              pre_filled: false,
              allocations: [{ id: nextId(), quantity: keptQty, source_factory_order_item_id: autoSource }],
            };
          }
          return { ...s, pre_filled: value as boolean };
        }),
      };
    }));
  }

  // --- Allocation actions within a SKU entry ---
  function updateAllocation(
    groupId: string,
    skuEntryId: string,
    allocId: string,
    field: "quantity" | "source_factory_order_item_id",
    value: number | string | null,
  ) {
    setCartonGroups(prev => prev.map(g => {
      if (g.id !== groupId) return g;
      return {
        ...g,
        skus: g.skus.map(s => s.id !== skuEntryId ? s : {
          ...s,
          allocations: s.allocations.map(a => a.id === allocId ? { ...a, [field]: value } : a),
        }),
      };
    }));
  }

  function addAllocation(groupId: string, skuEntryId: string) {
    setCartonGroups(prev => prev.map(g => {
      if (g.id !== groupId) return g;
      return {
        ...g,
        skus: g.skus.map(s => s.id !== skuEntryId ? s : {
          ...s,
          allocations: [...s.allocations, { id: nextId(), quantity: 0, source_factory_order_item_id: null }],
        }),
      };
    }));
  }

  function removeAllocation(groupId: string, skuEntryId: string, allocId: string) {
    setCartonGroups(prev => prev.map(g => {
      if (g.id !== groupId) return g;
      return {
        ...g,
        skus: g.skus.map(s => {
          if (s.id !== skuEntryId) return s;
          if (s.allocations.length <= 1) return s; // never drop the last
          return { ...s, allocations: s.allocations.filter(a => a.id !== allocId) };
        }),
      };
    }));
  }

  // Scan the current carton groups for SKU units left unlinked to a factory
  // order while an open order for that SKU exists. Those are the ones at risk
  // of silently not counting as shipped against the order. Aggregated per SKU.
  function computeUnlinkedWithOpenOrders(): Array<{ sku: string; qty: number; orders: string[] }> {
    const bySku = new Map<string, { sku: string; qty: number; orders: string[] }>();
    for (const group of cartonGroups) {
      for (const s of group.skus) {
        if (!s.sku_id) continue;
        let unlinkedQty = 0;
        for (const alloc of s.allocations) {
          if (alloc.quantity > 0 && alloc.source_factory_order_item_id == null) {
            unlinkedQty += alloc.quantity;
          }
        }
        if (unlinkedQty <= 0) continue;
        const open = getOpenFactoryItemsForSku(s.sku_id, factoryOrders, freightLineItems);
        if (open.length === 0) continue; // no open order to link → legitimately spot
        const product = products.find((p) => p.id === s.sku_id);
        const skuLabel = product?.sku ?? s.sku_id.slice(0, 8);
        const orderNums = open.map(
          (o) => o.factory_order_number ?? o.factory_order_id.slice(0, 8),
        );
        const existing = bySku.get(s.sku_id);
        if (existing) {
          existing.qty += unlinkedQty;
          for (const on of orderNums) if (!existing.orders.includes(on)) existing.orders.push(on);
        } else {
          bySku.set(s.sku_id, { sku: skuLabel, qty: unlinkedQty, orders: orderNums });
        }
      }
    }
    return Array.from(bySku.values());
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    void submitCore(false);
  }

  async function submitCore(skipSpotCheck: boolean) {
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

    const validCustom = customItems
      .map((c) => ({ ...c, description: c.description.trim() }))
      .filter((c) => c.description !== "" && c.quantity > 0);

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
      cartonGroups: cartonGroups
        .filter(g => g.carton_qty > 0 && g.skus.some(sk => sk.sku_id && skuTotal(sk) > 0))
        .map(g => ({
          cartonQty: g.carton_qty,
          notes: g.notes || undefined,
          skus: g.skus
            .filter(s => s.sku_id && skuTotal(s) > 0)
            .map(s => ({ skuId: s.sku_id, quantity: skuTotal(s), preFilled: s.pre_filled })),
        })),
    });
    if (!validation.ok) {
      setSubmitError(Object.values(validation.errors)[0] ?? "Validation failed");
      return;
    }
    if (!hasCatalogLines && validCustom.length === 0) {
      setSubmitError("Add at least one carton group or one non-catalog item");
      return;
    }

    // Save-time guard: if any SKU ships units while it has an open factory
    // order but the allocation was left unlinked, stop and confirm. Those
    // units would otherwise silently NOT count as shipped against the order
    // (exactly the bug that prompted this). Skipped once the operator
    // explicitly confirms they're spot shipments in the dialog.
    if (!skipSpotCheck) {
      const unlinked = computeUnlinkedWithOpenOrders();
      if (unlinked.length > 0) {
        setSpotWarnLines(unlinked);
        setShowSpotWarn(true);
        return;
      }
    }

    // Flatten to line_items. The unique index on the table is now
    // (shipment, sku, source_factory_order_item_id) per migration
    // 20260528000001 — same SKU shipped from different FOs lands as
    // separate rows, each with its own factory-order attribution.
    // Aggregate by the composite key so two carton groups sharing
    // both (sku, source_FO) still merge, but two groups with the same
    // SKU pointing at different FOs stay separate.
    const lineKey = (sku_id: string, source: string | null) =>
      `${sku_id}__${source ?? "null"}`;
    const byKey = new Map<
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
        /** Source factory_order_item_id. Part of the dedupe key now —
         * different source FOs produce different line items. NULL is
         * still valid (no FO link, e.g. spot purchases). */
        source_factory_order_item_id: string | null;
      }
    >();
    for (const group of cartonGroups) {
      for (const s of group.skus) {
        if (!s.sku_id) continue;
        const product = products.find((p) => p.id === s.sku_id);
        const fillable = product?.category === "fillable";
        // Each allocation becomes its own contribution, keyed by
        // (sku, source_FO). Two allocations to the same source (or both
        // unlinked) merge; allocations to different orders stay separate.
        for (const alloc of s.allocations) {
          if (alloc.quantity <= 0) continue;
          const prefilledQty = fillable && s.pre_filled ? alloc.quantity : 0;
          const key = lineKey(s.sku_id, alloc.source_factory_order_item_id);
          const existing = byKey.get(key);
          if (existing) {
            existing.quantity += alloc.quantity;
            existing.quantity_prefilled += prefilledQty;
          } else {
            // primaryCostBySkuId is undefined while the query loads. We treat
            // an undefined map and a missing entry the same — null cost. The
            // submit handler doesn't block on the query because the user can
            // legitimately ship a SKU that has no primary supplier cost yet.
            const primary = primaryCostBySkuId?.get(s.sku_id);
            const unitCost = primary?.unit_cost ?? null;
            byKey.set(key, {
              sku_id: s.sku_id,
              quantity: alloc.quantity,
              quantity_prefilled: prefilledQty,
              is_fillable: fillable,
              unit_cost: unitCost,
              retail_value: product?.retail_price ?? 0,
              source_factory_order_item_id: alloc.source_factory_order_item_id,
            });
          }
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
        lineItems: [
          ...validCustom.map((c) => ({
            sku_id: null,
            custom_description: c.description,
            quantity: c.quantity,
            quantity_prefilled: null,
            unit_cost: null,
            retail_value: null,
            source_factory_order_item_id: null,
          })),
          ...Array.from(byKey.values()).map((row) => ({
          sku_id: row.sku_id as string | null,
          custom_description: null,
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
        ],
      });
      navigate(`/freight/${created.id}`);
    } catch (err) {
      setSubmitError(describeError(err));
    }
  }

  const hasCatalogLines =
    cartonGroups.some(g => g.carton_qty > 0 && g.skus.some(s => s.sku_id && skuTotal(s) > 0));
  const hasCustomItems = customItems.some(c => c.description.trim() !== "" && c.quantity > 0);
  const isValid = shipmentNumber && freightType && (hasCatalogLines || hasCustomItems);

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
                  placeholder={freightType === "sea" ? (nextSeaNumber || "443") : "AIR-243"}
                  value={shipmentNumber}
                  onChange={e => { setShipmentNumber(e.target.value); setNumberTouched(true); }}
                  required
                />
                {freightType === "sea" && !numberTouched && nextSeaNumber && (
                  <p className="text-xs text-muted-foreground">
                    Auto-suggested next sea number — edit if needed.
                  </p>
                )}
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
                    (FedEx, UPS and DHL — all live). For sea freight from China,
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
                  onChange={e => { setShipDateTouched(true); setShipDate(e.target.value); }}
                />
                {!shipDateTouched && shipDate && trackingNumber.trim() && (
                  <p className="text-[10px] text-muted-foreground">
                    Defaulted to today (tracking number present). Adjust if it sailed earlier.
                  </p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="eta">Estimated Arrival (ETA)</Label>
                <Input
                  id="eta"
                  type="date"
                  value={eta}
                  onChange={e => { setEtaTouched(true); setEta(e.target.value); }}
                />
                {!etaTouched && freightType === "sea" && eta && (
                  <p className="text-[10px] text-muted-foreground">
                    Suggested: ship date + 30 days (sea transit). Edit to override.
                  </p>
                )}
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
                  const groupUnits = group.skus.reduce((s, sk) => s + skuTotal(sk), 0);
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
                        // Open factory-order items for the picker(s), computed
                        // per-row. Empty when no SKU selected yet.
                        const openFoItems = skuEntry.sku_id
                          ? getOpenFactoryItemsForSku(skuEntry.sku_id, factoryOrders, freightLineItems)
                          : [];
                        const isSplit = skuEntry.allocations.length > 1;
                        const lineTotal = skuTotal(skuEntry);
                        const firstAlloc = skuEntry.allocations[0];

                        // One factory-order <Select> bound to a single
                        // allocation. Reused by the collapsed "From:" row and
                        // every row of the split editor.
                        const renderFoSelect = (alloc: SkuAllocation, compact: boolean) => (
                          <Select
                            value={alloc.source_factory_order_item_id ?? "__none__"}
                            onValueChange={(v) =>
                              updateAllocation(
                                group.id, skuEntry.id, alloc.id,
                                "source_factory_order_item_id", v === "__none__" ? null : v,
                              )
                            }
                          >
                            <SelectTrigger className={cn("text-xs", compact ? "h-7 flex-1" : "h-8 w-full")}>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="__none__">
                                <span className="text-muted-foreground">No order link (spot / old order)</span>
                              </SelectItem>
                              {openFoItems.map((fo) => (
                                <SelectItem key={fo.factory_order_item_id} value={fo.factory_order_item_id}>
                                  <span className="font-mono">{fo.factory_order_number ?? fo.factory_order_id.slice(0, 8)}</span>
                                  <span className="ml-2 text-muted-foreground">
                                    {fo.remaining} of {fo.quantity_ordered} open
                                  </span>
                                  {fo.expected_completion && (
                                    <span className="ml-2 text-muted-foreground">· ETA {fo.expected_completion}</span>
                                  )}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        );

                        // Per-allocation "exceeds remaining" check. Returns the
                        // order's remaining count when the allocation overshoots
                        // it, else null. Warning only (real over-ships happen).
                        const allocWarning = (alloc: SkuAllocation): number | null => {
                          const fo = openFoItems.find(f => f.factory_order_item_id === alloc.source_factory_order_item_id);
                          return fo != null && alloc.quantity > fo.remaining ? fo.remaining : null;
                        };

                        return (
                          <div key={skuEntry.id} className="space-y-1">
                          <div
                            className="grid grid-cols-1 sm:grid-cols-[1fr_90px_auto_32px] gap-2 items-center"
                          >
                            <Select
                              value={skuEntry.sku_id}
                              onValueChange={v => updateSKUField(group.id, skuEntry.id, "sku_id", v)}
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
                            {/* Quantity — editable when single-source; a
                                read-only total badge when split (the real qty
                                inputs live in the editor below). */}
                            {isSplit ? (
                              <div
                                className="flex h-9 items-center justify-center rounded-md border border-dashed border-border text-sm tabular-nums text-muted-foreground"
                                title="Total across the allocations below"
                              >
                                {lineTotal.toLocaleString()}
                              </div>
                            ) : (
                              <Input
                                type="number"
                                min={0}
                                className="h-9"
                                placeholder="Qty"
                                value={firstAlloc.quantity || ""}
                                onChange={e => updateAllocation(group.id, skuEntry.id, firstAlloc.id, "quantity", parseInt(e.target.value, 10) || 0)}
                              />
                            )}
                            {/* Pre-filled checkbox — only for fillable SKUs */}
                            {isFillable ? (
                              <label className="flex items-center gap-1.5 cursor-pointer select-none whitespace-nowrap">
                                <Checkbox
                                  checked={skuEntry.pre_filled}
                                  onCheckedChange={(checked) => updateSKUField(group.id, skuEntry.id, "pre_filled", !!checked)}
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

                          {/* Single-source "From:" row — shown when a SKU is
                              selected, it has open FOs, and it isn't split.
                              "Split across orders" expands into the editor. */}
                          {skuEntry.sku_id && openFoItems.length > 0 && !isSplit && (
                            <div className="flex items-center gap-2 pl-1 text-xs">
                              <span className="text-muted-foreground shrink-0">From:</span>
                              {renderFoSelect(firstAlloc, true)}
                              {allocWarning(firstAlloc) != null && (
                                <span
                                  className="text-amber-400 text-[10px] shrink-0"
                                  title={`Order has ${allocWarning(firstAlloc)} remaining but this line ships ${firstAlloc.quantity}`}
                                >
                                  ⚠ exceeds ({allocWarning(firstAlloc)})
                                </span>
                              )}
                              <button
                                type="button"
                                className="text-cyan-400/80 hover:text-cyan-300 shrink-0 whitespace-nowrap"
                                onClick={() => addAllocation(group.id, skuEntry.id)}
                              >
                                Split across orders
                              </button>
                            </div>
                          )}

                          {/* Split editor — distribute this SKU's units across
                              multiple source orders (+ the no-link bucket). */}
                          {skuEntry.sku_id && isSplit && (
                            <div className="ml-1 rounded-md border border-border/70 bg-muted/20 p-2 space-y-1.5">
                              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                                Allocate units across orders
                              </div>
                              {skuEntry.allocations.map((alloc) => {
                                const warn = allocWarning(alloc);
                                return (
                                  <div key={alloc.id} className="space-y-0.5">
                                    <div className="grid grid-cols-[70px_1fr_28px] gap-2 items-center">
                                      <Input
                                        type="number"
                                        min={0}
                                        className="h-8 text-sm"
                                        placeholder="Qty"
                                        value={alloc.quantity || ""}
                                        onChange={e => updateAllocation(group.id, skuEntry.id, alloc.id, "quantity", parseInt(e.target.value, 10) || 0)}
                                      />
                                      {renderFoSelect(alloc, false)}
                                      <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon"
                                        className="h-8 w-7 text-muted-foreground hover:text-red-400"
                                        onClick={() => removeAllocation(group.id, skuEntry.id, alloc.id)}
                                      >
                                        <Trash2 className="h-3 w-3" />
                                      </Button>
                                    </div>
                                    {warn != null && (
                                      <span className="text-amber-400 text-[10px] pl-[78px]">
                                        ⚠ exceeds remaining ({warn})
                                      </span>
                                    )}
                                  </div>
                                );
                              })}
                              <div className="flex items-center justify-between pt-0.5">
                                <button
                                  type="button"
                                  className="text-cyan-400/80 hover:text-cyan-300 text-xs"
                                  onClick={() => addAllocation(group.id, skuEntry.id)}
                                >
                                  + Add source
                                </button>
                                <span className="text-xs text-muted-foreground tabular-nums">
                                  Total: {lineTotal.toLocaleString()} units
                                </span>
                              </div>
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

        {/* Non-catalog / sample items */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Samples &amp; Non-Catalog Items</CardTitle>
            <p className="text-xs text-muted-foreground">
              One-off items that aren't in the SKU catalog (prototypes, factory samples, spare parts)
            </p>
          </CardHeader>
          <CardContent className="space-y-3">
            {customItems.length > 0 && (
              <div className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-300/90">
                Non-catalog items are tracked on this shipment (ETA, receipt confirmation)
                but are <span className="font-medium">not added to inventory</span> and don't create SKUs.
              </div>
            )}
            {customItems.map((c) => (
              <div key={c.id} className="flex items-center gap-2">
                <Input
                  placeholder="Description (e.g. Glass prototype — v2 sample)"
                  value={c.description}
                  onChange={(e) =>
                    setCustomItems((prev) =>
                      prev.map((x) => (x.id === c.id ? { ...x, description: e.target.value } : x)),
                    )
                  }
                  className="flex-1"
                />
                <Input
                  type="number"
                  min={1}
                  placeholder="Qty"
                  value={c.quantity || ""}
                  onChange={(e) =>
                    setCustomItems((prev) =>
                      prev.map((x) =>
                        x.id === c.id ? { ...x, quantity: parseInt(e.target.value, 10) || 0 } : x,
                      ),
                    )
                  }
                  className="w-24"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-9 w-9 shrink-0 text-muted-foreground hover:text-red-400"
                  onClick={() => setCustomItems((prev) => prev.filter((x) => x.id !== c.id))}
                  title="Remove item"
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            ))}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                setCustomItems((prev) => [...prev, { id: nextId(), description: "", quantity: 1 }])
              }
            >
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              Add non-catalog item
            </Button>
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

      {/* Save-time guard: units left unlinked while an open factory order
          exists for that SKU. Lets the operator go back and link, or
          confirm they really are spot/untracked shipments. */}
      <AlertDialog open={showSpotWarn} onOpenChange={setShowSpotWarn}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Ship without linking to a factory order?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                <p>
                  These units aren't linked to a factory order, so they
                  <span className="font-medium text-foreground"> won't count as shipped</span>{" "}
                  against any order (they'll sit as in-transit spot stock):
                </p>
                <ul className="space-y-1 rounded-md border border-border bg-muted/30 p-2 text-sm">
                  {spotWarnLines.map((l) => (
                    <li key={l.sku} className="flex items-center justify-between gap-3">
                      <span>
                        <span className="font-mono font-medium text-foreground">{l.sku}</span>
                        <span className="text-muted-foreground"> × {l.qty.toLocaleString()}</span>
                      </span>
                      <span className="text-xs text-muted-foreground">
                        open: {l.orders.join(", ")}
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="text-xs">
                  Go back to pick the order in each SKU's <span className="font-medium">From:</span>{" "}
                  dropdown, or confirm these are spot shipments.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={createShipment.isPending}>
              Go back &amp; link
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={createShipment.isPending}
              onClick={(e) => {
                // Keep the dialog flow in our hands: prevent the default
                // auto-close so the button can show the pending state while
                // the create runs, then navigate on success.
                e.preventDefault();
                setShowSpotWarn(false);
                void submitCore(true);
              }}
            >
              {createShipment.isPending ? "Creating…" : "Ship as spot anyway"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
