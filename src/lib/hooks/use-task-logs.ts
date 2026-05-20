import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import type { TaskLog, ProductSKU, Profile } from "@/types/database";

export type TaskLogWithDetails = TaskLog & {
  product: ProductSKU;
  employee: Pick<Profile, "id" | "full_name" | "email">;
};

export function useTaskLogs(limit = 20000) {
  return useQuery({
    queryKey: ["task-logs", limit],
    queryFn: async () => {
      // Order by time_completed (when the work was actually done) rather
      // than created_at (when the DB row was inserted). This matters
      // most for back-filled historical data: an import lands all rows
      // with the same created_at but each row carries its real
      // time_completed from the source system, so created_at sort
      // would lump the entire import together at "import day" while
      // time_completed sort preserves the actual chronology. Falls
      // back to created_at when time_completed is null (rare; would
      // mean an in-progress task that never finished).
      //
      // PAGINATION: Supabase's PostgREST has a server-side
      // `db.max-rows = 1000` cap that silently truncates any single
      // response. Asking for `limit(5000)` returns 1000 rows and the
      // operator never knows. We page through with .range() until we
      // either fill the requested limit or exhaust the table, then
      // concat. PAGE_SIZE = 1000 matches the server cap so we never
      // make a wasted request asking for more than will arrive.
      const PAGE_SIZE = 1000;
      const all: TaskLogWithDetails[] = [];
      for (let offset = 0; offset < limit; offset += PAGE_SIZE) {
        const upper = Math.min(offset + PAGE_SIZE - 1, limit - 1);
        const { data, error } = await supabase
          .from("task_logs")
          .select("*, product:product_skus(*), employee:profiles(id, full_name, email)")
          .order("time_completed", { ascending: false, nullsFirst: false })
          .range(offset, upper);
        if (error) throw error;
        const chunk = (data ?? []) as TaskLogWithDetails[];
        all.push(...chunk);
        // Short chunk -> end of table, no need to ask for more.
        if (chunk.length < (upper - offset + 1)) break;
      }
      return all;
    },
    staleTime: 60 * 1000,
  });
}

/**
 * Log a completed manufacturing task via the atomic RPC.
 *
 * The RPC in migration 010 (`rpc_log_task_completion`) wraps three operations
 * in one transaction:
 *   1. Insert the task_log row.
 *   2. Move units between inventory buckets based on task_type.
 *   3. Insert an inventory_transactions audit entry.
 *
 * Never insert directly into task_logs — the inventory shift and audit entry
 * must stay atomic with the task log, which only the RPC guarantees.
 */
export function useLogTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (params: {
      skuId: string;
      taskType: "emptying" | "filling_capping" | "rtsing" | "prefilled_rtsing" | "breakage";
      quantity: number;
      notes?: string | null;
      actorId: string;
      timeStarted?: string | null;
      timeCompleted?: string | null;
    }) => {
      const { data, error } = await supabase.rpc("rpc_log_task_completion", {
        p_sku_id: params.skuId,
        p_task_type: params.taskType,
        p_quantity: params.quantity,
        // SQL args default to NULL; generated types don't preserve DEFAULT NULL.
        p_notes: (params.notes ?? null) as string,
        p_actor_id: params.actorId,
        p_time_started: (params.timeStarted ?? null) as string,
        p_time_completed: params.timeCompleted ?? new Date().toISOString(),
      });
      if (error) {
        // Supabase returns PostgrestError — a plain object, not an Error.
        // Throwing it bare means `err instanceof Error` checks downstream
        // fail and callers show a generic fallback message. Wrap it so the
        // real message (and code/details, when present) actually surfaces.
        const parts = [error.message, error.code, error.details, error.hint]
          .filter((p) => p && String(p).trim().length > 0);
        throw new Error(parts.join(" · ") || "RPC rpc_log_task_completion failed");
      }
      const result = data as {
        ok: boolean;
        error?: string;
        task_log_id?: string;
        available?: number;
        requested?: number;
      };
      if (!result.ok) {
        // Enrich the envelope error with supplementary fields so "insufficient
        // source stock" reports the actual numbers rather than just the code.
        const extras: string[] = [];
        if (typeof result.available === "number") extras.push(`available ${result.available}`);
        if (typeof result.requested === "number") extras.push(`requested ${result.requested}`);
        const base = result.error ?? "Task log failed";
        throw new Error(extras.length > 0 ? `${base} (${extras.join(", ")})` : base);
      }
      return result;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["task-logs"] });
      qc.invalidateQueries({ queryKey: ["inventory"] });
      qc.invalidateQueries({ queryKey: ["inventory-transactions"] });
    },
  });
}
