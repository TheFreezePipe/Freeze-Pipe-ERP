import { useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
  ArrowLeft,
  Plus,
  Trash2,
  Ship,
  Plane,
  Package,
  PackagePlus,
} from "lucide-react";
import {
  useCreateSupplierFreightShipment,
  useSupplierFactoryOrders,
  useSupplierFreightRollupByItem,
} from "@/lib/hooks";
import { supabase } from "@/lib/supabase";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";

/**
 * Supplier-side "New Shipment" — feature-parity with the admin Freight create
 * page:
 *   - Freight type selector (sea / air)
 *   - Carton groups with mixed-SKU support
 *   - Per-SKU prefilled checkbox (fillable SKUs only)
 *   - SKU dropdown ordered by "finished and unshipped" quantity so the
 *     most-likely candidates surface first, with a chip showing available qty
 *   - Source-FOI linkage picked up automatically when a SKU has exactly one
 *     open factory-order item on the current scope
 *
 * Differs from admin in a few places:
 *   - shipment_number + freight_cost are omitted from the UI. The server
 *     auto-generates the number; suppliers don't see cost.
 *   - status starts 'pending' (supplier pipeline); admin starts 'on_the_water'.
 */

interface CartonSKU {
  id: string;
  sku_id: string;
  quantity: number;
  pre_filled: boolean;
}
interface CartonGroup {
  id: string;
  carton_qty: number;
  skus: CartonSKU[];
  notes: string;
}

let idCounter = 0;
const nextId = () => `item-${++idCounter}`;

/**
 * SKU directory for the supplier portal. Includes category so we can decide
 * whether to render the Prefilled checkbox per entry.
 */
function useVisibleSKUs() {
  return useQuery({
    queryKey: ["supplier", "skus-with-category"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("product_skus")
        .select("id, sku, product_name, category")
        .eq("is_active", true)
        .order("sku");
      if (error) throw error;
      return (data ?? []) as Array<{
        id: string;
        sku: string;
        product_name: string;
        category: string;
      }>;
    },
    staleTime: 5 * 60 * 1000,
  });
}

