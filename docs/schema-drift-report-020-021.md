# Schema Drift Report — Migrations 020 + 021
Generated: 2026-04-21  
Source: live Supabase project `sitwttqdqqkucwkcyoks`

---

## Section 1: information_schema.columns (affected tables)

### component_breakage_reports (18 cols)
| column | data_type | nullable | default |
|--------|-----------|----------|---------|
| id | uuid | NO | gen_random_uuid() |
| factory_order_item_id | uuid | NO | |
| producing_supplier_id | uuid | NO | |
| reporter_supplier_id | uuid | NO | |
| sku_id | uuid | NO | |
| quantity_broken | integer | NO | |
| reason_category | text | NO | |
| description | text | NO | |
| replacement_requested | boolean | NO | false |
| replacement_factory_order_id | uuid | YES | |
| status | text | NO | 'open'::text |
| acknowledged_at | timestamp with time zone | YES | |
| acknowledged_by | uuid | YES | |
| resolution_notes | text | YES | |
| resolved_at | timestamp with time zone | YES | |
| resolved_by | uuid | YES | |
| created_at | timestamp with time zone | NO | now() |
| created_by | uuid | NO | |

### factory_order_items (12 cols)
| column | data_type | nullable | default |
|--------|-----------|----------|---------|
| id | uuid | NO | gen_random_uuid() |
| factory_order_id | uuid | NO | |
| sku_id | uuid | NO | |
| quantity_ordered | integer | NO | |
| quantity_finished | integer | YES | |
| unit_cost | numeric | YES | |
| created_at | timestamp with time zone | NO | now() |
| row_version | integer | NO | 1 |
| consolidator_confirmed_quantity | integer | YES | |
| consolidator_confirmed_at | timestamp with time zone | YES | |
| consolidator_confirmed_by | uuid | YES | |
| quantity_breakage | integer | NO | 0 |

### factory_orders (15 cols)
| column | data_type | nullable | default |
|--------|-----------|----------|---------|
| id | uuid | NO | gen_random_uuid() |
| order_number | text | YES | |
| status | text | NO | |
| order_date | date | NO | |
| expected_completion | date | YES | |
| notes | text | YES | |
| created_at | timestamp with time zone | NO | now() |
| updated_at | timestamp with time zone | NO | now() |
| row_version | integer | NO | 1 |
| supplier_id | uuid | YES | |
| ship_via_supplier_id | uuid | YES | |
| canceled_at | timestamp with time zone | YES | |
| canceled_by | uuid | YES | |
| canceled_reason | text | YES | |
| idempotency_key | uuid | YES | |

### freight_line_items (11 cols)
| column | data_type | nullable | default |
|--------|-----------|----------|---------|
| id | uuid | NO | gen_random_uuid() |
| freight_shipment_id | uuid | NO | |
| sku_id | uuid | NO | |
| quantity | integer | NO | |
| unit_cost | numeric | NO | 0 |
| retail_value | numeric | YES | |
| created_at | timestamp with time zone | NO | now() |
| updated_at | timestamp with time zone | NO | now() |
| row_version | integer | NO | 1 |
| supplier_declared_quantity | integer | YES | |
| source_factory_order_item_id | uuid | YES | |

### freight_shipments (27 cols)
| column | data_type | nullable | default |
|--------|-----------|----------|---------|
| id | uuid | NO | gen_random_uuid() |
| shipment_number | text | YES | |
| freight_type | text | NO | |
| status | text | NO | |
| carrier_name | text | YES | |
| broker_name | text | YES | |
| forwarder_id | uuid | YES | |
| tracking_number | text | YES | |
| ship_date | date | YES | |
| eta | date | YES | |
| actual_arrival_date | date | YES | |
| freight_cost | numeric | YES | |
| insurance_cost | numeric | YES | |
| duties_cost | numeric | YES | |
| total_cost | numeric | YES | |
| notes | text | YES | |
| created_at | timestamp with time zone | NO | now() |
| updated_at | timestamp with time zone | NO | now() |
| eta_original | date | YES | |
| eta_last_checked_at | timestamp with time zone | YES | |
| status_overridden_at | timestamp with time zone | YES | |
| total_cartons | integer | YES | |
| row_version | integer | NO | 1 |
| status_overridden_by | uuid | YES | |
| origin_supplier_id | uuid | YES | |
| created_by_supplier_user_id | uuid | YES | |
| idempotency_key | uuid | YES | |

