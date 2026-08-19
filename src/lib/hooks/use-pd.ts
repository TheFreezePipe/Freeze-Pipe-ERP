/**
 * Product Development board — data hooks. Reads are plain selects; stage
 * decisions go through the admin-checked RPCs (rpc_pd_move / kill / archive /
 * link / promote). Hooks throw raw errors; callers format with describeError.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import type { Database } from "@/lib/database.types";

type Tables = Database["public"]["Tables"];
export type PdProject = Tables["mkt_pd_projects"]["Row"];
export type PdProjectUpdate = Tables["mkt_pd_projects"]["Update"];
export type PdStageEvent = Tables["mkt_pd_stage_events"]["Row"];
export type PdNote = Tables["mkt_pd_notes"]["Row"];
export type PdStageConfig = Tables["mkt_pd_stage_config"]["Row"];

export type PdProjectWithRefs = PdProject & {
  owner: { id: string; full_name: string | null } | null;
  supplier: { id: string; name: string; code: string } | null;
  linked_sku: { id: string; sku: string; product_name: string } | null;
  comparable_sku: { id: string; sku: string; product_name: string } | null;
};

const PROJECT_SELECT =
  "*, owner:profiles!mkt_pd_projects_owner_id_fkey(id, full_name), " +
  "supplier:suppliers!mkt_pd_projects_supplier_id_fkey(id, name, code), " +
  "linked_sku:product_skus!mkt_pd_projects_linked_sku_id_fkey(id, sku, product_name), " +
  "comparable_sku:product_skus!mkt_pd_projects_comparable_sku_id_fkey(id, sku, product_name)";

const KEYS = {
  board: ["pd-board"] as const,
  project: (id: string) => ["pd-project", id] as const,
  events: (id: string) => ["pd-events", id] as const,
  notes: (id: string) => ["pd-notes", id] as const,
  config: ["pd-stage-config"] as const,
};

export function usePdBoard() {
  return useQuery({
    queryKey: KEYS.board,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("mkt_pd_projects")
        .select(PROJECT_SELECT)
        .is("archived_at", null)
        .order("stage", { ascending: true })
        .order("sort_index", { ascending: true })
        .order("created_at", { ascending: true });
      if (error) throw error;
      return (data ?? []) as unknown as PdProjectWithRefs[];
    },
    staleTime: 60_000,
  });
}

export function usePdStageConfig() {
  return useQuery({
    queryKey: KEYS.config,
    queryFn: async () => {
      const { data, error } = await supabase.from("mkt_pd_stage_config").select("*").order("sort_order");
      if (error) throw error;
      return (data ?? []) as PdStageConfig[];
    },
    staleTime: 10 * 60_000,
  });
}

export function usePdProjectEvents(projectId: string | null) {
  return useQuery({
    queryKey: KEYS.events(projectId ?? "none"),
    enabled: !!projectId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("mkt_pd_stage_events")
        .select("*, decider:profiles!mkt_pd_stage_events_decided_by_fkey(full_name)")
        .eq("project_id", projectId!)
        .order("decided_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as (PdStageEvent & { decider: { full_name: string | null } | null })[];
    },
  });
}

export function usePdProjectNotes(projectId: string | null) {
  return useQuery({
    queryKey: KEYS.notes(projectId ?? "none"),
    enabled: !!projectId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("mkt_pd_notes")
        .select("*, author:profiles!mkt_pd_notes_created_by_fkey(full_name)")
        .eq("project_id", projectId!)
        .order("occurred_on", { ascending: false })
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as (PdNote & { author: { full_name: string | null } | null })[];
    },
  });
}

function useInvalidateBoard() {
  const qc = useQueryClient();
  return (projectId?: string) => {
    qc.invalidateQueries({ queryKey: KEYS.board });
    if (projectId) {
      qc.invalidateQueries({ queryKey: KEYS.events(projectId) });
      qc.invalidateQueries({ queryKey: KEYS.notes(projectId) });
    }
  };
}

/** "+ New idea": name only, lands in Good Ideas (owner decision). */
export function useCreatePdProject() {
  const invalidate = useInvalidateBoard();
  return useMutation({
    mutationFn: async (params: { name: string; ownerId: string | null }) => {
      const { data, error } = await supabase
        .from("mkt_pd_projects")
        .insert({ name: params.name.trim(), owner_id: params.ownerId, created_by: params.ownerId, stage: "good_ideas" })
        .select("id")
        .single();
      if (error) throw error;
      return data as { id: string };
    },
    onSuccess: () => invalidate(),
  });
}

