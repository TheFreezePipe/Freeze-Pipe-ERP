/**
 * Domain type aliases over the GENERATED Supabase types.
 *
 * Single source of truth: src/lib/database.types.ts (regenerated from PROD
 * via `supabase gen types typescript --project-id pnqujtugddxusllkikje`).
 * This file only re-exports convenient names — it must never redeclare
 * table shapes by hand. (It used to: a full hand-maintained Database
 * interface lived here and drifted from the real schema repeatedly —
 * missing columns, stale status unions — until the 2026-07 audit removed
 * it. If a column looks missing, regenerate the types; don't add it here.)
 *
 * Narrowed unions: Postgres enforces these via CHECK constraints, so the
 * generated types widen them to `string`. The app relies on the literal
 * unions for exhaustive switches and comparisons, so we re-narrow the few
 * fields where that matters. If a constraint gains a new value in a
 * migration, update the union here in the same PR.
 */
import type { Database as GeneratedDatabase } from "@/lib/database.types";

type Tables = GeneratedDatabase["public"]["Tables"];

// Straight aliases — the generated Row is the whole truth.
export type Profile = Tables["profiles"]["Row"];
export type SKUEconomics = Tables["sku_economics"]["Row"];
export type FreightShipment = Tables["freight_shipments"]["Row"];
export type FreightLineItem = Tables["freight_line_items"]["Row"];
export type FactoryOrder = Tables["factory_orders"]["Row"];
export type FactoryOrderItem = Tables["factory_order_items"]["Row"];
export type InventoryLevel = Tables["inventory_levels"]["Row"];
export type InventoryTransaction = Tables["inventory_transactions"]["Row"];

// Narrowed domain unions (CHECK-constrained in the DB).
export type ProductCategory = "fillable" | "non_fillable";
export type AbcClassification = "A" | "B" | "C";
export type ProductSKU = Omit<
  Tables["product_skus"]["Row"],
  "category" | "abc_classification"
> & {
  category: ProductCategory;
  abc_classification: AbcClassification | null;
};

export type TaskType = "emptying" | "filling_capping" | "rtsing" | "prefilled_rtsing";
export type TaskLog = Omit<Tables["task_logs"]["Row"], "task_type"> & {
  task_type: TaskType;
};
