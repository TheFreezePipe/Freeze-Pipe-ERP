# Current Inventory-related pages audit

Read-only audit to support merging the Inventory and Warehouse sidebar groups. Code state: branch `feat/warehouse-phase0` with uncommitted Phase 0 edits (Sidebar, App, landing). Paths are repo-relative; `file:line` refers to that working tree.

**Headline findings**
- Only Stock Levels, Shipments and Factory Orders carry real inventory workflow today. The Warehouse group is one live page (Overview, which shows ship-day KPIs, not stock) plus four 12-line "Arrives with Phase 1" stubs.
- Stock Levels is a 1,504-line page doing four jobs: view, cycle count, order builder, SKU drill-down.
- There is no SKU hub. Stock lives in a modal on Stock Levels; costs, ShipStation aliases and recipes live on an admin-only page that shows no stock.
- Receiving is desktop-only and admin/manager-only, inside Shipments.

## 1. Navigation today

Sidebar groups (`src/components/layout/Sidebar.tsx:53-120`): Manufacturing (Floor `/go`, Overview, Workspace, Performance; all roles incl. `user`; :59-67), Inventory (Stock Levels `/inventory`, Shipments `/freight`, Factory Orders, Materials; admin/manager; :68-78), Warehouse (Overview, Map, Putaway, Counts, Locations; admin/manager; :79-88). A `user` sees only the Manufacturing group. Roles are declared twice, in the sidebar and in `src/App.tsx` `RequireRole` blocks (:110-333), and must be edited together. `END_ROUTES` (:124-133) makes `/inventory`, `/freight`, `/warehouse`, `/go` exact-match. That is right for Stock Levels (siblings like `/inventory/factory-orders` have their own items) but means Shipments goes unlit on its own detail pages `/freight/:id` and `/freight/new`.

## 2. Page by page

**Dashboard** `/dashboard` · "Dashboard" · admin, manager (`src/pages/Dashboard.tsx`)
- Purpose: one-screen ops summary.
- Sections: 4 StatCards (High Risk Value, Active Freight, Orders Shipped Today, Orders 7 Days; :58-98); Retail Value summary bar and Manufacturing Completion bar, each opening a modal (:100-129); Retail Value and 30-day Demand by category chart (:131-139); Alerts (:141-151); Sea cost-per-carton chart (:153-164); Active Freight cards (:166-208, not clickable).
- Reads: `useFreightShipments`, `useFreightLineItems`, `useSalesPulse`; children read `useInventory`, `useFactoryOrders`, `useProductBoms`, forecasts, economics.
- Links out: `/freight?filter=high_risk` (:65), `/freight` (:73), Alerts to bare `/inventory` (`AlertsPanel.tsx:104,117,134,144`) or `/freight/:id` (:162).
- Use: manager glance; floor never sees it.

**Floor home** `/go` · "Floor" · all internal roles (`src/pages/floor/FloorHome.tsx`)
- Purpose: phone home for floor staff; PWA `start_url` and `user` landing.
- Sections: tiles (:19-25): Put away, Count, Move (disabled, "Phase 1" badge), Look up, Manufacture (wide, to Workspace); always-on `ScanSink` (:58) that routes any scan to Look up.
- Reads: nothing. Floor: primary entry. Manager: rarely.

**Look up** `/go/lookup?scan=` · no sidebar item · all internal roles (`LookupPage.tsx:162-276`)
- Purpose: scan a barcode or SKU, see which SKU it is.
- Sections: scan card; match card with SKU, name, code, symbology, Finished and On hand (:47-91); no-match card with kind chip and candidates; "Link to SKU" (admin/manager only; :93-160, :263).
- Reads: `rpc_wh_resolve_scan`, `rpc_wh_link_barcode`, `useInventory`, `useProducts`.
- Floor: identify a product. Manager: attach barcodes. Shows no location, no inbound, no buckets.

**Manufacturing Overview** `/manufacturing` · "Overview" · admin, manager, user (`ManufacturingDashboard.tsx`)
- Purpose: what to make next.
- Sections: 5 StatCards, Raw, Pre-filled Raw, In Production, Finished (summed over all SKUs), Today's Output (:121-125); "Pipeline Status - Fillable SKUs" ranked by priority score, each row with urgency badge, launch chip, finished DOS, unfilled %, 4-segment bucket bar (:128-267).
- Reads: `useInventory`, `useTaskLogs(200)`, `useForecastDemandMap`, `useUpcomingMarketingBySku`. No links out.
- Floor: pick the next job. Manager: pipeline health.

