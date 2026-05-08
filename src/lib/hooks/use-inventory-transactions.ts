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
 * Reconstruct a per-day series of warehouse_finished balances for a SKU
 * over the last `days` days. Powers the history half of the inventory
 * projection chart on the SKU detail modal.
 *
 * We don't keep daily snapshots in the schema, so history is derived by
 * walking inventory_transactions backwards from the current balance:
 *
 *   balance_at(t) = current - Σ delta(tx) for tx.created_at > t
 *
 * Where delta(tx) is how much warehouse_finished changed at tx:
 *   - movement_kind='net_change' AND field_affected='warehouse_finished'
 *       → delta = tx.quantity   (already signed: negative for sales)
 *   - movement_kind='category_move' AND to_field='warehouse_finished'
 *       → delta = +tx.quantity
 *   - movement_kind='category_move' AND from_field='warehouse_finished'
 *       → delta = -tx.quantity
 *   - movement_kind='metadata' (oversell warnings, audit-only) → no change
 *
 * Returns end-of-day balances, oldest first. If a SKU has no transactions
 * in the window, the series is filled flat at the current balance — no
 * transactions = no changes = balance was constant. The chart treats
 * dates earlier than the SKU's first transaction (or the system genesis)
 * as known-flat in the same way; we don't fabricate movement we have no
 * evidence for.
 *
 * Caller passes the current `warehouse_finished` value (already loaded
 * for the chart) so we don't need to hit inventory_levels twice.
 */
export interface InventoryFinishedHistoryPoint {
  date: string; // ISO yyyy-mm-dd, end-of-day
  finished: number;
}

export function useSkuFinishedHistory(
  skuId: string | null | undefined,
  currentFinished: number,
  days: number,
) {
  return useQuery({
    queryKey: ["sku-finished-history", skuId, currentFinished, days],
    enabled: !!skuId,
    queryFn: async (): Promise<InventoryFinishedHistoryPoint[]> => {
      // Pull every relevant tx in the window. Cap at 5000 rows per SKU —
      // a busy SKU at ~50 movements/day still fits comfortably; if any
      // SKU ever blows past that we'll see an undercounted history line
      // (acceptable failure mode) rather than a stuck query.
      const cutoffIso = new Date(Date.now() - days * 86400_000).toISOString();
      const { data, error } = await supabase
        .from("inventory_transactions")
        .select("created_at, quantity, movement_kind, field_affected, from_field, to_field")
        .eq("sku_id", skuId!)
        .gte("created_at", cutoffIso)
        .order("created_at", { ascending: false })
        .limit(5000);
      if (error) throw error;
      // Cast loosely so the new movement_kind/from_field/to_field columns
      // line up regardless of whether the generated types have caught up.
      type TxRow = {
        created_at: string;
        quantity: number;
        movement_kind: string;
        field_affected: string;
        from_field: string | null;
        to_field: string | null;
      };
      const txs = (data ?? []) as unknown as TxRow[];

      function deltaToFinished(tx: TxRow): number {
        if (tx.movement_kind === "metadata") return 0;
        if (tx.movement_kind === "category_move") {
          if (tx.to_field === "warehouse_finished") return tx.quantity;
          if (tx.from_field === "warehouse_finished") return -tx.quantity;
          return 0;
        }
        // movement_kind = 'net_change' — only counts when affecting finished.
        return tx.field_affected === "warehouse_finished" ? tx.quantity : 0;
      }

      // Build the per-day series by walking the timeline. We anchor at
      // "end of today" = current balance, then walk backwards subtracting
      // deltas as we cross each transaction boundary. Days are in UTC
      // to match how the rest of the chart formats dates; this is fine
      // even for users in other timezones because the points are EOD
      // representations, not specific clock moments.
      const out: InventoryFinishedHistoryPoint[] = [];
      const todayUTC = new Date();
      todayUTC.setUTCHours(23, 59, 59, 999);

      let runningBalance = currentFinished;
      let txIdx = 0; // points into txs (newest first)

      for (let d = 0; d < days; d++) {
        const eod = new Date(todayUTC);
        eod.setUTCDate(eod.getUTCDate() - d);
        // Reverse-walk every tx newer than this EOD.
        while (
          txIdx < txs.length &&
          new Date(txs[txIdx].created_at).getTime() > eod.getTime()
        ) {
          runningBalance -= deltaToFinished(txs[txIdx]);
          txIdx++;
        }
        out.push({
          date: eod.toISOString().slice(0, 10),
          finished: Math.max(0, Math.round(runningBalance)),
        });
      }

      // Caller wants oldest-first.
      return out.reverse();
    },
    staleTime: 5 * 60_000,
  });
}
