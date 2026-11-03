import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import type { Database } from "@/lib/database.types";

export type SkuShippingMeasuredRow = Database["public"]["Tables"]["sku_shipping_measured"]["Row"];
export type ShippingMeasureRunRow = Database["public"]["Tables"]["shipping_measure_runs"]["Row"];
export type ShippingBoxTareRow = Database["public"]["Tables"]["shipping_box_tare"]["Row"];

/**
 * Measured outbound shipping per SKU ("as sold"), keyed by sku_id. Written
 * weekly by the shipping-measure edge function from real label costs and
 * scale-measured order weights. A row with confidence 'high' is the number
 * of record; otherwise the typed-in estimate on sku_economics is used.
 */
export function useAllShippingMeasured() {
  return useQuery({
    queryKey: ["shipping-measured", "all"],
    queryFn: async () => {
      const { data, error } = await supabase.from("sku_shipping_measured").select("*");
      if (error) throw error;
      const byId = new Map<string, SkuShippingMeasuredRow>();
      for (const r of data ?? []) byId.set(r.sku_id, r);
      return byId;
    },
    staleTime: 5 * 60_000,
  });
}

export function useShippingMeasured(skuId: string | null | undefined) {
  return useQuery({
    queryKey: ["shipping-measured", skuId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("sku_shipping_measured")
        .select("*")
        .eq("sku_id", skuId!)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
    enabled: !!skuId,
    staleTime: 5 * 60_000,
  });
}

/** The most recent weekly solve: window, fit quality, and the exceptions list. */
export function useLatestShippingMeasureRun() {
  return useQuery({
    queryKey: ["shipping-measured", "latest-run"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("shipping_measure_runs")
        .select("*")
        .is("error", null)
        .order("started_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
    staleTime: 5 * 60_000,
  });
}

export function useShippingBoxTares() {
  return useQuery({
    queryKey: ["shipping-measured", "box-tares"],
    queryFn: async () => {
      const { data, error } = await supabase.from("shipping_box_tare").select("*").order("tare_oz");
      if (error) throw error;
      return data ?? [];
    },
    staleTime: 5 * 60_000,
  });
}
