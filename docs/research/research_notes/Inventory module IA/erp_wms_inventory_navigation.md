# Inventory + Warehouse in one module: how established products structure navigation (as of Oct 2026)

**Method and evidence labels (read first).** Research done 2026-10-20. I did not log in to any product, so **no live UI or screenshots were observed**. The strongest evidence is the product's **public source code** for two open-source products (Odoo, ERPNext), where the menu tree is defined. Everything else comes from vendor help centres, marketing, or third parties. Every finding is tagged:

- **[CODE]**: menu definitions read directly from the product's public source on GitHub (raw files fetched with curl). This is the closest proxy for observed UI. Items can still be hidden by feature flags and permission groups, which are noted.
- **[DOCS]**: the vendor's help centre or documentation describing the UI (menu paths such as "Inventory → Transfers").
- **[MKT]**: vendor marketing, blog, datasheet or feature page.
- **[3P]**: third-party source (reviews, integrator docs, community posts).
- **[SUMMARY]**: taken from a search-engine result summary, not from a page read in full. Treat as weaker.

Several help pages were summarised by a small model during fetch, so wording may be paraphrased. Labels shown in quotes are as reported by the source. A sibling note, `../Module UX layout/desktop_wms_information_architecture.md`, already covers screen-level detail (Odoo putaway/storage categories, ShipHero reports, Cin7 bins). This note is about **navigation structure**.

---

## 1. Odoo Inventory (17 / 18 / 19)

### Takeaway
Odoo is the clearest example of quantities and locations living in **one app named "Inventory"**. Its documentation says the app is both an inventory application and a WMS. The second level is a hybrid grammar: **Overview → Operations → Products → Reporting → Configuration**. Operations is subdivided by kind of work (Transfers / Jobs / Adjustments / Procurement). Locations are reference data under Configuration, and "stock by location" is a report. Floor execution is pushed to a **separate Barcode app**. Many menu items only appear once a feature is switched on (progressive disclosure).

