import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import type { Database } from "@/lib/database.types";

/**
 * ShipStation SKU aliases — self-service management on the SKU detail page.
 *
 * `shipstation_sku_handling` is the triage table built in migration
 * 20260505000001. The original UI for it lived only on the unresolved-queue
 * page (operator triages a brand-new SKU code). Migration 20260507000001
 * opens up read-by-sku for admin/manager and adds an unregister RPC so the
 * SKU detail page can list and edit a product's aliases inline — same affordance
 * pattern as the per-supplier costs section right above it.
 *
 * Reads use the row-level SELECT policy added in migration 20260507000001
 * (admin/manager only). Mutations go through SECURITY DEFINER RPCs:
 *   - register   — admin or manager (managers triage day-to-day)
 *   - unregister — admin only (un-applies inventory deductions on linked orders)
 */

export type ShipstationSkuHandlingRow =
  Database["public"]["Tables"]["shipstation_sku_handling"]["Row"];

/**
 * All alias rows that resolve to a given SKU. Returns ShipStation sku_codes
 * (text) plus the row metadata so the detail page can show "added by",
 * "added at", and notes inline.
 */
export function useSkuAliases(skuId: string | null | undefined) {
  return useQuery({
    queryKey: ["shipstation-sku-handling", "by-sku", skuId],
    enabled: !!skuId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("shipstation_sku_handling")
        .select("*")
        .eq("resolved_sku_id", skuId!)
        .eq("is_non_inventory", false)
        .order("added_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as ShipstationSkuHandlingRow[];
    },
    staleTime: 60_000,
  });
}

/**
 * Register a ShipStation sku_code as an alias for an existing product SKU.
 * Wraps `rpc_shipstation_register_sku_alias` (admin or manager).
 *
 * Returns the RPC's JSON envelope so callers can surface
 * `existing_items_updated` (count of previously-blocked order items that
 * just resolved) — useful confirmation when registering a code that has
 * orders already piled up in the queue.
 */
export function useRegisterSkuAlias() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (params: {
      skuCode: string;
      resolvedSkuId: string;
      notes?: string | null;
    }) => {
      const { data, error } = await supabase.rpc(
        "rpc_shipstation_register_sku_alias",
        {
          p_sku_code: params.skuCode,
          p_resolved_sku_id: params.resolvedSkuId,
          p_notes: params.notes ?? undefined,
        },
      );
      if (error) throw error;
      const env = data as {
        ok: boolean;
        error?: string;
        existing_items_updated?: number;
      } | null;
      if (!env?.ok) {
        throw new Error(env?.error ?? "Failed to register alias");
      }
      return env;
    },
    onSuccess: () => {
      // The new alias may have re-resolved a stack of orders. Invalidate
      // the alias list, the unresolved-queue, and the orders list so all
      // three views catch up at once.
      qc.invalidateQueries({ queryKey: ["shipstation-sku-handling"] });
      qc.invalidateQueries({ queryKey: ["shipstation-unresolved-skus"] });
      qc.invalidateQueries({ queryKey: ["shipstation-orders"] });
    },
  });
}

/**
 * Remove an alias entry. Wraps `rpc_shipstation_unregister_sku_alias`
 * (admin only). Side effects:
 *   - any shipstation_order_items that resolved through this alias are
 *     reset back to sku_id = NULL (re-blocked)
 *   - any orders that had only this alias resolving them are flagged
 *     `inventory_apply_error` and `inventory_applied_at = NULL`
 *
 * The detail page should warn the user about these side effects before
 * calling — there's a confirm dialog wired up in SKUDetail.
 */
export function useUnregisterSkuAlias() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (params: { skuCode: string }) => {
      // Stale generated-types: the new RPC isn't in database.types.ts yet,
      // so we cast through `unknown` to satisfy the typed `.rpc()` overload.
      // Same pattern used elsewhere (e.g. supplier-portal hooks during
      // initial wiring) when a migration ships ahead of the type regen.
      const { data, error } = await (
        supabase.rpc as unknown as (
          fn: string,
          args: Record<string, unknown>,
        ) => Promise<{ data: unknown; error: { message: string } | null }>
      )("rpc_shipstation_unregister_sku_alias", { p_sku_code: params.skuCode });
      if (error) throw new Error(error.message);
      const env = data as {
        ok: boolean;
        error?: string;
        items_reset?: number;
      } | null;
      if (!env?.ok) {
        throw new Error(env?.error ?? "Failed to unregister alias");
      }
      return env;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["shipstation-sku-handling"] });
      qc.invalidateQueries({ queryKey: ["shipstation-unresolved-skus"] });
      qc.invalidateQueries({ queryKey: ["shipstation-orders"] });
    },
  });
}
