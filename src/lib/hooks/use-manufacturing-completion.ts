import { useQuery } from "@tanstack/react-query";
import { supabase as typedSupabase } from "@/lib/supabase";

// rpc_manufacturing_completion_history isn't in the generated DB types yet
// (added 20260609000002). Cast like the other not-yet-regenerated RPCs.
// deno-lint-ignore no-explicit-any
const supabase = typedSupabase as unknown as any;

export interface CompletionHistoryPoint {
  /** yyyy-mm-dd, end-of-day. */
  day: string;
  complete_units: number;
  unfilled_units: number;
  /** Derived completion percentage (0-100). */
  pct: number;
}

/**
 * Daily manufacturing-completion history for fillable SKUs, reconstructed
 * server-side from the inventory_transactions ledger
 * (rpc_manufacturing_completion_history). Powers the over-time graph in the
 * dashboard's Manufacturing Completion drill-down.
 */
export function useManufacturingCompletionHistory(days: number) {
  return useQuery({
    queryKey: ["mfg-completion-history", days],
    queryFn: async (): Promise<CompletionHistoryPoint[]> => {
      const { data, error } = await supabase.rpc(
        "rpc_manufacturing_completion_history",
        { p_days: days },
      );
      if (error) throw error;
      // deno-lint-ignore no-explicit-any
      return ((data ?? []) as any[]).map((r) => {
        const complete = r.complete_units ?? 0;
        const unfilled = r.unfilled_units ?? 0;
        const total = complete + unfilled;
        return {
          day: r.day as string,
          complete_units: complete,
          unfilled_units: unfilled,
          pct: total > 0 ? (complete / total) * 100 : 0,
        };
      });
    },
    staleTime: 5 * 60 * 1000,
  });
}
