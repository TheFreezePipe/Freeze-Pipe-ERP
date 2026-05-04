import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";

/**
 * Supplier portal hooks. Every mutation goes through a SECURITY DEFINER RPC
 * (migration 021) that validates caller identity, enforces state-machine
 * transitions, and emits an audit entry. Reads use RLS-scoped SELECT —
 * supplier users only ever see their own rows.
 *
 * Envelope contract: all RPCs return { ok: bool, error?: string, ... }.
 * The helper `unwrap()` converts ok=false into a thrown Error.
 */

// ---- Envelope helper --------------------------------------------------------

interface RpcEnvelope {
  ok: boolean;
  error?: string;
  [k: string]: unknown;
}

function unwrap<T extends RpcEnvelope>(data: unknown, fallbackError: string): T {
  const env = data as T;
  if (!env?.ok) {
    throw new Error(env?.error ?? fallbackError);
  }
  return env;
}

/**
 * Normalize whatever shape Supabase/PostgREST throws into a real Error.
 * PostgREST errors are plain objects ({code, message, details, hint}); they
 * don't survive `err instanceof Error` checks, which is why toasts sometimes
 * end up showing "Unknown error". This unwraps both Error and plain-object
 * errors into a single surface-able string.
 */
function toError(err: unknown, fallback: string): Error {
  if (err instanceof Error) return err;
  if (err && typeof err === "object") {
    const e = err as { message?: unknown; details?: unknown; hint?: unknown; code?: unknown };
    const parts: string[] = [];
    if (typeof e.message === "string" && e.message) parts.push(e.message);
    if (typeof e.details === "string" && e.details) parts.push(e.details);
    if (typeof e.hint === "string" && e.hint) parts.push(`(${e.hint})`);
    const msg = parts.length ? parts.join(" — ") : fallback;
    const wrapped = new Error(msg);
    if (typeof e.code === "string") (wrapped as Error & { code?: string }).code = e.code;
    return wrapped;
  }
  return new Error(fallback);
}

// ---- Query-key namespace ---------------------------------------------------

export const supplierQueryKeys = {
  factoryOrders: ["supplier", "factory-orders"] as const,
  factoryOrder: (id: string) => ["supplier", "factory-order", id] as const,
  shipments: ["supplier", "freight-shipments"] as const,
  shipment: (id: string) => ["supplier", "freight-shipment", id] as const,
  breakageReports: ["supplier", "breakage-reports"] as const,
  variances: ["supplier", "shipment-variances"] as const,
};

// =============================================================
// Factory orders (reads)
// =============================================================

export interface SupplierFactoryOrderRow {
  id: string;
  supplier_id: string;
  ship_via_supplier_id: string | null;
  order_number: string | null;
  order_date: string;
  expected_completion: string | null;
  status: "ordered" | "in_production" | "finished" | "shipped" | "canceled";
  canceled_at: string | null;
  canceled_reason: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  row_version: number;
}

export interface SupplierFactoryOrderItemRow {
  id: string;
  factory_order_id: string;
  sku_id: string;
  quantity_ordered: number;
  /** Producer's self-reported finished count. */
  quantity_finished: number | null;
  consolidator_confirmed_quantity: number | null;
  consolidator_confirmed_at: string | null;
  quantity_breakage: number;
  /** Per-item ETA override. NULL = inherit parent order's expected_completion. */
  alternate_expected_completion: string | null;
  created_at: string;
  row_version: number;
  /** Joined from product_skus; may be null if the SKU row is out of RLS scope. */
  sku?: { sku: string; product_name: string } | null;
  /**
   * Freight lines that reference this factory_order_item via
   * source_factory_order_item_id. Each entry carries its shipment so the UI
   * can show shipment numbers + rolled-up shipped quantity.
   *
   * RLS on freight_line_items scopes these to shipments the caller can see
   * (their own + consolidated). A producing supplier who ISN'T the shipper
   * won't have visibility into shipments that moved their items.
   */
  freight_lines?: Array<{
    quantity: number;
    shipment: {
      id: string;
      shipment_number: string | null;
      status: string;
    } | null;
  }>;
}

/**
 * Effective expected completion for a single item: per-item override if set,
 * otherwise the parent order's ETA. Returned as a YYYY-MM-DD string.
 */
export function effectiveItemEta(
  item: Pick<SupplierFactoryOrderItemRow, "alternate_expected_completion">,
  parent: Pick<SupplierFactoryOrderRow, "expected_completion">,
): string | null {
  return item.alternate_expected_completion ?? parent.expected_completion ?? null;
}

