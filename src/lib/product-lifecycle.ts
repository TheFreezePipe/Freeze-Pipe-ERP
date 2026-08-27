/**
 * Product lifecycle from the two product_skus flags.
 *
 *   active     — is_active, no archived_at: the normal catalog.
 *   pre_launch — !is_active, no archived_at: created by PD promotion
 *                (rpc_pd_promote_product). Orderable and costed, but kept
 *                off stock / forecast surfaces until its first factory-order
 *                line activates it (trg_activate_sku_on_order) or an admin
 *                clicks Activate on the SKU detail page.
 *   archived   — archived_at stamped by the archive_sku RPCs.
 */
import type { ProductSKU } from "@/types/database";

export type ProductLifecycle = "active" | "pre_launch" | "archived";

/** The legacy ProductSKU type predates the archived_at column. */
type WithArchivedAt = { archived_at?: string | null };

export function productLifecycle(p: Pick<ProductSKU, "is_active">): ProductLifecycle {
  if ((p as WithArchivedAt).archived_at) return "archived";
  return p.is_active ? "active" : "pre_launch";
}

export function isPreLaunch(p: Pick<ProductSKU, "is_active">): boolean {
  return productLifecycle(p) === "pre_launch";
}
