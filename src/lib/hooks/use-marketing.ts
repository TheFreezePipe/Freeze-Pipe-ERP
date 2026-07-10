/**
 * use-marketing — data hooks for the Marketing module (Phase 1).
 *
 * Plain table CRUD over the mkt_* tables, gated by RLS (read = any
 * authenticated; write = admin/manager via jwt_is_internal()). Hooks throw
 * raw errors; callers format with describeError() + toast. See
 * docs/MARKETING_MODULE_PLAN.md.
 */
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import type { Database, Json } from "@/lib/database.types";

type Tables = Database["public"]["Tables"];
export type MktSale = Tables["mkt_sales"]["Row"];
export type MktSaleInsert = Tables["mkt_sales"]["Insert"];
export type MktOffer = Tables["mkt_offers"]["Row"];
export type MktOfferInsert = Tables["mkt_offers"]["Insert"];
export type MktLaunch = Tables["mkt_launches"]["Row"];
export type MktLaunchInsert = Tables["mkt_launches"]["Insert"];
export type MktLaunchSku = Tables["mkt_launch_skus"]["Row"];
export type MktLaunchSkuInsert = Tables["mkt_launch_skus"]["Insert"];
export type MktBroadcast = Tables["mkt_broadcasts"]["Row"];
export type MktBroadcastInsert = Tables["mkt_broadcasts"]["Insert"];

export type MktOfferWithSkus = MktOffer & {
  offer_skus: { sku_id: string }[];
  free_item: { id: string; sku: string; product_name: string } | null;
};
export type MktSaleWithOffers = MktSale & { offers: MktOfferWithSkus[] };

export type MktLaunchMember = MktLaunchSku & {
  product: { id: string; sku: string; product_name: string } | null;
};
export type MktLaunchWithMembers = MktLaunch & { skus: MktLaunchMember[] };

/** A member row as entered in the launch form (before it has an id). */
export interface LaunchMemberInput {
  sku_id: string | null;
  planned_name: string | null;
  expected_first_30d_units: number | null;
  limited_qty: number | null;
  planner_confidence: number | null;
}

export type MktBroadcastWithLinks = MktBroadcast & {
  sale: { id: string; name: string } | null;
  launch: { id: string; name: string } | null;
};

/**
 * Broadcast results, resolved to one shape. The typed columns
 * (recipients/opens/clicks/revenue) are the source of truth; the old
 * `metrics` jsonb blob is READ-ONLY legacy — still consulted for rows that
 * predate the typed columns, but never written anymore.
 */
export interface BroadcastResults {
  recipients: number | null;
  opens: number | null;
  clicks: number | null;
  revenue: number | null;
}

function legacyMetricNum(metrics: Json | null, key: string): number | null {
  if (!metrics || typeof metrics !== "object" || Array.isArray(metrics)) return null;
  const v = (metrics as Record<string, Json | undefined>)[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Typed columns first, legacy `metrics` jsonb as a read-only fallback. */
export function broadcastResults(b: MktBroadcast): BroadcastResults {
  return {
    recipients: b.recipients ?? legacyMetricNum(b.metrics, "recipients"),
    opens: b.opens ?? legacyMetricNum(b.metrics, "opens"),
    clicks: b.clicks ?? legacyMetricNum(b.metrics, "clicks"),
    revenue: b.revenue ?? legacyMetricNum(b.metrics, "revenue"),
  };
}

const STALE = 2 * 60 * 1000;

// ===================== Sales =====================
export function useSales() {
  return useQuery({
    queryKey: ["mkt-sales"],
    queryFn: async (): Promise<MktSale[]> => {
      const { data, error } = await supabase
        .from("mkt_sales")
        .select("*")
        .order("starts_at", { ascending: false, nullsFirst: false });
      if (error) throw error;
      return data as MktSale[];
    },
    staleTime: STALE,
  });
}

export function useSaleWithOffers(id: string | undefined) {
  return useQuery({
    queryKey: ["mkt-sale", id],
    enabled: !!id,
    queryFn: async (): Promise<MktSaleWithOffers | null> => {
      const { data, error } = await supabase
        .from("mkt_sales")
        .select(
          // free_item needs the explicit FK hint: mkt_offers reaches
          // product_skus two ways (free_item_sku_id AND the m2m through
          // mkt_offer_skus), and PostgREST refuses to guess between them.
          "*, offers:mkt_offers(*, offer_skus:mkt_offer_skus(sku_id), free_item:product_skus!mkt_offers_free_item_sku_id_fkey(id, sku, product_name))",
        )
        .eq("id", id!)
        .maybeSingle();
      if (error) throw error;
      return data as MktSaleWithOffers | null;
    },
    staleTime: STALE,
  });
}

export function useCreateSale() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (sale: MktSaleInsert): Promise<MktSale> => {
      const { data, error } = await supabase.from("mkt_sales").insert(sale).select().single();
      if (error) throw error;
      return data as MktSale;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["mkt-sales"] }),
  });
}

export function useUpdateSale() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, updates }: { id: string; updates: Partial<MktSaleInsert> }) => {
      const { error } = await supabase.from("mkt_sales").update(updates).eq("id", id);
      if (error) throw error;
    },
    onSuccess: (_d, { id }) => {
      qc.invalidateQueries({ queryKey: ["mkt-sales"] });
      qc.invalidateQueries({ queryKey: ["mkt-sale", id] });
    },
  });
}

