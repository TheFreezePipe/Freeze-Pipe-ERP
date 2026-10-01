/**
 * Product Development board — data hooks. Reads are plain selects; stage
 * decisions go through the admin-checked RPCs (rpc_pd_move / kill / archive /
 * link / promote). Hooks throw raw errors; callers format with describeError.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import type { Database } from "@/lib/database.types";
import type { PdLaunchRef } from "@/lib/marketing/pd";
import { launchLinkErrorMessage } from "@/lib/marketing/launch-link";

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
  /** The launch this card rides (linked_launch_id); null when unattached. */
  launch: PdLaunchRef | null;
};

/** Launch columns embedded on a card (the chain reads launch_date / early_access_date / inventory_ready_by). */
export const PD_LAUNCH_REF_COLUMNS = "id, name, kind, launch_date, early_access_date, inventory_ready_by";

const PROJECT_SELECT =
  "*, owner:profiles!mkt_pd_projects_owner_id_fkey(id, full_name), " +
  "supplier:suppliers!mkt_pd_projects_supplier_id_fkey(id, name, code), " +
  "linked_sku:product_skus!mkt_pd_projects_linked_sku_id_fkey(id, sku, product_name), " +
  "comparable_sku:product_skus!mkt_pd_projects_comparable_sku_id_fkey(id, sku, product_name), " +
  "samples:mkt_pd_samples!mkt_pd_samples_project_id_fkey(*, photos:mkt_pd_sample_photos(*)), " +
  // FK hint required: mkt_pd_projects and mkt_launches are also joined by
  // mkt_launches.pd_project_id (legacy) and through mkt_launch_skus.
  `launch:mkt_launches!mkt_pd_projects_linked_launch_id_fkey(${PD_LAUNCH_REF_COLUMNS})`;

/** Embedded arrays come back unordered; sort rounds newest-first and photos by sort_order. */
function normalizeProject(row: PdProjectWithRefs): PdProjectWithRefs {
  const samples = [...(row.samples ?? [])]
    .map((s) => ({
      ...s,
      photos: [...(s.photos ?? [])].sort((a, b) => a.sort_order - b.sort_order || a.created_at.localeCompare(b.created_at)),
    }))
    .sort((a, b) => b.round_no - a.round_no);
  return { ...row, samples, launch: row.launch ?? null };
}

/**
 * Query keys. board = live (unarchived) cards; drop(tag) = a drop's live AND
 * arrived cards (the board pill and "Attach to launch" offer arrived cards
 * too); project(id) = one card, archived or not (the sheet opened from a
 * launch's Arrived row). Every launch-link write invalidates all three.
 */
export const PD_KEYS = {
  board: ["pd-board"] as const,
  skuOwners: ["pd-sku-owners"] as const,
  drop: (tag: string) => ["pd-drop", tag] as const,
  project: (id: string) => ["pd-project", id] as const,
  events: (id: string) => ["pd-events", id] as const,
  notes: (id: string) => ["pd-notes", id] as const,
  config: ["pd-stage-config"] as const,
};
const KEYS = PD_KEYS;

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

/**
 * One card by id, archived or not — the card sheet reached from a launch's
 * product list (an Arrived card is off the board but still on its launch).
 * Null when the id does not exist (or RLS hides it).
 */
export function usePdCard(id: string | null | undefined) {
  return useQuery({
    queryKey: KEYS.project(id ?? "none"),
    enabled: !!id,
    queryFn: async (): Promise<PdProjectWithRefs | null> => {
      const { data, error } = await supabase.from("mkt_pd_projects").select(PROJECT_SELECT).eq("id", id!).maybeSingle();
      if (error) throw error;
      return data ? normalizeProject(data as unknown as PdProjectWithRefs) : null;
    },
    staleTime: 60_000,
  });
}

/**
 * A drop's cards for the board pill: live cards plus cards archived as
 * ARRIVED (they stay on their launch and may be attached — link only);
 * cards archived for other reasons are left out. Board order (stage, sort
 * index, created). Empty tag → disabled, [].
 */
export function usePdDropCards(tag: string | null | undefined) {
  const t = tag?.trim() ?? "";
  return useQuery({
    queryKey: KEYS.drop(t),
    enabled: t !== "",
    queryFn: async (): Promise<PdProjectWithRefs[]> => {
      const { data, error } = await supabase
        .from("mkt_pd_projects")
        .select(PROJECT_SELECT)
        .eq("drop_tag", t)
        .or("archived_at.is.null,archive_reason.eq.arrived")
        .order("stage", { ascending: true })
        .order("sort_index", { ascending: true })
        .order("created_at", { ascending: true });
      if (error) throw error;
      return ((data ?? []) as unknown as PdProjectWithRefs[]).map(normalizeProject);
    },
    staleTime: 60_000,
  });
}