### Cited Findings
- [DOCS] Docs intro: "Odoo Inventory is both an inventory application and a warehouse management system." Barcode is documented as a separate Supply Chain section, not part of Inventory. — [Odoo 18 Inventory docs](https://www.odoo.com/documentation/18.0/applications/inventory_and_mrp/inventory.html)
- [CODE] Full Inventory menu tree, Odoo **18.0**, assembled from `menuitem` definitions. Sequence numbers are in brackets. Feature or permission gates are in *italics*:
  ```
  Inventory (app)
  ├─ Overview [0]                         → operation-type kanban (stock_picking_type_action)
  ├─ Operations [2]
  │   ├─ Transfers [1]: Receipts [20] · Deliveries [21] · Internal [22, *Storage Locations on*] · Dropships [30, *dropship module*]
  │   ├─ Jobs [2] (stock_picking_batch module): Batch Transfers [30] · Wave Transfers [31]
  │   ├─ Adjustments [3]: Physical Inventory [10] · Scrap [99]
  │   └─ Procurement [4]: Replenishment [5, *manager only*]
  ├─ Products [4]: Products [1] · Product Variants [2, *variants on*] · Lots/Serial Numbers [101, *lots on*] · Packages [102, *packages on*]
  ├─ Reporting [99, *manager only*]: Stock [5] · Locations [150, *Storage Locations on*] · Moves History [200] · Moves Analysis [230] · Valuation [250, *stock_account*]
  └─ Configuration [100, *manager only*]
      ├─ Settings [0]
      ├─ Warehouse Management [1]: Warehouses [1] · Operations Types [2] · Locations [3, *Storage Locations on*] · Routes [4, *Multi-Step Routes on*] · Rules [5, *Multi-Step Routes on*] · Storage Categories [6, *Storage Locations on*]
      ├─ Products [4]: Product Categories · Attributes · Product Packagings / Units & Packagings · Barcode Nomenclatures (*debug*)
      └─ Delivery [50]: Package Types
  ```
  Sources: [stock_menu_views.xml 18.0](https://raw.githubusercontent.com/odoo/odoo/18.0/addons/stock/views/stock_menu_views.xml), [stock_picking_views.xml](https://raw.githubusercontent.com/odoo/odoo/18.0/addons/stock/views/stock_picking_views.xml), [stock_quant_views.xml](https://raw.githubusercontent.com/odoo/odoo/18.0/addons/stock/views/stock_quant_views.xml), [stock_location_views.xml](https://raw.githubusercontent.com/odoo/odoo/18.0/addons/stock/views/stock_location_views.xml), [stock_orderpoint_views.xml](https://raw.githubusercontent.com/odoo/odoo/18.0/addons/stock/views/stock_orderpoint_views.xml), [stock_scrap_views.xml](https://raw.githubusercontent.com/odoo/odoo/18.0/addons/stock/views/stock_scrap_views.xml), [product_views.xml](https://raw.githubusercontent.com/odoo/odoo/18.0/addons/stock/views/product_views.xml), [stock_picking_type_views.xml](https://raw.githubusercontent.com/odoo/odoo/18.0/addons/stock/views/stock_picking_type_views.xml), [stock_storage_category_views.xml](https://raw.githubusercontent.com/odoo/odoo/18.0/addons/stock/views/stock_storage_category_views.xml), [stock_rule_views.xml](https://raw.githubusercontent.com/odoo/odoo/18.0/addons/stock/views/stock_rule_views.xml), [stock_package_type_view.xml](https://raw.githubusercontent.com/odoo/odoo/18.0/addons/stock/views/stock_package_type_view.xml), [stock_picking_batch_views.xml](https://raw.githubusercontent.com/odoo/odoo/18.0/addons/stock_picking_batch/views/stock_picking_batch_views.xml), [stock_valuation_layer_views.xml](https://raw.githubusercontent.com/odoo/odoo/18.0/addons/stock_account/views/stock_valuation_layer_views.xml), [stock_dropshipping picking views](https://raw.githubusercontent.com/odoo/odoo/18.0/addons/stock_dropshipping/views/stock_picking_views.xml), [res_config_settings_views.xml](https://raw.githubusercontent.com/odoo/odoo/18.0/addons/stock/views/res_config_settings_views.xml)
- [CODE] Odoo **19.0** has the same tree for the stock module: the same Operations groups (Transfers, Jobs, Adjustments, Procurement), Products, Reporting and Configuration. The Moves History action gains a URL path `moves-history`. The UoM config entry is renamed "Units & Packagings". The Valuation menu was not found in the same 19.0 stock_account file (it may have moved; not verified). — [stock_menu_views.xml 19.0](https://raw.githubusercontent.com/odoo/odoo/19.0/addons/stock/views/stock_menu_views.xml), [stock_move_line_views.xml 19.0](https://raw.githubusercontent.com/odoo/odoo/19.0/addons/stock/views/stock_move_line_views.xml)
- [CODE] The Overview kanban (one card per operation type) computes `count_picking_ready`, `count_picking_waiting`, `count_picking_late`, `count_picking_backorders` and `count_move_ready`. These are the "to process / waiting / late / back orders" numbers on each card. — [stock_picking_type_views.xml 18.0](https://raw.githubusercontent.com/odoo/odoo/18.0/addons/stock/views/stock_picking_type_views.xml)
- [3P] On Odoo 17, the Overview has cards for Receipts, Internal Transfers, Pick, Pack, Delivery Orders, PoS Orders, Resupply Subcontractor, Repairs and Manufacturing. Clicking a card opens that operation's list, and each card has a three-dot menu. — [Cybrosys Odoo 17 overview](https://www.cybrosys.com/blog/an-overview-of-odoo-17-inventory)
- [DOCS] The Operations menu lists Receipts, Deliveries, Internal Transfers, Manufacturings, Batch Transfers and Dropships. — [Odoo batch transfers docs](https://www.odoo.com/documentation/18.0/applications/inventory_and_mrp/inventory/shipping_receiving/picking_methods/batch.html)
- [DOCS] Cycle counts run from Operations > Physical Inventory, with count frequency set per location. Putaway Rules and Storage Categories sit under Configuration. — [cycle counts](https://www.odoo.com/documentation/18.0/applications/inventory_and_mrp/inventory/warehouses_storage/inventory_management/cycle_counts.html), [putaway](https://www.odoo.com/documentation/18.0/applications/inventory_and_mrp/inventory/shipping_receiving/daily_operations/putaway.html)
- [DOCS] Barcode app: the start screen is "a Barcode Scanner screen displaying different options". An **Operations** button opens operation cards such as **Receipts** and **Delivery Orders**. Processing a receipt means scanning, using +#, then **Validate**. Barcode scanning is enabled from Inventory app ‣ Configuration ‣ Settings. — [Odoo 18 Barcode receipts & deliveries](https://www.odoo.com/documentation/18.0/applications/inventory_and_mrp/barcode/operations/receipts_deliveries.html)
- [CODE] Manufacturing is a **separate app** (`menu_mrp_root`, sequence 145, right next to Inventory's 140). It uses the **same five-part grammar**: Operations, Planning, Products, Reporting, Configuration. — [mrp_views_menus.xml 18.0](https://raw.githubusercontent.com/odoo/odoo/18.0/addons/mrp/views/mrp_views_menus.xml)

### Inferences
- Odoo's answer to "inventory vs warehouse" is that they are not two modules. *Stock* is a report (Reporting > Stock / Locations), *places* are configuration (Configuration > Locations), and *work* is Operations plus Overview cards. One top-level app with five stable sections scales from "no locations" to "multi-step routes" by switching menu items on, not by adding modules.
- The Overview operation cards are the work-queue surface. Each card is a filtered list ("Receipts: 3 ready, 1 late"). This maps directly to Freeze Pipe's Putaway, Counts and Pick & Pack queues.
- Floor work is a different app on a different device (Barcode), driven by the same operation types. The desktop module stays a manager tool.
- Purchase orders live in the separate Purchase app. Only the resulting Receipt appears in Inventory. This is inferred from the module split (`purchase_stock`). I did not fetch a page stating it.

### Gaps
- No live Odoo UI observed. The demo was blocked in prior research, so card layout and visual grouping (section headers inside the dropdown) are unverified.
- The exact label of the Putaway Rules menu item was not located in source; the docs say Configuration > Putaway Rules. The location of Odoo 19 Valuation was not verified.

---

## 2. NetSuite (Inventory Management + NetSuite WMS)

### Takeaway
Classic NetSuite organises navigation **by record type** (Transactions / Lists / Reports / Setup), not by module. **Role centres** then regroup the same pages: a Warehouse Manager gets an "Inventory" tab. Warehouse floor work is a **separate mobile app** whose main menu is organised **by flow**. Putaway sits inside **Receiving**; bin transfers sit inside **Inventory**.

### Cited Findings
- [DOCS] Desktop path: Transactions > Inventory > Bin Putaway Worksheet (requires Bin Management). — [Oracle: Bin Putaway Worksheet](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_N3192034.html)
- [DOCS] The same page is reached by different paths per role. For example, Inventory Count is Administrator "Transaction > Inventory > Print Inventory Count Sheet" versus Warehouse Manager "Inventory > Inventory > Print Inventory Count Sheet" versus Accountant "Financial > Inventory > ...". Supply Chain Management is Admin "Transaction > Management > ..." versus Warehouse Manager "Inventory > Other > ...". Manufacturing dispatch list for Warehouse Manager is "Inventory > Manufacturing > Print Dispatch List". — [Oracle: SCM roles & permissions](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/bridgehead_3836204551.html)
- [DOCS] WMS mobile app: "On the Main Menu page, tap Receiving. On the Receiving page, tap Putaway… tap Cart Moves." — [Oracle: Putting Away Items Using Carts](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_161894286213.html)
- [DOCS][SUMMARY] Bin transfer path: Main Menu > Inventory > Bin Transfer. Storage-to-staging moves are not allowed; staging-to-storage must go through putaway. — [Oracle: Transferring Items Between Bins](https://oracle.hydrogen.sagittarius.connect.product.adaptavist.com/en/cloud/saas/netsuite/ns-online-help/section_1541441872.html)
- [DOCS] Bins appear under the **Lists** column in the WMS permissions table. — [Oracle: WMS permissions](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_156520480478.html)
- [MKT] The mobile WMS handles "receiving, putaway, picking and packing", plus bin transfers, replenishment and cycle counts from the device. — [NetSuite WMS datasheet](https://www.netsuite.co.uk/portal/assets/public-pdf/ds-netsuite-wms.pdf)

### Inferences
- NetSuite shows the cost of record-type navigation: an owner must know that a count sheet is a "Transaction". NetSuite fixes this with role-specific tabs, which is evidence that a task or role grouping ("Inventory" for warehouse people) reads better than a system grouping.
- In the mobile app, putaway is a sub-step of receiving. This supports putting Putaway next to receiving or inbound shipments rather than as a peer of Locations.

### Gaps
- Full WMS mobile main-menu list and order (Receiving / Picking / Packing / Inventory / ...) not confirmed from Oracle docs. Inventory Manager role-centre tabs not found.

---

## 3. Cin7 Core (and Cin7 Omni)

### Takeaway
Cin7 Core's web app is organised **by business flow**: Sale, Purchase, Production, Inventory, Financial, plus Reports and Settings. **Inventory** holds products, stock adjustments, stocktakes and transfers. **Locations and bins are reference data in Settings**. All floor execution (pick, pack, receive and put away, restock, stocktake, lookup, transfer, write-off, labels) is in a **separate WMS mobile app**, configured from the web app.

### Cited Findings
- [DOCS] Quick Access groups: **Purchase** (Simple Purchase, Advanced Purchase, Service Purchase, Supplier, Reorder), **Sale** (Simple Sale, Advanced Sale, Service Sale, Customer), **Production** (Assembly, Disassembly, Job, Inventory Write-Off), **Inventory** (Product, Product Family, Stock Adjustment, Stocktake, Transfer), **Financial** (Receive Money, Spend Money). — [Cin7 Core: Quick Access](https://help.core.cin7.com/hc/en-us/articles/9982491319951-Navigating-through-Cin7-Core-Using-the-Quick-Access-Button) (read via built-in browser)
- [DOCS] Menu paths: "Inventory → Transfers"; "Inventory → Stocktake and adjustments"; "Inventory → Products → [product]" (tabs: Prices, Suppliers, Movements, Bill of Materials); a Product Availability screen shows what is allocated to sale and work orders and expected delivery dates; "Reports → Inventory → Lot Recall"; permissions at "Settings → Users and Roles". — [Cin7 Core: Introduction to the Inventory Module](https://help.core.cin7.com/hc/en-us/articles/9034498689295-Introduction-to-the-Inventory-Module) (browser)
- [DOCS] Locations and bins live at Settings > Reference Books > Stock > Locations & Bins. Pick zones are an Advanced add-on. — [Cin7 Locations](https://help.core.cin7.com/hc/en-us/articles/9034487246735-Locations), [Pick Zones](https://help.core.cin7.com/hc/en-us/articles/9034505649679-Pick-Zones) (from sibling note)
- [DOCS] WMS is Cin7 Core's "warehouse management mobile app". Standard functions: Pick, Packing, Receive and put away (with or without a PO; put away moves received stock to a bin), Restock (returns), Stocktake, Stock lookup (SOH, available, allocated, on order; by location, by bin, or by item across bins), Stock transfer (between locations or bins; can pick transfers created on the web), Write-off, Print labels, Picking for kitting. Advanced adds pick zones, FEFO/FIFO enforcement, delivery scheduling and time tracking. WMS settings "can be customized from within Cin7 Core, not within the application itself." — [Cin7 Core: Introduction to WMS](https://help.core.cin7.com/hc/en-us/articles/9034461577487-Introduction-to-Warehouse-Management-System-WMS) (browser)

### Inferences
- Cin7's split is **"what" in the web Inventory module, "where + do" in the app, "where (setup)" in Settings**. The desktop module stays small (about 5 items) because execution moved to the phone.
- Receiving is reached from the purchase document on desktop and from "Receive" in the app. Receiving is not an Inventory menu item.

### Gaps
- The full Cin7 Core left-sidebar item list (beyond Quick Access groups) was not captured. The desktop Purchase-module receiving path was not fetched.
- **Cin7 Omni**: no help-centre navigation found (only third-party reviews and API listings). Not covered.

---

## 4. Katana MRP

### Takeaway
Katana's top level is **verb/flow screens**: Sell, Make, Buy, Stock, Plan, Insights, Items, Settings. **Stock** is the single quantities hub for products and raw materials together (in stock / committed / expected, location filter). It also hosts adjustments, transfers, stocktakes and batches. Bins and multi-bin putaway (a Warehouse Management add-on, 2026) were added **inside Stock and Settings**, not as a new top-level item.

### Cited Findings
- [DOCS] Screens: **Sell** (Sales orders, Quotes, Returns, Price lists, Customers); **Make** (Schedule, Tasks, plus the Shop Floor App); **Buy** (Purchase orders, Outsourced purchase orders, Suppliers); **Stock** (inventory list, safety stock levels, quick actions, stock movements); **Plan** (add-on: Planning, Replenishment); **Insights**; **Items** (Products, Materials, Services); **Settings** (General, Locations, Templates, Data management). — [Katana: basics of Katana screens](https://support.katanamrp.com/en/articles/5908373-basics-of-katana-screens)
- [DOCS] The Stock screen's Inventory tab shows products **and materials** at variant level. Columns: value, average cost, In stock, Committed, Expected, plus Safety stock and Calculated stock when one location is filtered. A "+" on each row creates a PO or MO. Materials are consumed when an MO completes. — [Katana: Using the Stock screen](https://support.katanamrp.com/en/articles/5966127-using-the-stock-screen)
- [DOCS][SUMMARY] Stocktake: "navigate to the Stock screen and select the Stocktakes tab". Completing a stocktake creates a stock adjustment. — [Katana: performing a stocktake](https://support.katanamrp.com/en/articles/5966106-performing-a-stocktake-i-e-inventory-count)
- [DOCS] Storage bins require the Warehouse Management add-on. They are added under Settings > Locations > Storage bins or on an item card. Each variant has one default bin per location. Bins are not visible in the Shop Floor app. — [Katana: basics of storage bins](https://support.katanamrp.com/en/articles/8340252-basics-of-storage-bins)
- [MKT] Multi-bin (blog dated 4 Sep 2026): after receiving a PO, a "putaway transfer" moves quantities from "Unassigned" into a bin. Per-bin counts appear under "Inventory → Stock Inventory" via a bin icon. Bins are configured at "Settings → Warehouse → Bin Locations". Warehouse App bin support is "upcoming". These labels conflict with the help article's "Settings > Locations > Storage bins". The blog is likely newer. — [Katana blog: multiple bin locations](https://katanamrp.com/blog/multiple-bin-locations/)

### Inferences
- Katana keeps raw materials in the same Stock hub as finished goods, separated only by an Items tab (Products / Materials). Consumption lives in Make. This argues for keeping Freeze Pipe's Materials in the merged inventory module, with consumption visible from Manufacturing.
- Putaway is modelled as a *transfer type* following PO receipt, not a separate module. Locations and bins are Settings.

### Gaps
- The exact current tab order on the Stock screen, and whether "Stock" has been relabelled "Inventory" in 2026 (the blog wording suggests so), are unverified.

---

## 5. Fishbowl (Advanced)

### Takeaway
Fishbowl is the legacy **department-split** pattern. Inventory-type modules sit in a **Materials** group, receiving in **Purchasing**, picking and shipping in **Sales**, and **Location / Location Group** in **Setup**. Warehouse work is spread across groups rather than consolidated.

### Cited Findings
- [MKT][SUMMARY] The Materials group holds Part, Product, Inventory, Monitor, Transfer Order and Consignment. Picking and Shipping are in the Sales group; Receiving is in Purchasing. Source is a 2017 Fishbowl blog, now 404, seen via search summary. — [Fishbowl blog (2017, archived URL)](https://blog.fishbowlinventory.com/2017/11/24/every-module-in-fishbowl/)
- [MKT] Setup module group (Aug 2018), 11 modules: Carrier, Company, Custom Field, **Location**, **Location Group**, Payment Terms, Property, Schedule, Unit of Measure, User, User Group. The same page's website "Features" groups (e.g. Warehousing: 3PL, Multi-location Management, Order Fulfillment, Pick & Pack) are marketing categories, not in-app groups. — [Fishbowl: Setup module group](https://fishbowlinventory.com/blog/setup-module-group)
- [3P] The Fishbowl Advanced iOS app release notes mention a "Location module inventory list" and a Cycle module. — [App Store: Fishbowl Advanced](https://apps.apple.com/app/id1189299884)

### Inferences
- This is the "clutter" end of the spectrum. A user doing one receiving-to-putaway flow crosses Purchasing → Materials → Setup. Its own marketing regroups features into a "Warehousing" bucket that the app does not have, a hint that buyers think in a consolidated warehouse category.

### Gaps
- Current Fishbowl Advanced module list not verified from a 2025–26 help source.

---

## 6. inFlow Inventory

### Takeaway
inFlow is **document-centric** with four broad areas: Sales, Purchasing, Inventory, Reports. Receiving is a button on the purchase order and picking is a button on the sales order. Inventory holds adjust, count, transfer and reorder. The **same mobile app** serves everyone, with a short home screen.

### Cited Findings
- [DOCS][SUMMARY] The user manual's Inventory section lists Adjust Stock, Count Stock, Transfer Stock, Reorder Stock and Work Orders. Paths are Main Menu > New stock adjustment and Main Menu > Create > Transfer. — [inFlow User Manual (PDF)](https://cdn2.inflowinventory.com/inFlowWebsite/inFlow_User_Manual.pdf), [inFlow: adjust stock](https://inflowinventory.com/support/cloud/how-do-i-adjust-my-stock-levels), [inFlow: transfer](https://www.inflowinventory.com/support/cloud/how-do-i-transfer-stock-between-locations/)
- [DOCS] Mobile app (updated 24 Jul 2026): the homepage shows **Inventory**, **Purchasing** and **Sales orders**, each with a "+" button. Main Menu has New product, Sales Orders, Customers and Transfer Stock. Receiving and picking appear only as buttons inside purchase and sales orders. No owner/staff role split is described. — [inFlow mobile app full guide](https://www.inflowinventory.com/support/cloud/inflow-inventory-mobile-app-full-guide)
- [MKT] Locations and sublocations, stock transfers, physical counts, a "Stockroom" companion scanning app, and mobile guided picking showing item locations. — [inFlow features](https://www.inflowinventory.com/features/all-features)

### Inferences
- For a small team, "receive from the document" (open the PO or shipment, press Receive) is the simplest mental model. Freeze Pipe's carton-level receiving on the Shipment detail already follows it.

### Gaps
- Exact web-app left-menu labels not confirmed.

---

## 7. Zoho Inventory (and Zoho ERP)

### Takeaway
Zoho explicitly **decluttered** a long sidebar by grouping modules under **Inventory / Sales / Purchases** headers. It then added a **"Warehouse Operations"** sub-area *inside* Inventory (Picklists, Putaways, Move Orders; Transfer Orders nearby). This is a direct precedent for **one Inventory module with a warehouse-operations sub-level**.

### Cited Findings
- [DOCS] Navigation-change announcement: "decided to declutter the left sidebar by grouping multiple modules under common headers". The **"Items" header was renamed "Inventory"** to better represent modules such as Price Lists and Inventory Adjustments. New **Sales** header: Customers, Sales Orders, Packages, Invoices, Payments Received, Sales Returns, Credit Notes, plus Picklists if enabled. New **Purchases** header: Vendors, Expenses, Purchase Orders, Bills, Payments Made, Vendor Credits. No post date is shown; image filenames suggest about 2021 (inference). — [Zoho community: Changes to how you navigate Zoho Inventory](https://help.zoho.com/portal/en/community/topic/changes-to-how-you-navigate-zoho-inventory)
- [DOCS] Picklists today: "Navigate to Picklist under Inventory on the left sidebar", or Inventory → "Warehouse Operations on the top module bar" → Picklists. Picklists have moved from the Sales header to Inventory. — [Zoho Inventory: Picklists](https://www.zoho.com/inventory/help/picklist/)
- [DOCS] Zoho ERP: Inventory (left sidebar) → Warehouse Operations (top module bar) → **Putaways** or **Move Orders**. Putaways need the Locations feature plus the Putaways module enabled in Settings, and items in the warehouse's Receiving Area. — [Zoho ERP: Create Putaway](https://www.zoho.com/en-in/erp/help/inventory/putaways/create-putaway.html), [Zoho ERP: Create Move Order](https://www.zoho.com/en-in/erp/help/inventory/move-orders/create-move-order.html)
- [DOCS] The Warehouses help section is split into Warehouses – Overview, Warehouse Operations and Transfer Orders. Bin locations are enabled per warehouse. — [Zoho Inventory: Warehouse operations](https://www.zoho.com/inventory/help/warehouses/warehouse-operations.html), [bin locations](https://www.zoho.com/ca/inventory/help/bin-locations/)

### Inferences
- Zoho's path (flat list, then flow headers, then "Warehouse Operations" tucked under Inventory) is the evolution Freeze Pipe is facing. It ended with **one Inventory header** whose second level includes a warehouse-operations bucket, with features switched on in Settings.
- Packages and Shipments stayed under Sales. Outbound shipping documents sit with the sale; the picking task moved to Inventory.

### Gaps
- Full current list of tabs in the Inventory "top module bar" not found.

---

## 8. ShipHero

### Takeaway
On the web dashboard, **Locations are part of the Inventory menu**: Products, Product Locations, Locations, Location Types and adjustments all live together. Purchase Orders (receiving) and Reports are separate top tabs. **All floor work** (batch picking, single order, cycle count, location search) is in the **mobile app**, plus a separate Packing App.

### Cited Findings
- [DOCS] Web Dashboard top-level tabs, each with a dropdown: Orders, Returns, Inventory, Purchase Orders, Reports, Shipping. — [ShipHero Getting Started category](https://software-help.shiphero.com/hc/en-us/categories/36549098773645-Getting-Started)
- [DOCS] The **Inventory** menu has eight items: Products, Inventory Change Reasons, Bulk Edit, Inventory Upload, **Product Locations** (which bins hold which products, quantity per bin, pickable), **Locations** (create, delete and bulk-update bins), **Location Types** (shelf, bin, pallet), Units of Measure. Purchase Orders has its own menu. — [ShipHero: Web Dashboard Inventory Menu](https://software-help.shiphero.com/hc/en-us/articles/8497110740749-User-Guide-Web-Dashboard-Inventory-Menu)
- [DOCS] The iOS mobile app is for floor staff. Sections: Dashboard (ready-to-ship orders and pickable items), Single Item Batch, Multi-Item Batch, Single Order, All Orders, Picking, **Products** (Search Products, **Cycle Count**, Search Locations), User Settings. Cycle Count is configured on the web. Single-item batches ship from a separate Packing App. — [ShipHero iOS Mobile App guide](https://software-help.shiphero.com/hc/en-us/articles/8497107616269-User-Guide-ShipHero-iOS-Mobile-App)
- [DOCS] Purchase Orders sub-tabs: All Purchase Orders, Line Items, Rejected Line Items, Change Log, Statuses, Vendors. A newer article uses "Receiving > Purchase Orders". — [Fulfillment Hub USA guide (3P)](https://knowledgebase.fulfillmenthubusa.com/fulfillment-hub-usa-guide-to-the-shiphero-web-dashboard-purchase-orders-menu), [ShipHero: Receiving POs](https://software-help.shiphero.com/hc/en-us/articles/4419362287885-Receiving-Purchase-Orders)

### Inferences
- ShipHero is object-centric on desktop (Inventory = products **and** places) and job-centric on mobile. Freeze Pipe's Warehouse > Locations would fold into Inventory under this model.

### Gaps
- No mobile Putaway or Receive section is named in the mobile guide. Where ShipHero's receiving and putaway live on mobile is unverified.

---

## 9. Veeqo, Linnworks/SkuVault, Finale, Brightpearl, ERPNext, Sortly

### Veeqo
**Takeaway:** Veeqo names the merged stock area **"Warehouse"** and puts **Inventory, Purchase Orders, Suppliers and Warehouse Transfers** together in it. Picking sits under **Fulfilment**; **Locations** sit in **Settings**.
- [DOCS] Sidebar (help article dated 17 Mar 2026) has four sections. **Fulfilment**: Orders, Wholesale, Returns, Picking Queues, Picking Groups. **Warehouse**: Inventory, Purchase Orders, Suppliers, **Warehouse Transfers (previously "stock transfers")**, Price Lists, Listings. The article notes these pages differ from Location settings. **Analytics**: Profit Analyzer, Sales Report, Product Report, Shipping Report, Demand Forecast, Inventory Value Report, Inventory Change Log, Returns Report, Team Metrics. **Settings**: …Inventory, Fulfilment, …Locations, Users, Digital picking… — [Veeqo: Navigating Veeqo](https://help.veeqo.com/en/articles/13833434-navigating-veeqo)
- [MKT] Cycle stock takes run on Veeqo's barcode scanner or the iOS/Android app "without shutting down your warehouse". — [Veeqo inventory features](https://www.veeqo.com/inventory-management-software-system/inventory-features)
- **Inference:** Veeqo shows that the inbound (POs) plus stock plus transfers bundle can be called "Warehouse" for an SMB audience. The rename from "stock transfers" to "Warehouse Transfers" suggests they chose the place-word as the umbrella.
- **Gap:** where stock takes appear on desktop.

### Linnworks / SkuVault Core
- [DOCS] Linnworks has a **My Inventory** screen (stock with a "Due" value from open POs) and a **Stock In** screen to "book in new inventory as it arrives". Booking in can mark items delivered on selected POs. PO screen actions: Deliver Item / Deliver All / To Delivered. In Linnworks Mobile: Stock In → From PO tab lists Open and Partially Delivered POs. — [Linnworks: deliver a PO](https://help.linnworks.com/support/solutions/articles/7000059576-purchase-orders-how-to-deliver-a-po), [Linnworks Mobile Stock In](https://help.linnworks.com/support/solutions/articles/7000057037), [Linnworks PO management](https://desktop.linnworks.com/Doc/purchase_order_management)
- [MKT] SkuVault Core location auditing: add or remove products in a location, bulk-move, print a location's labels, full recount; cycle count prioritised by last audit date. — [Linnworks webinar page](https://linnworks.zoom.us/webinar/register/8017090523954/WN_dMYr5PbQQtiIxpj3wkdJHw)
- **Inference:** "Stock In" is a receiving screen that is PO-aware but is not the PO itself. Receiving is a warehouse action that closes purchasing documents.
- **Gap:** SkuVault Core menu labels not found.

### Finale Inventory
- [DOCS] Two-level hierarchy: Location (facility) → **Sublocation** (area or bin). "Stock levels are stored in Sublocations". A "Std Bin ID" is only a lookup aid. Stock Transfer moves between sublocations. — [Finale: stock level definitions](https://support.finaleinventory.com/hc/en-us/articles/360006233073-Stock-level-defintions-and-calculations-in-Finale-Inventory), [Finale support article](https://support.finaleinventory.com/hc/en-us/articles/115007096608)
- **Gap:** Finale menu labels not found.

### Brightpearl
- [3P] Inventory settings are at Products / Inventory > Inventory Settings. Item location management is None, Standard (per warehouse) or Multiple concurrent (bin level). Receiving uses a **Goods-In Note** object against POs or credits. — [Extensiv: Brightpearl integration settings](https://help.extensiv.com/wm-brightpearl-integration-settings)
- [MKT] Receiving with PO sync, barcode, partial, blind and no-PO receipts; guided putaway by zones, licence plates and location groups. — [Brightpearl WMS](https://www.brightpearl.com/warehouse-management-system)
- **Gap:** no Brightpearl help-centre navigation found.

### ERPNext (v16 "develop", sidebar JSON modified 2026-07-03)
**Takeaway:** One **"Stock"** module holds transactions, pick lists, warehouses (as Setup) and putaway rules (as Tools). It uses the same hybrid grammar as Odoo: Home/Dashboard → work documents → Tools → Setup → Reports → Settings. It is also the clearest **clutter** example: about 45 links in one sidebar.
- [CODE] Stock sidebar: **Home · Dashboard · Stock Entry · Purchase Receipt · Delivery Note · Material Request · Pick List**. **[Tools]** Stock Reconciliation, Landed Cost Voucher, Repost Item Valuation, Packing Slip, Quality Inspection. **[Setup]** Item, Item Group, Item Attribute, Brand, **Warehouse**, UOM, UOM Conversion Factor, Serial No, Batch No, Serial and Batch Bundle, Inventory Dimension, Shipping Rule, Item Alternative, Quality Inspection Template, Delivery Trip. **[Reports]** 20 links (Stock Ledger, Stock Balance, Stock Projected Qty, Stock Ageing, Warehouse Wise Stock Balance, …). **[Settings]** Stock Settings, Item Variant Settings, Stock Reposting Settings, Delivery Settings. — [erpnext/workspace_sidebar/stock.json](https://raw.githubusercontent.com/frappe/erpnext/develop/erpnext/workspace_sidebar/stock.json)
- [CODE] The Stock workspace page has report cards: Stock Reports (14), Serial & Batch Reports (10), Movement Reports (9), Item Reports (5), Audit Reports (11), Tools (including **Putaway Rule**, Shipment, Quick Stock Balance), and Setup (including Warehouse Type). — [erpnext/stock/workspace/stock/stock.json](https://raw.githubusercontent.com/frappe/erpnext/develop/erpnext/stock/workspace/stock/stock.json)
- [CODE] **Buying** sidebar: Material Request, Request for Quotation, Supplier Quotation, **Purchase Order**, Purchase Invoice, plus Setup and Reports (including "Requested Items to Order and Receive"). **Purchase Receipt lives in Stock, not Buying.** **Manufacturing** sidebar: BOM, Work Order, Job Card, **Stock Entry**, **Shop Floor**; Setup includes Warehouse, Workstation and Plant Floor; Reports include "Work Order Consumed Materials". — [buying.json](https://raw.githubusercontent.com/frappe/erpnext/develop/erpnext/workspace_sidebar/buying.json), [manufacturing.json](https://raw.githubusercontent.com/frappe/erpnext/develop/erpnext/workspace_sidebar/manufacturing.json)
- **Inference:** ERPNext splits **ordering** (Buying: PO) from **receiving** (Stock: Purchase Receipt). Material consumption is a Stock Entry reachable from both Stock and Manufacturing. Warehouse (location) is Setup data and appears in both Stock and Manufacturing Setup. Pushing every report into the sidebar is the anti-pattern NN/g's thresholds warn about.

### Sortly
- [DOCS] Mobile app: the old Dashboard tab was replaced by a **Workflows** tab giving quick access to **Stock Counts, Pick Lists, Purchase Orders**. Other tabs: Items, Search (including Scan to Search to see where items are kept). Reports moved to Menu > Reports. — [Sortly Mobile App](https://help.sortly.com/hc/en-us/articles/6660883031451), [Sortly product overview](https://help.sortly.com/hc/en-us/articles/360036515592-Sortly-Product-Overview)
- [DOCS] Locations are nested **folders**, up to six levels. — [Sortly folders](https://help.sortly.com/how-to-add-folders)
- **Inference:** Sortly's "Workflows" is a single bucket of *things to do* (counts, picks, POs) beside the object list (Items). It is the simplest version of "overview + work queues".

---

## 10. Shopify admin (merchant mental model)

### Takeaway
Shopify treats **locations as Settings** and **inventory quantities, transfers, stock counts and purchase orders as part of Products/Inventory**. As of mid-2026, receiving a PO creates a linked **transfer**. Shopify has no bins. A merchant-trained owner will expect "Inventory" for quantities and "Locations" as configuration.

### Cited Findings
- [DOCS] "A location is any physical place where you sell products, fulfill orders, or stock inventory." Examples: warehouses, retail stores, pop-ups, some apps. There is no mention of sub-locations or bins. — [Shopify Help: Locations](https://help.shopify.com/en/manual/locations)
- [DOCS] "From your Shopify admin, go to Settings > Locations." — [Shopify Help: set up locations](https://help.shopify.com/en/manual/inventory-and-locations/locations/setup)
- [DOCS] The Help Centre section is **"Inventory and locations"**, with sub-areas Locations, Fundamentals, Setup of product inventory, Managing inventory quantities, **Stock counts**, **Inventory transfers and shipments**, **Purchase orders**, Migrating from Stocky. — [Shopify Help: Inventory and locations](https://help.shopify.com/en/manual/inventory-and-locations)
- [DOCS] Transfers have their own admin page (admin.shopify.com/transfers). Receiving can be full or partial at the destination, in admin or POS. — [Shopify Help: inventory transfers](https://help.shopify.com/en/manual/inventory-and-locations/inventory-transfers)
- [3P] Transfers sit at **Products > Transfers** after a May 2025 redesign. — [PowerCommerce summary](https://powercommerce.com/blogs/shopify-updates/shopify-simplifies-inventory-transfers-shipment-optional-clearer-transfer-view-inline-tracking-and-po-linking), [Ramp RFID KB](https://support.ramprfid.com/knowledge/transfer-orders-with-shopify)
- [DOCS] Changelog, 22 Jun 2026: "Purchase orders record what you ordered from a supplier and what it cost. Transfers record inventory movement." Receiving a PO now creates a transfer that stays linked to the PO, and one transfer can cover several shipments. — [Shopify changelog](https://changelog.shopify.com/posts/purchase-orders-now-create-transfers-to-move-inventory)
- [3P] Stocky (the old Shopify POS inventory app) is being retired, with its PO and transfer functions moving into admin. Dates conflict: "August 31, 2026" versus "August 2026". — [eSEOspace guide](https://eseospace.com/blog/shopify-inventory-management/)

### Inferences
- Shopify's model maps closely onto Freeze Pipe. **Factory Order ≈ Purchase order** (what was ordered and its cost). **Shipment ≈ Transfer/shipment** (movement, multiple shipments per PO, partial receiving). **Stock counts** and **Transfers** sit beside Inventory. **Locations** are settings. The owner probably already holds this mental model.

### Gaps
- Exact current admin labels under Products (Inventory / Transfers / Purchase orders / Stock counts) not verified from Shopify's own help text.

---

## 11. UX writing on IA for operations software

### Takeaway
I found no dedicated NN/g article on "object vs task navigation for enterprise apps". The relevant guidance is threshold-based: keep categories visible, use a section menu for 6–15 items and a landing page beyond 15. Object-first design (OOUX: "nouns before verbs") supports organising by object, with tasks surfaced on each object. Rugged-device vendors frame floor devices as **locked, single-purpose task launchers** separate from back-office screens.

### Cited Findings
- [DOCS] NN/g (Budiu, 16 Jul 2017): with fewer than 6 subcategories use an accordion or submenu; with 6–15 "consider a section menu"; with more than 15 per category use a category landing page. — [NN/g: Mobile Subnavigation](https://www.nngroup.com/articles/mobile-subnavigation/)
- [SUMMARY] NN/g: left-side vertical navigation is scalable and easy to scan for broad information spaces. In complex apps, keep menu items visible to minimise memory load. A homepage that acts as a navigation hub works for task-based apps. — [NN/g: vertical nav](https://www.nngroup.com/articles/vertical-nav/), [NN/g: heuristics for complex applications](https://www.nngroup.com/articles/usability-heuristics-complex-applications/), [NN/g: mobile navigation patterns](https://www.nngroup.com/articles/mobile-navigation-patterns/)
- [3P] OOUX (Sophia Prater): define objects (nouns) before actions (verbs). The ORCA process covers Objects, Relationships, Calls-to-action, Attributes. — [LogRocket: OOUX](https://blog.logrocket.com/ux-design/object-oriented-ux-ooux/), [InfoQ podcast](https://www.infoq.com/podcasts/object-oriented-ux-sophia-prater/)
- [3P] Task-oriented navigation is described as suiting business apps built for completing specific tasks. Object-oriented navigation needs each object to be self-contained. — [Userpilot: navigation UX](https://userpilot.com/blog/navigation-ux); see also [UX Mastery: object-focused vs task-focused](https://uxmastery.com/object-focused-vs-task-focused/)
- [3P] A hybrid pattern is documented in prior art: an object pane plus a task pane listing tasks applicable to the selected object. — [US patent 6,925,609](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/6925609)
- [DOCS] Zebra Enterprise Home Screen restricts a device to approved apps and can auto-launch one app in kiosk mode. Design Studio builds custom launcher screens. — [Zebra Design Studio](https://techdocs.zebra.com/zebradna/latest/design/), [Zebra EHS](https://www.zebra.com/cn/zh/support-downloads/software/mobile-computer-software/enterprise-home-screen.html)

### Gaps
- No Honeywell guide and no Odoo design-rationale document were found. Treat "floor app separate from management" as an industry pattern evidenced by products (Odoo Barcode, NetSuite WMS, Cin7 WMS, ShipHero mobile), not by a published design guide.

---

# Synthesis

## Answers to the key questions

**Q1. Who keeps quantities and locations under one top-level item, and what is it called?**
- **One item:** Odoo "Inventory" (locations in Configuration, stock-by-location in Reporting); ShipHero "Inventory" (Locations, Product Locations, Location Types in the same dropdown); Zoho "Inventory" (with "Warehouse Operations" inside); ERPNext "Stock" (Warehouse under Setup, Pick List, Putaway Rule); Katana "Stock" (bins configured in Settings); Veeqo **"Warehouse"** (Inventory + POs + Transfers; Locations in Settings); Cin7 Core "Inventory" (locations in Settings reference books); Shopify Products/Inventory (Settings > Locations). Sources: sections 1, 3, 4, 7, 8, 9, 10 above.
- **Split:** Fishbowl (Materials vs Setup > Location; receiving in Purchasing, picking and shipping in Sales); NetSuite (record-type menus; role centre "Inventory" tab; separate WMS app).
- **No studied product has sibling top-level "Inventory" and "Warehouse" items that both hold stock pages.** Where "warehouse" appears, it is either the umbrella name (Veeqo) or a sub-area inside Inventory (Zoho "Warehouse Operations", Odoo Configuration "Warehouse Management").
- Names in use: **Inventory** (Odoo, Cin7, ShipHero, Zoho, Shopify) is the majority, then **Stock** (Katana, ERPNext), then **Warehouse** (Veeqo).

**Q2. Second-level pattern.**
- Desktop modules converge on a **hybrid**: *Overview → work (operations / queues) → objects (products, stock) → reports → configuration*. Examples: Odoo (Overview / Operations / Products / Reporting / Configuration), ERPNext (Home / Dashboard / documents / Tools / Setup / Reports / Settings), Veeqo (sections by area, then objects).
- **Pure object** second levels appear in ShipHero's Inventory dropdown and Cin7's Inventory module, both of which push "do" to mobile.
- **Flow verbs** appear at the *top* level (Katana Sell/Make/Buy/Stock; Zoho Inventory/Sales/Purchases; Cin7 Sale/Purchase/Production/Inventory) rather than inside the inventory module.
- **Mobile apps are organised by job** (NetSuite Receiving/Inventory; Cin7 Pick/Pack/Receive/Stocktake/Transfer; ShipHero batch types plus Cycle Count; Sortly Workflows).

**Q3. Where purchase or factory orders and inbound shipments sit relative to receiving and putaway.**
- The *order* document usually sits with buying: Odoo Purchase app, ERPNext Buying, Katana Buy, Cin7 Purchase, ShipHero Purchase Orders tab. SMB tools put it in the warehouse area: Veeqo "Warehouse > Purchase Orders", Zoho "Purchases".
- The *receiving* act is a warehouse operation: Odoo Operations > Receipts, ERPNext Stock > Purchase Receipt, Linnworks Stock In, Cin7 WMS Receive. It is often launched from the order (inFlow, Shopify "receiving a PO creates a transfer").
- **Putaway is a sub-step of receiving** (NetSuite Receiving > Putaway; Cin7 "Receive and put away"; Katana putaway transfer after PO receipt; Zoho Putaways from the "Receiving Area"; Odoo putaway rules applied on receipt).
- Shopify's 2026 model separates the PO (ordered and cost) from the transfer/shipment (movement). This matches Freeze Pipe's Factory Order versus Shipment split.

**Q4. Raw materials and consumption when manufacturing exists.**
- The item and its stock stay in the inventory module: Katana Items > Materials, with stock on the Stock screen; Odoo products in Inventory. Consumption and BOMs live in Manufacturing: Katana Make (MO completion consumes); Odoo Manufacturing app; ERPNext Work Order / Stock Entry, with a "Work Order Consumed Materials" report in Manufacturing; Cin7 Production (Assembly, Job, Inventory Write-Off).

**Q5. Floor and mobile surface relative to the desktop module.**
- It is predominantly a **separate app** using the same data: Odoo Barcode, NetSuite WMS, Cin7 Core WMS (configured from the web), ShipHero mobile plus Packing App, Katana Shop Floor (and Warehouse App), Sortly mobile. The exception is inFlow, where one mobile app mirrors the web app's areas.
- Configuration of floor behaviour stays on desktop (Cin7 WMS settings; ShipHero cycle-count setup; Odoo Inventory Settings enabling Barcode).

**Q6. Number of top-level items and depth; what overviews show.**
- Inventory-module second level: Odoo 5 sections, depth 3 (Operations > Transfers > Receipts). ShipHero Inventory has 8 flat items. Veeqo Warehouse has 6. Cin7 Inventory has about 5. ERPNext Stock has 7 links plus 4 collapsible groups with about 45 children (clutter).
- Overview pages: Odoo shows one card per operation type with ready / waiting / late / back-order counts [CODE]. ShipHero's mobile dashboard shows ready-to-ship and pickable counts. Katana's Stock list has in stock / committed / expected per item.

**Q7. Naming that reads well to a non-technical owner.**
- Quantities: "Inventory" or "Stock". Counts: Shopify and Sortly "Stock counts", Katana "Stocktakes", Cin7 "Stocktake", Odoo "Physical Inventory" (less plain). Moves: "Transfers" (Shopify, Cin7), Veeqo "Warehouse Transfers". Inbound: "Receipts" (Odoo), "Receiving" (NetSuite, ShipHero), "Stock In" (Linnworks). Places: "Locations" everywhere; bins are "Storage bins" or "Bin Locations" (Katana) or "Sublocations" (Finale, inFlow). Config buckets: "Configuration" (Odoo), "Setup" (ERPNext, Fishbowl), "Settings" (Katana, Veeqo, Shopify, Cin7).

**Q8. Elegant consolidation versus clutter.**
- **Elegant:** Odoo (5 stable sections, feature-gated items, work surfaced as Overview cards); Veeqo (4 sections; Warehouse bundles stock, POs and transfers); Sortly (a Workflows tab of to-dos); Shopify (Locations in Settings; Inventory, Transfers and POs together).
- **Clutter:** ERPNext Stock sidebar (20 report links in the sidebar; 60+ links on the workspace); Zoho before regrouping (the sidebar needed scrolling, by Zoho's own admission); Fishbowl (warehouse work spread across Purchasing, Sales, Materials and Setup).

## Three candidate IA patterns for a merged Freeze Pipe module

All three remove the separate "Warehouse" group. They keep **Floor (/go)** as the phone surface for staff, so pages run on desktop for managers and on the phone for floor work. They assume roughly 9–10 pages today: Stock Levels, Shipments, Factory Orders, Materials, Overview, Map, Putaway, Counts, Locations, Pick & Pack (soon).

### Pattern A: "Odoo grammar" (Overview + Work + Stock + Setup) under one **Inventory** group
```
Inventory
  Overview          ← operation cards: Arriving (shipments in transit) · To put away · To pick & pack · Counts due · Low stock
  ── Work ──
  Receiving         ← inbound shipments, carton-level receive (today's /freight list)
  Putaway
  Pick & Pack
  Counts
  ── Stock ──
  Stock Levels      ← toggle By SKU / By location; link to Map
  Materials         ← raw materials & packaging, consumption tab
  Map
  ── Orders ──
  Factory Orders
Settings
  Locations (racks/bins), putaway rules, count frequency
```
- **Pros:** Mirrors the most-cited consolidated product (Odoo: Overview / Operations / Products / Reporting / Configuration). Work queues are surfaced on the Overview with counts. Locations become configuration, as in Odoo, Cin7, Veeqo, Katana and Shopify. One group name the owner already uses.
- **Cons:** About 10 items in one group sits in NN/g's 6–15 "section menu" band, so it needs visual sub-headings or will feel long. Factory Orders is a buying document (Odoo, ERPNext and Katana put POs in Purchase/Buy), so its placement is debatable.
- **Resembles:** Odoo Inventory (strongly), ERPNext Stock (structure, minus the clutter), Zoho Inventory with its Warehouse Operations sub-area.

### Pattern B: "Flow" split (Inbound → Stock → Outbound), Katana/Veeqo style
```
Inbound            (or "Buy")
  Factory Orders
  Shipments        ← receive cartons here
  Putaway
Inventory          (or "Stock")
  Overview
  Stock Levels
  Materials
  Counts
  Map
Fulfilment
  Pick & Pack
Settings
  Locations
```
- **Pros:** Each group is short (3–5 items, under NN/g's accordion threshold). It follows the physical flow from factory order to shipment to receive and put away to stock to pick and ship. It matches Katana (Buy / Stock / Sell), Veeqo (Fulfilment / Warehouse), Zoho (Purchases / Inventory / Sales) and ERPNext (Buying PO / Stock receipt). Putaway sits with receiving, as in NetSuite, Cin7 and Katana.
- **Cons:** Three groups replace two, so the sidebar does not get shorter. Pick & Pack alone in a group is thin until order and returns pages exist. "What is happening in the warehouse today" is spread over three groups unless the Overview aggregates them.
- **Resembles:** Katana, Veeqo, Zoho, Cin7 Core top level, NetSuite WMS mobile flow menus.

### Pattern C: "Object hub + Floor app" (small desktop module; all doing on the phone)
```
Inventory
  Overview          ← queue counts + exceptions (late shipments, count variances, low stock)
  Stock             ← SKUs; detail has Locations / Movements / Inbound tabs
  Materials
  Inbound           ← Factory Orders + Shipments as two tabs of one page
  Locations & Map   ← one page: map view ⇄ list view
Floor  (/go, phone)
  Receive · Put away · Pick & Pack · Count · Move · Look up
Settings
  Location setup, rules
```
- **Pros:** Shortest desktop sidebar (5 items). It matches how ShipHero (Inventory dropdown plus mobile), Cin7 Core (Inventory module plus WMS app), Odoo (Inventory plus Barcode) and NetSuite (desktop plus WMS mobile) separate manager and floor. Phones with Bluetooth scanners already exist, and a `/go` Floor entry already exists in the sidebar. Putaway and Counts become floor jobs whose queues managers monitor on Overview.
- **Cons:** Managers lose a direct desktop list for putaway or counts unless the Overview cards link into filtered lists (Odoo cards solve this). It relies on Floor being complete for every job. Desktop exception handling (approving count variances, reassigning putaway) needs a home, such as a drawer from the Overview.
- **Resembles:** ShipHero, Cin7 Core, Odoo plus Barcode, Shopify (Inventory, Transfers and POs under Products; Locations in Settings; POS or mobile for receiving).

### Inferences across patterns
- Every studied consolidated product puts **location setup** in Configuration or Settings and **stock-by-location** as a view of inventory. A standalone "Locations" sidebar item is the first candidate to remove.
- **Putaway belongs to receiving** in four products' navigation (NetSuite, Cin7, Katana, Zoho). It should sit next to Shipments or Receiving, or be a floor job, not a peer of Map.
- An **Overview with operation cards and counts** is the consolidation tool that lets queues leave the sidebar. This is Odoo's signature, ShipHero's mobile dashboard, and Sortly's Workflows.
- A hybrid of A and C (Pattern A's grouping, with Putaway, Counts and Pick & Pack living mainly in Floor and exposed on desktop through Overview cards) is plausible. That judgement is mine, not a pattern observed in one product.

### Overall gaps
- No first-hand UI observation or screenshots of any product. The Odoo and ERPNext trees come from source code, which is reliable for labels and hierarchy but not for visual grouping.
- Not verified: Cin7 Omni, SkuVault Core, Finale and Brightpearl navigation labels; NetSuite WMS full main menu; current Fishbowl Advanced module groups; Shopify's exact Products sub-menu labels.
- No usability study was found comparing "Inventory + Warehouse as two modules" against "one module". The recommendation rests on product convergence, not on measured outcomes.
