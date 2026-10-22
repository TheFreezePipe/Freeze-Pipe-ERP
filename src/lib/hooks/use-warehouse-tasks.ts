import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useLiveInvalidate } from "@/lib/realtime";
import type { Database } from "@/lib/database.types";
import { whRpc, type WhContainerState, type WhRpcResult } from "./use-warehouse";

/**
 * Warehouse Phase 1 task reads and station sessions (design §5.5, §9.4):
 * the putaway queue, one print job's status, the caller's live station and
 * the printers. Station start/end are RPCs; everything else here is a read.
 */

export type WhMoveRow = Database["public"]["Tables"]["wh_moves"]["Row"] & {
  container: { code: string; sku_id: string | null; qty: number; state: WhContainerState; label_stock: "white" | "green" } | null;
  sku: { sku: string; product_name: string } | null;
  suggested: { code: string } | null;
  from: { code: string } | null;
};

export interface WhPutawayFilter {
  origin?: "receipt" | "rts" | "manual" | "reconcile";
  fromLocationId?: string;
}

/** Open putaways, RTS cartons first (priority), then oldest first. */
export function useWhPutawayQueue(filter: WhPutawayFilter = {}) {
  useLiveInvalidate("wh-tasks", ["wh_moves"], [["wh-putaway"], ["wh-overview"]]);
  return useQuery({
    queryKey: ["wh-putaway", filter],
    queryFn: async (): Promise<WhMoveRow[]> => {
      let q = supabase
        .from("wh_moves")
        .select(
          "*, container:wh_containers(code, sku_id, qty, state, label_stock), sku:product_skus(sku, product_name), suggested:wh_locations!wh_moves_suggested_location_id_fkey(code), from:wh_locations!wh_moves_from_location_id_fkey(code)",
        )
        .eq("kind", "putaway")
        .in("status", ["open", "in_progress"]);
      if (filter.origin) q = q.eq("origin", filter.origin);
      if (filter.fromLocationId) q = q.eq("from_location_id", filter.fromLocationId);
      const { data, error } = await q
        .order("priority", { ascending: false })
        .order("created_at", { ascending: true })
        .limit(500);
      if (error) throw error;
      return (data ?? []) as unknown as WhMoveRow[];
    },
    staleTime: 30 * 1000,
  });
}

export type WhPrintJobRow = Database["public"]["Tables"]["wh_print_jobs"]["Row"] & {
  printer: { code: string; name: string } | null;
};

const PENDING_PRINT = new Set(["queued", "claimed"]);

/** One print job; refetches every 2 s while it is queued or being printed. */
export function useWhPrintJob(id: string | null | undefined) {
  return useQuery({
    queryKey: ["wh-print-job", id],
    enabled: !!id,
    queryFn: async (): Promise<WhPrintJobRow | null> => {
      const { data, error } = await supabase
        .from("wh_print_jobs")
        .select("*, printer:wh_printers(code, name)")
        .eq("id", id as string)
        .maybeSingle();
      if (error) throw error;
      return (data ?? null) as unknown as WhPrintJobRow | null;
    },
    refetchInterval: (query) => (PENDING_PRINT.has(query.state.data?.status ?? "") ? 2000 : false),
  });
}

export interface WhStationSession {
  id: string;
  station_location_id: string;
  started_at: string;
  device_id: string | null;
  station: { code: string; name: string | null } | null;
}

/** The signed-in person's live station session, or null. */
export function useWhStation() {
  return useQuery({
    queryKey: ["wh-station"],
    queryFn: async (): Promise<WhStationSession | null> => {
      const { data: auth } = await supabase.auth.getSession();
      const profileId = auth.session?.user.id;
      if (!profileId) return null;
      const { data, error } = await supabase
        .from("wh_station_sessions")
        .select("id, station_location_id, started_at, device_id, station:wh_locations(code, name)")
        .eq("profile_id", profileId)
        .is("ended_at", null)
        .maybeSingle();
      if (error) throw error;
      return (data ?? null) as unknown as WhStationSession | null;
    },
    staleTime: 60 * 1000,
  });
}

const DEVICE_KEY = "fp-wh-device-id";

/** A random id per browser, kept in localStorage, so a fixed laptop can be told apart. */
export function getWhDeviceId(): string | null {
  try {
    const existing = window.localStorage.getItem(DEVICE_KEY);
    if (existing) return existing;
    const fresh = crypto.randomUUID();
    window.localStorage.setItem(DEVICE_KEY, fresh);
    return fresh;
  } catch {
    return null;
  }
}

/** Scan a station label: ends the caller's previous session and opens one there. Exported for tests. */
export function startWhStation(
  params: { scan: string; deviceId?: string | null },
  client?: unknown,
): Promise<WhRpcResult<"rpc_wh_start_station">> {
  return whRpc(
    "rpc_wh_start_station",
    { p_scan_value: params.scan, p_device_id: params.deviceId ?? null },
    "Couldn't start the station",
    client,
  );
}

/** End the caller's live station session. Exported for tests. */
export function endWhStation(client?: unknown): Promise<WhRpcResult<"rpc_wh_end_station">> {
  return whRpc("rpc_wh_end_station", {}, "Couldn't end the station", client);
}

export function useWhStartStation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params: { scan: string; deviceId?: string | null }) =>
      startWhStation({ scan: params.scan, deviceId: params.deviceId === undefined ? getWhDeviceId() : params.deviceId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["wh-station"] });
    },
  });
}

export function useWhEndStation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => endWhStation(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["wh-station"] });
    },
  });
}

export type WhPrinterRow = Database["public"]["Tables"]["wh_printers"]["Row"] & {
  station: { code: string; name: string | null } | null;
};

/** Every printer with its station and the agent's last heartbeat. */
export function useWhPrinters() {
  useLiveInvalidate("wh-printers", ["wh_printers"], [["wh-printers"]]);
  return useQuery({
    queryKey: ["wh-printers"],
    queryFn: async (): Promise<WhPrinterRow[]> => {
      const { data, error } = await supabase
        .from("wh_printers")
        .select("*, station:wh_locations(code, name)")
        .order("code");
      if (error) throw error;
      return (data ?? []) as unknown as WhPrinterRow[];
    },
    staleTime: 60 * 1000,
  });
}