**Workspace** `/manufacturing/workspace` · "Workspace" · all (`Workspace.tsx`)
- Purpose: log a manufacturing task (phone-sized form).
- Sections: My-output strip linking to Performance (:116); SKU tiles with search or scan text (:131); 5 task types (:169): Emptying raw to WIP, Filling and Capping (no bucket move), RTSing WIP to Finished, Pre-Filled RTSing prefilled_raw to Finished, Log Breakage (Finished removed); quantity stepper defaulting to carton size (:207); notes; Log Task (:270).
- Writes: `rpc_log_task_completion` via `useLogTask`. Reads: `useProducts`.
- Floor: main daily tool. Manager: occasional.

**Performance** `/manufacturing/performance` · all (`Performance.tsx`)
- Sections: date-range selector (URL `range`, `from`, `to`); 4 KPIs (Avg Tasks/Hr disabled, :127-160); time chart; leaderboard (leadership only, :172-174); SKU insights.
- Reads: `useTaskLogs()` (hook default 50,000 rows, paged by 1,000). `user` is forced to "Just me". The comment at `App.tsx:139-141` ("leaderboard visible to everyone") is stale.

**Stock Levels** `/inventory` · sidebar "Stock Levels", page h1 "Inventory" (:868) · admin, manager (`src/pages/inventory/InventoryDashboard.tsx`)
- Purpose: per-SKU stock across warehouse, in transit and on order, with days of supply, plus counting and ordering.
- Header actions (:861-922): "Build order" mode (cart in localStorage `fp-erp-order-cart`, :554-565; Review draft order dialog :1344 groups lines by supplier and opens `NewFactoryOrderDialog`); "Edit" cycle-count mode.
- KPIs (:930-933, collapse on scroll): In Warehouse, In Transit, On Order, Est. Sales/Day.
- Filters (:947-1018): search `q`, `category`, `abc`, `archived` (URL-persisted, :531-534), DOS-target slider (localStorage `freeze-pipe-dos-target`, :538).
- Table (:1033-1075): SKU, Category, ABC, Demand/mo (O/F badges), Warehouse Units+DOS, In Transit Units+DOS (hover popover per shipment), On Order Units+DOS (hover popover per factory order, with allocated chips), Total Units+DOS, Order column in order mode. Raw/Pre-filled/WIP/Finished columns appear only in edit mode (:1036-1042) and in the modal; `warehouse_other` is saveable (:752-766) but has no input.
- Row click opens `SKUDetailModal` (:1082, :1330; `src/components/inventory/SKUDetailModal.tsx:221-525`): 4 summary cards, demand-source picker (admin pins auto/manual), 90-day projection chart, Warehouse Breakdown (Raw, Pre-filled, WIP, Finished, Other), admin Archive/Restore.
- Save opens a reason dialog (:1423; breakage, mispick, theft, receiving_error, other) then `rpc_bulk_cycle_count` (`use-inventory.ts:126-170`).
- Reads: `useInventory`, freight shipments and lines, `useFactoryOrders`, `useProductBoms`, forecasts, demand overrides, marketing signals, suppliers, supplier costs (:459-505).
- In: Dashboard alerts, daily email, sidebar. Out: none (modal does not link to SKU Detail, orders or shipments).
- Floor: none (route blocked). Manager: stock check, counts, ordering.

**Shipments** `/freight` · "Shipments", h1 "Freight Tracking" (:270) · admin, manager (`src/pages/freight/FreightDashboard.tsx`)
- Sections: Refresh tracking and New Shipment (:274-281); KPIs Active Freight, High Risk (+$ at risk), Typical Sea Transit (opens `TransitReportModal`), Pre-filled % (opens `PrefillReportModal`) (:286-326); tabs All/Sea/Air/High Risk (`?filter=`, :332); list grouped "Receiving (n)", "In Transit", "Delivered" (3 days shown, older 20 at a time; :48-49).
- Card (`ShipmentCard` :446): status override select, ETA cell with drift, cartons callout, tracking, carrier, freight cost, lines table (SKU, Qty, Unit Cost, Line Total, Prefilled); dock banner "x of y cartons to check in" with "Check in cartons" (just navigates to detail, :591) or legacy "Receive all remaining" (`rpc_apply_freight_delivery`, :598).
- Reads: `useFreightShipments`, `useFreightLineItems`, `useAllCartonGroupTotals`; a tracking worker polls per shipment.
- In: Dashboard, Alerts, Launch supply table, FO detail. Manager: monitor ETAs, start check-in.

