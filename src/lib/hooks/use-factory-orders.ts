import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { supabaseUpdateWithVersion } from "@/lib/concurrency";
import type { FactoryOrder, FactoryOrderItem, ProductSKU } from "@/types/database";
import type { Database } from "@/lib/database.types";

type FactoryOrderInsert = Database["public"]["Tables"]["factory_orders"]["Insert"];
type FactoryOrderItemInsert = Database["public"]["Tables"]["factory_order_items"]["Insert"];

export type FactoryOrderItemWithProduct = FactoryOrderItem & { product: ProductSKU };
/**
 * Enriched shape used by the admin Factory Orders page. `supplier` is joined
 * from the suppliers table so we can render a label without a second query —
 * replaces the retired `factory: "nancy" | "yx"` column that used to live on
 * factory_orders (gone pre-020; drift was masked by hand-rolled types).
 *
 * `parent_factory_order_id` is read from migration 057's column. The admin
 * page uses it to find sibling child orders for the missing-component
 * warning; the supplier portal uses the RPC (cross-supplier visibility).
 * Cast through `& { parent_factory_order_id: string | null }` until the
 * generated types regen post-057-deploy.
 */
export type FactoryOrderWithItems = FactoryOrder & {
  items: FactoryOrderItemWithProduct[];
  supplier: { id: string; code: string; name: string } | null;
  parent_factory_order_id: string | null;
};

export function useFactoryOrders() {
  return useQuery({
    queryKey: ["factory-orders"],
    queryFn: async () => {
      // Disambiguate the FK explicitly: factory_orders has TWO FKs to
      // suppliers (supplier_id and ship_via_supplier_id from migration 020).
      // Without `!factory_orders_supplier_id_fkey`, PostgREST picks one
      // arbitrarily (or errors), which is why admin was missing rows that
      // supplier portals could see.
      const { data, error } = await supabase
        .from("factory_orders")
        .select(
          "*, items:factory_order_items(*, product:product_skus(*)), supplier:suppliers!factory_orders_supplier_id_fkey(id, code, name)",
        )
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data as unknown as FactoryOrderWithItems[];
    },
    // 30s is short enough that Nancy creating an order on one tab surfaces
    // on the admin tab with minimal lag; long enough not to hammer the API.
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
}

export function useCreateFactoryOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (payload: {
      // Use the generated Insert types so any drift (column renames, added
      // NOT NULL fields) surfaces here instead of silently dropping data.
      // Caller omits factory_order_id on items — we set it from the inserted
      // order row below.
      order: Omit<FactoryOrderInsert, "id" | "created_at" | "updated_at" | "row_version">;
      items: Omit<FactoryOrderItemInsert, "id" | "factory_order_id" | "created_at" | "row_version">[];
    }) => {
      const { data: orderData, error: orderErr } = await supabase
        .from("factory_orders")
        .insert(payload.order)
        .select()
        .single();
      if (orderErr) throw orderErr;
      const order = orderData as unknown as FactoryOrder;

      if (payload.items.length > 0) {
        const rows: FactoryOrderItemInsert[] = payload.items.map((i) => ({
          ...i,
          factory_order_id: order.id,
        }));
        const { error: itemErr } = await supabase
          .from("factory_order_items")
          .insert(rows);
        if (itemErr) throw itemErr;
      }
      return order;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["factory-orders"] }),
  });
}

export function useUpdateFactoryOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (params: {
      id: string;
      updates: Partial<FactoryOrder>;
      expectedVersion?: number;
    }) => {
      return supabaseUpdateWithVersion(
        supabase,
        "factory_orders",
        params.id,
        params.expectedVersion ?? null,
        params.updates as Record<string, unknown>,
      );
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["factory-orders"] }),
  });
}

// ---------------------------------------------------------------------------
// BoM-aware ordering — migration 057
// ---------------------------------------------------------------------------

/**
 * Active produced-component BoM rows. Used by the admin FactoryOrders page
 * (and the Nancy supplier portal) to compute "expected components" for a
 * given parent order's line items, without an N+1 RPC call across orders.
 *
 * RLS on product_boms (migration 020) lets internal users see all rows and
 * suppliers see rows where they're the assembler — Nancy gets her own
 * compound-SKU rows automatically. Component_type is filtered to
 * `produced` because consumable_inventory components (e.g. koozies)
 * don't trigger child factory_orders.
 */
export interface ProductBomRow {
  id: string;
  parent_sku_id: string;
  component_sku_id: string;
  units_per_parent: number;
  component_type: "produced" | "consumable_inventory";
  assembled_at_supplier_id: string;
}