/**
 * Decide whether an item is overdue as of `today` (YYYY-MM-DD).
 * Overdue = effective ETA exists and is strictly before today, the parent
 * order is still in a pre-terminal state, and the item hasn't been received
 * by the consolidator yet.
 */
export function isItemOverdue(
  item: Pick<
    SupplierFactoryOrderItemRow,
    "alternate_expected_completion" | "consolidator_confirmed_quantity"
  >,
  parent: Pick<SupplierFactoryOrderRow, "expected_completion" | "status">,
  today: string,
): boolean {
  if (parent.status === "finished" || parent.status === "shipped" || parent.status === "canceled") return false;
  if (item.consolidator_confirmed_quantity !== null) return false;
  const eta = effectiveItemEta(item, parent);
  if (!eta) return false;
  return eta < today;
}

export type SupplierFactoryOrderWithItems = SupplierFactoryOrderRow & {
  items: SupplierFactoryOrderItemRow[];
};

export function useSupplierFactoryOrders() {
  return useQuery({
    queryKey: supplierQueryKeys.factoryOrders,
    queryFn: async () => {
      // Keep this nested select shallow — PostgREST + the current schema
      // get flaky with a deep reverse-join to freight_line_items from here.
      // Freight rollup lives in a sibling query (`useSupplierFreightRollup`)
      // that's merged client-side by the list page. Trade-off: one extra
      // round trip for a much more predictable query shape.
      const { data, error } = await supabase
        .from("factory_orders")
        .select(
          "*, items:factory_order_items(id, factory_order_id, sku_id, quantity_ordered, quantity_finished, consolidator_confirmed_quantity, consolidator_confirmed_at, quantity_breakage, alternate_expected_completion, created_at, row_version, sku:product_skus(sku, product_name))",
        )
        .order("order_date", { ascending: false });
      if (error) throw toError(error, "Factory orders fetch failed");
      return (data ?? []) as unknown as SupplierFactoryOrderWithItems[];
    },
    staleTime: 60_000,
  });
}

/**
 * Freight-line rollup for a set of factory-order item ids. Returns a map
 * keyed by factory_order_item_id → list of { quantity, shipment } entries.
 * Consumers (the Factory Orders list page) merge this into the items they
 * already have.
 *
 * Scope: respects RLS — suppliers only see shipments where
 * origin_supplier_id ∈ jwt_supplier_scope(). Empty map for callers with no
 * visible shipments (e.g., a pure producer who isn't also the broker).
 */
export function useSupplierFreightRollupByItem(itemIds: string[] | undefined) {
  const enabled = !!itemIds && itemIds.length > 0;
  return useQuery({
    // Stable key: sort ids so order doesn't churn the cache.
    queryKey: [
      "supplier",
      "freight-rollup-by-item",
      ...(itemIds ? [...itemIds].sort() : []),
    ],
    enabled,
    queryFn: async () => {
      if (!itemIds || itemIds.length === 0) {
        return new Map<
          string,
          Array<{ quantity: number; shipment: { id: string; shipment_number: string | null; status: string } | null }>
        >();
      }
      const { data, error } = await supabase
        .from("freight_line_items")
        .select(
          "source_factory_order_item_id, quantity, shipment:freight_shipments(id, shipment_number, status)",
        )
        .in("source_factory_order_item_id", itemIds);
      if (error) throw toError(error, "Freight rollup fetch failed");

      const rollup = new Map<
        string,
        Array<{ quantity: number; shipment: { id: string; shipment_number: string | null; status: string } | null }>
      >();
      for (const row of (data ?? []) as Array<{
        source_factory_order_item_id: string | null;
        quantity: number;
        shipment: { id: string; shipment_number: string | null; status: string } | null;
      }>) {
        if (!row.source_factory_order_item_id) continue;
        const list = rollup.get(row.source_factory_order_item_id) ?? [];
        list.push({ quantity: row.quantity, shipment: row.shipment });
        rollup.set(row.source_factory_order_item_id, list);
      }
      return rollup;
    },
    staleTime: 30_000,
  });
}

