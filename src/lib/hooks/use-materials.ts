import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase as typedSupabase } from "@/lib/supabase";

// Stale generated types: the materials tables were added in
// 20260526000001 but `database.types.ts` hasn't been regenerated yet.
// Cast through `unknown` so .from("materials") etc. compile. The next
// `supabase gen types typescript` run will let us drop this and use
// the strongly-typed client directly.
// deno-lint-ignore no-explicit-any
const supabase = typedSupabase as unknown as any;

/**
 * Materials = non-sellable consumable inputs (glycerin, caps, boxes).
 *
 * Tables introduced in 20260526000001_materials_consumables_tracking.sql:
 *   - materials                  (catalog)
 *   - material_inventory_levels  (current on-hand per material)
 *   - material_transactions      (append-only audit log)
 *   - sku_material_consumption   (recipe: how much of each material per SKU)
 *
 * Generated types haven't caught up yet; we cast loosely. When the next
 * `supabase gen types` run lands, the inline shapes below can shrink to
 * `Database["public"]["Tables"]["materials"]["Row"]` etc.
 */

export interface Material {
  id: string;
  code: string;
  name: string;
  category: string;
  unit_of_measure: string;
  unit_cost: number;
  reorder_point_qty: number | null;
  lead_time_days: number | null;
  supplier_id: string | null;
  dim_length_in: number | null;
  dim_width_in: number | null;
  dim_height_in: number | null;
  notes: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  row_version: number;
}

export interface MaterialInventoryLevel {
  id: string;
  material_id: string;
  on_hand_qty: number;
  last_counted_at: string | null;
  last_counted_by: string | null;
  updated_at: string;
}

export type MaterialWithLevel = Material & {
  inventory: MaterialInventoryLevel | null;
};

/**
 * All materials + their current on-hand level joined in one shot. Used by
 * the Materials catalog tab. Filtered to active rows by default; pass
 * { includeArchived: true } to surface archived materials for cleanup work.
 */
export function useMaterials(opts: { includeArchived?: boolean } = {}) {
  return useQuery({
    queryKey: ["materials", { includeArchived: !!opts.includeArchived }],
    queryFn: async (): Promise<MaterialWithLevel[]> => {
      let query = supabase
        .from("materials")
        .select("*, inventory:material_inventory_levels(*)")
        .order("code", { ascending: true });
      if (!opts.includeArchived) query = query.eq("is_active", true);
      const { data, error } = await query;
      if (error) throw error;
      // PostgREST returns the joined 1:1 child as an array; flatten so
      // callers can read `material.inventory?.on_hand_qty` directly.
      type Joined = Material & { inventory: MaterialInventoryLevel[] | MaterialInventoryLevel | null };
      const rows = (data ?? []) as unknown as Joined[];
      return rows.map((r) => ({
        ...r,
        inventory: Array.isArray(r.inventory) ? (r.inventory[0] ?? null) : r.inventory,
      }));
    },
    staleTime: 60_000,
  });
}

/**
 * Single material + its current on-hand level, by id. Powers the Material
 * detail page. Returns null when the id doesn't resolve (deleted/bad URL).
 */
export function useMaterial(id: string | null | undefined) {
  return useQuery({
    queryKey: ["material", id],
    enabled: !!id,
    queryFn: async (): Promise<MaterialWithLevel | null> => {
      const { data, error } = await supabase
        .from("materials")
        .select("*, inventory:material_inventory_levels(*)")
        .eq("id", id!)
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      type Joined = Material & {
        inventory: MaterialInventoryLevel[] | MaterialInventoryLevel | null;
      };
      const r = data as unknown as Joined;
      return {
        ...r,
        inventory: Array.isArray(r.inventory) ? (r.inventory[0] ?? null) : r.inventory,
      };
    },
    staleTime: 60_000,
  });
}

export interface MaterialTransaction {
  id: string;
  material_id: string;
  transaction_type: string;
  quantity_change: number;
  reference_type: string | null;
  reference_id: string | null;
  notes: string | null;
  performed_by: string | null;
  created_at: string;
}

