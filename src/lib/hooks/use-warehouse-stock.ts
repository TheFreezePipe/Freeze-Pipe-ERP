import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useLiveInvalidate } from "@/lib/realtime";
import type { Database } from "@/lib/database.types";
import { whRpc, type WhBucket, type WhContainerState, type WhRpcResult } from "./use-warehouse";

/**
 * Warehouse Phase 1 stock reads (design §9.4): locations with what they
 * hold, one location's balances, cartons and recent movements, and cartons
 * by filter. Writes go through the RPCs in use-warehouse / use-warehouse-tasks.
 */

type SummaryRow = Database["public"]["Views"]["wh_location_summary"]["Row"];

/** One non-zero balance at a location: a carton's units or loose units. */
export interface WhLocationContent {
  container_id: string | null;
  code: string | null;
  sku_id: string;
  sku: string;
  qty: number;
  bucket: WhBucket;
  state: WhContainerState | null;
  label_stock: "white" | "green" | null;
}

/** A wh_location_summary row with its contents typed. */
export type WhLocationSummary = Omit<SummaryRow, "contents"> & { contents: WhLocationContent[] };

const LOCATION_ROOTS = [["wh-locations"], ["wh-location"], ["wh-containers"]];

/** Every location with cartons, units by bucket, SKU count and contents, in walk order. */
export function useWhLocations() {
  useLiveInvalidate("wh-stock", ["wh_inventory_balances", "wh_containers"], LOCATION_ROOTS);
  return useQuery({
    queryKey: ["wh-locations"],
    queryFn: async (): Promise<WhLocationSummary[]> => {
      const { data, error } = await supabase
        .from("wh_location_summary")
        .select("*")
        .order("pick_sequence", { ascending: true, nullsFirst: false })
        .order("code", { ascending: true });
      if (error) throw error;
      return (data ?? []).map((row) => ({
        ...row,
        contents: (Array.isArray(row.contents) ? row.contents : []) as unknown as WhLocationContent[],
      }));
    },
    staleTime: 60 * 1000,
  });
}

export interface WhBalanceRow {
  id: string;
  sku_id: string;
  container_id: string | null;
  bucket: WhBucket;
  on_hand: number;
  allocated: number;
  available: number | null;
  last_movement_at: string | null;
  sku: { sku: string; product_name: string } | null;
  container: { code: string; state: WhContainerState; label_stock: "white" | "green" } | null;
}

export interface WhMovementRow {
  id: string;
  seq: number;
  type: string;
  sku_id: string;
  bucket: WhBucket;
  to_bucket: WhBucket | null;
  qty: number;
  from_location_id: string | null;
  to_location_id: string | null;
  from_container_id: string | null;
  to_container_id: string | null;
  actor_id: string;
  note: string | null;
  created_at: string;
  sku: { sku: string } | null;
}

export type WhContainerRow = Database["public"]["Tables"]["wh_containers"]["Row"] & {
  sku: { sku: string; product_name: string } | null;
  location: { code: string } | null;
};

export interface WhLocationDetail {
  location: WhLocationSummary | null;
  balances: WhBalanceRow[];
  containers: WhContainerRow[];
  movements: WhMovementRow[];
}

/** One location: its summary row, non-zero balances, live cartons and its last 25 movements. */
export function useWhLocation(id: string | null | undefined) {
  return useQuery({
    queryKey: ["wh-location", id],
    enabled: !!id,
    queryFn: async (): Promise<WhLocationDetail> => {
      const locationId = id as string;
      const [summary, balances, containers, movements] = await Promise.all([
        supabase.from("wh_location_summary").select("*").eq("id", locationId).maybeSingle(),
        supabase
          .from("wh_inventory_balances")
          .select("id, sku_id, container_id, bucket, on_hand, allocated, available, last_movement_at, sku:product_skus(sku, product_name), container:wh_containers(code, state, label_stock)")
          .eq("location_id", locationId)
          .neq("on_hand", 0),
        supabase
          .from("wh_containers")
          .select("*, sku:product_skus(sku, product_name), location:wh_locations(code)")
          .eq("location_id", locationId)
          .in("state", ["sealed", "open"])
          .order("code"),
        supabase
          .from("wh_inventory_movements")
          .select("id, seq, type, sku_id, bucket, to_bucket, qty, from_location_id, to_location_id, from_container_id, to_container_id, actor_id, note, created_at, sku:product_skus(sku)")
          .or(`from_location_id.eq.${locationId},to_location_id.eq.${locationId}`)
          .order("seq", { ascending: false })
          .limit(25),
      ]);
      for (const r of [summary, balances, containers, movements]) if (r.error) throw r.error;
      const row = summary.data;
      return {
        location: row
          ? { ...row, contents: (Array.isArray(row.contents) ? row.contents : []) as unknown as WhLocationContent[] }
          : null,
        balances: (balances.data ?? []) as unknown as WhBalanceRow[],
        containers: (containers.data ?? []) as unknown as WhContainerRow[],
        movements: (movements.data ?? []) as unknown as WhMovementRow[],
      };
    },
    staleTime: 30 * 1000,
  });
}

export interface WhContainerFilter {
  locationId?: string;
  shipmentId?: string;
  skuId?: string;
  /** Defaults to the live states, sealed and open. */
  states?: WhContainerState[];
  labelStock?: "white" | "green";
}

/** Cartons by location, shipment, SKU or label colour (live states by default; at most 500). */
export function useWhContainers(filter: WhContainerFilter = {}) {
  return useQuery({
    queryKey: ["wh-containers", filter],
    queryFn: async (): Promise<WhContainerRow[]> => {
      let q = supabase
        .from("wh_containers")
        .select("*, sku:product_skus(sku, product_name), location:wh_locations(code)")
        .in("state", filter.states ?? ["sealed", "open"]);
      if (filter.locationId) q = q.eq("location_id", filter.locationId);
      if (filter.shipmentId) q = q.eq("freight_shipment_id", filter.shipmentId);
      if (filter.skuId) q = q.eq("sku_id", filter.skuId);
      if (filter.labelStock) q = q.eq("label_stock", filter.labelStock);
      const { data, error } = await q.order("code").limit(500);
      if (error) throw error;
      return (data ?? []) as unknown as WhContainerRow[];
    },
    staleTime: 30 * 1000,
  });
}

/** The Overview KPI band in one call (admin, manager). */
export function useWhOverview(enabled = true) {
  return useQuery({
    queryKey: ["wh-overview"],
    enabled,
    queryFn: (): Promise<WhRpcResult<"rpc_wh_overview">> =>
      whRpc("rpc_wh_overview", {}, "Couldn't load the warehouse overview"),
    staleTime: 60 * 1000,
  });
}
