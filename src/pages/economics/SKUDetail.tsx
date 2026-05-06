import { useParams, useNavigate } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ArrowLeft, EyeOff, Eye, Plus, Trash2, Star, StarOff, Pencil, Check, X } from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { useState, useMemo, useEffect, useRef } from "react";
import {
  useProduct,
  useUpdateProduct,
  useSuppliers,
  useSkuEconomics,
  useUpsertSkuEconomics,
  useSkuSupplierCosts,
  useUpsertSkuSupplierCost,
  useDeleteSkuSupplierCost,
  useSetPrimarySkuSupplierCost,
  useSkuPrefillStats,
} from "@/lib/hooks";
import { DEFAULT_CC_FEE_RATE } from "@/lib/inventory-math";

const COLORS = ["hsl(205,94%,56%)", "hsl(142,71%,45%)", "hsl(31,97%,56%)", "hsl(270,67%,56%)"];

// Default cost values used the first time a SKU's economics row is
// created. Dollar amounts default to 0 — the operator must enter real
// numbers before saving so we never persist a fabricated cost. The
// percentage splits default to "100% sea / 0% air / 100% US-mfg" since
// that matches the dominant pattern in our catalog (see migration 045
// imports). After the first save, `values` hydrates from sku_economics
// on load and round-trips through useUpsertSkuEconomics on save.
const initialValues = {
  additional_raw_cost: 0,
  pct_sea: 100,
  pct_air: 0,
  sea_freight_cost_per_unit: 0,
  air_freight_cost_per_unit: 0,
  breakage_issue_cost: 0,
  labor_cost_us: 0,
  glycerin_cost_us: 0,
  manufacturing_cost_cn: 0,
  packing_material_cost: 0,
  packing_labor_cost: 0,
  shipping_cost: 0,
};

type CostValues = typeof initialValues;

/** Pull only the persisted-cost subset out of a sku_economics row. */
function pickCostValues(
  e: { [K in keyof CostValues]: number | null } | null | undefined,
): CostValues {
  if (!e) return initialValues;
  return {
    additional_raw_cost: e.additional_raw_cost ?? initialValues.additional_raw_cost,
    pct_sea: e.pct_sea ?? initialValues.pct_sea,
    pct_air: e.pct_air ?? initialValues.pct_air,
    sea_freight_cost_per_unit: e.sea_freight_cost_per_unit ?? initialValues.sea_freight_cost_per_unit,
    air_freight_cost_per_unit: e.air_freight_cost_per_unit ?? initialValues.air_freight_cost_per_unit,
    breakage_issue_cost: e.breakage_issue_cost ?? initialValues.breakage_issue_cost,
    labor_cost_us: e.labor_cost_us ?? initialValues.labor_cost_us,
    glycerin_cost_us: e.glycerin_cost_us ?? initialValues.glycerin_cost_us,
    manufacturing_cost_cn: e.manufacturing_cost_cn ?? initialValues.manufacturing_cost_cn,
    packing_material_cost: e.packing_material_cost ?? initialValues.packing_material_cost,
    packing_labor_cost: e.packing_labor_cost ?? initialValues.packing_labor_cost,
    shipping_cost: e.shipping_cost ?? initialValues.shipping_cost,
  };
}