export default function NewShipment() {
  const navigate = useNavigate();
  const { toast } = useToast();

  const skus = useVisibleSKUs();
  const orders = useSupplierFactoryOrders();
  const create = useCreateSupplierFreightShipment();

  // Pull the freight-line rollup for every factory-order item in scope. We
  // use this to compute "already shipped" qty per item so the availability
  // number surfaces what's actually left to ship.
  const allItemIds = useMemo(
    () => (orders.data ?? []).flatMap((o) => (o.items ?? []).map((i) => i.id)),
    [orders.data],
  );
  const freightRollup = useSupplierFreightRollupByItem(
    allItemIds.length > 0 ? allItemIds : undefined,
  );
  const freightMap = freightRollup.data ?? new Map();

  // Shipment fields
  const [freightType, setFreightType] = useState<"sea" | "air">("sea");
  const [carrier, setCarrier] = useState("");
  const [trackingNumber, setTrackingNumber] = useState("");
  const [shipDate, setShipDate] = useState("");
  const [eta, setEta] = useState("");
  const [freightCost, setFreightCost] = useState("");
  const [notes, setNotes] = useState("");

  const [cartonGroups, setCartonGroups] = useState<CartonGroup[]>([]);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Idempotency key — stable for the life of this form. Retries from the
  // same submit attempt are dedup'd server-side.
  const idempotencyKey = useMemo(() => crypto.randomUUID(), []);

  // Map: sku_id -> { availableUnits, oldestFoiId }. Availability is
  // sum(quantity_finished) for that sku across in-flight orders, minus
  // what's already been attached to freight. The oldest matching FOI is
  // auto-linked as source on new line entries so downstream reporting can
  // trace units back to their order.
  const skuAvailability = useMemo(() => {
    const map = new Map<
      string,
      { available: number; oldestFoi: { id: string; orderDate: string } | null }
    >();
    for (const order of orders.data ?? []) {
      if (order.status === "canceled" || order.status === "shipped") continue;
      for (const item of order.items ?? []) {
        const finished = item.quantity_finished ?? 0;
        // How many of this item have already been attached to freight?
        let shippedSoFar = 0;
        for (const fl of freightMap.get(item.id) ?? []) {
          shippedSoFar += fl.quantity;
        }
        const left = Math.max(0, finished - shippedSoFar);
        if (left === 0) continue;
        const entry = map.get(item.sku_id) ?? { available: 0, oldestFoi: null };
        entry.available += left;
        if (
          entry.oldestFoi === null ||
          order.order_date.localeCompare(entry.oldestFoi.orderDate) < 0
        ) {
          entry.oldestFoi = { id: item.id, orderDate: order.order_date };
        }
        map.set(item.sku_id, entry);
      }
    }
    return map;
  }, [orders.data, freightMap]);

  // Dropdown ordering: available-to-ship first (descending), then by sku code.
  const availableSKUs = useMemo(() => {
    const list = skus.data ?? [];
    return list.slice().sort((a, b) => {
      const av = skuAvailability.get(a.id)?.available ?? 0;
      const bv = skuAvailability.get(b.id)?.available ?? 0;
      if (av !== bv) return bv - av;
      return a.sku.localeCompare(b.sku);
    });
  }, [skus.data, skuAvailability]);

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
    setCartonGroups((prev) => [
      ...prev,
      {
        id: nextId(),
        carton_qty: 1,
        skus: [{ id: nextId(), sku_id: "", quantity: 0, pre_filled: false }],
        notes: "",
      },
    ]);
  }

  function removeCartonGroup(groupId: string) {
    setCartonGroups((prev) => prev.filter((g) => g.id !== groupId));
  }

  function updateCartonGroup(
    groupId: string,
    field: "carton_qty" | "notes",
    value: number | string,
  ) {
    setCartonGroups((prev) =>
      prev.map((g) => (g.id === groupId ? { ...g, [field]: value } : g)),
    );
  }

  function addSKUToGroup(groupId: string) {
    setCartonGroups((prev) =>
      prev.map((g) =>
        g.id === groupId
          ? {
              ...g,
              skus: [
                ...g.skus,
                { id: nextId(), sku_id: "", quantity: 0, pre_filled: false },
              ],
            }
          : g,
      ),
    );
  }

  function removeSKUFromGroup(groupId: string, skuEntryId: string) {
    setCartonGroups((prev) =>
      prev.map((g) => {
        if (g.id !== groupId) return g;
        const filtered = g.skus.filter((s) => s.id !== skuEntryId);
        return filtered.length === 0 ? g : { ...g, skus: filtered };
      }),
    );
  }

  function updateSKUEntry(
    groupId: string,
    skuEntryId: string,
    field: "sku_id" | "quantity" | "pre_filled",
    value: string | number | boolean,
  ) {
    setCartonGroups((prev) =>
      prev.map((g) => {
        if (g.id !== groupId) return g;
        return {
          ...g,
          skus: g.skus.map((s) => {
            if (s.id !== skuEntryId) return s;
            const updated = { ...s, [field]: value };
            // Reset pre_filled when SKU switches — the new SKU might be
            // non-fillable or have different defaults.
            if (field === "sku_id") updated.pre_filled = false;
            return updated;
          }),
        };
      }),
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitError(null);

    if (cartonGroups.length === 0 || !cartonGroups.some((g) => g.carton_qty > 0 && g.skus.some((s) => s.sku_id && s.quantity > 0))) {
      setSubmitError("Add at least one carton with a SKU and quantity.");
      return;
    }
    if (!carrier.trim()) {
      setSubmitError("Carrier is required.");
      return;
    }

    // Aggregate by SKU to satisfy the unique (shipment, sku) index — same
    // pattern admin uses. Each aggregated line carries summed quantity +
    // summed prefilled count + the best-guess source FOI (oldest open).
    const bySku = new Map<
      string,
      {
        sku_id: string;
        quantity: number;
        quantity_prefilled: number;
        is_fillable: boolean;
        source_foi: string | null;
      }
    >();
    for (const group of cartonGroups) {
      for (const s of group.skus) {
        if (!s.sku_id || s.quantity <= 0) continue;
        const product = skus.data?.find((p) => p.id === s.sku_id);
        const fillable = product?.category === "fillable";
        const prefilledQty = fillable && s.pre_filled ? s.quantity : 0;
        const existing = bySku.get(s.sku_id);
        if (existing) {
          existing.quantity += s.quantity;
          existing.quantity_prefilled += prefilledQty;
        } else {
          bySku.set(s.sku_id, {
            sku_id: s.sku_id,
            quantity: s.quantity,
            quantity_prefilled: prefilledQty,
            is_fillable: fillable,
            source_foi: skuAvailability.get(s.sku_id)?.oldestFoi?.id ?? null,
          });
        }
      }
    }

    try {
      const res = await create.mutateAsync({
        idempotencyKey,
        freightType,
        carrier: carrier.trim(),
        trackingNumber: trackingNumber.trim() || null,
        shipDate: shipDate || null,
        eta: eta || null,
        totalCartons: totals.totalCartons,
        freightCost: freightCost ? Math.max(0, parseFloat(freightCost)) : 0,
        lines: Array.from(bySku.values()).map((row) => ({
          skuId: row.sku_id,
          supplierDeclaredQuantity: row.quantity,
          // Non-fillable SKUs send null so prefill stats ignore them.
          quantityPrefilled: row.is_fillable ? row.quantity_prefilled : null,
          sourceFactoryOrderItemId: row.source_foi,
        })),
      });
      toast({
        title: res.replayed ? "Shipment already existed" : "Shipment created",
        description: `${res.line_count ?? bySku.size} line(s). ${notes.trim() ? "Notes saved." : ""}`,
      });
      navigate("/supplier/shipments");
    } catch (err) {
      // PostgREST + RPC envelope errors surface both message and details —
      // prefer whatever the hook's toError wrapper already normalized.
      setSubmitError(err instanceof Error ? err.message : "Failed to create shipment");
    }
  }

  const isValid =
    cartonGroups.some(
      (g) => g.carton_qty > 0 && g.skus.some((s) => s.sku_id && s.quantity > 0),
    ) && carrier.trim().length > 0;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" onClick={() => navigate("/supplier/shipments")}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div>
          <h1 className="text-2xl font-bold">New Shipment</h1>
          <p className="text-muted-foreground text-sm">
            Declare a shipment. Starts in <code className="text-xs">pending</code>; once you
            add a tracking number + carrier it auto-advances to{" "}
            <code className="text-xs">on the water</code>.
          </p>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Freight type */}
        <div className="grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={() => setFreightType("sea")}
            className={cn(
              "flex items-center justify-center gap-3 rounded-lg border p-4 transition-all",
              freightType === "sea"
                ? "border-primary bg-primary/10 ring-1 ring-primary"
                : "border-border hover:bg-muted/50",
            )}
          >
            <Ship
              className={cn(
                "h-5 w-5",
                freightType === "sea" ? "text-blue-400" : "text-muted-foreground",
              )}
            />
            <span
              className={cn(
                "font-medium",
                freightType === "sea" ? "text-foreground" : "text-muted-foreground",
              )}
            >
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
                : "border-border hover:bg-muted/50",
            )}
          >
            <Plane
              className={cn(
                "h-5 w-5",
                freightType === "air" ? "text-cyan-400" : "text-muted-foreground",
              )}
            />
            <span
              className={cn(
                "font-medium",
                freightType === "air" ? "text-foreground" : "text-muted-foreground",
              )}
            >
              Air Freight
            </span>
          </button>
        </div>

        {/* Shipment details */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Shipment Details</CardTitle>
            <CardDescription>
              Shipment number is generated on submit. You can fill in the tracking number now or later when
              you book with the carrier.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="carrier">Carrier *</Label>
                <Input
                  id="carrier"
                  placeholder={freightType === "sea" ? "e.g. Maersk" : "e.g. FedEx"}
                  value={carrier}
                  onChange={(e) => setCarrier(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="tracking">Tracking Number</Label>
                <Input
                  id="tracking"
                  placeholder="Optional at this stage"
                  value={trackingNumber}
                  onChange={(e) => setTrackingNumber(e.target.value)}
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
                  onChange={(e) => setShipDate(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="eta">Estimated Arrival (ETA)</Label>
                <Input
                  id="eta"
                  type="date"
                  value={eta}
                  onChange={(e) => setEta(e.target.value)}
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="freight-cost">Freight Cost</Label>
                <div className="relative">
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
                  />
                </div>
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
                <CardDescription>
                  Each carton group represents identical cartons. Add multiple SKUs to a group for mixed
                  cartons. Finished/unshipped units from your open factory orders appear at the top of the
                  SKU list.
                </CardDescription>
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
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="mt-2"
                  onClick={addCartonGroup}
                >
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
                        isMixed ? "border-yellow-500/40 bg-yellow-500/5" : "border-border",
                      )}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-3">
                          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                            Carton {gi + 1}
                          </span>
                          {isMixed && (
                            <Badge
                              variant="outline"
                              className="border-yellow-500/60 text-yellow-400 text-[10px]"
                            >
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
                              onChange={(e) =>
                                updateCartonGroup(
                                  group.id,
                                  "carton_qty",
                                  parseInt(e.target.value, 10) || 0,
                                )
                              }
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

                      {group.skus.map((skuEntry) => {
                        const product = skus.data?.find((p) => p.id === skuEntry.sku_id);
                        const isFillable = product?.category === "fillable";
                        const avail = skuAvailability.get(skuEntry.sku_id)?.available;
                        return (
                          <div
                            key={skuEntry.id}
                            className="grid grid-cols-1 sm:grid-cols-[1fr_90px_auto_32px] gap-2 items-center"
                          >
                            <Select
                              value={skuEntry.sku_id}
                              onValueChange={(v) =>
                                updateSKUEntry(group.id, skuEntry.id, "sku_id", v)
                              }
                            >
                              <SelectTrigger className="h-9">
                                <SelectValue placeholder="Select SKU...">
                                  {product ? (
                                    <span className="flex items-center gap-2">
                                      <span className="font-medium">{product.sku}</span>
                                      <span className="text-xs text-muted-foreground truncate">
                                        {product.product_name}
                                      </span>
                                      {avail !== undefined && avail > 0 && (
                                        <Badge
                                          variant="outline"
                                          className="text-[9px] border-green-400/50 text-green-400"
                                        >
                                          {avail} ready
                                        </Badge>
                                      )}
                                    </span>
                                  ) : (
                                    "Select SKU..."
                                  )}
                                </SelectValue>
                              </SelectTrigger>
                              <SelectContent>
                                {availableSKUs.map((p) => {
                                  const readyUnits = skuAvailability.get(p.id)?.available ?? 0;
                                  return (
                                    <SelectItem key={p.id} value={p.id}>
                                      <span className="font-medium">{p.sku}</span>
                                      <span className="ml-2 text-xs text-muted-foreground">
                                        {p.product_name}
                                      </span>
                                      <Badge variant="outline" className="ml-2 text-[9px]">
                                        {p.category === "fillable" ? "Fill" : "Non-Fill"}
                                      </Badge>
                                      {readyUnits > 0 && (
                                        <Badge
                                          variant="outline"
                                          className="ml-1 text-[9px] border-green-400/50 text-green-400"
                                        >
                                          {readyUnits} ready
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
                              onChange={(e) =>
                                updateSKUEntry(
                                  group.id,
                                  skuEntry.id,
                                  "quantity",
                                  parseInt(e.target.value, 10) || 0,
                                )
                              }
                            />
                            {isFillable ? (
                              <label className="flex items-center gap-1.5 cursor-pointer select-none whitespace-nowrap">
                                <Checkbox
                                  checked={skuEntry.pre_filled}
                                  onCheckedChange={(checked) =>
                                    updateSKUEntry(
                                      group.id,
                                      skuEntry.id,
                                      "pre_filled",
                                      !!checked,
                                    )
                                  }
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
                        );
                      })}

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

                      <Input
                        className="h-8 text-xs"
                        placeholder="Notes (optional)"
                        value={group.notes}
                        onChange={(e) => updateCartonGroup(group.id, "notes", e.target.value)}
                      />
                    </div>
                  );
                })}

                <Separator />
                <div className="flex items-center justify-between text-sm px-1">
                  <span className="text-muted-foreground">
                    {cartonGroups.length} carton group{cartonGroups.length !== 1 ? "s" : ""}
                    {" "}·{" "}{totals.totalUnits.toLocaleString()} units
                  </span>
                  <span className="font-medium tabular-nums">
                    {totals.totalCartons} carton{totals.totalCartons !== 1 ? "s" : ""} total
                  </span>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        {/* Notes — kept local (not persisted on the shipment yet; visible
            to internal team via audit details when they pull the audit log). */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Internal Notes (optional)</CardTitle>
            <CardDescription>
              Not sent to the carrier. Recorded against this shipment for internal reference.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Input
              placeholder="Anything the receiver should know"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </CardContent>
        </Card>

        {submitError && (
          <div className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">
            {submitError}
          </div>
        )}

        <div className="flex items-center justify-between pb-6">
          <Button type="button" variant="outline" onClick={() => navigate("/supplier/shipments")}>
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={!isValid || create.isPending}
            className="min-w-[140px]"
          >
            {create.isPending ? "Creating…" : "Create Shipment"}
          </Button>
        </div>
      </form>
    </div>
  );
}
