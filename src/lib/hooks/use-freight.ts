import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { supabaseUpdateWithVersion } from "@/lib/concurrency";
import type { FreightShipment, FreightLineItem, ProductSKU } from "@/types/database";
import type { Database, Json } from "@/lib/database.types";

type FreightShipmentInsert = Database["public"]["Tables"]["freight_shipments"]["Insert"];
type FreightLineItemInsert = Database["public"]["Tables"]["freight_line_items"]["Insert"];
type FreightCartonGroupRow = Database["public"]["Tables"]["freight_carton_groups"]["Row"];
type FreightCartonGroupSkuRow = Database["public"]["Tables"]["freight_carton_group_skus"]["Row"];

export type FreightLineItemWithProduct = FreightLineItem & { product: ProductSKU | null };
export type FreightShipmentWithItems = FreightShipment & { line_items: FreightLineItemWithProduct[] };

export type CartonGroupSkuWithProduct = FreightCartonGroupSkuRow & {
  product: Pick<ProductSKU, "sku" | "product_name"> | null;
};
export type CartonGroupWithSkus = FreightCartonGroupRow & {
  skus: CartonGroupSkuWithProduct[];
};

/** One entry for rpc_record_freight_receipt. Negative cartons/units = correction. */
export type FreightReceiptEntry =
  | { carton_group_id: string; cartons: number }
  | { line_item_id: string; units: number };

export interface RecordFreightReceiptResult {
  ok: boolean;
  units_credited?: number;
  fully_received?: boolean;
  credited?: Array<{ sku_id: string; units: number }>;
  message?: string;
  error?: string;
}

export interface CloseFreightShortResult {
  ok: boolean;
  units_short?: number;
  variances_created?: number;
  factory_orders_reopened?: number;
  message?: string;
  error?: string;
}

export function useFreightShipments() {
  return useQuery({
    queryKey: ["freight"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("freight_shipments")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data as FreightShipment[];
    },
    staleTime: 2 * 60 * 1000,
  });
}

export function useFreightLineItems(shipmentId?: string) {
  return useQuery({
    queryKey: ["freight-line-items", shipmentId ?? "all"],
    queryFn: async () => {
      let query = supabase
        .from("freight_line_items")
        .select("*, product:product_skus(*)");
      if (shipmentId) query = query.eq("freight_shipment_id", shipmentId);
      const { data, error } = await query;
      if (error) throw error;
      return data as FreightLineItemWithProduct[];
    },
    staleTime: 2 * 60 * 1000,
  });
}

export function useFreightShipment(id: string) {
  return useQuery({
    queryKey: ["freight", id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("freight_shipments")
        .select("*")
        .eq("id", id)
        .single();
      if (error) throw error;
      return data as FreightShipment;
    },
    enabled: !!id,
  });
}

export function useCreateFreightShipment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (payload: {
      shipment: Omit<FreightShipmentInsert, "id" | "created_at" | "updated_at" | "row_version">;
      lineItems: Omit<FreightLineItemInsert, "id" | "freight_shipment_id" | "created_at" | "updated_at" | "row_version">[];
    }) => {
      const { data: shipmentData, error: shipErr } = await supabase
        .from("freight_shipments")
        .insert(payload.shipment)
        .select()
        .single();
      if (shipErr) throw shipErr;
      const shipment = shipmentData as unknown as FreightShipment;

      if (payload.lineItems.length > 0) {
        const rows: FreightLineItemInsert[] = payload.lineItems.map((li) => ({
          ...li,
          freight_shipment_id: shipment.id,
        }));
        const { error: liErr } = await supabase
          .from("freight_line_items")
          .insert(rows);
        if (liErr) throw liErr;
      }
      return shipment;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["freight"] });
      qc.invalidateQueries({ queryKey: ["freight-line-items"] });
    },
  });
}

export function useUpdateFreightShipment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (params: {
      id: string;
      updates: Partial<FreightShipment>;
      expectedVersion?: number;
    }) => {
      return supabaseUpdateWithVersion(
        supabase,
        "freight_shipments",
        params.id,
        params.expectedVersion ?? null,
        params.updates as Record<string, unknown>,
      );
    },
    onSuccess: (_data, { id }) => {
      qc.invalidateQueries({ queryKey: ["freight"] });
      qc.invalidateQueries({ queryKey: ["freight", id] });
    },
  });
}

/**
 * Confirm receipt of a delivered freight shipment.
 *
 * Carrier tracking flips a shipment's status to 'delivered' when the
 * carrier reports delivery, but inventory_levels DOES NOT move at that
 * point. An admin or manager must explicitly confirm physical receipt
 * before the units land in warehouse_raw — handles the case where a
 * shipment is marked delivered by carrier but is still sitting in a
 * freight terminal awaiting pickup.
 *
 * The RPC (rpc_apply_freight_delivery, post-migration 20260506000001)
 * itself enforces the admin/manager role check on the caller's
 * auth.uid(); this hook just wraps it. UI is responsible for hiding the
 * affordance from non-admin/manager users to avoid surprising errors.
 */
