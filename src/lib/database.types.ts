export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      audit_chain_config: {
        Row: {
          checkpoint_seq: number
          id: number
          set_at: string
        }
        Insert: {
          checkpoint_seq: number
          id?: number
          set_at?: string
        }
        Update: {
          checkpoint_seq?: number
          id?: number
          set_at?: string
        }
        Relationships: []
      }
      audit_logs: {
        Row: {
          action: string
          actor_id: string | null
          created_at: string
          details: Json
          id: string
          target_id: string
          target_table: string
        }
        Insert: {
          action: string
          actor_id?: string | null
          created_at?: string
          details?: Json
          id?: string
          target_id: string
          target_table: string
        }
        Update: {
          action?: string
          actor_id?: string | null
          created_at?: string
          details?: Json
          id?: string
          target_id?: string
          target_table?: string
        }
        Relationships: [
          {
            foreignKeyName: "audit_logs_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      component_breakage_reports: {
        Row: {
          acknowledged_at: string | null
          acknowledged_by: string | null
          created_at: string
          created_by: string
          description: string
          factory_order_item_id: string
          id: string
          producing_supplier_id: string
          quantity_broken: number
          reason_category: string
          replacement_factory_order_id: string | null
          replacement_requested: boolean
          reporter_supplier_id: string
          resolution_notes: string | null
          resolved_at: string | null
          resolved_by: string | null
          sku_id: string
          status: string
        }
        Insert: {
          acknowledged_at?: string | null
          acknowledged_by?: string | null
          created_at?: string
          created_by: string
          description: string
          factory_order_item_id: string
          id?: string
          producing_supplier_id: string
          quantity_broken: number
          reason_category: string
          replacement_factory_order_id?: string | null
          replacement_requested?: boolean
          reporter_supplier_id: string
          resolution_notes?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          sku_id: string
          status?: string
        }
        Update: {
          acknowledged_at?: string | null
          acknowledged_by?: string | null
          created_at?: string
          created_by?: string
          description?: string
          factory_order_item_id?: string
          id?: string
          producing_supplier_id?: string
          quantity_broken?: number
          reason_category?: string
          replacement_factory_order_id?: string | null
          replacement_requested?: boolean
          reporter_supplier_id?: string
          resolution_notes?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          sku_id?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "component_breakage_reports_acknowledged_by_fkey"
            columns: ["acknowledged_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "component_breakage_reports_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "component_breakage_reports_factory_order_item_id_fkey"
            columns: ["factory_order_item_id"]
            isOneToOne: false
            referencedRelation: "factory_order_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "component_breakage_reports_factory_order_item_id_fkey"
            columns: ["factory_order_item_id"]
            isOneToOne: false
            referencedRelation: "supplier_portal_factory_order_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "component_breakage_reports_producing_supplier_id_fkey"
            columns: ["producing_supplier_id"]
            isOneToOne: false
            referencedRelation: "suppliers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "component_breakage_reports_replacement_factory_order_id_fkey"
            columns: ["replacement_factory_order_id"]
            isOneToOne: false
            referencedRelation: "factory_orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "component_breakage_reports_replacement_factory_order_id_fkey"
            columns: ["replacement_factory_order_id"]
            isOneToOne: false
            referencedRelation: "supplier_portal_factory_orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "component_breakage_reports_reporter_supplier_id_fkey"
            columns: ["reporter_supplier_id"]
            isOneToOne: false
            referencedRelation: "suppliers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "component_breakage_reports_resolved_by_fkey"
            columns: ["resolved_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "component_breakage_reports_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "product_skus"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "component_breakage_reports_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "product_skus_active"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "component_breakage_reports_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "supplier_portal_skus"
            referencedColumns: ["id"]
          },
        ]
      }
      demand_overrides: {
        Row: {
          created_at: string
          id: string
          monthly_demand: number
          overridden_by: string | null
          reason: string | null
          sku_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          monthly_demand: number
          overridden_by?: string | null
          reason?: string | null
          sku_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          monthly_demand?: number
          overridden_by?: string | null
          reason?: string | null
          sku_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "demand_overrides_overridden_by_fkey"
            columns: ["overridden_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "demand_overrides_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: true
            referencedRelation: "product_skus"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "demand_overrides_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: true
            referencedRelation: "product_skus_active"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "demand_overrides_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: true
            referencedRelation: "supplier_portal_skus"
            referencedColumns: ["id"]
          },
        ]
      }
      factory_order_items: {
        Row: {
          alternate_expected_completion: string | null
          consolidator_confirmed_at: string | null
          consolidator_confirmed_by: string | null
          consolidator_confirmed_quantity: number | null
          created_at: string
          factory_order_id: string
          id: string
          quantity_breakage: number
          quantity_consumed_by_parent: number
          quantity_finished: number | null
          quantity_ordered: number
          quantity_shipped_manual: number
          row_version: number
          sku_id: string
          unit_cost: number | null
        }
        Insert: {
          alternate_expected_completion?: string | null
          consolidator_confirmed_at?: string | null
          consolidator_confirmed_by?: string | null
          consolidator_confirmed_quantity?: number | null
          created_at?: string
          factory_order_id: string
          id?: string
          quantity_breakage?: number
          quantity_consumed_by_parent?: number
          quantity_finished?: number | null
          quantity_ordered: number
          quantity_shipped_manual?: number
          row_version?: number
          sku_id: string
          unit_cost?: number | null
        }
        Update: {
          alternate_expected_completion?: string | null
          consolidator_confirmed_at?: string | null
          consolidator_confirmed_by?: string | null
          consolidator_confirmed_quantity?: number | null
          created_at?: string
          factory_order_id?: string
          id?: string
          quantity_breakage?: number
          quantity_consumed_by_parent?: number
          quantity_finished?: number | null
          quantity_ordered?: number
          quantity_shipped_manual?: number
          row_version?: number
          sku_id?: string
          unit_cost?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "factory_order_items_consolidator_confirmed_by_fkey"
            columns: ["consolidator_confirmed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "factory_order_items_factory_order_id_fkey"
            columns: ["factory_order_id"]
            isOneToOne: false
            referencedRelation: "factory_orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "factory_order_items_factory_order_id_fkey"
            columns: ["factory_order_id"]
            isOneToOne: false
            referencedRelation: "supplier_portal_factory_orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "factory_order_items_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "product_skus"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "factory_order_items_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "product_skus_active"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "factory_order_items_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "supplier_portal_skus"
            referencedColumns: ["id"]
          },
        ]
      }
      factory_orders: {
        Row: {
          canceled_at: string | null
          canceled_by: string | null
          canceled_reason: string | null
          created_at: string
          expected_completion: string | null
          id: string
          idempotency_key: string | null
          notes: string | null
          order_date: string | null
          order_number: string | null
          parent_factory_order_id: string | null
          row_version: number
          ship_via_supplier_id: string | null
          shipped_at: string | null
          status: string
          supplier_id: string
          updated_at: string
        }
        Insert: {
          canceled_at?: string | null
          canceled_by?: string | null
          canceled_reason?: string | null
          created_at?: string
          expected_completion?: string | null
          id?: string
          idempotency_key?: string | null
          notes?: string | null
          order_date?: string | null
          order_number?: string | null
          parent_factory_order_id?: string | null
          row_version?: number
          ship_via_supplier_id?: string | null
          shipped_at?: string | null
          status?: string
          supplier_id: string
          updated_at?: string
        }
        Update: {
          canceled_at?: string | null
          canceled_by?: string | null
          canceled_reason?: string | null
          created_at?: string
          expected_completion?: string | null
          id?: string
          idempotency_key?: string | null
          notes?: string | null
          order_date?: string | null
          order_number?: string | null
          parent_factory_order_id?: string | null
          row_version?: number
          ship_via_supplier_id?: string | null
          shipped_at?: string | null
          status?: string
          supplier_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "factory_orders_canceled_by_fkey"
            columns: ["canceled_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "factory_orders_parent_factory_order_id_fkey"
            columns: ["parent_factory_order_id"]
            isOneToOne: false
            referencedRelation: "factory_orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "factory_orders_parent_factory_order_id_fkey"
            columns: ["parent_factory_order_id"]
            isOneToOne: false
            referencedRelation: "supplier_portal_factory_orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "factory_orders_ship_via_supplier_id_fkey"
            columns: ["ship_via_supplier_id"]
            isOneToOne: false
            referencedRelation: "suppliers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "factory_orders_supplier_id_fkey"
            columns: ["supplier_id"]
            isOneToOne: false
            referencedRelation: "suppliers"
            referencedColumns: ["id"]
          },
        ]
      }
      freight_line_items: {
        Row: {
          created_at: string
          custom_description: string | null
          freight_shipment_id: string
          id: string
          quantity: number
          quantity_prefilled: number | null
          retail_value: number | null
          row_version: number
          sku_id: string | null
          source_factory_order_item_id: string | null
          supplier_declared_quantity: number | null
          unit_cost: number | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          custom_description?: string | null
          freight_shipment_id: string
          id?: string
          quantity: number
          quantity_prefilled?: number | null
          retail_value?: number | null
          row_version?: number
          sku_id?: string | null
          source_factory_order_item_id?: string | null
          supplier_declared_quantity?: number | null
          unit_cost?: number | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          custom_description?: string | null
          freight_shipment_id?: string
          id?: string
          quantity?: number
          quantity_prefilled?: number | null
          retail_value?: number | null
          row_version?: number
          sku_id?: string | null
          source_factory_order_item_id?: string | null
          supplier_declared_quantity?: number | null
          unit_cost?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "freight_line_items_freight_shipment_id_fkey"
            columns: ["freight_shipment_id"]
            isOneToOne: false
            referencedRelation: "freight_shipments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "freight_line_items_freight_shipment_id_fkey"
            columns: ["freight_shipment_id"]
            isOneToOne: false
            referencedRelation: "supplier_portal_freight_shipments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "freight_line_items_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "product_skus"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "freight_line_items_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "product_skus_active"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "freight_line_items_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "supplier_portal_skus"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "freight_line_items_source_factory_order_item_id_fkey"
            columns: ["source_factory_order_item_id"]
            isOneToOne: false
            referencedRelation: "factory_order_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "freight_line_items_source_factory_order_item_id_fkey"
            columns: ["source_factory_order_item_id"]
            isOneToOne: false
            referencedRelation: "supplier_portal_factory_order_items"
            referencedColumns: ["id"]
          },
        ]
      }
      freight_shipments: {
        Row: {
          actual_arrival_date: string | null
          broker_name: string | null
          carrier_name: string | null
          china_customs_delay: boolean
          created_at: string
          created_by_supplier_user_id: string | null
          duties_cost: number | null
          eta: string | null
          eta_last_checked_at: string | null
          eta_original: string | null
          forwarder_code: string | null
          freight_cost: number | null
          freight_type: string
          id: string
          idempotency_key: string | null
          insurance_cost: number | null
          notes: string | null
          origin_supplier_id: string | null
          receipt_confirmed_at: string | null
          receipt_confirmed_by: string | null
          row_version: number
          ship_date: string | null
          shipment_number: string
          status: string
          status_overridden_at: string | null
          status_overridden_by: string | null
          total_cartons: number | null
          total_cost: number | null
          tracking_number: string | null
          updated_at: string
        }
        Insert: {
          actual_arrival_date?: string | null
          broker_name?: string | null
          carrier_name?: string | null
          china_customs_delay?: boolean
          created_at?: string
          created_by_supplier_user_id?: string | null
          duties_cost?: number | null
          eta?: string | null
          eta_last_checked_at?: string | null
          eta_original?: string | null
          forwarder_code?: string | null
          freight_cost?: number | null
          freight_type: string
          id?: string
          idempotency_key?: string | null
          insurance_cost?: number | null
          notes?: string | null
          origin_supplier_id?: string | null
          receipt_confirmed_at?: string | null
          receipt_confirmed_by?: string | null
          row_version?: number
          ship_date?: string | null
          shipment_number: string
          status?: string
          status_overridden_at?: string | null
          status_overridden_by?: string | null
          total_cartons?: number | null
          total_cost?: number | null
          tracking_number?: string | null
          updated_at?: string
        }
        Update: {
          actual_arrival_date?: string | null
          broker_name?: string | null
          carrier_name?: string | null
          china_customs_delay?: boolean
          created_at?: string
          created_by_supplier_user_id?: string | null
          duties_cost?: number | null
          eta?: string | null
          eta_last_checked_at?: string | null
          eta_original?: string | null
          forwarder_code?: string | null
          freight_cost?: number | null
          freight_type?: string
          id?: string
          idempotency_key?: string | null
          insurance_cost?: number | null
          notes?: string | null
          origin_supplier_id?: string | null
          receipt_confirmed_at?: string | null
          receipt_confirmed_by?: string | null
          row_version?: number
          ship_date?: string | null
          shipment_number?: string
          status?: string
          status_overridden_at?: string | null
          status_overridden_by?: string | null
          total_cartons?: number | null
          total_cost?: number | null
          tracking_number?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "freight_shipments_created_by_supplier_user_id_fkey"
            columns: ["created_by_supplier_user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "freight_shipments_origin_supplier_id_fkey"
            columns: ["origin_supplier_id"]
            isOneToOne: false
            referencedRelation: "suppliers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "freight_shipments_receipt_confirmed_by_fkey"
            columns: ["receipt_confirmed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "freight_shipments_status_overridden_by_fkey"
            columns: ["status_overridden_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      inventory_levels: {
        Row: {
          id: string
          last_synced_at: string
          location_id: string
          row_version: number
          sku_id: string
          updated_at: string
          warehouse_finished: number | null
          warehouse_in_production: number | null
          warehouse_other: number | null
          warehouse_prefilled_raw: number
          warehouse_raw: number | null
        }
        Insert: {
          id?: string
          last_synced_at?: string
          location_id: string
          row_version?: number
          sku_id: string
          updated_at?: string
          warehouse_finished?: number | null
          warehouse_in_production?: number | null
          warehouse_other?: number | null
          warehouse_prefilled_raw?: number
          warehouse_raw?: number | null
        }
        Update: {
          id?: string
          last_synced_at?: string
          location_id?: string
          row_version?: number
          sku_id?: string
          updated_at?: string
          warehouse_finished?: number | null
          warehouse_in_production?: number | null
          warehouse_other?: number | null
          warehouse_prefilled_raw?: number
          warehouse_raw?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "inventory_levels_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "locations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_levels_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "product_skus"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_levels_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "product_skus_active"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_levels_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "supplier_portal_skus"
            referencedColumns: ["id"]
          },
        ]
      }
      inventory_retail_value_daily: {
        Row: {
          onorder_retail: number
          snapshot_date: string
          source: string
          transit_retail: number
          updated_at: string
          warehouse_retail: number
        }
        Insert: {
          onorder_retail?: number
          snapshot_date: string
          source?: string
          transit_retail?: number
          updated_at?: string
          warehouse_retail?: number
        }
        Update: {
          onorder_retail?: number
          snapshot_date?: string
          source?: string
          transit_retail?: number
          updated_at?: string
          warehouse_retail?: number
        }
        Relationships: []
      }
      inventory_transactions: {
        Row: {
          actor_ip: unknown
          actor_user_agent: string | null
          created_at: string
          field_affected: string
          from_field: string | null
          id: string
          movement_kind: string
          notes: string | null
          performed_by: string
          prev_hash: string | null
          quantity: number
          reference_id: string | null
          reference_type: string | null
          row_hash: string | null
          seq: number
          sku_id: string | null
          to_field: string | null
          transaction_type: string
        }
        Insert: {
          actor_ip?: unknown
          actor_user_agent?: string | null
          created_at?: string
          field_affected: string
          from_field?: string | null
          id?: string
          movement_kind?: string
          notes?: string | null
          performed_by: string
          prev_hash?: string | null
          quantity: number
          reference_id?: string | null
          reference_type?: string | null
          row_hash?: string | null
          seq?: number
          sku_id?: string | null
          to_field?: string | null
          transaction_type: string
        }
        Update: {
          actor_ip?: unknown
          actor_user_agent?: string | null
          created_at?: string
          field_affected?: string
          from_field?: string | null
          id?: string
          movement_kind?: string
          notes?: string | null
          performed_by?: string
          prev_hash?: string | null
          quantity?: number
          reference_id?: string | null
          reference_type?: string | null
          row_hash?: string | null
          seq?: number
          sku_id?: string | null
          to_field?: string | null
          transaction_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "inventory_transactions_performed_by_fkey"
            columns: ["performed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_transactions_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "product_skus"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_transactions_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "product_skus_active"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_transactions_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "supplier_portal_skus"
            referencedColumns: ["id"]
          },
        ]
      }
      labor_hours_daily: {
        Row: {
          created_at: string
          homebase_employee_id: string
          id: string
          last_synced_at: string
          minutes_breaks_paid: number
          minutes_breaks_unpaid: number
          minutes_clocked: number
          raw_payload: Json | null
          source: string
          updated_at: string
          work_date: string
        }
        Insert: {
          created_at?: string
          homebase_employee_id: string
          id?: string
          last_synced_at?: string
          minutes_breaks_paid?: number
          minutes_breaks_unpaid?: number
          minutes_clocked?: number
          raw_payload?: Json | null
          source?: string
          updated_at?: string
          work_date: string
        }
        Update: {
          created_at?: string
          homebase_employee_id?: string
          id?: string
          last_synced_at?: string
          minutes_breaks_paid?: number
          minutes_breaks_unpaid?: number
          minutes_clocked?: number
          raw_payload?: Json | null
          source?: string
          updated_at?: string
          work_date?: string
        }
        Relationships: []
      }
      locations: {
        Row: {
          address_line1: string | null
          address_line2: string | null
          city: string | null
          code: string
          country: string | null
          created_at: string
          id: string
          is_active: boolean
          is_default: boolean
          location_type: string
          name: string
          owner_supplier_id: string | null
          postal_code: string | null
          row_version: number
          state: string | null
          updated_at: string
        }
        Insert: {
          address_line1?: string | null
          address_line2?: string | null
          city?: string | null
          code: string
          country?: string | null
          created_at?: string
          id?: string
          is_active?: boolean
          is_default?: boolean
          location_type: string
          name: string
          owner_supplier_id?: string | null
          postal_code?: string | null
          row_version?: number
          state?: string | null
          updated_at?: string
        }
        Update: {
          address_line1?: string | null
          address_line2?: string | null
          city?: string | null
          code?: string
          country?: string | null
          created_at?: string
          id?: string
          is_active?: boolean
          is_default?: boolean
          location_type?: string
          name?: string
          owner_supplier_id?: string | null
          postal_code?: string | null
          row_version?: number
          state?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "locations_owner_supplier_id_fkey"
            columns: ["owner_supplier_id"]
            isOneToOne: false
            referencedRelation: "suppliers"
            referencedColumns: ["id"]
          },
        ]
      }
      material_inventory_levels: {
        Row: {
          id: string
          last_counted_at: string | null
          last_counted_by: string | null
          material_id: string
          on_hand_qty: number
          updated_at: string
        }
        Insert: {
          id?: string
          last_counted_at?: string | null
          last_counted_by?: string | null
          material_id: string
          on_hand_qty?: number
          updated_at?: string
        }
        Update: {
          id?: string
          last_counted_at?: string | null
          last_counted_by?: string | null
          material_id?: string
          on_hand_qty?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "material_inventory_levels_last_counted_by_fkey"
            columns: ["last_counted_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "material_inventory_levels_material_id_fkey"
            columns: ["material_id"]
            isOneToOne: true
            referencedRelation: "materials"
            referencedColumns: ["id"]
          },
        ]
      }
      material_transactions: {
        Row: {
          created_at: string
          id: string
          material_id: string
          notes: string | null
          performed_by: string
          quantity_change: number
          reference_id: string | null
          reference_type: string | null
          transaction_type: string
        }
        Insert: {
          created_at?: string
          id?: string
          material_id: string
          notes?: string | null
          performed_by: string
          quantity_change: number
          reference_id?: string | null
          reference_type?: string | null
          transaction_type: string
        }
        Update: {
          created_at?: string
          id?: string
          material_id?: string
          notes?: string | null
          performed_by?: string
          quantity_change?: number
          reference_id?: string | null
          reference_type?: string | null
          transaction_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "material_transactions_material_id_fkey"
            columns: ["material_id"]
            isOneToOne: false
            referencedRelation: "materials"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "material_transactions_performed_by_fkey"
            columns: ["performed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      materials: {
        Row: {
          category: string
          code: string
          created_at: string
          dim_height_in: number | null
          dim_length_in: number | null
          dim_width_in: number | null
          id: string
          is_active: boolean
          lead_time_days: number | null
          name: string
          notes: string | null
          reorder_point_qty: number | null
          row_version: number
          supplier_id: string | null
          unit_cost: number
          unit_of_measure: string
          updated_at: string
        }
        Insert: {
          category: string
          code: string
          created_at?: string
          dim_height_in?: number | null
          dim_length_in?: number | null
          dim_width_in?: number | null
          id?: string
          is_active?: boolean
          lead_time_days?: number | null
          name: string
          notes?: string | null
          reorder_point_qty?: number | null
          row_version?: number
          supplier_id?: string | null
          unit_cost?: number
          unit_of_measure: string
          updated_at?: string
        }
        Update: {
          category?: string
          code?: string
          created_at?: string
          dim_height_in?: number | null
          dim_length_in?: number | null
          dim_width_in?: number | null
          id?: string
          is_active?: boolean
          lead_time_days?: number | null
          name?: string
          notes?: string | null
          reorder_point_qty?: number | null
          row_version?: number
          supplier_id?: string | null
          unit_cost?: number
          unit_of_measure?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "materials_supplier_id_fkey"
            columns: ["supplier_id"]
            isOneToOne: false
            referencedRelation: "suppliers"
            referencedColumns: ["id"]
          },
        ]
      }
      mkt_broadcasts: {
        Row: {
          audience_segment: string | null
          audience_size: number | null
          channel: string
          created_at: string
          created_by: string | null
          id: string
          launch_id: string | null
          metrics: Json | null
          name: string
          sale_id: string | null
          scheduled_at: string | null
          sent_at: string | null
          updated_at: string
        }
        Insert: {
          audience_segment?: string | null
          audience_size?: number | null
          channel: string
          created_at?: string
          created_by?: string | null
          id?: string
          launch_id?: string | null
          metrics?: Json | null
          name: string
          sale_id?: string | null
          scheduled_at?: string | null
          sent_at?: string | null
          updated_at?: string
        }
        Update: {
          audience_segment?: string | null
          audience_size?: number | null
          channel?: string
          created_at?: string
          created_by?: string | null
          id?: string
          launch_id?: string | null
          metrics?: Json | null
          name?: string
          sale_id?: string | null
          scheduled_at?: string | null
          sent_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "mkt_broadcasts_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mkt_broadcasts_launch_id_fkey"
            columns: ["launch_id"]
            isOneToOne: false
            referencedRelation: "mkt_launches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mkt_broadcasts_sale_id_fkey"
            columns: ["sale_id"]
            isOneToOne: false
            referencedRelation: "mkt_sales"
            referencedColumns: ["id"]
          },
        ]
      }
      mkt_launch_skus: {
        Row: {
          created_at: string
          expected_first_30d_units: number | null
          id: string
          launch_id: string
          limited_qty: number | null
          planned_name: string | null
          planner_confidence: number | null
          sku_id: string | null
          sort_order: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          expected_first_30d_units?: number | null
          id?: string
          launch_id: string
          limited_qty?: number | null
          planned_name?: string | null
          planner_confidence?: number | null
          sku_id?: string | null
          sort_order?: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          expected_first_30d_units?: number | null
          id?: string
          launch_id?: string
          limited_qty?: number | null
          planned_name?: string | null
          planner_confidence?: number | null
          sku_id?: string | null
          sort_order?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "mkt_launch_skus_launch_id_fkey"
            columns: ["launch_id"]
            isOneToOne: false
            referencedRelation: "mkt_launches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mkt_launch_skus_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "product_skus"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mkt_launch_skus_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "product_skus_active"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mkt_launch_skus_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "supplier_portal_skus"
            referencedColumns: ["id"]
          },
        ]
      }
      mkt_launches: {
        Row: {
          created_at: string
          created_by: string | null
          id: string
          inventory_ready_by: string | null
          kind: string
          launch_date: string | null
          name: string
          notes: string | null
          preorder: boolean
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          inventory_ready_by?: string | null
          kind?: string
          launch_date?: string | null
          name: string
          notes?: string | null
          preorder?: boolean
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          inventory_ready_by?: string | null
          kind?: string
          launch_date?: string | null
          name?: string
          notes?: string | null
          preorder?: boolean
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "mkt_launches_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      mkt_offer_skus: {
        Row: {
          offer_id: string
          sku_id: string
        }
        Insert: {
          offer_id: string
          sku_id: string
        }
        Update: {
          offer_id?: string
          sku_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "mkt_offer_skus_offer_id_fkey"
            columns: ["offer_id"]
            isOneToOne: false
            referencedRelation: "mkt_offers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mkt_offer_skus_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "product_skus"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mkt_offer_skus_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "product_skus_active"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mkt_offer_skus_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "supplier_portal_skus"
            referencedColumns: ["id"]
          },
        ]
      }
      mkt_offers: {
        Row: {
          buy_qty: number | null
          category: string | null
          code: string | null
          created_at: string
          dollar_off: number | null
          free_item_sku_id: string | null
          get_qty: number | null
          id: string
          label: string
          min_order_amount: number | null
          percent_off: number | null
          sale_id: string
          scope: string
          updated_at: string
        }
        Insert: {
          buy_qty?: number | null
          category?: string | null
          code?: string | null
          created_at?: string
          dollar_off?: number | null
          free_item_sku_id?: string | null
          get_qty?: number | null
          id?: string
          label: string
          min_order_amount?: number | null
          percent_off?: number | null
          sale_id: string
          scope?: string
          updated_at?: string
        }
        Update: {
          buy_qty?: number | null
          category?: string | null
          code?: string | null
          created_at?: string
          dollar_off?: number | null
          free_item_sku_id?: string | null
          get_qty?: number | null
          id?: string
          label?: string
          min_order_amount?: number | null
          percent_off?: number | null
          sale_id?: string
          scope?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "mkt_offers_free_item_sku_id_fkey"
            columns: ["free_item_sku_id"]
            isOneToOne: false
            referencedRelation: "product_skus"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mkt_offers_free_item_sku_id_fkey"
            columns: ["free_item_sku_id"]
            isOneToOne: false
            referencedRelation: "product_skus_active"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mkt_offers_free_item_sku_id_fkey"
            columns: ["free_item_sku_id"]
            isOneToOne: false
            referencedRelation: "supplier_portal_skus"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mkt_offers_sale_id_fkey"
            columns: ["sale_id"]
            isOneToOne: false
            referencedRelation: "mkt_sales"
            referencedColumns: ["id"]
          },
        ]
      }
      mkt_sales: {
        Row: {
          created_at: string
          created_by: string | null
          ends_at: string | null
          id: string
          name: string
          notes: string | null
          starts_at: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          ends_at?: string | null
          id?: string
          name: string
          notes?: string | null
          starts_at?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          ends_at?: string | null
          id?: string
          name?: string
          notes?: string | null
          starts_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "mkt_sales_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      product_boms: {
        Row: {
          assembled_at_supplier_id: string
          component_location_id: string | null
          component_sku_id: string
          component_type: string
          created_at: string
          effective_from: string
          effective_until: string | null
          id: string
          notes: string | null
          parent_sku_id: string
          row_version: number
          units_per_parent: number
          updated_at: string
        }
        Insert: {
          assembled_at_supplier_id: string
          component_location_id?: string | null
          component_sku_id: string
          component_type: string
          created_at?: string
          effective_from?: string
          effective_until?: string | null
          id?: string
          notes?: string | null
          parent_sku_id: string
          row_version?: number
          units_per_parent?: number
          updated_at?: string
        }
        Update: {
          assembled_at_supplier_id?: string
          component_location_id?: string | null
          component_sku_id?: string
          component_type?: string
          created_at?: string
          effective_from?: string
          effective_until?: string | null
          id?: string
          notes?: string | null
          parent_sku_id?: string
          row_version?: number
          units_per_parent?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "product_boms_assembled_at_supplier_id_fkey"
            columns: ["assembled_at_supplier_id"]
            isOneToOne: false
            referencedRelation: "suppliers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_boms_component_location_id_fkey"
            columns: ["component_location_id"]
            isOneToOne: false
            referencedRelation: "locations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_boms_component_sku_id_fkey"
            columns: ["component_sku_id"]
            isOneToOne: false
            referencedRelation: "product_skus"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_boms_component_sku_id_fkey"
            columns: ["component_sku_id"]
            isOneToOne: false
            referencedRelation: "product_skus_active"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_boms_component_sku_id_fkey"
            columns: ["component_sku_id"]
            isOneToOne: false
            referencedRelation: "supplier_portal_skus"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_boms_parent_sku_id_fkey"
            columns: ["parent_sku_id"]
            isOneToOne: false
            referencedRelation: "product_skus"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_boms_parent_sku_id_fkey"
            columns: ["parent_sku_id"]
            isOneToOne: false
            referencedRelation: "product_skus_active"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_boms_parent_sku_id_fkey"
            columns: ["parent_sku_id"]
            isOneToOne: false
            referencedRelation: "supplier_portal_skus"
            referencedColumns: ["id"]
          },
        ]
      }
      product_skus: {
        Row: {
          abc_classification: string | null
          archive_reason: string | null
          archived_at: string | null
          archived_by: string | null
          category: string
          created_at: string
          display_category: string
          id: string
          is_active: boolean | null
          monthly_demand: number | null
          product_name: string
          retail_price: number | null
          row_version: number
          sku: string
          standard_quantity_per_carton: number | null
          upc_code: string | null
          updated_at: string
        }
        Insert: {
          abc_classification?: string | null
          archive_reason?: string | null
          archived_at?: string | null
          archived_by?: string | null
          category: string
          created_at?: string
          display_category?: string
          id?: string
          is_active?: boolean | null
          monthly_demand?: number | null
          product_name: string
          retail_price?: number | null
          row_version?: number
          sku: string
          standard_quantity_per_carton?: number | null
          upc_code?: string | null
          updated_at?: string
        }
        Update: {
          abc_classification?: string | null
          archive_reason?: string | null
          archived_at?: string | null
          archived_by?: string | null
          category?: string
          created_at?: string
          display_category?: string
          id?: string
          is_active?: boolean | null
          monthly_demand?: number | null
          product_name?: string
          retail_price?: number | null
          row_version?: number
          sku?: string
          standard_quantity_per_carton?: number | null
          upc_code?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "product_skus_archived_by_fkey"
            columns: ["archived_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          avatar_url: string | null
          created_at: string
          email: string
          full_name: string
          homebase_employee_id: string | null
          homebase_employee_name: string | null
          homebase_linked_at: string | null
          homebase_linked_by: string | null
          id: string
          is_active: boolean
          role: string
          row_version: number
          supplier_id: string | null
          updated_at: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          email: string
          full_name: string
          homebase_employee_id?: string | null
          homebase_employee_name?: string | null
          homebase_linked_at?: string | null
          homebase_linked_by?: string | null
          id: string
          is_active?: boolean
          role?: string
          row_version?: number
          supplier_id?: string | null
          updated_at?: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          email?: string
          full_name?: string
          homebase_employee_id?: string | null
          homebase_employee_name?: string | null
          homebase_linked_at?: string | null
          homebase_linked_by?: string | null
          id?: string
          is_active?: boolean
          role?: string
          row_version?: number
          supplier_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "profiles_homebase_linked_by_fkey"
            columns: ["homebase_linked_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "profiles_supplier_id_fkey"
            columns: ["supplier_id"]
            isOneToOne: false
            referencedRelation: "suppliers"
            referencedColumns: ["id"]
          },
        ]
      }
      sales_daily: {
        Row: {
          sale_date: string
          sku_id: string
          source: string
          units: number
          updated_at: string
        }
        Insert: {
          sale_date: string
          sku_id: string
          source?: string
          units?: number
          updated_at?: string
        }
        Update: {
          sale_date?: string
          sku_id?: string
          source?: string
          units?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "sales_daily_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "product_skus"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sales_daily_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "product_skus_active"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sales_daily_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "supplier_portal_skus"
            referencedColumns: ["id"]
          },
        ]
      }
      shipment_variances: {
        Row: {
          acknowledged_at: string | null
          acknowledged_by: string | null
          created_at: string
          created_by: string | null
          declared_quantity: number
          freight_line_item_id: string
          id: string
          notes: string | null
          origin_supplier_id: string
          received_quantity: number
          resolution_notes: string | null
          resolved_at: string | null
          resolved_by: string | null
          shipment_id: string
          sku_id: string
          status: string
          variance_quantity: number | null
          variance_type: string
        }
        Insert: {
          acknowledged_at?: string | null
          acknowledged_by?: string | null
          created_at?: string
          created_by?: string | null
          declared_quantity: number
          freight_line_item_id: string
          id?: string
          notes?: string | null
          origin_supplier_id: string
          received_quantity: number
          resolution_notes?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          shipment_id: string
          sku_id: string
          status?: string
          variance_quantity?: number | null
          variance_type: string
        }
        Update: {
          acknowledged_at?: string | null
          acknowledged_by?: string | null
          created_at?: string
          created_by?: string | null
          declared_quantity?: number
          freight_line_item_id?: string
          id?: string
          notes?: string | null
          origin_supplier_id?: string
          received_quantity?: number
          resolution_notes?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          shipment_id?: string
          sku_id?: string
          status?: string
          variance_quantity?: number | null
          variance_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "shipment_variances_acknowledged_by_fkey"
            columns: ["acknowledged_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shipment_variances_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shipment_variances_freight_line_item_id_fkey"
            columns: ["freight_line_item_id"]
            isOneToOne: false
            referencedRelation: "freight_line_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shipment_variances_freight_line_item_id_fkey"
            columns: ["freight_line_item_id"]
            isOneToOne: false
            referencedRelation: "supplier_portal_freight_line_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shipment_variances_origin_supplier_id_fkey"
            columns: ["origin_supplier_id"]
            isOneToOne: false
            referencedRelation: "suppliers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shipment_variances_resolved_by_fkey"
            columns: ["resolved_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shipment_variances_shipment_id_fkey"
            columns: ["shipment_id"]
            isOneToOne: false
            referencedRelation: "freight_shipments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shipment_variances_shipment_id_fkey"
            columns: ["shipment_id"]
            isOneToOne: false
            referencedRelation: "supplier_portal_freight_shipments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shipment_variances_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "product_skus"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shipment_variances_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "product_skus_active"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shipment_variances_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "supplier_portal_skus"
            referencedColumns: ["id"]
          },
        ]
      }
      shipstation_order_items: {
        Row: {
          created_at: string
          id: string
          quantity: number
          shipstation_line_item_id: number | null
          shipstation_order_id: string
          sku_code: string
          sku_id: string | null
          unit_price_cents: number
        }
        Insert: {
          created_at?: string
          id?: string
          quantity: number
          shipstation_line_item_id?: number | null
          shipstation_order_id: string
          sku_code: string
          sku_id?: string | null
          unit_price_cents?: number
        }
        Update: {
          created_at?: string
          id?: string
          quantity?: number
          shipstation_line_item_id?: number | null
          shipstation_order_id?: string
          sku_code?: string
          sku_id?: string | null
          unit_price_cents?: number
        }
        Relationships: [
          {
            foreignKeyName: "shipstation_order_items_shipstation_order_id_fkey"
            columns: ["shipstation_order_id"]
            isOneToOne: false
            referencedRelation: "shipstation_orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shipstation_order_items_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "product_skus"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shipstation_order_items_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "product_skus_active"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shipstation_order_items_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "supplier_portal_skus"
            referencedColumns: ["id"]
          },
        ]
      }
      shipstation_orders: {
        Row: {
          box_applied_at: string | null
          created_at: string
          customer_email: string | null
          customer_name: string | null
          id: string
          inventory_applied_at: string | null
          inventory_apply_attempts: number
          inventory_apply_error: string | null
          last_seen_at: string
          last_seen_via: string | null
          order_date: string
          order_number: string
          order_status: string
          order_total_cents: number
          raw_payload: Json | null
          ship_date: string | null
          shipping_amount_cents: number
          shipstation_order_id: number
          store_id: number | null
          store_name: string | null
          tax_amount_cents: number
          updated_at: string
        }
        Insert: {
          box_applied_at?: string | null
          created_at?: string
          customer_email?: string | null
          customer_name?: string | null
          id?: string
          inventory_applied_at?: string | null
          inventory_apply_attempts?: number
          inventory_apply_error?: string | null
          last_seen_at?: string
          last_seen_via?: string | null
          order_date: string
          order_number: string
          order_status: string
          order_total_cents?: number
          raw_payload?: Json | null
          ship_date?: string | null
          shipping_amount_cents?: number
          shipstation_order_id: number
          store_id?: number | null
          store_name?: string | null
          tax_amount_cents?: number
          updated_at?: string
        }
        Update: {
          box_applied_at?: string | null
          created_at?: string
          customer_email?: string | null
          customer_name?: string | null
          id?: string
          inventory_applied_at?: string | null
          inventory_apply_attempts?: number
          inventory_apply_error?: string | null
          last_seen_at?: string
          last_seen_via?: string | null
          order_date?: string
          order_number?: string
          order_status?: string
          order_total_cents?: number
          raw_payload?: Json | null
          ship_date?: string | null
          shipping_amount_cents?: number
          shipstation_order_id?: number
          store_id?: number | null
          store_name?: string | null
          tax_amount_cents?: number
          updated_at?: string
        }
        Relationships: []
      }
      shipstation_sku_handling: {
        Row: {
          added_at: string
          added_by: string | null
          is_non_inventory: boolean
          notes: string | null
          resolved_sku_id: string | null
          sku_code: string
        }
        Insert: {
          added_at?: string
          added_by?: string | null
          is_non_inventory?: boolean
          notes?: string | null
          resolved_sku_id?: string | null
          sku_code: string
        }
        Update: {
          added_at?: string
          added_by?: string | null
          is_non_inventory?: boolean
          notes?: string | null
          resolved_sku_id?: string | null
          sku_code?: string
        }
        Relationships: [
          {
            foreignKeyName: "shipstation_sku_handling_added_by_fkey"
            columns: ["added_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shipstation_sku_handling_resolved_sku_id_fkey"
            columns: ["resolved_sku_id"]
            isOneToOne: false
            referencedRelation: "product_skus"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shipstation_sku_handling_resolved_sku_id_fkey"
            columns: ["resolved_sku_id"]
            isOneToOne: false
            referencedRelation: "product_skus_active"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shipstation_sku_handling_resolved_sku_id_fkey"
            columns: ["resolved_sku_id"]
            isOneToOne: false
            referencedRelation: "supplier_portal_skus"
            referencedColumns: ["id"]
          },
        ]
      }
      shipstation_sync_runs: {
        Row: {
          completed_at: string | null
          error_message: string | null
          from_date: string | null
          id: string
          notes: string | null
          orders_drift_detected: number
          orders_new: number
          orders_pulled: number
          orders_updated: number
          run_type: string
          started_at: string
          status: string
          to_date: string | null
        }
        Insert: {
          completed_at?: string | null
          error_message?: string | null
          from_date?: string | null
          id?: string
          notes?: string | null
          orders_drift_detected?: number
          orders_new?: number
          orders_pulled?: number
          orders_updated?: number
          run_type: string
          started_at?: string
          status?: string
          to_date?: string | null
        }
        Update: {
          completed_at?: string | null
          error_message?: string | null
          from_date?: string | null
          id?: string
          notes?: string | null
          orders_drift_detected?: number
          orders_new?: number
          orders_pulled?: number
          orders_updated?: number
          run_type?: string
          started_at?: string
          status?: string
          to_date?: string | null
        }
        Relationships: []
      }
      shipstation_webhook_events: {
        Row: {
          attempts: number
          event_id: string
          event_type: string
          id: string
          processed_at: string | null
          processing_error: string | null
          received_at: string
          request_body: Json | null
          request_headers: Json | null
          resource_url: string | null
          resulting_order_id: string | null
          signature_verified: boolean
        }
        Insert: {
          attempts?: number
          event_id: string
          event_type: string
          id?: string
          processed_at?: string | null
          processing_error?: string | null
          received_at?: string
          request_body?: Json | null
          request_headers?: Json | null
          resource_url?: string | null
          resulting_order_id?: string | null
          signature_verified?: boolean
        }
        Update: {
          attempts?: number
          event_id?: string
          event_type?: string
          id?: string
          processed_at?: string | null
          processing_error?: string | null
          received_at?: string
          request_body?: Json | null
          request_headers?: Json | null
          resource_url?: string | null
          resulting_order_id?: string | null
          signature_verified?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "shipstation_webhook_events_resulting_order_id_fkey"
            columns: ["resulting_order_id"]
            isOneToOne: false
            referencedRelation: "shipstation_orders"
            referencedColumns: ["id"]
          },
        ]
      }
      sku_economics: {
        Row: {
          additional_raw_cost: number | null
          additional_raw_cost_reason: string | null
          air_freight_cost_per_unit: number | null
          breakage_issue_cost: number | null
          created_at: string
          credit_card_fees: number | null
          glycerin_cost_us: number | null
          id: string
          labor_cost_us: number | null
          manufacturing_cost_cn: number | null
          mfg_override_active: boolean
          mfg_override_pct_prefilled: number | null
          mfg_window_days: number
          nancy_raw_cost: number | null
          packing_labor_cost: number | null
          packing_material_cost: number | null
          pct_air: number | null
          pct_from_nancy: number | null
          pct_from_yx: number | null
          pct_manufactured_cn: number | null
          pct_manufactured_us: number | null
          pct_sea: number | null
          row_version: number
          sea_freight_cost_per_unit: number | null
          shipping_cost: number | null
          sku_id: string
          updated_at: string
          yx_raw_cost: number | null
        }
        Insert: {
          additional_raw_cost?: number | null
          additional_raw_cost_reason?: string | null
          air_freight_cost_per_unit?: number | null
          breakage_issue_cost?: number | null
          created_at?: string
          credit_card_fees?: number | null
          glycerin_cost_us?: number | null
          id?: string
          labor_cost_us?: number | null
          manufacturing_cost_cn?: number | null
          mfg_override_active?: boolean
          mfg_override_pct_prefilled?: number | null
          mfg_window_days?: number
          nancy_raw_cost?: number | null
          packing_labor_cost?: number | null
          packing_material_cost?: number | null
          pct_air?: number | null
          pct_from_nancy?: number | null
          pct_from_yx?: number | null
          pct_manufactured_cn?: number | null
          pct_manufactured_us?: number | null
          pct_sea?: number | null
          row_version?: number
          sea_freight_cost_per_unit?: number | null
          shipping_cost?: number | null
          sku_id: string
          updated_at?: string
          yx_raw_cost?: number | null
        }
        Update: {
          additional_raw_cost?: number | null
          additional_raw_cost_reason?: string | null
          air_freight_cost_per_unit?: number | null
          breakage_issue_cost?: number | null
          created_at?: string
          credit_card_fees?: number | null
          glycerin_cost_us?: number | null
          id?: string
          labor_cost_us?: number | null
          manufacturing_cost_cn?: number | null
          mfg_override_active?: boolean
          mfg_override_pct_prefilled?: number | null
          mfg_window_days?: number
          nancy_raw_cost?: number | null
          packing_labor_cost?: number | null
          packing_material_cost?: number | null
          pct_air?: number | null
          pct_from_nancy?: number | null
          pct_from_yx?: number | null
          pct_manufactured_cn?: number | null
          pct_manufactured_us?: number | null
          pct_sea?: number | null
          row_version?: number
          sea_freight_cost_per_unit?: number | null
          shipping_cost?: number | null
          sku_id?: string
          updated_at?: string
          yx_raw_cost?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "sku_economics_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: true
            referencedRelation: "product_skus"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sku_economics_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: true
            referencedRelation: "product_skus_active"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sku_economics_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: true
            referencedRelation: "supplier_portal_skus"
            referencedColumns: ["id"]
          },
        ]
      }
      sku_forecasts: {
        Row: {
          computed_at: string
          data_points: number | null
          ewma_daily: number | null
          forecast_30d: number
          forecast_method: string | null
          last_sale_date: string | null
          lower_bound: number | null
          seasonal_index: number | null
          sku_id: string
          trend_multiplier: number | null
          upper_bound: number | null
        }
        Insert: {
          computed_at?: string
          data_points?: number | null
          ewma_daily?: number | null
          forecast_30d: number
          forecast_method?: string | null
          last_sale_date?: string | null
          lower_bound?: number | null
          seasonal_index?: number | null
          sku_id: string
          trend_multiplier?: number | null
          upper_bound?: number | null
        }
        Update: {
          computed_at?: string
          data_points?: number | null
          ewma_daily?: number | null
          forecast_30d?: number
          forecast_method?: string | null
          last_sale_date?: string | null
          lower_bound?: number | null
          seasonal_index?: number | null
          sku_id?: string
          trend_multiplier?: number | null
          upper_bound?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "sku_forecasts_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: true
            referencedRelation: "product_skus"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sku_forecasts_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: true
            referencedRelation: "product_skus_active"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sku_forecasts_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: true
            referencedRelation: "supplier_portal_skus"
            referencedColumns: ["id"]
          },
        ]
      }
      sku_material_consumption: {
        Row: {
          created_at: string
          id: string
          material_id: string
          notes: string | null
          quantity_per_unit: number
          sku_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          material_id: string
          notes?: string | null
          quantity_per_unit: number
          sku_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          material_id?: string
          notes?: string | null
          quantity_per_unit?: number
          sku_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "sku_material_consumption_material_id_fkey"
            columns: ["material_id"]
            isOneToOne: false
            referencedRelation: "materials"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sku_material_consumption_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "product_skus"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sku_material_consumption_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "product_skus_active"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sku_material_consumption_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "supplier_portal_skus"
            referencedColumns: ["id"]
          },
        ]
      }
      sku_supplier_costs: {
        Row: {
          created_at: string
          id: string
          is_primary: boolean
          notes: string | null
          row_version: number
          sku_id: string
          supplier_id: string
          unit_cost: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          is_primary?: boolean
          notes?: string | null
          row_version?: number
          sku_id: string
          supplier_id: string
          unit_cost: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          is_primary?: boolean
          notes?: string | null
          row_version?: number
          sku_id?: string
          supplier_id?: string
          unit_cost?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "sku_supplier_costs_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "product_skus"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sku_supplier_costs_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "product_skus_active"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sku_supplier_costs_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "supplier_portal_skus"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sku_supplier_costs_supplier_id_fkey"
            columns: ["supplier_id"]
            isOneToOne: false
            referencedRelation: "suppliers"
            referencedColumns: ["id"]
          },
        ]
      }
      suppliers: {
        Row: {
          address_line1: string | null
          address_line2: string | null
          city: string | null
          code: string
          consolidates_for: string[]
          contact_email: string | null
          contact_name: string | null
          contact_phone: string | null
          country: string
          created_at: string
          default_lead_time_days: number | null
          id: string
          invoice_currency: string
          is_active: boolean
          is_export_broker: boolean
          is_filler: boolean
          is_producer: boolean
          name: string
          notes: string | null
          payment_terms: string | null
          postal_code: string | null
          row_version: number
          state_region: string | null
          updated_at: string
        }
        Insert: {
          address_line1?: string | null
          address_line2?: string | null
          city?: string | null
          code: string
          consolidates_for?: string[]
          contact_email?: string | null
          contact_name?: string | null
          contact_phone?: string | null
          country?: string
          created_at?: string
          default_lead_time_days?: number | null
          id?: string
          invoice_currency?: string
          is_active?: boolean
          is_export_broker?: boolean
          is_filler?: boolean
          is_producer?: boolean
          name: string
          notes?: string | null
          payment_terms?: string | null
          postal_code?: string | null
          row_version?: number
          state_region?: string | null
          updated_at?: string
        }
        Update: {
          address_line1?: string | null
          address_line2?: string | null
          city?: string | null
          code?: string
          consolidates_for?: string[]
          contact_email?: string | null
          contact_name?: string | null
          contact_phone?: string | null
          country?: string
          created_at?: string
          default_lead_time_days?: number | null
          id?: string
          invoice_currency?: string
          is_active?: boolean
          is_export_broker?: boolean
          is_filler?: boolean
          is_producer?: boolean
          name?: string
          notes?: string | null
          payment_terms?: string | null
          postal_code?: string | null
          row_version?: number
          state_region?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      task_logs: {
        Row: {
          created_at: string
          employee_id: string
          id: string
          notes: string | null
          quantity_processed: number
          sku_id: string
          task_type: string
          time_completed: string | null
          time_started: string | null
        }
        Insert: {
          created_at?: string
          employee_id: string
          id?: string
          notes?: string | null
          quantity_processed: number
          sku_id: string
          task_type: string
          time_completed?: string | null
          time_started?: string | null
        }
        Update: {
          created_at?: string
          employee_id?: string
          id?: string
          notes?: string | null
          quantity_processed?: number
          sku_id?: string
          task_type?: string
          time_completed?: string | null
          time_started?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "task_logs_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "task_logs_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "product_skus"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "task_logs_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "product_skus_active"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "task_logs_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "supplier_portal_skus"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      inventory_levels_default: {
        Row: {
          id: string | null
          last_synced_at: string | null
          location_id: string | null
          row_version: number | null
          sku_id: string | null
          updated_at: string | null
          warehouse_finished: number | null
          warehouse_in_production: number | null
          warehouse_other: number | null
          warehouse_raw: number | null
        }
        Relationships: [
          {
            foreignKeyName: "inventory_levels_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "locations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_levels_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "product_skus"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_levels_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "product_skus_active"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_levels_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "supplier_portal_skus"
            referencedColumns: ["id"]
          },
        ]
      }
      inventory_totals_by_sku: {
        Row: {
          location_count: number | null
          most_recent_update: string | null
          sku_id: string | null
          warehouse_finished: number | null
          warehouse_in_production: number | null
          warehouse_other: number | null
          warehouse_raw: number | null
        }
        Relationships: [
          {
            foreignKeyName: "inventory_levels_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "product_skus"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_levels_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "product_skus_active"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_levels_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "supplier_portal_skus"
            referencedColumns: ["id"]
          },
        ]
      }
      product_boms_active: {
        Row: {
          assembled_at_supplier_id: string | null
          component_location_id: string | null
          component_sku_id: string | null
          component_type: string | null
          created_at: string | null
          effective_from: string | null
          effective_until: string | null
          id: string | null
          notes: string | null
          parent_sku_id: string | null
          row_version: number | null
          units_per_parent: number | null
          updated_at: string | null
        }
        Insert: {
          assembled_at_supplier_id?: string | null
          component_location_id?: string | null
          component_sku_id?: string | null
          component_type?: string | null
          created_at?: string | null
          effective_from?: string | null
          effective_until?: string | null
          id?: string | null
          notes?: string | null
          parent_sku_id?: string | null
          row_version?: number | null
          units_per_parent?: number | null
          updated_at?: string | null
        }
        Update: {
          assembled_at_supplier_id?: string | null
          component_location_id?: string | null
          component_sku_id?: string | null
          component_type?: string | null
          created_at?: string | null
          effective_from?: string | null
          effective_until?: string | null
          id?: string | null
          notes?: string | null
          parent_sku_id?: string | null
          row_version?: number | null
          units_per_parent?: number | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "product_boms_assembled_at_supplier_id_fkey"
            columns: ["assembled_at_supplier_id"]
            isOneToOne: false
            referencedRelation: "suppliers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_boms_component_location_id_fkey"
            columns: ["component_location_id"]
            isOneToOne: false
            referencedRelation: "locations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_boms_component_sku_id_fkey"
            columns: ["component_sku_id"]
            isOneToOne: false
            referencedRelation: "product_skus"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_boms_component_sku_id_fkey"
            columns: ["component_sku_id"]
            isOneToOne: false
            referencedRelation: "product_skus_active"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_boms_component_sku_id_fkey"
            columns: ["component_sku_id"]
            isOneToOne: false
            referencedRelation: "supplier_portal_skus"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_boms_parent_sku_id_fkey"
            columns: ["parent_sku_id"]
            isOneToOne: false
            referencedRelation: "product_skus"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_boms_parent_sku_id_fkey"
            columns: ["parent_sku_id"]
            isOneToOne: false
            referencedRelation: "product_skus_active"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_boms_parent_sku_id_fkey"
            columns: ["parent_sku_id"]
            isOneToOne: false
            referencedRelation: "supplier_portal_skus"
            referencedColumns: ["id"]
          },
        ]
      }
      product_skus_active: {
        Row: {
          abc_classification: string | null
          archive_reason: string | null
          archived_at: string | null
          archived_by: string | null
          category: string | null
          created_at: string | null
          display_category: string | null
          id: string | null
          is_active: boolean | null
          monthly_demand: number | null
          product_name: string | null
          retail_price: number | null
          row_version: number | null
          sku: string | null
          standard_quantity_per_carton: number | null
          upc_code: string | null
          updated_at: string | null
        }
        Insert: {
          abc_classification?: string | null
          archive_reason?: string | null
          archived_at?: string | null
          archived_by?: string | null
          category?: string | null
          created_at?: string | null
          display_category?: string | null
          id?: string | null
          is_active?: boolean | null
          monthly_demand?: number | null
          product_name?: string | null
          retail_price?: number | null
          row_version?: number | null
          sku?: string | null
          standard_quantity_per_carton?: number | null
          upc_code?: string | null
          updated_at?: string | null
        }
        Update: {
          abc_classification?: string | null
          archive_reason?: string | null
          archived_at?: string | null
          archived_by?: string | null
          category?: string | null
          created_at?: string | null
          display_category?: string | null
          id?: string | null
          is_active?: boolean | null
          monthly_demand?: number | null
          product_name?: string | null
          retail_price?: number | null
          row_version?: number | null
          sku?: string | null
          standard_quantity_per_carton?: number | null
          upc_code?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "product_skus_archived_by_fkey"
            columns: ["archived_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      shipstation_unmatched_boxes: {
        Row: {
          dims_key: string | null
          last_shipped: string | null
          shipments: number | null
        }
        Relationships: []
      }
      shipstation_unresolved_skus: {
        Row: {
          distinct_orders: number | null
          first_seen: string | null
          last_seen: string | null
          line_item_count: number | null
          sku_code: string | null
          total_units: number | null
        }
        Relationships: []
      }
      shipstation_unresolved_skus_pending: {
        Row: {
          distinct_orders: number | null
          first_seen: string | null
          last_seen: string | null
          line_item_count: number | null
          sku_code: string | null
          total_units: number | null
        }
        Relationships: []
      }
      supplier_portal_breakage_reports: {
        Row: {
          acknowledged_at: string | null
          created_at: string | null
          description: string | null
          factory_order_item_id: string | null
          id: string | null
          producing_supplier_id: string | null
          quantity_broken: number | null
          reason_category: string | null
          replacement_factory_order_id: string | null
          replacement_requested: boolean | null
          reporter_supplier_id: string | null
          resolution_notes: string | null
          resolved_at: string | null
          sku_id: string | null
          status: string | null
        }
        Insert: {
          acknowledged_at?: string | null
          created_at?: string | null
          description?: string | null
          factory_order_item_id?: string | null
          id?: string | null
          producing_supplier_id?: string | null
          quantity_broken?: number | null
          reason_category?: string | null
          replacement_factory_order_id?: string | null
          replacement_requested?: boolean | null
          reporter_supplier_id?: string | null
          resolution_notes?: string | null
          resolved_at?: string | null
          sku_id?: string | null
          status?: string | null
        }
        Update: {
          acknowledged_at?: string | null
          created_at?: string | null
          description?: string | null
          factory_order_item_id?: string | null
          id?: string | null
          producing_supplier_id?: string | null
          quantity_broken?: number | null
          reason_category?: string | null
          replacement_factory_order_id?: string | null
          replacement_requested?: boolean | null
          reporter_supplier_id?: string | null
          resolution_notes?: string | null
          resolved_at?: string | null
          sku_id?: string | null
          status?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "component_breakage_reports_factory_order_item_id_fkey"
            columns: ["factory_order_item_id"]
            isOneToOne: false
            referencedRelation: "factory_order_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "component_breakage_reports_factory_order_item_id_fkey"
            columns: ["factory_order_item_id"]
            isOneToOne: false
            referencedRelation: "supplier_portal_factory_order_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "component_breakage_reports_producing_supplier_id_fkey"
            columns: ["producing_supplier_id"]
            isOneToOne: false
            referencedRelation: "suppliers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "component_breakage_reports_replacement_factory_order_id_fkey"
            columns: ["replacement_factory_order_id"]
            isOneToOne: false
            referencedRelation: "factory_orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "component_breakage_reports_replacement_factory_order_id_fkey"
            columns: ["replacement_factory_order_id"]
            isOneToOne: false
            referencedRelation: "supplier_portal_factory_orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "component_breakage_reports_reporter_supplier_id_fkey"
            columns: ["reporter_supplier_id"]
            isOneToOne: false
            referencedRelation: "suppliers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "component_breakage_reports_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "product_skus"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "component_breakage_reports_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "product_skus_active"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "component_breakage_reports_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "supplier_portal_skus"
            referencedColumns: ["id"]
          },
        ]
      }
      supplier_portal_factory_order_items: {
        Row: {
          consolidator_confirmed_at: string | null
          consolidator_confirmed_quantity: number | null
          created_at: string | null
          factory_order_id: string | null
          id: string | null
          quantity_breakage: number | null
          quantity_ordered: number | null
          row_version: number | null
          sku_id: string | null
        }
        Insert: {
          consolidator_confirmed_at?: string | null
          consolidator_confirmed_quantity?: number | null
          created_at?: string | null
          factory_order_id?: string | null
          id?: string | null
          quantity_breakage?: number | null
          quantity_ordered?: number | null
          row_version?: number | null
          sku_id?: string | null
        }
        Update: {
          consolidator_confirmed_at?: string | null
          consolidator_confirmed_quantity?: number | null
          created_at?: string | null
          factory_order_id?: string | null
          id?: string | null
          quantity_breakage?: number | null
          quantity_ordered?: number | null
          row_version?: number | null
          sku_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "factory_order_items_factory_order_id_fkey"
            columns: ["factory_order_id"]
            isOneToOne: false
            referencedRelation: "factory_orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "factory_order_items_factory_order_id_fkey"
            columns: ["factory_order_id"]
            isOneToOne: false
            referencedRelation: "supplier_portal_factory_orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "factory_order_items_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "product_skus"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "factory_order_items_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "product_skus_active"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "factory_order_items_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "supplier_portal_skus"
            referencedColumns: ["id"]
          },
        ]
      }
      supplier_portal_factory_orders: {
        Row: {
          canceled_at: string | null
          canceled_reason: string | null
          created_at: string | null
          expected_completion: string | null
          id: string | null
          notes: string | null
          order_date: string | null
          row_version: number | null
          ship_via_supplier_id: string | null
          status: string | null
          supplier_id: string | null
          updated_at: string | null
        }
        Insert: {
          canceled_at?: string | null
          canceled_reason?: string | null
          created_at?: string | null
          expected_completion?: string | null
          id?: string | null
          notes?: string | null
          order_date?: string | null
          row_version?: number | null
          ship_via_supplier_id?: string | null
          status?: string | null
          supplier_id?: string | null
          updated_at?: string | null
        }
        Update: {
          canceled_at?: string | null
          canceled_reason?: string | null
          created_at?: string | null
          expected_completion?: string | null
          id?: string | null
          notes?: string | null
          order_date?: string | null
          row_version?: number | null
          ship_via_supplier_id?: string | null
          status?: string | null
          supplier_id?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "factory_orders_ship_via_supplier_id_fkey"
            columns: ["ship_via_supplier_id"]
            isOneToOne: false
            referencedRelation: "suppliers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "factory_orders_supplier_id_fkey"
            columns: ["supplier_id"]
            isOneToOne: false
            referencedRelation: "suppliers"
            referencedColumns: ["id"]
          },
        ]
      }
      supplier_portal_freight_line_items: {
        Row: {
          created_at: string | null
          freight_shipment_id: string | null
          id: string | null
          quantity: number | null
          quantity_prefilled: number | null
          sku_id: string | null
          source_factory_order_item_id: string | null
          supplier_declared_quantity: number | null
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          freight_shipment_id?: string | null
          id?: string | null
          quantity?: number | null
          quantity_prefilled?: number | null
          sku_id?: string | null
          source_factory_order_item_id?: string | null
          supplier_declared_quantity?: number | null
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          freight_shipment_id?: string | null
          id?: string | null
          quantity?: number | null
          quantity_prefilled?: number | null
          sku_id?: string | null
          source_factory_order_item_id?: string | null
          supplier_declared_quantity?: number | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "freight_line_items_freight_shipment_id_fkey"
            columns: ["freight_shipment_id"]
            isOneToOne: false
            referencedRelation: "freight_shipments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "freight_line_items_freight_shipment_id_fkey"
            columns: ["freight_shipment_id"]
            isOneToOne: false
            referencedRelation: "supplier_portal_freight_shipments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "freight_line_items_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "product_skus"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "freight_line_items_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "product_skus_active"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "freight_line_items_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "supplier_portal_skus"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "freight_line_items_source_factory_order_item_id_fkey"
            columns: ["source_factory_order_item_id"]
            isOneToOne: false
            referencedRelation: "factory_order_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "freight_line_items_source_factory_order_item_id_fkey"
            columns: ["source_factory_order_item_id"]
            isOneToOne: false
            referencedRelation: "supplier_portal_factory_order_items"
            referencedColumns: ["id"]
          },
        ]
      }
      supplier_portal_freight_shipments: {
        Row: {
          actual_arrival_date: string | null
          carrier_name: string | null
          created_at: string | null
          created_by_supplier_user_id: string | null
          eta: string | null
          eta_original: string | null
          id: string | null
          idempotency_key: string | null
          origin_supplier_id: string | null
          row_version: number | null
          status: string | null
          total_cartons: number | null
          tracking_number: string | null
          updated_at: string | null
        }
        Insert: {
          actual_arrival_date?: string | null
          carrier_name?: string | null
          created_at?: string | null
          created_by_supplier_user_id?: string | null
          eta?: string | null
          eta_original?: string | null
          id?: string | null
          idempotency_key?: string | null
          origin_supplier_id?: string | null
          row_version?: number | null
          status?: string | null
          total_cartons?: number | null
          tracking_number?: string | null
          updated_at?: string | null
        }
        Update: {
          actual_arrival_date?: string | null
          carrier_name?: string | null
          created_at?: string | null
          created_by_supplier_user_id?: string | null
          eta?: string | null
          eta_original?: string | null
          id?: string | null
          idempotency_key?: string | null
          origin_supplier_id?: string | null
          row_version?: number | null
          status?: string | null
          total_cartons?: number | null
          tracking_number?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "freight_shipments_created_by_supplier_user_id_fkey"
            columns: ["created_by_supplier_user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "freight_shipments_origin_supplier_id_fkey"
            columns: ["origin_supplier_id"]
            isOneToOne: false
            referencedRelation: "suppliers"
            referencedColumns: ["id"]
          },
        ]
      }
      supplier_portal_skus: {
        Row: {
          category: string | null
          created_at: string | null
          id: string | null
          is_active: boolean | null
          product_name: string | null
          sku: string | null
        }
        Insert: {
          category?: string | null
          created_at?: string | null
          id?: string | null
          is_active?: boolean | null
          product_name?: string | null
          sku?: string | null
        }
        Update: {
          category?: string | null
          created_at?: string | null
          id?: string | null
          is_active?: boolean | null
          product_name?: string | null
          sku?: string | null
        }
        Relationships: []
      }
      supplier_portal_variances: {
        Row: {
          acknowledged_at: string | null
          created_at: string | null
          declared_quantity: number | null
          freight_line_item_id: string | null
          id: string | null
          notes: string | null
          origin_supplier_id: string | null
          received_quantity: number | null
          resolution_notes: string | null
          resolved_at: string | null
          shipment_id: string | null
          sku_id: string | null
          status: string | null
          variance_quantity: number | null
          variance_type: string | null
        }
        Insert: {
          acknowledged_at?: string | null
          created_at?: string | null
          declared_quantity?: number | null
          freight_line_item_id?: string | null
          id?: string | null
          notes?: string | null
          origin_supplier_id?: string | null
          received_quantity?: number | null
          resolution_notes?: string | null
          resolved_at?: string | null
          shipment_id?: string | null
          sku_id?: string | null
          status?: string | null
          variance_quantity?: number | null
          variance_type?: string | null
        }
        Update: {
          acknowledged_at?: string | null
          created_at?: string | null
          declared_quantity?: number | null
          freight_line_item_id?: string | null
          id?: string | null
          notes?: string | null
          origin_supplier_id?: string | null
          received_quantity?: number | null
          resolution_notes?: string | null
          resolved_at?: string | null
          shipment_id?: string | null
          sku_id?: string | null
          status?: string | null
          variance_quantity?: number | null
          variance_type?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "shipment_variances_freight_line_item_id_fkey"
            columns: ["freight_line_item_id"]
            isOneToOne: false
            referencedRelation: "freight_line_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shipment_variances_freight_line_item_id_fkey"
            columns: ["freight_line_item_id"]
            isOneToOne: false
            referencedRelation: "supplier_portal_freight_line_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shipment_variances_origin_supplier_id_fkey"
            columns: ["origin_supplier_id"]
            isOneToOne: false
            referencedRelation: "suppliers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shipment_variances_shipment_id_fkey"
            columns: ["shipment_id"]
            isOneToOne: false
            referencedRelation: "freight_shipments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shipment_variances_shipment_id_fkey"
            columns: ["shipment_id"]
            isOneToOne: false
            referencedRelation: "supplier_portal_freight_shipments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shipment_variances_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "product_skus"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shipment_variances_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "product_skus_active"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shipment_variances_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "supplier_portal_skus"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      _apply_box_for_shipped_order: {
        Args: { p_order_id: string }
        Returns: string
      }
      _default_location_id: { Args: never; Returns: string }
      _factory_order_fully_shipped: {
        Args: { p_order_id: string }
        Returns: boolean
      }
      _recompute_consumption_for_parent: {
        Args: { p_parent_order_id: string }
        Returns: undefined
      }
      _recompute_factory_order_status: {
        Args: { p_actor: string; p_order_id: string }
        Returns: undefined
      }
      _task_type_movement: {
        Args: { p_task_type: string }
        Returns: {
          from_field: string
          to_field: string
        }[]
      }
      archive_sku: {
        Args: { p_actor_id: string; p_reason: string; p_sku_id: string }
        Returns: undefined
      }
      archive_sku_force: {
        Args: { p_actor_id: string; p_reason: string; p_sku_id: string }
        Returns: undefined
      }
      jwt_is_internal: { Args: never; Returns: boolean }
      jwt_supplier_id: { Args: never; Returns: string }
      jwt_supplier_scope: { Args: never; Returns: string[] }
      restore_sku: {
        Args: { p_actor_id: string; p_sku_id: string }
        Returns: undefined
      }
      rpc_acknowledge_breakage_report: {
        Args: { p_dispute?: boolean; p_report_id: string }
        Returns: Json
      }
      rpc_acknowledge_shipment_variance: {
        Args: { p_variance_id: string }
        Returns: Json
      }
      rpc_admin_edit_factory_order: {
        Args: {
          p_expected_version: number
          p_order_id: string
          p_payload: Json
        }
        Returns: Json
      }
      rpc_admin_link_factory_order_to_parent: {
        Args: { p_child_order_id: string; p_parent_order_id: string }
        Returns: undefined
      }
      rpc_admin_set_factory_order_progress: {
        Args: {
          p_expected_version: number
          p_line_ops: Json
          p_order_id: string
        }
        Returns: Json
      }
      rpc_admin_unlink_factory_order_from_parent: {
        Args: { p_child_order_id: string }
        Returns: undefined
      }
      rpc_apply_freight_delivery: {
        Args: { p_actor_id: string; p_shipment_id: string }
        Returns: Json
      }
      rpc_apply_freight_status_override: {
        Args: {
          p_actor_id: string
          p_expected_version: number
          p_new_status: string
          p_reason?: string
          p_shipment_id: string
        }
        Returns: Json
      }
      rpc_apply_shipstation_boxes: {
        Args: { p_limit?: number; p_system_actor_id?: string }
        Returns: Json
      }
      rpc_apply_shipstation_sale: {
        Args: { p_order_id: string; p_system_actor_id?: string }
        Returns: Json
      }
      rpc_bulk_cycle_count: {
        Args: {
          p_actor_id: string
          p_adjustments: Json
          p_notes: string
          p_reason: string
        }
        Returns: Json
      }
      rpc_bulk_material_cycle_count: {
        Args: {
          p_actor_id: string
          p_adjustments: Json
          p_notes: string
          p_reason: string
        }
        Returns: Json
      }
      rpc_clear_freight_status_override: {
        Args: {
          p_actor_id: string
          p_expected_version: number
          p_shipment_id: string
        }
        Returns: Json
      }
      rpc_consolidator_confirm_factory_order_receive: {
        Args: { p_payload: Json }
        Returns: Json
      }
      rpc_cycle_count: {
        Args: {
          p_actor_id: string
          p_delta: number
          p_field: string
          p_notes: string
          p_reason: string
          p_sku_id: string
        }
        Returns: Json
      }
      rpc_factory_order_component_status: {
        Args: { p_factory_order_id: string }
        Returns: Json
      }
      rpc_factory_order_component_status_batch: {
        Args: { p_parent_order_ids: string[] }
        Returns: Json
      }
      rpc_file_component_breakage_report: {
        Args: {
          p_description: string
          p_factory_order_item_id: string
          p_quantity_broken: number
          p_reason_category: string
        }
        Returns: Json
      }
      rpc_inventory_retail_value_history: {
        Args: { p_days?: number }
        Returns: {
          day: string
          is_snapshot: boolean
          onorder_retail: number
          transit_retail: number
          warehouse_retail: number
        }[]
      }
      rpc_log_task_completion: {
        Args: {
          p_actor_id: string
          p_location_id?: string
          p_notes: string
          p_quantity: number
          p_sku_id: string
          p_task_type: string
          p_time_completed?: string
          p_time_started?: string
        }
        Returns: Json
      }
      rpc_manufacturing_clear_estimate: {
        Args: { p_days?: number }
        Returns: {
          incoming_prefilled: number
          incoming_raw: number
          prefilled_now: number
          prefilled_rtsing_per_day: number
          rtsing_per_day: number
          unfilled_now: number
        }[]
      }
      rpc_manufacturing_completion_history: {
        Args: { p_days?: number }
        Returns: {
          complete_units: number
          day: string
          unfilled_units: number
        }[]
      }
      rpc_material_usage_rates: {
        Args: { p_days?: number }
        Returns: {
          daily_usage: number
          data_points: number
          material_id: string
          units_consumed: number
        }[]
      }
      rpc_promote_user_to_supplier: {
        Args: { p_supplier_id: string; p_target_user_id: string }
        Returns: Json
      }
      rpc_recompute_demand: {
        Args: { p_dry_run?: boolean }
        Returns: {
          delta: number
          new_demand: number
          old_demand: number
          sku: string
        }[]
      }
      rpc_refresh_sales_daily: { Args: { p_days?: number }; Returns: number }
      rpc_resolve_breakage_report: {
        Args: {
          p_replacement_factory_order_id?: string
          p_report_id: string
          p_resolution_notes: string
          p_write_off?: boolean
        }
        Returns: Json
      }
      rpc_resolve_shipment_variance: {
        Args: {
          p_resolution_notes: string
          p_variance_id: string
          p_write_off?: boolean
        }
        Returns: Json
      }
      rpc_sales_pulse: {
        Args: never
        Returns: {
          awaiting_orders: number
          orders_7d: number
          orders_prior_7d: number
          orders_today: number
          orders_yesterday: number
          units_7d: number
          units_prior_7d: number
          units_today: number
          units_yesterday: number
        }[]
      }
      rpc_set_profile_active: {
        Args: { p_is_active: boolean; p_target_user_id: string }
        Returns: Json
      }
      rpc_shipstation_register_non_inventory_sku: {
        Args: { p_notes?: string; p_sku_code: string }
        Returns: Json
      }
      rpc_shipstation_register_sku_alias: {
        Args: {
          p_notes?: string
          p_resolved_sku_id: string
          p_sku_code: string
        }
        Returns: Json
      }
      rpc_shipstation_unregister_sku_alias: {
        Args: { p_sku_code: string }
        Returns: Json
      }
      rpc_snapshot_inventory_retail_value: { Args: never; Returns: undefined }
      rpc_supplier_advance_factory_order: {
        Args: {
          p_expected_version: number
          p_factory_order_id: string
          p_notes?: string
        }
        Returns: Json
      }
      rpc_supplier_cancel_factory_order: {
        Args: {
          p_expected_version: number
          p_factory_order_id: string
          p_reason: string
        }
        Returns: Json
      }
      rpc_supplier_create_factory_order: {
        Args: { p_payload: Json }
        Returns: Json
      }
      rpc_supplier_create_freight_shipment: {
        Args: { p_payload: Json }
        Returns: Json
      }
      rpc_supplier_report_item_finished: {
        Args: {
          p_expected_version: number
          p_factory_order_item_id: string
          p_quantity_finished: number
        }
        Returns: Json
      }
      rpc_supplier_set_item_alternate_eta: {
        Args: {
          p_alternate_eta: string
          p_expected_version: number
          p_factory_order_item_id: string
        }
        Returns: Json
      }
      rpc_supplier_update_shipment_tracking: {
        Args: {
          p_carrier?: string
          p_clear_carrier?: boolean
          p_clear_eta?: boolean
          p_clear_freight_cost?: boolean
          p_clear_ship_date?: boolean
          p_clear_tracking_number?: boolean
          p_eta?: string
          p_expected_version: number
          p_freight_cost?: number
          p_ship_date?: string
          p_shipment_id: string
          p_tracking_number?: string
        }
        Returns: Json
      }
      rpc_update_user_role: {
        Args: {
          p_actor_id: string
          p_new_role: string
          p_target_user_id: string
        }
        Returns: Json
      }
      verify_audit_chain: {
        Args: { p_from_seq?: number }
        Returns: {
          first_broken_at: string
          first_broken_id: string
          message: string
        }[]
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
