import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { supabaseUpdateWithVersion } from "@/lib/concurrency";
import type { FreightShipment, FreightLineItem, ProductSKU } from "@/types/database";
import type { Database } from "@/lib/database.types";

type FreightShipmentInsert = Database["public"]["Tables"]["freight_shipments"]["Insert"];
type FreightLineItemInsert = Database["public"]["Tables"]["freight_line_items"]["Insert"];

export type FreightLineItemWithProduct = FreightLineItem & { product: ProductSKU };
export type FreightShipmentWithItems = FreightShipment & { line_items: FreightLineItemWithProduct[] };

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
