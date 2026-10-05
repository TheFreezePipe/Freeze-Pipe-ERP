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
import type { PdLaunchRef } from "@/lib/marketing/pd";
import { inboundBySku, keepCurrentCardMembers, type InboundLine, type InboundMap } from "@/lib/marketing/launch-link";
import type { LaunchFactorySupply, LaunchFactorySupplyItem, LaunchFactorySupplyOrder } from "@/lib/marketing/launch-supply";

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
  offer_skus: { sku_id: string; product: { id: string; sku: string } | null }[];
  free_item: { id: string; sku: string; product_name: string } | null;
};
export type MktSaleWithOffers = MktSale & { offers: MktOfferWithSkus[] };

export type MktLaunchMember = MktLaunchSku & {
  product: { id: string; sku: string; product_name: string } | null;
};
type PdProjectRow = Tables["mkt_pd_projects"]["Row"];

/**
 * A PD card attached to a launch (mkt_pd_projects.linked_launch_id), with
 * what the deadline chain / risk dot / launch-link previews / memberState
 * read. `launch` is the parent launch's dates, so deadlineChain(card, today)
 * and riskDot(card, today) anchor on it without passing it. Its supply is
 * not here: the ledger reads the SKU's factory orders through
 * useLaunchFactorySupply.
 */
export type MktLaunchCard = Pick<
  PdProjectRow,
  | "id"
  | "name"
  | "stage"
  | "drop_tag"
  | "display_category"
  | "target_launch_date"
  | "launch_date_override"
  | "linked_launch_id"
  | "spec_sent_at"
  | "stage_entered_at"
  | "linked_sku_id"
  | "linked_factory_order_id"
  | "archived_at"
  | "archive_reason"
  | "ordered_at"
  | "created_at"
> & { launch: PdLaunchRef };

/**
 * skus: member rows (each carries pd_project_id when it stands for a card).
 * cards: attached PD cards, archived (arrived) ones included — they stay on
 * their launch, frozen — ordered by their member row's position, then name.
 * Halted cards are never attached (trg_pd_halt_detaches).
 */
export type MktLaunchWithMembers = MktLaunch & { skus: MktLaunchMember[]; cards: MktLaunchCard[] };

/** A member row as entered in the launch form (before it has an id). */
export interface LaunchMemberInput {
  sku_id: string | null;
  planned_name: string | null;
  expected_first_30d_units: number | null;
  limited_qty: number | null;
  planner_confidence: number | null;
  /**
   * The PD card this row stands for. rpc_save_launch attaches a card that is
   * not on the launch yet (create-launch-from-drop is one call; a SKU pick
   * whose SKU belongs to a live card is sent WITH the card's id so the row
   * becomes the card line) and skips halted cards (no row). A newly picked
   * plain SKU is auto-linked to its one live card server-side anyway.
   */
  pd_project_id?: string | null;
}

/**
 * The launch fields an edit save may carry besides the mkt_launches columns.
 * `detach_pd_project_ids`: cards whose row the form removed (the X on a card
 * row) — rpc_save_launch processes them LAST through the unified detach
 * rule, deleting the row unless it has actuals.
 */
export type LaunchSaveInput = Partial<MktLaunchInsert> & { detach_pd_project_ids?: string[] };

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
          "*, offers:mkt_offers(*, offer_skus:mkt_offer_skus(sku_id, product:product_skus(id, sku)), free_item:product_skus!mkt_offers_free_item_sku_id_fkey(id, sku, product_name))",
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
    mutationFn: async ({ id, updates }: { id: string; saleId: string; updates: Partial<MktOfferInsert> }) => {
      const { error } = await supabase.from("mkt_offers").update(updates).eq("id", id);
      if (error) throw error;
    },
    onSuccess: (_d, { saleId }) => invalidateSale(qc, saleId),
  });
}

