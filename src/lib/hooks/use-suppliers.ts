import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";

/**
 * Supplier directory for internal admin flows. This is a thin wrapper over
 * the `suppliers` table — visibility is broad (all authenticated users can
 * SELECT suppliers because the table has an "authenticated" SELECT policy
 * from migration 017) but writes are admin-only via the "Admins can manage
 * suppliers" policy.
 *
 * Supplier users have a narrower SELECT policy (`supplier_select_in_scope`
 * from migration 020) that limits them to their own scope. This hook is
 * intended for the admin UI.
 */

export interface SupplierRow {
  id: string;
  code: string;
  name: string;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  country: string;
  default_lead_time_days: number | null;
  payment_terms: string | null;
  invoice_currency: string;
  notes: string | null;
  is_active: boolean;
  is_producer: boolean;
  is_filler: boolean;
  is_export_broker: boolean;
  consolidates_for: string[];
  created_at: string;
  updated_at: string;
  row_version: number;
}

export const supplierKeys = {
  all: ["suppliers"] as const,
  active: ["suppliers", "active"] as const,
};

export function useSuppliers(opts: { activeOnly?: boolean } = {}) {
  const { activeOnly = false } = opts;
  return useQuery({
    queryKey: activeOnly ? supplierKeys.active : supplierKeys.all,
    queryFn: async () => {
      let q = supabase.from("suppliers").select("*").order("name");
      if (activeOnly) q = q.eq("is_active", true);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as unknown as SupplierRow[];
    },
    staleTime: 5 * 60 * 1000,
  });
}

/**
 * Create a new supplier. Admin-only (enforced by RLS on the table). Returns
 * the created row so the caller can immediately use the new UUID.
 *
 * `code` must be unique. Capability flags default matches the suppliers
 * table's own defaults (is_producer=true, is_filler=false, is_export_broker=false).
 */
export function useCreateSupplier() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      code: string;
      name: string;
      country?: string;
      contactName?: string | null;
      contactEmail?: string | null;
      contactPhone?: string | null;
      defaultLeadTimeDays?: number | null;
      paymentTerms?: string | null;
      invoiceCurrency?: string;
      notes?: string | null;
      isProducer?: boolean;
      isFiller?: boolean;
      isExportBroker?: boolean;
    }) => {
      const row = {
        code: input.code.trim(),
        name: input.name.trim(),
        country: input.country ?? "CN",
        contact_name: input.contactName ?? null,
        contact_email: input.contactEmail ?? null,
        contact_phone: input.contactPhone ?? null,
        default_lead_time_days: input.defaultLeadTimeDays ?? null,
        payment_terms: input.paymentTerms ?? null,
        invoice_currency: input.invoiceCurrency ?? "USD",
        notes: input.notes ?? null,
        is_active: true,
        is_producer: input.isProducer ?? true,
        is_filler: input.isFiller ?? false,
        is_export_broker: input.isExportBroker ?? false,
      };
      const { data, error } = await supabase
        .from("suppliers")
        .insert(row)
        .select()
        .single();
      if (error) throw error;
      return data as unknown as SupplierRow;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: supplierKeys.all }),
  });
}

export function useUpdateSupplierActive() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (params: { id: string; isActive: boolean }) => {
      const { error } = await supabase
        .from("suppliers")
        .update({ is_active: params.isActive })
        .eq("id", params.id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: supplierKeys.all }),
  });
}

/** One supplier by id. Returns null while loading or if not found. */
export function useSupplier(id: string | null | undefined) {
  return useQuery({
    queryKey: id ? ["suppliers", "one", id] : ["suppliers", "one", "none"],
    enabled: !!id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("suppliers")
        .select("*")
        .eq("id", id!)
        .single();
      if (error) throw error;
      return data as unknown as SupplierRow;
    },
    staleTime: 60_000,
  });
}