export default function SKUDetail() {
  const { skuId } = useParams();
  const navigate = useNavigate();
  const { data: product, isLoading } = useProduct(skuId ?? "");
  const updateProduct = useUpdateProduct();
  const { isAdmin } = useAuth();

  // Persistent data
  const suppliersQ = useSuppliers({ activeOnly: true });
  const economicsQ = useSkuEconomics(skuId ?? null);
  const supplierCostsQ = useSkuSupplierCosts(skuId ?? null);
  const upsertEcon = useUpsertSkuEconomics();
  const upsertCost = useUpsertSkuSupplierCost();
  const deleteCost = useDeleteSkuSupplierCost();
  const setPrimary = useSetPrimarySkuSupplierCost();

  // Cost values mirror sku_economics. Hydrated from the query when it lands;
  // persisted via handleSaveCosts → useUpsertSkuEconomics. `lastSaved` is the
  // server-side snapshot used for the dirty-button check so we don't write a
  // round-trip when the user hasn't actually changed anything.
  const [values, setValues] = useState<CostValues>(initialValues);
  const [lastSaved, setLastSaved] = useState<CostValues>(initialValues);
  // additional_raw_cost_reason is a free-form text companion to the
  // additional_raw_cost number — held separately because CostValues is
  // typed all-number. Persisted alongside the numeric fields on save.
  const [additionalRawReason, setAdditionalRawReason] = useState<string>("");
  const [lastSavedReason, setLastSavedReason] = useState<string>("");
  const [isActive, setIsActive] = useState<boolean | undefined>(undefined);

  // Inline retail price edit — pencil → input → check (save) / x (cancel).
  // Persists via useUpdateProduct, same hook the deactivate button uses.
  const [editingRetail, setEditingRetail] = useState(false);
  const [retailDraft, setRetailDraft] = useState("");
  // Surface mutation failures inline. Each handler clears this on entry
  // and sets it on a thrown error; the sticky save bar at the bottom
  // displays it. Without this, network/RLS failures from the mutations
  // were silently swallowed (mutation toast wiring is per-hook and
  // wasn't installed for upsertCost / upsertEcon / updateProduct here).
  const [saveError, setSaveError] = useState<string | null>(null);
  const [retailError, setRetailError] = useState<string | null>(null);

  // Inline SKU code + product name edits (admin-only). Same pencil → input
  // → check/x pattern as retail. SKU rename is allowed because all
  // FK/relational references go via product_skus.id (UUID) — only the
  // human-readable text columns (e.g. shipstation_order_items.sku_code,
  // freight_line_items snapshots) keep their old text after a rename, which
  // is intentional historical preservation.
  const [editingSku, setEditingSku] = useState(false);
  const [skuDraft, setSkuDraft] = useState("");
  const [skuError, setSkuError] = useState<string | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);

  function startRetailEdit() {
    setRetailDraft(product?.retail_price?.toString() ?? "");
    setEditingRetail(true);
  }
  function cancelRetailEdit() {
    setEditingRetail(false);
    setRetailDraft("");
    setRetailError(null);
  }
  async function saveRetailEdit() {
    if (!product) return;
    setRetailError(null);
    const next = parseFloat(retailDraft);
    if (!Number.isFinite(next) || next < 0) {
      // Bad input — surface a hint instead of silently bailing.
      setRetailError("Retail price must be a non-negative number");
      return;
    }
    try {
      await updateProduct.mutateAsync({
        id: product.id,
        updates: { retail_price: next },
      });
      setEditingRetail(false);
      setRetailDraft("");
    } catch (err) {
      setRetailError(err instanceof Error ? err.message : "Failed to save retail price");
    }
  }

  function startSkuEdit() {
    setSkuDraft(product?.sku ?? "");
    setEditingSku(true);
    setSkuError(null);
  }
  function cancelSkuEdit() {
    setEditingSku(false);
    setSkuDraft("");
    setSkuError(null);
  }
  async function saveSkuEdit() {
    if (!product) return;
    setSkuError(null);
    const next = skuDraft.trim();
    if (!next) {
      setSkuError("SKU code is required");
      return;
    }
    if (next === product.sku) {
      setEditingSku(false);
      return;
    }
    try {
      // No expectedVersion — matches the existing retail/category edits on
      // this page. row_version isn't projected through the useProduct hook's
      // type, and concurrent edits to product_skus metadata are rare.
      await updateProduct.mutateAsync({
        id: product.id,
        updates: { sku: next },
      });
      setEditingSku(false);
      setSkuDraft("");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to save SKU code";
      // Friendly hint for the unique-key violation on product_skus.sku
      if (/duplicate key|product_skus_sku_key|unique/i.test(msg)) {
        setSkuError(`Another product already uses code "${next}"`);
      } else {
        setSkuError(msg);
      }
    }
  }

  function startNameEdit() {
    setNameDraft(product?.product_name ?? "");
    setEditingName(true);
    setNameError(null);
  }
  function cancelNameEdit() {
    setEditingName(false);
    setNameDraft("");
    setNameError(null);
  }
  async function saveNameEdit() {
    if (!product) return;
    setNameError(null);
    const next = nameDraft.trim();
    if (!next) {
      setNameError("Product name is required");
      return;
    }
    if (next === product.product_name) {
      setEditingName(false);
      return;
    }
    try {
      await updateProduct.mutateAsync({
        id: product.id,
        updates: { product_name: next },
      });
      setEditingName(false);
      setNameDraft("");
    } catch (err) {
      setNameError(err instanceof Error ? err.message : "Failed to save product name");
    }
  }

  // Category toggle (fillable ↔ non_fillable). Same pencil-on-hover
  // affordance as retail price, but the editor is a 2-button radio
  // since there are only two valid values. Persisted via useUpdateProduct.
  const [editingCategory, setEditingCategory] = useState(false);
  async function setCategoryTo(next: "fillable" | "non_fillable") {
    if (!product || product.category === next) {
      setEditingCategory(false);
      return;
    }
    await updateProduct.mutateAsync({
      id: product.id,
      updates: { category: next },
    });
    setEditingCategory(false);
  }

  // New-supplier-row state (for the "Add supplier" picker at the bottom of
  // the Raw Cost section).
  const [newSupplierId, setNewSupplierId] = useState<string>("");
  const [newUnitCost, setNewUnitCost] = useState<string>("");

  // Local mirror of persisted mfg override fields so edits don't round-trip
  // to the DB on every keystroke. Saved via the button in the section.
  const [mfgOverrideActive, setMfgOverrideActive] = useState<boolean>(false);
  const [mfgOverridePct, setMfgOverridePct] = useState<string>("");
  const [mfgWindow, setMfgWindow] = useState<number>(30);

  // Refs that track the current edit state without re-triggering the
  // hydration effect. Without this, the effect closes over stale
  // `values` / `lastSaved` / reason at first render and either misses
  // the dirty check or fires too aggressively. Refs let the effect
  // read the *latest* state at the moment a refetch lands.
  const valuesRef = useRef(values);
  const lastSavedRef = useRef(lastSaved);
  const reasonRef = useRef(additionalRawReason);
  const lastSavedReasonRef = useRef(lastSavedReason);
  useEffect(() => {
    valuesRef.current = values;
    lastSavedRef.current = lastSaved;
    reasonRef.current = additionalRawReason;
    lastSavedReasonRef.current = lastSavedReason;
  });

  useEffect(() => {
    if (!economicsQ.data) return;
    // Mfg override fields hydrate unconditionally — they're managed by
    // their own "Save mfg settings" button, not the cost dirty check,
    // so a refetch reflecting the latest server value is what we want.
    setMfgOverrideActive(economicsQ.data.mfg_override_active);
    setMfgOverridePct(
      economicsQ.data.mfg_override_pct_prefilled?.toString() ?? "",
    );
    setMfgWindow(economicsQ.data.mfg_window_days);

    // Hydrate the cost-input mirror from the freshly-loaded server row.
    // Critical guard: if the user has local unsaved edits to the cost
    // fields, *do not* overwrite them on refetch (window-focus refetch
    // would otherwise silently revert in-flight typing). Compare the
    // current `values` against `lastSaved` via refs to detect dirtiness
    // without making the effect depend on those state values (which
    // would re-fire on every keystroke).
    const fromServer = pickCostValues(economicsQ.data);
    const reason = economicsQ.data.additional_raw_cost_reason ?? "";

    const keys = Object.keys(initialValues) as (keyof CostValues)[];
    const valuesDirty = keys.some(
      (k) => valuesRef.current[k] !== lastSavedRef.current[k],
    );
    const reasonDirty = reasonRef.current !== lastSavedReasonRef.current;

    if (valuesDirty || reasonDirty) {
      // User has work in flight — keep their edits; don't touch
      // `lastSaved` either, so the dirty button stays accurate.
      // (Trade-off: if another user saved server-side while this user
      // was editing, we won't see their changes until this user saves
      // or discards. That's the correct trade — preserving user work
      // beats "fresh data for stale tabs.")
      return;
    }

    setValues(fromServer);
    setLastSaved(fromServer);
    setAdditionalRawReason(reason);
    setLastSavedReason(reason);
  }, [economicsQ.data]);

  const prefillQ = useSkuPrefillStats(skuId ?? null, mfgWindow);

  // Credit card fees: prefer the per-SKU stored value when present
  // (`sku_economics.credit_card_fees`), fall back to the default rate
  // applied to retail. DEFAULT_CC_FEE_RATE lives in inventory-math.ts
  // so changing the rate is a one-line edit, not a search-and-replace.
  const ccFeesStored = economicsQ.data?.credit_card_fees ?? null;
  const creditCardFees =
    ccFeesStored != null && ccFeesStored > 0
      ? ccFeesStored
      : Math.round((product?.retail_price ?? 0) * DEFAULT_CC_FEE_RATE * 100) / 100;

  const pctPairs: Record<string, string> = {
    pct_sea: "pct_air",
    pct_air: "pct_sea",
  };
  function set(field: keyof typeof initialValues, val: string) {
    // Defensive parsing. Empty string → 0 (operator clearing the field
    // is a deliberate "no value yet"). Non-empty garbage like "abc" →
    // ignore the keystroke entirely; previously `parseFloat(x) || 0`
    // silently coerced it to 0, which round-tripped to the DB on save
    // and looked indistinguishable from a real $0 cost. Negative values
    // are clamped to 0 — none of these fields can legitimately be
    // negative (raw cost, freight, labor etc).
    let parsed: number;
    if (val.trim() === "") {
      parsed = 0;
    } else {
      const n = parseFloat(val);
      if (!Number.isFinite(n)) return;
      parsed = Math.max(0, n);
    }
    const complement = pctPairs[field];
    if (complement) {
      const clamped = Math.min(100, Math.max(0, parsed));
      setValues((prev) => ({
        ...prev,
        [field]: clamped,
        [complement]: Math.round((100 - clamped) * 100) / 100,
      }));
    } else {
      setValues((prev) => ({ ...prev, [field]: parsed }));
    }
  }

  // Lookup supplier names for the cost rows.
  const supplierLookup = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of suppliersQ.data ?? []) m.set(s.id, s.name);
    return m;
  }, [suppliersQ.data]);

  const costRows = supplierCostsQ.data ?? [];
  const primaryCost = costRows.find((r) => r.is_primary) ?? null;

  // Which suppliers are available to add (not already on this SKU)?
  const availableSuppliers = (suppliersQ.data ?? []).filter(
    (s) => !costRows.some((r) => r.supplier_id === s.id),
  );

  // ---- Computed cost rollups ------------------------------------------------

  const rawCost = useMemo(() => {
    // Primary supplier cost + any additional raw cost captured on sku_economics.
    return (primaryCost?.unit_cost ?? 0) + values.additional_raw_cost;
  }, [primaryCost, values.additional_raw_cost]);

  const importCost = useMemo(() => {
    const v = values;
    return (
      (v.pct_sea / 100) * v.sea_freight_cost_per_unit +
      (v.pct_air / 100) * v.air_freight_cost_per_unit +
      v.breakage_issue_cost
    );
  }, [values]);

  // Effective prefilled fraction: manual override (if active) wins; otherwise
  // the freight-derived value; if neither is available, treat as 0 for the
  // math (all units assumed unfilled — errs toward higher US labor cost).
  const isNonFillable = product?.category === "non_fillable";

  const effectivePrefilledPct = useMemo(() => {
    if (isNonFillable) return null;
    if (mfgOverrideActive && mfgOverridePct.trim() !== "") {
      const v = parseFloat(mfgOverridePct);
      if (!Number.isNaN(v)) return Math.min(100, Math.max(0, v)) / 100;
    }
    if (prefillQ.data?.pctPrefilled !== null && prefillQ.data?.pctPrefilled !== undefined) {
      return prefillQ.data.pctPrefilled;
    }
    return null;
  }, [isNonFillable, mfgOverrideActive, mfgOverridePct, prefillQ.data]);

  const mfgCost = useMemo(() => {
    if (isNonFillable) return 0;
    const prefilled = effectivePrefilledPct ?? 0;
    const unfilled = 1 - prefilled;
    // Prefilled path: no US labor, no glycerin, only CN manufacturing cost.
    // Unfilled path: US labor + glycerin (CN manufacturing cost is assumed
    // bundled into raw cost when unfilled — matches the prior model).
    return unfilled * (values.labor_cost_us + values.glycerin_cost_us)
      + prefilled * values.manufacturing_cost_cn;
  }, [isNonFillable, effectivePrefilledPct, values.labor_cost_us, values.glycerin_cost_us, values.manufacturing_cost_cn]);

  const packShip = values.packing_material_cost + values.packing_labor_cost + values.shipping_cost + creditCardFees;
  const finished = rawCost + importCost + mfgCost;
  const totalD2C = finished + packShip;

  const pieData = [
    { name: "Raw", value: rawCost },
    { name: "Import", value: importCost },
    { name: "Manufacturing", value: mfgCost },
    { name: "Pack & Ship", value: packShip },
  ];

  const activeState = isActive ?? product?.is_active ?? true;

  // ---- Handlers -------------------------------------------------------------

  async function handleAddSupplierCost() {
    if (!skuId || !newSupplierId || !newUnitCost.trim()) return;
    setSaveError(null);
    const cost = parseFloat(newUnitCost);
    if (!Number.isFinite(cost) || cost < 0) {
      setSaveError("Unit cost must be a non-negative number");
      return;
    }
    try {
      await upsertCost.mutateAsync({
        skuId,
        supplierId: newSupplierId,
        unitCost: cost,
      });
      // If this is the first row on this SKU, promote it to primary automatically
      // so the raw-cost rollup has something to use.
      const willBeFirst = costRows.length === 0;
      if (willBeFirst) {
        // Need the new row's id — refetch will produce it; then promote.
        // Trigger invalidation first via the upsert's onSuccess, then fire set-primary
        // once the new row lands. Simpler: just let the user hit the star.
      }
      setNewSupplierId("");
      setNewUnitCost("");
    } catch (err) {
      // Don't clear inputs on failure — let the user see what they had
      // queued so they can retry. Surface the error inline.
      setSaveError(err instanceof Error ? err.message : "Failed to add supplier cost");
    }
  }

  async function handleSaveMfg() {
    if (!skuId) return;
    setSaveError(null);
    try {
      await upsertEcon.mutateAsync({
        skuId,
        updates: {
          mfg_override_active: mfgOverrideActive,
          mfg_override_pct_prefilled:
            mfgOverrideActive && mfgOverridePct.trim() !== ""
              ? parseFloat(mfgOverridePct)
              : null,
          mfg_window_days: mfgWindow,
        },
      });
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to save mfg settings");
    }
  }

  // Has the user changed any of the 12 persisted cost fields since the
  // last server snapshot landed? Used to enable / disable the Save Costs
  // button. Cheap to recompute every render — 12 numeric comparisons.
  const costsDirty = useMemo(() => {
    const keys = Object.keys(initialValues) as (keyof CostValues)[];
    if (keys.some((k) => values[k] !== lastSaved[k])) return true;
    if (additionalRawReason !== lastSavedReason) return true;
    return false;
  }, [values, lastSaved, additionalRawReason, lastSavedReason]);

  async function handleSaveCosts() {
    if (!skuId) return;
    setSaveError(null);
    const trimmedReason = additionalRawReason.trim();
    try {
      await upsertEcon.mutateAsync({
        skuId,
        updates: {
          ...values,
          // Empty string → null so the column reads "no reason given"
          // rather than a literal empty string downstream.
          additional_raw_cost_reason: trimmedReason === "" ? null : trimmedReason,
        },
      });
      // Reflect saved state synchronously to avoid dirty-button flicker
      // between mutate-success and the refetch hydration.
      setLastSaved(values);
      setLastSavedReason(additionalRawReason);
    } catch (err) {
      // Leave `lastSaved` untouched on failure — the dirty button stays
      // active so the operator can retry without re-typing.
      setSaveError(err instanceof Error ? err.message : "Failed to save costs");
    }
  }

  if (isLoading) return <div className="p-8 text-muted-foreground">Loading…</div>;
  if (!product) return <div className="p-8 text-muted-foreground">SKU not found</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" onClick={() => navigate("/economics")}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div>
          <div className="flex items-center gap-2">
            {/* SKU code — inline editable (admin only). Pencil shows on
                hover; click puts the code into an input. Enter or check
                button saves; Escape or x button cancels. Unique-key
                violations are caught and surfaced as a friendly hint. */}
            {editingSku ? (
              <div className="flex items-center gap-1">
                <Input
                  value={skuDraft}
                  onChange={(e) => setSkuDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") saveSkuEdit();
                    if (e.key === "Escape") cancelSkuEdit();
                  }}
                  autoFocus
                  className="h-8 text-xl font-bold w-44"
                  disabled={updateProduct.isPending}
                />
                <Button size="icon" variant="ghost" className="h-8 w-8" onClick={saveSkuEdit} disabled={updateProduct.isPending} title="Save (Enter)">
                  <Check className="h-4 w-4 text-green-400" />
                </Button>
                <Button size="icon" variant="ghost" className="h-8 w-8" onClick={cancelSkuEdit} disabled={updateProduct.isPending} title="Cancel (Escape)">
                  <X className="h-4 w-4 text-muted-foreground" />
                </Button>
                {skuError && (
                  <span className="text-[11px] text-red-400 ml-1" title={skuError}>
                    {skuError}
                  </span>
                )}
              </div>
            ) : isAdmin ? (
              <button
                type="button"
                onClick={startSkuEdit}
                className="group inline-flex items-center gap-1"
                title="Click to edit SKU code"
              >
                <h1 className="text-2xl font-bold">{product.sku}</h1>
                <Pencil className="h-3 w-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
              </button>
            ) : (
              <h1 className="text-2xl font-bold">{product.sku}</h1>
            )}
            {/* Category badge — click pencil to flip fillable ↔ non-
                fillable. Drives whether the Manufacturing Cost card
                appears further down the page. */}
            {editingCategory ? (
              <div className="flex items-center gap-1">
                <Button
                  size="sm"
                  variant={product.category === "fillable" ? "default" : "outline"}
                  className="h-7 text-xs"
                  onClick={() => setCategoryTo("fillable")}
                  disabled={updateProduct.isPending}
                >
                  Fillable
                </Button>
                <Button
                  size="sm"
                  variant={product.category === "non_fillable" ? "default" : "outline"}
                  className="h-7 text-xs"
                  onClick={() => setCategoryTo("non_fillable")}
                  disabled={updateProduct.isPending}
                >
                  Non-Fillable
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7"
                  onClick={() => setEditingCategory(false)}
                  title="Close"
                >
                  <X className="h-3.5 w-3.5 text-muted-foreground" />
                </Button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setEditingCategory(true)}
                className="group inline-flex items-center gap-1"
                title="Click to change category"
              >
                <Badge
                  variant="outline"
                  className={
                    product.category === "fillable"
                      ? "border-blue-500 text-blue-400"
                      : "border-muted text-muted-foreground"
                  }
                >
                  {product.category === "fillable" ? "Fillable" : "Non-Fillable"}
                </Badge>
                <Pencil className="h-3 w-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
              </button>
            )}
            <Badge variant="outline" className="border-muted text-muted-foreground">
              {product.display_category}
            </Badge>
            {/* Retail price — inline editable. Pencil shows on hover; click
                puts the value in an input. Enter or check button saves;
                Escape or x button cancels. */}
            {editingRetail ? (
              <div className="flex items-center gap-1">
                <span className="text-sm text-muted-foreground">$</span>
                <Input
                  type="number"
                  step="0.01"
                  min={0}
                  value={retailDraft}
                  onChange={(e) => setRetailDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") saveRetailEdit();
                    if (e.key === "Escape") cancelRetailEdit();
                  }}
                  autoFocus
                  className="h-7 text-xs w-24 tabular-nums"
                  disabled={updateProduct.isPending}
                />
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7"
                  onClick={saveRetailEdit}
                  disabled={updateProduct.isPending}
                  title="Save (Enter)"
                >
                  <Check className="h-3.5 w-3.5 text-green-400" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7"
                  onClick={cancelRetailEdit}
                  disabled={updateProduct.isPending}
                  title="Cancel (Escape)"
                >
                  <X className="h-3.5 w-3.5 text-muted-foreground" />
                </Button>
                {retailError && (
                  <span className="text-[11px] text-red-400 ml-1" title={retailError}>
                    {retailError}
                  </span>
                )}
              </div>
            ) : (
              <button
                type="button"
                onClick={startRetailEdit}
                className="group inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground tabular-nums"
                title="Click to edit retail price"
              >
                ${product.retail_price.toFixed(2)}
                <Pencil className="h-3 w-3 opacity-0 group-hover:opacity-100 transition-opacity" />
              </button>
            )}
            {!activeState && (
              <Badge variant="outline" className="border-red-500/50 text-red-400">Inactive</Badge>
            )}
          </div>
          {/* Product name — inline editable (admin only). */}
          {editingName ? (
            <div className="flex items-center gap-1 mt-1">
              <Input
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") saveNameEdit();
                  if (e.key === "Escape") cancelNameEdit();
                }}
                autoFocus
                className="h-7 text-sm w-80"
                disabled={updateProduct.isPending}
              />
              <Button size="icon" variant="ghost" className="h-7 w-7" onClick={saveNameEdit} disabled={updateProduct.isPending} title="Save (Enter)">
                <Check className="h-3.5 w-3.5 text-green-400" />
              </Button>
              <Button size="icon" variant="ghost" className="h-7 w-7" onClick={cancelNameEdit} disabled={updateProduct.isPending} title="Cancel (Escape)">
                <X className="h-3.5 w-3.5 text-muted-foreground" />
              </Button>
              {nameError && (
                <span className="text-[11px] text-red-400 ml-1" title={nameError}>
                  {nameError}
                </span>
              )}
            </div>
          ) : isAdmin ? (
            <button
              type="button"
              onClick={startNameEdit}
              className="group inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
              title="Click to edit product name"
            >
              <span>{product.product_name}</span>
              <Pencil className="h-3 w-3 opacity-0 group-hover:opacity-100 transition-opacity" />
            </button>
          ) : (
            <p className="text-muted-foreground">{product.product_name}</p>
          )}
        </div>
      </div>

      {/* No-economics-row banner. Surfaces when this SKU has never had
          its costs saved — the inputs below are starter zeros, not real
          data. Hidden once the user saves at least once. */}
      {!economicsQ.isLoading && !economicsQ.data && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3">
          <p className="text-sm text-amber-200">
            <span className="font-semibold">No cost data on file.</span> The fields
            below default to zero — enter real numbers before clicking{" "}
            <span className="font-mono text-xs">Save costs</span> so this SKU's cost
            rollup, margin, and Open Value contribution are accurate.
          </p>
        </div>
      )}

      {/* Cost rollup - stacked bar */}
      <Card>
        <CardContent className="pt-6 space-y-4">
          <div className="flex items-baseline gap-3">
            <span className="text-sm font-medium text-muted-foreground">Total D2C Cost</span>
            <span className="text-3xl font-bold tabular-nums tracking-tight text-primary">
              ${totalD2C.toFixed(2)}
            </span>
            {product.retail_price > 0 && (() => {
              const profit = product.retail_price - totalD2C;
              const marginPct = Math.round((profit / product.retail_price) * 100);
              return (
                <Badge variant="outline" className={profit > 0 ? "border-green-500 text-green-400" : "border-red-500 text-red-400"}>
                  {marginPct}% margin · ${profit.toFixed(2)} profit per unit
                </Badge>
              );
            })()}
          </div>

          <div className="flex h-10 w-full overflow-hidden rounded-lg">
            {pieData.map((d, i) => {
              const pct = totalD2C > 0 ? (d.value / totalD2C) * 100 : 0;
              if (pct <= 0) return null;
              return (
                <div
                  key={d.name}
                  className="flex items-center justify-center text-xs font-semibold text-white"
                  style={{ width: `${pct}%`, backgroundColor: COLORS[i], minWidth: pct > 4 ? undefined : "36px" }}
                >
                  ${d.value.toFixed(2)}
                </div>
              );
            })}
          </div>

          <div className="grid grid-cols-4 gap-4">
            {pieData.map((d, i) => {
              const pct = totalD2C > 0 ? Math.round((d.value / totalD2C) * 100) : 0;
              return (
                <div key={d.name} className="space-y-0.5">
                  <div className="flex items-center gap-2">
                    <div className="h-2.5 w-2.5 rounded-full shrink-0" style={{ backgroundColor: COLORS[i] }} />
                    <span className="text-xs text-muted-foreground">{d.name}</span>
                  </div>
                  <p className="text-lg font-bold tabular-nums">${d.value.toFixed(2)}</p>
                  <p className="text-[11px] text-muted-foreground tabular-nums">{pct}% of total</p>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* Editable sections */}
      <div className="grid gap-4 lg:grid-cols-2">
        {/* Raw Cost — per-supplier list */}
        <Card className={isNonFillable ? "lg:col-span-2" : undefined}>
          <CardHeader>
            <CardTitle className="text-base">Raw Cost</CardTitle>
            <CardDescription>
              Primary supplier cost drives the rollup; secondary rows are preserved for pricing
              comparison. Use the star to switch primary.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {costRows.length === 0 ? (
              <p className="text-sm text-muted-foreground italic">
                No supplier costs recorded yet. Add one below.
              </p>
            ) : (
              <div className="rounded-md border border-border overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-muted/40 text-left text-xs uppercase text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2">Supplier</th>
                      <th className="px-3 py-2 text-right">Unit Cost</th>
                      <th className="px-3 py-2 w-16 text-center">Primary</th>
                      <th className="px-3 py-2 w-8"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {costRows.map((row) => (
                      <tr key={row.id} className="border-t border-border">
                        <td className="px-3 py-2">
                          {supplierLookup.get(row.supplier_id) ?? row.supplier_id.slice(0, 8)}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <Input
                            type="number"
                            step="0.01"
                            min={0}
                            defaultValue={row.unit_cost}
                            className="h-8 w-28 text-right tabular-nums ml-auto"
                            onBlur={(e) => {
                              const v = parseFloat(e.target.value);
                              if (!Number.isNaN(v) && v !== row.unit_cost && skuId) {
                                upsertCost.mutate({
                                  skuId,
                                  supplierId: row.supplier_id,
                                  unitCost: v,
                                  notes: row.notes,
                                });
                              }
                            }}
                          />
                        </td>
                        <td className="px-3 py-2 text-center">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            disabled={row.is_primary || setPrimary.isPending || !skuId}
                            onClick={() =>
                              skuId && setPrimary.mutate({ id: row.id, skuId })
                            }
                            title={row.is_primary ? "This is the primary" : "Mark as primary"}
                          >
                            {row.is_primary ? (
                              <Star className="h-4 w-4 fill-yellow-400 text-yellow-400" />
                            ) : (
                              <StarOff className="h-4 w-4 text-muted-foreground" />
                            )}
                          </Button>
                        </td>
                        <td className="px-3 py-2">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            disabled={deleteCost.isPending || !skuId}
                            onClick={() =>
                              skuId && deleteCost.mutate({ id: row.id, skuId })
                            }
                            title="Remove this supplier's cost"
                          >
                            <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {availableSuppliers.length > 0 && (
              <div className="flex items-end gap-2 pt-2">
                <div className="flex-1 space-y-1">
                  <Label className="text-xs">Add supplier</Label>
                  <Select value={newSupplierId} onValueChange={setNewSupplierId}>
                    <SelectTrigger>
                      <SelectValue placeholder="Pick a supplier" />
                    </SelectTrigger>
                    <SelectContent>
                      {availableSuppliers.map((s) => (
                        <SelectItem key={s.id} value={s.id}>
                          <span className="font-mono text-xs">{s.code}</span>
                          <span className="ml-2">{s.name}</span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="w-32 space-y-1">
                  <Label className="text-xs">Unit cost</Label>
                  <Input
                    type="number"
                    step="0.01"
                    min={0}
                    value={newUnitCost}
                    onChange={(e) => setNewUnitCost(e.target.value)}
                    placeholder="0.00"
                  />
                </div>
                <Button
                  size="sm"
                  disabled={!newSupplierId || !newUnitCost.trim() || upsertCost.isPending}
                  onClick={handleAddSupplierCost}
                >
                  <Plus className="mr-1 h-3.5 w-3.5" />
                  Add
                </Button>
              </div>
            )}

            {/* Additional raw cost + free-form reason. The reason is
                what saves us from "why does BW64P show $1 extra raw cost?"
                six months from now — it surfaces as a tooltip on the SKU
                list. Reason is optional; the dollar value stands on its
                own if the operator skips it. */}
            <div className="grid grid-cols-[8rem_1fr] gap-2">
              <div>
                <Label className="text-xs">Additional Raw Cost</Label>
                <Input
                  type="number"
                  step="0.01"
                  value={values.additional_raw_cost}
                  onChange={(e) => set("additional_raw_cost", e.target.value)}
                />
              </div>
              <div>
                <Label className="text-xs">
                  Reason{" "}
                  <span className="text-muted-foreground/60 font-normal">
                    (optional — e.g. "tooling amortization")
                  </span>
                </Label>
                <Input
                  type="text"
                  value={additionalRawReason}
                  onChange={(e) => setAdditionalRawReason(e.target.value)}
                  placeholder={
                    values.additional_raw_cost > 0
                      ? "What's this extra cost for?"
                      : "—"
                  }
                  disabled={values.additional_raw_cost <= 0}
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Importing Cost */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Importing Cost</CardTitle>
            <CardDescription>Weighted: ${importCost.toFixed(2)}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div><Label className="text-xs">% Sea Freight</Label><Input type="number" value={values.pct_sea} onChange={(e) => set("pct_sea", e.target.value)} /></div>
              <div><Label className="text-xs">% Air Freight</Label><Input type="number" value={values.pct_air} onChange={(e) => set("pct_air", e.target.value)} /></div>
              <div><Label className="text-xs">Sea Cost/Unit</Label><Input type="number" step="0.01" value={values.sea_freight_cost_per_unit} onChange={(e) => set("sea_freight_cost_per_unit", e.target.value)} /></div>
              <div><Label className="text-xs">Air Cost/Unit</Label><Input type="number" step="0.01" value={values.air_freight_cost_per_unit} onChange={(e) => set("air_freight_cost_per_unit", e.target.value)} /></div>
            </div>
            <div><Label className="text-xs">Breakage/Issue Cost</Label><Input type="number" step="0.01" value={values.breakage_issue_cost} onChange={(e) => set("breakage_issue_cost", e.target.value)} /></div>
          </CardContent>
        </Card>

        {/* Manufacturing Cost — hidden entirely for non-fillable SKUs */}
        {!isNonFillable && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Manufacturing Cost</CardTitle>
              <CardDescription>
                Weighted: ${mfgCost.toFixed(2)}
                {effectivePrefilledPct !== null && (
                  <span className="ml-2 text-xs text-muted-foreground">
                    ({Math.round(effectivePrefilledPct * 100)}% prefilled
                    {mfgOverrideActive ? " · manual override" : ` · last ${mfgWindow}d freight`})
                  </span>
                )}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Freight-derived ratio + window slider */}
              <div className="rounded-md border border-border p-3 space-y-3 bg-muted/30">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <p className="text-xs text-muted-foreground">Auto-derived from freight</p>
                    <p className="text-sm tabular-nums">
                      {prefillQ.data?.pctPrefilled !== null && prefillQ.data?.pctPrefilled !== undefined ? (
                        <>
                          <span className="font-semibold">
                            {Math.round(prefillQ.data.pctPrefilled * 100)}% prefilled
                          </span>
                          <span className="text-muted-foreground ml-2">
                            {prefillQ.data.prefilledUnits.toLocaleString()} / {prefillQ.data.totalUnits.toLocaleString()} units across {prefillQ.data.shipmentCount} shipment(s)
                          </span>
                        </>
                      ) : (
                        <span className="text-muted-foreground">
                          Not enough data — need ≥50 tracked units. Showing 0% until more arrivals.
                        </span>
                      )}
                    </p>
                  </div>
                </div>
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <Label className="text-xs">Window: {mfgWindow} days</Label>
                    <span className="text-[10px] text-muted-foreground">30 — 90</span>
                  </div>
                  <input
                    type="range"
                    min={30}
                    max={90}
                    step={5}
                    value={mfgWindow}
                    onChange={(e) => setMfgWindow(parseInt(e.target.value, 10))}
                    className="w-full h-2 bg-border rounded appearance-none cursor-pointer accent-primary"
                  />
                </div>
              </div>

              {/* Manual override */}
              <div className="space-y-2">
                <label className="flex items-center gap-2 cursor-pointer text-xs">
                  <Checkbox
                    checked={mfgOverrideActive}
                    onCheckedChange={(c) => setMfgOverrideActive(c === true)}
                  />
                  <span>Override auto-derived % with a manual value</span>
                </label>
                {mfgOverrideActive && (
                  <div>
                    <Label className="text-xs">% Prefilled (manual)</Label>
                    <Input
                      type="number"
                      min={0}
                      max={100}
                      step={1}
                      value={mfgOverridePct}
                      onChange={(e) => setMfgOverridePct(e.target.value)}
                      placeholder="0 — 100"
                    />
                  </div>
                )}
                <Button size="sm" variant="outline" onClick={handleSaveMfg} disabled={upsertEcon.isPending}>
                  {upsertEcon.isPending ? "Saving…" : "Save mfg settings"}
                </Button>
              </div>

              {/* Unit costs that feed the rollup */}
              <div className="grid grid-cols-2 gap-3 pt-2 border-t border-border">
                <div><Label className="text-xs">Labor (US, unfilled path)</Label><Input type="number" step="0.01" value={values.labor_cost_us} onChange={(e) => set("labor_cost_us", e.target.value)} /></div>
                <div><Label className="text-xs">Glycerin (US, unfilled path)</Label><Input type="number" step="0.01" value={values.glycerin_cost_us} onChange={(e) => set("glycerin_cost_us", e.target.value)} /></div>
                <div className="col-span-2"><Label className="text-xs">Manufacturing Cost (CN, prefilled path)</Label><Input type="number" step="0.01" value={values.manufacturing_cost_cn} onChange={(e) => set("manufacturing_cost_cn", e.target.value)} /></div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Pack & Ship Cost */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Pack & Ship Cost</CardTitle>
            <CardDescription>Total: ${packShip.toFixed(2)}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div><Label className="text-xs">Packing Material</Label><Input type="number" step="0.01" value={values.packing_material_cost} onChange={(e) => set("packing_material_cost", e.target.value)} /></div>
              <div><Label className="text-xs">Packing Labor</Label><Input type="number" step="0.01" value={values.packing_labor_cost} onChange={(e) => set("packing_labor_cost", e.target.value)} /></div>
              <div><Label className="text-xs">Shipping Cost</Label><Input type="number" step="0.01" value={values.shipping_cost} onChange={(e) => set("shipping_cost", e.target.value)} /></div>
              <div>
                <Label className="text-xs">
                  Credit Card Fees{" "}
                  <span className="text-muted-foreground/60 font-normal">
                    {ccFeesStored != null && ccFeesStored > 0
                      ? "(custom)"
                      : `(${(DEFAULT_CC_FEE_RATE * 100).toFixed(0)}% of Retail — default)`}
                  </span>
                </Label>
                <Input type="number" step="0.01" value={creditCardFees} disabled className="opacity-70" />
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Save costs — single button commits all 12 persisted cost fields
          across the Raw / Importing / Manufacturing / Pack & Ship cards.
          The "Save mfg settings" button inside the Manufacturing card is
          separate — it covers the override toggle + window slider, which
          have their own UX. */}
      <div className="flex items-center justify-end gap-3 sticky bottom-2 z-10 bg-background/95 backdrop-blur p-3 -mx-3 rounded-lg border border-border shadow-sm">
        {saveError && (
          <span className="text-xs text-red-400 mr-auto" title={saveError}>
            {saveError}
          </span>
        )}
        {costsDirty && !saveError && (
          <span className="text-xs text-amber-400">Unsaved changes</span>
        )}
        <Button
          onClick={handleSaveCosts}
          disabled={!costsDirty || upsertEcon.isPending}
        >
          {upsertEcon.isPending ? "Saving…" : "Save costs"}
        </Button>
      </div>

      <div className="flex items-center justify-between">
        {isAdmin && (
          <Button
            variant="ghost"
            size="sm"
            className={activeState ? "text-muted-foreground/60 hover:text-red-400" : "text-red-400 hover:text-green-400"}
            onClick={async () => {
              const newState = !activeState;
              setIsActive(newState);
              await updateProduct.mutateAsync({ id: product.id, updates: { is_active: newState } });
            }}
          >
            {activeState ? (
              <><EyeOff className="mr-1.5 h-3.5 w-3.5" />Deactivate SKU</>
            ) : (
              <><Eye className="mr-1.5 h-3.5 w-3.5" />Reactivate SKU</>
            )}
          </Button>
        )}
      </div>
    </div>
  );
}