### locations (16 cols)
| column | data_type | nullable | default |
|--------|-----------|----------|---------|
| id | uuid | NO | gen_random_uuid() |
| code | text | NO | |
| name | text | NO | |
| location_type | text | NO | |
| address_line1 | text | YES | |
| address_line2 | text | YES | |
| city | text | YES | |
| state | text | YES | |
| postal_code | text | YES | |
| country | text | YES | 'US'::text |
| is_default | boolean | NO | false |
| is_active | boolean | NO | true |
| row_version | integer | NO | 1 |
| created_at | timestamp with time zone | NO | now() |
| updated_at | timestamp with time zone | NO | now() |
| owner_supplier_id | uuid | YES | |

### product_boms (13 cols)
| column | data_type | nullable | default |
|--------|-----------|----------|---------|
| id | uuid | NO | gen_random_uuid() |
| parent_sku_id | uuid | NO | |
| component_sku_id | uuid | NO | |
| component_type | text | NO | |
| units_per_parent | integer | NO | 1 |
| assembled_at_supplier_id | uuid | NO | |
| component_location_id | uuid | YES | |
| effective_from | date | NO | CURRENT_DATE |
| effective_until | date | YES | |
| notes | text | YES | |
| created_at | timestamp with time zone | NO | now() |
| updated_at | timestamp with time zone | NO | now() |
| row_version | integer | NO | 1 |

### product_skus (17 cols)
| column | data_type | nullable | default |
|--------|-----------|----------|---------|
| id | uuid | NO | gen_random_uuid() |
| sku | text | NO | |
| product_name | text | NO | |
| upc_code | text | YES | |
| category | text | NO | |
| display_category | text | NO | 'Accessories'::text |
| retail_price | numeric | YES | |
| standard_quantity_per_carton | integer | YES | |
| abc_classification | text | YES | |
| monthly_demand | numeric | YES | |
| is_active | boolean | NO | true |
| created_at | timestamp with time zone | NO | now() |
| updated_at | timestamp with time zone | NO | now() |
| row_version | integer | NO | 1 |
| archived_at | timestamp with time zone | YES | |
| archived_by | uuid | YES | |
| archive_reason | text | YES | |

### profiles (14 cols)
| column | data_type | nullable | default |
|--------|-----------|----------|---------|
| id | uuid | NO | |
| email | text | NO | |
| full_name | text | NO | |
| role | text | NO | 'user'::text |
| avatar_url | text | YES | |
| created_at | timestamp with time zone | YES | now() |
| updated_at | timestamp with time zone | YES | now() |
| row_version | integer | NO | 1 |
| homebase_employee_id | text | YES | |
| homebase_employee_name | text | YES | |
| homebase_linked_at | timestamp with time zone | YES | |
| homebase_linked_by | uuid | YES | |
| supplier_id | uuid | YES | |
| is_active | boolean | NO | true |

### shipment_variances (18 cols)
| column | data_type | nullable | default |
|--------|-----------|----------|---------|
| id | uuid | NO | gen_random_uuid() |
| freight_line_item_id | uuid | NO | |
| shipment_id | uuid | NO | |
| sku_id | uuid | NO | |
| origin_supplier_id | uuid | NO | |
| declared_quantity | integer | NO | |
| received_quantity | integer | NO | |
| variance_quantity | integer | YES | (generated) |
| variance_type | text | NO | |
| status | text | NO | 'open'::text |
| notes | text | YES | |
| resolution_notes | text | YES | |
| acknowledged_at | timestamp with time zone | YES | |
| acknowledged_by | uuid | YES | |
| resolved_at | timestamp with time zone | YES | |
| resolved_by | uuid | YES | |
| created_at | timestamp with time zone | NO | now() |
| created_by | uuid | YES | |