/** Partial update — admin-only via RLS. */
export function useUpdateSupplier() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (params: {
      id: string;
      updates: Partial<{
        name: string;
        contact_name: string | null;
        contact_email: string | null;
        contact_phone: string | null;
        country: string;
        default_lead_time_days: number | null;
        payment_terms: string | null;
        invoice_currency: string;
        notes: string | null;
        is_producer: boolean;
        is_filler: boolean;
        is_export_broker: boolean;
      }>;
    }) => {
      const { error } = await supabase
        .from("suppliers")
        .update(params.updates)
        .eq("id", params.id);
      if (error) throw error;
    },
    onSuccess: (_data, params) => {
      qc.invalidateQueries({ queryKey: supplierKeys.all });
      qc.invalidateQueries({ queryKey: ["suppliers", "one", params.id] });
    },
  });
}

// =============================================================
// Supplier stats — COO-level rollups across orders / items / quality
// =============================================================

export interface SupplierStats {
  /** Count of non-canceled, non-shipped orders. */
  activeOrders: number;
  /** Sum of (unit_cost × quantity_ordered) across active orders. */
  openOrderValue: number;
  /** Count of items past effective ETA and not yet received. */
  overdueItems: number;
  /**
   * On-time delivery rate over the last 90 days, as a 0-1 fraction.
   * Measured against items that were confirmed-received in that window —
   * an item is "on-time" if confirmed_at <= effective ETA (alt or parent).
   * Returns null if fewer than 3 samples exist (noise floor).
   */
  onTimeRate: number | null;
  /**
   * Breakage rate over the last 90 days, as a 0-1 fraction.
   * quantity_breakage / consolidator_confirmed_quantity across that window.
   * Returns null if fewer than 3 samples.
   */
  breakageRate: number | null;
  /**
   * Average actual lead time (days), measured as order_date → latest
   * consolidator_confirmed_at, over orders fully received in the last 90d.
   * Returns null if fewer than 3 samples.
   */
  avgLeadTimeDays: number | null;
  /** Number of open (non-resolved) breakage reports against this supplier. */
  openBreakageReports: number;
  /** Number of open (non-resolved) variances against this supplier. */
  openVariances: number;
  /**
   * Monthly throughput and on-time rate for the trailing 6 calendar months.
   * Each row is keyed by YYYY-MM. `received` counts items with a
   * consolidator_confirmed_at in that month; `onTimeRate` is same-month ratio
   * or null when there's no receives.
   */
  monthly: Array<{ month: string; received: number; onTimeRate: number | null }>;
  /**
   * Per-SKU totals the supplier has produced in the last 365 days. Sorted
   * descending by quantity. `lastOrdered` is YYYY-MM-DD of the most recent
   * order_date touching this SKU.
   */
  skuPortfolio: Array<{
    sku_id: string;
    totalOrdered: number;
    totalConfirmed: number;
    totalValue: number;
    lastOrdered: string | null;
  }>;
}

/**
 * Spend concentration across all suppliers — shows what share of our total
 * factory-order spend (last 365 days, by unit_cost × quantity_ordered) goes
 * to each supplier. Useful as a concentration-risk signal on the detail page
 * and as a leaderboard on a future dashboard.
 */
export function useSupplierSpendShares() {
  return useQuery({
    queryKey: ["suppliers", "spend-shares"],
    queryFn: async () => {
      const oneYearAgoDate = new Date(Date.now() - 365 * 86400_000).toISOString().slice(0, 10);
      const { data, error } = await supabase
        .from("factory_orders")
        .select("supplier_id, order_date, items:factory_order_items(unit_cost, quantity_ordered)")
        .gte("order_date", oneYearAgoDate);
      if (error) throw error;
      type Row = {
        supplier_id: string | null;
        order_date: string | null;
        items: Array<{ unit_cost: number | null; quantity_ordered: number }>;
      };
      const rows = (data ?? []) as unknown as Row[];
      const totals = new Map<string, number>();
      let grand = 0;
      for (const r of rows) {
        if (!r.supplier_id) continue;
        const lineTotal = (r.items ?? []).reduce(
          (s, i) => s + (i.unit_cost ?? 0) * i.quantity_ordered,
          0,
        );
        totals.set(r.supplier_id, (totals.get(r.supplier_id) ?? 0) + lineTotal);
        grand += lineTotal;
      }
      return {
        totalSpend: grand,
        bySupplier: totals, // map<supplier_id, spend>
      };
    },
    staleTime: 5 * 60 * 1000,
  });
}

