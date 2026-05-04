import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import type { Database } from "@/lib/database.types";

/**
 * SKU economics + per-supplier costs + freight-derived prefill stats.
 * Backs the SKU detail page's Raw Cost, Manufacturing Cost, and adjacent
 * sections.
 *
 * Ownership notes:
 *   - `sku_economics` is 1:1 with product_skus and holds editable cost fields
 *     (importing, manufacturing, pack & ship) + the new mfg override / window
 *     columns (migration 028).
 *   - `sku_supplier_costs` is 1:N — one row per (sku, supplier) with one
 *     primary. The primary cost feeds raw-cost rollups; secondary rows are
 *     kept for pricing comparison on SKUs we might dual-source.
 */

// ---- sku_economics ----------------------------------------------------------

// Re-aliased to the generated row type so future column additions (or
// removals) propagate without a hand-editing pass on this file.
// Same pattern as FreightShipment / FreightLineItem in src/types/database.ts.
export type SkuEconomicsRow = Database["public"]["Tables"]["sku_economics"]["Row"];

export function useSkuEconomics(skuId: string | null | undefined) {
  return useQuery({
    queryKey: ["sku-economics", skuId],
    enabled: !!skuId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("sku_economics")
        .select("*")
        .eq("sku_id", skuId!)
        .maybeSingle();
      if (error) throw error;
      return (data ?? null) as unknown as SkuEconomicsRow | null;
    },
    staleTime: 60_000,
  });
}

/**
 * Batch fetch — every sku_economics row, keyed by sku_id. Used by the
 * SKU Economics list page to render Total D2C and Contribution Margin
 * inline without making N per-row queries.
 */
export function useAllSkuEconomics() {
  return useQuery({
    queryKey: ["sku-economics", "all"],
    queryFn: async () => {
      const { data, error } = await supabase.from("sku_economics").select("*");
      if (error) throw error;
      const rows = (data ?? []) as unknown as SkuEconomicsRow[];
      const byId = new Map<string, SkuEconomicsRow>();
      for (const r of rows) byId.set(r.sku_id, r);
      return byId;
    },
    staleTime: 60_000,
  });
}

/**
 * Batch fetch — primary supplier cost per SKU, keyed by sku_id. The
 * `is_primary` flag picks which row's unit_cost feeds into Raw Cost on
 * the SKU economics rollup; many SKUs only have one supplier row, but
 * the dual-source case still needs the primary.
 */
export function useAllPrimarySkuSupplierCosts() {
  return useQuery({
    queryKey: ["sku-supplier-costs", "primary-by-sku"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("sku_supplier_costs")
        .select("*")
        .eq("is_primary", true);
      if (error) throw error;
      const rows = (data ?? []) as unknown as SkuSupplierCostRow[];
      const byId = new Map<string, SkuSupplierCostRow>();
      for (const r of rows) byId.set(r.sku_id, r);
      return byId;
    },
    staleTime: 60_000,
  });
}

export function useUpsertSkuEconomics() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (params: {
      skuId: string;
      updates: Partial<Omit<SkuEconomicsRow, "id" | "sku_id" | "created_at" | "updated_at" | "row_version">>;
    }) => {
      // UPSERT by sku_id so the very first save for a SKU creates the row
      // rather than requiring a separate INSERT step.
      const { error } = await supabase
        .from("sku_economics")
        .upsert({ sku_id: params.skuId, ...params.updates }, { onConflict: "sku_id" });
      if (error) throw error;
    },
    // Invalidate by prefix so BOTH the per-SKU query (`["sku-economics",
    // skuId]`) and the batch query used by the SKU Costs list page
    // (`["sku-economics", "all"]`) refetch. React Query matches by
    // prefix, so a parent key catches every child. Without this the list
    // page stayed stale after a detail-page save — costs lived in the DB
    // but the list still rendered "—".
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["sku-economics"] }),
  });
}

// ---- sku_supplier_costs -----------------------------------------------------

export type SkuSupplierCostRow = Database["public"]["Tables"]["sku_supplier_costs"]["Row"];

export function useSkuSupplierCosts(skuId: string | null | undefined) {
  return useQuery({
    queryKey: ["sku-supplier-costs", skuId],
    enabled: !!skuId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("sku_supplier_costs")
        .select("*")
        .eq("sku_id", skuId!)
        .order("is_primary", { ascending: false })
        .order("created_at", { ascending: true });
      if (error) throw error;
      return (data ?? []) as unknown as SkuSupplierCostRow[];
    },
    staleTime: 60_000,
  });
}

/** Add OR update a per-supplier cost row. Use when the supplier_id is new for
 *  this SKU (insert) or when editing an existing row (update). */
export function useUpsertSkuSupplierCost() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (params: {
      skuId: string;
      supplierId: string;
      unitCost: number;
      notes?: string | null;
    }) => {
      const { error } = await supabase
        .from("sku_supplier_costs")
        .upsert(
          {
            sku_id: params.skuId,
            supplier_id: params.supplierId,
            unit_cost: params.unitCost,
            notes: params.notes ?? null,
          },
          { onConflict: "sku_id,supplier_id" },
        );
      if (error) throw error;
    },
    // Prefix invalidate to refresh BOTH the per-SKU query and the
    // batch (`["sku-supplier-costs", "primary-by-sku"]`) used by the
    // SKU Costs list page's Raw column.
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["sku-supplier-costs"] }),
  });
}

