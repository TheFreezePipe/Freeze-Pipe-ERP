import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { deltaToWarehouseTotal, type LedgerRow } from "@/lib/ledger-sign";
import type { InventoryTransaction, ProductSKU, Profile } from "@/types/database";
import {
  type ChangeLogFilters,
  UUID_RE,
  sanitizeSearch,
  dayStartIso,
  dayEndIso,
  toFilters,
} from "./change-log-query";

export type { ChangeLogFilters } from "./change-log-query";

export type InventoryTransactionWithDetails = InventoryTransaction & {
  product: ProductSKU | null;
  performed_by_profile: Profile | null;
};

/**
 * Inventory-domain side of the Change Log feed.
 *
 * Accepts either a bare row limit (legacy callers) or a ChangeLogFilters
 * object. When filters are supplied they are applied SERVER-SIDE so the
 * Change Log can search the full transaction history — not just the most
 * recent N rows. Free-text search resolves matching SKU ids first (embedded
 * product columns can't be OR-ed with parent columns in one PostgREST call)
 * and then matches notes / type / field / reference on the parent row.
 */
export function useInventoryTransactions(arg: number | ChangeLogFilters = 200) {
  const { dateFrom, dateTo, type, userId, search, limit = 500 } = toFilters(arg);
  return useQuery({
    queryKey: [
      "inventory-transactions",
      { dateFrom, dateTo, type, userId, search, limit },
    ],
    queryFn: async () => {
      const cleaned = search ? sanitizeSearch(search) : "";

      // Resolve SKU/name matches to ids so we can match parent rows by
      // sku_id (capped to keep the generated URL small).
      let skuIds: string[] = [];
      if (cleaned) {
        const { data: skus } = await supabase
          .from("product_skus")
          .select("id")
          .or(`sku.ilike.*${cleaned}*,product_name.ilike.*${cleaned}*`)
          .limit(50);
        skuIds = (skus ?? []).map((s) => (s as { id: string }).id);
      }

      let q = supabase
        .from("inventory_transactions")
        .select("*, product:product_skus(*), performed_by_profile:profiles!performed_by(*)")
        .order("created_at", { ascending: false })
        .limit(limit);

      if (dateFrom) q = q.gte("created_at", dayStartIso(dateFrom));
      if (dateTo) q = q.lte("created_at", dayEndIso(dateTo));
      if (type && type !== "all") q = q.eq("transaction_type", type);
      if (userId === "system") q = q.is("performed_by", null);
      else if (userId && userId !== "all") q = q.eq("performed_by", userId);

      if (cleaned) {
        const orParts = [
          `notes.ilike.*${cleaned}*`,
          `transaction_type.ilike.*${cleaned}*`,
          `field_affected.ilike.*${cleaned}*`,
        ];
        if (skuIds.length) orParts.push(`sku_id.in.(${skuIds.join(",")})`);
        if (UUID_RE.test(cleaned)) orParts.push(`reference_id.eq.${cleaned}`);
        q = q.or(orParts.join(","));
      }

      const { data, error } = await q;
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
 * Where delta(tx) is deltaToWarehouseTotal from @/lib/ledger-sign — the
 * per-movement-kind sign rules (incl. write_off rows, which store positive
 * quantities but mean removal) live there with the Change Log's display
 * sign so the two can never drift apart again.
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
      type TxRow = LedgerRow & { created_at: string };
      const txs = (data ?? []) as unknown as TxRow[];

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
          runningBalance -= deltaToWarehouseTotal(txs[txIdx]);
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