export function useDeleteSale() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("mkt_sales").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["mkt-sales"] }),
  });
}

// ===================== Offers =====================
function invalidateSale(qc: ReturnType<typeof useQueryClient>, saleId: string) {
  qc.invalidateQueries({ queryKey: ["mkt-sale", saleId] });
  qc.invalidateQueries({ queryKey: ["mkt-sales"] });
}

export function useCreateOffer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (offer: MktOfferInsert): Promise<MktOffer> => {
      const { data, error } = await supabase.from("mkt_offers").insert(offer).select().single();
      if (error) throw error;
      return data as MktOffer;
    },
    onSuccess: (offer) => invalidateSale(qc, offer.sale_id),
  });
}

export function useUpdateOffer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      saleId: _saleId,
      updates,
    }: {
      id: string;
      saleId: string;
      updates: Partial<MktOfferInsert>;
    }) => {
      const { error } = await supabase.from("mkt_offers").update(updates).eq("id", id);
      if (error) throw error;
    },
    onSuccess: (_d, { saleId }) => invalidateSale(qc, saleId),
  });
}

export function useDeleteOffer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, saleId: _saleId }: { id: string; saleId: string }) => {
      const { error } = await supabase.from("mkt_offers").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: (_d, { saleId }) => invalidateSale(qc, saleId),
  });
}

/** Replace an offer's explicit SKU membership (scope = sku_set). */
export function useSetOfferSkus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      offerId,
      saleId: _saleId,
      skuIds,
    }: {
      offerId: string;
      saleId: string;
      skuIds: string[];
    }) => {
      const { error: delErr } = await supabase.from("mkt_offer_skus").delete().eq("offer_id", offerId);
      if (delErr) throw delErr;
      if (skuIds.length > 0) {
        const rows = skuIds.map((sku_id) => ({ offer_id: offerId, sku_id }));
        const { error: insErr } = await supabase.from("mkt_offer_skus").insert(rows);
        if (insErr) throw insErr;
      }
    },
    onSuccess: (_d, { saleId }) => invalidateSale(qc, saleId),
  });
}

// ===================== Launches =====================
export function useLaunches() {
  return useQuery({
    queryKey: ["mkt-launches"],
    queryFn: async (): Promise<MktLaunchWithMembers[]> => {
      const { data, error } = await supabase
        .from("mkt_launches")
        .select("*, skus:mkt_launch_skus(*, product:product_skus(id, sku, product_name))")
        .order("launch_date", { ascending: false, nullsFirst: false });
      if (error) throw error;
      return data as MktLaunchWithMembers[];
    },
    staleTime: STALE,
  });
}

// Launch writes go through rpc_save_launch: one transaction (no stranded
// child rows on failure) that RECONCILES members instead of delete+reinsert,
// so the Phase B outcome columns (sold_out_at, actual_first_30d_units,
// factory_order_id) survive an edit. The RPC is SECURITY INVOKER, so the
// admin/manager RLS write gate still applies.
export function useCreateLaunch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ launch, members }: { launch: MktLaunchInsert; members: LaunchMemberInput[] }): Promise<MktLaunch> => {
      const { data, error } = await supabase.rpc("rpc_save_launch", {
        p_id: null as unknown as string, // NULL → insert; typed non-null by codegen
        p_launch: launch as unknown as Json,
        p_members: members as unknown as Json,
      });
      if (error) throw error;
      // RPC returns the new launch id; callers only read .id.
      return { ...(launch as MktLaunch), id: data as string };
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["mkt-launches"] }),
  });
}

export function useUpdateLaunch() {
  const qc = useQueryClient();
  return useMutation({
    // members omitted (e.g. a calendar drag that only shifts dates) → members
    // untouched (RPC leaves them alone when p_members is null).
    mutationFn: async ({ id, updates, members }: { id: string; updates: Partial<MktLaunchInsert>; members?: LaunchMemberInput[] }) => {
      const { error } = await supabase.rpc("rpc_save_launch", {
        p_id: id,
        p_launch: updates as unknown as Json,
        p_members: (members ?? null) as unknown as Json,
      });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["mkt-launches"] }),
  });
}

export function useDeleteLaunch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("mkt_launches").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["mkt-launches"] }),
  });
}

// ===================== Broadcasts =====================
export function useBroadcasts() {
  return useQuery({
    queryKey: ["mkt-broadcasts"],
    queryFn: async (): Promise<MktBroadcastWithLinks[]> => {
      const { data, error } = await supabase
        .from("mkt_broadcasts")
        .select(
          "*, sale:mkt_sales(id, name), launch:mkt_launches(id, name)",
        )
        .order("scheduled_at", { ascending: false, nullsFirst: false });
      if (error) throw error;
      return data as MktBroadcastWithLinks[];
    },
    staleTime: STALE,
  });
}

export function useCreateBroadcast() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (b: MktBroadcastInsert): Promise<MktBroadcast> => {
      const { data, error } = await supabase.from("mkt_broadcasts").insert(b).select().single();
      if (error) throw error;
      return data as MktBroadcast;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["mkt-broadcasts"] }),
  });
}

export function useUpdateBroadcast() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, updates }: { id: string; updates: Partial<MktBroadcastInsert> }) => {
      const { error } = await supabase.from("mkt_broadcasts").update(updates).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["mkt-broadcasts"] }),
  });
}

export function useDeleteBroadcast() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("mkt_broadcasts").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["mkt-broadcasts"] }),
  });
}
