# Warehouse module, Phase 0 and Phase 1: technical design

Date 2026-10-20, revised 2026-10-21 · Branch `feat/warehouse-phase0` · Status: ready for implementation review

Revision 2026-10-21: cartons keep a location through manufacturing, with a green relabel at RTS and a two-step put-back (5.7); labels print through a queue to the printer at the station a worker scanned into (5.5); the sidebar and routes follow the merged Inventory module in `docs/design/INVENTORY_MODULE_IA.md`, which supersedes 3.8 and the paths in 9.1 and Appendix A.

Scope: Phase 0 (prerequisites) and Phase 1 (locations, map, putaway, counts). Picking, carts, totes and the bench helper are Phases 2 and 3 and appear only where Phase 1 must leave room for them.

Sources: the scope report, UX layout report and ops audit in `docs/research/reports/`, the cart sizing note, the research notes on the ERP shell, current state, location model, pick path and Scan to View, the owner's workbook generator, `docs/design/STAGING_REFRESH.md`, and the code cited inline. **Proposed** marks a choice the owner has not settled, with a one-sentence reason; everything else is an owner decision or a fact read from the repo.

---

## Executive summary (for the owner)

**Phase 0 (1 to 2 weeks) prepares the ground and changes nothing on the floor.**
- Staging becomes a copy of production with customer details scrubbed: the practice floor, where staff can scan, put away and count without touching real stock, ShipStation or the label printer.
- The ERP installs on staff phones like an app and accepts Bluetooth scanners.
- Your UPCs are loaded for 86 of the 131 active products, so scanning a box finds the product.
- Floor staff open the ERP to a new "Floor" home with big buttons.
- For two to four weeks we time today's picking, so later gains are measured against your own numbers.

**Phase 1 gives every shelf and every carton an address.** The scope report estimated 6 to 9 weeks, including a 3D view you have since dropped.
- Every shelf position gets a code and a barcode label. `02-01-2` means rack face 02, bay 01 counted in the walking direction, level 2 from the floor. Level 3 is overflow and is never picked from directly.
- Every carton gets its own license-plate label, printed at the dock when it is checked in. The phone says which shelf to put it on and why; scanning the shelf label confirms it.
- A carton keeps its address through manufacturing. One scan releases its shelf when it goes to the line. When a batch is RTS'd, the worker scans the carton's old label and a bright green label prints with their name and the time; they shelve the carton and scan the bay. Green means ready to ship, to pickers and to anyone counting.
- Labels print through a queue: a phone can ask for a label and it comes out of the printer at the station the worker scanned into when they started.
- A map shows every rack; tapping a bay shows what is in it, carton by carton; search finds any product or carton.
- Staff count one shelf at a time on the phone without seeing what the system expects; managers approve differences on the desktop.
- Every night the ERP checks one rule per product: units on the shelves, minus units already sold to open orders, equals the Stock Levels number. A product that breaks the rule gets a count task.

**What stays the same.** ShipStation still receives orders and prints labels. Stock still leaves the Stock Levels number when ShipStation imports an order, so the oversell policy is unchanged. Packing is unchanged. The picking app is Phase 2.

**What you need to do.** Finish the workbook measurements and confirm each rack face's walking direction on the floor. Buy a thermal label printer for the right dock door and a second one for the manufacturing desks, white and bright green 4×2 inch carton labels, 3×1 inch shelf labels, a scanner for the manufacturing desks and two or three Bluetooth scanners; the dock and manufacturing laptops run the small print agent. Spend a day hanging shelf labels and do one full count on go-live day.

**One honest limitation.** Until the Phase 2 picking app exists the ERP cannot know which shelf an order was picked from, so when an order ships it takes the units from the first pickable shelf in walking order that holds the product. Building totals stay exact; shelf-by-shelf numbers can drift a little between counts, and the weekly counts correct them.

---

## 1. What exists today

| Area | Fact the design relies on | Where |
|---|---|---|
| Stock | One `inventory_levels` row per SKU at Main Warehouse `…0100`, five bucket columns, `warehouse_finished` may go negative. `rpc_cycle_count`, `rpc_apply_shipstation_sale` and `_freight_credit_units` address rows by `sku_id` only, so the design never adds a second row. | baseline; `20260505000002`; `20260921000001` |
| Ledger | `inventory_transactions` is hash-chained, immutable, has no location column; `chk_inv_tx_reference_shape` allows six reference types. | baseline L3103-3122 |
| Receiving | Carton groups count identical cartons. `rpc_record_freight_receipt(p_shipment_id, p_entries, p_actor_id)` turns taps into units by cumulative rounding and credits one bucket per SKU (non_fillable finished; fillable prefilled_raw or raw). Cartons then dissolve. | `20260722000001` |
| Sales | Deduction at `awaiting_shipment` or `shipped`, idempotent from the ledger; cancellations not credited. `apply_box_on_shipped` shows the trigger pattern: fire on order_status, swallow errors. | `20260921000001`, `20260610000001` |
| Frontend | Routes hard-wired in `App.tsx`; `DefaultRedirect` and `RequireRole` send `user` to `/manufacturing/workspace`; Sidebar `end` is an inline chain; no Realtime, PWA, barcode or print code; `h-screen`; `vercel.json` sends `camera=()`. | `App.tsx`, `Sidebar.tsx`, `vercel.json` |
| Products | `upc_code` set on 1 of 131 active SKUs; no box dimensions. Postgres is 17.6. | cart sizing note; baseline |

## 2. Settled decisions and their consequences

| Decision | Consequence in this design |
|---|---|
| ERP owns locations, inventory, picking, totes; ShipStation keeps intake and labels; no ERP pack screen | No ShipStation write in Phase 1; the outbound guard (3.3) exists anyway |
| Deduction stays at ShipStation import; a physical layer is what pickers see | New `wh_*` tables, no new `inventory_levels` rows; physical stock decrements at pick confirm in Phase 2 and at ship settlement in Phase 1 (5.6) |
| Nightly identity: physical on-hand − allocated-to-open-orders = `warehouse_finished` | `rpc_wh_reconcile_physical` (section 6) |
| One LPN per carton minted in `rpc_record_freight_receipt`, labels printed then | Receipt RPC replaced, same signature (5.4) |
| `FF-BB-L` zero-padded; walk order in `pick_sequence` | Code CHECK; one generator owns both (5.3) |
| Level 3 overflow, never picked; bays hold cartons, several SKUs, no sub-positions | `is_overflow` with CHECK `NOT (pickable AND is_overflow)`; a location is a bay-level, contents are balances by container |
| Zones are defaults; the bucket lives on the balance | `wh_locations.default_bucket` advisory, `wh_inventory_balances.bucket` authoritative |
| Cancellations deferred; damaged = write-off; spares at `SPARES-01` | Explained reconcile term; `rpc_wh_write_off`; `SPARES-01` converts to `other` |
| Variance approval managers only; location scan every stop a setting | Role gate; `wh_settings.scan_rules` |
| No 3D; plan plus elevation; keep x/y/z | SVG; millimetre coordinates |
| Tote classes from box dimensions only; 18-slot cart, 12S/4M/2L | Box columns in Phase 0; `cart_definitions` placeholder |
| Staging `sitwttqdqqkucwkcyoks` is the practice floor; production `pnqujtugddxusllkikje` | Sections 3.1-3.3 |
| 86 SKUs with UPCs; match 7/8/12/13 digits | `sku_barcodes` (3.6) |
| Personal phones with Bluetooth HID scanners; solid Wi-Fi; pickups 2-3 PM | No camera in Phases 0-1; idempotent online RPCs; baseline measures share shipped by cutoff |
| Cartons keep a location through manufacturing; the RTS step is incomplete until the carton is relabelled green (new LPN, worker, time) and its bay scanned (owner, 2026-10-21) | `rpc_wh_take_to_line`, `rpc_wh_rts_relabel`, child LPNs, two-step put-back (5.7) |
| One print queue; a station's printer prints what a worker at that station asks for, from any device (owner, 2026-10-21) | `wh_printers`, `wh_print_jobs`, `wh_station_sessions`, print agent (5.5) |

---

## 3. Phase 0: prerequisites

### 3.1 Staging rebuild

The coordinator rebuilt staging on 2026-10-20; `docs/design/STAGING_REFRESH.md` is the as-run record and `scripts/staging/` holds the scripts. The procedure, condensed:

1. Back up staging (public tables as JSON, function definitions, migration rows, cron jobs).
2. Drop and recreate `public` with Supabase's grants; apply the 84 migrations in filename order through the Management API `database/query` endpoint, recording each in `schema_migrations`. The system actor profile `…0001` must exist before `20260921000001`.
3. Accounts: copy `suppliers`; create staging auth users with production's profile UUIDs plus the system actor, so copied `performed_by`/`created_by`/`received_by` stay valid; mirror roles with `block_direct_role_update` disabled for the update; recreate `on_auth_user_created`.
4. Copy master data in foreign-key order with user triggers paused, plus ShipStation orders from 2026-08-01 with items and discounts, scrubbed in the production-side SELECT.
5. Reconcile seeded tables (materials, `mkt_promo_history`) by primary-key set; unschedule every cron job pointing at production; verify.

Three additions before warehouse practice (**proposed**, because the reconcile and the guard depend on them):
- **Ledger rows for unshipped orders.** The runbook copies no `inventory_transactions`, so the open-order term in section 6 would read zero. Copy the `order_shipped` and `shipstation_ledger_rebase` rows of copied orders not yet shipped (awaiting, on hold, cancelled) in `seq` order; the hash-chain trigger re-chains them.
- **Allowlist scrub.** Build `raw_payload` from an allowlist so a key ShipStation adds later cannot carry personal data: `orderId`, `orderNumber`, `orderKey`, `orderDate`, `modifyDate`, `orderStatus`, `shipDate`, `advancedOptions` (`storeId`, `parentId`, `mergedOrSplit`, `mergedIds`), `items`, `dimensions`, `weight`, `carrierCode`, `serviceCode`. ERP SQL reads only `dimensions`, `items` and `advancedOptions`.
- **Warehouse settings.** After every refresh: `wh_settings.outbound` = `blocked`, the `ERP_OUTBOUND_MODE` secret not `live`, and migration 11's publication entries.