/**
 * Append-only audit history for one material (cycle counts, receipts, and —
 * once auto-deduction lands — manufacturing consumption). Newest first.
 * Actor names are resolved by the caller via useProfiles to avoid relying on
 * a PostgREST FK embed.
 */
export function useMaterialTransactions(
  materialId: string | null | undefined,
  limit = 50,
) {
  return useQuery({
    queryKey: ["material-transactions", materialId, limit],
    enabled: !!materialId,
    queryFn: async (): Promise<MaterialTransaction[]> => {
      const { data, error } = await supabase
        .from("material_transactions")
        .select("*")
        .eq("material_id", materialId!)
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) throw error;
      return (data ?? []) as unknown as MaterialTransaction[];
    },
    staleTime: 60_000,
  });
}

/**
 * Upsert a material catalog row. INSERT when params.id is undefined,
 * UPDATE when present. Either path writes an inventory_levels row on
 * create so the joined query always returns a paired result.
 *
 * RLS gates writes to admin/manager (server-side). UI should also gate
 * the edit affordances to those roles to avoid a 403 round-trip.
 */
export function useUpsertMaterial() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (params: {
      id?: string;
      code: string;
      name: string;
      category: string;
      unit_of_measure: string;
      unit_cost: number;
      reorder_point_qty: number | null;
      lead_time_days: number | null;
      dim_length_in: number | null;
      dim_width_in: number | null;
      dim_height_in: number | null;
      notes: string | null;
    }): Promise<Material> => {
      const payload = {
        code: params.code,
        name: params.name,
        category: params.category,
        unit_of_measure: params.unit_of_measure,
        unit_cost: params.unit_cost,
        reorder_point_qty: params.reorder_point_qty,
        lead_time_days: params.lead_time_days,
        dim_length_in: params.dim_length_in,
        dim_width_in: params.dim_width_in,
        dim_height_in: params.dim_height_in,
        notes: params.notes,
      };

      if (params.id) {
        const { data, error } = await supabase
          .from("materials")
          .update(payload)
          .eq("id", params.id)
          .select()
          .single();
        if (error) throw new Error(error.message);
        return data as unknown as Material;
      }

      // INSERT path — create the catalog row and a paired inventory_levels
      // row in two statements (no transaction needed; the inventory row
      // is just a zero-balance placeholder that the cycle-count flow
      // will populate when the operator runs their first count).
      const { data: created, error: createErr } = await supabase
        .from("materials")
        .insert(payload)
        .select()
        .single();
      if (createErr) {
        const msg = createErr.message ?? "";
        if (/duplicate key|materials_code_key|unique/i.test(msg)) {
          throw new Error(`A material with code "${params.code}" already exists`);
        }
        throw new Error(msg || "Create failed");
      }
      const newRow = created as unknown as Material;

      // Pair the inventory row. Failure here is recoverable (operator can
      // cycle-count to create it), but we surface the warning so the UI
      // can flag.
      const { error: invErr } = await supabase
        .from("material_inventory_levels")
        .insert({ material_id: newRow.id, on_hand_qty: 0 });
      if (invErr) {
        console.warn("Material created but inventory row failed:", invErr.message);
      }
      return newRow;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["materials"] });
    },
  });
}

/**
 * Bulk cycle count for materials. Mirrors useBulkCycleCount on the SKU
 * side: all-or-nothing validation, single-transaction apply, append-only
 * audit row per change, no inventory-shift side effects beyond updating
 * material_inventory_levels.
 *
 * Adjustments are SIGNED deltas (new_count - current_count). Only emit
 * one per material the operator actually touched — never zero-fill the
 * unedited rows. This is the same bug class as the SKU cycle-count fix
 * from 2026-05-14.
 */
export type MaterialCycleCountReason =
  | "spillage"
  | "damage"
  | "receiving"
  | "recount"
  | "other";

export type MaterialCycleCountResult =
  | {
      ok: true;
      applied: number;
      adjustments: Array<{ material_id: string; delta: number; new_value: number }>;
    }
  | {
      ok: false;
      error: string;
      failures: Array<{
        material_id: string;
        material_code?: string;
        reason: string;
        delta?: number;
        current?: number;
      }>;
    };

