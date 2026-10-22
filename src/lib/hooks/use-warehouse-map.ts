import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import type { Json } from "@/lib/database.types";
import { whRpc, type WhRpcResult } from "./use-warehouse";
import { saveWhLayout } from "./use-warehouse-layout";

/**
 * Stock map hooks (design §9.3 FloorPlan, LocationDrawer, LayoutEditor,
 * WhFind; §9.4): ad hoc counts from the drawer, the fixture "blocked"
 * toggle, a layout save that keeps every problem the RPC reports, and the
 * SKU index Find and the heat mode read. Mutations are plain functions that
 * take an optional client (exported for tests) plus a hook that
 * invalidates the roots they change.
 */

// ---- Count now ------------------------------------------------------------------

export type WhCountKind = "scheduled" | "pick_triggered" | "reconcile" | "variance_recount" | "ad_hoc";

export interface WhCreateCount {
  locationIds: string[];
  kind?: WhCountKind;
  reason?: string | null;
}

/** Ad hoc count tasks (admin, manager): {created, existing, missing} task and location ids. */
export function createWhCount(params: WhCreateCount, client?: unknown) {
  return whRpc(
    "rpc_wh_create_count",
    { p_location_ids: params.locationIds, p_kind: params.kind ?? "ad_hoc", p_reason: params.reason ?? null },
    "Couldn't create the count",
    client,
  );
}

export function useWhCreateCount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params: WhCreateCount) => createWhCount(params),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["wh-counts"] });
      qc.invalidateQueries({ queryKey: ["wh-overview"] });
    },
  });
}

// ---- Layout save with every problem ---------------------------------------------

export interface WhLayoutProblem {
  row: string;
  error: string;
  message: string;
}

/** rpc_wh_save_layout said no: nothing was saved; `problems` lists every row it refused. */
export class WhLayoutRejectedError extends Error {
  problems: WhLayoutProblem[];
  code: string;

  constructor(message: string, code: string, problems: WhLayoutProblem[]) {
    super(message);
    this.name = "WhLayoutRejectedError";
    this.code = code;
    this.problems = problems;
  }
}

type RpcClient = { rpc: (fn: string, args?: object) => PromiseLike<{ data: unknown; error: unknown }> };

/**
 * rpc_wh_save_layout for the editor: like saveWhLayout, but a rejection keeps
 * the RPC's `problems` array (stale rows, unknown templates, check
 * violations) instead of only its first message.
 */
export async function saveWhLayoutChecked(payload: Json, client: unknown = supabase): Promise<WhRpcResult<"rpc_wh_save_layout">> {
  const { data, error } = await (client as RpcClient).rpc("rpc_wh_save_layout", { p_payload: payload });
  if (error) throw error;
  const env = data as ({ ok?: boolean; error?: string; message?: string; problems?: WhLayoutProblem[] } & Record<string, unknown>) | null;
  if (!env?.ok) {
    throw new WhLayoutRejectedError(env?.message ?? env?.error ?? "Couldn't save the layout", env?.error ?? "unknown", env?.problems ?? []);
  }
  return env as unknown as WhRpcResult<"rpc_wh_save_layout">;
}

export function useWhSaveLayoutChecked() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: Json) => saveWhLayoutChecked(payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["wh-layout"] });
      qc.invalidateQueries({ queryKey: ["wh-overview"] });
    },
  });
}

// ---- Fixture blocked flag ---------------------------------------------------------

export interface WhFixtureBlocked {
  id: string;
  blocked: boolean;
  /** The fixture's row_version as loaded; a newer one makes the save stale. */
  rowVersion?: number;
}

/** Toggle a fixture's `blocked` flag (the gaylord overflow spot) through rpc_wh_save_layout (admin). */
export function setWhFixtureBlocked(params: WhFixtureBlocked, client?: unknown) {
  const row: Record<string, unknown> = { id: params.id, blocked: params.blocked };
  if (params.rowVersion != null) row.row_version = params.rowVersion;
  return saveWhLayout({ fixtures: [row] } as unknown as Json, client);
}

export function useWhFixtureBlocked() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params: WhFixtureBlocked) => setWhFixtureBlocked(params),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["wh-layout"] });
    },
  });
}

// ---- SKU index (Find, heat) ---------------------------------------------------------

export interface WhSkuIndexRow {
  id: string;
  sku: string;
  product_name: string;
  is_active: boolean | null;
  abc_classification: string | null;
  monthly_demand: number | null;
  display_category: string;
  upc_code: string | null;
}

/** Every SKU with the few columns Find and the heat map need. */
export function useWhSkuIndex() {
  return useQuery({
    queryKey: ["wh-sku-index"],
    queryFn: async (): Promise<WhSkuIndexRow[]> => {
      const { data, error } = await supabase
        .from("product_skus")
        .select("id, sku, product_name, is_active, abc_classification, monthly_demand, display_category, upc_code")
        .order("sku");
      if (error) throw error;
      return (data ?? []) as WhSkuIndexRow[];
    },
    staleTime: 5 * 60 * 1000,
  });
}
