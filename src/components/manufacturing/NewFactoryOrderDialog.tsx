import { useEffect, useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Plus, Trash2, Sparkles, AlertTriangle, Megaphone } from "lucide-react";
import { useUpcomingMarketingBySku, describeSkuSignals } from "@/lib/hooks/use-marketing-signals";
import {
  buildInTransitMap,
  buildOnOrderMap,
} from "@/lib/inventory-aggregates";
import { getEffectiveDemand } from "@/lib/demand";
import { buildOrderPreview } from "@/lib/order-preview";
import {
  useProducts,
  useInventory,
  useCreateFactoryOrder,
  useSuppliers,
  useFreightShipments,
  useFreightLineItems,
  useFactoryOrders,
  useAllPrimarySkuSupplierCosts,
  useForecastDemandMap,
} from "@/lib/hooks";

/**
 * Internal admin "New Factory Order" dialog. Unlike the supplier-portal
 * create form, this one is for internal staff placing orders on behalf of
 * ANY supplier — including one-off vendors outside of Nancy/YX. Supplier
 * selection is free-form via a picker backed by the `suppliers` table.
 *
 * The old version of this dialog hardcoded a nancy-or-yx split driven by
 * `display_category`. That rule doesn't hold once there are more suppliers,
 * so the auto-split is gone. If you want to place orders with two suppliers
 * simultaneously, open the dialog twice.
 */

interface LineItem {
  id: string;
  sku_id: string;
  quantity: number;
  /** YYYY-MM-DD; empty string = inherit the order-level expected_completion. */
  alternateEta: string;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pre-seed the supplier when opened from a draft (e.g. the Stock Levels
   *  order builder, which splits a cart by supplier). */
  initialSupplierId?: string;
  /** Pre-seed line items {sku_id, quantity} when opened from a draft. */
  initialItems?: { sku_id: string; quantity: number }[];
  /** Lock the supplier picker — used when the order builder has already
   *  decided the supplier for this group. */
  lockSupplier?: boolean;
  /** Called after a successful create (in addition to onOpenChange(false)),
   *  so a caller can clear the corresponding lines from its draft. */
  onCreated?: () => void;
}

const TARGET_DOS = 120;

function dosColor(dos: number): string {
  if (dos < 60) return "text-red-400";
  if (dos < 90) return "text-yellow-400";
  if (dos > 150) return "text-blue-400";
  return "text-green-400";
}

