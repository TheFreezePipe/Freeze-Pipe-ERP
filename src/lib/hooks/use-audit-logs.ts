import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import type { Profile } from "@/types/database";
import {
  type ChangeLogFilters,
  UUID_RE,
  sanitizeSearch,
  dayStartIso,
  dayEndIso,
  toFilters,
} from "./change-log-query";

/**
 * One row from the `audit_logs` table plus the joined actor profile. Admin-
 * visible under the `internal_select_audit_logs` RLS policy; suppliers only
 * see their own actions via `supplier_select_own_audit_logs`.
 *
 * Used by the admin Change Log page, which merges these with the older
 * `inventory_transactions` stream to form one unified activity timeline.
 * Supplier-side workflow actions (factory order create/advance/cancel,
 * freight shipment create/update, breakage reports, etc.) only live here —
 * the inventory_transactions table doesn't see them.
 */
export interface AuditLogEntry {
  id: string;
  actor_id: string | null;
  action: string;
  target_table: string;
  target_id: string;
  details: Record<string, unknown> | null;
  created_at: string;
  actor_profile: Profile | null;
}

/**
 * Workflow side of the Change Log feed (supplier portal actions, freight
 * shipment + factory order lifecycle, breakage/variance acknowledgements).
 *
 * Like useInventoryTransactions, accepts a bare limit (legacy) or a
 * ChangeLogFilters object whose date / type / user / search filters are
 * applied server-side so the full audit history is searchable. The shared
 * `type` value maps to audit_logs.action; selecting an inventory-only type
 * simply yields no audit rows (and vice-versa), which is the intended
 * behavior for the unified feed.
 */
export function useAuditLogs(arg: number | ChangeLogFilters = 500) {
  const { dateFrom, dateTo, type, userId, search, limit = 500 } = toFilters(arg);
  return useQuery({
    queryKey: ["audit-logs", { dateFrom, dateTo, type, userId, search, limit }],
    queryFn: async () => {
      const cleaned = search ? sanitizeSearch(search) : "";

      let q = supabase
        .from("audit_logs")
        .select("*, actor_profile:profiles!actor_id(*)")
        .order("created_at", { ascending: false })
        .limit(limit);

      if (dateFrom) q = q.gte("created_at", dayStartIso(dateFrom));
      if (dateTo) q = q.lte("created_at", dayEndIso(dateTo));
      if (type && type !== "all") q = q.eq("action", type);
      if (userId === "system") q = q.is("actor_id", null);
      else if (userId && userId !== "all") q = q.eq("actor_id", userId);

      if (cleaned) {
        const orParts = [
          `action.ilike.*${cleaned}*`,
          `target_table.ilike.*${cleaned}*`,
        ];
        if (UUID_RE.test(cleaned)) orParts.push(`target_id.eq.${cleaned}`);
        q = q.or(orParts.join(","));
      }

      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as unknown as AuditLogEntry[];
    },
    staleTime: 60 * 1000,
  });
}