export function useSupplierFactoryOrder(id: string | null | undefined) {
  return useQuery({
    queryKey: id ? supplierQueryKeys.factoryOrder(id) : ["supplier", "factory-order", "none"],
    enabled: !!id,
    queryFn: async () => {
      const [orderRes, itemsRes] = await Promise.all([
        supabase.from("factory_orders").select("*").eq("id", id!).single(),
        // Nested select pulls the sku display fields without a second round-trip.
        // RLS on product_skus applies — if the caller can't see a component sku
        // row (unlikely given K.3's policy), `sku` comes back null.
        supabase
          .from("factory_order_items")
          // `*` already includes alternate_expected_completion after migration 024.
          .select("*, sku:product_skus(sku, product_name)")
          .eq("factory_order_id", id!),
      ]);
      if (orderRes.error) throw toError(orderRes.error, "Failed to fetch order");
      if (itemsRes.error) throw toError(itemsRes.error, "Failed to fetch items");
      return {
        order: orderRes.data as unknown as SupplierFactoryOrderRow,
        items: (itemsRes.data ?? []) as unknown as SupplierFactoryOrderItemRow[],
      };
    },
    staleTime: 30_000,
  });
}

// =============================================================
// Factory orders (mutations)
// =============================================================

export interface CreateFactoryOrderInput {
  /** Client-generated UUID for retry safety. Reuse the same value on retry. */
  idempotencyKey: string;
  /** Supplier-chosen reference (e.g. "NAN-2026-043"). Optional. */
  orderNumber?: string | null;
  expectedCompletion: string; // ISO date
  notes?: string | null;
  items: Array<{
    skuId: string;
    quantity: number;
    /** Optional per-item override of the order-level ETA. NULL/undefined = inherit. */
    alternateExpectedCompletion?: string | null;
  }>;
}

export function useCreateSupplierFactoryOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateFactoryOrderInput) => {
      const payload = {
        idempotency_key: input.idempotencyKey,
        order_number: input.orderNumber ?? null,
        expected_completion: input.expectedCompletion,
        notes: input.notes ?? null,
        items: input.items.map((i) => ({
          sku_id: i.skuId,
          quantity: i.quantity,
          alternate_expected_completion: i.alternateExpectedCompletion ?? null,
        })),
      };
      const { data, error } = await supabase.rpc(
        "rpc_supplier_create_factory_order",
        { p_payload: payload },
      );
      if (error) throw toError(error, "RPC call failed");
      return unwrap<RpcEnvelope & { factory_order_id: string; item_count?: number; replayed?: boolean }>(
        data,
        "Create factory order failed",
      );
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: supplierQueryKeys.factoryOrders });
    },
  });
}

export function useAdvanceFactoryOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (params: {
      factoryOrderId: string;
      expectedVersion: number;
      notes?: string | null;
    }) => {
      const { data, error } = await supabase.rpc(
        "rpc_supplier_advance_factory_order",
        {
          p_factory_order_id: params.factoryOrderId,
          p_expected_version: params.expectedVersion,
          // SQL arg defaults to NULL; generated types don't preserve that.
          p_notes: (params.notes ?? null) as string,
        },
      );
      if (error) throw toError(error, "RPC call failed");
      return unwrap<RpcEnvelope & { new_status: string }>(data, "Advance failed");
    },
    onSuccess: (_data, params) => {
      qc.invalidateQueries({ queryKey: supplierQueryKeys.factoryOrders });
      qc.invalidateQueries({ queryKey: supplierQueryKeys.factoryOrder(params.factoryOrderId) });
    },
  });
}

export function useCancelFactoryOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (params: {
      factoryOrderId: string;
      expectedVersion: number;
      reason: string;
    }) => {
      const { data, error } = await supabase.rpc(
        "rpc_supplier_cancel_factory_order",
        {
          p_factory_order_id: params.factoryOrderId,
          p_expected_version: params.expectedVersion,
          p_reason: params.reason,
        },
      );
      if (error) throw toError(error, "RPC call failed");
      return unwrap<RpcEnvelope>(data, "Cancel failed");
    },
    onSuccess: (_data, params) => {
      qc.invalidateQueries({ queryKey: supplierQueryKeys.factoryOrders });
      qc.invalidateQueries({ queryKey: supplierQueryKeys.factoryOrder(params.factoryOrderId) });
    },
  });
}

/**
 * Report the finished count for a single line item. Server auto-promotes the
 * parent order's status from ordered → in_production (any progress) or →
 * finished (all lines complete). Version-gated on the parent order.
 */