export function useConfirmFreightReceipt() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (params: { shipmentId: string; actorId: string }) => {
      const { data, error } = await supabase.rpc("rpc_apply_freight_delivery", {
        p_shipment_id: params.shipmentId,
        p_actor_id: params.actorId,
      });
      if (error) throw error;
      const result = data as { ok?: boolean; message?: string; error?: string; line_items_processed?: number };
      if (!result?.ok) {
        throw new Error(result?.message ?? result?.error ?? "Receipt confirmation failed");
      }
      return result;
    },
    onSuccess: (_data, { shipmentId }) => {
      qc.invalidateQueries({ queryKey: ["freight"] });
      qc.invalidateQueries({ queryKey: ["freight", shipmentId] });
      qc.invalidateQueries({ queryKey: ["freight-line-items"] });
      qc.invalidateQueries({ queryKey: ["inventory"] });
    },
  });
}

/**
 * Carton groups for a shipment, with nested SKU splits + product identity
 * (sku, product_name), ordered by sort_order. Drives the tap-per-carton
 * receiving UX; shipments without groups fall back to unit-mode receiving
 * against raw line items.
 *
 * The product embed rides the freight_carton_group_skus.sku_id →
 * product_skus FK from migration 20260722000001. The generated types file
 * doesn't (yet) list that relationship, so the cast goes through `unknown`
 * rather than relying on supabase-js's select-string parser.
 */
export function useCartonGroups(shipmentId: string) {
  return useQuery({
    queryKey: ["freight-carton-groups", shipmentId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("freight_carton_groups")
        .select("*, skus:freight_carton_group_skus(*, product:product_skus(sku, product_name))")
        .eq("freight_shipment_id", shipmentId)
        .order("sort_order", { ascending: true });
      if (error) throw error;
      return data as unknown as CartonGroupWithSkus[];
    },
    enabled: !!shipmentId,
    staleTime: 2 * 60 * 1000,
  });
}

/**
 * Record an incremental freight receipt (rpc_record_freight_receipt).
 *
 * Entries are carton taps ({carton_group_id, cartons: ±n}) or unit-mode
 * postings ({line_item_id, units: ±n}); negative values are corrections.
 * The RPC credits inventory buckets per units received and — when every
 * catalog line reaches its declared quantity — auto-stamps the shipment
 * delivered + receipt-confirmed. Admin/manager enforced server-side;
 * hide the affordance from other roles (same contract as
 * useConfirmFreightReceipt above).
 */
export function useRecordFreightReceipt() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (params: {
      shipmentId: string;
      entries: FreightReceiptEntry[];
      actorId: string;
    }) => {
      const { data, error } = await supabase.rpc("rpc_record_freight_receipt", {
        p_shipment_id: params.shipmentId,
        p_entries: params.entries as unknown as Json,
        p_actor_id: params.actorId,
      });
      if (error) throw error;
      const result = data as unknown as RecordFreightReceiptResult;
      if (!result?.ok) {
        throw new Error(result?.message ?? result?.error ?? "Failed to record receipt");
      }
      return result;
    },
    onSuccess: (_data, { shipmentId }) => {
      qc.invalidateQueries({ queryKey: ["freight"] });
      qc.invalidateQueries({ queryKey: ["freight", shipmentId] });
      qc.invalidateQueries({ queryKey: ["freight-line-items"] });
      qc.invalidateQueries({ queryKey: ["inventory"] });
      qc.invalidateQueries({ queryKey: ["freight-carton-groups", shipmentId] });
    },
  });
}

/**
 * Close a partially-received shipment short (rpc_close_freight_short).
 *
 * Server-side this files shortage variances, shrinks each line to what
 * physically arrived (returning the missing units to on-order via the
 * existing netting), reopens auto-completed factory orders, and stamps
 * closed_short_at + receipt confirmation. Admin/manager enforced
 * server-side.
 */
export function useCloseFreightShort() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (params: {
      shipmentId: string;
      reason: string;
      actorId: string;
    }) => {
      const { data, error } = await supabase.rpc("rpc_close_freight_short", {
        p_shipment_id: params.shipmentId,
        p_reason: params.reason,
        p_actor_id: params.actorId,
      });
      if (error) throw error;
      const result = data as unknown as CloseFreightShortResult;
      if (!result?.ok) {
        throw new Error(result?.message ?? result?.error ?? "Failed to close shipment short");
      }
      return result;
    },
    onSuccess: (_data, { shipmentId }) => {
      qc.invalidateQueries({ queryKey: ["freight"] });
      qc.invalidateQueries({ queryKey: ["freight", shipmentId] });
      qc.invalidateQueries({ queryKey: ["freight-line-items"] });
      qc.invalidateQueries({ queryKey: ["inventory"] });
      qc.invalidateQueries({ queryKey: ["freight-carton-groups", shipmentId] });
      // Close-short can flip auto-completed factory orders back to
      // in_production — refresh those too.
      qc.invalidateQueries({ queryKey: ["factory-orders"] });
    },
  });
}
