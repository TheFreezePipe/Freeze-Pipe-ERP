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
export type PdSample = Tables["mkt_pd_samples"]["Row"];
export type PdSamplePhoto = Tables["mkt_pd_sample_photos"]["Row"];

export type PdSampleWithPhotos = PdSample & { photos: PdSamplePhoto[] };

export type PdProjectWithRefs = PdProject & {
  owner: { id: string; full_name: string | null } | null;
  supplier: { id: string; name: string; code: string } | null;
  linked_sku: { id: string; sku: string; product_name: string } | null;
  comparable_sku: { id: string; sku: string; product_name: string } | null;
  /** Sample rounds, newest first, each with its photos (sort_order, then created_at). */
  samples: PdSampleWithPhotos[];
};

const PROJECT_SELECT =
  "*, owner:profiles!mkt_pd_projects_owner_id_fkey(id, full_name), " +
  "supplier:suppliers!mkt_pd_projects_supplier_id_fkey(id, name, code), " +
  "linked_sku:product_skus!mkt_pd_projects_linked_sku_id_fkey(id, sku, product_name), " +
  "comparable_sku:product_skus!mkt_pd_projects_comparable_sku_id_fkey(id, sku, product_name), " +
  "samples:mkt_pd_samples!mkt_pd_samples_project_id_fkey(*, photos:mkt_pd_sample_photos(*))";

/** Embedded arrays come back unordered; sort rounds newest-first and photos by sort_order. */
function normalizeProject(row: PdProjectWithRefs): PdProjectWithRefs {
  const samples = [...(row.samples ?? [])]
    .map((s) => ({
      ...s,
      photos: [...(s.photos ?? [])].sort((a, b) => a.sort_order - b.sort_order || a.created_at.localeCompare(b.created_at)),
    }))
    .sort((a, b) => b.round_no - a.round_no);
  return { ...row, samples };
}

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
      return ((data ?? []) as unknown as PdProjectWithRefs[]).map(normalizeProject);
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
      return (data ?? []) as unknown as (PdStageEvent & {
        decider: { full_name: string | null } | null;
      })[];
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
      return (data ?? []) as unknown as (PdNote & {
        author: { full_name: string | null } | null;
      })[];
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
        .insert({
          name: params.name.trim(),
          owner_id: params.ownerId,
          created_by: params.ownerId,
          stage: "good_ideas",
        })
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

type RpcResult = {
  ok: boolean;
  error?: string;
  missing?: string[];
  outcome?: string;
  sku_id?: string;
};

function assertOk(res: RpcResult, fallback: string): RpcResult {
  if (!res.ok) {
    const err = new Error(res.error ?? fallback) as Error & {
      missing?: string[];
    };
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
      const { data, error } = await supabase.rpc("rpc_pd_kill", {
        p_project_id: params.id,
        p_reason: params.reason,
      });
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
      const { data, error } = await supabase.rpc("rpc_pd_archive", {
        p_project_id: params.id,
        p_reason: params.reason,
      });
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
      const { error } = await supabase.rpc("rpc_pd_reorder", {
        p_project_id: params.id,
        p_sort_index: params.sortIndex,
      });
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

// ---------------------------------------------------------------------------
// Phase 2 — sample rounds + photos
// ---------------------------------------------------------------------------

/** Key-present semantics: only the keys you pass are written (null clears). */
export interface PdSamplePatch {
  id?: string;
  sample_type?: "prototype" | "pre_production" | "first_off";
  requested_at?: string;
  factory_eta?: string | null;
  tracking_no?: string | null;
  received_at?: string | null;
  feedback_sent_at?: string | null;
  factory_acknowledged_at?: string | null;
  verdict?: "approved" | "approved_with_changes" | "revise" | "rejected";
  verdict_notes?: string | null;
}

export interface PdSampleSaveResult {
  ok: boolean;
  error?: string;
  sample_id?: string;
  round_no?: number;
  moved_to?: string | null;
  next_round_id?: string | null;
}

/**
 * Create a round (no id) or patch one (id). The RPC owns the auto-moves:
 * first receipt in China Working → Prototype Sent; revise/rejected →
 * recycle to China Working + next round opened.
 */
export function useSavePdSample() {
  const invalidate = useInvalidateBoard();
  return useMutation({
    mutationFn: async (params: { projectId: string; patch: PdSamplePatch }) => {
      const { data, error } = await supabase.rpc("rpc_pd_sample_save", {
        p_project_id: params.projectId,
        p_sample: params.patch as unknown as never,
      });
      if (error) throw error;
      const res = data as unknown as PdSampleSaveResult;
      if (!res.ok) throw new Error(res.error ?? "sample save failed");
      return res;
    },
    onSuccess: (_d, v) => invalidate(v.projectId),
  });
}

export const PD_SAMPLES_BUCKET = "pd-samples";
/** Longest edge after client-side resize; keeps each photo well under the 8 MB bucket cap. */
export const PD_PHOTO_MAX_EDGE = 1600;

/** Resize an image in the browser (canvas) to a JPEG no larger than PD_PHOTO_MAX_EDGE on its longest edge. */
export async function resizePhoto(file: File, maxEdge = PD_PHOTO_MAX_EDGE): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas unavailable");
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.86));
  if (!blob) throw new Error("image encode failed");
  return blob;
}

/** Upload one photo to the round (resized client-side), then register it. */
export function useAddPdSamplePhoto() {
  const invalidate = useInvalidateBoard();
  return useMutation({
    mutationFn: async (params: { projectId: string; sampleId: string; file: File; sortOrder: number; userId: string | null }) => {
      const blob = await resizePhoto(params.file);
      const path = `${params.projectId}/${params.sampleId}/${crypto.randomUUID()}.jpg`;
      const up = await supabase.storage.from(PD_SAMPLES_BUCKET).upload(path, blob, {
        contentType: "image/jpeg",
        upsert: false,
      });
      if (up.error) throw up.error;
      const { error } = await supabase.from("mkt_pd_sample_photos").insert({
        sample_id: params.sampleId,
        storage_path: path,
        sort_order: params.sortOrder,
        created_by: params.userId,
      });
      if (error) {
        await supabase.storage.from(PD_SAMPLES_BUCKET).remove([path]);
        throw error;
      }
      return path;
    },
    onSuccess: (_d, v) => invalidate(v.projectId),
  });
}

export function useRemovePdSamplePhoto() {
  const invalidate = useInvalidateBoard();
  return useMutation({
    mutationFn: async (params: { projectId: string; photoId: string; storagePath: string }) => {
      const { error } = await supabase.from("mkt_pd_sample_photos").delete().eq("id", params.photoId);
      if (error) throw error;
      await supabase.storage.from(PD_SAMPLES_BUCKET).remove([params.storagePath]);
    },
    onSuccess: (_d, v) => invalidate(v.projectId),
  });
}

/**
 * Signed URLs for a set of storage paths (private bucket). One batched call;
 * cached ~50 min against a 1 h signature.
 */
export function usePdPhotoUrls(paths: string[]) {
  const key = [...paths].sort().join("|");
  return useQuery({
    queryKey: ["pd-photo-urls", key],
    enabled: paths.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase.storage.from(PD_SAMPLES_BUCKET).createSignedUrls(paths, 60 * 60);
      if (error) throw error;
      const out: Record<string, string> = {};
      for (const row of data ?? []) {
        if (row.path && row.signedUrl) out[row.path] = row.signedUrl;
      }
      return out;
    },
    staleTime: 50 * 60_000,
    gcTime: 55 * 60_000,
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
