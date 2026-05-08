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

/**
 * Reconstruct a per-day series of TOTAL warehouse balances for a SKU
 * over the last `days` days. Powers the history half of the inventory
 * projection chart on the SKU detail modal.
 *
 * "Total warehouse" = sum across all five buckets:
 *   warehouse_raw + warehouse_prefilled_raw + warehouse_in_production
 *   + warehouse_finished + warehouse_other
 *
 * We don't keep daily snapshots in the schema, so history is derived by
 * walking inventory_transactions backwards from the current total:
 *
 *   total_at(t) = current_total - Σ delta(tx) for tx.created_at > t
 *
 * Where delta(tx) is how much TOTAL warehouse changed at tx:
 *   - movement_kind='net_change' AND field_affected starts with 'warehouse_'
 *       → delta = tx.quantity   (already signed: negative for sales)
 *   - movement_kind='category_move' between two warehouse_* buckets
 *       → delta = 0   (intra-warehouse movement; total unchanged)
 *   - movement_kind='category_move' from warehouse_* to non-warehouse field
 *       → delta = -tx.quantity   (units left the warehouse)
 *   - movement_kind='category_move' to warehouse_* from non-warehouse field
 *       → delta = +tx.quantity   (units entered the warehouse)
 *   - movement_kind='metadata' (oversell warnings, audit-only) → 0
 *   - field_affected on non-inventory columns (eta, status, etc.) → 0
 *
 * Returns end-of-day balances, oldest first. If a SKU has no inventory-
 * affecting transactions in the window, the series is filled flat at the
 * current total — no transactions = no changes = balance was constant.
 *
 * Caller passes the current total (already loaded for the chart) so we
 * don't need to hit inventory_levels twice.
 */
export interface InventoryWarehouseHistoryPoint {
  date: string; // ISO yyyy-mm-dd, end-of-day
  total: number;
}

export function useSkuWarehouseTotalHistory(
  skuId: string | null | undefined,
  currentTotal: number,
  days: number,
) {
  return useQuery({
    queryKey: ["sku-warehouse-total-history", skuId, currentTotal, days],
    enabled: !!skuId,
    queryFn: async (): Promise<InventoryWarehouseHistoryPoint[]> => {
      // Pull every tx in the window for this SKU. Cap at 5000 rows —
      // a busy SKU at ~50 movements/day fits 100 days; if any SKU ever
      // blows past that we'll see an undercounted history line rather
      // than a stuck query.
      const cutoffIso = new Date(Date.now() - days * 86400_000).toISOString();
      const { data, error } = await supabase
        .from("inventory_transactions")
        .select("created_at, quantity, movement_kind, field_affected, from_field, to_field")
        .eq("sku_id", skuId!)
        .gte("created_at", cutoffIso)
        .order("created_at", { ascending: false })
        .limit(5000);
      if (error) throw error;
      type TxRow = {
        created_at: string;
        quantity: number;
        movement_kind: string;
        field_affected: string;
        from_field: string | null;
        to_field: string | null;
      };
      const txs = (data ?? []) as unknown as TxRow[];

      const isWarehouseField = (f: string | null) =>
        !!f && f.startsWith("warehouse_");

      function deltaToTotal(tx: TxRow): number {
        if (tx.movement_kind === "metadata") return 0;
        if (tx.movement_kind === "category_move") {
          const fromIsWh = isWarehouseField(tx.from_field);
          const toIsWh = isWarehouseField(tx.to_field);
          // Intra-warehouse move — total unchanged.
          if (fromIsWh && toIsWh) return 0;
          // Units leaving warehouse (rare; would be e.g. write-off).
          if (fromIsWh && !toIsWh) return -tx.quantity;
          // Units entering warehouse from somewhere else.
          if (!fromIsWh && toIsWh) return tx.quantity;
          return 0;
        }
        // net_change — only counts when the field is one of our warehouse
        // buckets. tx on metadata fields like 'eta', 'status', 'role',
        // 'row_hash' contribute nothing.
        return isWarehouseField(tx.field_affected) ? tx.quantity : 0;
      }

      // Walk the timeline. Anchor at "end of today" = current total,
      // then walk backwards subtracting deltas as we cross each tx
      // boundary. UTC end-of-day matches how the rest of the chart
      // formats dates.
      const out: InventoryWarehouseHistoryPoint[] = [];
      const todayUTC = new Date();
      todayUTC.setUTCHours(23, 59, 59, 999);

      let runningBalance = currentTotal;
      let txIdx = 0;

      for (let d = 0; d < days; d++) {
        const eod = new Date(todayUTC);
        eod.setUTCDate(eod.getUTCDate() - d);
        while (
          txIdx < txs.length &&
          new Date(txs[txIdx].created_at).getTime() > eod.getTime()
        ) {
          runningBalance -= deltaToTotal(txs[txIdx]);
          txIdx++;
        }
        out.push({
          date: eod.toISOString().slice(0, 10),
          total: Math.max(0, Math.round(runningBalance)),
        });
      }

      return out.reverse();
    },
    staleTime: 5 * 60_000,
  });
}