export function useDeleteOffer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id }: { id: string; saleId: string }) => {
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
    mutationFn: async ({ offerId, skuIds }: { offerId: string; saleId: string; skuIds: string[] }) => {
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
/** The card columns the launches query embeds (MktLaunchCard minus the parent launch, added by normalizeLaunch). */
const LAUNCH_CARD_COLUMNS =
  "id, name, stage, drop_tag, display_category, target_launch_date, launch_date_override, linked_launch_id, " +
  "spec_sent_at, stage_entered_at, linked_sku_id, linked_factory_order_id, archived_at, archive_reason, ordered_at, created_at";

type LaunchRowRaw = MktLaunch & {
  skus: MktLaunchMember[] | null;
  cards: Omit<MktLaunchCard, "launch">[] | null;
};

/** Cards get their parent launch's dates; ordered like the member rows (then name). */
function normalizeLaunch(row: LaunchRowRaw): MktLaunchWithMembers {
  const skus = row.skus ?? [];
  const pos = new Map<string, number>();
  for (const m of skus) if (m.pd_project_id) pos.set(m.pd_project_id, m.sort_order);
  const launch: PdLaunchRef = {
    id: row.id,
    name: row.name,
    kind: row.kind,
    launch_date: row.launch_date,
    early_access_date: row.early_access_date,
    inventory_ready_by: row.inventory_ready_by,
  };
  const cards: MktLaunchCard[] = (row.cards ?? [])
    .map((c) => ({ ...c, launch }))
    .sort(
      (a, b) =>
        (pos.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (pos.get(b.id) ?? Number.MAX_SAFE_INTEGER) ||
        a.name.localeCompare(b.name),
    );
  return { ...row, skus, cards };
}

export function useLaunches() {
  return useQuery({
    queryKey: ["mkt-launches"],
    queryFn: async (): Promise<MktLaunchWithMembers[]> => {
      const { data, error } = await supabase
        .from("mkt_launches")
        .select(
          "*, skus:mkt_launch_skus(*, product:product_skus(id, sku, product_name)), " +
            // FK hint required: launches and cards are also joined by the
            // legacy mkt_launches.pd_project_id and through mkt_launch_skus.
            // Cards are internal-only (RLS): other accounts get [].
            `cards:mkt_pd_projects!mkt_pd_projects_linked_launch_id_fkey(${LAUNCH_CARD_COLUMNS})`,
        )
        .order("launch_date", { ascending: false, nullsFirst: false });
      if (error) throw error;
      return ((data ?? []) as unknown as LaunchRowRaw[]).map(normalizeLaunch);
    },
    staleTime: STALE,
  });
}

/**
 * Inbound freight for a set of SKUs, grouped by SKU: every freight line on a
 * shipment whose receipt is not confirmed (fn_pd_evaluate_arrival's INBOUND
 * test), with its shipment — number, type, status, ETA and original ETA,
 * carrier — and the shipment's carton groups with the SKUs each carries (the
 * supply ledger's cartons-to-land per SKU). ONE query per page — pass
 * launchSkuIds(launches) and hand the map to launchProducts for every launch. Cache key ["launch-inbound", <sorted sku ids joined by |>];
 * freight check-ins are a different module, so the 2-minute staleTime (and a
 * remount) is what refreshes it. Returns EMPTY_INBOUND-shaped data (an empty
 * Map) when no SKU is passed.
 */
export const LAUNCH_INBOUND_KEY = ["launch-inbound"] as const;

export function useLaunchInbound(skuIds: readonly string[]) {
  const ids = [...new Set(skuIds)].sort();
  return useQuery({
    queryKey: [...LAUNCH_INBOUND_KEY, ids.join("|")],
    queryFn: async (): Promise<InboundMap> => {
      if (ids.length === 0) return new Map();
      const { data, error } = await supabase
        .from("freight_line_items")
        .select(
          "sku_id, quantity, quantity_received, quantity_prefilled, source_factory_order_item_id, freight_shipment_id, " +
            "shipment:freight_shipments!inner(id, shipment_number, freight_type, status, eta, eta_original, ship_date, carrier_name, receipt_confirmed_at, " +
            "carton_groups:freight_carton_groups(carton_qty, received_cartons, skus:freight_carton_group_skus(sku_id)))",
        )
        .in("sku_id", ids)
        .is("shipment.receipt_confirmed_at", null);
      if (error) throw error;
      return inboundBySku((data ?? []) as unknown as InboundLine[]);
    },
    staleTime: STALE,
  });
}

/**
 * Units still at the factory for a set of SKUs — the supply ledger's factory
 * rows. Two queries in one: the open factory orders (status not shipped /
 * canceled) with their items for these SKUs, then the freight lines sourced
 * from those items over EVERY shipment status, summed per item into
 * `shippedByItem` (units that left the factory stop being on order whether
 * the shipment has landed or not — the same netting as buildOnOrderMap).
 * ONE query per page — pass launchSkuIds(launches) and hand the result to
 * launchProducts for every launch. Cache key
 * ["launch-factory-supply", <sorted sku ids joined by |>]; the 2-minute
 * staleTime (and a remount) refreshes it. Returns EMPTY_FACTORY_SUPPLY-shaped
 * data when no SKU is passed.
 */
export const LAUNCH_FACTORY_SUPPLY_KEY = ["launch-factory-supply"] as const;

export function useLaunchFactorySupply(skuIds: readonly string[]) {
  const ids = [...new Set(skuIds)].sort();
  return useQuery({
    queryKey: [...LAUNCH_FACTORY_SUPPLY_KEY, ids.join("|")],
    queryFn: async (): Promise<LaunchFactorySupply> => {
      if (ids.length === 0) return { orders: [], shippedByItem: new Map() };
      const { data: orderRows, error: ordersError } = await supabase
        .from("factory_orders")
        .select(
          "id, order_number, status, expected_completion, " +
            "items:factory_order_items!inner(id, sku_id, quantity_ordered, quantity_finished, quantity_breakage, quantity_shipped_manual, quantity_consumed_by_parent, alternate_expected_completion)",
        )
        .in("items.sku_id", ids)
        .not("status", "in", "(shipped,canceled)");
      if (ordersError) throw ordersError;
      const orders = ((orderRows ?? []) as unknown as (Omit<LaunchFactorySupplyOrder, "items"> & { items: LaunchFactorySupplyItem[] | null })[]).map(
        (o) => ({ ...o, items: o.items ?? [] }),
      );
      const itemIds = orders.flatMap((o) => o.items.map((it) => it.id));
      const shippedByItem = new Map<string, number>();
      if (itemIds.length > 0) {
        const { data: lines, error: linesError } = await supabase
          .from("freight_line_items")
          .select("source_factory_order_item_id, quantity")
          .in("source_factory_order_item_id", itemIds);
        if (linesError) throw linesError;
        for (const li of lines ?? []) {
          if (!li.source_factory_order_item_id) continue;
          shippedByItem.set(li.source_factory_order_item_id, (shippedByItem.get(li.source_factory_order_item_id) ?? 0) + (li.quantity ?? 0));
        }
      }
      return { orders, shippedByItem };
    },
    staleTime: STALE,
  });
}

/**
 * A launch save can move cards (fn_pd_follow_launch writes their date and a
 * 'launch_moved' activity event), attach cards (card-backed members, SKU
 * picks that belong to a card) and detach them (detach_pd_project_ids), so it
 * refreshes the PD board, the drop lists and card activity as well as the
 * launches.
 */
function invalidateLaunchWrite(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ["mkt-launches"] });
  qc.invalidateQueries({ queryKey: ["mkt-launch-skus-upcoming"] });
  qc.invalidateQueries({ queryKey: ["pd-board"] });
  qc.invalidateQueries({ queryKey: ["pd-drop"] });
  qc.invalidateQueries({ queryKey: ["pd-events"] });
  qc.invalidateQueries({ queryKey: ["pd-project"] });
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
    onSuccess: () => invalidateLaunchWrite(qc),
  });
}