/** Click-to-edit: one field at a time. Internal users may edit fields. */
export function useUpdatePdProject() {
  const invalidate = useInvalidateBoard();
  return useMutation({
    mutationFn: async (params: { id: string; patch: PdProjectUpdate }) => {
      const { error } = await supabase.from("mkt_pd_projects").update(params.patch).eq("id", params.id);
      if (error) throw error;
    },
    onSuccess: (_d, v) => invalidate(v.id),
  });
}

type RpcResult = { ok: boolean; error?: string; missing?: string[]; outcome?: string; sku_id?: string };

function assertOk(res: RpcResult, fallback: string): RpcResult {
  if (!res.ok) {
    const err = new Error(res.error ?? fallback) as Error & { missing?: string[] };
    err.missing = res.missing;
    throw err;
  }
  return res;
}

export function useMovePdProject() {
  const invalidate = useInvalidateBoard();
  return useMutation({
    mutationFn: async (params: { id: string; to: string; reason?: string }) => {
      const { data, error } = await supabase.rpc("rpc_pd_move", {
        p_project_id: params.id,
        p_to_stage: params.to,
        p_reason: (params.reason ?? null) as string,
        p_override: null as unknown as never,
      });
      if (error) throw error;
      return assertOk(data as RpcResult, "move failed");
    },
    onSuccess: (_d, v) => invalidate(v.id),
  });
}

export function useKillPdProject() {
  const invalidate = useInvalidateBoard();
  return useMutation({
    mutationFn: async (params: { id: string; reason: string }) => {
      const { data, error } = await supabase.rpc("rpc_pd_kill", { p_project_id: params.id, p_reason: params.reason });
      if (error) throw error;
      return assertOk(data as RpcResult, "kill failed");
    },
    onSuccess: (_d, v) => invalidate(v.id),
  });
}

export function useArchivePdProject() {
  const invalidate = useInvalidateBoard();
  return useMutation({
    mutationFn: async (params: { id: string; reason: string }) => {
      const { data, error } = await supabase.rpc("rpc_pd_archive", { p_project_id: params.id, p_reason: params.reason });
      if (error) throw error;
      return assertOk(data as RpcResult, "archive failed");
    },
    onSuccess: (_d, v) => invalidate(v.id),
  });
}

export function useReorderPdProject() {
  const invalidate = useInvalidateBoard();
  return useMutation({
    mutationFn: async (params: { id: string; sortIndex: number }) => {
      const { error } = await supabase.rpc("rpc_pd_reorder", { p_project_id: params.id, p_sort_index: params.sortIndex });
      if (error) throw error;
    },
    onSuccess: () => invalidate(),
  });
}

/** Phase 1 Ordered: link an existing factory order (detection trigger arrives in Phase 3). */
export function useLinkPdFactoryOrder() {
  const invalidate = useInvalidateBoard();
  return useMutation({
    mutationFn: async (params: { id: string; factoryOrderId: string }) => {
      const { data, error } = await supabase.rpc("rpc_pd_link_factory_order", {
        p_project_id: params.id,
        p_factory_order_id: params.factoryOrderId,
      });
      if (error) throw error;
      return assertOk(data as RpcResult, "link failed");
    },
    onSuccess: (_d, v) => invalidate(v.id),
  });
}

/** RFC step 3: create the product (+ economics) from the card's confirmed fields. */
export function usePromotePdProduct() {
  const qc = useQueryClient();
  const invalidate = useInvalidateBoard();
  return useMutation({
    mutationFn: async (params: {
      id: string;
      product: {
        sku: string;
        product_name: string;
        category?: "fillable" | "non_fillable";
        display_category?: string;
        retail_price?: number;
        standard_quantity_per_carton?: number;
        upc_code?: string | null;
        abc_classification?: string | null;
      };
    }) => {
      const { data, error } = await supabase.rpc("rpc_pd_promote_product", {
        p_project_id: params.id,
        p_product: params.product as unknown as never,
      });
      if (error) throw error;
      return assertOk(data as RpcResult, "promotion failed");
    },
    onSuccess: (_d, v) => {
      invalidate(v.id);
      qc.invalidateQueries({ queryKey: ["products"] });
      qc.invalidateQueries({ queryKey: ["sku-economics"] });
    },
  });
}

export function useAddPdNote() {
  const invalidate = useInvalidateBoard();
  return useMutation({
    mutationFn: async (params: { projectId: string; body: string; occurredOn: string; authorId: string | null }) => {
      const { error } = await supabase.from("mkt_pd_notes").insert({
        project_id: params.projectId,
        body: params.body.trim(),
        occurred_on: params.occurredOn,
        created_by: params.authorId,
      });
      if (error) throw error;
    },
    onSuccess: (_d, v) => invalidate(v.projectId),
  });
}