### suppliers (24 cols)
| column | data_type | nullable | default |
|--------|-----------|----------|---------|
| id | uuid | NO | gen_random_uuid() |
| code | text | NO | |
| name | text | NO | |
| contact_name | text | YES | |
| contact_email | text | YES | |
| contact_phone | text | YES | |
| address_line1 | text | YES | |
| address_line2 | text | YES | |
| city | text | YES | |
| state_region | text | YES | |
| postal_code | text | YES | |
| country | text | NO | 'CN'::text |
| default_lead_time_days | integer | YES | |
| payment_terms | text | YES | |
| invoice_currency | character | NO | 'USD'::bpchar |
| notes | text | YES | |
| is_active | boolean | NO | true |
| row_version | integer | NO | 1 |
| created_at | timestamp with time zone | NO | now() |
| updated_at | timestamp with time zone | NO | now() |
| is_producer | boolean | NO | true |
| is_filler | boolean | NO | false |
| is_export_broker | boolean | NO | false |
| consolidates_for | ARRAY | NO | '{}'::uuid[] |

---

## Section 2a: RLS Policies (supplier_% on public schema)

| table | policy | cmd | using | with_check |
|-------|--------|-----|-------|------------|
| component_breakage_reports | supplier_insert_breakage_reports_as_reporter | INSERT | | (reporter_supplier_id = jwt_supplier_id()) AND (created_by = auth.uid()) AND (status = 'open') |
| component_breakage_reports | supplier_select_own_breakage_reports | SELECT | (producing_supplier_id = ANY(jwt_supplier_scope())) OR (reporter_supplier_id = ANY(jwt_supplier_scope())) | |
| factory_order_items | supplier_insert_own_foi | INSERT | | EXISTS(SELECT 1 FROM factory_orders fo WHERE fo.id = factory_order_items.factory_order_id AND fo.supplier_id = jwt_supplier_id() AND fo.status = 'ordered') AND consolidator_confirmed_quantity IS NULL AND consolidator_confirmed_at IS NULL AND consolidator_confirmed_by IS NULL AND quantity_breakage = 0 |
| factory_order_items | supplier_select_in_scope_foi | SELECT | EXISTS(SELECT 1 FROM factory_orders fo WHERE fo.id = factory_order_items.factory_order_id AND (fo.supplier_id = ANY(jwt_supplier_scope()) OR fo.ship_via_supplier_id = ANY(jwt_supplier_scope()))) | |
| factory_orders | supplier_insert_own_factory_orders | INSERT | | supplier_id = jwt_supplier_id() AND status = 'ordered' |
| factory_orders | supplier_select_in_scope_factory_orders | SELECT | supplier_id = ANY(jwt_supplier_scope()) OR ship_via_supplier_id = ANY(jwt_supplier_scope()) | |
| freight_line_items | supplier_insert_own_freight_lines | INSERT | | EXISTS(SELECT 1 FROM freight_shipments s WHERE s.id = freight_line_items.freight_shipment_id AND s.origin_supplier_id = jwt_supplier_id() AND s.status IN ('pending','booked')) AND supplier_declared_quantity IS NOT NULL AND quantity = supplier_declared_quantity |
| freight_line_items | supplier_select_own_freight_lines | SELECT | EXISTS(SELECT 1 FROM freight_shipments s WHERE s.id = freight_line_items.freight_shipment_id AND s.origin_supplier_id = ANY(jwt_supplier_scope())) | |
| freight_shipments | supplier_insert_own_shipments | INSERT | | origin_supplier_id = jwt_supplier_id() AND created_by_supplier_user_id = auth.uid() AND status IN ('pending','booked') |
| freight_shipments | supplier_select_own_shipments | SELECT | origin_supplier_id = ANY(jwt_supplier_scope()) | |
| inventory_levels | supplier_select_own_inventory | SELECT | EXISTS(SELECT 1 FROM locations l WHERE l.id = inventory_levels.location_id AND l.owner_supplier_id = ANY(jwt_supplier_scope())) | |
| locations | supplier_select_own_locations | SELECT | owner_supplier_id = ANY(jwt_supplier_scope()) | |
| product_boms | supplier_select_assembled_boms | SELECT | assembled_at_supplier_id = ANY(jwt_supplier_scope()) | |
| product_skus | supplier_select_related_skus | SELECT | jwt_supplier_id() IS NOT NULL AND (EXISTS(SELECT 1 FROM factory_order_items foi JOIN factory_orders fo ON fo.id = foi.factory_order_id WHERE foi.sku_id = product_skus.id AND fo.supplier_id = ANY(jwt_supplier_scope())) OR EXISTS(SELECT 1 FROM product_boms b WHERE b.component_sku_id = product_skus.id AND b.assembled_at_supplier_id = ANY(jwt_supplier_scope()) AND b.effective_until IS NULL) OR EXISTS(SELECT 1 FROM product_boms b WHERE b.parent_sku_id = product_skus.id AND b.assembled_at_supplier_id = ANY(jwt_supplier_scope()) AND b.effective_until IS NULL)) | |
| profiles | supplier_select_own_profile | SELECT | id = auth.uid() | |
| shipment_variances | supplier_select_own_variances | SELECT | origin_supplier_id = ANY(jwt_supplier_scope()) | |
| suppliers | supplier_select_in_scope | SELECT | id = ANY(jwt_supplier_scope()) | |