export function useReportItemFinished() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (params: {
      factoryOrderItemId: string;
      quantityFinished: number;
      expectedVersion: number;
      /** For cache invalidation only. */
      factoryOrderId: string;
    }) => {
      const { data, error } = await supabase.rpc(
        "rpc_supplier_report_item_finished",
        {
          p_factory_order_item_id: params.factoryOrderItemId,
          p_quantity_finished: params.quantityFinished,
          p_expected_version: params.expectedVersion,
        },
      );
      if (error) throw toError(error, "Report finished failed");
      return unwrap<RpcEnvelope & { quantity_finished: number; order_status: string }>(
        data,
        "Report finished failed",
      );
    },
    onSuccess: (_d, params) => {
      qc.invalidateQueries({ queryKey: supplierQueryKeys.factoryOrders });
      qc.invalidateQueries({ queryKey: supplierQueryKeys.factoryOrder(params.factoryOrderId) });
    },
  });
}

export function useSetItemAlternateEta() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (params: {
      factoryOrderItemId: string;
      /** Null clears the per-item override. */
      alternateEta: string | null;
      /** row_version on the parent factory_order at read time. */
      expectedVersion: number;
      /** Used only for cache invalidation. */
      factoryOrderId: string;
    }) => {
      const { data, error } = await supabase.rpc(
        "rpc_supplier_set_item_alternate_eta",
        {
          p_factory_order_item_id: params.factoryOrderItemId,
          // Generated types don't preserve DEFAULT NULL — cast through.
          p_alternate_eta: (params.alternateEta ?? null) as string,
          p_expected_version: params.expectedVersion,
        },
      );
      if (error) throw toError(error, "RPC call failed");
      return unwrap<RpcEnvelope>(data, "Set alt ETA failed");
    },
    onSuccess: (_d, params) => {
      qc.invalidateQueries({ queryKey: supplierQueryKeys.factoryOrders });
      qc.invalidateQueries({ queryKey: supplierQueryKeys.factoryOrder(params.factoryOrderId) });
    },
  });
}

// =============================================================
// Freight shipments
// =============================================================

export interface SupplierFreightShipmentRow {
  id: string;
  origin_supplier_id: string | null;
  shipment_number: string | null;
  freight_type: "sea" | "air";
  tracking_number: string | null;
  carrier_name: string | null;
  status: "pending" | "on_the_water" | "high_risk" | "cleared_customs" | "tracking" | "delivered";
  ship_date: string | null;
  eta: string | null;
  eta_original: string | null;
  actual_arrival_date: string | null;
  total_cartons: number | null;
  freight_cost: number | null;
  total_cost: number | null;
  created_by_supplier_user_id: string | null;
  idempotency_key: string | null;
  created_at: string;
  updated_at: string;
  row_version: number;
}

/** Shipment + its line items in one shape, used by the list cards. */
export type SupplierFreightShipmentWithLines = SupplierFreightShipmentRow & {
  lines: SupplierFreightLineItemRow[];
};

export interface SupplierFreightLineItemRow {
  id: string;
  freight_shipment_id: string;
  sku_id: string;
  quantity: number;
  supplier_declared_quantity: number | null;
  /** Subset of `quantity` that arrived prefilled. NULL for non-fillable SKUs
   *  and legacy rows. Exposed to the portal by migration 029. */
  quantity_prefilled: number | null;
  source_factory_order_item_id: string | null;
  created_at: string;
  updated_at: string;
  sku?: { sku: string; product_name: string } | null;
}

export function useSupplierFreightShipments() {
  return useQuery({
    queryKey: supplierQueryKeys.shipments,
    queryFn: async () => {
      // Pull lines inline so the list page can render SKU breakdowns without
      // fanning out to one query per shipment. RLS on both tables applies.
      const { data, error } = await supabase
        .from("freight_shipments")
        .select(
          "*, lines:freight_line_items(id, freight_shipment_id, sku_id, quantity, supplier_declared_quantity, quantity_prefilled, source_factory_order_item_id, created_at, updated_at, sku:product_skus(sku, product_name))",
        )
        .order("created_at", { ascending: false });
      if (error) throw toError(error, "Shipments fetch failed");
      return (data ?? []) as unknown as SupplierFreightShipmentWithLines[];
    },
    staleTime: 60_000,
  });
}

