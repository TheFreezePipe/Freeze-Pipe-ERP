import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import type { FreightShipment } from "@/types/database";

/**
 * Carrier tracking now happens server-side via the tracking-reconcile Edge
 * Function (pg_cron every 6 hours). The client is a read-only view of the
 * reconciled state stored on freight_shipments.
 *
 * This hook exposes just a manual-refresh capability: trigger the Edge
 * Function on demand (bypassing the schedule), then invalidate the freight
 * query so the UI pulls the updated ETA/status.
 *
 * The per-shipment "worker" component from the old design is retired. The
 * 12-hour client poll was a workaround for "what if nobody is logged in";
 * the server-side cron solves that properly.
 */
export function useShipmentTracking(shipment: FreightShipment | null | undefined) {
  const qc = useQueryClient();

  const manualRefresh = useMutation({
    mutationFn: async () => {
      if (!shipment) return null;
      // Fire-and-wait: trigger the Edge Function to reconcile this specific
      // shipment. The function reads its own auth header; anonymous invocation
      // is allowed for manual refreshes so a logged-in user can nudge a
      // specific shipment's tracking check.
      const { data, error } = await supabase.functions.invoke("tracking-reconcile", {
        body: { shipmentId: shipment.id },
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      if (!shipment) return;
      qc.invalidateQueries({ queryKey: ["freight"] });
      qc.invalidateQueries({ queryKey: ["freight", shipment.id] });
    },
  });

  return {
    refetch: () => manualRefresh.mutate(),
    isFetching: manualRefresh.isPending,
    data: shipment ? { update: null, reconciled: null } : null,
  };
}

/**
 * Page-level "refresh all tracking" hook for the freight dashboard's
 * Refresh button. Triggers the same Edge Function the cron uses, which
 * iterates every in-flight shipment and reconciles. Returns a summary
 * report from the function (shipments_checked / eta_changes / status_changes
 * / errors) so the UI can show what happened.
 *
 * Note: the underlying tracking-reconcile function currently always
 * processes ALL in-flight shipments regardless of the body — there is
 * no per-shipment filter on the server side yet. This hook is the
 * appropriate caller for that "all" behavior; the older
 * useShipmentTracking hook above sends a shipmentId in the body that
 * the server ignores (latent — works but redundantly does the full sweep).
 */
type ReconcileReport = {
  shipments_checked: number;
  eta_changes: number;
  status_changes: number;
  overrides_skipped: number;
  errors: number;
  error_details?: Array<{ shipmentId: string; error: string }>;
};

export function useRefreshAllTracking() {
  const qc = useQueryClient();

  const refresh = useMutation({
    mutationFn: async (): Promise<ReconcileReport> => {
      const { data, error } = await supabase.functions.invoke("tracking-reconcile", {
        body: {},
      });
      if (error) throw error;
      // Function returns { ok: true, report: {...} }
      const report = (data as { ok?: boolean; report?: ReconcileReport })?.report;
      if (!report) throw new Error("tracking-reconcile returned no report");
      return report;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["freight"] });
    },
  });

  return {
    refresh: () => refresh.mutateAsync(),
    isRefreshing: refresh.isPending,
    lastReport: refresh.data ?? null,
  };
}

/**
 * Kept as an export for backwards compatibility with list pages that
 * previously rendered one of these per in-transit shipment to kick off
 * client-side polling. Now a no-op: server-side cron drives everything.
 */
export function ShipmentTrackingWorker(_props: { shipment: FreightShipment }) {
  return null;
}