---

## Section 2b: Triggers (new/modified tables)

| table | trigger | event | function |
|-------|---------|-------|----------|
| component_breakage_reports | trg_breakage_report_append_only | UPDATE | enforce_breakage_report_append_only() |
| component_breakage_reports | trg_breakage_report_no_delete | DELETE | block_breakage_report_delete() |
| component_breakage_reports | trg_breakage_reporter_consolidates | INSERT | enforce_breakage_reporter_consolidates() |
| factory_order_items | trg_bump_version_factory_order_items | UPDATE | bump_row_version() |
| factory_orders | set_updated_at | UPDATE | update_updated_at() |
| factory_orders | trg_bump_version_factory_orders | UPDATE | bump_row_version() |
| factory_orders | trg_factory_order_shipped_cost_check | UPDATE | check_shipped_factory_order_has_cost() |
| freight_line_items | set_updated_at | UPDATE | update_updated_at() |
| freight_line_items | trg_bump_version_freight_line_items | UPDATE | bump_row_version() |
| freight_shipments | set_updated_at | UPDATE | update_updated_at() |
| freight_shipments | trg_bump_version_freight_shipments | UPDATE | bump_row_version() |
| freight_shipments | trg_freight_no_regression | UPDATE | prevent_freight_status_regression() |
| freight_shipments | trg_warn_freight_total_drift | UPDATE | warn_freight_total_drift() |
| freight_shipments | trg_warn_freight_total_drift | INSERT | warn_freight_total_drift() |
| product_boms | set_updated_at | UPDATE | update_updated_at() |
| product_boms | trg_bump_version_product_boms | UPDATE | bump_row_version() |
| product_boms | trg_check_bom_no_cycle | UPDATE | check_bom_no_cycle() |
| product_boms | trg_check_bom_no_cycle | INSERT | check_bom_no_cycle() |
| shipment_variances | trg_shipment_variance_append_only | UPDATE | enforce_shipment_variance_append_only() |
| shipment_variances | trg_shipment_variance_no_delete | DELETE | block_shipment_variance_delete() |
| suppliers | set_updated_at | UPDATE | update_updated_at() |
| suppliers | trg_bump_version_suppliers | UPDATE | bump_row_version() |
| suppliers | trg_validate_consolidates_for | UPDATE | validate_consolidates_for() |
| suppliers | trg_validate_consolidates_for | INSERT | validate_consolidates_for() |

---

## Section 2c: Functions