export function NewFactoryOrderDialog({
  open,
  onOpenChange,
  initialSupplierId,
  initialItems,
  lockSupplier = false,
  onCreated,
}: Props) {
  const { data: products = [] } = useProducts();
  const { data: inventory = [] } = useInventory();
  const { data: suppliers = [] } = useSuppliers({ activeOnly: true });
  const { data: shipments = [] } = useFreightShipments();
  const { data: freightLines = [] } = useFreightLineItems();
  const { data: factoryOrders = [] } = useFactoryOrders();
  // Primary supplier unit_cost per SKU — what `rawCostFor` should
  // return when real cost data exists. Pre-imported via migration 045.
  const { data: primaryCostBySkuId } = useAllPrimarySkuSupplierCosts();
  const forecastMap = useForecastDemandMap();
  const createFactoryOrder = useCreateFactoryOrder();
  // Marketing→ops alignment: flag lines whose SKU has an upcoming sale or
  // launch (60d) so order sizing accounts for it.
  const mktSignals = useUpcomingMarketingBySku();

  // Per-SKU aggregates derived from live sources (freight_shipments +
  // factory_orders). The legacy inventory_levels.in_transit_*/nancy_*/yx_*
  // columns were dropped in migration 041.
  const inTransitMap = useMemo(
    () => buildInTransitMap(shipments, freightLines),
    [shipments, freightLines],
  );
  const onOrderMap = useMemo(
    () => buildOnOrderMap(factoryOrders, freightLines),
    [factoryOrders, freightLines],
  );

  const [supplierId, setSupplierId] = useState<string>("");
  const [expected, setExpected] = useState("");
  // Order date defaults to today (YYYY-MM-DD in local time). User can
  // override if they're logging an order placed on a previous day; if
  // they clear the field entirely the submit handler falls back to
  // today, so it's effectively optional with a sensible default.
  const today = new Date().toISOString().slice(0, 10);
  const [orderDate, setOrderDate] = useState<string>(today);
  // Optional order number / name (e.g. "NAN-2026-043", "Q2 spring run").
  // Free-form; null on save when blank. Editable later via the inline
  // pencil affordance on the Factory Orders list page.
  const [orderNumber, setOrderNumber] = useState<string>("");
  const [items, setItems] = useState<LineItem[]>([]);
  const [budget, setBudget] = useState<string>("25000");
  // Budget-based auto-allocation is a power-user feature most operators
  // don't need on every order. Hidden by default to save vertical space;
  // surfaced via a small "+ Use budget-based auto-allocate" button.
  const [showBudgetAllocator, setShowBudgetAllocator] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Seed supplier + line items from the draft whenever the dialog opens with
  // pre-fill props (Stock Levels order builder). Keyed on `open` so it only
  // fires on the open transition, not on every keystroke while editing.
  useEffect(() => {
    if (!open) return;
    if (initialSupplierId !== undefined) setSupplierId(initialSupplierId);
    if (initialItems) {
      setItems(
        initialItems.map((i) => ({
          id: crypto.randomUUID(),
          sku_id: i.sku_id,
          quantity: i.quantity,
          alternateEta: "",
        })),
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const activeProducts = useMemo(
    () => products.filter((p) => p.is_active).sort((a, b) => a.sku.localeCompare(b.sku)),
    [products],
  );

  const availableProducts = useMemo(
    () => activeProducts.filter((p) => !items.some((i) => i.sku_id === p.id)),
    [activeProducts, items],
  );

  // Shared cost + days-of-stock math — identical to the Stock Levels order
  // builder so the two surfaces never disagree on cost / DOS / margin.
  const preview = useMemo(
    () =>
      buildOrderPreview({
        products,
        inventory,
        inTransitMap,
        onOrderMap,
        primaryCostBySkuId,
        forecastMap,
      }),
    [products, inventory, inTransitMap, onOrderMap, primaryCostBySkuId, forecastMap],
  );
  // Local aliases keep the existing call sites below unchanged. `rawCostFor`
  // returns null when no primary supplier cost is on file (never a guess) so
  // the line lands with NULL unit_cost rather than polluting cost rollups.
  const rawCostFor = preview.rawCostFor;
  const retailFor = preview.retailFor;
  const dosFor = preview.dosFor;

  const totals = useMemo(
    () => preview.lineTotals(items.map((i) => ({ sku_id: i.sku_id, quantity: i.quantity }))),
    [preview, items],
  );

  function addLine(skuId: string) {
    if (!skuId) return;
    setItems((prev) => [...prev, { id: crypto.randomUUID(), sku_id: skuId, quantity: 100, alternateEta: "" }]);
  }

  function updateQty(id: string, qty: number) {
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, quantity: Math.max(0, qty) } : i)));
  }

  function updateAltEta(id: string, alternateEta: string) {
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, alternateEta } : i)));
  }

  function removeLine(id: string) {
    setItems((prev) => prev.filter((i) => i.id !== id));
  }

  function autoAllocate() {
    const budgetNum = parseFloat(budget) || 0;
    if (budgetNum <= 0) return;

    const candidates = activeProducts
      .map((p) => {
        const demand = getEffectiveDemand(p.id, p.monthly_demand, forecastMap);
        const dailyDemand = demand / 30;
        const currentDOS = dosFor(p.id);
        const shortfallDays = Math.max(0, TARGET_DOS - currentDOS);
        const unitsNeeded = Math.ceil(shortfallDays * dailyDemand);
        const cartonQty = p.standard_quantity_per_carton || 1;
        // SKUs without a primary supplier cost are excluded from the
        // budget allocator — there's nothing to divide the budget by.
        // Operator gets a clear nudge to populate cost data before
        // letting the allocator route money through that SKU.
        const cost = rawCostFor(p.id);
        return { product: p, currentDOS, unitsNeeded, cartonQty, cost, dailyDemand };
      })
      .filter((c) => c.unitsNeeded > 0 && c.cost !== null && c.cost > 0)
      .sort((a, b) => a.currentDOS - b.currentDOS);

    let remaining = budgetNum;
    const allocation: LineItem[] = [];
    for (const c of candidates) {
      if (remaining <= 0) break;
      // c.cost is non-null here — the filter above dropped any SKU with
      // null/zero cost so the allocator never tries to spend budget on
      // unpriced items.
      const cost = c.cost as number;
      const maxAffordable = Math.floor(remaining / cost);
      let qty = Math.min(c.unitsNeeded, maxAffordable);
      if (c.cartonQty > 1) qty = Math.floor(qty / c.cartonQty) * c.cartonQty;
      if (qty <= 0) continue;
      allocation.push({ id: crypto.randomUUID(), sku_id: c.product.id, quantity: qty, alternateEta: "" });
      remaining -= qty * cost;
    }

    setItems(allocation);
  }

  async function handleSubmit() {
    setSubmitError(null);
    if (!supplierId) {
      setSubmitError("Pick a supplier before creating the order.");
      return;
    }
    if (items.length === 0) {
      setSubmitError("Add at least one line item.");
      return;
    }
    try {
      await createFactoryOrder.mutateAsync({
        order: {
          supplier_id: supplierId,
          expected_completion: expected || null,
          // Trim and null-out blanks so the column stays NULL instead of
          // an empty string when no order number was provided.
          order_number: orderNumber.trim() || null,
          // Internal-created orders start in 'ordered' — same as supplier-portal
          // creates. Advance via the admin UI as work progresses.
          status: "ordered",
          // User-selected order date; fall back to today if they cleared
          // the input. Today is also the initial default.
          order_date: orderDate || new Date().toISOString().slice(0, 10),
          notes: null,
        },
        items: items.map((i) => ({
          sku_id: i.sku_id,
          quantity_ordered: i.quantity,
          quantity_finished: 0,
          // Real primary supplier unit_cost or NULL — never a fabricated
          // estimate. Cost rollups downstream guard with `?? 0` so a
          // missing value visibly drops out of totals rather than
          // silently inflating them.
          unit_cost: rawCostFor(i.sku_id),
          alternate_expected_completion: i.alternateEta || null,
        })),
      });
      onOpenChange(false);
      setItems([]);
      setExpected("");
      setOrderDate(new Date().toISOString().slice(0, 10));
      setOrderNumber("");
      setSupplierId("");
      // Let a draft-driven caller (order builder) clear the lines it handed in.
      onCreated?.();
    } catch (err) {
      // PostgREST errors are plain objects with {message, details, hint, code}.
      let msg = "Unknown error";
      if (err instanceof Error) msg = err.message;
      else if (err && typeof err === "object") {
        const e = err as { message?: unknown; details?: unknown; code?: unknown };
        const parts: string[] = [];
        if (typeof e.code === "string") parts.push(`[${e.code}]`);
        if (typeof e.message === "string") parts.push(e.message);
        if (typeof e.details === "string") parts.push(e.details);
        if (parts.length) msg = parts.join(" ");
      }
      setSubmitError(msg);
    }
  }

  const budgetNum = parseFloat(budget) || 0;
  const overBudget = totals.rawCost > budgetNum && budgetNum > 0;
  const selectedSupplier = suppliers.find((s) => s.id === supplierId);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New Factory Order</DialogTitle>
          <DialogDescription>
            Place an order on behalf of any active supplier. For Nancy / YX, they'll see the order in
            their supplier portal; for one-off vendors, internal team handles comms offline.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6">
          {/* Header fields — 4-column grid. Totals moved to the Line
              Items section header below, where it semantically belongs
              (totals describe the line items, not the order metadata). */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="space-y-2">
              <Label>Supplier</Label>
              <Select value={supplierId} onValueChange={setSupplierId} disabled={lockSupplier}>
                <SelectTrigger>
                  <SelectValue placeholder="Pick a supplier" />
                </SelectTrigger>
                <SelectContent>
                  {suppliers.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      <span className="font-mono text-xs">{s.code}</span>
                      <span className="ml-2">{s.name}</span>
                    </SelectItem>
                  ))}
                  {suppliers.length === 0 && (
                    <div className="px-3 py-2 text-xs text-muted-foreground">
                      No active suppliers. Add one in Settings → Suppliers.
                    </div>
                  )}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>
                Order Number
                <span className="ml-1.5 text-[10px] text-muted-foreground/60 font-normal">
                  optional
                </span>
              </Label>
              <Input
                placeholder="e.g. NAN-2026-043"
                value={orderNumber}
                onChange={(e) => setOrderNumber(e.target.value)}
                className="font-mono text-sm"
              />
            </div>
            <div className="space-y-2">
              <Label>
                Order Date
                <span className="ml-1.5 text-[10px] text-muted-foreground/60 font-normal">
                  defaults to today
                </span>
              </Label>
              <Input
                type="date"
                value={orderDate}
                onChange={(e) => setOrderDate(e.target.value)}
                max={today}
              />
            </div>
            <div className="space-y-2">
              <Label>Expected Completion</Label>
              <Input type="date" value={expected} onChange={(e) => setExpected(e.target.value)} />
            </div>
          </div>

          {/* Budget + auto-allocate — collapsed by default. The toggle
              button below is the discoverable entry point; the panel
              renders inline when toggled on. */}
          {showBudgetAllocator ? (
            <div className="rounded-lg border border-border bg-muted/30 p-4">
              <div className="flex items-start justify-between gap-3 mb-3">
                <Label className="flex items-center gap-2 mt-1">
                  <Sparkles className="h-3.5 w-3.5 text-amber-400" />
                  Budget-based Auto Allocation
                </Label>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs text-muted-foreground"
                  onClick={() => setShowBudgetAllocator(false)}
                >
                  Hide
                </Button>
              </div>
              <div className="flex items-end gap-3">
                <div className="flex-1 space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground">$</span>
                    <Input
                      type="number"
                      value={budget}
                      onChange={(e) => setBudget(e.target.value)}
                      className="max-w-[160px]"
                      placeholder="25000"
                    />
                    <Button onClick={autoAllocate} variant="secondary" className="gap-2">
                      <Sparkles className="h-4 w-4" />
                      Auto-Allocate
                    </Button>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground max-w-xs leading-snug">
                  Distributes the budget to SKUs with the lowest current DOS first, targeting{" "}
                  {TARGET_DOS} days of stock and rounding to full cartons. SKU→supplier routing is
                  manual — the allocator doesn't try to match SKUs to this order's supplier.
                </p>
              </div>
            </div>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              className="self-start text-xs text-muted-foreground gap-1.5"
              onClick={() => setShowBudgetAllocator(true)}
            >
              <Sparkles className="h-3.5 w-3.5 text-amber-400/80" />
              Use budget-based auto-allocate
            </Button>
          )}

          {/* Line items */}
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-baseline gap-3 flex-wrap">
                <Label className="text-base">Line Items</Label>
                {/* Totals readout — moved out of the header grid so the
                    metadata row reads cleanly. Empty state nudges the
                    user toward picking a supplier first. */}
                <span className="text-xs text-muted-foreground tabular-nums">
                  {selectedSupplier ? (
                    items.length === 0 ? (
                      "0 items"
                    ) : (
                      <>
                        {items.length} line item{items.length === 1 ? "" : "s"} ·{" "}
                        {totals.units.toLocaleString()} units ·{" "}
                        ${Math.round(totals.rawCost).toLocaleString()} est. cost
                      </>
                    )
                  ) : (
                    "Pick a supplier to get started."
                  )}
                </span>
              </div>
              <div className="w-[260px]">
                <Select value="" onValueChange={addLine}>
                  <SelectTrigger>
                    <span className="flex items-center gap-2 text-muted-foreground">
                      <Plus className="h-4 w-4" />
                      Add SKU
                    </span>
                  </SelectTrigger>
                  <SelectContent>
                    {availableProducts.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        <span className="font-mono text-xs">{p.sku}</span>
                        <span className="ml-2">{p.product_name}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {items.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
                No line items yet. Add a SKU above
                {showBudgetAllocator
                  ? " or run Auto-Allocate"
                  : <> or use the <span className="text-amber-400">budget-based auto-allocate</span> shortcut</>}
                .
              </div>
            ) : (
              <div className="rounded-lg border border-border overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border bg-muted/40 text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                      <th className="px-3 py-2">SKU</th>
                      <th className="px-3 py-2 text-right">Qty</th>
                      <th className="px-3 py-2">Alt ETA</th>
                      <th className="px-3 py-2 text-right">Raw Cost</th>
                      <th className="px-3 py-2 text-right">Retail</th>
                      <th className="px-3 py-2 text-center">Current DOS</th>
                      <th className="px-3 py-2 text-center">New DOS</th>
                      <th className="px-3 py-2 w-8"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item) => {
                      const p = products.find((x) => x.id === item.sku_id);
                      if (!p) return null;
                      const unitRaw = rawCostFor(item.sku_id);
                      const unitRetail = retailFor(item.sku_id);
                      const currentDOS = dosFor(item.sku_id);
                      const newDOS = dosFor(item.sku_id, item.quantity);
                      const dosDelta = newDOS - currentDOS;
                      return (
                        <tr key={item.id} className="border-b border-border/50 last:border-0">
                          <td className="px-3 py-2">
                            <div className="font-medium flex items-center gap-1.5">
                              {p.sku}
                              {mktSignals.has(item.sku_id) && (
                                <span className="inline-flex shrink-0" title={describeSkuSignals(mktSignals.get(item.sku_id)!)}>
                                  <Megaphone className="h-3 w-3 text-pink-400" />
                                </span>
                              )}
                            </div>
                            <div className="text-[11px] text-muted-foreground truncate max-w-[220px]">
                              {p.product_name}
                            </div>
                          </td>
                          <td className="px-3 py-2">
                            <Input
                              type="number"
                              value={item.quantity}
                              onChange={(e) => updateQty(item.id, parseInt(e.target.value, 10) || 0)}
                              className="h-8 w-24 text-right tabular-nums ml-auto"
                            />
                            <div className="text-[10px] text-muted-foreground text-right mt-0.5">
                              {Math.ceil(item.quantity / (p.standard_quantity_per_carton || 1))} ctns
                            </div>
                          </td>
                          <td className="px-3 py-2">
                            <Input
                              type="date"
                              value={item.alternateEta}
                              min={new Date().toISOString().slice(0, 10)}
                              onChange={(e) => updateAltEta(item.id, e.target.value)}
                              className="h-8 w-36 text-xs"
                              placeholder={expected}
                              title={
                                item.alternateEta
                                  ? "Per-item override"
                                  : `Inheriting order ETA${expected ? ` (${expected})` : ""}`
                              }
                            />
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">
                            {unitRaw !== null ? (
                              <>
                                <div>${(unitRaw * item.quantity).toLocaleString(undefined, { maximumFractionDigits: 0 })}</div>
                                <div className="text-[10px] text-muted-foreground">${unitRaw.toFixed(2)}/u</div>
                              </>
                            ) : (
                              // No primary supplier cost on file for this SKU.
                              // Visible "—" + tooltip telling the operator how
                              // to fix it. The order can still be created; the
                              // line will land with NULL unit_cost.
                              <span
                                className="text-amber-400 text-xs"
                                title="No primary supplier cost on file. Add one on this SKU's detail page (Raw Cost section) to get accurate costing."
                              >
                                — no cost data
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">
                            <div>${(unitRetail * item.quantity).toLocaleString(undefined, { maximumFractionDigits: 0 })}</div>
                            <div className="text-[10px] text-muted-foreground">${unitRetail.toFixed(2)}/u</div>
                          </td>
                          <td className={`px-3 py-2 text-center tabular-nums ${dosColor(currentDOS)}`}>
                            {currentDOS}d
                          </td>
                          <td className="px-3 py-2 text-center tabular-nums">
                            <span className={dosColor(newDOS)}>{newDOS}d</span>
                            {dosDelta > 0 && (
                              <span className="ml-1 text-[10px] text-green-400">+{Math.round(dosDelta)}</span>
                            )}
                          </td>
                          <td className="px-2 py-2">
                            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => removeLine(item.id)}>
                              <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
                            </Button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Totals panel */}
          <div className="grid grid-cols-4 gap-3 rounded-lg border border-border bg-muted/30 p-4">
            <div>
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Total Units</p>
              <p className="text-xl font-bold tabular-nums">{totals.units.toLocaleString()}</p>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Raw Cost</p>
              <p className={`text-xl font-bold tabular-nums ${overBudget ? "text-red-400" : ""}`}>
                ${Math.round(totals.rawCost).toLocaleString()}
              </p>
              {budgetNum > 0 && (
                <p className="text-[10px] text-muted-foreground">
                  {overBudget ? (
                    <span className="text-red-400 inline-flex items-center gap-1">
                      <AlertTriangle className="h-3 w-3" /> ${Math.round(totals.rawCost - budgetNum).toLocaleString()} over
                    </span>
                  ) : (
                    <>${Math.round(budgetNum - totals.rawCost).toLocaleString()} left of ${budgetNum.toLocaleString()} budget</>
                  )}
                </p>
              )}
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Retail Value</p>
              <p className="text-xl font-bold tabular-nums">${Math.round(totals.retail).toLocaleString()}</p>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Gross Margin</p>
              <p className={`text-xl font-bold tabular-nums ${totals.margin >= 0 ? "text-green-400" : "text-red-400"}`}>
                ${Math.round(totals.margin).toLocaleString()}
              </p>
            </div>
          </div>

          {submitError && (
            <div className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-400">
              {submitError}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={
              !supplierId ||
              items.length === 0 ||
              items.every((i) => !i.sku_id || i.quantity <= 0) ||
              createFactoryOrder.isPending
            }
          >
            {createFactoryOrder.isPending ? "Creating…" : "Create Order"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
