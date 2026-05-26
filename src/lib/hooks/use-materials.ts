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