| # | Check | Method | Pass |
|---|---|---|---|
| 1 | Migration history | `schema_migrations` against `ls supabase/migrations/*.sql` | same versions (84 today) |
| 2 | Schema parity | md5 of ordered columns, `pg_get_functiondef`, `pg_policies`, triggers, CHECKs on both projects | identical |
| 3 | RLS and grants | tables with `relrowsecurity = false`; `has_schema_privilege` per API role | same as production; true |
| 4 | Auth trigger | sign up a throwaway user | profile created, role `user` |
| 5 | Cron | `cron.job` commands | none contains `pnqujtugddxusllkikje` |
| 6 | Copied data | primary-key sets against the same production filter | equal |
| 7 | PII | emails not `@example.com`; `jsonb_object_keys(raw_payload)`; `raw_payload::text LIKE '%@%'` | 0; inside allowlist; 0 |
| 8 | Smoke | `rpc_apply_shipstation_sale` on an applied order; `rpc_daily_report()` | `already_applied`; data |
| 9 | App | staging login; Stock Levels, Shipments, Sales | load; amber banner |
| 10 | Outbound | setting and secret | `blocked` |

### 3.2 `scripts/refresh-staging`

`docs/ENVIRONMENTS.md` promises a weekly refresh script that does not exist, and today's rebuild has manual steps. **Proposed:** `scripts/refresh-staging/`, in Python so it reuses `scripts/staging/mgmt.py`:
- `refresh.py --rebuild | --data-only`: rebuild runs backup, schema, accounts, copy, seeded-table fix, ledger rows, cron cleanup and warehouse settings; data-only truncates copied tables and starts at copy. It reads `SUPABASE_ACCESS_TOKEN` from `.env.local` and never prints it.
- `accounts.sql`, `ledger_open_orders.sql`, `post_refresh.sql`: the manual steps as reviewable files.
- `verify.sql`: the checklist, run on both projects, written to `last-report.txt`.
- Refusals: abort if the destination is the production ref or check 7 fails; always write `outbound = blocked` last.

**Proposed** migration 3 fixes the cron defect the runbook names (`20260610000001`, `20260701000001` and `20260721000002` hard-code the production URL): the jobs read it from a Vault secret `project_url` at run time, as `service_role_jwt` already works, and a job is left untouched when the secret is absent so production cannot lose it.

### 3.3 Staging outbound guard

Phase 1 prints labels, Phase 2 adds ShipStation tags, Phase 3 may add PrintNode. **Proposed:** one guard covers all three.
- Database: `wh_settings.outbound` = `{"mode": "live" | "blocked" | "practice"}`; `fn_outbound_allowed(p_kind)` is true in `live`, true only for `browser_print` in `practice`, false in `blocked`. Migration 2 seeds `blocked` so a fresh database is safe by default; an admin switches production to `live` (rollout step 1) and the refresh writes `blocked`.
- Edge: `_shared/outbound-guard.ts` `assertOutbound(kind)` requires the secret `ERP_OUTBOUND_MODE=live` as well; every future ShipStation POST and PrintNode call goes through it. Staging keeps having no ShipStation secrets.
- Client: `useOutboundMode()` never returns `live` off production; print buttons are disabled in `blocked`. In `practice`, labels carry a "PRACTICE · STAGING" band and barcode values start `%Z`, so a practice label on the production floor never resolves to a real carton or shelf.

### 3.4 PWA groundwork and Permissions-Policy

- `public/manifest.webmanifest` (short name "FP Floor", `start_url` `/go`, `standalone`, theme `#121212`, icons from `favicon.png`); `index.html` gains `viewport-fit=cover`, the manifest link and the Apple web-app tags.
- `public/sw.js`, **proposed** hand-written rather than Workbox, because Phase 1 needs only installability and a cached shell. Network-first navigations with cached `index.html` fallback; cache-first `/assets/*` (immutable per `vercel.json`); no cross-origin caching; registered in production builds with a "new version" toast.
- `h-screen` becomes `h-dvh` in `Layout`, `RequireAuth` and `RequireRole`; the environment banner moves inside the column; the task shell pads with `env(safe-area-inset-*)`.
- Permissions-Policy keeps `camera=()` through Phase 1: HID scanners need no camera. A Phase 2 camera fallback adds a later `/go/(.*)` rule with `camera=(self)`, checked with `curl -I` because both rules match.

### 3.5 Realtime enablement

No `supabase.channel` call exists in `src/`. Phase 0 adds the plumbing:
- `createClient` gets `realtime: { worker: true, heartbeatCallback }`, reconnecting on timeout.
- `src/lib/realtime.ts` `useLiveInvalidate(channel, tables, queryRoots)` subscribes to `postgres_changes`, debounces root invalidation by 250 ms, and invalidates everything when the page becomes visible, because backgrounded phones drop the socket silently. No-op in demo mode.
- Migration 11 adds `wh_inventory_balances`, `wh_containers`, `wh_moves`, `wh_count_tasks`, `wh_print_jobs`, `wh_printers`, `wh_station_sessions` to `supabase_realtime`; SELECT policies keep suppliers out.

### 3.6 UPC import and matching

**Proposed:** a `sku_barcodes` table rather than `upc_codes text[]`, because a unique index on the normalised code guarantees one barcode never resolves to two SKUs.

`sku_barcodes`: `id`; `sku_id` FK `product_skus`; `code text NOT NULL UNIQUE` (normalised); `code_raw`; `symbology` CHECK IN (`upca`, `upce`, `ean13`, `ean8`, `other`); `source` CHECK IN (`catalog_csv`, `scan_link`, `manual`); `is_primary` with a partial unique index per SKU; `created_by`, `created_at`. `product_skus.upc_code` gets the primary GTIN-12 for display and the ShipStation CSV; lookups never read it. The same migration adds `box_length_in`, `box_width_in`, `box_height_in` (`numeric(5,2)`, NULL, CHECK > 0) and nothing else.

Normalised form: GTIN-12 for UPC-A and UPC-E, GTIN-13 for EAN-13 not starting with 0, 8 digits for EAN-8. `fn_gtin_candidates(p_scan text) RETURNS text[]` (IMMUTABLE) and its twin `src/lib/warehouse/gtin.ts` strip non-digits and branch on length:

| Length | Read as | Candidates |
|---|---|---|
| 13 | EAN-13; leading 0 means UPC-A | drop the 0, else the 13 digits |
| 12 | UPC-A | as scanned, check digit verified |
| 11 (proposed) | UPC-A without check digit | append the check digit |
| 8 | UPC-E (number system 0/1, with check), else EAN-8 | expanded UPC-A and the raw 8 |
| 7 | UPC-E without check digit | expand, compute the check digit |
| 6 (proposed) | UPC-E body, number system 0 | expand |

UPC-E expansion keys on the last body digit d6: 0-2 give `NS d1 d2 d6 0000 d3 d4 d5`; 3 gives `NS d1 d2 d3 00000 d4 d5`; 4 gives `NS d1 d2 d3 d4 00000 d5`; 5-9 give `NS d1 d2 d3 d4 d5 0000 d6`; then the check digit. From the catalog, 10-Filters `13833251` and its raw `1383325` both expand to `138332000051`, its `upc_gtin12`.

- `rpc_wh_import_sku_master(p_rows jsonb, p_dry_run boolean)` (admin) loads `{sku, upc_gtin12, upc_upce8, upc_raw, box_*}` rows parsed from `docs/research/warehouse-map/sku_catalog_with_upc.csv`, later the workbook's SKU boxes tab. A code already on another SKU is reported, never overwritten.
- `rpc_wh_resolve_scan` matches `code = ANY(fn_gtin_candidates(scan))`. **Proposed:** a manager scanning an unknown code gets "Link to SKU" (`rpc_wh_link_barcode`), so the other 45 products gain codes in the course of work.

### 3.7 Baseline KPIs

Two to four weeks from now; Phase 1 does not touch picking, so it cannot disturb the baseline.
- Stopwatch log (ops audit step 9), three waves a week including a Monday, the routine peak: date, wave, picker, slips printed, first pick, last order on cart, orders, lines, units, mis-picks found at pack, reprints.
- SQL over `shipstation_orders`: orders and lines per ship day, median import-to-ship hours, share of morning orders shipped the same day (the 2-3 PM pickup), reships per week.
- Each rate is kept beside that day's volume, since the window straddles the November ramp.

### 3.8 Sidebar

Superseded 2026-10-21 by the merged Inventory group (`docs/design/INVENTORY_MODULE_IA.md`); kept for the record.

- A "Warehouse" group between Inventory and Economics, roles admin and manager: Overview `/warehouse` (`Warehouse`), Map `/warehouse/map` (`Map`), Putaway (`ArrowDownToLine`, badge: open putaways), Counts (`ClipboardCheck`, badge: counts awaiting approval), Locations (`MapPin`). Badges copy `PdReviewBadge`. Pick & Pack joins in Phase 2.
- **Proposed:** Floor `/go` (`Smartphone`) first in Manufacturing for all internal roles, so desktop users reach the phone home.
- Replace the inline `end` chain with `END_ROUTES = new Set([...existing, "/warehouse", "/go"])` and `end={END_ROUTES.has(item.to)}`.

### 3.9 The `/go` floor landing

- `src/lib/landing.ts` `landingPathFor(role)`: user `/go`, supplier `/supplier`, others `/dashboard`; `DefaultRedirect` and `RequireRole` both call it.
- `FloorHome`: two columns of tiles at least 64 px tall with live badges: Put away, Count, Move, Look up, Manufacture (`/manufacturing/workspace`); Pick arrives in Phase 2. A live `ScanSink` opens Look up on any scanned label.
- **Proposed:** the per-user landing preference waits, because every floor worker is role `user`.

### 3.10 Phase 0 exit criteria

Every 3.1 check passes; staging prints and writes nothing outbound; the PWA installs on an iPhone and an Android phone and a paired HID scanner types into `ScanSink` with the keyboard hidden; all 86 UPC SKUs resolve from every catalog form; two weeks of baseline exist; floor users land on `/go`.

---

## 4. Phase 1 data model

### 4.1 Migrations

Forward-only, idempotent, a header stating finding and decision, and the `schema_migrations` trailer, as the repo does.

