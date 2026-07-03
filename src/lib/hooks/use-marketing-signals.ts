import { useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";

/**
 * Marketing → ops signal layer (plan v0.3.1 §0.2).
 *
 * useUpcomingMarketingBySku answers "does this SKU have a sale or launch
 * coming up?" for the ops surfaces (Stock Levels rows, New Factory Order
 * dialog, order builder). Sales resolve through the mkt_offer_sku_expansion
 * view, so sitewide/category offers correctly fan out to concrete SKUs.
 *
 * Approval mutations implement the draft → proposed → confirmed track on
 * sales and launches; 'confirmed' stamps who/when (and is what will later
 * gate an event's uplift into the forecast overlay — Phase C).
 */

export type ApprovalStatus = "draft" | "proposed" | "confirmed";

export interface SkuSaleSignal {
  sale_id: string;
  sale_name: string;
  starts_at: string;
  ends_at: string;
  approval_status: ApprovalStatus;
  effective_discount_pct: number | null;
  uplift_pct: number | null;
}
export interface SkuLaunchSignal {
  launch_id: string;
  name: string;
  launch_date: string;
  approval_status: ApprovalStatus;
}
export interface SkuMarketingSignals {
  sales: SkuSaleSignal[];
  launches: SkuLaunchSignal[];
}

const DAY_MS = 86_400_000;

/** sku_id -> upcoming sales/launches within the horizon (default 60 days). */
export function useUpcomingMarketingBySku(horizonDays = 60) {
  const { data: saleRows } = useQuery({
    queryKey: ["mkt-expansion-upcoming", horizonDays],
    queryFn: async () => {
      const nowIso = new Date().toISOString();
      const horizonIso = new Date(Date.now() + horizonDays * DAY_MS).toISOString();
      const { data, error } = await supabase
        .from("mkt_offer_sku_expansion")
        .select("sku_id, sale_id, sale_name, starts_at, ends_at, approval_status, effective_discount_pct, uplift_pct")
        .gte("ends_at", nowIso)
        .lte("starts_at", horizonIso);
      if (error) throw error;
      return data ?? [];
    },
    staleTime: 5 * 60 * 1000,
  });

  const { data: launchRows } = useQuery({
    queryKey: ["mkt-launch-skus-upcoming", horizonDays],
    queryFn: async () => {
      const today = new Date().toISOString().slice(0, 10);
      const horizon = new Date(Date.now() + horizonDays * DAY_MS).toISOString().slice(0, 10);
      // !inner so the launch-date filter constrains the member rows.
      const { data, error } = await supabase
        .from("mkt_launch_skus")
        .select("sku_id, launch:mkt_launches!inner(id, name, launch_date, approval_status)")
        .not("sku_id", "is", null)
        .gte("launch.launch_date", today)
        .lte("launch.launch_date", horizon);
      if (error) throw error;
      return data ?? [];
    },
    staleTime: 5 * 60 * 1000,
  });

  return useMemo(() => {
    const map = new Map<string, SkuMarketingSignals>();
    const entry = (skuId: string) => {
      let e = map.get(skuId);
      if (!e) { e = { sales: [], launches: [] }; map.set(skuId, e); }
      return e;
    };
    for (const r of saleRows ?? []) {
      // View columns are typed nullable (Postgres views drop NOT NULL);
      // rows from real joins always carry these, so skip any that don't.
      if (!r.sku_id || !r.sale_id || !r.sale_name || !r.starts_at || !r.ends_at) continue;
      const e = entry(r.sku_id);
      // One sale can reach a SKU via several offers — dedupe per sale.
      if (!e.sales.some((s) => s.sale_id === r.sale_id)) {
        e.sales.push({
          sale_id: r.sale_id,
          sale_name: r.sale_name,
          starts_at: r.starts_at,
          ends_at: r.ends_at,
          approval_status: (r.approval_status ?? "draft") as ApprovalStatus,
          effective_discount_pct: r.effective_discount_pct,
          uplift_pct: r.uplift_pct,
        });
      }
    }
    for (const r of launchRows ?? []) {
      if (!r.sku_id || !r.launch) continue;
      const l = r.launch as unknown as { id: string; name: string; launch_date: string; approval_status: ApprovalStatus };
      const e = entry(r.sku_id);
      if (!e.launches.some((x) => x.launch_id === l.id)) {
        e.launches.push({ launch_id: l.id, name: l.name, launch_date: l.launch_date, approval_status: l.approval_status });
      }
    }
    return map;
  }, [saleRows, launchRows]);
}

/** Compact human line for badge tooltips: "SALE July 4th Jun 29–Jul 3 (20% off) · LAUNCH X on Aug 1". */
export function describeSkuSignals(sig: SkuMarketingSignals): string {
  const d = (iso: string) =>
    new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const parts: string[] = [];
  for (const s of sig.sales) {
    const depth = s.effective_discount_pct != null ? ` (${s.effective_discount_pct}% off)` : "";
    const pending = s.approval_status !== "confirmed" ? " [not ops-confirmed]" : "";
    parts.push(`SALE ${s.sale_name} ${d(s.starts_at)}–${d(s.ends_at)}${depth}${pending}`);
  }
  for (const l of sig.launches) {
    const pending = l.approval_status !== "confirmed" ? " [not ops-confirmed]" : "";
    parts.push(`LAUNCH ${l.name} on ${d(l.launch_date + "T12:00:00Z")}${pending}`);
  }
  return parts.join("  ·  ");
}

function useSetApproval(table: "mkt_sales" | "mkt_launches", listKey: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (params: { id: string; status: ApprovalStatus; actorId: string }) => {
      const { id, status, actorId } = params;
      const { error } = await supabase
        .from(table)
        .update({
          approval_status: status,
          ops_confirmed_by: status === "confirmed" ? actorId : null,
          ops_confirmed_at: status === "confirmed" ? new Date().toISOString() : null,
        })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [listKey] });
      qc.invalidateQueries({ queryKey: ["mkt-expansion-upcoming"] });
      qc.invalidateQueries({ queryKey: ["mkt-launch-skus-upcoming"] });
    },
  });
}

export function useSetSaleApproval() {
  return useSetApproval("mkt_sales", "mkt-sales");
}
export function useSetLaunchApproval() {
  return useSetApproval("mkt_launches", "mkt-launches");
}
