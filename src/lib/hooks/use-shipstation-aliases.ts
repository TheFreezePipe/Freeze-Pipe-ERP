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
 *   - register   — admin or manager (managers triage day-to-day); un-parks
 *                  the orders carrying the code (next reconcile applies them)
 *   - unregister — admin only (credits the old sku back on linked orders and
 *                  re-opens them)
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

/** Envelope returned by `rpc_shipstation_register_sku_alias`. */
export interface RegisterSkuAliasEnvelope {
  ok: boolean;
  error?: string;
  /** Stored spelling of the code (normalised to the pending items' case). */
  sku_code?: string;
  /** Previously-blocked order items that just resolved through this alias. */
  existing_items_updated?: number;
  /**
   * Unapplied shipped / awaiting_shipment orders carrying the code. The
   * next reconcile run (every 30 minutes) applies them — migration
   * 20260921000001.
   */
  orders_requeued?: number;
}

/** Envelope returned by `rpc_shipstation_unregister_sku_alias`. */
export interface UnregisterSkuAliasEnvelope {
  ok: boolean;
  error?: string;
  sku_code?: string;
  /** Order items reset to sku_id NULL (re-blocked). */
  items_reset?: number;
  /** Applied orders re-opened so the next reconcile re-applies them. */
  orders_reopened?: number;
  /** Orders whose old-sku deduction was credited back by the RPC. */
  orders_credited?: number;
  /** Units credited back to the old sku across those orders. */
  units_credited?: number;
}

/**
 * Register a ShipStation sku_code as an alias for an existing product SKU.
 * Wraps `rpc_shipstation_register_sku_alias` (admin or manager).
 *
 * Returns the RPC's JSON envelope so callers can surface
 * `existing_items_updated` (count of previously-blocked order items that
 * just resolved) and `orders_requeued` (orders the next reconcile run will
 * apply) — useful confirmation when registering a code that has orders
 * already piled up in the queue.
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
      const env = data as RegisterSkuAliasEnvelope | null;
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
 * (admin only). Side effects (migration 20260921000001):
 *   - any shipstation_order_items that resolved through this alias are
 *     reset back to sku_id = NULL (re-blocked)
 *   - for every affected order, units the ledger deducted for the old sku
 *     beyond what its lines still resolve to are credited back right away
 *     (positive order_shipped row, stock restored)
 *   - applied orders are re-opened (`inventory_applied_at = NULL`,
 *     `inventory_apply_error` set) so the next reconcile deducts whatever
 *     the code resolves to next
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
      const env = data as UnregisterSkuAliasEnvelope | null;
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
