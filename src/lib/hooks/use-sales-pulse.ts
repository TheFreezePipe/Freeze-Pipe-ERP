import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";

export interface SalesPulse {
  orders_today: number;
  units_today: number;
  orders_yesterday: number;
  units_yesterday: number;
  /** Orders currently awaiting shipment (today's pending label queue). */
  awaiting_orders: number;
  orders_7d: number;
  orders_prior_7d: number;
  units_7d: number;
  units_prior_7d: number;
}

/**
 * Dashboard sales pulse — orders/units shipped today (warehouse day,
 * America/New_York) + yesterday + the awaiting-shipment queue +
 * trailing-7d vs prior-7d units, aggregated server-side from ShipStation
 * orders (rpc_sales_pulse). Fresh within ~30 min via the intraday
 * reconcile. Note: the warehouse prints labels in end-of-day batches, so
 * "today" is structurally low before mid-afternoon — that's why the
 * queue and yesterday numbers travel with it.
 */
export function useSalesPulse() {
  return useQuery({
    queryKey: ["sales-pulse"],
    queryFn: async (): Promise<SalesPulse | null> => {
      const { data, error } = await supabase.rpc("rpc_sales_pulse");
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      return (row ?? null) as SalesPulse | null;
    },
    staleTime: 5 * 60 * 1000,
  });
}
