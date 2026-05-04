import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import type { Profile } from "@/types/database";

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

export function useAuditLogs(limit = 500) {
  return useQuery({
    queryKey: ["audit-logs", limit],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("audit_logs")
        .select("*, actor_profile:profiles!actor_id(*)")
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) throw error;
      return (data ?? []) as unknown as AuditLogEntry[];
    },
    staleTime: 60 * 1000,
  });
}