export function useSupplierFreightShipment(id: string | null | undefined) {
  return useQuery({
    queryKey: id ? supplierQueryKeys.shipment(id) : ["supplier", "freight-shipment", "none"],
    enabled: !!id,
    queryFn: async () => {
      const [shipRes, linesRes] = await Promise.all([
        supabase.from("freight_shipments").select("*").eq("id", id!).single(),
        supabase
          .from("freight_line_items")
          .select("*, sku:product_skus(sku, product_name)")
          .eq("freight_shipment_id", id!),
      ]);
      if (shipRes.error) throw shipRes.error;
      if (linesRes.error) throw linesRes.error;
      return {
        shipment: shipRes.data as unknown as SupplierFreightShipmentRow,
        lines: (linesRes.data ?? []) as unknown as SupplierFreightLineItemRow[],
      };
    },
    staleTime: 30_000,
  });
}

export interface CreateFreightShipmentInput {
  idempotencyKey: string;
  /** Optional. Server auto-generates as `<CODE>-<YYYYMMDD>-<8-char idem>` when omitted. */
  shipmentNumber?: string | null;
  /** 'sea' or 'air'. Defaults to 'sea' server-side when omitted. */
  freightType?: "sea" | "air";
  /** Date the container leaves the supplier facility. */
  shipDate?: string | null;
  trackingNumber?: string | null;
  carrier: string;
  eta?: string | null;
  totalCartons: number;
  /** Freight cost the supplier paid (or expects to pay) the carrier. Non-negative. */
  freightCost?: number;
  lines: Array<{
    skuId: string;
    supplierDeclaredQuantity: number;
    sourceFactoryOrderItemId?: string | null;
    /**
     * Portion of this line's declared quantity that was filled at the
     * supplier. Optional — omit or pass null for unknown. Must be between
     * 0 and supplierDeclaredQuantity when provided.
     */
    quantityPrefilled?: number | null;
  }>;
}

export function useCreateSupplierFreightShipment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateFreightShipmentInput) => {
      const payload = {
        idempotency_key: input.idempotencyKey,
        shipment_number: input.shipmentNumber ?? null,
        freight_type: input.freightType ?? "sea",
        ship_date: input.shipDate ?? null,
        tracking_number: input.trackingNumber ?? null,
        carrier: input.carrier,
        eta: input.eta ?? null,
        total_cartons: input.totalCartons,
        freight_cost: input.freightCost ?? 0,
        lines: input.lines.map((l) => ({
          sku_id: l.skuId,
          supplier_declared_quantity: l.supplierDeclaredQuantity,
          source_factory_order_item_id: l.sourceFactoryOrderItemId ?? null,
          quantity_prefilled: l.quantityPrefilled ?? null,
        })),
      };
      const { data, error } = await supabase.rpc(
        "rpc_supplier_create_freight_shipment",
        { p_payload: payload },
      );
      if (error) throw toError(error, "RPC call failed");
      return unwrap<RpcEnvelope & { shipment_id: string; line_count?: number; replayed?: boolean }>(
        data,
        "Create shipment failed",
      );
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: supplierQueryKeys.shipments }),
  });
}

/**
 * Post-create edit for a supplier shipment. Only the origin supplier can
 * call; only pending/on_the_water shipments are editable; row_version
 * gate guards against concurrent edits. Setting tracking + carrier on a
 * pending row auto-promotes it to on_the_water server-side.
 *
 * Null param = "don't touch". To explicitly clear a field, pass the
 * corresponding clear* flag as true.
 */
export function useUpdateSupplierShipmentTracking() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (params: {
      shipmentId: string;
      expectedVersion: number;
      trackingNumber?: string | null;
      carrier?: string | null;
      eta?: string | null;
      shipDate?: string | null;
      freightCost?: number | null;
      clearTrackingNumber?: boolean;
      clearCarrier?: boolean;
      clearEta?: boolean;
      clearShipDate?: boolean;
      clearFreightCost?: boolean;
    }) => {
      const { data, error } = await supabase.rpc(
        "rpc_supplier_update_shipment_tracking",
        {
          p_shipment_id: params.shipmentId,
          p_expected_version: params.expectedVersion,
          p_tracking_number: params.trackingNumber ?? undefined,
          p_carrier: params.carrier ?? undefined,
          p_eta: params.eta ?? undefined,
          p_ship_date: params.shipDate ?? undefined,
          p_freight_cost: params.freightCost ?? undefined,
          p_clear_tracking_number: params.clearTrackingNumber ?? false,
          p_clear_carrier: params.clearCarrier ?? false,
          p_clear_eta: params.clearEta ?? false,
          p_clear_ship_date: params.clearShipDate ?? false,
          p_clear_freight_cost: params.clearFreightCost ?? false,
        },
      );
      if (error) throw toError(error, "Update shipment failed");
      return unwrap<RpcEnvelope>(data, "Update shipment failed");
    },
    onSuccess: (_d, params) => {
      qc.invalidateQueries({ queryKey: supplierQueryKeys.shipments });
      qc.invalidateQueries({ queryKey: supplierQueryKeys.shipment(params.shipmentId) });
    },
  });
}

