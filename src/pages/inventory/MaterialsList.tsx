import { useMemo, useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { Plus, Beaker, Package, Boxes, ClipboardCheck, AlertTriangle, Pencil } from "lucide-react";
import {
  useMaterials,
  useUpsertMaterial,
  useBulkMaterialCycleCount,
  useAllRecipes,
  useInventory,
  useUnmatchedShipstationBoxes,
  useMaterialUsageRates,
  type MaterialWithLevel,
  type MaterialCycleCountReason,
} from "@/lib/hooks";
import {
  computeAllMaterialRunways,
  type MaterialRunwayResult,
} from "@/lib/materials/runway";
import {
  MATERIAL_CATEGORIES,
  materialCategoryRank,
  type MaterialCategory,
} from "@/lib/constants";
import { useAuth } from "@/lib/auth-context";

/**
 * Materials catalog tab — non-sellable consumables tracking.
 *
 * Released to all admin/manager users 2026-06-10. Catalog + cycle counts +
 * recipes + runway forecasting (recipe-estimated, or observed usage for
 * boxes via the nightly ShipStation box decrement) are all live.
 */
export default function MaterialsList() {
  const navigate = useNavigate();
  const { isAdmin, isManager, profile } = useAuth();
  const canEdit = isAdmin || isManager;

  const { data: materials = [], isLoading } = useMaterials();
  const { data: allRecipes = [] } = useAllRecipes();
  const { data: inventory = [] } = useInventory();
  const { data: unmatchedBoxes = [] } = useUnmatchedShipstationBoxes();
  const { data: usageRates } = useMaterialUsageRates();
  const bulkCycleCount = useBulkMaterialCycleCount();

  // Runway forecast — computed once per (materials, recipes, inventory)
  // change. Per-row reads are O(1) Map lookups.
  const runways = useMemo(() => {
    return computeAllMaterialRunways({
      materials,
      allRecipes,
      usageRateByMaterial: usageRates,
      fillableInventory: inventory
        .filter((inv) => inv.product?.category === "fillable")
        .map((inv) => ({
          product: {
            id: inv.product!.id,
            category: inv.product!.category,
            monthly_demand: inv.product!.monthly_demand,
          },
          inventory: {
            warehouse_raw: inv.warehouse_raw,
            warehouse_prefilled_raw: inv.warehouse_prefilled_raw,
            warehouse_in_production: inv.warehouse_in_production,
          },
        })),
    });
  }, [materials, allRecipes, inventory, usageRates]);

  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState<string>("");
  // Dialog: undefined = closed, null = add mode (empty form), Material =
  // edit mode (form prefilled). Single state covers both flows.
  const [editingMaterial, setEditingMaterial] = useState<MaterialWithLevel | null | undefined>(undefined);

  // ===== Cycle Count state =====
  // Same shape and bug-fix lineage as the SKU cycle count: only emit
  // deltas for materials the operator actually edited. `editValues` is
  // keyed by material_id; an undefined value means "not touched."
  const [cycleMode, setCycleMode] = useState(false);
  const [editValues, setEditValues] = useState<Record<string, number>>({});
  const [reasonDialogOpen, setReasonDialogOpen] = useState(false);
  const [reasonChoice, setReasonChoice] = useState<MaterialCycleCountReason>("recount");
  const [reasonNotes, setReasonNotes] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);

  function enterCycleMode() {
    setCycleMode(true);
    setEditValues({});
    setSaveError(null);
  }
  function exitCycleMode() {
    setCycleMode(false);
    setEditValues({});
    setReasonDialogOpen(false);
    setSaveError(null);
  }
  function setCount(materialId: string, raw: string) {
    // Parse to number, allow blank → undefined (means "not touched").
    if (raw.trim() === "") {
      setEditValues((prev) => {
        const next = { ...prev };
        delete next[materialId];
        return next;
      });
      return;
    }
    const n = parseFloat(raw);
    if (!Number.isFinite(n)) return;
    setEditValues((prev) => ({ ...prev, [materialId]: Math.max(0, n) }));
  }
  function computeAdjustments(): Array<{ materialId: string; delta: number }> {
    const out: Array<{ materialId: string; delta: number }> = [];
    for (const [materialId, newVal] of Object.entries(editValues)) {
      if (newVal === undefined) continue;
      const m = materials.find((x) => x.id === materialId);
      if (!m) continue;
      const oldVal = m.inventory?.on_hand_qty ?? 0;
      const delta = newVal - oldVal;
      if (delta !== 0) out.push({ materialId, delta });
    }
    return out;
  }
  function openReasonDialog() {
    const adj = computeAdjustments();
    if (adj.length === 0) {
      // No actual changes — just exit edit mode silently.
      exitCycleMode();
      return;
    }
    setSaveError(null);
    setReasonChoice("recount");
    setReasonNotes("");
    setReasonDialogOpen(true);
  }
  async function confirmSave() {
    if (!profile?.id) {
      setSaveError("Not authenticated");
      return;
    }
    const adjustments = computeAdjustments();
    try {
      const result = await bulkCycleCount.mutateAsync({
        adjustments,
        reason: reasonChoice,
        notes: reasonNotes.trim() || null,
        actorId: profile.id,
      });
      if (!result.ok) {
        if (result.failures.length > 0) {
          setSaveError(
            `${result.failures.length} adjustment(s) rejected (no changes saved): ` +
            result.failures
              .map((f) => {
                const code = f.material_code ?? f.material_id.slice(0, 8);
                if (f.reason === "would_go_negative") {
                  return `${code}: would go negative (current ${f.current ?? 0}, delta ${f.delta ?? 0})`;
                }
                return `${code}: ${f.reason}`;
              })
              .join("; "),
          );
        } else {
          setSaveError(result.error || "Save failed");
        }
        return;
      }
      // Success — close dialog AND exit edit mode AND clear drafts
      setReasonDialogOpen(false);
      exitCycleMode();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Save failed");
    }
  }

  const filtered = useMemo(() => {
    return materials
      .filter((m) => {
        if (categoryFilter !== "all" && m.category !== categoryFilter) return false;
        if (searchQuery) {
          const q = searchQuery.toLowerCase();
          if (!m.code.toLowerCase().includes(q) && !m.name.toLowerCase().includes(q)) {
            return false;
          }
        }
        return true;
      })
      .sort((a, b) => {
        // Category priority first (Filling Materials → Caps → Boxes
        // → Other), then code alphabetical within. Runway-ascending sort
        // will replace the alphabetical secondary once Phase 5 ships.
        const ra = materialCategoryRank(a.category);
        const rb = materialCategoryRank(b.category);
        if (ra !== rb) return ra - rb;
        return a.code.localeCompare(b.code);
      });
  }, [materials, categoryFilter, searchQuery]);

  return (
    <div className="space-y-4 max-w-6xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Materials</h1>
          <p className="text-muted-foreground text-sm">
            Non-sellable inputs: glycerin, caps, boxes, etc.
          </p>
        </div>
        {canEdit && !cycleMode && (
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={enterCycleMode}>
              <ClipboardCheck className="mr-1.5 h-4 w-4" />
              Cycle Count
            </Button>
            <Button onClick={() => setEditingMaterial(null)}>
              <Plus className="mr-1.5 h-4 w-4" />
              Add Material
            </Button>
          </div>
        )}
      </div>

      {/* Low-stock alerts — surfaces any material below its reorder
          point. One row each, clickable to scroll to the material in
          the list. Skipped in cycle-count mode for focus. */}
      {!cycleMode && (() => {
        const lowStock = materials.filter((m) => {
          const onHand = m.inventory?.on_hand_qty ?? 0;
          return m.reorder_point_qty != null && onHand < m.reorder_point_qty;
        });
        if (lowStock.length === 0) return null;
        return (
          <div className="rounded-lg border border-red-500/50 bg-red-500/5 px-4 py-3 space-y-2">
            <div className="flex items-center gap-2 text-sm font-medium text-red-300">
              <AlertTriangle className="h-4 w-4" />
              {lowStock.length} material{lowStock.length === 1 ? "" : "s"} below reorder point
            </div>
            <ul className="text-xs text-red-300/80 space-y-0.5 ml-6">
              {lowStock.map((m) => {
                const onHand = m.inventory?.on_hand_qty ?? 0;
                return (
                  <li key={m.id}>
                    <span className="font-mono">{m.code}</span> — {onHand} {m.unit_of_measure} on hand
                    (reorder at {m.reorder_point_qty})
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })()}

      {/* Unmatched ShipStation box sizes — shipments whose package
          dimensions don't match any catalog box, so no box was decremented.
          Add a box with these dimensions and future shipments auto-match. */}
      {!cycleMode && unmatchedBoxes.length > 0 && (
        <div className="rounded-lg border border-amber-500/50 bg-amber-500/5 px-4 py-3 space-y-2">
          <div className="flex items-center gap-2 text-sm font-medium text-amber-200">
            <AlertTriangle className="h-4 w-4" />
            {unmatchedBoxes.length} ShipStation box size{unmatchedBoxes.length === 1 ? "" : "s"} not in the catalog
          </div>
          <p className="text-xs text-amber-300/70 ml-6">
            These shipments didn't decrement any box. Add a box (L×W×H, in inches) matching a size to start tracking it.
          </p>
          <ul className="text-xs text-amber-300/80 space-y-0.5 ml-6">
            {unmatchedBoxes.map((b) => (
              <li key={b.dims_key}>
                <span className="font-mono">{b.dims_key}</span> in —{" "}
                {b.shipments} shipment{b.shipments === 1 ? "" : "s"}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Cycle Count edit-mode banner — same UX as the SKU cycle count.
          Edit-mode replaces filters with the count-entry workflow; you
          either save (opens reason dialog) or cancel. */}
      {cycleMode && (
        <div className="rounded-lg border border-amber-500/50 bg-amber-500/10 px-4 py-3 flex items-center gap-3">
          <ClipboardCheck className="h-4 w-4 text-amber-400 shrink-0" />
          <div className="flex-1">
            <p className="text-sm font-medium text-amber-100">Cycle Count Mode</p>
            <p className="text-xs text-amber-300/80">
              Enter the actual on-hand quantity for any material you're
              counting. Leave others blank — only changed values get logged.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button variant="outline" size="sm" onClick={exitCycleMode} disabled={bulkCycleCount.isPending}>
              Cancel
            </Button>
            <Button size="sm" onClick={openReasonDialog} disabled={bulkCycleCount.isPending}>
              Save Cycle Count
            </Button>
          </div>
        </div>
      )}

      {/* Filter bar */}
      <div className="flex items-end gap-3 flex-wrap">
        <div className="flex-1 min-w-[220px]">
          <Label className="text-xs text-muted-foreground">Search</Label>
          <Input
            placeholder="Code or name…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="h-9"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">Category</Label>
          <Select value={categoryFilter} onValueChange={setCategoryFilter}>
            <SelectTrigger className="h-9 w-[180px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All categories</SelectItem>
              {MATERIAL_CATEGORIES.map((c) => (
                <SelectItem key={c} value={c}>{c}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="ml-auto text-xs text-muted-foreground pb-1.5 tabular-nums">
          {filtered.length} of {materials.length} materials
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Catalog</CardTitle>
        </CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          {isLoading ? (
            <div className="p-8 text-sm text-muted-foreground text-center">Loading…</div>
          ) : filtered.length === 0 ? (
            <div className="p-8 text-sm text-muted-foreground text-center">
              No materials match the current filters.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                  <th className="px-4 py-2">Code</th>
                  <th className="px-3 py-2">Name</th>
                  <th className="px-3 py-2">Category</th>
                  <th className="px-3 py-2 text-right">On Hand</th>
                  {cycleMode && (
                    <th className="px-3 py-2 text-right bg-amber-500/5">Actual Count</th>
                  )}
                  <th className="px-3 py-2">Unit</th>
                  {!cycleMode && <th className="px-3 py-2 text-right">Unit Cost</th>}
                  {!cycleMode && <th className="px-3 py-2 text-right">$ On Hand</th>}
                  {!cycleMode && <th className="px-3 py-2 text-right">Reorder Pt</th>}
                  {!cycleMode && (
                    <th
                      className="px-3 py-2 text-right"
                      title="Days of stock at the current burn rate (recipe demand, or recent shipments for boxes)"
                    >
                      Days Runway
                    </th>
                  )}
                  {!cycleMode && canEdit && <th className="px-3 py-2 w-10"></th>}
                </tr>
              </thead>
              <tbody>
                {filtered.map((m) => (
                  <MaterialRow
                    key={m.id}
                    material={m}
                    cycleMode={cycleMode}
                    canEdit={canEdit}
                    editValue={editValues[m.id]}
                    runway={runways.get(m.id) ?? null}
                    onCountChange={(v) => setCount(m.id, v)}
                    onEdit={() => setEditingMaterial(m)}
                    onClick={cycleMode ? undefined : () => navigate(`/inventory/materials/${m.id}`)}
                  />
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {/* Material form dialog — handles both add (editingMaterial=null)
          and edit (editingMaterial=Material) flows via a single state. */}
      <MaterialFormDialog
        open={editingMaterial !== undefined}
        material={editingMaterial ?? null}
        onClose={() => setEditingMaterial(undefined)}
      />

      {/* Cycle count reason dialog — preventDefault on the AlertDialogAction
          to keep the dialog open through the async save, so any error from
          the RPC is actually visible (same fix pattern as the SKU cycle
          count from 2026-05-14). */}
      <AlertDialog open={reasonDialogOpen} onOpenChange={(o) => { if (!o) setReasonDialogOpen(false); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Record cycle count reason</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                <p className="text-sm">
                  Pick the closest reason for the adjustment. Notes are
                  optional but recommended for future audits.
                </p>
                {(() => {
                  const adj = computeAdjustments();
                  return (
                    <div className="rounded-md border border-border/60 bg-muted/30 p-2 text-xs">
                      <p className="font-medium mb-1">
                        {adj.length} adjustment{adj.length === 1 ? "" : "s"} will be logged:
                      </p>
                      <ul className="space-y-0.5 max-h-32 overflow-y-auto">
                        {adj.map((a) => {
                          const m = materials.find((x) => x.id === a.materialId);
                          return (
                            <li key={a.materialId} className="tabular-nums">
                              <span className="font-medium">{m?.code ?? a.materialId.slice(0, 8)}</span>
                              {" · "}
                              <span className={a.delta > 0 ? "text-green-400" : "text-red-400"}>
                                {a.delta > 0 ? "+" : ""}{a.delta} {m?.unit_of_measure ?? ""}
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  );
                })()}
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">Reason</label>
                  <Select value={reasonChoice} onValueChange={(v) => setReasonChoice(v as MaterialCycleCountReason)}>
                    <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="recount">Recount</SelectItem>
                      <SelectItem value="spillage">Spillage</SelectItem>
                      <SelectItem value="damage">Damage</SelectItem>
                      <SelectItem value="receiving">Receiving</SelectItem>
                      <SelectItem value="other">Other</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">Notes (optional)</label>
                  <Textarea
                    value={reasonNotes}
                    onChange={(e) => setReasonNotes(e.target.value)}
                    rows={2}
                    placeholder="Any context worth preserving"
                  />
                </div>
                {saveError && (
                  <p className="text-xs text-red-400">{saveError}</p>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setSaveError(null)}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void confirmSave();
              }}
              disabled={bulkCycleCount.isPending}
            >
              {bulkCycleCount.isPending ? "Saving…" : "Record adjustment"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

    </div>
  );
}

function MaterialRow({
  material,
  cycleMode,
  canEdit,
  editValue,
  runway,
  onCountChange,
  onEdit,
  onClick,
}: {
  material: MaterialWithLevel;
  cycleMode: boolean;
  canEdit: boolean;
  editValue: number | undefined;
  runway: MaterialRunwayResult | null;
  onCountChange: (raw: string) => void;
  onEdit: () => void;
  onClick?: () => void;
}) {
  const onHand = material.inventory?.on_hand_qty ?? 0;
  const dollarsOnHand = onHand * material.unit_cost;
  const belowReorder =
    material.reorder_point_qty != null && onHand < material.reorder_point_qty;

  const CategoryIcon =
    material.category === "Filling Materials"
      ? Beaker
      : material.category === "Boxes"
        ? Boxes
        : Package;

  // Delta preview during cycle count — green for increases, red for
  // decreases. Helps the operator catch obvious typos before saving.
  const delta = editValue !== undefined ? editValue - onHand : 0;
  const deltaStr = delta > 0 ? `+${delta}` : delta < 0 ? `${delta}` : "";

  return (
    <tr
      className={`border-b border-border/50 ${onClick ? "hover:bg-muted/40 cursor-pointer" : ""}`}
      onClick={onClick}
    >
      <td className="px-4 py-3 font-mono text-xs">{material.code}</td>
      <td className="px-3 py-3">
        <div className="flex items-center gap-2">
          <CategoryIcon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          {material.name}
        </div>
        {material.dim_length_in != null && (
          <span className="text-[10px] text-muted-foreground">
            {material.dim_length_in}″ × {material.dim_width_in}″ × {material.dim_height_in}″
          </span>
        )}
      </td>
      <td className="px-3 py-3">
        <Badge variant="outline" className="text-[10px]">
          {material.category}
        </Badge>
      </td>
      <td className={`px-3 py-3 text-right tabular-nums font-medium ${belowReorder ? "text-red-400" : ""}`}>
        {onHand.toLocaleString(undefined, { maximumFractionDigits: 2 })}
      </td>
      {cycleMode && (
        <td className="px-3 py-3 text-right bg-amber-500/5">
          <div className="inline-flex items-center gap-2 justify-end">
            <Input
              type="number"
              step="0.01"
              min={0}
              className="h-8 w-28 text-right tabular-nums"
              placeholder="(blank = skip)"
              value={editValue === undefined ? "" : editValue}
              onChange={(e) => onCountChange(e.target.value)}
              onClick={(e) => e.stopPropagation()}
            />
            {deltaStr && (
              <span
                className={`text-xs tabular-nums w-16 text-left ${
                  delta > 0 ? "text-green-400" : "text-red-400"
                }`}
              >
                {deltaStr}
              </span>
            )}
          </div>
        </td>
      )}
      <td className="px-3 py-3 text-xs text-muted-foreground">{material.unit_of_measure}</td>
      {!cycleMode && (
        <td className="px-3 py-3 text-right tabular-nums">
          {material.unit_cost > 0
            ? `$${material.unit_cost.toFixed(2)}`
            : <span className="text-muted-foreground/50">—</span>}
        </td>
      )}
      {!cycleMode && (
        <td className="px-3 py-3 text-right tabular-nums">
          {dollarsOnHand > 0
            ? `$${dollarsOnHand.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
            : <span className="text-muted-foreground/50">—</span>}
        </td>
      )}
      {!cycleMode && (
        <td className="px-3 py-3 text-right tabular-nums">
          {material.reorder_point_qty != null
            ? material.reorder_point_qty.toLocaleString(undefined, { maximumFractionDigits: 2 })
            : <span className="text-muted-foreground/50">—</span>}
        </td>
      )}
      {!cycleMode && (
        <td className="px-3 py-3 text-right tabular-nums">
          {runway && (runway.consumptionSource === "demand_recipe" || runway.consumptionSource === "usage") && runway.currentRunwayDays != null ? (
            <span
              className={
                runway.currentRunwayDays < 14
                  ? "text-red-400"
                  : runway.currentRunwayDays < 30
                    ? "text-yellow-400"
                    : "text-green-400"
              }
              title={
                runway.consumptionSource === "usage"
                  ? `Current: ${runway.currentRunwayDays}d at ${runway.dailyConsumption.toFixed(2)} ${material.unit_of_measure}/day (based on recent shipments)`
                  : `Current: ${runway.currentRunwayDays}d at ${runway.dailyConsumption.toFixed(2)} ${material.unit_of_measure}/day\n` +
                    `If pipeline (${runway.pipelineConsumptionQty.toFixed(0)} ${material.unit_of_measure}) finishes: ${runway.pipelineRunwayDays}d`
              }
            >
              {runway.currentRunwayDays}d
              {runway.consumptionSource === "demand_recipe" && (
                <span className="ml-1 text-[10px] text-muted-foreground">
                  ({runway.pipelineRunwayDays}d w/ pipeline)
                </span>
              )}
            </span>
          ) : (
            <span
              className="text-muted-foreground/50 italic text-xs"
              title={
                runway?.consumptionSource === "no_recipes"
                  ? material.dim_length_in != null
                    ? "Box usage will populate from ShipStation shipments"
                    : "No SKUs reference this material yet — add to a recipe on the SKU detail page"
                  : runway?.consumptionSource === "no_demand"
                    ? "Recipe exists but referenced SKUs have no monthly demand recorded"
                    : "—"
              }
            >
              {runway?.consumptionSource === "no_recipes"
                ? material.dim_length_in != null
                  ? "awaiting usage"
                  : "no recipes"
                : "—"}
            </span>
          )}
        </td>
      )}
      {!cycleMode && canEdit && (
        <td className="px-3 py-3 text-right" onClick={(e) => e.stopPropagation()}>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={onEdit}
            title="Edit material"
          >
            <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
          </Button>
        </td>
      )}
    </tr>
  );
}

const blankForm = {
  code: "",
  name: "",
  category: "Filling Materials" as MaterialCategory | string,
  unit_of_measure: "each",
  unit_cost: "",
  reorder_point_qty: "",
  lead_time_days: "",
  dim_length_in: "",
  dim_width_in: "",
  dim_height_in: "",
  notes: "",
};

/**
 * Material form dialog — single component for both add and edit flows.
 *   - `material = null` → add mode (empty form, INSERT on save)
 *   - `material = Material` → edit mode (prefilled, UPDATE on save)
 *
 * The hook (useUpsertMaterial) handles which DB operation runs based
 * on whether `id` is passed to the mutation.
 */
function MaterialFormDialog({
  open,
  material,
  onClose,
}: {
  open: boolean;
  material: MaterialWithLevel | null;
  onClose: () => void;
}) {
  const upsert = useUpsertMaterial();
  const isEdit = material !== null;
  const [form, setForm] = useState(blankForm);
  const [error, setError] = useState<string | null>(null);

  // Hydrate the form whenever the dialog opens with a (different)
  // material to edit. Empty when adding. We re-check whenever the
  // material id changes to support quickly editing one then another.
  useEffect(() => {
    if (!open) return;
    if (material) {
      setForm({
        code: material.code,
        name: material.name,
        category: material.category,
        unit_of_measure: material.unit_of_measure,
        unit_cost: material.unit_cost > 0 ? String(material.unit_cost) : "",
        reorder_point_qty: material.reorder_point_qty != null ? String(material.reorder_point_qty) : "",
        lead_time_days: material.lead_time_days != null ? String(material.lead_time_days) : "",
        dim_length_in: material.dim_length_in != null ? String(material.dim_length_in) : "",
        dim_width_in: material.dim_width_in != null ? String(material.dim_width_in) : "",
        dim_height_in: material.dim_height_in != null ? String(material.dim_height_in) : "",
        notes: material.notes ?? "",
      });
    } else {
      setForm(blankForm);
    }
    setError(null);
  }, [open, material]);

  function set<K extends keyof typeof blankForm>(key: K, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
    if (error) setError(null);
  }

  function close() {
    onClose();
    setForm(blankForm);
    setError(null);
  }

  async function save() {
    setError(null);
    if (!form.code.trim()) return setError("Code is required");
    if (!form.name.trim()) return setError("Name is required");
    if (!form.unit_of_measure.trim()) return setError("Unit of measure is required");
    const unitCost = form.unit_cost.trim() === "" ? 0 : parseFloat(form.unit_cost);
    if (!Number.isFinite(unitCost) || unitCost < 0) return setError("Unit cost must be ≥ 0");

    // Box-specific dimensions — if any are filled, all three must be.
    const dimL = form.dim_length_in.trim() === "" ? null : parseInt(form.dim_length_in, 10);
    const dimW = form.dim_width_in.trim() === "" ? null : parseInt(form.dim_width_in, 10);
    const dimH = form.dim_height_in.trim() === "" ? null : parseInt(form.dim_height_in, 10);
    const dimAnySet = dimL !== null || dimW !== null || dimH !== null;
    const dimAllSet = dimL !== null && dimW !== null && dimH !== null;
    if (dimAnySet && !dimAllSet) {
      return setError("If you enter one dimension, you must enter all three (L × W × H)");
    }

    try {
      await upsert.mutateAsync({
        // Passing id triggers UPDATE; omitting it triggers INSERT.
        id: material?.id,
        code: form.code.trim(),
        name: form.name.trim(),
        category: form.category,
        unit_of_measure: form.unit_of_measure.trim(),
        unit_cost: unitCost,
        reorder_point_qty: form.reorder_point_qty.trim() === ""
          ? null
          : parseFloat(form.reorder_point_qty),
        lead_time_days: form.lead_time_days.trim() === ""
          ? null
          : parseInt(form.lead_time_days, 10),
        dim_length_in: dimL,
        dim_width_in: dimW,
        dim_height_in: dimH,
        notes: form.notes.trim() === "" ? null : form.notes.trim(),
      });
      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) close(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit Material" : "Add Material"}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? "Update this material's catalog metadata. On-hand qty is changed via the Cycle Count flow, not this dialog."
              : "New consumable input. Dimensions are optional and only used for box-type materials (mapped to ShipStation orders)."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">Code *</Label>
              <Input value={form.code} onChange={(e) => set("code", e.target.value)} placeholder="GLYCERIN, CAP-14MM..." />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Name *</Label>
              <Input value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="Display name" />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">Category *</Label>
              <Select value={form.category} onValueChange={(v) => set("category", v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {MATERIAL_CATEGORIES.map((c) => (
                    <SelectItem key={c} value={c}>{c}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Unit of Measure *</Label>
              <Input value={form.unit_of_measure} onChange={(e) => set("unit_of_measure", e.target.value)} placeholder="each, L, kg, box" />
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">Unit Cost ($)</Label>
              <Input type="number" step="0.01" min={0} value={form.unit_cost} onChange={(e) => set("unit_cost", e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Reorder Point</Label>
              <Input type="number" step="0.01" min={0} value={form.reorder_point_qty} onChange={(e) => set("reorder_point_qty", e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Lead Time (days)</Label>
              <Input type="number" min={0} value={form.lead_time_days} onChange={(e) => set("lead_time_days", e.target.value)} />
            </div>
          </div>

          <div className="space-y-1">
            <Label className="text-xs">Box Dimensions (L × W × H, inches)</Label>
            <div className="grid grid-cols-3 gap-2">
              <Input type="number" min={0} placeholder="L" value={form.dim_length_in} onChange={(e) => set("dim_length_in", e.target.value)} />
              <Input type="number" min={0} placeholder="W" value={form.dim_width_in} onChange={(e) => set("dim_width_in", e.target.value)} />
              <Input type="number" min={0} placeholder="H" value={form.dim_height_in} onChange={(e) => set("dim_height_in", e.target.value)} />
            </div>
            <p className="text-[10px] text-muted-foreground">Leave blank unless this is a packaging box.</p>
          </div>

          {error && (
            <div className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300">
              {error}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={close} disabled={upsert.isPending}>Cancel</Button>
          <Button onClick={save} disabled={upsert.isPending}>
            {upsert.isPending ? "Saving…" : isEdit ? "Save Changes" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
