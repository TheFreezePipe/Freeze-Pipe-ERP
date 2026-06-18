import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";

export interface RetailValueHistoryPoint {
  day: string;
  warehouse: number;
  transit: number;
  onOrder: number;
  total: number;
  /** true when this day's values come from an exact nightly snapshot
   *  (vs. reconstructed from records at current prices). */
  isSnapshot: boolean;
}

/**
 * Daily three-stage retail value of inventory (In Warehouse / In Transit /
 * On Order) over the trailing `days`. Server reconstructs history back to
 * go-live from the transaction ledger + freight/factory dates, and prefers
 * exact nightly snapshots once they exist (rpc_inventory_retail_value_history).
 * Postgres returns numeric columns as strings, so coerce with Number().
 */
export function useRetailValueHistory(days: number) {
  return useQuery({
    queryKey: ["retail-value-history", days],
    queryFn: async (): Promise<RetailValueHistoryPoint[]> => {
      const { data, error } = await supabase.rpc(
        "rpc_inventory_retail_value_history",
        { p_days: days },
      );
      if (error) throw error;
      return ((data ?? []) as Array<Record<string, unknown>>).map((r) => {
        const warehouse = Number(r.warehouse_retail ?? 0);
        const transit = Number(r.transit_retail ?? 0);
        const onOrder = Number(r.onorder_retail ?? 0);
        return {
          day: r.day as string,
          warehouse,
          transit,
          onOrder,
          total: warehouse + transit + onOrder,
          isSnapshot: !!r.is_snapshot,
        };
      });
    },
    staleTime: 5 * 60 * 1000,
  });
}