/**
 * Freight shipments declared by a specific supplier (origin_supplier_id).
 * Used on the supplier detail page to show broker activity. Returns null
 * when no supplier_id is provided.
 */
export function useSupplierShipments(supplierId: string | null | undefined) {
  return useQuery({
    queryKey: ["suppliers", "shipments", supplierId],
    enabled: !!supplierId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("freight_shipments")
        .select(
          "id, shipment_number, status, carrier_name, tracking_number, ship_date, eta, eta_original, actual_arrival_date, total_cartons, created_at",
        )
        .eq("origin_supplier_id", supplierId!)
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      return (data ?? []) as unknown as Array<{
        id: string;
        shipment_number: string | null;
        status: string;
        carrier_name: string | null;
        tracking_number: string | null;
        ship_date: string | null;
        eta: string | null;
        eta_original: string | null;
        actual_arrival_date: string | null;
        total_cartons: number | null;
        created_at: string;
      }>;
    },
    staleTime: 60_000,
  });
}

/**
 * Audit trail filtered to a specific supplier. Returns entries where the
 * supplier is either the actor (a supplier user did the action) OR the
 * target_table is one of the supplier-relevant tables AND the target_id
 * resolves to something owned by this supplier. The second cut is harder
 * to enforce in SQL without a supplier_id column on audit_logs, so this
 * MVP version just surfaces entries whose action name contains a
 * supplier-relevant verb plus actor-scoped entries. Good enough for
 * "what did this supplier just do?" — a proper supplier_id on audit_logs
 * is a follow-up if we need more precision.
 */
export function useSupplierAuditTrail(supplierId: string | null | undefined) {
  return useQuery({
    queryKey: ["suppliers", "audit-trail", supplierId],
    enabled: !!supplierId,
    queryFn: async () => {
      if (!supplierId) return [];
      // Find profile ids linked to this supplier first so we can filter by actor.
      const { data: linkedProfiles } = await supabase
        .from("profiles")
        .select("id")
        .eq("supplier_id", supplierId);
      const actorIds = (linkedProfiles ?? []).map((p) => (p as { id: string }).id);

      // Pull recent activity for those actors. Supplier-role users are scoped
      // by the existing "supplier_select_own_audit_logs" policy for themselves
      // only — admins (this page) see all via "internal_select_audit_logs".
      if (actorIds.length === 0) {
        return [] as Array<{
          id: string;
          actor_id: string | null;
          action: string;
          target_table: string;
          target_id: string;
          details: Record<string, unknown>;
          created_at: string;
        }>;
      }
      const { data, error } = await supabase
        .from("audit_logs")
        .select("id, actor_id, action, target_table, target_id, details, created_at")
        .in("actor_id", actorIds)
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      return (data ?? []) as unknown as Array<{
        id: string;
        actor_id: string | null;
        action: string;
        target_table: string;
        target_id: string;
        details: Record<string, unknown>;
        created_at: string;
      }>;
    },
    staleTime: 60_000,
  });
}

/**
 * Aggregate supplier-level KPIs. Pulls factory_orders + items, plus any
 * breakage / variance rows pointing at this supplier, then computes stats
 * client-side. Acceptable for the MVP volume; if the dataset grows past a
 * few thousand rows per supplier this should move to a SQL view or RPC.
 */