// (Removed useBookFreightShipment — migration 035 collapsed `booked` out
//  of the state machine. Setting tracking + carrier on a pending shipment
//  via useUpdateSupplierShipmentTracking auto-promotes it to on_the_water.)

// =============================================================
// Consolidator receive
// =============================================================

export interface ConsolidatorReceiveInput {
  factoryOrderId: string;
  expectedVersion: number;
  items: Array<{
    factoryOrderItemId: string;
    confirmedQuantity: number;
    breakageQuantity: number;
    breakageReasonCategory?:
      | "crushed_in_transit"
      | "manufacturing_defect"
      | "wet_damage"
      | "contamination"
      | "other";
    breakageDescription?: string;
  }>;
}

export function useConsolidatorReceive() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: ConsolidatorReceiveInput) => {
      const payload = {
        factory_order_id: input.factoryOrderId,
        expected_version: input.expectedVersion,
        items: input.items.map((i) => ({
          factory_order_item_id: i.factoryOrderItemId,
          confirmed_quantity: i.confirmedQuantity,
          breakage_quantity: i.breakageQuantity,
          breakage_reason_category: i.breakageReasonCategory,
          breakage_description: i.breakageDescription,
        })),
      };
      const { data, error } = await supabase.rpc(
        "rpc_consolidator_confirm_factory_order_receive",
        { p_payload: payload },
      );
      if (error) throw toError(error, "RPC call failed");
      return unwrap<RpcEnvelope & { items_processed: number; breakage_reports_created: number }>(
        data,
        "Receive confirm failed",
      );
    },
    onSuccess: (_d, input) => {
      qc.invalidateQueries({ queryKey: supplierQueryKeys.factoryOrders });
      qc.invalidateQueries({ queryKey: supplierQueryKeys.factoryOrder(input.factoryOrderId) });
      qc.invalidateQueries({ queryKey: supplierQueryKeys.breakageReports });
      // The receive RPC also writes to inventory_levels (units land in
      // warehouse_finished or warehouse_raw depending on factory order
      // type) and emits inventory_transactions audit rows. Without
      // these invalidations the inventory dashboard, SKU detail, and
      // retail-value bar will keep showing pre-receive numbers until
      // the user manually refreshes — operators interpret this as
      // "the receive didn't post."
      qc.invalidateQueries({ queryKey: ["inventory"] });
      qc.invalidateQueries({ queryKey: ["inventory-transactions"] });
    },
  });
}

// =============================================================
// Breakage reports
// =============================================================

export interface BreakageReportRow {
  id: string;
  factory_order_item_id: string;
  producing_supplier_id: string;
  reporter_supplier_id: string;
  sku_id: string;
  quantity_broken: number;
  reason_category: string;
  description: string;
  replacement_requested: boolean;
  replacement_factory_order_id: string | null;
  status: "open" | "acknowledged" | "disputed" | "resolved" | "written_off";
  resolution_notes: string | null;
  acknowledged_at: string | null;
  resolved_at: string | null;
  created_at: string;
}

export function useBreakageReports() {
  return useQuery({
    queryKey: supplierQueryKeys.breakageReports,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("component_breakage_reports")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw toError(error, "RPC call failed");
      return (data ?? []) as unknown as BreakageReportRow[];
    },
    staleTime: 60_000,
  });
}

export function useFileBreakageReport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (params: {
      factoryOrderItemId: string;
      quantityBroken: number;
      reasonCategory:
        | "crushed_in_transit"
        | "manufacturing_defect"
        | "wet_damage"
        | "contamination"
        | "other";
      description: string;
    }) => {
      const { data, error } = await supabase.rpc(
        "rpc_file_component_breakage_report",
        {
          p_factory_order_item_id: params.factoryOrderItemId,
          p_quantity_broken: params.quantityBroken,
          p_reason_category: params.reasonCategory,
          p_description: params.description,
        },
      );
      if (error) throw toError(error, "RPC call failed");
      return unwrap<RpcEnvelope & { breakage_report_id: string }>(data, "File breakage failed");
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: supplierQueryKeys.breakageReports }),
  });
}

