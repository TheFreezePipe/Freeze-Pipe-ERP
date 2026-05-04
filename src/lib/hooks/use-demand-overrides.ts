import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";

/**
 * Demand overrides live in the `demand_overrides` table (migration 012).
 * Keeps the baseline `product_skus.monthly_demand` (from ShipStation) intact
 * while allowing admins/managers to set a manual override that flows into
 * DOS calculations.
 */
export interface DemandOverride {
  id: string;
  sku_id: string;
  monthly_demand: number;
  reason: string | null;
  overridden_by: string | null;
  created_at: string;
  updated_at: string;
}

export function useDemandOverrides() {
  return useQuery({
    queryKey: ["demand-overrides"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("demand_overrides")
        .select("*");
      if (error) throw error;
      return data as DemandOverride[];
    },
    staleTime: 5 * 60 * 1000,
  });
}

export function useDemandOverride(skuId: string) {
  return useQuery({
    queryKey: ["demand-overrides", skuId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("demand_overrides")
        .select("*")
        .eq("sku_id", skuId)
        .maybeSingle();
      if (error) throw error;
      return data as DemandOverride | null;
    },
    enabled: !!skuId,
  });
}

/**
 * Upsert a demand override. Pass `monthlyDemand = null` to clear the override
 * (deletes the row). Writes an audit entry so the Change Log reflects who
 * changed what.
 */
export function useSetDemandOverride() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (params: {
      skuId: string;
      monthlyDemand: number | null;
      reason?: string | null;
      actorId: string;
    }) => {
      const { skuId, monthlyDemand, reason, actorId } = params;

      // Look up previous value so the audit entry is useful.
      const { data: previous } = await supabase
        .from("demand_overrides")
        .select("monthly_demand")
        .eq("sku_id", skuId)
        .maybeSingle();
      const previousValue = (previous as { monthly_demand: number } | null)?.monthly_demand ?? null;

      if (monthlyDemand === null) {
        // Clear: delete the row
        const { error } = await supabase
          .from("demand_overrides")
          .delete()
          .eq("sku_id", skuId);
        if (error) throw error;
      } else {
        // Upsert
        const { error } = await supabase
          .from("demand_overrides")
          .upsert({
            sku_id: skuId,
            monthly_demand: monthlyDemand,
            reason: reason ?? null,
            overridden_by: actorId,
          }, { onConflict: "sku_id" });
        if (error) throw error;
      }

      // Audit entry — metadata kind; no inventory impact
      const prevStr = previousValue !== null ? `${previousValue}/mo` : "unset";
      const nextStr = monthlyDemand !== null ? `${monthlyDemand}/mo` : "cleared";
      const { error: auditErr } = await supabase
        .from("inventory_transactions")
        .insert({
          sku_id: skuId,
          transaction_type: "sku_demand_override",
          quantity: 0,
          field_affected: "demand_override",
          movement_kind: "metadata",
          reference_id: skuId,
          reference_type: "product_sku",
          notes: `Demand override ${prevStr} → ${nextStr}${reason ? ` (${reason})` : ""}`,
          performed_by: actorId,
        });
      if (auditErr) throw auditErr;

      return { ok: true, previousValue, newValue: monthlyDemand };
    },
    onSuccess: (_data, { skuId }) => {
      qc.invalidateQueries({ queryKey: ["demand-overrides"] });
      qc.invalidateQueries({ queryKey: ["demand-overrides", skuId] });
      qc.invalidateQueries({ queryKey: ["inventory-transactions"] });
    },
  });
}