export function useSupplierStats(supplierId: string | null | undefined) {
  return useQuery({
    queryKey: ["suppliers", "stats", supplierId],
    enabled: !!supplierId,
    queryFn: async (): Promise<SupplierStats> => {
      const ninetyDaysAgo = new Date(Date.now() - 90 * 86400_000).toISOString();

      const [ordersRes, breakageRes, variancesRes] = await Promise.all([
        supabase
          .from("factory_orders")
          .select(
            "id, status, order_date, expected_completion, row_version, items:factory_order_items(id, sku_id, quantity_ordered, unit_cost, consolidator_confirmed_quantity, consolidator_confirmed_at, quantity_breakage, alternate_expected_completion)",
          )
          .eq("supplier_id", supplierId!),
        supabase
          .from("component_breakage_reports")
          .select("id, status")
          .eq("producing_supplier_id", supplierId!),
        supabase
          .from("shipment_variances")
          .select("id, status")
          .eq("origin_supplier_id", supplierId!),
      ]);
      if (ordersRes.error) throw ordersRes.error;
      if (breakageRes.error) throw breakageRes.error;
      if (variancesRes.error) throw variancesRes.error;

      type OrderRow = {
        id: string;
        status: string;
        order_date: string;
        expected_completion: string | null;
        row_version: number;
        items: Array<{
          id: string;
          sku_id: string;
          quantity_ordered: number;
          unit_cost: number | null;
          consolidator_confirmed_quantity: number | null;
          consolidator_confirmed_at: string | null;
          quantity_breakage: number;
          alternate_expected_completion: string | null;
        }>;
      };
      const orders = (ordersRes.data ?? []) as unknown as OrderRow[];
      const todayIso = new Date().toISOString().slice(0, 10);

      let activeOrders = 0;
      let openOrderValue = 0;
      let overdueItems = 0;

      let onTimeHits = 0;
      let onTimeTotal = 0;
      let breakageSumBroken = 0;
      let breakageSumConfirmed = 0;
      let leadTimeSumDays = 0;
      let leadTimeTotal = 0;

      for (const o of orders) {
        const terminal = o.status === "canceled" || o.status === "shipped";
        if (!terminal) activeOrders += 1;

        // Per-order latest confirmed_at — used for lead time.
        let latestConfirmedAt: string | null = null;
        let allItemsConfirmed = (o.items ?? []).length > 0;

        for (const it of o.items ?? []) {
          // Open order $ value (only active orders contribute).
          if (!terminal && it.consolidator_confirmed_quantity === null) {
            openOrderValue += (it.unit_cost ?? 0) * it.quantity_ordered;
          }

          // Effective ETA for overdue + on-time math.
          const effectiveEta = it.alternate_expected_completion ?? o.expected_completion ?? null;

          // Overdue count.
          if (
            !terminal &&
            it.consolidator_confirmed_quantity === null &&
            effectiveEta !== null &&
            effectiveEta < todayIso
          ) {
            overdueItems += 1;
          }

          // On-time sampling: items confirmed in the last 90 days.
          if (
            it.consolidator_confirmed_at !== null &&
            it.consolidator_confirmed_at >= ninetyDaysAgo &&
            effectiveEta !== null
          ) {
            onTimeTotal += 1;
            const confirmedDateOnly = it.consolidator_confirmed_at.slice(0, 10);
            if (confirmedDateOnly <= effectiveEta) onTimeHits += 1;
          }

          // Breakage sampling: items confirmed in the last 90 days.
          if (
            it.consolidator_confirmed_at !== null &&
            it.consolidator_confirmed_at >= ninetyDaysAgo &&
            it.consolidator_confirmed_quantity !== null &&
            it.consolidator_confirmed_quantity > 0
          ) {
            breakageSumConfirmed += it.consolidator_confirmed_quantity;
            breakageSumBroken += it.quantity_breakage;
          }

          if (it.consolidator_confirmed_quantity === null) {
            allItemsConfirmed = false;
          } else if (
            it.consolidator_confirmed_at !== null &&
            (latestConfirmedAt === null || it.consolidator_confirmed_at > latestConfirmedAt)
          ) {
            latestConfirmedAt = it.consolidator_confirmed_at;
          }
        }

        // Lead time sampling: orders fully received in the last 90 days.
        if (
          allItemsConfirmed &&
          latestConfirmedAt !== null &&
          latestConfirmedAt >= ninetyDaysAgo
        ) {
          const orderDateMs = new Date(o.order_date).getTime();
          const confirmedMs = new Date(latestConfirmedAt).getTime();
          const days = (confirmedMs - orderDateMs) / 86400_000;
          if (days >= 0) {
            leadTimeSumDays += days;
            leadTimeTotal += 1;
          }
        }
      }

      const openBreakageReports = (breakageRes.data ?? []).filter(
        (r) => (r as { status: string }).status !== "resolved" && (r as { status: string }).status !== "written_off",
      ).length;
      const openVariances = (variancesRes.data ?? []).filter(
        (v) => (v as { status: string }).status !== "resolved" && (v as { status: string }).status !== "written_off",
      ).length;

      // Monthly throughput + on-time for the trailing 6 calendar months
      // (including the current month). Keyed by YYYY-MM so the chart reads
      // left-to-right in chronological order.
      const monthKey = (d: Date) =>
        `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
      const now = new Date();
      const months: string[] = [];
      for (let i = 5; i >= 0; i--) {
        const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
        months.push(monthKey(d));
      }
      const monthlyBuckets = new Map<string, { received: number; onHits: number; onTotal: number }>();
      months.forEach((m) => monthlyBuckets.set(m, { received: 0, onHits: 0, onTotal: 0 }));

      // Per-SKU portfolio for the trailing 365 days. Keyed by sku_id.
      const oneYearAgoDate = new Date(Date.now() - 365 * 86400_000).toISOString().slice(0, 10);
      const portfolio = new Map<
        string,
        { totalOrdered: number; totalConfirmed: number; totalValue: number; lastOrdered: string | null }
      >();

      for (const o of orders) {
        for (const it of o.items ?? []) {
          // Portfolio: scope to last-year orders.
          if (o.order_date && o.order_date >= oneYearAgoDate) {
            const entry = portfolio.get(it.sku_id) ?? {
              totalOrdered: 0,
              totalConfirmed: 0,
              totalValue: 0,
              lastOrdered: null as string | null,
            };
            entry.totalOrdered += it.quantity_ordered;
            entry.totalConfirmed += it.consolidator_confirmed_quantity ?? 0;
            entry.totalValue += (it.unit_cost ?? 0) * it.quantity_ordered;
            if (entry.lastOrdered === null || o.order_date > entry.lastOrdered) {
              entry.lastOrdered = o.order_date;
            }
            portfolio.set(it.sku_id, entry);
          }

          // Monthly: bucket by consolidator_confirmed_at's YYYY-MM.
          if (it.consolidator_confirmed_at !== null) {
            const confirmedDate = new Date(it.consolidator_confirmed_at);
            const key = monthKey(confirmedDate);
            const bucket = monthlyBuckets.get(key);
            if (bucket) {
              bucket.received += 1;
              const effectiveEta = it.alternate_expected_completion ?? o.expected_completion ?? null;
              if (effectiveEta !== null) {
                bucket.onTotal += 1;
                const confirmedDateOnly = it.consolidator_confirmed_at.slice(0, 10);
                if (confirmedDateOnly <= effectiveEta) bucket.onHits += 1;
              }
            }
          }
        }
      }

      const monthly = months.map((m) => {
        const b = monthlyBuckets.get(m)!;
        return {
          month: m,
          received: b.received,
          onTimeRate: b.onTotal > 0 ? b.onHits / b.onTotal : null,
        };
      });

      const skuPortfolio = Array.from(portfolio.entries())
        .map(([sku_id, v]) => ({ sku_id, ...v }))
        .sort((a, b) => b.totalOrdered - a.totalOrdered);

      const SAMPLE_FLOOR = 3;
      return {
        activeOrders,
        openOrderValue,
        overdueItems,
        onTimeRate: onTimeTotal >= SAMPLE_FLOOR ? onTimeHits / onTimeTotal : null,
        breakageRate:
          breakageSumConfirmed >= SAMPLE_FLOOR
            ? breakageSumBroken / breakageSumConfirmed
            : null,
        avgLeadTimeDays:
          leadTimeTotal >= SAMPLE_FLOOR ? leadTimeSumDays / leadTimeTotal : null,
        openBreakageReports,
        openVariances,
        monthly,
        skuPortfolio,
      };
    },
    staleTime: 60_000,
  });
}
