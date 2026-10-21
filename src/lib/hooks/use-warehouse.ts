import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { APP_ENV } from "@/lib/env";
import type { Json } from "@/lib/database.types";
import { effectiveOutboundMode, type OutboundMode } from "@/lib/warehouse/outbound";
import { baselineWindow } from "@/lib/warehouse/baseline";

/**
 * Warehouse module, Phase 0 hooks. Every call is a SECURITY DEFINER RPC
 * returning the { ok, error?, ... } envelope; ok=false throws the server's
 * human-readable error, which the UI shows verbatim.
 */

// ---- RPC contracts ----------------------------------------------------------
// database.types.ts is regenerated after the warehouse migrations land. Until
// then these RPCs are typed here and the single cast lives in whRpc().

export interface WhSettings {
  outbound?: { mode?: OutboundMode };
  [key: string]: unknown;
}

export interface WhScanMatch {
  sku_id: string;
  sku: string;
  product_name: string;
  /** Matched barcode; null when the scan matched a SKU code directly. */
  code: string | null;
  symbology: string | null;
  display_category?: string | null;
  is_active?: boolean;
}

export interface WhResolveScanResult {
  /** Server's reading: "gtin" when the scan had a barcode shape, else "sku". */
  kind?: string;
  match: WhScanMatch | null;
  candidates: string[];
}

export interface WhBarcodeCoverage {
  with_code: number;
  active_total: number;
}

export interface WhBaselineDay {
  ship_day: string;
  orders: number;
  lines: number;
  median_days_to_ship: number | null;
  same_day_share: number | null;
}

export interface WhBaselineKpis {
  days: WhBaselineDay[];
  summary: {
    median_orders_per_day: number | null;
    median_days_to_ship: number | null;
    same_day_share: number | null;
  };
}

interface WhEnvelope {
  ok: boolean;
  error?: string;
  message?: string;
}

interface WhRpc {
  rpc_wh_get_settings: { args: Record<string, never>; result: { settings: WhSettings } };
  rpc_wh_set_setting: { args: { p_key: string; p_value: Json }; result: { key: string; value: Json } };
  rpc_wh_resolve_scan: { args: { p_scan: string }; result: WhResolveScanResult };
  rpc_wh_link_barcode: { args: { p_sku_id: string; p_scan: string }; result: { code: string; symbology: string } };
  rpc_wh_barcode_coverage: { args: Record<string, never>; result: WhBarcodeCoverage };
  rpc_wh_baseline_kpis: { args: { p_from: string; p_to: string }; result: WhBaselineKpis };
}

type UntypedRpcClient = {
  rpc: (fn: string, args?: object) => PromiseLike<{ data: unknown; error: unknown }>;
};

/** Call a warehouse RPC and unwrap its envelope. Exported for tests. */
export async function whRpc<K extends keyof WhRpc>(
  name: K,
  args: WhRpc[K]["args"],
  fallbackError: string,
  client: unknown = supabase,
): Promise<WhRpc[K]["result"]> {
  const { data, error } = await (client as UntypedRpcClient).rpc(name, args);
  if (error) throw error;
  const env = data as (WhEnvelope & WhRpc[K]["result"]) | null;
  if (!env?.ok) throw new Error(env?.error ?? env?.message ?? fallbackError);
  return env;
}

// ---- Settings + outbound guard ---------------------------------------------

export function useWarehouseSettings() {
  return useQuery({
    queryKey: ["wh-settings"],
    queryFn: async (): Promise<WhSettings> => {
      const result = await whRpc("rpc_wh_get_settings", {}, "Couldn't load warehouse settings");
      return result.settings ?? {};
    },
    staleTime: 5 * 60 * 1000,
  });
}

/** Effective outbound mode: never "live" off production; "blocked" until known. */
export function useOutboundMode(): OutboundMode {
  const { data } = useWarehouseSettings();
  return effectiveOutboundMode(data?.outbound?.mode, APP_ENV);
}

export function useSetWarehouseSetting() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (params: { key: string; value: Json }) =>
      whRpc("rpc_wh_set_setting", { p_key: params.key, p_value: params.value }, "Couldn't save the setting"),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["wh-settings"] });
    },
  });
}

// ---- Barcodes ---------------------------------------------------------------

export function useResolveScan() {
  return useMutation({
    mutationFn: async (scan: string): Promise<WhResolveScanResult> => {
      const result = await whRpc("rpc_wh_resolve_scan", { p_scan: scan }, "Couldn't look up that code");
      return { kind: result.kind, match: result.match ?? null, candidates: result.candidates ?? [] };
    },
  });
}

export function useLinkBarcode() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (params: { skuId: string; scan: string }) =>
      whRpc("rpc_wh_link_barcode", { p_sku_id: params.skuId, p_scan: params.scan }, "Couldn't link the barcode"),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["wh-barcode-coverage"] });
      qc.invalidateQueries({ queryKey: ["sku-barcodes"] });
      // product_skus.upc_code carries the primary GTIN for display.
      qc.invalidateQueries({ queryKey: ["products"] });
    },
  });
}

export function useBarcodeCoverage() {
  return useQuery({
    queryKey: ["wh-barcode-coverage"],
    queryFn: async (): Promise<WhBarcodeCoverage> => {
      const result = await whRpc("rpc_wh_barcode_coverage", {}, "Couldn't load barcode coverage");
      return { with_code: result.with_code ?? 0, active_total: result.active_total ?? 0 };
    },
    staleTime: 5 * 60 * 1000,
  });
}

// ---- Baseline KPIs ----------------------------------------------------------

/** Ship-day KPIs over the last `days` complete days (ET), ending yesterday. */
export function useBaselineKpis(days = 14) {
  return useQuery({
    queryKey: ["wh-baseline-kpis", days],
    queryFn: async (): Promise<WhBaselineKpis> => {
      const { from, to } = baselineWindow(days);
      const result = await whRpc("rpc_wh_baseline_kpis", { p_from: from, p_to: to }, "Couldn't load baseline KPIs");
      return {
        days: result.days ?? [],
        summary: result.summary ?? {
          median_orders_per_day: null,
          median_days_to_ship: null,
          same_day_share: null,
        },
      };
    },
    staleTime: 10 * 60 * 1000,
  });
}