/** A card that owns a SKU (mkt_pd_projects.linked_sku_id), archived or not. */
export interface PdSkuOwner {
  id: string;
  name: string;
  linked_sku_id: string;
  archived_at: string | null;
}

/**
 * Every card that owns a SKU — live AND archived (an arrived card keeps its
 * SKU for good). "Link existing SKU" greys these: rpc_pd_link_sku refuses a
 * SKU any other card owns (sku_owned_by_other_card), the board alone would
 * miss the archived owners.
 */
export function usePdSkuOwners() {
  return useQuery({
    queryKey: KEYS.skuOwners,
    queryFn: async (): Promise<PdSkuOwner[]> => {
      const { data, error } = await supabase
        .from("mkt_pd_projects")
        .select("id, name, linked_sku_id, archived_at")
        .not("linked_sku_id", "is", null);
      if (error) throw error;
      return (data ?? []) as PdSkuOwner[];
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

/** Launches list (use-marketing useLaunches) embeds each launch's cards. */
const LAUNCHES_KEY = ["mkt-launches"] as const;
/** Upcoming launch members per SKU (use-marketing-signals). */
const LAUNCH_SKUS_UPCOMING_KEY = ["mkt-launch-skus-upcoming"] as const;

function useInvalidateBoard() {
  const qc = useQueryClient();
  return (projectId?: string) => {
    qc.invalidateQueries({ queryKey: KEYS.board });
    qc.invalidateQueries({ queryKey: KEYS.skuOwners });
    qc.invalidateQueries({ queryKey: ["pd-drop"] });
    // card names, stages and dates show on the Launches page member lists;
    // halting a card deletes its member row (trg_pd_halt_detaches)
    qc.invalidateQueries({ queryKey: LAUNCHES_KEY });
    qc.invalidateQueries({ queryKey: LAUNCH_SKUS_UPCOMING_KEY });
    if (projectId) {
      qc.invalidateQueries({ queryKey: KEYS.project(projectId) });
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
      // an attached card's member row flips to the new SKU
      qc.invalidateQueries({ queryKey: LAUNCH_SKUS_UPCOMING_KEY });
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

// ---------------------------------------------------------------------------
// Launch link — cards attach to launches (20260928000001_pd_launch_attach,
// 20260930000002_launch_one_product_one_row)
// ---------------------------------------------------------------------------

/** How the card's launch member row was found (rpc_pd_attach_launch rules a-e). */
export type PdAttachMember = "kept" | "claimed_sku" | "claimed_placeholder" | "moved" | "inserted";

export interface PdAttachLaunchCard {
  project_id: string;
  member_id: string;
  member: PdAttachMember;
  /** Planned name of the placeholder row the card took over (claimed_placeholder only). */
  replaced: string | null;
  from_launch_id: string | null;
  old_target: string | null;
  new_target: string | null;
  /** An archived (arrived) card: linked only, its dates untouched. */
  archived: boolean;
}

/** A card the attach refused (halted cards are never on a launch). */
export interface PdAttachSkipped {
  id: string;
  name: string;
  reason: "halted";
}

export interface PdAttachLaunchResult {
  ok: true;
  /** Cards attached (skipped ones excluded). */
  attached: number;
  launch_id: string;
  launch_date: string | null;
  cards: PdAttachLaunchCard[];
  skipped: PdAttachSkipped[];
}

export interface PdDetachLaunchResult {
  ok: true;
  noop?: boolean;
  launch_id?: string | null;
  target_launch_date?: string | null;
  member?: "deleted" | "released" | "none";
}

/** How rpc_pd_link_sku placed the SKU on the card's launch (none when the card is unattached). */
export type PdLinkSkuMember = "merged" | "placeholder_promoted" | "kept" | "none";

export interface PdLinkSkuResult {
  ok: true;
  sku_id: string;
  sku: string;
  launch_id: string | null;
  member_id: string | null;
  member: PdLinkSkuMember;
}

export interface PdMarkArrivedResult {
  ok: true;
  launch_id: string | null;
}

export interface PdSetLaunchOverrideResult {
  ok: true;
  launch_date_override: boolean;
  target_launch_date: string | null;
}

type LaunchLinkFailure = { ok: false; error?: string; missing?: string[] };

/** {ok:false, error} → Error whose message describeError shows as-is; .code keeps the RPC code. */
function assertLaunchLinkOk<T extends { ok: true }>(res: T | LaunchLinkFailure): T {
  if (!res || res.ok !== true) {
    const f = (res ?? {}) as LaunchLinkFailure;
    const err = new Error(launchLinkErrorMessage(f.error)) as Error & { code?: string; missing?: string[] };
    err.code = f.error;
    err.missing = f.missing;
    throw err;
  }
  return res;
}

/** Everything that shows a card's launch, date or membership. */
function useInvalidateLaunchLink() {
  const qc = useQueryClient();
  return (projectIds: readonly string[]) => {
    qc.invalidateQueries({ queryKey: KEYS.board });
    qc.invalidateQueries({ queryKey: KEYS.skuOwners });
    qc.invalidateQueries({ queryKey: ["pd-drop"] });
    qc.invalidateQueries({ queryKey: LAUNCHES_KEY });
    qc.invalidateQueries({ queryKey: LAUNCH_SKUS_UPCOMING_KEY });
    for (const id of projectIds) {
      qc.invalidateQueries({ queryKey: KEYS.project(id) });
      qc.invalidateQueries({ queryKey: KEYS.events(id) });
    }
  };
}

/**
 * Attach one card or a whole drop to a launch; every live card follows the
 * launch date, an arrived card is linked only, halted cards come back in
 * `skipped` (never attached).
 */
export function useAttachLaunch() {
  const invalidate = useInvalidateLaunchLink();
  return useMutation({
    mutationFn: async (params: { projectIds: string[]; launchId: string }) => {
      const { data, error } = await supabase.rpc("rpc_pd_attach_launch", {
        p_project_ids: params.projectIds,
        p_launch_id: params.launchId,
      });
      if (error) throw error;
      return assertLaunchLinkOk(data as unknown as PdAttachLaunchResult | LaunchLinkFailure);
    },
    onSuccess: (_d, v) => invalidate(v.projectIds),
  });
}

/** Detach a card: it keeps its current date as its own; its member row is removed or released. */
export function useDetachLaunch() {
  const invalidate = useInvalidateLaunchLink();
  return useMutation({
    mutationFn: async (params: { projectId: string }) => {
      const { data, error } = await supabase.rpc("rpc_pd_detach_launch", { p_project_id: params.projectId });
      if (error) throw error;
      return assertLaunchLinkOk(data as unknown as PdDetachLaunchResult | LaunchLinkFailure);
    },
    onSuccess: (_d, v) => invalidate([v.projectId]),
  });
}

/**
 * "Use own date" (override true; `date` sets it, else the current date is
 * kept) / "Use launch date" (override false; snaps back to the launch date).
 * Refused for archived cards (error 'archived': their dates are frozen).
 */
export function useSetLaunchOverride() {
  const invalidate = useInvalidateLaunchLink();
  return useMutation({
    mutationFn: async (params: { projectId: string; override: boolean; date?: string | null }) => {
      const { data, error } = await supabase.rpc("rpc_pd_set_launch_override", {
        p_project_id: params.projectId,
        p_override: params.override,
        ...(params.date ? { p_date: params.date } : {}),
      });
      if (error) throw error;
      return assertLaunchLinkOk(data as unknown as PdSetLaunchOverrideResult | LaunchLinkFailure);
    },
    onSuccess: (_d, v) => invalidate([v.projectId]),
  });
}

/**
 * "Link existing SKU" on a card that has none (admin/manager). When the card
 * is on a launch that already lists that SKU as a plain row, the two merge
 * into the card's row (member 'merged'); otherwise the card's placeholder
 * takes the SKU ('placeholder_promoted'). Errors (launchLinkErrorMessage):
 * admin_or_manager_required, sku_required, not_found, already_linked,
 * sku_not_found, sku_owned_by_other_card.
 */
export function useLinkSku() {
  const invalidate = useInvalidateLaunchLink();
  return useMutation({
    mutationFn: async (params: { projectId: string; skuId: string }) => {
      const { data, error } = await supabase.rpc("rpc_pd_link_sku", {
        p_project_id: params.projectId,
        p_sku_id: params.skuId,
      });
      if (error) throw error;
      return assertLaunchLinkOk(data as unknown as PdLinkSkuResult | LaunchLinkFailure);
    },
    onSuccess: (_d, v) => invalidate([v.projectId]),
  });
}

/**
 * "Mark arrived" on an Ordered card (admin/manager): archives it as arrived
 * by hand; its launch link, date and override are untouched, so it stays on
 * its launch as an Arrived product. Errors: admin_or_manager_required,
 * not_found, already_archived, not_ordered.
 */
export function useMarkArrived() {
  const invalidate = useInvalidateLaunchLink();
  return useMutation({
    mutationFn: async (params: { projectId: string; note?: string | null }) => {
      const note = params.note?.trim();
      const { data, error } = await supabase.rpc("rpc_pd_mark_arrived", {
        p_project_id: params.projectId,
        ...(note ? { p_note: note } : {}),
      });
      if (error) throw error;
      return assertLaunchLinkOk(data as unknown as PdMarkArrivedResult | LaunchLinkFailure);
    },
    onSuccess: (_d, v) => invalidate([v.projectId]),
  });
}