export function useProductBoms() {
  return useQuery({
    queryKey: ["product-boms", "active-produced"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("product_boms")
        .select("id, parent_sku_id, component_sku_id, units_per_parent, component_type, assembled_at_supplier_id")
        .is("effective_until", null)
        .eq("component_type", "produced");
      if (error) throw error;
      return (data ?? []) as ProductBomRow[];
    },
    staleTime: 5 * 60_000, // BoMs rarely change; 5 min is safe.
  });
}

/**
 * Calls `rpc_factory_order_component_status` (migration 057). Returns
 * BoM-derived expected components plus actual child orders for one
 * factory_order. Used by:
 *   - the admin order detail / linker UI (full child detail), and
 *   - the Nancy supplier portal (cross-supplier visibility into YX
 *     child orders that her direct read path can't reach via RLS).
 */
export interface FactoryOrderComponentStatus {
  expected_components: Array<{
    component_sku_id: string;
    component_sku: string;
    quantity_needed: number;
  }>;
  child_orders: Array<{
    id: string;
    order_number: string | null;
    supplier_id: string;
    supplier_code: string;
    supplier_name: string;
    status: string;
    order_date: string | null;
    expected_completion: string | null;
    components: Array<{
      sku_id: string;
      sku: string;
      quantity_ordered: number;
      quantity_finished: number;
    }>;
  }>;
}

export function useFactoryOrderComponentStatus(orderId: string | null) {
  return useQuery({
    queryKey: ["factory-order-component-status", orderId],
    queryFn: async () => {
      if (!orderId) return null;
      const { data, error } = await supabase.rpc(
        "rpc_factory_order_component_status",
        { p_factory_order_id: orderId },
      );
      if (error) throw error;
      return data as unknown as FactoryOrderComponentStatus;
    },
    enabled: !!orderId,
    staleTime: 30_000,
  });
}

/**
 * Batch variant — takes an array of parent factory_order_ids and returns
 * a Map keyed by id. Used by the FactoryOrders list pages (admin + Nancy
 * supplier portal) to render per-SKU missing-component icons inline.
 *
 * Single round trip via `rpc_factory_order_component_status_batch`
 * (migration 058). Server filters the requested ids down to those the
 * caller can see — supplier callers get only their own orders, internal
 * staff get everything; orders silently omitted are simply absent from
 * the returned Map (callers should treat absence as "no data,
 * render no warning").
 *
 * The query is keyed by the SORTED join of the input ids so list-order
 * shuffles don't cause cache-invalidating churn.
 */
export function useFactoryOrderComponentStatusBatch(orderIds: string[]) {
  const sortedKey = [...orderIds].sort().join(",");
  return useQuery({
    queryKey: ["factory-order-component-status-batch", sortedKey],
    queryFn: async () => {
      if (orderIds.length === 0) return new Map<string, FactoryOrderComponentStatus>();
      const { data, error } = await supabase.rpc(
        "rpc_factory_order_component_status_batch",
        { p_parent_order_ids: orderIds },
      );
      if (error) throw error;
      const obj = (data ?? {}) as Record<string, FactoryOrderComponentStatus>;
      return new Map(Object.entries(obj));
    },
    enabled: orderIds.length > 0,
    staleTime: 30_000,
  });
}

/**
 * Given a per-order component status (from the RPC) and a specific SKU id
 * on that order, return whether that SKU has any missing components and
 * the per-component shortfall details. Used by the per-SKU warning icon
 * on the list pages — answers "should I render a warning by *this* SKU
 * row, and if so what?".
 *
 * "Missing" means: this SKU has BoM-driven produced components AND the
 * sum of linked child orders' line items for those components is below
 * the parent's needed quantity (line.quantity_ordered × units_per_parent
 * for each matching BoM row).
 */