**Shipment detail** `/freight/:id` · admin, manager (`FreightDetail.tsx:74-720`)
- Sections: header (number, type, status override, receiving chip, copyable tracking, inline carrier/tracking edit, China-customs +7d menu :497-510); metric cards (cartons, units, ETA drift, freight cost, :518-575); `ShipmentStepper` Created, Shipped, Customs, Ground, Received (:592); `ShipmentManifest` (:595): dock banner "n cartons awaiting check-in", Check in all, per-carton-group +/- steppers (`rpc_record_freight_receipt`), columns Item/Qty/Pack/Ctns/From order/Received; Close short (`CloseShortDialog` :708, `rpc_close_freight_short`); cost strip.
- Out: "From order" to `/inventory/factory-orders/:id` (`ShipmentManifest.tsx:261`).
- This is the only receiving surface. Check-in credits Raw/Pre-filled/Finished buckets and is blocked for `user` in UI and RPC.

**New shipment** `/freight/new` · admin, manager (`FreightNew.tsx`)
- Sections: Shipment Details (:768), Carton groups with per-SKU factory-order allocations and prefilled flag (:871), Samples and Non-catalog (:1237), Shipping Costs (:1304), Notes (:1329). Submit creates and opens detail (:706). Suppliers do the same in `/supplier/shipments/new`.

**Factory Orders** `/inventory/factory-orders` · admin, manager (`FactoryOrders.tsx:180-420`)
- Sections: New Order (`NewFactoryOrderDialog`); 4 KPIs (Open Orders, Units In Production, Units At Factory, Open Value; :354-357); tabs `?filter=` all, NANCY, YX, in_production, finished, shipped (:360); order cards (:422) with inline order-number edit, supplier/status badges, days-left, missing-component chip, linked child orders panel with link/unlink (`LinkOrderDialog`), per-SKU progress bars (ordered, in production, at factory, shipped) with cost and value; "Completed" section, older than 3 days collapsed.
- Click goes to detail. In: Stock Levels (create only), launch supply, PD card.

**Factory order detail** `/inventory/factory-orders/:id` · admin, manager (`FactoryOrderDetail.tsx:77-1218`)
- Sections: header with Edit mode (locked once lines have finished/received qty, :299, :487); metadata strip; component-orders card (:688); Line items table Ordered/Finished/Shipped/Unit cost/Line value with "Set progress" mode (:812-824); Linked Freight Shipments cards to `/freight/:id` (:1171).

**Materials** `/inventory/materials` · admin, manager (`MaterialsList.tsx:64-880`)
- Sections: Cycle Count and Add Material (:238); below-reorder alert (:255); unmatched ShipStation box-size alert (:285); search and category filter (local state, not URL; :330); Catalog table Code, Name, Category, On Hand, Unit, Unit Cost, $ On Hand, Reorder Pt, Days Runway (:375-391); cycle count mode with reason dialog (recount, spillage, damage, receiving, other; `rpc_bulk_material_cycle_count`); `MaterialFormDialog` (:702).
- Reads: `useMaterials`, `useAllRecipes`, `useInventory` (fillable raw+prefilled+WIP drive runway), `useUnmatchedShipstationBoxes`, `useMaterialUsageRates`.
- **Material detail** `/inventory/materials/:materialId`: 4 stat boxes On Hand, Current Runway, Pipeline Runway, Reorder Point (`MaterialDetail.tsx:128-158`); reorder helper (:160); glycerin barrels (:172); history table (:180).

**Quality Issues** `/inventory/quality-issues` · admin, manager in routing, doc says admin-only (`QualityIssues.tsx`)
- Sections: 3 cards (the third, "Total Open Value", shows a count), Breakage/Variances tabs, resolve dialog (notes required, write-off). No sidebar entry and no link anywhere in `src` (orphan route, `App.tsx:194`).