export function useUpdateLaunch() {
  const qc = useQueryClient();
  return useMutation({
    // members omitted (e.g. a calendar drag that only shifts dates) → members
    // untouched (RPC leaves them alone when p_members is null).
    // openedWithCardIds: the cards that had a row when the form opened. A card
    // among them that lost its row meanwhile (detached while the form was
    // open) is dropped from the payload — rpc_save_launch would re-attach it.
    // Card rows NOT in that set are new picks (a SKU that belongs to a card)
    // and go through. Omitted → every card row without a current row is
    // dropped (the pre-2026-10 form, which never added cards).
    mutationFn: async ({
      id,
      updates,
      members,
      openedWithCardIds,
    }: {
      id: string;
      updates: LaunchSaveInput;
      members?: LaunchMemberInput[];
      openedWithCardIds?: readonly string[];
    }) => {
      let payload = members ?? null;
      if (payload?.some((m) => m.pd_project_id)) {
        const { data: rows, error: rowsError } = await supabase
          .from("mkt_launch_skus")
          .select("pd_project_id")
          .eq("launch_id", id)
          .not("pd_project_id", "is", null);
        if (rowsError) throw rowsError;
        const current = new Set((rows ?? []).map((r) => r.pd_project_id).filter((v): v is string => !!v));
        payload = keepCurrentCardMembers(payload, current, openedWithCardIds ? new Set(openedWithCardIds) : undefined);
      }
      const { error } = await supabase.rpc("rpc_save_launch", {
        p_id: id,
        p_launch: updates as unknown as Json,
        p_members: payload as unknown as Json,
      });
      if (error) throw error;
    },
    onSuccess: () => invalidateLaunchWrite(qc),
  });
}

export function useDeleteLaunch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("mkt_launches").delete().eq("id", id);
      if (error) throw error;
    },
    // attached cards become unattached (FK ON DELETE SET NULL)
    onSuccess: () => invalidateLaunchWrite(qc),
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
