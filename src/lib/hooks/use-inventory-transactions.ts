import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import type { InventoryTransaction, ProductSKU, Profile } from "@/types/database";

export type InventoryTransactionWithDetails = InventoryTransaction & {
  product: ProductSKU | null;
  performed_by_profile: Profile | null;
};

export function useInventoryTransactions(limit = 200) {
  return useQuery({
    queryKey: ["inventory-transactions", limit],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("inventory_transactions")
        .select("*, product:product_skus(*), performed_by_profile:profiles!performed_by(*)")
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) throw error;
      return data as InventoryTransactionWithDetails[];
    },
    staleTime: 60 * 1000,
  });
}
