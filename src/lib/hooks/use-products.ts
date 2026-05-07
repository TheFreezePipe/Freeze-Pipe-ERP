import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { supabaseUpdateWithVersion } from "@/lib/concurrency";
import type { ProductSKU } from "@/types/database";

export function useProducts() {
  return useQuery({
    queryKey: ["products"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("product_skus")
        .select("*")
        .order("display_category")
        .order("product_name");
      if (error) throw error;
      return data as ProductSKU[];
    },
    staleTime: 5 * 60 * 1000,
  });
}

export function useProduct(id: string) {
  return useQuery({
    queryKey: ["products", id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("product_skus")
        .select("*")
        .eq("id", id)
        .single();
      if (error) throw error;
      return data as ProductSKU;
    },
    enabled: !!id,
  });
}

/**
 * Insert a new product_skus row. RLS policy "Admins can manage SKUs" gates
 * to admin/manager via auth.uid() against profiles, so the client-side call
 * fails for non-elevated users with a postgrest 42501 (insufficient_privilege).
 *
 * Returns the inserted row so callers can navigate to its id without an
 * extra fetch. Wraps the postgrest error so the unique-key violation on
 * (sku) surfaces as a friendly "already exists" message rather than the
 * raw "duplicate key value violates unique constraint" string.
 */
export function useCreateProduct() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (params: {
      sku: string;
      product_name: string;
      category: "fillable" | "non_fillable";
      display_category: string;
      retail_price?: number | null;
      standard_quantity_per_carton?: number | null;
      upc_code?: string | null;
      abc_classification?: string | null;
      monthly_demand?: number | null;
    }) => {
      const { data, error } = await supabase
        .from("product_skus")
        .insert({
          sku: params.sku,
          product_name: params.product_name,
          category: params.category,
          display_category: params.display_category,
          retail_price: params.retail_price ?? null,
          standard_quantity_per_carton: params.standard_quantity_per_carton ?? null,
          upc_code: params.upc_code ?? null,
          abc_classification: params.abc_classification ?? null,
          monthly_demand: params.monthly_demand ?? null,
          is_active: true,
        })
        .select()
        .single();
      if (error) {
        // Friendly hint for the unique-key violation on product_skus.sku.
        const msg = error.message ?? "";
        if (/duplicate key|product_skus_sku_key|unique/i.test(msg)) {
          throw new Error(`Another product already uses code "${params.sku}"`);
        }
        wrapPostgrestError(error, "Create failed");
      }
      return data as ProductSKU;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["products"] });
    },
  });
}

export function useUpdateProduct() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (params: {
      id: string;
      updates: Partial<ProductSKU>;
      /** If provided, the update is guarded by optimistic concurrency —
       *  throws ConcurrencyConflictError if the row has been modified. */
      expectedVersion?: number;
    }) => {
      return supabaseUpdateWithVersion(
        supabase,
        "product_skus",
        params.id,
        params.expectedVersion ?? null,
        params.updates as Record<string, unknown>,
      );
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["products"] });
      // Product fields that update here can change downstream cost math:
      //   - `category` flips fillable ↔ non_fillable, which changes the
      //     manufacturing-cost branch in computeListD2C and the dashboard
      //     cash-at-stage calc. Cached economics rollups go stale.
      //   - `retail_price` is the basis for the default CC fee (3% of
      //     retail) and for the margin/contribution columns rendered in
      //     SKUList. Same staleness without an invalidation.
      // Prefix invalidation hits both per-id and "all" economics keys.
      qc.invalidateQueries({ queryKey: ["sku-economics"] });
      qc.invalidateQueries({ queryKey: ["sku-supplier-costs"] });
    },
  });
}

// ---------------------------------------------------------------------------
// Archive / restore — uses the SECURITY DEFINER RPCs from migration 008
// (archive_sku, archive_sku_force, restore_sku) instead of flipping
// `is_active` directly. The RPCs write the canonical archive columns
// (archived_at, archived_by, archive_reason) AND emit an inventory_transactions
// audit row. Bypassing them — as the old modal code did — left archived_at
// NULL, so the dashboard's `archived_at IS NOT NULL` filter ignored the
// archive on the next remount and the SKU appeared un-archived.
//
// These RPCs return VOID and signal failure via RAISE EXCEPTION (not a JSONB
// envelope), so we wrap PostgrestError into a proper Error here so callers
// using `err instanceof Error ? err.message : ...` see the real reason.
// ---------------------------------------------------------------------------

function wrapPostgrestError(
  error: { message?: string; code?: string; details?: string; hint?: string } | null,
  fallback: string,
): never {
  if (!error) throw new Error(fallback);
  const parts = [error.message, error.code, error.details, error.hint]
    .filter((p) => p && String(p).trim().length > 0);
  throw new Error(parts.join(" · ") || fallback);
}

/**
 * Standard archive — refuses if the SKU still has any on-hand warehouse
 * stock. The modal does the same check client-side first to render the
 * friendlier "force?" dialog, but the RPC enforces it server-side as a
 * safety net (e.g. against stale client state).
 */
export function useArchiveSKU() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (params: { skuId: string; actorId: string; reason: string }) => {
      const { error } = await supabase.rpc("archive_sku", {
        p_sku_id: params.skuId,
        p_actor_id: params.actorId,
        p_reason: params.reason,
      });
      if (error) wrapPostgrestError(error, "Archive failed");
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["products"] });
      qc.invalidateQueries({ queryKey: ["inventory"] });
      qc.invalidateQueries({ queryKey: ["inventory-transactions"] });
    },
  });
}

/**
 * Force-archive — bypasses the on-hand stock check. Use when the operator
 * has confirmed in the UI that they want to archive despite live inventory
 * (e.g. discontinued line being written off).
 */
export function useArchiveSKUForce() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (params: { skuId: string; actorId: string; reason: string }) => {
      const { error } = await supabase.rpc("archive_sku_force", {
        p_sku_id: params.skuId,
        p_actor_id: params.actorId,
        p_reason: params.reason,
      });
      if (error) wrapPostgrestError(error, "Force archive failed");
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["products"] });
      qc.invalidateQueries({ queryKey: ["inventory"] });
      qc.invalidateQueries({ queryKey: ["inventory-transactions"] });
    },
  });
}

/** Restore an archived SKU — clears archived_at/archived_by/reason and re-actives. */
export function useRestoreSKU() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (params: { skuId: string; actorId: string }) => {
      const { error } = await supabase.rpc("restore_sku", {
        p_sku_id: params.skuId,
        p_actor_id: params.actorId,
      });
      if (error) wrapPostgrestError(error, "Restore failed");
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["products"] });
      qc.invalidateQueries({ queryKey: ["inventory"] });
      qc.invalidateQueries({ queryKey: ["inventory-transactions"] });
    },
  });
}
