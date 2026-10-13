import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { computeSaleMetrics, type SaleInput, type SaleMetrics } from "@/lib/marketing/sale-metrics";

/**
 * Sale results: rpc_sale_metrics (every raw input for one sale, ET-keyed,
 * store-filtered) → computeSaleMetrics (all judgement in the frontend).
 * Live sales refetch every 5 minutes while the tab is visible; the data
 * itself is as fresh as the ShipStation reconcile (about 30 minutes).
 */
export function useSaleMetrics(saleId: string | null | undefined, opts: { seasonIndex?: number } = {}) {
  const q = useQuery({
    queryKey: ["sale-metrics", saleId],
    enabled: !!saleId,
    queryFn: async (): Promise<SaleInput> => {
      const { data, error } = await supabase.rpc("rpc_sale_metrics", { p_sale_id: saleId! });
      if (error) throw error;
      return data as unknown as SaleInput;
    },
    staleTime: 5 * 60 * 1000,
    refetchInterval: (query) => {
      const d = query.state.data as SaleInput | undefined;
      if (!d) return false;
      const today = d.as_of_day;
      const live = today >= d.sale.d1 && today <= d.sale.end;
      return live ? 5 * 60 * 1000 : false;
    },
  });
  const metrics: SaleMetrics | null = q.data ? computeSaleMetrics(q.data, opts) : null;
  return { ...q, metrics };
}

export function useSetSaleSetting() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ saleId, key, value }: { saleId: string; key: "plan_orders" | "season_index" | "cm_pct" | "store_ids"; value: unknown }) => {
      const { error } = await supabase.rpc("rpc_set_sale_setting", { p_sale_id: saleId, p_key: key, p_value: value as never });
      if (error) throw error;
    },
    onSuccess: (_d, v) => {
      void qc.invalidateQueries({ queryKey: ["sale-metrics", v.saleId] });
      void qc.invalidateQueries({ queryKey: ["mkt-sale", v.saleId] });
      void qc.invalidateQueries({ queryKey: ["mkt-sales"] });
    },
  });
}
