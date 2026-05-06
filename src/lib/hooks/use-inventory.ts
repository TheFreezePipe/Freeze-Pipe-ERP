import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import type { InventoryLevel, ProductSKU } from "@/types/database";

export type InventoryWithProduct = InventoryLevel & { product: ProductSKU };

export type CycleCountField =
  | "warehouse_raw"
  | "warehouse_prefilled_raw"
  | "warehouse_in_production"
  | "warehouse_finished"
  | "warehouse_other";

export type CycleCountReason = "breakage" | "mispick" | "theft" | "receiving_error" | "other";

export function useInventory() {
  return useQuery({
    queryKey: ["inventory"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("inventory_levels")
        .select("*, product:product_skus(*)")
        .order("sku_id");
      if (error) throw error;
      return data as InventoryWithProduct[];
    },
    staleTime: 2 * 60 * 1000,
  });
}

export function useInventoryBySku(skuId: string) {
  return useQuery({
    queryKey: ["inventory", skuId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("inventory_levels")
        .select("*, product:product_skus(*)")
        .eq("sku_id", skuId)
        .single();
      if (error) throw error;
      return data as InventoryWithProduct;
    },
    enabled: !!skuId,
  });
}

/**
 * Apply a cycle count adjustment via the atomic RPC.
 *
 * Use this for ALL manual inventory edits. Never bare-update the
 * inventory_levels table from the app — the RPC wraps the mutation +
 * audit entry in a single transaction with invariant enforcement.
 */
export function useCycleCount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (params: {
      skuId: string;
      field: CycleCountField;
      delta: number;
      reason: CycleCountReason;
      notes?: string | null;
      actorId: string;
    }) => {
      const { data, error } = await supabase.rpc("rpc_cycle_count", {
        p_sku_id: params.skuId,
        p_field: params.field,
        p_delta: params.delta,
        p_reason: params.reason,
        p_notes: params.notes ?? null,
        p_actor_id: params.actorId,
      } as never);
      if (error) throw error;
      // RPC returns JSONB — pass through the server's result
      const result = data as { ok: boolean; error?: string; new_value?: number; current?: number; delta?: number };
      if (!result.ok) {
        throw new Error(result.error ?? "Cycle count failed");
      }
      return result;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["inventory"] });
      qc.invalidateQueries({ queryKey: ["inventory-transactions"] });
    },
  });
}

/**
 * Result envelope from `useBulkCycleCount`. On success, every requested
 * adjustment landed atomically. On failure, NO writes occurred — the
 * server validated all adjustments up-front and rejected the whole
 * batch if any were invalid. UI surfaces `failures[]` so the operator
 * sees exactly which rows to fix.
 */
export type BulkCycleCountResult =
  | {
      ok: true;
      applied: number;
      adjustments: Array<{
        sku_id: string;
        field: CycleCountField;
        delta: number;
        new_value: number;
      }>;
    }
  | {
      ok: false;
      error: string;
      failures: Array<{
        sku_id: string;
        field: string;
        reason: string;
        delta?: number;
        current?: number;
      }>;
    };

/**
 * Apply multiple cycle count adjustments atomically via the
 * `rpc_bulk_cycle_count` RPC (migration 050). The server validates the
 * whole batch first, then applies + audits in a single transaction, so
 * partial-failure split-state is impossible. Replaces the prior
 * per-row loop that committed each adjustment independently and could
 * leave inventory half-edited when one row failed.
 */
export function useBulkCycleCount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (params: {
      adjustments: Array<{
        skuId: string;
        field: CycleCountField;
        delta: number;
      }>;
      reason: CycleCountReason;
      notes?: string | null;
      actorId: string;
    }): Promise<BulkCycleCountResult> => {
      // Translate camelCase → snake_case for the JSONB payload the RPC expects.
      const payload = params.adjustments
        .filter((a) => a.delta !== 0)
        .map((a) => ({ sku_id: a.skuId, field: a.field, delta: a.delta }));

      const { data, error } = await supabase.rpc("rpc_bulk_cycle_count", {
        p_adjustments: payload,
        p_reason: params.reason,
        p_notes: params.notes ?? "",
        p_actor_id: params.actorId,
      });
      if (error) {
        // Network / RLS / transaction-level error. Return as a structured
        // failure so the dashboard's existing UI can render it.
        return {
          ok: false,
          error: error.message,
          failures: [],
        };
      }
      return data as BulkCycleCountResult;
    },
    onSuccess: (result) => {
      // Only refresh caches when something actually committed. A
      // validation-failed envelope means the DB state is unchanged —
      // invalidating would force a needless refetch.
      if (result.ok) {
        qc.invalidateQueries({ queryKey: ["inventory"] });
        qc.invalidateQueries({ queryKey: ["inventory-transactions"] });
      }
    },
  });
}
