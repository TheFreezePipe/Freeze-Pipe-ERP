export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export interface Database {
  public: {
    Tables: {
      profiles: {
        Row: {
          id: string;
          email: string;
          full_name: string;
          role: "admin" | "manager" | "user" | "supplier";
          avatar_url: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id: string;
          email: string;
          full_name: string;
          role?: "admin" | "manager" | "user" | "supplier";
          avatar_url?: string | null;
        };
        Update: Partial<Database["public"]["Tables"]["profiles"]["Insert"]>;
      };
      product_skus: {
        Row: {
          id: string;
          sku: string;
          product_name: string;
          upc_code: string | null;
          category: "fillable" | "non_fillable";
          display_category: string;
          retail_price: number;
          standard_quantity_per_carton: number;
          abc_classification: "A" | "B" | "C" | null;
          monthly_demand: number;
          is_active: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          sku: string;
          product_name: string;
          upc_code?: string | null;
          category: "fillable" | "non_fillable";
          display_category: string;
          retail_price?: number;
          standard_quantity_per_carton?: number;
          abc_classification?: "A" | "B" | "C" | null;
          monthly_demand?: number;
          is_active?: boolean;
        };
        Update: Partial<Database["public"]["Tables"]["product_skus"]["Insert"]>;
      };
      sku_economics: {
        Row: {
          id: string;
          sku_id: string;
          pct_from_yx: number;
          pct_from_nancy: number;
          nancy_raw_cost: number;
          yx_raw_cost: number;
          additional_raw_cost: number;
          pct_sea: number;
          pct_air: number;
          sea_freight_cost_per_unit: number;
          air_freight_cost_per_unit: number;
          breakage_issue_cost: number;
          pct_manufactured_us: number;
          pct_manufactured_cn: number;
          labor_cost_us: number;
          glycerin_cost_us: number;
          manufacturing_cost_cn: number;
          packing_material_cost: number;
          packing_labor_cost: number;
          shipping_cost: number;
          credit_card_fees: number;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          sku_id: string;
          pct_from_yx?: number;
          pct_from_nancy?: number;
          nancy_raw_cost?: number;
          yx_raw_cost?: number;
          additional_raw_cost?: number;
          pct_sea?: number;
          pct_air?: number;
          sea_freight_cost_per_unit?: number;
          air_freight_cost_per_unit?: number;
          breakage_issue_cost?: number;
          pct_manufactured_us?: number;
          pct_manufactured_cn?: number;
          labor_cost_us?: number;
          glycerin_cost_us?: number;
          manufacturing_cost_cn?: number;
          packing_material_cost?: number;
          packing_labor_cost?: number;
          shipping_cost?: number;
          credit_card_fees?: number;
        };
        Update: Partial<Database["public"]["Tables"]["sku_economics"]["Insert"]>;
      };
      task_logs: {
        Row: {
          id: string;
          employee_id: string;
          sku_id: string;
          task_type: "emptying" | "filling_capping" | "rtsing" | "prefilled_rtsing";
          quantity_processed: number;
          time_started: string | null;
          time_completed: string | null;
          notes: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          employee_id: string;
          sku_id: string;
          task_type: "emptying" | "filling_capping" | "rtsing" | "prefilled_rtsing";
          quantity_processed: number;
          time_started?: string | null;
          time_completed?: string | null;
          notes?: string | null;
        };
        Update: Partial<Database["public"]["Tables"]["task_logs"]["Insert"]>;
      };
      freight_shipments: {
        Row: {
          id: string;
          shipment_number: string;
          freight_type: "air" | "sea";
          status: "on_the_water" | "high_risk" | "cleared_customs" | "tracking" | "delivered";
          carrier_name: string | null;
          broker_name: string | null;
          forwarder_code: string | null;
          tracking_number: string | null;
          ship_date: string | null;
          eta: string | null;
          /** Original ETA captured before any tracking drift. Immutable after first check. */
          eta_original: string | null;
          /** ISO timestamp of the last successful carrier tracking check. */
          eta_last_checked_at: string | null;
          /** ISO timestamp of when a human last manually set the status. When non-null,
           *  carrier tracking will not auto-change the status (it still updates ETA). */
          status_overridden_at: string | null;
          actual_arrival_date: string | null;
          freight_cost: number;
          insurance_cost: number;
          duties_cost: number;
          /** Generated column: freight_cost + insurance_cost + duties_cost.
           *  DB computes automatically; do not set in Insert/Update — Postgres
           *  rejects writes to GENERATED ALWAYS columns. */
          total_cost: number;
          /** Actual carton count entered at shipment creation (sum of carton_qty across all carton groups). */
          total_cartons: number | null;
          notes: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          shipment_number: string;
          freight_type: "air" | "sea";
          status?: "on_the_water" | "high_risk" | "cleared_customs" | "tracking" | "delivered";
          carrier_name?: string | null;
          broker_name?: string | null;
          forwarder_code?: string | null;
          tracking_number?: string | null;
          ship_date?: string | null;
          eta?: string | null;
          eta_original?: string | null;
          eta_last_checked_at?: string | null;
          status_overridden_at?: string | null;
          actual_arrival_date?: string | null;
          freight_cost?: number;
          insurance_cost?: number;
          duties_cost?: number;
          // total_cost intentionally omitted — generated column, DB-computed.
          total_cartons?: number | null;
          notes?: string | null;
        };
        Update: Partial<Database["public"]["Tables"]["freight_shipments"]["Insert"]>;
      };
      freight_line_items: {
        Row: {
          id: string;
          freight_shipment_id: string;
          sku_id: string;
          quantity: number;
          unit_cost: number;
          retail_value: number;
          created_at: string;
        };
        Insert: {
          id?: string;
          freight_shipment_id: string;
          sku_id: string;
          quantity: number;
          unit_cost?: number;
          retail_value?: number;
        };
        Update: Partial<Database["public"]["Tables"]["freight_line_items"]["Insert"]>;
      };
      inventory_levels: {
        // Legacy in_transit_* / nancy_* / yx_* columns were dropped in
        // migration 041. Live In Transit + On Order derivations live in
        // `src/lib/inventory-aggregates.ts` (read from freight_shipments
        // and factory_orders respectively).
        // warehouse_prefilled_raw added in migration 20260506000002 — units
        // arriving pre-filled from supplier (sources the prefilled_rtsing
        // task type, skipping WIP).
        Row: {
          id: string;
          sku_id: string;
          warehouse_raw: number;
          warehouse_prefilled_raw: number;
          warehouse_in_production: number;
          warehouse_finished: number;
          warehouse_other: number;
          last_synced_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          sku_id: string;
          warehouse_raw?: number;
          warehouse_prefilled_raw?: number;
          warehouse_in_production?: number;
          warehouse_finished?: number;
          warehouse_other?: number;
        };
        Update: Partial<Database["public"]["Tables"]["inventory_levels"]["Insert"]>;
      };
      inventory_transactions: {
        Row: {
          id: string;
          sku_id: string;
          transaction_type: string;
          quantity: number;
          field_affected: string;
          reference_id: string | null;
          reference_type: string | null;
          notes: string | null;
          performed_by: string | null;
          created_at: string;
          /** 'net_change' | 'category_move' | 'metadata' — controls how
           *  to interpret quantity vs from_field/to_field. */
          movement_kind: string;
          /** Set only when movement_kind='category_move'; the source bucket. */
          from_field: string | null;
          /** Set only when movement_kind='category_move'; the destination bucket. */
          to_field: string | null;
        };
        Insert: {
          id?: string;
          sku_id: string;
          transaction_type: string;
          quantity: number;
          field_affected: string;
          reference_id?: string | null;
          reference_type?: string | null;
          notes?: string | null;
          performed_by?: string | null;
          movement_kind?: string;
          from_field?: string | null;
          to_field?: string | null;
        };
        Update: Partial<Database["public"]["Tables"]["inventory_transactions"]["Insert"]>;
      };
      factory_orders: {
        Row: {
          id: string;
          supplier_id: string | null;
          order_number: string | null;
          status: "ordered" | "in_production" | "finished" | "shipped";
          order_date: string | null;
          expected_completion: string | null;
          notes: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          supplier_id: string | null;
          order_number?: string | null;
          status?: "ordered" | "in_production" | "finished" | "shipped";
          order_date?: string | null;
          expected_completion?: string | null;
          notes?: string | null;
        };
        Update: Partial<Database["public"]["Tables"]["factory_orders"]["Insert"]>;
      };
      factory_order_items: {
        Row: {
          id: string;
          factory_order_id: string;
          sku_id: string;
          quantity_ordered: number;
          quantity_finished: number;
          unit_cost: number;
          created_at: string;
        };
        Insert: {
          id?: string;
          factory_order_id: string;
          sku_id: string;
          quantity_ordered: number;
          quantity_finished?: number;
          unit_cost?: number;
        };
        Update: Partial<Database["public"]["Tables"]["factory_order_items"]["Insert"]>;
      };
      factory_order_fulfillments: {
        Row: {
          id: string;
          factory_order_item_id: string;
          quantity: number;
          stage: "in_production" | "finished_at_factory" | "shipped";
          freight_shipment_id: string | null;
          completed_at: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          factory_order_item_id: string;
          quantity: number;
          stage: "in_production" | "finished_at_factory" | "shipped";
          freight_shipment_id?: string | null;
          completed_at?: string | null;
        };
        Update: Partial<Database["public"]["Tables"]["factory_order_fulfillments"]["Insert"]>;
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
  };
}

// Convenience types
// Profile drifted post-migration (homebase_*, supplier_id, is_active, row_version
// added). Pull from generated types so new fields surface automatically.
export type Profile = GeneratedDatabase["public"]["Tables"]["profiles"]["Row"];
export type ProductSKU = Database["public"]["Tables"]["product_skus"]["Row"];
// Re-aliased to generated types — the hand-rolled shape predated
// migration 028's mfg_override_active / mfg_override_pct_prefilled /
// mfg_window_days additions. Same drift pattern as Profile and
// FreightShipment.
export type SKUEconomics = GeneratedDatabase["public"]["Tables"]["sku_economics"]["Row"];
export type TaskLog = Database["public"]["Tables"]["task_logs"]["Row"];
// FreightShipment status enum drifted through migrations 022 (added pending +
// booked) and 035 (collapsed booked back out — tracking submission auto-
// promotes pending → on_the_water). Pull from generated types so the status
// union stays in sync automatically.
export type FreightShipment = GeneratedDatabase["public"]["Tables"]["freight_shipments"]["Row"];
// Re-aliased to generated types for the same reason FreightShipment is:
// the hand-rolled shape is missing supplier-portal columns (notably
// source_factory_order_item_id, added in migration 021, which the
// inventory-aggregates on-order derivation reads). Generated types keep
// the union in sync with the live schema.
export type FreightLineItem = GeneratedDatabase["public"]["Tables"]["freight_line_items"]["Row"];
export type InventoryLevel = Database["public"]["Tables"]["inventory_levels"]["Row"];
export type InventoryTransaction = Database["public"]["Tables"]["inventory_transactions"]["Row"];
// Re-alias to the generated database types so FactoryOrder / FactoryOrderItem
// track the real schema. The hand-rolled Row definition higher up in this file
// still has the old `factory: "nancy" | "yx"` shape — it's kept there for
// demo-data's sake (demo uses it as a literal convenience) but the exported
// *type* comes from the generated file.
import type { Database as GeneratedDatabase } from "@/lib/database.types";
export type FactoryOrder = GeneratedDatabase["public"]["Tables"]["factory_orders"]["Row"];
export type FactoryOrderItem = GeneratedDatabase["public"]["Tables"]["factory_order_items"]["Row"];
export type FactoryOrderFulfillment = Database["public"]["Tables"]["factory_order_fulfillments"]["Row"];
export type FulfillmentStage = FactoryOrderFulfillment["stage"];