**Warehouse Overview** `/warehouse` · admin, manager (`WarehouseOverview.tsx`)
- Sections: 5 StatCards Outbound mode, Barcodes coverage, Orders per ship day, Days to ship, Shipped same day (:35-69); 14-day ship-day table (:79-106). Reads `rpc_wh_*` (settings, coverage, baseline KPIs). No stock content.
- **Map, Putaway, Counts, Locations** `/warehouse/{map,putaway,counts,locations}`: placeholder cards, "Arrives with Phase 1".

**SKU Costs list and SKU detail** `/economics`, `/economics/:skuId` · admin only (`SKUList.tsx`, `SKUDetail.tsx:88-1647`)
- Detail sections: inline-editable SKU, name, category, retail, master carton qty; cost rollup bar; Raw Cost per supplier (:1084); Importing (:1252); Manufacturing (:1270); Pack and Ship (:1363); ShipStation Aliases (:1397); Materials Used recipe (:1498). No stock quantities. Alias and recipe sections are gated `isAdmin || isManager` (:96) but the route is admin-only, so managers cannot reach them.
- In: SKU Costs list, PD card (`PdCardSheet.tsx:552,709`). Out: none to stock.

**Also relevant:** Settings > Change Log (admin only) is the only UI for the `inventory_transactions` ledger and ShipStation deduction rows (`ChangeLog.tsx`). Supplier portal `/supplier/*` has its own Factory Orders and Shipments views.

## 3. Overlap matrix

| Concept | Where it appears |
|---|---|
| Stock quantities | Stock Levels table and modal; Look up (Finished, On hand); Mfg Overview (totals); Dashboard value bar/chart; Materials runway inputs; daily email "Running low" |
| Lifecycle buckets (raw/prefilled/WIP/finished) | Mfg Overview (totals and bars); Stock Levels (edit mode, modal only); Workspace (moves them); Shipment receipt (credits them); Dashboard Manufacturing Completion. "Unfilled" differs: raw+WIP (`ManufacturingCompletionChart.tsx:13-14`) vs partial prefilled weight (`inventory-math.ts:100-107`) |
| Inbound cartons / receiving | Shipments banner and cartons callout; Shipment detail dock banner and steppers; daily email "receiving outstanding"; Warehouse Putaway stub; Floor "Put away" tile (disabled). Stock Levels shows inbound only as units |
| Factory orders | Factory Orders list/detail; Stock Levels On Order popover and Build order; Shipment manifest "From order" and New Shipment allocations; Dashboard value; Launch supply; PD card; supplier portal |
| Materials consumption | Materials list/detail; SKU Detail recipe; Stock Levels buckets feed runway; ShipStation box decrement |
| Forecasts and demand | Stock Levels Demand/mo and DOS; SKU modal picker (admin); Mfg Overview priority and launch boost; Dashboard alerts and chart; SKU Costs Monthly Demand; New Factory Order dialog; daily email |
| ShipStation deductions | No page. Change Log rows; SKU Detail aliases; Materials unmatched boxes; Dashboard pulse; Warehouse Overview baseline KPIs; modal "ShipStation actuals" |
| Cycle counts | Stock Levels Edit; Materials Cycle Count; Workspace breakage; Warehouse Counts stub; Floor "Count" tile (disabled) |
| SKU detail | Stock modal (stock, demand, projection, archive); SKU Detail page (cost, aliases, recipe); Look up match card; PD card link |
| "Location" | `locations` table (sites) is not read by any web page; `wh_locations` (bins) does not exist yet; UI copy says "across all locations" (`InventoryDashboard.tsx:869`) and "stacked by location" (`Dashboard.tsx:134`) meaning warehouse/transit/on-order stage |

## 4. Jobs supported today