export function missingComponentsForSku(
  parentSkuId: string,
  parentLineItemQty: number,
  status: FactoryOrderComponentStatus | null | undefined,
  boms: ProductBomRow[],
): Array<{
  componentSkuId: string;
  componentSku: string;
  qtyNeeded: number;
  qtyOrdered: number;
  qtyShort: number;
}> {
  if (!status) return [];
  const matchingBoms = boms.filter(
    (b) => b.parent_sku_id === parentSkuId && b.component_type === "produced",
  );
  if (matchingBoms.length === 0) return [];

  // Roll up child orders' quantities per component sku id.
  const orderedBySku = new Map<string, number>();
  for (const co of status.child_orders) {
    for (const c of co.components ?? []) {
      orderedBySku.set(
        c.sku_id,
        (orderedBySku.get(c.sku_id) ?? 0) + c.quantity_ordered,
      );
    }
  }

  // Look up component sku codes from expected_components (server-resolved).
  const expectedSkuById = new Map<string, string>();
  for (const e of status.expected_components) {
    expectedSkuById.set(e.component_sku_id, e.component_sku);
  }

  const out: Array<{
    componentSkuId: string;
    componentSku: string;
    qtyNeeded: number;
    qtyOrdered: number;
    qtyShort: number;
  }> = [];
  for (const b of matchingBoms) {
    const need = parentLineItemQty * b.units_per_parent;
    const ordered = orderedBySku.get(b.component_sku_id) ?? 0;
    if (ordered < need) {
      out.push({
        componentSkuId: b.component_sku_id,
        componentSku: expectedSkuById.get(b.component_sku_id) ?? "?",
        qtyNeeded: need,
        qtyOrdered: ordered,
        qtyShort: need - ordered,
      });
    }
  }
  return out;
}

/** Admin-only: link a child factory_order to its parent. */
export function useLinkFactoryOrderToParent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (params: { childOrderId: string; parentOrderId: string }) => {
      const { error } = await supabase.rpc("rpc_admin_link_factory_order_to_parent", {
        p_child_order_id: params.childOrderId,
        p_parent_order_id: params.parentOrderId,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["factory-orders"] });
      qc.invalidateQueries({ queryKey: ["factory-order-component-status"] });
    },
  });
}

/** Admin-only: break a child factory_order's link to its parent. */
export function useUnlinkFactoryOrderFromParent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (params: { childOrderId: string }) => {
      const { error } = await supabase.rpc("rpc_admin_unlink_factory_order_from_parent", {
        p_child_order_id: params.childOrderId,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["factory-orders"] });
      qc.invalidateQueries({ queryKey: ["factory-order-component-status"] });
    },
  });
}

// ---------------------------------------------------------------------------
// Pure helpers for client-side missing-component detection
// ---------------------------------------------------------------------------

/**
 * Given a parent factory_order, the full set of factory_orders, and the
 * active produced BoM rows, return the list of missing components (rolled
 * up by component SKU). A component is "missing" if the required quantity
 * (sum of parent line items × units_per_parent) exceeds the quantity
 * already ordered across all child factory_orders linked to this parent.
 *
 * Returns an empty array for orders with no BoM-driven components — those
 * are the simple/non-compound SKUs and never need a sibling order.
 */
export function computeMissingComponents(
  order: FactoryOrderWithItems,
  allOrders: FactoryOrderWithItems[],
  boms: ProductBomRow[],
): Array<{
  componentSkuId: string;
  qtyNeeded: number;
  qtyOrdered: number;
  qtyShort: number;
}> {
  // expectedBySku: rolled-up quantity needed across all line items on this
  // parent. Multiple items may reference the same component SKU (e.g. two
  // line items of BW58 each needing 1× HT10) — sum into a single bucket.
  const expectedBySku = new Map<string, number>();
  for (const item of order.items) {
    const matchingBoms = boms.filter((b) => b.parent_sku_id === item.sku_id);
    for (const b of matchingBoms) {
      const need = item.quantity_ordered * b.units_per_parent;
      expectedBySku.set(
        b.component_sku_id,
        (expectedBySku.get(b.component_sku_id) ?? 0) + need,
      );
    }
  }
  if (expectedBySku.size === 0) return [];

  // orderedBySku: aggregate child orders' line item quantities for each
  // component SKU. Only counts child orders that are actually linked to
  // THIS parent — unlinked orders for the same SKU don't satisfy the
  // requirement.
  const orderedBySku = new Map<string, number>();
  for (const c of allOrders) {
    if (c.parent_factory_order_id !== order.id) continue;
    for (const ci of c.items) {
      orderedBySku.set(
        ci.sku_id,
        (orderedBySku.get(ci.sku_id) ?? 0) + ci.quantity_ordered,
      );
    }
  }

  const missing: Array<{
    componentSkuId: string;
    qtyNeeded: number;
    qtyOrdered: number;
    qtyShort: number;
  }> = [];
  for (const [skuId, need] of expectedBySku) {
    const ordered = orderedBySku.get(skuId) ?? 0;
    if (ordered < need) {
      missing.push({
        componentSkuId: skuId,
        qtyNeeded: need,
        qtyOrdered: ordered,
        qtyShort: need - ordered,
      });
    }
  }
  return missing;
}
