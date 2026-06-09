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

/** Raw inputs for the throughput-based "days to clear" estimate. */
export interface ClearEstimate {
  /** raw + in-production units in the warehouse now (fillable). */
  unfilled_now: number;
  /** pre-filled units in the warehouse now (need RTS only). */
  prefilled_now: number;
  /** raw fillable units inbound on non-delivered freight. */
  incoming_raw: number;
  /** pre-filled fillable units inbound on non-delivered freight. */
  incoming_prefilled: number;
  /** rtsing (in-production -> finished) units/day, trailing window. */
  rtsing_per_day: number;
  /** prefilled_rtsing (pre-filled -> finished) units/day, trailing window. */
  prefilled_rtsing_per_day: number;
}

/**
 * Inputs for the "days to clear" estimate (rpc_manufacturing_clear_estimate).
 * The modal composes: days = (all on-hand + inbound fillable work to make
 * ready) ÷ (combined rtsing + prefilled_rtsing throughput). Defaults to a
 * trailing 30-day throughput window.
 */
export function useManufacturingClearEstimate(days = 30) {
  return useQuery({
    queryKey: ["mfg-clear-estimate", days],
    queryFn: async (): Promise<ClearEstimate | null> => {
      const { data, error } = await supabase.rpc(
        "rpc_manufacturing_clear_estimate",
        { p_days: days },
      );
      if (error) throw error;
      // deno-lint-ignore no-explicit-any
      const row = (Array.isArray(data) ? data[0] : data) as any;
      if (!row) return null;
      return {
        unfilled_now: row.unfilled_now ?? 0,
        prefilled_now: row.prefilled_now ?? 0,
        incoming_raw: row.incoming_raw ?? 0,
        incoming_prefilled: row.incoming_prefilled ?? 0,
        rtsing_per_day: Number(row.rtsing_per_day ?? 0),
        prefilled_rtsing_per_day: Number(row.prefilled_rtsing_per_day ?? 0),
      };
    },
    staleTime: 5 * 60 * 1000,
  });
}