| Job | Page today | Roles |
|---|---|---|
| Check stock for a SKU | Stock Levels; Look up (two numbers) | admin/manager; all |
| Identify a product by scan, link barcode | Look up | all; link admin/manager |
| See stock by bucket | Mfg Overview; modal | all; admin/manager |
| See what is arriving | Shipments; transit popover; Dashboard; daily email | admin/manager |
| Check in a shipment | Shipments card to Shipment detail | admin/manager |
| Create / close short a shipment | New shipment; Shipment detail | admin/manager |
| Create a factory order | Factory Orders; Stock Levels Build order | admin/manager |
| Track, edit, link factory orders | Factory Orders; detail | admin/manager |
| Adjust a SKU count | Stock Levels Edit | admin/manager |
| Adjust a material count | Materials | admin/manager |
| Log a manufacturing task or breakage | Workspace | all |
| Review materials runway, reorder | Materials; Material detail | admin/manager |
| Resolve breakage and variances | Quality Issues (hidden) | admin/manager |
| Pin demand source, archive SKU | Stock modal | admin |
| Edit costs, aliases, recipes | SKU Detail | admin |
| Review who changed what | Settings > Change Log | admin |
| Put away, count by bin, move, map | Phase 1 stubs | none yet |

## 5. Frictions a merge should fix

1. **Three count surfaces.** Stock Levels Edit (SKU bucket deltas, spreadsheet-wide, admin/manager), Materials Cycle Count, and the planned Warehouse Counts/Floor Count (bin balances). Different reason lists, no count history view, and floor staff cannot count at all today.
2. **Two notions of location, plus a third meaning.** `locations` (sites, e.g. Main Warehouse, NANCY-DOCK; unread by the UI) versus Phase 1 `wh_locations` (bins `FF-BB-L`). The design keeps one `inventory_levels` row per SKU (`docs/design/WAREHOUSE_MODULE_PHASE0_1.md` section 1) and adds by-location expansion to Stock Levels (section 9.1). Page copy already uses "location" for stage.
3. **Receiving is split across groups.** Shipments sits under Inventory; Putaway sits under Warehouse; the Floor "Put away" tile is disabled; check-in is admin/manager desktop-only. The check-in to putaway handoff will cross two groups.
4. **Materials is stranded.** It is a manufacturing input (recipes per SKU, runway from fillable buckets) but lives in Inventory, is closed to `user`, and recipes are editable only on the admin SKU page.
5. **Duplicated KPIs.** In Warehouse / In Transit / On Order appear on Stock Levels, the modal, and the Dashboard value bar and chart; Active Freight on Dashboard card, list and Shipments KPI; bucket totals on Mfg Overview versus Dashboard completion bar with different "unfilled" rules.
6. **No SKU hub.** Stock modal, admin-only cost page and Look up each show a slice. Alerts land on unfiltered `/inventory` although `?q=` exists. The modal links to nothing.
7. **Ledger and ShipStation invisible.** Per-SKU history is only the projection chart; the ledger is an admin Settings tab; ShipStation deductions have no surface, so "why did this number change" has no manager answer.
8. **Naming drift.** Stock Levels vs "Inventory"; Shipments vs "Freight Tracking"; "Overview" in three groups; Floor vs Workspace vs "Manufacture"; Beaker icon used for Materials and Product Development.
9. **Highlight loss.** `END_ROUTES` leaves Shipments unlit on shipment detail and new (section 1).
10. **Orphans and bugs.** Quality Issues has no entry point. `src/components/marketing/sale/ProductsTable.tsx:96` links `/economics/skus/:id`, which matches no route and falls through to the role landing. Stock Levels edit omits the `other` bucket input. "Total Open Value" shows a count.
11. **Role asymmetry.** `user` sees aggregate stock (Mfg Overview) and Look up, but not incoming freight, factory orders or shipments, and cannot receive.
12. **Page weight.** `InventoryDashboard.tsx` (1,504 lines) mixes four modes; its table is `min-w-[900px]`, poor on phones.

## 6. Facts that constrain the merge