/** Delete a per-supplier cost row. The partial unique index on `is_primary`
 *  means if you delete the current primary you'll need to promote another row
 *  before the next write that requires a primary. */
export function useDeleteSkuSupplierCost() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (params: { id: string; skuId: string }) => {
      const { error } = await supabase
        .from("sku_supplier_costs")
        .delete()
        .eq("id", params.id);
      if (error) throw error;
    },
    // Prefix invalidate to refresh BOTH the per-SKU query and the
    // batch (`["sku-supplier-costs", "primary-by-sku"]`) used by the
    // SKU Costs list page's Raw column.
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["sku-supplier-costs"] }),
  });
}

/**
 * Promote a row to primary. Atomic via two-step update wrapped in a single
 * RPC-less flow: first clear all other rows for this SKU, then set the target
 * row. Supabase doesn't expose transactions on the client, so there's a
 * microsecond window where no primary exists — the partial unique index
 * tolerates that because it's only violated by two TRUE rows, not zero. Good
 * enough for an admin-only, low-concurrency operation.
 */
export function useSetPrimarySkuSupplierCost() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (params: { id: string; skuId: string }) => {
      // 1. Clear any current primary on this SKU.
      const { error: clearErr } = await supabase
        .from("sku_supplier_costs")
        .update({ is_primary: false })
        .eq("sku_id", params.skuId)
        .eq("is_primary", true);
      if (clearErr) throw clearErr;
      // 2. Set the target as primary.
      const { error: setErr } = await supabase
        .from("sku_supplier_costs")
        .update({ is_primary: true })
        .eq("id", params.id);
      if (setErr) throw setErr;
    },
    // Prefix invalidate to refresh BOTH the per-SKU query and the
    // batch (`["sku-supplier-costs", "primary-by-sku"]`) used by the
    // SKU Costs list page's Raw column.
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["sku-supplier-costs"] }),
  });
}

// ---- Freight-derived prefill stats -----------------------------------------

export interface SkuPrefillStats {
  /** Total declared units across tracked lines in the window. */
  totalUnits: number;
  /** Units flagged as prefilled (sum of quantity_prefilled). */
  prefilledUnits: number;
  /** 0-1 fraction; null when totalUnits < noise floor (arbitrary minimum). */
  pctPrefilled: number | null;
  /** Count of distinct arrived shipments contributing to the ratio. */
  shipmentCount: number;
}

/**
 * Prefill ratio for a SKU derived from freight arrivals in the last
 * `windowDays` days. "Arrived" = freight_shipments.actual_arrival_date is
 * set and within the window. Rows where quantity_prefilled is NULL (pre-
 * migration 027 or simply untracked) are excluded — not rolled in as
 * unfilled — so the ratio represents only signal we actually have.
 */
export function useSkuPrefillStats(
  skuId: string | null | undefined,
  windowDays: number,
) {
  return useQuery({
    queryKey: ["sku-prefill-stats", skuId, windowDays],
    enabled: !!skuId,
    queryFn: async (): Promise<SkuPrefillStats> => {
      const cutoffIso = new Date(Date.now() - windowDays * 86400_000)
        .toISOString()
        .slice(0, 10);

      // Pull tracked lines for this SKU joined to shipments so we can filter
      // by actual_arrival_date. Only `arrived` shipments (actual_arrival_date
      // set and in window) and only rows with quantity_prefilled tracked.
      const { data, error } = await supabase
        .from("freight_line_items")
        .select(
          "quantity, quantity_prefilled, freight_shipment_id, freight_shipments!inner(actual_arrival_date)",
        )
        .eq("sku_id", skuId!)
        .not("quantity_prefilled", "is", null)
        .gte("freight_shipments.actual_arrival_date", cutoffIso);
      if (error) throw error;

      type Row = {
        quantity: number;
        quantity_prefilled: number | null;
        freight_shipment_id: string;
      };
      const rows = (data ?? []) as unknown as Row[];
      let totalUnits = 0;
      let prefilledUnits = 0;
      const shipmentIds = new Set<string>();
      for (const r of rows) {
        totalUnits += r.quantity;
        prefilledUnits += r.quantity_prefilled ?? 0;
        shipmentIds.add(r.freight_shipment_id);
      }
      // Noise floor: require at least 50 units in the window before the
      // ratio is meaningful. Below that, show "—" and explain why.
      const SAMPLE_FLOOR = 50;
      return {
        totalUnits,
        prefilledUnits,
        pctPrefilled:
          totalUnits >= SAMPLE_FLOOR ? prefilledUnits / totalUnits : null,
        shipmentCount: shipmentIds.size,
      };
    },
    staleTime: 2 * 60_000,
  });
}