| File | Contents | Phase |
|---|---|---|
| `20261021000001_wh_sku_dims_barcodes.sql` | box columns, `sku_barcodes`, GTIN functions and RPCs | 0 |
| `20261021000002_wh_settings_guard.sql` | `wh_settings`, outbound guard | 0 |
| `20261021000003_cron_project_url.sql` | cron URL from Vault | 0 |
| `20261021000004_wh_layout.sql` | layout tables, `UNLOCATED`, generator | 1 |
| `20261021000005_wh_stock.sql` | containers, balances, movements, writer, reference CHECK | 1 |
| `20261021000006_wh_tasks.sql` | moves, counts, printers, print jobs, station sessions | 1 |
| `20261021000007_wh_rpcs.sql` | task RPCs, manufacturing carton RPCs, station and print RPCs, imports, `wh_location_summary` | 1 |
| `20261021000008_wh_receiving_lpn.sql` | receipt RPCs replaced | 1 |
| `20261021000009_wh_ledger_sync.sql` | settlements, mirror and settlement triggers | 1 |
| `20261021000010_wh_reconcile.sql` | reconcile, count scheduler, cron, daily report key | 1 |
| `20261021000011_wh_realtime.sql` | publication | 1 |

Migrations 1-3 can reach production in Phase 0; they change no existing behaviour.

### 4.2 Rules for every new table

- RLS on. SELECT `TO authenticated USING (jwt_is_internal())`, which admits admin, manager and user and excludes suppliers. No write policies: SECURITY DEFINER RPCs do every write, as with `freight_receipts` (**proposed** for layout tables too, so edits pass the generator's checks).
- Mutable tables carry `created_at`, `updated_at` (`update_updated_at`) and `row_version` (`bump_row_version`). Append-only tables get a new `block_wh_mutation()` trigger, since `block_audit_mutation` names `inventory_transactions` in its message.
- `chk_` constraint names; integer quantities; views `WITH (security_invoker = true)`.
- `bucket` is `text CHECK IN ('raw','prefilled_raw','in_production','finished','other')`: the `inventory_levels` columns without the `warehouse_` prefix.

### 4.3 Tables

**Layout.**
- `wh_rack_templates`: `id`; `code` UNIQUE, `name`; `kind` CHECK IN (`pallet_rack`, `shelving`, `end_cap`, `floor`); `bays`, `levels` smallint; `bay_width_mm`, `depth_mm` integer; `level_heights_mm integer[]` (beam tops, CHECK cardinality = levels); `overflow_top_level boolean`; `capacity_cartons_per_level` integer NULL.
- `wh_racks`: `id`; `site_location_id` FK `locations` DEFAULT `_default_location_id()`; `code` (`R01`…, UNIQUE per site); `template_id`; `description`; `x_mm`, `y_mm` of the front-left corner, origin at the inside top-left corner nearest the left dock door, X east, Y south (workbook convention); `rot_deg` CHECK IN (0, 90, 180, 270); `bays`, `levels` (template defaults; R07 has 2 bays, 1 level); `width_mm`, `depth_mm`; `active`.
- `wh_rack_faces`, **proposed** because R02 and R03 each carry two faces with different codes, aisles and walk directions, and face 09 spans R08 and R09: `id`; `rack_id`; `face_code char(2)` (UNIQUE per rack); `side`; `aisle`; `walk_pass smallint` (order of the aisle pass; 99 not routed); `walk_dir` CHECK IN (`N`, `S`, `E`, `W`), bay 01 being the first bay reached; `first_bay_no` DEFAULT 1 (face 09 continues at bay 3 on R09); `zone_by_bay text[]`; `pickable_levels smallint[]` DEFAULT `{1,2}`.
- `wh_fixtures`, **proposed** because the plan needs doors, benches, desks and gaylords, and the owner's "blocked" toggle for the gaylord overflow spot: `id`, `name`, `kind` CHECK IN (`door`, `pack_station`, `desk`, `staging`, `obstacle`, `other`), geometry in mm, `zone`, `location_id` NULL (a station's park point), `blocked boolean` (a Phase 2 routing input).

**`wh_locations`**

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `site_location_id` | uuid FK `locations` | default Main Warehouse |
| `code` | text NOT NULL | UNIQUE per site; CHECK `code ~ '^\d{2}-\d{2}-\d$'` when `kind = 'bay_level'` |
| `barcode_value` | text GENERATED (`'%' \|\| code`) STORED UNIQUE | see below |
| `kind` | text | CHECK IN (`bay_level`, `floor`, `station`, `virtual`) |
| `rack_id`, `face_id`, `face`, `bay`, `level` | | set for bay-levels |
| `zone` | text NOT NULL | CHECK IN (`RTS`, `RAW`, `BOX`, `WIP`, `ACC`, `MISC`, `IN`, `OUT`, `MFG`, `PACK`, `SPARE`, `VIRTUAL`) |
| `default_bucket`, `bucket_lock` | text NULL | advisory default; forced bucket (`SPARES-01` = `other`) |
| `pickable`, `is_overflow` | boolean NOT NULL DEFAULT false | CHECK `NOT (pickable AND is_overflow)` |
| `allow_negative` | boolean DEFAULT false | only `UNLOCATED` and `MFG-LINE` |
| `pick_sequence` | integer | partial UNIQUE per site WHERE `active` |
| `x_mm`, `y_mm`, `z_mm`, `width_mm`, `depth_mm`, `height_mm` | integer | bay centre on the face edge; z = beam top |
| `capacity_cartons` | integer NULL | from the template; editable |
| `last_counted_at`, `label_printed_at`, `label_verified_at` | timestamptz | verified = scanned on the label walk |
| `active` | boolean DEFAULT true | deactivation refused while any balance ≠ 0 |

Barcode values (**proposed**): every ERP-printed barcode is `%` plus the human code, because no SKU, UPC or ShipStation `^#^…^` payload starts with `%`, ZPL needs no escape for it (only `^` and `~`), and a HID scanner on a US layout types it reliably. Labels show only the code. After the prefix, `^\d{2}-\d{2}-\d$` and named codes are locations, `C-` a carton, `T-` a tote (Phase 2); `%Z` marks a practice label.

Rows come from the workbook: 71 rack bay-levels on faces 01-08, `09-01-1` to `09-03-1`, and `IN-01`, `OUT-UPS`, `OUT-GAY-1`, `OUT-GAY-2`, `ST-S1` to `ST-S4`, `ST-DOCK`, `ST-MFG-1` to `ST-MFG-4` (one per manufacturing desk; station labels start a station session, 5.5), `CART-START`, `MFG-LINE` (allow_negative) and `SPARES-01` (bucket_lock `other`). The migration seeds only `UNLOCATED` (virtual, allow_negative), home of unexplained physical differences.

**`wh_containers`** (license plates)

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `code` | text UNIQUE | `C-<shipment_number>-<nnn>`; opening stock `C-OB-<nnnn>`; an RTS relabel is the parent code plus `R<n>` (`C-466-007R1`), or `C-MFG-<nnnn>` when no parent was scanned (5.7) |
| `barcode_value` | text GENERATED (`'%' \|\| code`) UNIQUE | |
| `kind` | text DEFAULT 'carton' | CHECK IN (`carton`); Phase 2 adds `tote` |
| `sku_id` | uuid NULL | NULL = mixed carton |
| `qty_initial`, `qty` | integer | `qty` is current units, written only by `_wh_post_movement` |
| `state` | text | CHECK IN (`sealed`, `open`, `empty`, `void`); a parent relabelled at RTS becomes `void` with `superseded_by` set |
| `location_id` | uuid NULL | CHECK `state IN ('empty','void') OR location_id IS NOT NULL` |
| `source` | text | CHECK IN (`freight`, `opening_balance`, `manual`, `manufacturing`) |
| `freight_shipment_id`, `carton_group_id`, `freight_receipt_id`, `carton_seq` | | traceability to the receipt |
| `printed_at`, `print_count`, `opened_at`, `emptied_at`, `created_by` | | |
| `label_stock` | text | CHECK IN (`white`, `green`) DEFAULT `white`; green = finished goods relabelled at RTS |
| `parent_container_id`, `superseded_by` | uuid NULL FK self | lineage: the carton scanned at RTS; the green child that replaced a voided parent |
| `finished_by`, `finished_at` | uuid NULL, timestamptz NULL | the worker and time printed on a green label |

**`wh_inventory_balances`**

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | carried in Realtime payloads |
| `sku_id`, `location_id` | uuid NOT NULL FK | |
| `container_id` | uuid NULL FK | NULL = loose units |
| `bucket` | text NOT NULL | |
| `on_hand` | integer DEFAULT 0 | CHECK `on_hand >= 0 OR allow_negative` |
| `allocated` | integer DEFAULT 0 | CHECK ≥ 0; 0 in Phase 1, cart claims in Phase 2 |
| `available` | integer GENERATED (`on_hand - allocated`) STORED | |
| `allow_negative` | boolean NOT NULL | copied from the location on insert |
| `last_movement_at` | timestamptz | |

`UNIQUE NULLS NOT DISTINCT (sku_id, location_id, container_id, bucket)` (Postgres 15+). Zero rows are pruned nightly after 30 days without movement once their container is empty or void.

**`wh_inventory_movements`** (append-only)

| Column | Type | Notes |
|---|---|---|
| `id`, `seq` | uuid PK, bigint identity | |
| `movement_group_id` | uuid NOT NULL | one RPC call |
| `client_event_id` | uuid UNIQUE NULL | phone idempotency key |
| `type` | text | CHECK IN (`receive`, `void_receipt`, `putaway`, `move`, `open_container`, `count_adjust`, `write_off`, `bucket_convert`, `mfg_mirror`, `ledger_mirror`, `ship_settle`, `opening_balance`, `relabel`); Phase 2 adds `pick`. `relabel` moves finished units at `MFG-LINE` into a green child carton (5.7) |
| `sku_id`, `bucket`, `to_bucket` | | `to_bucket` for conversions |
| `qty` | integer | CHECK > 0 |
| `from_location_id`, `to_location_id`, `from_container_id`, `to_container_id` | uuid NULL | at least one location set |
| `actor_id` | uuid NOT NULL FK `profiles` | system actor `…0001` for automation |
| `reference_type`, `reference_id` | text, uuid | type CHECK IN (`freight_receipt`, `freight_shipment`, `wh_move`, `wh_count_task`, `shipstation_order`, `task_log`, `inventory_transaction`, `wh_import`) |
| `ledger_tx_id` | uuid NULL | the `inventory_transactions` row when a SKU total changed |
| `note`, `device`, `created_at` | | |

