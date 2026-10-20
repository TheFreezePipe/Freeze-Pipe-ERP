# Desktop (web) information architecture of small/mid-size WMS products, as of Oct 2026

**Method note (read first).** All facts below come from vendor help-center / documentation text fetched via WebFetch/WebSearch (page text was summarised by a small model, so wording may be paraphrased). **No live UI was observed**: the Odoo demo (demo.odoo.com) was blocked by the browser tool ("navigation denied or failed"), and no trial UIs were accessible. So "Cited Findings" = vendor documentation statements, not first-hand screen observation. Items under "Inferences" are mine. Coverage is uneven: Odoo, Logiwa, ShipHero (reports/PO), Cin7, Extensiv, SKUSavvy (counts) have decent detail; Veeqo, Packiyo, Zenventory, inFlow, Hopstack, Deposco, Infoplus, Peoplevox, Sortly, NetBox are thin; Easy WMS was not researched.

---

## KQ1. Per-product navigation, dashboards, locations, containers, waves, counts, replenishment

### Takeaway
Mature products (Odoo, Logiwa, Extensiv) split into "operations/work" (receipts, jobs/waves, transfers), "inventory views" (by location, by SKU), "configuration" (locations, putaway/wave rules) and "reports". Small e-commerce tools (Veeqo, ShipHero) expose far less location management in the web UI: locations are mostly an attribute of a SKU, with a CSV workflow and a report-style grid.

### Cited Findings

