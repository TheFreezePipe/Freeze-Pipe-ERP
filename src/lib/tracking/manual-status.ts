/**
 * Freight status manual override — Supabase-backed hooks.
 *
 * A "manual override" means a human has explicitly set the shipment status,
 * overriding whatever carrier tracking would otherwise compute. The
 * `status_overridden_at` timestamp flags the override; the tracking
 * reconciler skips status updates while this is set (still updates ETA).
 *
 * Three cases handled here:
 *   1. Override to a non-delivered status → rpc_apply_freight_status_override
 *      (migration 044). Row-version-gated, writes a single audit_logs entry
 *      under action='freight.status_override'.
 *   2. Override to "delivered" → rpc_apply_freight_delivery (migration 010 /
 *      modernized in 039). Atomically increments warehouse_raw per line item,
 *      flips status, stamps actual_arrival_date, writes inventory_transactions
 *      audit rows (these ARE inventory events, not workflow events).
 *   3. Clear override → rpc_clear_freight_status_override (migration 044).
 *      Row-version-gated, writes audit_logs action='freight.status_override_cleared'.
 *
 * The override + clear paths now flow through audit_logs (workflow audit),
 * matching migration 026's split. Pre-044 they wrote one row per SKU into
 * inventory_transactions, which inflated the inventory audit and put
 * non-inventory events in the wrong table.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import type { FreightShipment } from "@/types/database";

/** Wraps a PostgrestError (plain object) into a proper Error so callers
 * using `err instanceof Error ? err.message : ...` see the real message. */
function wrapPostgrestError(
  error: { message?: string; code?: string; details?: string; hint?: string } | null,
  fallback: string,
): never {
  if (!error) throw new Error(fallback);
  const parts = [error.message, error.code, error.details, error.hint]
    .filter((p) => p && String(p).trim().length > 0);
  throw new Error(parts.join(" · ") || fallback);
}

export function useApplyFreightStatusOverride() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (params: {
      shipment: FreightShipment;
      newStatus: FreightShipment["status"];
      actorId: string;
      reason?: string | null;
    }) => {
      const { shipment, newStatus, actorId, reason } = params;

      // Delivery is a different RPC entirely — it moves inventory in
      // addition to flipping the status. Keep that path here so the
      // caller doesn't have to switch hooks for one transition.
      if (newStatus === "delivered") {
        const { data, error } = await supabase.rpc("rpc_apply_freight_delivery", {
          p_shipment_id: shipment.id,
          p_actor_id: actorId,
        });
        if (error) wrapPostgrestError(error, "Delivery RPC failed");
        const result = data as { ok: boolean; error?: string; line_items_processed?: number };
        if (!result.ok) throw new Error(result.error ?? "Delivery RPC failed");
        return result;
      }

      // Non-delivery: the row-version-gated status-override RPC from
      // migration 044. Writes a single audit_logs entry per call.
      const { data, error } = await supabase.rpc("rpc_apply_freight_status_override", {
        p_shipment_id: shipment.id,
        p_new_status: newStatus,
        p_actor_id: actorId,
        p_expected_version: shipment.row_version,
        p_reason: reason ?? undefined,
      });
      if (error) wrapPostgrestError(error, "Status override failed");
      const result = data as {
        ok: boolean;
        error?: string;
        prev_status?: string;
        new_status?: string;
        current_version?: number;
      };
      if (!result.ok) {
        const msg =
          result.error === "version_conflict"
            ? `Shipment was modified by someone else (current version ${result.current_version}). Refresh and retry.`
            : result.error === "use_delivery_rpc"
              ? "Use the delivery flow for delivered transitions."
              : (result.error ?? "Status override failed");
        throw new Error(msg);
      }
      return result;
    },
    onSuccess: (_data, { shipment }) => {
      qc.invalidateQueries({ queryKey: ["freight"] });
      qc.invalidateQueries({ queryKey: ["freight", shipment.id] });
      qc.invalidateQueries({ queryKey: ["inventory"] });
      qc.invalidateQueries({ queryKey: ["inventory-transactions"] });
      qc.invalidateQueries({ queryKey: ["audit-logs"] });
    },
  });
}

export function useClearFreightStatusOverride() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (params: { shipment: FreightShipment; actorId: string }) => {
      const { shipment, actorId } = params;

      const { data, error } = await supabase.rpc("rpc_clear_freight_status_override", {
        p_shipment_id: shipment.id,
        p_actor_id: actorId,
        p_expected_version: shipment.row_version,
      });
      if (error) wrapPostgrestError(error, "Clear override failed");
      const result = data as {
        ok: boolean;
        error?: string;
        noop?: boolean;
        current_version?: number;
      };
      if (!result.ok) {
        const msg =
          result.error === "version_conflict"
            ? `Shipment was modified by someone else (current version ${result.current_version}). Refresh and retry.`
            : (result.error ?? "Clear override failed");
        throw new Error(msg);
      }
      return result;
    },
    onSuccess: (_data, { shipment }) => {
      qc.invalidateQueries({ queryKey: ["freight"] });
      qc.invalidateQueries({ queryKey: ["freight", shipment.id] });
      qc.invalidateQueries({ queryKey: ["audit-logs"] });
    },
  });
}