- **Email links.** The 8 AM ET daily report (to all active admins) links `${SITE_URL}/inventory` (`supabase/functions/daily-report/index.ts:327`; default `https://freezepipeinventory.com`, :25). Its sections are Incoming, Receiving outstanding, Running low. `invite-user` redirects to `/auth/accept-invite` (:194), which has no route. No migration or doc embeds ERP URLs.
- **Deep links in `src` to keep or redirect.** `/inventory` (AlertsPanel x4); `/freight`, `/freight?filter=high_risk` (`Dashboard.tsx:65,73`); `/freight/:id` (`AlertsPanel.tsx:162`, `launch-supply.ts:831`, `FactoryOrderDetail.tsx:1183`); `/freight/new`; `/inventory/factory-orders/:id` (`launch-supply.ts:832`, `PdCardSheet.tsx:715`, `ShipmentManifest.tsx:261`); `/economics/:skuId` (`PdCardSheet.tsx:552,709`); `/inventory/materials[/:id]`; `/manufacturing/workspace` and `/manufacturing/performance`; `/go/lookup?scan=`. Unit tests pin `launch-supply.ts` hrefs (`launch-supply.test.ts:267,297`) and landing paths (`landing.test.ts`).
- **PWA and hosting.** `public/manifest.webmanifest` sets `start_url` `/go`, scope `/`; `vercel.json` rewrites every path to `index.html`, so any bookmarked route must keep resolving; Permissions-Policy blocks camera.
- **URL filters** (`src/lib/use-url-filter.ts`: defaults omitted, `replace: true`). Stock Levels: `q`, `category`, `abc`, `archived`. Shipments and Factory Orders both use `filter`, with different value sets (`all|sea|air|high_risk` vs `all|NANCY|YX|in_production|finished|shipped`), which would collide on a combined page. Performance: `range|from|to`; Look up: `scan`; PD: `card`. Materials, SKU Costs and Quality Issues keep filters in local state.
- **localStorage keys.** `sidebar.collapsedGroups` (keyed by group label, so renaming a group resets it; `Sidebar.tsx:135`), `freeze-pipe-dos-target`, `fp-erp-order-cart`.
- **Roles.** Inventory, Freight, Warehouse: admin, manager. Manufacturing and `/go`: plus `user`. Economics and Settings: admin. Supplier: `/supplier/*` only. Receipts, cycle counts and resolutions are also enforced in the RPCs. `RequireRole` sends refused users to `landingPathFor` (`landing.ts:4-7`, `RequireRole.tsx:35`).
- **`user` landing is `/go`**, not `/manufacturing/workspace`; `CLAUDE.md` and the Phase 0/1 design doc still say workspace. CLAUDE.md also lists a Workspace persistence TODO that is already wired (`Workspace.tsx:81`).
- **Planned changes to these pages** (design doc sections 7, 8, 9.1): Shipment detail gains LPN, label and putaway stages; Stock Levels rows expand by location; SKU detail gains a Locations tab; Counts and Putaway get count/approval badges; `/go/putaway`, `/go/count`, `/go/move` join the floor shell.
- **Error boundary** is keyed by pathname (`Layout.tsx:34`): route changes reset page state, so a merged page with modes must keep mode in the URL.

## Sources

`src/components/layout/Sidebar.tsx`, `Layout.tsx`, `Header.tsx`; `src/App.tsx`; `src/lib/landing.ts`, `use-url-filter.ts`, `auth-context.tsx`, `inventory-aggregates.ts`, `inventory-math.ts`; `src/components/shared/RequireRole.tsx`, `StatCard.tsx`; `src/pages/Dashboard.tsx`; `src/pages/inventory/*` (InventoryDashboard, FactoryOrders, FactoryOrderDetail, MaterialsList, materials/MaterialDetail, QualityIssues); `src/pages/freight/*`; `src/pages/manufacturing/*`; `src/pages/warehouse/*`; `src/pages/floor/*`; `src/pages/economics/SKUDetail.tsx`, `SKUList.tsx`; `src/pages/settings/Settings.tsx`, `ChangeLog.tsx`; `src/components/inventory`, `freight`, `manufacturing`, `warehouse`, `dashboard`; `src/components/marketing/pd/PdCardSheet.tsx`, `sale/ProductsTable.tsx`; `src/lib/marketing/launch-supply.ts` and test; `src/lib/hooks/use-inventory.ts`, `use-freight.ts`, `use-warehouse.ts`, `use-task-logs.ts`, `use-materials.ts`, `use-shipstation-aliases.ts`; `supabase/functions/daily-report/index.ts`, `invite-user/index.ts`; `supabase/migrations/20260506000002_warehouse_prefilled_raw_bucket.sql`; `public/manifest.webmanifest`; `vercel.json`; `docs/design/WAREHOUSE_MODULE_PHASE0_1.md`; `docs/research/reports/Warehouse module UX layout.md`.
