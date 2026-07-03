import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";

/**
 * Demand overrides live in the `demand_overrides` table (migration 012;
 * `mode` column added 2026-07-03). Keeps the baseline
 * `product_skus.monthly_demand` (from ShipStation) intact while letting
 * admins/managers PIN which number drives a SKU's demand:
 *   (no row)   auto     — forecast when trusted (>=60/mo), else trailing-30d
 *   'trailing' pin the ShipStation trailing-30d baseline
 *   'forecast' pin the engine forecast, even below the trust gate
 *   'manual'   pin an operator-entered number (monthly_demand)
 * The pin flows through buildEffectiveDemandMap into every demand consumer.
 */
export type DemandSourceMode = "manual" | "trailing" | "forecast";

export interface DemandOverride {
  id: string;
  sku_id: string;
  /** Only meaningful when mode === 'manual'; null otherwise. */
  monthly_demand: number | null;
  mode: DemandSourceMode;
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
 * Set the demand source pin for a SKU. `mode: "auto"` deletes the row
 * (back to the automatic chain); 'manual' requires `monthlyDemand`;
 * 'trailing' / 'forecast' pin those sources (monthly_demand stored null).
 * Writes an audit entry so the Change Log reflects who changed what.
 */
export function useSetDemandOverride() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (params: {
      skuId: string;
      mode: DemandSourceMode | "auto";
      monthlyDemand?: number | null;
      reason?: string | null;
      actorId: string;
    }) => {
      const { skuId, mode, monthlyDemand, reason, actorId } = params;
      if (mode === "manual" && (monthlyDemand == null || monthlyDemand < 0)) {
        throw new Error("A non-negative number is required for a manual demand pin");
      }

      // Look up previous state so the audit entry is useful.
      const { data: previous } = await supabase
        .from("demand_overrides")
        .select("monthly_demand, mode")
        .eq("sku_id", skuId)
        .maybeSingle();
      const prev = previous as { monthly_demand: number | null; mode: DemandSourceMode } | null;
      const previousValue = prev?.monthly_demand ?? null;

      if (mode === "auto") {
        // Clear: delete the row
        const { error } = await supabase
          .from("demand_overrides")
          .delete()
          .eq("sku_id", skuId);
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from("demand_overrides")
          .upsert({
            sku_id: skuId,
            mode,
            monthly_demand: mode === "manual" ? monthlyDemand : null,
            reason: reason ?? null,
            overridden_by: actorId,
          }, { onConflict: "sku_id" });
        if (error) throw error;
      }

      // Audit entry — metadata kind; no inventory impact
      const describe = (m: DemandSourceMode | "auto" | undefined, v: number | null) =>
        m === undefined || m === "auto" ? "auto"
        : m === "manual" ? `manual ${v ?? "?"}/mo`
        : m;
      const prevStr = describe(prev?.mode, previousValue);
      const nextStr = describe(mode, monthlyDemand ?? null);
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

      return { ok: true, previousValue, newValue: monthlyDemand ?? null };
    },
    onSuccess: (_data, { skuId }) => {
      qc.invalidateQueries({ queryKey: ["demand-overrides"] });
      qc.invalidateQueries({ queryKey: ["demand-overrides", skuId] });
      qc.invalidateQueries({ queryKey: ["inventory-transactions"] });
    },
  });
}