**Odoo (v18 docs)**
- Operations menu lists: Receipts, Deliveries, Internal Transfers, Manufacturings, Batch Transfers, Dropships. — [Odoo batch docs](https://www.odoo.com/documentation/18.0/applications/inventory_and_mrp/inventory/shipping_receiving/picking_methods/batch.html)
- Docs structure of the Inventory app: Product management; Warehouses and storage (Inventory management: Warehouses, Locations, Operation types, Inventory adjustments, Cycle counts, Scrap, Reception report; Replenishment: Reordering rules, Replenishment report; Reporting: Forecasted, Stock, Locations dashboard, Moves history, Stock valuation); Shipping and receiving (Routes, 1/2/3-step flows, Putaway rules, Storage categories, Cross-dock, Picking methods Batch/Cluster/Wave, Removal strategies FIFO/LIFO/FEFO/Closest/Least packages). — [Odoo Inventory docs](https://www.odoo.com/documentation/18.0/applications/inventory_and_mrp/inventory.html)
- Overview dashboard = kanban cards per operation type; each card summarises outstanding work with counts of late / waiting / backorders and a three-dot menu with filters (All/Ready/Waiting) and settings; "Prepare Batch" is on the card menu. The late/waiting/backorder detail is from an Odoo 14 walkthrough and is NOT confirmed for 18 (official Odoo 18 docs fetched did not describe the Overview page). — [Cybrosys Odoo 14 overview](https://www.cybrosys.com/blog/odoo-14-inventory-an-overview), [Cybrosys op types O18](https://cybrosys.com/blog/what-are-the-different-operation-types-in-odoo-18-inventory), [Odoo batch docs](https://www.odoo.com/documentation/18.0/applications/inventory_and_mrp/inventory/shipping_receiving/picking_methods/batch.html)
- Locations are under Inventory > Configuration > Locations; nested by "Parent Location" (e.g. WH/Stock/Zone A/Refrigerator 1). Form fields: Location Type, Storage Category, Company, Is a Scrap Location, Is a Dock Location, Barcode, Replenish Location; "Cyclic Counting" section (Inventory Frequency in days, Last Inventory, Next Expected); Logistics section (removal strategy). Smart buttons: Current Stock, Products, Putaway Rules. List columns are not described in the docs. — [Odoo locations docs](https://www.odoo.com/documentation/18.0/applications/inventory_and_mrp/inventory/warehouses_storage/inventory_management/use_locations.html)
- Reporting > Locations is a stock-by-location grid, one row per product per location: Product, Location, Package, Lot/Serial Number, On Hand, Reserved, Unit; filters Internal Locations / Expiration Alerts / Conflicts; Group By; row actions edit qty, History, Replenishment; header "New" (adjustment) and "Inventory At Date". Reporting menu is admin-only. Empty locations are not on this report; they are in Configuration > Locations via an "Empty Locations" filter. — [Odoo locations report](https://www.odoo.com/documentation/18.0/applications/inventory_and_mrp/inventory/warehouses_storage/reporting/locations.html)
- Storage Categories (Configuration > Storage Categories): Max Weight, "Allow New Product" (empty only / same product / mixed), Capacity by Product tab, Capacity by Package tab, Locations smart button. Odoo does not split a receipt across locations; if the first suggested location is over capacity, everything still goes there. — [Odoo storage categories](https://www.odoo.com/documentation/18.0/applications/inventory_and_mrp/inventory/shipping_receiving/daily_operations/storage_category.html)
- Putaway Rules (Configuration > Putaway Rules, requires Multi-Step Routes): fields Product/Product Category, Package type, "When product arrives in location", "Store to", Sublocation (No / Last Used / Closest Location), Having Category. Priority: package+product > package+category > package > product > category. — [Odoo putaway docs](https://www.odoo.com/documentation/18.0/applications/inventory_and_mrp/inventory/shipping_receiving/daily_operations/putaway.html)
- Batch transfers (Operations > Batch Transfers): fields Responsible, Operation Type, Scheduled Date; tabs "Detailed Operations" and "Operations" (Demand / Reserved / Done); auto-batching is set on the operation type via Batch Grouping criteria (Contact, Carrier, Destination Country, Source Location, Destination Location); manual add via list Actions > "Add to batch" or card menu > Prepare Batch; backorder pop-up when Done < Reserved. Wave/cluster only listed as a settings label ("Batch, Wave & Cluster Transfers"). — [Odoo batch docs](https://www.odoo.com/documentation/18.0/applications/inventory_and_mrp/inventory/shipping_receiving/picking_methods/batch.html)
- Replenishment (Operations > Replenishment): list columns Product, Location, Min, Max, Multiple Quantity (optional: Trigger, Preferred route, Vendor, BoM, Procurement group, Visibility days); Trigger Auto vs Manual; "To Reorder" filter; "Order" button; rules also reachable from a "Reordering Rules" smart button on the product form. — [Odoo reordering rules](https://www.odoo.com/documentation/18.0/applications/inventory_and_mrp/inventory/warehouses_storage/replenishment/reordering_rules.html)
- Cycle counts: Operations > Physical Inventory (Inventory Adjustments list; group by Location); per-location Inventory Frequency; annual inventory day/month under Settings. — [Odoo cycle counts](https://www.odoo.com/documentation/18.0/applications/inventory_and_mrp/inventory/warehouses_storage/inventory_management/cycle_counts.html)

**Logiwa IO** (help center; no left-nav listing found)
- Help collections reveal functional areas: Dashboard; Inbound/Receiving (POs, receive, mobile receiving, "Suggest Putaway Location When Receiving"); Putaway and Transfers (putaway algorithms with conditions/actions/priority/testing; Inventory by Location transfers; license plates; limits such as max SKU count per location, volume-based and sequential LP putaway); Picking (Location Barcodes); Waves and Jobs (Wave Rules, Job Types, Job Management, Wave Log Report, AI Jobs, Putwall sorting, precartonization); Inventory Count (Count Plans, recount, Instant Count, analyze results); Returns (Return Management - Reporting); Analytics (Labor Analytics, Operational Analytics). — [Logiwa Process Manuals](https://intercom.help/mylogiwa/en/collections/1917589-process-manuals)
- Dashboard: Filters (Warehouse, Client via "Add Filter") plus widgets: Progress for Today (tasks, order lines packed, orders to ship, with counts and %; shift progress when one warehouse is selected), Unfulfilled Orders, Order Breakdown by Status (Open, Ready to Pick, Picking Started, Ready to Pack, Packing Started, Ready to Ship, Cancelled, Shortage, On Hold, Already Shipped Today, To be Shipped Today / Tomorrow), Channel Orders, Client Orders, Carrier Orders, Orders by Country, Jobs (tabs Priority / Status / Types). Channel widget clicks through to the Shipment Order page. — [Logiwa Dashboard Guide](https://intercom.help/mylogiwa/en/articles/8411623-logiwa-dashboard-guide)
- Wave Rules wizard (Create New on the Wave Rules page): 1 Setup (operation type Picking / Cycle Count / Replenishment; rule set name; warehouse; priority; delete method for unstarted jobs "same day / next day / 2 days later"; one or more Job Types, drag to reorder) > 2 Selection (order criteria such as Order Type, Priority + Order By fields e.g. expected shipment date, carrier rate) > 3 Schedule (specific times or a period, e.g. every 30 min = 48 runs/day; follows user time zone) > 4 Assign (job pool, user roles, or a specific user) > 5 Finish; a "Run" button executes a rule manually. — [Logiwa wave rule](https://intercom.help/mylogiwa/en/articles/7002741-create-a-wave-rule-for-picking)
- Job Management grid columns: Warehouse, Wave No, Rule Name, Job Code, Job Type, AI Job Description, Status, Priority, Operation Type, Assignee, Created By, Order Count, Product Count, Number of Tasks/Locations/SKUs, Pending/Completed Tasks, Pending Picking/Packing Tasks, planned and actual start/end, Mobile Cart, Picking Zone, Label Status, Pick List Status. Statuses Pending / In Progress / Completed / Canceled (completed and canceled shown only for 15 days). Actions: Cancel Job (bulk up to 100; releases allocations), Assign/Unassign (described one job at a time via a drawer; an assigned job leaves the mobile job pool), Print Packing List (supervisors, one or many). Docs do not describe filters or a prioritize action. — [Logiwa Job Management](https://intercom.help/mylogiwa/en/articles/9680217-job-management)
- Count Plans: "Create New Count" popup (Name, Warehouse, Description, Scheduled Count Date, Lock Locations), then Next > choose Location or SKU tasks (cannot mix) > Add > Save; then "Create Job" manually or recurring via Cycle Count Wave Rule; bulk import from Excel. Locations holding picked/packed/sorted/loaded stock get Cancelled tasks. — [Logiwa count plan](https://intercom.help/mylogiwa/en/articles/7033435-create-a-count-plan)
- Count results (Count Plan Details, tabs Location Details / SKU Details): columns Initial Stock Qty, Counted Qty, Approved Stock Qty, Approved Count Qty, Difference (%), Counted Location/Product progress, Recounted Location, Recount Line. Approving and completing triggers the adjustment; a recount creates a second line for the same location; Transaction History report (Transaction Type = Count) shows approving supervisor. — [Logiwa cycle count results](https://intercom.help/mylogiwa/en/articles/11769774-analyzing-cycle-count-results)
- Inventory by Location screen has "Transfer Product" and "Transfer Location/LP" actions; LP detail shows LP Type, Parent LP, Location, LP Quantity, Pack Type/Quantity, SKU, SKU Quantity (LPs nest via Parent LP). — [Logiwa transfer from inventory by location](https://intercom.help/mylogiwa/en/articles/9833109-transfer-from-inventory-by-location)

**ShipHero**
- Reports help section includes Item Locations, Replenishment, Inventory Change Log, Rejected Line Items, recurring data exports. — [ShipHero Reports section](https://software-help.shiphero.com/hc/en-us/articles/4419303977357)
- Item Locations report: one row per SKU per location (with LPNs enabled, loose units vs units in LPN are separated); filters Warehouse, Location Status (PICKABLE, UNPICKABLE, SELLABLE, UNSELLABLE, STOCKED, EMPTY), Item Status, Lot Expiration, Store Integration, Location Search, Hospital Status; "Columns" menu (Item, Warehouse, Location, Type, Total Units, Active Item, Pickable, Sellable, Creation Date, Client, Loose Units / Units in LPN, lot columns); Export "All Rows to CSV" or "Visible Rows to CSV"; separate how-tos for adjusting inventory, deleting item-locations and clearing the "Hospital" flag in bulk. Some columns require support to enable. — [ShipHero Item Locations report](https://software-help.shiphero.com/hc/en-us/articles/44544064232973-Overview-Item-Locations-Report)
- Replenishment report (Reports > Replenishment): columns SKU, On Hand, Allocated, Replenishment Level, Available in Pickable Bins, Qty from Non-Pickable Bins, Items to Replenish, Top 3 Non-Pickable Bins; filters Location Prefix, Allocation, Order Details, Order Tags, Order Status, Sort by; filters are saved in the URL; Min/Max apply only to pickable locations; output is CSV export (no task creation described). — [ShipHero Replenishment report](https://software-help.shiphero.com/hc/en-us/articles/44079877217933-Overview-Replenishment-Report)
- Locations list (Inventory > Locations, per a search-result summary of a ShipHero help article): filter/search, then "Export for Location Update" CSV with editable Name, Pickable, Priority, Type, Sellable. No label-printing option found. API gained name/pickable/sellable filters for the locations query. — [ShipHero help search summary](https://software-help.shiphero.com/hc/en-us/articles/4419303977357); [ShipHero changelog](https://changelog.shiphero.com/changelog/new-filters-for-locations-query)
- Purchase Orders menu has six sub-tabs: All Purchase Orders, Line Items, Rejected Line Items, Change Log, Statuses (custom PO statuses), Vendors; most grids have Column Visibility + CSV/PDF export. A newer help article places it under left menu "Receiving > Purchase Orders" (menu layout has changed over time). — [Fulfillment Hub USA ShipHero PO guide](https://knowledgebase.fulfillmenthubusa.com/fulfillment-hub-usa-guide-to-the-shiphero-web-dashboard-purchase-orders-menu); [ShipHero receiving POs](https://software-help.shiphero.com/hc/en-us/articles/4419362287885-Receiving-Purchase-Orders)
- Picking is configured per warehouse by admins/warehouse managers; only inventory in pickable locations can enter batches; default pick order sends pickers to the location with the least stock unless numeric location "priority" overrides (lower = first); mobile batch types Single Item Batch / Multi-Item Batch / Single Order; Location-Aware Picking is an add-on configured by ShipHero staff. (From search-result summaries; individual article text was not read.) — [ShipHero help section](https://software-help.shiphero.com/hc/en-us/articles/46894595615373)

**Veeqo**
- Bin locations are attached to products (product page or CSV with sku_code + location columns, per warehouse); picking and stock-take lists sort by bin in alphanumeric order (use leading zeros); bin shown on the inventory page (flagged as new). No dedicated location management page described. — [Veeqo bin location overview](https://help.veeqo.com/en/articles/6096735-bin-location-overview)
- Digital picking: modes Single Tote (pick-to-pile), Pick to Order, Most Efficient (pile if >50% of batch is single-line orders); default batch 10 orders / max 20 items; ad-hoc batch from the Orders page via Actions > Pick (ignores batch limit); priority queues built from drag-and-drop Order Tags with a lowest "Other Orders" queue; tags auto-applied via Settings > Rules; no direct picker assignment (docs suggest per-picker order views using "picked by" status); tote barcodes needed. — [Veeqo digital picking overview](https://help.veeqo.com/en/articles/8306650-digital-picking-overview)
- Reporting is marketed as picker performance/bottlenecks, inventory, stock movement; specific report screen names not found. — [Veeqo picking page](https://www.veeqo.com/gb/picking-and-packing-software)

**Packiyo**
- Product Locations section sits on the product page (Left Menu > Inventory > Products > product > scroll to Product Locations); location types define behaviour categories (picking path, overstock) and a "pickable" setting. (Via search summary; direct fetch of the article returned 404.) — [Packiyo product locations](https://help.packiyo.com/en/articles/6983778-managing-product-locations)

**Extensiv 3PL Warehouse Manager**
- Admin Console top bar has six items: Home, Warehouse (Bins, Warehouses, Companies, Cycle Counting, Replenishments), Inventory (parts/inventory sortable by lot, company or bin), Orders (Shipping Orders, Receiving Orders, Print Jobs, Wave Picking, Work Orders, Cross-dock Orders), Contacts, Reports (links to classic reports); the left nav shows children of the selected top item. — [Extensiv navigating menus](https://extensiv.helpjuice.com/1618963-navigating-menus)

**Cin7 Core WMS**
- Locations & Bins live in Settings > Reference Books > Stock > Locations & Bins; the Bins tab holds directed-putaway rules (when enabled for the location); Pick Zones tab (Advanced add-on) with zones assigned at product level (bulk via CSV round-trip); guided walk path with alphanumeric bin order; used bins are "Deprecated", not deleted; Standard plan = one warehouse location. — [Cin7 Locations (search summary)](https://help.core.cin7.com/hc/en-us/articles/9034487246735-Locations); [Cin7 Pick Zones](https://help.core.cin7.com/hc/en-us/articles/9034505649679-Pick-Zones); [Cin7 Bins](https://help.core.cin7.com/hc/en-us/articles/11321150323727-Bins)

**SKUSavvy**
- Cycle counts live under a warehouse > Inventory > Cycle Counts (feature enabled per warehouse); create manually (choose bins), automatically (N bins by product/last-counted), or by criteria (include/exclude SKUs, product type, tags); assign employees; optional blind count (hide expected qty) and bin/item scan requirements; unexpected items flagged; count screen shows bin on warehouse layout (optional 3D path); completion lists discrepancies and the counter confirms, adjustments are written immediately (no separate manager approval step described); completed counts create "Cycle Counted" warehouse-log entries. Marketing claims: visual warehouse map with draggable bins, Activity Dashboard. — [SKUSavvy cycle counting](https://skusavvy.com/docs/guides/warehouse/cycle-counting); [SKUSavvy platform](https://www.skusavvy.com/platform)

**inFlow**
- Locations and sublocations (sublocations tier-gated), stock transfers, physical counts, reorder control per product per location; web app plus "Stockroom" companion scanning app; mobile guided picking shows ordered items and their location. — [inFlow features](https://www.inflowinventory.com/features/all-features)

**Sortly**
- Location structure is nested folders, up to six levels including top-level "All Items"; folder name is the only required field. — [Sortly folders](https://help.sortly.com/how-to-add-folders)

**NetBox (analogue)**
- Data model: Region/Site Group > Site > Location (nestable) > Rack, plus flat Rack Groups as a second grouping axis (row/aisle); every rack belongs to a site, assignment to a location is optional. Sidebar/tree UI not verified. — [NetBox facilities docs](https://netboxlabs.com/docs/netbox/en/stable/features/facilities/)

**Hopstack / Deposco / Infoplus / Peoplevox / Zenventory**
- Only marketing or third-party review text found. Hopstack: guided putaway, order/batch/wave picking, automated ABC analysis. Peoplevox: wave templates can require admin expertise. Deposco: UI described as dense by some reviewers. Infoplus: "intuitive" UI, standard dashboards. — [Hopstack](https://hopstack.io/feature/warehouse-management); [rfp.wiki Deposco](https://www.rfp.wiki/supply-chain-logistics-transportation/warehouse-management-systems/deposco); [rfp.wiki Infoplus vs Deposco](https://www.rfp.wiki/supply-chain-logistics-transportation/warehouse-management-systems/infoplus/deposco); [rfp.wiki Peoplevox](https://www.rfp.wiki/vendors/descartes-peoplevox/infios-krber) (low confidence, review aggregators)

### Inferences
- The "work unit" differs: Odoo = operation-type cards that open filtered lists; Logiwa = a jobs grid generated by wave rules; Veeqo/ShipHero = queues/batches that are mostly created from the Orders page plus mobile execution. A "Pick Batches" screen in our ERP is best a status-filtered grid of batches with a "Create batch" dialog, not a drag-and-drop kanban.
- Location master is "Configuration"-flavoured in Odoo/Cin7, "Warehouse" top-level in Extensiv; day-to-day manager use is the by-location inventory grid, not the master list.

### Gaps
- No first-hand UI observation (Odoo demo blocked; no trial accounts). Visual layout (card arrangement, tab positions) is unverified.
- ShipHero Locations page columns/bulk actions/label printing, ShipHero picking web board, any pack-station web screen (ShipHero Packing / Veeqo), Veeqo report names, Packiyo dashboard/orders/picking/packing/reports, Zenventory, Easy WMS, Infoplus, Deposco, Hopstack, Peoplevox, Sortly beyond folders: not found in accessible docs.
- Location label printing: only an Oracle WMS doc title was seen ([Oracle: Print Labels for Locations Filtered in Locations UI](https://docs.oracle.com/en/cloud/saas/warehouse-management/24b/owmol/print-labels-for-locations-filtered-in-locations-ui.html), different class of product, text not read). No small/mid-size WMS label printing UI confirmed.
- Returns screens and picker productivity / accuracy / aging report pages: only Logiwa article titles (Return Management - Reporting, Labor Analytics, Operational Analytics, Wave Log Report) found; contents not read.
- Role-based manager vs floor views: not documented explicitly beyond Logiwa job-pool by user role and ShipHero "admins or warehouse managers" configuring picking. A third-party review-site claim that Descartes acquired Extensiv (Sept 2026) was seen once and is unverified.

---

## KQ2. The 8-12 screens every system has (consensus)

### Takeaway
Across Odoo, Logiwa, Extensiv, ShipHero and Cin7 a common set of roughly 10 desktop screens emerges. Floor execution (receive, pick, count, putaway) is mostly mobile/scanner; desktop is for planning, monitoring, review and configuration.

### Cited Findings
- Dashboard / overview: Odoo operation-type cards, Logiwa widgets. — [Logiwa dashboard](https://intercom.help/mylogiwa/en/articles/8411623-logiwa-dashboard-guide); [Cybrosys](https://www.cybrosys.com/blog/odoo-14-inventory-an-overview)
- Receiving / purchase orders with line status and rejected lines: ShipHero PO sub-tabs, Logiwa Inbound, Extensiv Receiving Orders. — [ShipHero PO guide](https://knowledgebase.fulfillmenthubusa.com/fulfillment-hub-usa-guide-to-the-shiphero-web-dashboard-purchase-orders-menu); [Logiwa manuals](https://intercom.help/mylogiwa/en/collections/1917589-process-manuals); [Extensiv](https://extensiv.helpjuice.com/1618963-navigating-menus)
- Inventory by location grid: ShipHero Item Locations, Odoo Locations report, Logiwa Inventory by Location. — [ShipHero](https://software-help.shiphero.com/hc/en-us/articles/44544064232973-Overview-Item-Locations-Report); [Odoo](https://www.odoo.com/documentation/18.0/applications/inventory_and_mrp/inventory/warehouses_storage/reporting/locations.html); [Logiwa](https://intercom.help/mylogiwa/en/articles/9833109-transfer-from-inventory-by-location)
- Locations master/config: Odoo Configuration > Locations, Cin7 Locations & Bins, Extensiv Warehouse > Bins, ShipHero export-edit-import. — see KQ1
- Putaway rules/algorithms: Odoo, Logiwa, Cin7 directed putaway. — see KQ1
- Orders-to-work (waves/batches/jobs): Odoo Batch Transfers, Logiwa Jobs/Wave Rules, Extensiv Wave Picking, Veeqo queues. — see KQ1
- Cycle count plans + variance review: Odoo Physical Inventory, Logiwa Count Plans, SKUSavvy, Extensiv Cycle Counting. — see KQ1
- Replenishment: Odoo Replenishment, ShipHero Replenishment report, Extensiv Replenishments. — see KQ1
- Movement / audit log: ShipHero Inventory Change Log, Odoo Moves History, Logiwa Transaction History. — [ShipHero reports](https://software-help.shiphero.com/hc/en-us/articles/4419303977357); [Odoo docs](https://www.odoo.com/documentation/18.0/applications/inventory_and_mrp/inventory.html); [Logiwa](https://intercom.help/mylogiwa/en/articles/11769774-analyzing-cycle-count-results)
- Reports/analytics incl. labor: Logiwa Labor/Operational Analytics, Veeqo picker productivity. — [Logiwa manuals](https://intercom.help/mylogiwa/en/collections/1917589-process-manuals); [Veeqo](https://www.veeqo.com/gb/picking-and-packing-software)
- Returns: Logiwa Return Management, ShipHero Returns tab. — [Logiwa manuals](https://intercom.help/mylogiwa/en/collections/1917589-process-manuals)

### Inferences
Proposed set (12): (1) Warehouse Overview, (2) Receiving (inbound shipments/POs), (3) Putaway queue, (4) Inventory by Location, (5) Locations (tree+table with detail), (6) Containers/LPNs, (7) Pick Batches/Waves, (8) Pack/Ship queue, (9) Cycle Counts, (10) Replenishment & Slotting, (11) Movement Log, (12) Reports; plus Warehouse Settings (zones, location types, putaway rules, batch rules).

### Gaps
Pack-station web screens are not documented in accessible sources; most vendors appear to treat packing as scanner/mobile or a separate station app.

---

## KQ3. Linking patterns (SKU bin list, inventory by location, freight -> putaway, order -> pick status)

### Takeaway
Vendors link both ways: the SKU page shows its locations (Packiyo "Product Locations", Odoo smart buttons, Veeqo bin on inventory), and location/report rows link back to SKU, history and replenishment.

### Cited Findings
- Packiyo: location list lives on the product page in a Product Locations section. — [Packiyo](https://help.packiyo.com/en/articles/6983778-managing-product-locations)
- Odoo: location form smart buttons (Current Stock, Products, Putaway Rules); product-form smart button for Reordering Rules; Locations-report rows have History and Replenishment actions. — [Odoo locations](https://www.odoo.com/documentation/18.0/applications/inventory_and_mrp/inventory/warehouses_storage/inventory_management/use_locations.html); [Odoo reordering](https://www.odoo.com/documentation/18.0/applications/inventory_and_mrp/inventory/warehouses_storage/replenishment/reordering_rules.html); [Odoo locations report](https://www.odoo.com/documentation/18.0/applications/inventory_and_mrp/inventory/warehouses_storage/reporting/locations.html)
- ShipHero Replenishment: SKU cell opens the product details page; filters live in the URL. — [ShipHero Replenishment](https://software-help.shiphero.com/hc/en-us/articles/44079877217933-Overview-Replenishment-Report)
- Logiwa: dashboard widgets drill to Shipment Order lists; job grid carries Wave No, Rule Name, Order Count (order <-> job linkage); order status ladder Ready to Pick > Picking Started > Ready to Pack > Packing Started > Ready to Ship. — [Logiwa dashboard](https://intercom.help/mylogiwa/en/articles/8411623-logiwa-dashboard-guide); [Logiwa jobs](https://intercom.help/mylogiwa/en/articles/9680217-job-management)
- Inbound: Logiwa "Suggest Putaway Location When Receiving" and putaway algorithms; ShipHero PO "Rejected Line Items" created during receiving; Odoo receipts feed putaway rules ("When product arrives in location" -> "Store to"). — [Logiwa manuals](https://intercom.help/mylogiwa/en/collections/1917589-process-manuals); [ShipHero PO guide](https://knowledgebase.fulfillmenthubusa.com/fulfillment-hub-usa-guide-to-the-shiphero-web-dashboard-purchase-orders-menu); [Odoo putaway](https://www.odoo.com/documentation/18.0/applications/inventory_and_mrp/inventory/shipping_receiving/daily_operations/putaway.html)
- Veeqo: ad-hoc batches launched from the Orders page (Actions > Pick); per-picker saved order views filtered by "picked by". — [Veeqo](https://help.veeqo.com/en/articles/8306650-digital-picking-overview)

### Inferences
For the ERP: SKU detail gets a "Locations" tab (bin, container, on hand/allocated, pickable flag, min/max) linking to a location drawer; Inventory page gets a "By SKU / By location" toggle; Freight shipment detail gets a "Receiving & putaway" tab/status chip generating putaway tasks per received line; Order detail gets a pick-status chip with batch link; every grid deep-links with URL-persisted filters (ShipHero pattern).

### Gaps
No vendor doc found explicitly showing an "order detail pick-status panel" layout; no vendor freight-shipment-to-putaway-task document (ERP-specific design decision).

---

## KQ4. Dashboard KPI card sets for small operations

### Takeaway
Small-ops dashboards are work-queue counts by status plus "today's progress", not financial KPIs. Logiwa's set is the best documented.

### Cited Findings
- Logiwa: Progress for Today (tasks, order lines packed, orders to ship, % complete), Unfulfilled Orders, Order Breakdown by Status, orders by channel/client/carrier/country, Jobs by priority/status/type. — [Logiwa dashboard](https://intercom.help/mylogiwa/en/articles/8411623-logiwa-dashboard-guide)
- Odoo: per-operation-type cards with to-process, late, waiting, backorder counts (Odoo 14 detail). — [Cybrosys](https://www.cybrosys.com/blog/odoo-14-inventory-an-overview)
- SKUSavvy marketing lists an Activity Dashboard, employee productivity metrics, dead-stock detection. — [SKUSavvy platform](https://www.skusavvy.com/platform)
- Veeqo marketing: picker productivity and bottleneck reports. — [Veeqo](https://www.veeqo.com/gb/picking-and-packing-software)

### Inferences
Suggested card set: Orders ready to pick / picking in progress / ready to pack / ready to ship / shortage-or-hold; late orders (ship-by before today); inbound expected today and received-awaiting-putaway; replenishment needed (SKUs below min with bulk stock available); open count tasks and variances awaiting approval; location health (empty, over capacity, stock in unassigned/receiving location); today's progress (lines picked/packed vs plan); pick accuracy and lines/hour once data is captured.

### Gaps
Industry-standard KPI definitions and benchmarks (accuracy %, dock-to-stock time, lines/hour) were not sourced.

---

## KQ5. Notable good and bad UX choices

### Takeaway
Good: URL-persisted filters, column pickers, status-ladder drill-downs, wizard-style rule builders with manual Run, lock-locations option and approved-vs-counted quantities. Bad: bulk actions missing or one-at-a-time, report-only replenishment, feature-flagged columns, naming-dependent pick order, menu churn.

### Cited Findings
- Good: ShipHero saves report filters in the URL and offers both All-rows and Visible-rows export. — [ShipHero Replenishment](https://software-help.shiphero.com/hc/en-us/articles/44079877217933-Overview-Replenishment-Report); [Item Locations](https://software-help.shiphero.com/hc/en-us/articles/44544064232973-Overview-Item-Locations-Report)
- Good: Logiwa wave-rule wizard (Setup > Selection > Schedule > Assign) with manual Run; putaway algorithm has Test / Test-a-Rule / Prioritize articles. — [Logiwa wave rule](https://intercom.help/mylogiwa/en/articles/7002741-create-a-wave-rule-for-picking); [Logiwa manuals](https://intercom.help/mylogiwa/en/collections/1917589-process-manuals)
- Good: Logiwa count plan "Lock Locations" option, and results showing initial vs counted vs approved quantities (accounts for movements during the count). — [Logiwa count plan](https://intercom.help/mylogiwa/en/articles/7033435-create-a-count-plan); [results](https://intercom.help/mylogiwa/en/articles/11769774-analyzing-cycle-count-results)
- Good: Odoo separates capacity rules (Storage Categories) from locations, and puts cycle-count schedule fields on the location form. — [Odoo storage categories](https://www.odoo.com/documentation/18.0/applications/inventory_and_mrp/inventory/shipping_receiving/daily_operations/storage_category.html); [Odoo locations](https://www.odoo.com/documentation/18.0/applications/inventory_and_mrp/inventory/warehouses_storage/inventory_management/use_locations.html)
- Bad: Logiwa assignment described one job at a time; completed/canceled jobs disappear after 15 days. — [Logiwa jobs](https://intercom.help/mylogiwa/en/articles/9680217-job-management)
- Bad: Veeqo lacks direct batch assignment (workaround: per-picker order views); pick order depends on bin-name leading zeros. — [Veeqo digital picking](https://help.veeqo.com/en/articles/8306650-digital-picking-overview); [Veeqo bins](https://help.veeqo.com/en/articles/6096735-bin-location-overview)
- Bad: ShipHero replenishment is an exportable report rather than a task generator; some columns need support to enable; menu paths changed across versions. — [ShipHero Replenishment](https://software-help.shiphero.com/hc/en-us/articles/44079877217933-Overview-Replenishment-Report); [Item Locations](https://software-help.shiphero.com/hc/en-us/articles/44544064232973-Overview-Item-Locations-Report); [receiving POs](https://software-help.shiphero.com/hc/en-us/articles/4419362287885-Receiving-Purchase-Orders)
- Bad: Odoo putaway does not split a receipt across locations even when capacity is exceeded. — [Odoo storage categories](https://www.odoo.com/documentation/18.0/applications/inventory_and_mrp/inventory/shipping_receiving/daily_operations/storage_category.html)
- Mixed: SKUSavvy counter confirms their own discrepancies and adjustments post immediately (fast, but no manager-approval gate described). — [SKUSavvy cycle counting](https://skusavvy.com/docs/guides/warehouse/cycle-counting)
- Low-confidence reviews: Deposco UI "dense/inconsistent"; Peoplevox wave templates need admin expertise. — [rfp.wiki Deposco](https://www.rfp.wiki/supply-chain-logistics-transportation/warehouse-management-systems/deposco); [rfp.wiki Peoplevox](https://www.rfp.wiki/vendors/descartes-peoplevox/infios-krber)

### Inferences
Adopt: URL-persisted filters + column picker + CSV; status cards that deep-link to filtered grids; separate Variance Review with per-line approve/recount; bulk assign; rule preview/"Run now". Avoid: report-only replenishment; pick sequence derived from bin names (store an explicit pick_sequence per location); one-at-a-time assignment.

### Gaps
Sources are documentation, not usability studies; "good/bad" is judged from described behaviour, not observed use.

---

## KQ6. Consensus IA for a Warehouse module (top-level vs tab vs drawer)

### Takeaway
One "Warehouse" sidebar module with an internal sub-nav (not ten new sidebar items): Overview, Receiving, Inventory (by location), Locations, Containers, Pick & Pack, Counts, Replenishment, Reports; configuration rules under Warehouse Settings. Entity details open as side drawers; per-entity facets are tabs.

### Cited Findings
- Extensiv uses a top bar (Home / Warehouse / Inventory / Orders / Contacts / Reports) with a contextual left bar. — [Extensiv](https://extensiv.helpjuice.com/1618963-navigating-menus)
- Odoo splits Operations / Products / Reporting / Configuration; Cin7 places location setup in Settings reference books; ShipHero places Item Locations and Replenishment under Reports. — [Odoo docs](https://www.odoo.com/documentation/18.0/applications/inventory_and_mrp/inventory.html); [Cin7](https://help.core.cin7.com/hc/en-us/articles/9034487246735-Locations); [ShipHero](https://software-help.shiphero.com/hc/en-us/articles/4419303977357)
- Logiwa uses drawers/popups for actions (assign from a drawer; "Create New Count" popup). — [Logiwa jobs](https://intercom.help/mylogiwa/en/articles/9680217-job-management); [Logiwa count plan](https://intercom.help/mylogiwa/en/articles/7033435-create-a-count-plan)
- Location hierarchy models: Odoo parent-path names; NetBox site > location > rack (+ rack groups); Sortly nested folders (6 levels). — [Odoo](https://www.odoo.com/documentation/18.0/applications/inventory_and_mrp/inventory/warehouses_storage/inventory_management/use_locations.html); [NetBox](https://netboxlabs.com/docs/netbox/en/stable/features/facilities/); [Sortly](https://help.sortly.com/how-to-add-folders)

### Inferences (proposal)
- Sidebar: single "Warehouse" item; sub-nav tabs: Overview | Receiving | Inventory | Locations | Containers | Pick & Pack | Counts | Replenishment | Reports. Rules (putaway, batch rules, location types, capacity) in Warehouse > Settings (or global Settings).
- Detail tabs: Location (Contents, Containers, History, Settings/Capacity); SKU (Locations, Replenishment rule); Batch (Orders, Pick list, Activity); Count (Tasks, Variances).
- Drawers: quick location view from any bin chip, assign picker, create batch, move stock, print labels, approve variance.
- Locations as tree (left pane) + table (right), following Odoo parent-path and NetBox hierarchy; support explicit zone/aisle/bay/shelf/bin level types.
- Role split: manager desktop module; floor tasks on a separate mobile/scanner view (consistent with ShipHero/Logiwa/Veeqo/SKUSavvy mobile execution).

### Gaps
No vendor documents its tree-vs-table location UI in accessible docs; NetBox sidebar/tree UI unverified.