/**
 * Recipe entry: how much of each material does one finished unit of a
 * given SKU consume? Used by the SKU detail page (admin/manager only)
 * to define and edit per-SKU material requirements. The Materials list
 * page reads these in aggregate to compute pipeline_consumption for
 * the runway forecast (Phase 5).
 */
export interface SkuMaterialConsumption {
  id: string;
  sku_id: string;
  material_id: string;
  quantity_per_unit: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export type SkuMaterialConsumptionRow = SkuMaterialConsumption & {
  material: Pick<Material, "id" | "code" | "name" | "category" | "unit_of_measure"> | null;
};

export function useSkuMaterialConsumption(skuId: string | null | undefined) {
  return useQuery({
    queryKey: ["sku-material-consumption", skuId],
    enabled: !!skuId,
    queryFn: async (): Promise<SkuMaterialConsumptionRow[]> => {
      const { data, error } = await supabase
        .from("sku_material_consumption")
        .select("*, material:materials(id, code, name, category, unit_of_measure)")
        .eq("sku_id", skuId!)
        .order("created_at", { ascending: true });
      if (error) throw error;
      return (data ?? []) as unknown as SkuMaterialConsumptionRow[];
    },
    staleTime: 60_000,
  });
}

/**
 * Upsert a (sku_id, material_id) recipe row. Unique constraint on the
 * pair means there's only ever one row per combination — onConflict
 * lets the same form action handle "add new" and "edit existing"
 * without the caller needing to know which it is.
 */
export function useUpsertSkuMaterialConsumption() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (params: {
      skuId: string;
      materialId: string;
      quantityPerUnit: number;
      notes?: string | null;
    }) => {
      const { error } = await supabase
        .from("sku_material_consumption")
        .upsert(
          {
            sku_id: params.skuId,
            material_id: params.materialId,
            quantity_per_unit: params.quantityPerUnit,
            notes: params.notes ?? null,
          },
          { onConflict: "sku_id,material_id" },
        );
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sku-material-consumption"] });
    },
  });
}

/**
 * All recipes across the catalog, flat. Used by the runway calculation
 * which needs to walk every SKU's recipe to estimate daily consumption
 * + pipeline consumption per material. Returns the minimal shape needed
 * for that math; if you want display-ready joined data per SKU use
 * useSkuMaterialConsumption(skuId) instead.
 */
export function useAllRecipes() {
  return useQuery({
    queryKey: ["sku-material-consumption", "all"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("sku_material_consumption")
        .select("sku_id, material_id, quantity_per_unit");
      if (error) throw error;
      return (data ?? []) as unknown as Array<{
        sku_id: string;
        material_id: string;
        quantity_per_unit: number;
      }>;
    },
    staleTime: 60_000,
  });
}

export function useDeleteSkuMaterialConsumption() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (params: { id: string }) => {
      const { error } = await supabase
        .from("sku_material_consumption")
        .delete()
        .eq("id", params.id);
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sku-material-consumption"] });
    },
  });
}

export function useBulkMaterialCycleCount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (params: {
      adjustments: Array<{ materialId: string; delta: number }>;
      reason: MaterialCycleCountReason;
      notes?: string | null;
      actorId: string;
    }): Promise<MaterialCycleCountResult> => {
      const payload = params.adjustments
        .filter((a) => a.delta !== 0)
        .map((a) => ({ material_id: a.materialId, delta: a.delta }));
      const { data, error } = await supabase.rpc("rpc_bulk_material_cycle_count", {
        p_adjustments: payload,
        p_reason: params.reason,
        p_notes: params.notes ?? "",
        p_actor_id: params.actorId,
      });
      if (error) {
        return {
          ok: false,
          error: error.message,
          failures: [],
        };
      }
      return data as MaterialCycleCountResult;
    },
    onSuccess: (result) => {
      if (result.ok) {
        qc.invalidateQueries({ queryKey: ["materials"] });
        // Future: invalidate material_transactions queries when those exist.
      }
    },
  });
}