| function | signature |
|----------|-----------|
| block_breakage_report_delete | () |
| block_shipment_variance_delete | () |
| check_bom_no_cycle | () |
| enforce_breakage_report_append_only | () |
| enforce_breakage_reporter_consolidates | () |
| enforce_shipment_variance_append_only | () |
| jwt_is_internal | () |
| jwt_supplier_id | () |
| jwt_supplier_scope | () |
| rpc_acknowledge_breakage_report | (p_report_id uuid, p_dispute boolean) |
| rpc_acknowledge_shipment_variance | (p_variance_id uuid) |
| rpc_consolidator_confirm_factory_order_receive | (p_payload jsonb) |
| rpc_file_component_breakage_report | (p_factory_order_item_id uuid, p_quantity_broken integer, p_reason_category text, p_description text) |
| rpc_promote_user_to_supplier | (p_target_user_id uuid, p_supplier_id uuid) |
| rpc_resolve_breakage_report | (p_report_id uuid, p_resolution_notes text, p_replacement_factory_order_id uuid, p_write_off boolean) |
| rpc_resolve_shipment_variance | (p_variance_id uuid, p_resolution_notes text, p_write_off boolean) |
| rpc_set_profile_active | (p_target_user_id uuid, p_is_active boolean) |
| rpc_supplier_advance_factory_order | (p_factory_order_id uuid, p_expected_version integer, p_notes text) |
| rpc_supplier_book_freight_shipment | (p_shipment_id uuid, p_expected_version integer, p_tracking_number text, p_carrier text, p_eta date) |
| rpc_supplier_cancel_factory_order | (p_factory_order_id uuid, p_expected_version integer, p_reason text) |
| rpc_supplier_create_factory_order | (p_payload jsonb) |
| rpc_supplier_create_freight_shipment | (p_payload jsonb) |
| validate_consolidates_for | () |

---

## Section 3: Deployed migration file contents

Not retained verbatim. The deployed SQL differed from the on-disk files in the following ways (all corrections applied at deploy time):

---

## Additional renames / corrections NOT in the author's list

The following were corrected at deploy time and are NOT in the original rename list
(product_name, carrier_name, quantity_ordered, freight_shipment_id, expected_completion,
actual_arrival_date, removed departed_at):

1. **`factory_order_items.quantity` → `quantity_ordered`** — already in author's list ✓
2. **`freight_line_items.shipment_id` → `freight_shipment_id`** — already in author's list ✓
3. **`freight_shipments.carrier` → `carrier_name`** — already in author's list ✓
4. **`product_skus.name` → `product_name`** — already in author's list ✓
5. **`factory_orders.expected_ready_date` → `expected_completion`** — already in author's list ✓
6. **`freight_shipments.delivered_at` → `actual_arrival_date`** — already in author's list ✓
7. **`freight_shipments.departed_at` removed** — already in author's list ✓

### Additional items NOT previously listed:

8. **`factory_order_items` has NO `updated_at` column** — the migration file references `foi.updated_at` in `supplier_portal_factory_order_items` view. The deployed view omits `updated_at` and uses `row_version` instead. The local migration file's view definition must drop `foi.updated_at`.

9. **`freight_shipments.status` CHECK constraint** — the live table has existing status values (e.g. `'on_the_water'`, `'delivered'`) from earlier migrations. The migration file's `supplier_insert_own_shipments` policy restricts INSERT to `status IN ('pending', 'booked')`. Confirm those two values are valid under the existing status CHECK on `freight_shipments` — if not, the policy will silently block all supplier inserts.

10. **`ALTER TABLE ... ENABLE ROW LEVEL SECURITY`** applied to 3 tables not in the migration file: `product_boms`, `shipment_variances`, `component_breakage_reports`. These were bare CREATE TABLE statements in 020 with no ENABLE ROW LEVEL SECURITY line. Add `ALTER TABLE <table> ENABLE ROW LEVEL SECURITY;` after each CREATE TABLE in the local 020 file.

11. **`supplier_portal_factory_order_items` view** — deployed version uses `foi.row_version` not `foi.updated_at` (which doesn't exist). Local file needs this corrected.

12. **`supplier_portal_freight_shipments` view** — deployed version uses `actual_arrival_date` (not `delivered_at`) and omits `departed_at`. Local file needs both corrections.

13. **`supplier_portal_freight_line_items` view** — deployed version uses `fli.freight_shipment_id` (not `fli.shipment_id`). Local file needs this corrected.

14. **`rpc_supplier_create_factory_order`** — deployed version inserts into `factory_order_items` with column `quantity_ordered` (not `quantity`), and inserts into `factory_orders` with column `expected_completion` (not `expected_ready_date`). Local 021 file needs both corrected.

15. **`rpc_supplier_create_freight_shipment`** — deployed version inserts into `freight_shipments` with `carrier_name` (not `carrier`), and inserts into `freight_line_items` with `freight_shipment_id` via the table's actual FK column name. Local 021 file needs `carrier_name` corrected.

16. **`rpc_supplier_book_freight_shipment`** — deployed version updates `carrier_name` (not `carrier`). Local 021 file needs this corrected.