export function useAcknowledgeBreakageReport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (params: { reportId: string; dispute?: boolean }) => {
      const { data, error } = await supabase.rpc(
        "rpc_acknowledge_breakage_report",
        { p_report_id: params.reportId, p_dispute: params.dispute ?? false },
      );
      if (error) throw toError(error, "RPC call failed");
      return unwrap<RpcEnvelope & { new_status: string }>(data, "Ack failed");
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: supplierQueryKeys.breakageReports }),
  });
}

export function useResolveBreakageReport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (params: {
      reportId: string;
      resolutionNotes: string;
      replacementFactoryOrderId?: string | null;
      writeOff?: boolean;
    }) => {
      const { data, error } = await supabase.rpc(
        "rpc_resolve_breakage_report",
        {
          p_report_id: params.reportId,
          p_resolution_notes: params.resolutionNotes,
          // SQL arg defaults to NULL; generated types don't preserve that.
          p_replacement_factory_order_id: (params.replacementFactoryOrderId ?? null) as string,
          p_write_off: params.writeOff ?? false,
        },
      );
      if (error) throw toError(error, "RPC call failed");
      return unwrap<RpcEnvelope & { final_status: string }>(data, "Resolve failed");
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: supplierQueryKeys.breakageReports }),
  });
}

// =============================================================
// Shipment variances
// =============================================================

export interface ShipmentVarianceRow {
  id: string;
  freight_line_item_id: string;
  shipment_id: string;
  sku_id: string;
  origin_supplier_id: string;
  declared_quantity: number;
  received_quantity: number;
  variance_quantity: number;
  variance_type: "shortage" | "overage" | "breakage_in_transit" | "damage" | "other";
  status: "open" | "acknowledged" | "resolved" | "written_off";
  notes: string | null;
  resolution_notes: string | null;
  acknowledged_at: string | null;
  resolved_at: string | null;
  created_at: string;
}

export function useShipmentVariances() {
  return useQuery({
    queryKey: supplierQueryKeys.variances,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("shipment_variances")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw toError(error, "RPC call failed");
      return (data ?? []) as unknown as ShipmentVarianceRow[];
    },
    staleTime: 60_000,
  });
}

export function useAcknowledgeShipmentVariance() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (params: { varianceId: string }) => {
      const { data, error } = await supabase.rpc(
        "rpc_acknowledge_shipment_variance",
        { p_variance_id: params.varianceId },
      );
      if (error) throw toError(error, "RPC call failed");
      return unwrap<RpcEnvelope>(data, "Ack variance failed");
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: supplierQueryKeys.variances }),
  });
}

export function useResolveShipmentVariance() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (params: {
      varianceId: string;
      resolutionNotes: string;
      writeOff?: boolean;
    }) => {
      const { data, error } = await supabase.rpc(
        "rpc_resolve_shipment_variance",
        {
          p_variance_id: params.varianceId,
          p_resolution_notes: params.resolutionNotes,
          p_write_off: params.writeOff ?? false,
        },
      );
      if (error) throw toError(error, "RPC call failed");
      return unwrap<RpcEnvelope & { final_status: string }>(data, "Resolve variance failed");
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: supplierQueryKeys.variances }),
  });
}

// =============================================================
// Admin supplier-user provisioning
// =============================================================

export function usePromoteUserToSupplier() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (params: { targetUserId: string; supplierId: string }) => {
      const { data, error } = await supabase.rpc(
        "rpc_promote_user_to_supplier",
        { p_target_user_id: params.targetUserId, p_supplier_id: params.supplierId },
      );
      if (error) throw toError(error, "RPC call failed");
      return unwrap<RpcEnvelope & { supplier_id: string }>(data, "Promote failed");
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["profiles"] }),
  });
}

export function useSetProfileActive() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (params: { targetUserId: string; isActive: boolean }) => {
      const { data, error } = await supabase.rpc(
        "rpc_set_profile_active",
        { p_target_user_id: params.targetUserId, p_is_active: params.isActive },
      );
      if (error) throw toError(error, "RPC call failed");
      return unwrap<RpcEnvelope & { is_active: boolean }>(data, "Set active failed");
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["profiles"] }),
  });
}
