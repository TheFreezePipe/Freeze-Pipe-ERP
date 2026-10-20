# Staging refresh runbook

Staging (`sitwttqdqqkucwkcyoks`) is the practice floor for the Warehouse module. It carries production's schema, production's master data, and a scrubbed copy of recent ShipStation orders. This runbook records how it was rebuilt on 2026-10-20 and how to repeat it. Production (`pnqujtugddxusllkikje`) is only ever read.

## What the scripts do

All three live in `scripts/staging/` and talk to Supabase through the Management API's `database/query` endpoint, so they need no database password and work through firewalls that block direct Postgres. They read a personal access token from `.env.local` as `SUPABASE_ACCESS_TOKEN` (git-ignored). Create the token at https://supabase.com/dashboard/account/tokens before a refresh and revoke it afterwards.

| Script | Does | Destructive on |
|---|---|---|
| `mgmt.py` | Helper: `q(sql, project_ref)` runs SQL and returns rows; never prints the token | nothing |
| `rebuild_staging_schema.py <scratch_dir> <repo_dir>` | Drops and recreates staging's `public` schema, applies every file in `supabase/migrations/` in order, records them in `supabase_migrations.schema_migrations`, recreates the `on_auth_user_created` trigger on `auth.users`, prints table, function and cron counts | staging `public` schema |
| `copy_to_staging.py <scratch_dir>` | Copies the table list in `TABLES` from production in foreign-key order, chunked, with user triggers paused per table; skips tables that already hold production's row count (resume); scrubs `shipstation_orders` inside the production-side SELECT | staging rows in the listed tables |

Both scripts log to `<scratch_dir>/rebuild_staging.log` and `copy_to_staging.log`.

## Order of operations (as run 2026-10-20)

1. Back up staging: every public table as JSON, function definitions, migration rows and cron jobs (the scripts do not do this; it was a one-off `row_to_json` dump). Keep it until the new staging has been used for a week.
2. `rebuild_staging_schema.py`. It stops at the first failing migration and records only what applied. On 2026-10-20 it stopped at `20260921000001_shipstation_apply_once.sql`, which requires the system actor profile `00000000-0000-0000-0000-000000000001` to exist.
3. Accounts. Copy `suppliers` first (profiles reference them). Then create staging auth users for every production profile **with the same UUID** so that every copied row that references `profiles` (performed_by, created_by, received_by) stays valid, plus the system actor. This is done with direct inserts into `auth.users` and `auth.identities` (the pattern Supabase documents for seeding), with one shared practice password stored in `.env.local` as `STAGING_PRACTICE_PASSWORD`. The `on_auth_user_created` trigger creates each profile with role `user`; roles, names, active flags and supplier links are then mirrored from production with `ALTER TABLE profiles DISABLE TRIGGER USER` around the update, because the ERP's `block_direct_role_update` trigger forbids direct role changes (correctly). The three pre-existing staging users (the owner's freshetech login and the two pilot supplier accounts) keep their auth rows and get profiles re-created.
4. Re-run `rebuild_staging_schema.py` logic for the remaining migrations (the script's loop can be pointed at the unapplied files; on 2026-10-20 this was done inline).
5. `copy_to_staging.py`. Tables copied: locations, product_skus, product_boms, sku_supplier_costs, sku_economics, sku_forecasts, inventory_levels, materials, material_inventory_levels, sku_material_consumption, shipstation_sku_handling, audit_chain_config, demand_overrides, inventory_retail_value_daily, mkt_sales, mkt_sale_stores, mkt_sale_baseline, mkt_sale_sku_lift, mkt_offers, mkt_offer_skus, mkt_discount_codes, mkt_promo_history, factory_orders, factory_order_items, freight_shipments, freight_line_items, freight_carton_groups, freight_carton_group_skus, freight_receipts, task_logs, shipstation_orders (order_date ≥ 2026-08-01), shipstation_order_items and shipstation_order_discounts for those orders.
   Not copied, by design: inventory_transactions (52k rows, hash-chained ledger; staging starts a fresh chain), material_transactions, sales_daily, audit_logs, api_keys, shipstation_sync_runs, shipstation_webhook_events, youtube_video_summaries, the marketing launch and product-development tables (a foreign-key cycle between projects and samples; not needed for warehouse practice).
6. Seeded-table reconciliation. Some migrations seed rows with random IDs (materials, mkt_promo_history). `ON CONFLICT DO NOTHING` keeps the seeded row and dependent production rows then fail their foreign keys. Fix: delete the seeded rows and insert production's. The copier's resume check (row counts equal) will also skip such tables, so compare primary-key sets after a run, not just counts.
7. Cron review. Migrations schedule cron jobs; after a rebuild list `cron.job` on staging and unschedule anything that points at production. On 2026-10-20 `shipstation-reconcile-intraday` was scheduled on staging with the **production** function URL (hard-coded in `20260610000001_realtime_box_deduction.sql`; `20260701000001_daily_report.sql` and `20260721000002_youtube_summary.sql` also hard-code it but did not schedule on staging). Defect to fix in a later migration: read the project URL from a setting or Vault instead of a literal.
8. Verify: 55 tables and 84 migrations on staging; a PII query over `shipstation_orders` returning zero rows with a real email, name, bill-to, ship-to street, phone or notes; orders joined to items; one read-only RPC (`rpc_daily_report()`) returns data.

## Scrubbing rules

Inside the production-side SELECT, so nothing personal leaves production: `customer_email` becomes `user-<8 hex>@example.com`, `customer_name` becomes `Customer <6 hex>`, and `raw_payload` loses `billTo`, `customerEmail`, `customerUsername`, `customerNotes`, `internalNotes`, `giftMessage`, `customerId`, with `shipTo` reduced to state, country and the first three digits of the postal code. Order numbers, SKUs, quantities, carrier and service codes, store IDs and dates are kept because picking practice needs them.

## Local app against staging

`.env.local` points `VITE_SUPABASE_URL` at staging with the current anon key, `VITE_APP_ENV=staging` (amber banner), and the current staging service role key for scripts. `npm run dev` runs the ERP against staging. ShipStation API secrets are **not** set on staging's edge functions, so nothing on staging talks to ShipStation; the reconcile cron jobs there are no-ops.

## Known gaps after the 2026-10-20 refresh

- `supabase_realtime` publication has no tables on staging (none needed until the Warehouse module adds its channels).
- The daily report on staging shows no sales because `sales_daily` was not copied.
- 69 of 9,314 copied orders have no item rows (the production blank-SKU import issue, carried over as-is).
