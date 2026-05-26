import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
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
import { Plus, Beaker, Package, Boxes } from "lucide-react";
import {
  useMaterials,
  useUpsertMaterial,
  type MaterialWithLevel,
} from "@/lib/hooks";
import {
  MATERIAL_CATEGORIES,
  materialCategoryRank,
  type MaterialCategory,
} from "@/lib/constants";
import { useShouldShowMaterialsFeature } from "@/lib/feature-flags";
import { useAuth } from "@/lib/auth-context";

/**
 * Materials catalog tab — non-sellable consumables tracking.
 *
 * Feature-flagged to Chase only during development (see
 * useShouldShowMaterialsFeature). When the team is ready, delete the
 * flag check and the tab + page become visible to all admin/manager.
 *
 * Phase 2 scope: list view + add/edit. Runway days are placeholder
 * "—" until recipes (Phase 4) and pipeline math (Phase 5) land.
 */
export default function MaterialsList() {
  const navigate = useNavigate();
  const showFlag = useShouldShowMaterialsFeature();
  const { isAdmin, isManager } = useAuth();
  const canEdit = isAdmin || isManager;

  const { data: materials = [], isLoading } = useMaterials();

  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [dialogOpen, setDialogOpen] = useState(false);

  // Defense-in-depth: if a non-Chase user hits this URL directly,
  // bounce them away. The nav also hides the tab for them but a
  // direct link would otherwise leak the page.
  if (!showFlag) {
    return (
      <div className="p-8 text-sm text-muted-foreground">
        This feature isn't available yet.
      </div>
    );
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
        // Category priority first (Filling Materials → Caps → Packaging
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
        {canEdit && (
          <Button onClick={() => setDialogOpen(true)}>
            <Plus className="mr-1.5 h-4 w-4" />
            Add Material
          </Button>
        )}
      </div>

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
                  <th className="px-3 py-2">Unit</th>
                  <th className="px-3 py-2 text-right">Unit Cost</th>
                  <th className="px-3 py-2 text-right">$ On Hand</th>
                  <th className="px-3 py-2 text-right">Reorder Pt</th>
                  <th
                    className="px-3 py-2 text-right text-muted-foreground/40"
                    title="Awaiting recipe + pipeline data (Phase 5)"
                  >
                    Days Runway
                  </th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((m) => (
                  <MaterialRow key={m.id} material={m} onClick={() => navigate(`/inventory/materials/${m.id}`)} />
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {/* Add Material dialog */}
      <AddMaterialDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
      />

      <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-300/80">
        <span className="font-medium">In-progress feature:</span> this tab is visible only to admin user during development. Cycle counts, recipes, and runway forecasting are landing in subsequent phases.
      </div>
    </div>
  );
}

function MaterialRow({
  material,
  onClick,
}: {
  material: MaterialWithLevel;
  onClick: () => void;
}) {
  const onHand = material.inventory?.on_hand_qty ?? 0;
  const dollarsOnHand = onHand * material.unit_cost;
  const belowReorder =
    material.reorder_point_qty != null && onHand < material.reorder_point_qty;

  const CategoryIcon =
    material.category === "Filling Materials"
      ? Beaker
      : material.category === "Packaging"
        ? Boxes
        : Package;

  return (
    <tr
      className="border-b border-border/50 hover:bg-muted/40 cursor-pointer"
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
      <td className="px-3 py-3 text-xs text-muted-foreground">{material.unit_of_measure}</td>
      <td className="px-3 py-3 text-right tabular-nums">
        {material.unit_cost > 0
          ? `$${material.unit_cost.toFixed(2)}`
          : <span className="text-muted-foreground/50">—</span>}
      </td>
      <td className="px-3 py-3 text-right tabular-nums">
        {dollarsOnHand > 0
          ? `$${dollarsOnHand.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
          : <span className="text-muted-foreground/50">—</span>}
      </td>
      <td className="px-3 py-3 text-right tabular-nums">
        {material.reorder_point_qty != null
          ? material.reorder_point_qty.toLocaleString(undefined, { maximumFractionDigits: 2 })
          : <span className="text-muted-foreground/50">—</span>}
      </td>
      <td
        className="px-3 py-3 text-right tabular-nums text-muted-foreground/40 italic"
        title="Awaiting recipe + pipeline data (Phase 5)"
      >
        —
      </td>
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

function AddMaterialDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const upsert = useUpsertMaterial();
  const [form, setForm] = useState(blankForm);
  const [error, setError] = useState<string | null>(null);

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
          <DialogTitle>Add Material</DialogTitle>
          <DialogDescription>
            New consumable input. Dimensions are optional and only used for box-type materials (mapped to ShipStation orders).
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
            {upsert.isPending ? "Saving…" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