**Tasks.**
- `wh_moves`: `id`; `kind` CHECK IN (`putaway`, `replenish`, `move`); `origin` CHECK IN (`receipt`, `rts`, `manual`, `reconcile`) DEFAULT `manual` (**proposed**, so queues can list a worker's own RTS cartons first); `status` CHECK IN (`open`, `in_progress`, `done`, `cancelled`); `container_id`, or `sku_id` + `qty` + `bucket` for loose units; `from_location_id`; `suggested_location_id`; `suggestion_reason` CHECK IN (`same_sku_reserve`, `same_sku_face`, `nearest_empty`, `other_zone_empty`, `breakdown_shelf`, `none`); `to_location_id` (actual); `source_type`, `source_id`; `priority`; `assigned_to`, `completed_by`, `started_at`, `completed_at`, `movement_group_id`. Partial UNIQUE (`container_id`) WHERE an open putaway.
- `wh_count_tasks`: `id`; `kind` CHECK IN (`scheduled`, `pick_triggered`, `reconcile`, `variance_recount`, `ad_hoc`), where `pick_triggered` is written by the Phase 2 pick confirm when a bin hits zero; `status` CHECK IN (`open`, `counting`, `submitted`, `approved`, `cancelled`); `location_id` (a count covers one whole location); `sku_id` (the trigger, for display); `reason` (e.g. "Reconcile 2026-11-03: BW20 −3"); `due_date`; `moved_during_count`; assignee, submitter, approver and their timestamps; `source_type`, `source_id`. Partial UNIQUE (`location_id`) WHERE `open` or `counting`.
- `wh_count_lines`: `id`; `count_task_id` (CASCADE); `sku_id`, `container_id`, `bucket`; `expected_qty` (snapshot at submit, never sent to the phone); `counted_qty` ≥ 0 (expected but unscanned items are written as 0); `variance` GENERATED; `found_container_elsewhere`; `resolution` CHECK IN (`accept`, `misplaced`, `write_off`, `recount`); `movement_group_id`, `ledger_tx_id`, `scan_value`.

**Settings, printing, settlement, reconcile.**
- `wh_settings` (`key` PK, `value jsonb`, `updated_at`, `updated_by`), written by `rpc_wh_set_setting` (admin) with per-key validation as `rpc_set_sale_setting` does. Seeds: `outbound {"mode":"blocked"}`; `physical_layer {"live_since":null,"mint_lpns":false}`; `scan_rules {"location_scan_every_stop":true,"confirm_putaway_location":true}`; `putaway {"breakdown_location_code":null,"max_suggestions":3}`; `count_schedule {"A_days":7,"B_days":30,"C_days":90,"daily_cap":20}`; `reconcile {"create_counts":true,"max_counts_per_sku":3}`; `labels {"lpn":"4x2","location":"3x1","dpi":203}`; `rts {"require_relabel":true,"allow_no_parent":true}`; `printing {"require_station":true,"claim_timeout_s":60,"max_attempts":3}`; `cart_definitions []`, with the Phase 2 shape `{code, slots:[{letter, class, colour}]}` and the 18-slot default (A-R: 12 S, 4 M, 2 L) documented in the migration.
- `wh_printers`: `id`; `code` UNIQUE (`DOCK-1`, `MFG-1`); `name`; `station_location_id` FK `wh_locations` (kind `station`, NULL for a shared printer); `transport` CHECK IN (`agent`, `browser`); `address` (agent: the Windows printer name on that PC, or `tcp://<ip>:9100` for a network printer); `label_stock` CHECK IN (`white_4x2`, `green_4x2`, `white_3x1`); `dpi` DEFAULT 203; `agent_id` (which installed agent owns it); `last_seen_at`; `active`.
- `wh_print_jobs`: `id`; `kind` CHECK IN (`lpn`, `lpn_rts`, `location`, `station`); `item_ids uuid[]`; `payload jsonb` (the label fields; whoever prints renders them); `printer_id` FK `wh_printers` NULL (NULL = browser print); `station_location_id`; `status` CHECK IN (`queued`, `claimed`, `printed`, `failed`, `blocked`, `cancelled`); `claimed_by`, `claimed_at`, `attempts`; `requested_by`, `requested_from` (`dock`, `phone`, `desktop`, `workspace`); `created_at`, `printed_at`, `error`. Index on (`printer_id`, `status`, `created_at`).
- `wh_station_sessions`: `id`; `profile_id`; `station_location_id` FK `wh_locations` (kind `station`); `device_id` (random per browser, kept in `localStorage`); `started_at`; `ended_at` NULL. Partial UNIQUE (`profile_id`) WHERE `ended_at IS NULL`: one live station per person; scanning another station label ends the old session and starts a new one (5.5).
- `wh_order_settlements`, **proposed** as its own table so the busy `shipstation_orders` upserts stay untouched: `shipstation_order_id` PK FK; `method` CHECK IN (`ship_settle`, `pick`); `settled_units`, `shortfall_units`; `settled_at`; `last_error`.
- `wh_reconcile_runs` (`run_at`, `actor_id`, `skus_checked`, `mismatched_skus`, `abs_residual_units`, `unlocated_units`, `rts_unplaced_cartons`) and `wh_reconcile_lines` (`run_id`, `sku_id`, `bucket`, `physical`, `open_order_units`, `cancelled_held_units`, `unsettled_units`, `levels_value`, `residual`, `count_task_ids uuid[]`).

### 4.4 Indexes

Balances on `location_id`, (`sku_id`, `bucket`), `container_id`. Movements on (`sku_id`, `created_at`), (`from_location_id`, `created_at`), (`to_location_id`, `created_at`), (`reference_type`, `reference_id`), `movement_group_id`. Containers on `location_id` WHERE sealed or open, `sku_id`, `carton_group_id`. Locations on (`rack_id`, `face`, `bay`, `level`), `zone`. Moves on (`status`, `kind`, `created_at`); count tasks on (`status`, `due_date`).

### 4.5 Ledger changes

Migration 5 re-adds `chk_inv_tx_reference_shape` with `wh_count_task` and `wh_movement` appended. New `transaction_type` values: `wh_count_adjust` (`net_change`), `wh_write_off` (`write_off`, stored positive per `src/lib/ledger-sign.ts`), `wh_bucket_move` (`category_move`); `ledger-sign.ts` and the Change Log labels learn them. Level writes keep today's rules: finished may go negative, other buckets floor at zero as in `rpc_bulk_cycle_count`.

---

## 5. Phase 1 RPCs

### 5.1 Common rules

- **Envelope**: `{ok: true, …}` or `{ok: false, error: '<code>', message: '<sentence>'}`, as `rpc_record_freight_receipt` returns; hooks throw `message ?? error`, so messages name codes: "C-466-007 is already in 02-01-2."
- **Actor** (**proposed**): `_wh_actor(p_actor_id)` returns `auth.uid()` for signed-in callers and honours `p_actor_id` only from `service_role`, because existing RPCs trust a client-supplied actor id any user could forge. `_wh_require_role` checks `profiles.role` and `is_active`.
- **Idempotency**: phone RPCs take `p_client_event_id`; a repeat returns the first result with `duplicate: true`, the hook the Phase 2 outbox needs.
- **One writer**: `_wh_post_movement(p_group, p_type, p_sku, p_bucket, p_qty, p_from_loc, p_from_ctr, p_to_loc, p_to_ctr, p_to_bucket, p_actor, p_ref_type, p_ref_id, p_note) RETURNS uuid` locks both balances FOR UPDATE in id order (no deadlock between phones), refuses to take a non-negative balance below zero, upserts the destination, updates container `qty` and `state` (a draw opens a sealed carton; zero empties it) and inserts the movement. Not executable by clients.
- **Grants**: `REVOKE ALL … FROM PUBLIC, anon; GRANT EXECUTE … TO authenticated` (plus `service_role` for scheduled functions), as `20261016000001` does.

### 5.2 Catalogue

"Internal" = admin, manager, user.

| RPC | Roles | Purpose |
|---|---|---|
| `rpc_wh_resolve_scan(p_value)` | internal | `{kind: location \| container \| sku \| shipstation_order \| practice \| unknown, id, code, label}`; strips `%`, decodes `^#^HEX^` to orderId, tries GTIN candidates, then SKU codes |
| `rpc_wh_suggest_putaway(p_container_id, p_exclude uuid[])` | internal | next suggestion and reason (5.4) |
| `rpc_wh_putaway_container`, `rpc_wh_move_stock`, `rpc_wh_open_container`, `rpc_wh_record_count` | internal | 5.3 |
| `rpc_wh_write_off(p_sku_id, p_location_id, p_container_id, p_qty, p_reason, p_client_event_id)` | internal | damaged = write-off, bin and ledger together |
| `rpc_wh_approve_variance` | admin, manager | 5.3 |
| `rpc_wh_create_count(p_location_ids, p_kind, p_reason)` | admin, manager | ad hoc counts |
| `rpc_wh_save_layout(p_payload)`, `rpc_wh_save_location(p_location)` | admin | layout rows with `row_version`; named locations and deactivation |
| `rpc_wh_generate_locations(p_rack_id DEFAULT NULL, p_dry_run DEFAULT true)` | admin | 5.3 |
| `rpc_wh_resequence(p_rows)` | admin | `pick_sequence` fixes from Verify walk |
| `rpc_wh_request_labels(p_kind, p_ids, p_from, p_printer_id DEFAULT NULL)`, `rpc_wh_mark_printed(p_job_id, p_status, p_error)` | internal | 5.5; without a printer the job goes to the caller's station printer, else the browser |
| `rpc_wh_start_station(p_scan_value)`, `rpc_wh_end_station()` | internal | 5.5; a station label scan opens or switches the caller's session |
| `rpc_wh_claim_print_jobs(p_printer_ids, p_agent_id)`, `rpc_wh_agent_heartbeat(p_agent_id, p_printer_ids)` | print agent | 5.5; `FOR UPDATE SKIP LOCKED`, so two agents never print one job |
| `rpc_wh_take_to_line(p_container_id, p_client_event_id)` | internal | 5.7; a raw carton leaves its bin for `MFG-LINE` |
| `rpc_wh_rts_relabel(p_sku_id, p_cartons, p_parent_container_id, p_task_log_id, p_client_event_id)` | internal | 5.7; green child LPNs, labels, putaway tasks |
| `rpc_wh_import_stock(p_rows, p_dry_run)` | admin | opening balances (9.6) |
| `rpc_wh_import_sku_master`; `rpc_wh_link_barcode` | admin; admin, manager | 3.6 |
| `rpc_wh_overview()` | admin, manager | Overview KPI band in one call (**proposed**, instead of seven count queries) |
| `rpc_wh_reconcile_physical(p_create_counts DEFAULT true)`; `rpc_wh_schedule_counts()` | service_role, admin | sections 6 and 8 |
| `rpc_wh_set_setting(p_key, p_value)` | admin | 4.3 |

### 5.3 Main RPCs

**`rpc_wh_generate_locations(p_rack_id uuid, p_dry_run boolean)`.** For each face, bay `b` in walk order and level `l`: code `face_code-lpad(b,2)-l`; zone from `zone_by_bay`; `default_bucket` from the zone (RTS and ACC finished, RAW raw, WIP in_production, MISC other, BOX none because boxes live in `materials`); `is_overflow` for the top level of an overflow template; `pickable` when `l` is in `pickable_levels`, the zone is RTS or ACC and the level is not overflow; x, y, z from the rack corner, rotation, bay width and beam heights. Existing rows match on (`face_id`, `bay`, `level`): geometry updates in place, a changed code returns as a conflict with no write (map edits never rename silently), and rows no longer generated deactivate only when empty. A dry run returns `{create, update, conflicts, deactivate, codes}` for the editor; applying recomputes every `pick_sequence`.

**`pick_sequence`** (**proposed** refinement of the workbook). The workbook's face order × 1000 + bay × 10 + level walks aisle A twice, although faces 01 and 02 face each other and are "picked on the same pass". The generator ranks every bay of a `walk_pass` by its position along the walk direction and assigns `walk_pass × 1000 + rank × 10 + level`. With the workbook's faces: pass 1 the accessory caps (07) by the cart start, pass 2 south down aisle A (01 and 02 interleaved), pass 3 north through B/C (03 and 04), pass 4 south down aisle D (05 and 06); WIP and MISC get 99xxx.

**`rpc_wh_putaway_container(p_container_id uuid, p_location_id uuid, p_move_id uuid DEFAULT NULL, p_client_event_id uuid DEFAULT NULL, p_actor_id uuid DEFAULT NULL)`.** Moves every balance of the container to the location in one group, buckets unchanged unless the target has `bucket_lock` (then a `wh_bucket_move` ledger row too). Refuses virtual or inactive targets, empty or void containers and the current location. Closes the putaway task with the actual location and whether the suggestion was followed; over `capacity_cartons` returns ok with `warning: 'over_capacity'`. Returns `{ok, container, from, to, followed_suggestion, next}`, where `next` is the oldest open putaway, so a receiver can carry two cartons.

**`rpc_wh_move_stock(p_sku_id uuid, p_qty integer, p_from_location_id uuid, p_to_location_id uuid, p_from_container_id uuid DEFAULT NULL, p_to_container_id uuid DEFAULT NULL, p_bucket text DEFAULT NULL, p_move_id uuid DEFAULT NULL, p_client_event_id uuid DEFAULT NULL, p_actor_id uuid DEFAULT NULL)`.** Loose or part-carton moves; `p_bucket` may be omitted when the source holds one bucket of the SKU. A move to `MFG-LINE` is "take to the line"; `rpc_wh_take_to_line` is its one-scan form for a whole carton (5.7). Errors: `insufficient` (with available), `ambiguous_bucket`, `location_inactive`.

**`rpc_wh_open_container(p_container_id uuid, p_to_location_id uuid DEFAULT NULL, p_unpack boolean DEFAULT false, p_client_event_id uuid DEFAULT NULL, p_actor_id uuid DEFAULT NULL)`.** The case break. Without a target, sealed becomes open in place. With a target, normally a pickable face, the carton moves there and opens: the usual "bring a level-3 carton down". `p_unpack` empties the units out as loose stock for the accessory caps. A non-pickable target returns `warning: 'not_pickable'`.

**`rpc_wh_take_to_line(p_container_id uuid, p_client_event_id uuid DEFAULT NULL, p_actor_id uuid DEFAULT NULL)`.** Moves every balance of a sealed or open carton to `MFG-LINE` in one group of `move` movements, keeps the container's id and label, and records who took it. Refuses `void` cartons and cartons already at the line (`already_at_line`). Returns `{ok, container, from, units}`. Called from the Workspace when an emptying task starts and from the Floor Move tile.

**`rpc_wh_rts_relabel(p_sku_id uuid, p_cartons jsonb, p_parent_container_id uuid DEFAULT NULL, p_task_log_id uuid DEFAULT NULL, p_client_event_id uuid DEFAULT NULL, p_actor_id uuid DEFAULT NULL)`.** `p_cartons` = `[{qty, state: 'sealed' | 'open'}]`, one entry per physical carton, plus an optional `{qty, loose: true}` remainder. In one transaction it: (1) checks that loose `finished` units of the SKU at `MFG-LINE` cover the total, else `insufficient_at_line` naming the gap, since the RTS task log must land first; (2) mints one green child per entry: code = parent code plus `R<n>` (n counts relabels of that parent), or `C-MFG-<nnnn>` without a parent; `source manufacturing`, `label_stock green`, `parent_container_id`, `finished_by` = actor, `finished_at` = now; (3) posts a `relabel` movement per child from loose finished at `MFG-LINE` into the child at `MFG-LINE`; (4) voids the parent when its balances are zero, setting `superseded_by` to the first child, and otherwise leaves it `open` at the line; (5) opens one putaway `wh_moves` row per child, `origin rts`, with a suggestion from `_wh_suggest_putaway` (the RTS pick face if it has room, else RTS overflow); (6) moves a loose remainder to the SKU's pick face through `rpc_wh_move_stock` when one exists, else leaves it at the line with a loose putaway task; (7) queues one `lpn_rts` print job for all children on the caller's station printer. Returns `{ok, containers: [{id, code, qty, suggested}], print_job_id, putaway_tasks}`. Before `physical_layer.live_since` it returns `{ok: true, dormant: true}` and the Workspace hides the step.

**`rpc_wh_record_count(p_location_id uuid, p_lines jsonb, p_count_task_id uuid DEFAULT NULL, p_started_at timestamptz DEFAULT NULL, p_client_event_id uuid DEFAULT NULL, p_actor_id uuid DEFAULT NULL)`.** `p_lines` = `[{sku_id, container_id | null, counted_qty, scan_value}]`; without a task it creates an `ad_hoc` one. It snapshots expected quantities per (SKU, container, bucket) at submit, writes counted lines plus a zero line for every expected item not scanned, flags `found_container_elsewhere` and, if anything moved at the location after `p_started_at`, `moved_during_count`. All-zero variance approves itself and stamps `last_counted_at`; otherwise `submitted`. The response `{ok, status, lines}` never carries expected quantities or variances.

**`rpc_wh_approve_variance(p_count_task_id uuid, p_decisions jsonb, p_actor_id uuid DEFAULT NULL)`.** Managers only; `p_decisions` = `[{line_id, resolution}]`, unlisted lines `accept`.
- `accept`: bin set to counted (`count_adjust`); the SKU total moves by the variance through a `wh_count_adjust` ledger row on the bucket's column, referencing the task. With write-offs and bucket locks, this is the module's only path into `inventory_levels`.
- `misplaced`: bin set to counted; the difference goes to or from `UNLOCATED`, no ledger row. A carton found here moves here.
- `write_off`: as `accept`, as a `wh_write_off` row.
- `recount`: no change; a `variance_recount` task opens.

Returns `{ok, adjusted_units, levels_delta, recounts}` and stamps `last_counted_at`.

### 5.4 Receiving: minting LPNs in `rpc_record_freight_receipt`

Migration 8 replaces the function with the same signature `(uuid, jsonb, uuid)` and return keys, so `useRecordFreightReceipt` and `ShipmentManifest` keep working. When `physical_layer.mint_lpns` is true:
- **Minting.** A tap on group G from `r0` to `r1` mints cartons `r0+1`…`r1`. Carton `k` holds, per SKU, `round(U·k/M) − round(U·(k−1)/M)`, the RPC's own rounding, so cartons sum exactly to the units credited. Code `C-` + shipment number reduced to `[A-Za-z0-9]` + `-` + `lpad(n, 3, '0')`, `n` counting across the shipment (**proposed**, because "carton n of N" is how receivers count). Single-SKU groups set `sku_id`; mixed groups leave it null. Balances land at `IN-01` in the bucket `_freight_credit_units` chooses, with `receive` movements referencing the `freight_receipts` row.
- **Tasks and labels.** One putaway `wh_moves` row per carton with a suggestion; one `wh_print_jobs` row per call.
- **Corrections.** A negative tap voids the group's newest cartons that are still sealed and full, wherever they are. If none qualify, the call fails with `lpn_in_use`: "Every carton from this group has been opened or split; count the location instead."
- **Unit mode** (no carton plan) credits loose units at `IN-01` with a putaway task per SKU and no labels.
- **Ledger.** `_freight_credit_units` is unchanged; the RPC sets `wh.mirror_skip` so the mirror (5.6) does not count the receipt twice.
- **Receive-all.** `rpc_apply_freight_delivery` sends a carton-planned shipment's remaining cartons as carton entries (**proposed**, because the unit path skips LPNs).
- **Return** gains `lpns`, `print_job_id` and `putaway_tasks`.

Suggestions (`_wh_suggest_putaway`): first match wins; a candidate is skipped if excluded, inactive, virtual, or full once open putaways pointed at it are counted.
1. Mixed carton: the break-down shelf in `putaway.breakdown_location_code`.
2. Same-SKU reserve: a non-pickable or overflow location holding sealed cartons of the same SKU and bucket, nearest by `pick_sequence` to where the SKU is picked.
3. Same-SKU face: when no pickable location holds an open carton or loose units of the SKU; the phone offers "Open to pick face".
4. Nearest empty location in the bucket's default zone (raw to RAW, finished to RTS overflow first), by distance from the SKU's pick face or `IN-01`.
5. Nearest empty storable location anywhere, since zones are defaults.
6. None: the receiver scans any location.

### 5.5 Labels and print jobs

Revised 2026-10-21: one queue, printers that belong to stations, and a station session that says which printer a worker means.

- **Rendering.** One pure module, `src/lib/warehouse/labels.ts`, turns a job's `payload` into ZPL (`^BC` Code 128, 3 dots per module at 203 dpi, so the barcode is about 2.4 in wide; `^` and `~` in free text escaped through `^FH`) and into Code 128 SVG with bwip-js (`toSVG`, `bcid: 'code128'`) for the browser path and the on-screen preview. The print agent imports the same module, so a label looks the same whichever path prints it.
- **LPN label** (4×2, white): barcode of `%C-466-007`, the code large, SKU and name or "MIXED BW20×12 + NB4×6", units, bucket word, shipment and "carton 7 of 40", date.
- **RTS label** (4×2, bright green stock): barcode of `%C-466-007R1`, the code large, "RTS" in the largest type on the label, SKU and name, units, the worker's first name and the completion date and time, the suggested bay, and "from C-466-007". The green stock is the signal: a picker or counter reads finished goods from across the aisle, and a white label in an RTS bay is wrong by definition.
- **Location label** (3×1): barcode of `%02-01-2`, the code large, "Face 02 · Bay 01 · Level 2", and "OVERFLOW" on level 3. **Station label** (3×1): `%ST-MFG-1` and the station name.
- **Print queue.** `rpc_wh_request_labels` creates a `wh_print_jobs` row. The target is, in order: the printer named in the call; the printer of the caller's live station session whose `label_stock` fits the kind (green for `lpn_rts`); `browser`, where the calling page renders and prints through a hidden iframe or saves a PDF. A phone therefore never talks to a printer: the phone asks, the station's printer answers. `rpc_wh_mark_printed` stamps `printed_at` and `print_count` on the items; a Reprint anywhere is a new job.
- **Station sessions** (**proposed** in this form, because routing by user account breaks the moment someone changes station). Every station location (`ST-S1` to `ST-S4`, `ST-DOCK`, `ST-MFG-1` to `ST-MFG-4`) has a label. Scanning it wherever a `ScanSink` is live calls `rpc_wh_start_station`, which ends the person's previous session and opens one at that station; the header shows a `StationChip` ("Mfg desk 2", tap to change) and every label request carries the session's station. A fixed laptop pins its station in `localStorage` and re-confirms it at sign-in. With `printing.require_station` on, a request with no session and no printer falls back to `browser` and the page says why.
- **Print agent.** `tools/print-agent/`, a small Node service installed on the dock laptop, the manufacturing laptop or one central PC, signed in as a dedicated `print-agent` auth user whose profile carries `is_print_agent`, the only grant `rpc_wh_claim_print_jobs` accepts. It owns the printers whose `agent_id` is its own: USB printers by Windows printer name through the raw spooler, network printers by TCP 9100. One PC can therefore drive a fleet of network printers while a laptop drives the printer on its own desk, and the queue is the same either way. It subscribes to `wh_print_jobs` over Realtime, polls every 15 s as a floor, claims with `FOR UPDATE SKIP LOCKED` (two agents never print one job), renders ZPL, sends, marks `printed` or `failed` with the error, retries up to `printing.max_attempts` with backoff, releases a claim older than `claim_timeout_s`, and heartbeats `last_seen_at`. A failed or stale job shows on the requesting page with "Reprint", "Print elsewhere" (another printer) and "Print from browser"; Settings › Warehouse › Printers shows each printer's agent, last seen and queue depth.
- **Guard.** `fn_outbound_allowed('agent_print')` is true only in `live`; in `practice` every job targets `browser` with the "PRACTICE · STAGING" band and `%Z` codes; in `blocked` requests are refused. PrintNode, if ever wanted, is a third `transport` behind the same guard, not a different queue.

### 5.6 Keeping the physical layer in step with the ledger

**Proposed:** every SKU-level change gets a physical twin in the same transaction, so the identity can break only through real-world events. All three parts stay dormant until `physical_layer.live_since` is set.

1. **Ledger mirror**, an AFTER INSERT trigger on `inventory_transactions` for `cycle_count`, `task_logged` and `freight_delivered`, skipped when `wh.mirror_skip` is on. Category moves from manufacturing (emptying, filling, RTS, pre-filled RTS) post a `bucket_convert` at `MFG-LINE`, drawing first from the balances of cartons taken to the line and then from loose units there; negative raw at the line is the cue that cartons were not scanned to the line. RTS output lands as loose finished units at the line, where `rpc_wh_rts_relabel` (5.7) boxes it into green cartons; only when no relabel follows does it accumulate with a loose putaway task, the no-scanner fallback. Breakage write-offs and Stock Levels cycle counts post at `UNLOCATED`. Receipts written by any other path post loose at `IN-01`. Errors go to `audit_logs` (`wh.mirror_failed`) and never fail the ledger insert, the rule `trg_apply_box_on_shipped` follows.
2. **Ship settlement.** `_wh_settle_order(order_id)` is ledger-derived like `rpc_apply_shipstation_sale`: per SKU, target = the order's net `order_shipped` plus rebase deduction if shipped, else 0; the difference from its `ship_settle` units moves. Sources: Phase 2 tote contents; open cartons and loose units on pickable locations by `pick_sequence`; sealed cartons there, which opens them. Overflow is never drawn, since nobody picks level 3. A shortfall goes to `UNLOCATED` as a negative and opens a `reconcile` count. Callers: a trigger on `shipstation_orders` when status becomes shipped; the mirror, when an `order_shipped` row lands for an already-shipped order (the webhook writes the order before calling the sale RPC); the nightly sweep.
3. **Explicit postings.** Count approvals and write-offs write ledger rows and movements together (5.3).

### 5.7 Cartons through manufacturing

Owner decision 2026-10-21. A carton of raw product leaves the raw racks, is emptied at the line, its contents are filled and RTS'd, and the finished units go back into a carton that is shelved in the RTS racks. The carton keeps an address at every step, and the RTS step is not complete until the carton has a green label and a bay.

| Step | Who and where | Scan | System | Carton after |
|---|---|---|---|---|
| 1. Pull | Worker at the raw rack; the Workspace emptying task start, or the Floor Move tile | carton LPN | `rpc_wh_take_to_line`: balances move to `MFG-LINE`; the raw bin is released | white, `sealed` or `open`, at `MFG-LINE` |
| 2. Empty | Workspace emptying log (unchanged) | none | ledger category move; the mirror draws raw from that carton at the line and credits loose `in_production` | `empty` at `MFG-LINE` once drained; a partial carton stays `open` and can be parked on the WIP rack with Move |
| 3. Fill, cap | Workspace (unchanged) | none | the mirror converts loose units at the line | — |
| 4. RTS | Workspace RTS or pre-filled RTS log (unchanged) | none | the mirror credits loose `finished` at the line | — |
| 5. Relabel | Workspace RTS step, required when live | parent LPN, or "no label" | `rpc_wh_rts_relabel`: green children minted at the line, parent voided when empty, a putaway task per child with a suggested bay, an `lpn_rts` job to the station printer | green, `sealed` (`open` if partial), at `MFG-LINE`, "printed, not placed" |
| 6. Place | Worker carries the carton; Floor Put away or the Workspace | bay label | `rpc_wh_putaway_container`: balances move to the bay; the task closes with whether the suggestion was followed | green, in its bay, pickable from the face or held in RTS overflow |

Rules:
- Step 1 has a fixed destination, so it is one scan with no bay scan. Step 6 is the worker's choice, so it is always a bay scan (or "Put here" with `confirm_putaway_location` off).
- A relabelled carton is a new container with a new code, linked to the parent. What comes back from RTS is rarely what went in (breakage, partial batches, units from two cartons), so contents are declared, not inherited: the quantity on the green label is the quantity the worker confirmed. The white barcode is voided at print; scanning it later says "C-466-007 was RTS'd as C-466-007R1 by Devon on Oct 21, 2:14 PM; use the green label" and offers Reprint green. Lineage stays queryable back to the freight receipt through `parent_container_id`.
- A batch can fill several cartons and leave a remainder. The Workspace step starts with one row holding the full quantity; "Add another carton" splits it; "Remainder loose to pick face" sends the rest to the open carton at the SKU's face. Each carton gets its own label and task.
- Pre-filled cartons waiting between filling and RTS are parked on the WIP rack with the Move tile, so a half-finished batch is findable too; they keep their white label.
- Until placed, a green carton shows on the Workspace ("1 carton waiting for a bay"), on the Floor Put away tile badge, on the Inventory Overview "To put away" card, and in the nightly run as `rts_unplaced`. Nothing is lost by forgetting; it nags.
- Fallback: an RTS logged with no station session (a manager backfilling on a desktop) skips the relabel; finished units sit loose at the line with a loose putaway task, as 5.6 describes. With `rts.require_relabel` on, the Workspace refuses to complete the RTS step without a carton whenever a station session exists.
- Counting: a white LPN scanned in an RTS zone flags "needs a green label" on the count line; a green LPN scanned in a RAW zone flags the reverse.
- Hardware: a 4-inch direct thermal printer at the manufacturing desks loaded with fluorescent green 4×2 labels, a scanner at each desk, and a station label per desk. The Workspace runs on the desk laptop, which also runs the print agent; a phone can log the step too, and the label still comes out at the desk.

---

## 6. Nightly reconciliation

`rpc_wh_reconcile_physical` runs at 09:00 UTC (**proposed**: after the 03:15 UTC ShipStation reconcile and before the 8 AM ET daily report). Per SKU:
- **P**: on-hand of `finished` balances at every active location, including `IN-01`, `MFG-LINE` and `UNLOCATED`.
- **O**: units the ledger deducted for orders neither shipped nor cancelled (the negated sum of their `order_shipped` and rebase rows).
- **H**: the same for cancelled orders, deducted and never credited while cancellations are deferred.
- **S**: deducted units on shipped orders not yet settled; non-zero only when a settlement failed.
- **L**: `inventory_levels.warehouse_finished`.

The settled identity is **P − O = L**. The report shows the residual **R = P − O − H − S − L**, with H and S as explained terms; R ≠ 0 is a discrepancy. Other buckets use R = P(bucket) − L(bucket).

Each run sweeps settlements, prunes zero balances, writes a run row plus a line per (SKU, bucket) with a non-zero R, H or S, and with `reconcile.create_counts` on opens `reconcile` counts on up to `max_counts_per_sku` pickable locations per finished-residual SKU. Discrepancies surface on the Counts › Reconcile tab, as Overview tiles ("Off by", "Unlocated"), and in the daily report: `rpc_daily_report` gains `warehouse: {mismatched_skus, abs_units, unlocated_units, putaway_over_24h, rts_unplaced, counts_due}`, re-issued whole by migration 10 because it is one SQL body.

---

## 7. Receiving and putaway, end to end

Desktop at the dock (`FreightDetail`):
- Banner and steppers stay; +1 or "Check in all N cartons" also prints that call's LPN labels. `ShipmentStepper` gains "Label cartons" and "Put away" stages.
- The manifest gains LPNs (a range chip such as `C-466-001…040`, with reprint) and Put away (n of N, amber until done).
- A Putaway queue card lists each LPN with SKU or MIXED, units, suggested location, reason and status, with Re-suggest and Reprint.
- A correction names its consequence on the button: "Void C-466-040".

Phone (`/go/putaway`), one route driven by state so nothing remounts between cartons:
1. Waiting: `ScanSink` live; the worker's own green cartons at `MFG-LINE` first, then LPNs at `IN-01` and other green cartons, oldest first.
2. Scan an LPN: hero "Put it in 02-01-3" with face, bay and level words, SKU, units, reason chip, next-LPN preview; Suggest another, Open to pick face (when offered), Reprint.
3. Scan a location: the suggested one flashes green; any other storable one is accepted with an amber flash and recorded as not followed; virtual or inactive flashes red and changes nothing. With `confirm_putaway_location` off, "Put here" confirms without the scan.
4. Back to step 1 with the next LPN preselected.

## 8. Cycle counts

- **Phone (`/go/count`).** Due tasks sorted by `pick_sequence`, so the list is a count path. Scanning a location label starts its task or an ad hoc one. The screen shows only what has been scanned. A sealed carton's LPN counts at full quantity; an open carton's LPN asks for units on `BigStepper`; a product barcode adds one loose unit per scan, correctable with the stepper. Unknown barcodes flash red and offer managers "Link to SKU". A white LPN in an RTS zone, or a green one in a RAW zone, is accepted with an amber flash and a "wrong label colour" flag on the line. Done submits, flashes green and opens the next task.
- **Desktop (`/warehouse/counts`).** Variances lists submitted tasks with expected, counted, variance, counter, the moved-during-count flag and a likely cause from recent movements at the location (a settlement that morning, a carton opened without a move); per line Approve, Misplaced, Write off, Recount. Managers only.
- **Schedule.** `rpc_wh_schedule_counts`, nightly after the reconcile: a location is due when `last_counted_at` is older than the shortest cadence of the SKUs it holds, from `product_skus.abc_classification` (A 7 days, B 30, C 90, unclassified C), most overdue first up to `daily_cap`. Weekly A counts are what the ops audit asks for while cancellations stay deferred.
- **Pick-triggered.** The kind exists now; the Phase 2 pick confirm creates one when a pick empties a bin.

---

## 9. Frontend

### 9.1 Routes

The paths below predate the Inventory merge; `docs/design/INVENTORY_MODULE_IA.md` and `src/lib/inventory-routes.ts` hold the current ones (`/warehouse` → `/inventory`, map and counts → `/inventory/stock?view=`, putaway → `/inventory/shipments?filter=receiving`, locations and the layout editor → Settings › Warehouse). Pages keep the names below.

| Route | Page | Roles | Notes |
|---|---|---|---|
| `/warehouse` | `pages/warehouse/WarehouseOverview.tsx` | admin, manager | `StatCard` band: putaways, counts due, variances, unlocated, off-by SKUs, accuracy |
| `/warehouse/map` | `WarehouseMap.tsx` | admin, manager | `?mode=browse\|stock\|counted\|heat`, `?view=plan\|elevation`, `?loc=`, `?q=` |
| `/warehouse/map/edit` | `LayoutEditor.tsx` | admin | three panes |
| `/warehouse/racks/:rackId` | `RackDetail.tsx` | admin, manager | elevation per face |
| `/warehouse/putaway` | `PutawayQueue.tsx` | admin, manager | `?shipment=`; the dock's printer comes from its station session (5.5), not a URL flag |
| `/warehouse/counts` | `Counts.tsx` | admin, manager | Variances, Count tasks, Schedule, Moves, Reconcile; Replenishment in Phase 2 |
| `/warehouse/locations` | `Locations.tsx` | admin, manager | dense table, inline edit, CSV export, labels |
| `/go` | `pages/go/FloorHome.tsx` | admin, manager, user | tiles, scan anything |
| `/go/putaway` | `GoPutaway.tsx` | admin, manager, user | `?lpn=` |
| `/go/count` | `GoCount.tsx` | admin, manager, user | list and count in one route |
| `/go/move` | `GoMove.tsx` | admin, manager, user | includes "Take to line" |
| `/go/lookup` | `GoLookup.tsx` | admin, manager, user | location, LPN or product |
| `/manufacturing/workspace` | existing `Workspace.tsx` | admin, manager, user | the emptying task gains "Scan the carton" (take to line); RTS tasks gain the carton step (5.7) |
| `/settings` Warehouse tab | `settings/WarehouseSettings.tsx` | admin | scan rules, putaway, schedule, labels, printers and agents, stations, RTS rules, outbound (read-only off production), carts placeholder |

Map modes in Phase 1: Browse, Stock (cartons against capacity), Counted (days since count), Heat. **Proposed:** Heat paints ShipStation units per SKU over 30 days onto the bins holding each SKU, since bin-level picks exist only after Phase 2. Route mode is Phase 2; meanwhile the editor's Verify walk draws the `pick_sequence` path. Also in Phase 1: Stock Levels rows expand to a by-location list with the effective count still the headline, and SKU detail gains a Locations tab.

### 9.2 Task-mode shell

`/go` routes use their own layout route, `GoLayout`, inside `RequireAuth`: the normal `Layout` from `md` up, and below `md` a `TaskShell` with a 44 px top bar (exit, title, "3 of 12"), an `h-dvh` column and a bottom action area padded by the safe-area inset. Targets ≥ 52 px, primary actions ≥ 56 px, location codes ≥ 40 px, and no typing anywhere, because a paired scanner hides the iPhone keyboard.

### 9.3 Components

| Component | Path | Notes |
|---|---|---|
| `ScanSink` | `components/warehouse/ScanSink.tsx`, `lib/warehouse/scan.ts` | window-level keydown buffer (gap < 40 ms, Enter ends) plus hidden-input fallback, so scans land with nothing focused; `classifyScan()` hints, `rpc_wh_resolve_scan` decides |
| `LocationCode` | `components/warehouse/` | tabular `FF-BB-L`, small and hero sizes, words line |
| `BigStepper` | `components/shared/` | extracted from the Workspace quantity card, which then uses it unchanged |
| `ResultFlash` | `components/warehouse/`, `lib/warehouse/feedback.ts` | full-screen green, amber, red; Web Audio tones unlocked on first tap |
| `FloorPlan` | `components/warehouse/map/` | SVG in mm: racks, bay cells coloured by mode, fixtures, search highlights, viewBox zoom |
| `RackElevation` | `components/warehouse/map/` | levels × bays per face; SKU chips with carton counts; level 3 hatched |
| `LocationDrawer` | `components/warehouse/` | right `Sheet` 340 px: code, chips, contents by carton, last count; Move, Count now, Print label, Rack view; history |
| `LayoutEditor` | `components/warehouse/editor/` | Palette, Canvas (100 mm snap, rotate, duplicate), Properties with faces; dry-run preview; Import; Verify walk |
| `PutawayQueueCard` | `components/freight/` | on `FreightDetail` |
| `LabelSheet`, `WhFind` | `components/warehouse/` | print page; command-palette search over SKU, LPN, location |
| `StationChip` | `components/warehouse/` | header chip with the live station; scan a station label to change it; pinned on fixed laptops |
| `RtsCartonStep` | `components/manufacturing/` | the Workspace step: parent scan, carton rows, remainder, print and place status |
| `PrintJobStatus` | `components/warehouse/` | toast or inline row: queued, printing at Mfg desk 2, printed, failed with Reprint, Print elsewhere, Print from browser |
| print agent | `tools/print-agent/` | Node service, not a component; shares `lib/warehouse/labels.ts` |
| `PageHeader`, `EmptyState` | `components/shared/` | extracted to stop further copies |

`lib/status-colors.ts` gains `PUTAWAY_STATUS_COLORS`, `COUNT_STATUS_COLORS` and `CONTAINER_STATE_COLORS` with the existing semantics (amber needs action, green done, red failure, slate terminal). Pure, tested modules in `src/lib/warehouse/`: `gtin`, `scan`, `location-code` (the generator's TypeScript twin for the editor preview), `carton-split`, `map-geometry`, `labels`, `count-schedule`, `reconcile-format`, `csv`.

### 9.4 Hooks, query keys, Realtime

Hooks in `src/lib/hooks/use-warehouse-layout.ts`, `use-warehouse-stock.ts`, `use-warehouse-tasks.ts`, `use-sku-barcodes.ts`, re-exported from `index.ts`.

| Key | Hook | Reads |
|---|---|---|
| `["wh-layout"]` | `useWhLayout` | templates, racks, faces, fixtures |
| `["wh-locations"]` | `useWhLocations` | `wh_location_summary` (cartons, units by bucket, SKUs per location) |
| `["wh-location", id]` | `useWhLocation` | one location: balances, containers, movements |
| `["wh-balances", skuId]` | `useWhBalancesBySku` | search, SKU detail, Stock Levels expansion |
| `["wh-containers", filter]`, `["wh-putaway", filter]` | `useWhContainers`, `useWhPutawayQueue` | by shipment or location; open putaways |
| `["wh-counts", status]`, `["wh-count", id]` | `useWhCountTasks`, `useWhCountTask` | tasks and lines |
| `["wh-reconcile"]`, `["wh-settings"]`, `["wh-overview"]`, `["sku-barcodes", skuId]` | matching hooks | latest run; settings; `rpc_wh_overview`; barcodes |
| `["wh-station"]`, `["wh-printers"]`, `["wh-print-job", id]` | `useWhStation`, `useWhPrinters`, `useWhPrintJob` | the caller's live session; printers with agent heartbeat; one job's status over Realtime |

Mutations (`useWhPutaway`, `useWhMoveStock`, `useWhOpenContainer`, `useWhWriteOff`, `useWhRecordCount`, `useWhApproveVariance`, `useWhGenerateLocations`, `useWhSaveLayout`, `useWhRequestLabels`, `useWhImportStock`, `useImportSkuMaster`) unwrap the envelope and invalidate roots; phone mutations send `crypto.randomUUID()` as `client_event_id` and keep `ShipmentManifest`'s pendingKey guard. `useRecordFreightReceipt` also invalidates `wh-putaway` and `wh-containers`.

Realtime via `useLiveInvalidate`: channel `wh-stock` (balances, containers) invalidates the location, balance and container roots; `wh-tasks` (moves, count tasks) invalidates `wh-putaway`, `wh-counts`, `wh-overview`; `wh-print` is subscribed by the print agent and, per job id, by the page that requested the label. `/go` pages also refetch every 60 seconds.

### 9.5 Dependencies

`bwip-js` 4.x, `cmdk`, `@radix-ui/react-toggle-group`, `@radix-ui/react-radio-group`, `vaul` (with `Sheet side="bottom"` as fallback); shadcn files `skeleton`, `toggle-group`, `drawer`, `command`, `radio-group`. No 3D, canvas or camera library.

### 9.6 Importing the digitizing workbook

Import spreadsheet takes the workbook's tabs saved as CSV (**proposed**: CSV, to avoid a spreadsheet dependency).
1. Racks, Faces, Fixtures to `rpc_wh_save_layout`; feet × 304.8 = mm; templates from the Scale tab, pallet racks marked `overflow_top_level`.
2. A generator dry run is compared with the Locations tab by code; only `pick_sequence` should differ (5.3).
3. Named locations to `rpc_wh_save_location`; SKU boxes to `rpc_wh_import_sku_master`.
4. Stock placement to `rpc_wh_import_stock`, dry run first: SKU, location, sealed cartons, units in the open carton, units per carton, and an optional Bucket column defaulting to the location's bucket (always finished for non_fillable SKUs). It mints `C-OB-nnnn` sealed cartons plus one open carton, with `opening_balance` movements and no ledger row. The first reconcile then shows the true gap between books and shelves, which the go-live count resolves.

---

## 10. Test plan

**Vitest** (pure modules beside the code, the repo convention):
- `gtin`: all 86 catalog codes (fixture from `sku_catalog_with_upc.csv`) resolve to their `upc_gtin12` from the 12-digit, leading-zero 13-digit, 8- and 7-digit forms; check digits; EAN-8 not mistaken for UPC-E.
- `scan`: `%02-01-2` location, `%C-466-007` carton, `%ZC-466-007` practice, `^#^499602D2^` order 1234567890, `BW20` and `10-Filters` SKU-like, digit strings GTIN.
- `location-code`: 71 rack bay-level codes from the workbook's faces; level 3 never pickable; faces 01 and 02 interleaved. A staging smoke asserts the TypeScript preview equals the SQL dry run.
- `carton-split`: per-carton units sum to `units_total` for random U and M.
- `count-schedule`, `reconcile-format`, `map-geometry`, `csv`.
- `labels`: ZPL for an LPN, an RTS label and a station label carries the right barcode value, escapes `^` and `~` in free text, fits 4×2 and 3×1 at 203 dpi; the SVG and ZPL paths encode the same value.
- Hooks: extend `hooks.test.ts` with each mutation's RPC name and arguments, and that `ok: false` throws.

**SQL test** `supabase/tests/warehouse_phase1.test.sql`, rolled back like `supplier_portal_rls.test.sql`: receive a two-group shipment (one mixed) and assert LPNs, per-carton units, `IN-01` balances and unchanged ledger rows; void by negative tap; put away; open to a face; count a variance; approve as accept (ledger row, levels moved) and as misplaced (`UNLOCATED`); settle a shipped order; reconcile to zero. Manufacturing: take a raw carton to the line, log emptying and RTS, relabel into two green cartons and a loose remainder, assert the parent is `void` with `superseded_by`, the children sit at `MFG-LINE` with open putaways and one `lpn_rts` job, a scan of the parent's code resolves to the child, then put one child away; two agents claim the same job and only one wins. RLS: suppliers read no `wh_*` rows; a `user` cannot approve.

**Smoke after every deploy.** `CREATE OR REPLACE FUNCTION` does not validate referenced relations (CLAUDE.md), so every new or replaced RPC gets one call on the target project, kept as a paste-ready block in the migration header. Success or a validation envelope (random ids returning `*_not_found`, `rpc_wh_move_stock` returning `insufficient`, imports and the generator in dry-run mode) passes; a relation error fails. The block also calls `rpc_record_freight_receipt` with a random shipment, `rpc_daily_report()` and `fn_gtin_candidates('1383325')`.

**Manual on staging:** an iPhone and an Android phone with paired HID scanners, the dock and manufacturing laptops printing through the agent, and one label requested from a phone arriving at the station's printer.

## 11. Rollout

1. Phase 0 on staging; migrations 1-3 to staging, then production, where an admin sets `outbound` to `live` and the edge secret `ERP_OUTBOUND_MODE=live`; UPC import on both.
2. Phase 1 migrations to staging with `physical_layer` off; smoke; regenerate `src/lib/database.types.ts` through the Management API types endpoint.
3. Owner practice on staging in `practice` mode: import the workbook, print practice labels, put away a staged shipment, count, approve, read a reconcile.
4. Production deploy with `live_since` null and `mint_lpns` false: nothing changes for anyone.
5. Layout import; print shelf labels in `pick_sequence` order; hang them; walk with `/go/lookup`, which stamps `label_verified_at`, until every location is verified. Install the print agent on the dock and manufacturing laptops, register the printers and hang the station labels.
6. Opening stock: import placement; apply the `C-OB` labels; full count on go-live day; approve; set `live_since` and `mint_lpns` in one settings call. Mirror, settlement and reconcile start then.
7. The next freight arrival uses LPN check-in and phone putaway, and the next RTS batch leaves the line in green cartons; two clean weeks close Phase 1.

Rollback is a setting: turning `physical_layer` off stops minting, mirroring and settlement, and the SKU books never depended on it.

## 12. Acceptance criteria

**Phase 0**: the 3.10 exit criteria (the scope report's, adjusted because HID scanning needs no camera), plus the Warehouse sidebar group with correct active states.

**Phase 1** (scope report: "Every unit and carton has a bin; reconciliation report is clean for two consecutive weeks; map search finds any SKU/LPN"), made testable:
- Every carton received after go-live has an LPN printed at check-in and is put away; in a normal week none waits at `IN-01` over 24 hours.
- Every RTS batch logged after go-live leaves the line in green cartons placed in a bay within the shift; `rts_unplaced` is zero at the nightly run in a normal week.
- A label requested from a phone prints at the worker's station within ten seconds, and a failed print shows on the phone with a way to reprint.
- Every active location has a verified label; every SKU with stock has a location.
- Fourteen consecutive nightly runs with zero finished residual, and `UNLOCATED` back to zero after each week's counts.
- Map search highlights every location and carton for any SKU or LPN within one second on the dock laptop.
- Every A-SKU location is counted in each 7-day window.
- Every RPC passes its smoke call on production.

The scope report's Phase 1 also listed a 3D overview (dropped by the owner) and a slotting view (moved to Phase 2; it needs bin-level pick history).

## 13. Risks

| Risk | Effect | Mitigation |
|---|---|---|
| Settlement guesses the shelf | Bin drift, never total drift | Weekly A counts; ends with Phase 2 pick scans |
| "Take to line" scans skipped | Negative raw at `MFG-LINE` | Overview tile; reconcile line names it; one-scan take to line at the start of the emptying task |
| RTS logged without the relabel | Finished units loose at `MFG-LINE`, invisible to settlement | Loose putaway task and Overview tile; `rts.require_relabel` blocks the Workspace step when a station session exists |
| Print agent PC off, or printer out of labels | No labels at that station | Agent runs as a service with a heartbeat shown in Settings; browser print fallback; any agent may claim a network printer's jobs |
| Two labels on one carton | Contents read from the wrong one | Parent voided at print, the old label explains the relabel, counts flag the wrong colour per zone |
| Stock Levels edits after go-live | Units in `UNLOCATED` | Counts lists them for managers |
| Bay capacity unknown | Overfilled bays | Measured template capacity; Suggest another |
| Staging cron calls production | Wrong runs or emails | Check 5; migration 3; refresh clears jobs |
| Personal data reaches staging | Privacy breach | Allowlist, check 7, refresh aborts |
| Forged `p_actor_id` | Privilege escalation | `_wh_actor` uses `auth.uid()` |
| Realtime drops on phones | Stale screens | Visibility refetch, 60 s floor, server checks every scan |
| Labels unreadable at height | Scan failures | 3 dots per module, wide quiet zones, test level 3 first |
| Codes change after labels hang | Shelves mismatch | No silent renames; Verify walk before printing |
| `rpc_daily_report` re-issued whole | Email regression | Diff against current body; run on staging first |

---

## Appendix A. Wireframe boards to routes and components

The UX layout report describes its 15-artboard canvas by screen rather than number; this follows its sections in order.

| # | Board | Route | Components | Phase |
|---|---|---|---|---|
| 1 | Floor home | `/go` | `FloorHome`, `TaskShell`, `ScanSink` | 0 shell, 1 tiles |
| 2 | Freight detail: LPN check-in, label and putaway stages | `/freight/:id` | `ShipmentManifest`, `ShipmentStepper`, `LabelSheet` | 1 |
| 3 | Putaway queue card | `/freight/:id`, `/warehouse/putaway` | `PutawayQueueCard`, `PutawayQueue` | 1 |
| 4 | Phone putaway | `/go/putaway` | `GoPutaway`, `LocationCode`, `ResultFlash` | 1 |
| 5 | Map: plan, modes, Find | `/warehouse/map` | `FloorPlan`, `WhFind`, toggle-group | 1 (Route mode 2) |
| 6 | Map: rack elevation | `/warehouse/racks/:rackId` | `RackElevation` | 1 |
| 7 | Location drawer | `/warehouse/map?loc=` | `LocationDrawer` | 1 |
| 8 | Edit layout | `/warehouse/map/edit` | `LayoutEditor`, Verify walk | 1 |
| 9 | Counts & Replenish, blind phone count | `/warehouse/counts`, `/go/count` | `Counts`, `GoCount`, `BigStepper` | 1 (Replenishment 2) |
| 10 | Overview | `/warehouse` | `WarehouseOverview`, `StatCard` | 1 (pick KPIs 2) |
| 11 | Pick & Pack board | `/warehouse/pick` | | 2 |
| 12 | Phone: start cart | `/go/pick` | | 2 |
| 13 | Phone: next pick | `/go/pick` | | 2 |
| 14 | Phone: exception sheet | `/go/pick` | | 2 |
| 15 | Phone: cart complete, hand-off | `/go/pick` | | 2 |

Specified but not drawn as boards: the Locations table, Settings › Warehouse, the Workspace RTS carton step, the station chip and the print agent (Phase 1), tote labels and the bench helper (Phases 2-3).
