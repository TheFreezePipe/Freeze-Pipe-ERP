# SMB E-commerce WMS / Pick-and-Pack Feature Benchmark (as of October 2026)

Research date: 2026-10-19. All pricing and feature statements were gathered from public web pages in October 2026 and are only as current as the cited page. Vendor marketing claims are labeled "(marketing)". Where aggregators (Capterra, CostBench, rfp.wiki, etc.) disagree with vendor pages, the conflict is noted. Many vendors do not publish pricing; those are listed as quote-only. Note: rfp.wiki comparison pages appear to be AI-generated and were treated as low-confidence.

Scope context: Freeze Pipe (one small warehouse, 2-5 staff, a few hundred SKUs, Shopify -> ShipStation) is considering a custom module with a 3D warehouse map, unit/carton location assignment, mobile guided pick-and-pack with path optimization and pick-to-tote, real-time ShipStation integration, and eventual pick-to-light.

---

## 1. Feature matrix: Group A products (location model, mobile, pick methods, path, pack verify, cartonization, ShipStation, pricing)

### Takeaway
Among SMB products, the mature picking feature set (mobile app, batch picking with a tote per order, bin-sorted routes, scan-to-verify) is available from about $350-$1,000/month; ShipStation itself already bundles mobile picking (Standard) and pick-to-tote plus scan-to-verify (Premium), so the custom module is displacing roughly $150-$1,350/month of ShipStation plan cost only if it replaces ShipStation, but more realistically it displaces a $499-$2,000/month WMS or an add-on to ShipStation. Only SKUSavvy (not on the supplied list) clearly advertises a 3D/visual warehouse map.

### Cited Findings

**ShipStation (own warehouse features)**
- Plan pricing (monthly billing; shipments/month tiers): Starter (3 users) from $14.99 (50 shipments) to $174.99 (5,000); Standard (10 users) $29.99 (50) / $149.99 (1,000) / $249.99 (5,000); Premium (15 users) $349.99 (50) / $599.99 (1,000) / $799.99 (5,000). Annual billing advertised as 20% off. — [ShipStation pricing](https://www.shipstation.com/pricing/)
- Warehouse feature gating: pick lists and packing slips on all tiers; mobile picking, barcode scan/verify/print, barcode hot keys, analytics/performance dashboard on Standard+; Pick to Tote, Cubiscan (dimensioning hardware) on Premium only; inventory sync, bundles, lot and serial tracking on Standard+; purchase orders, scan-to-receive, forecasting/reorder assist on Premium. — [ShipStation pricing](https://www.shipstation.com/pricing/)
- ShipStation says Pick-to-Tote, Picking Exceptions, Scan to Verify are Premium and Pick to Light is "coming soon" (Premium); batch statuses are Ready to Pick / Picking / Picked; a second picker can take over a partly finished batch (announced as upcoming). — [ShipStation blog: warehouse picking and packing](https://www.shipstation.com/blog/warehouse-picking-packing/); [ShipStation WMS page](https://www.shipstation.com/fulfillment/warehouse-management/)
- ShipStation claims mobile picking gives "30-40% increase in labor efficiency compared with printed pick lists" (marketing). Overpick prevention, pause/resume, flag exceptions (low stock, substitutions). — [ShipStation WMS page](https://www.shipstation.com/fulfillment/warehouse-management/)
- Bin locations are not described as a standalone feature; the blog says pick-list templates can show "product images, bin locations, SKU priority". No explicit path-optimization claim was found on ShipStation's own pages. — [ShipStation blog](https://www.shipstation.com/blog/warehouse-picking-packing/); [ShipStation WMS page](https://www.shipstation.com/fulfillment/warehouse-management/)
- The ShipStation WMS page did not mention cycle counting, receiving, or dedicated warehouse reporting. — [ShipStation WMS page](https://www.shipstation.com/fulfillment/warehouse-management/)
- SKUSavvy (a competitor, so treat as unverified) says ShipStation lacks bin-level tracking, optimized pick path, tote batching, replenishment prompts, cycle counts, wave picking, putaway and per-employee pick tracking. — [SKUSavvy blog](https://skusavvy.com/blog/why-shipstation-needs-a-wms-upgrade-what-to-use)

**ShipHero**
- Entry price reported at about $1,995/month (Brands, 5 users, unlimited orders), $2,145 for 3PLs, extra users about $150/month each. One site (CostBench) claims a Feb 2026 price drop to "$15/month"; this looks implausible and conflicts with every other source - treat as unconfirmed. — [Eightx](https://eightx.co/blog/compare/how-much-does-shiphero-cost); [Toolradar](https://toolradar.com/tools/shiphero/pricing); [CostBench changelog](https://www.costbench.com/changelog/shiphero-price-decrease-2026-02/). ShipHero's own /pricing URL returned 404; its site gives no prices ("Book a Demo"). — [ShipHero home](https://www.shiphero.com/)
- Modules (marketing): order/inventory/returns management, picking and packing, live carrier rate shopping, receiving and putaway, mobile replenishment, labor management (WorkforceHero), AI Picking, work orders, 3PL portal; labor-cost, picker and packer performance dashboards. — [ShipHero home](https://www.shiphero.com/)
- Mobile app is native (iOS user guide exists); a Capterra reviewer says Android handheld scanners are not supported. — [ShipHero iOS user guide](https://software-help.shiphero.com/hc/en-us/articles/8497107616269-User-Guide-to-the-ShipHero-iOS-Mobile-App); [Capterra ShipHero reviews](https://capterra.com/p/166930/ShipHero/reviews/)
- Pick methods: Single-Item Batch (SIB, all orders share one tote, packer separates) and Multi-Item Batch (MIB, one tote per order). — [ShipHero Mobile Picking Interface (beta)](https://software-help.shiphero.com/hc/en-us/articles/40363495768077)
- Does not mention ShipStation on its home page; ShipHero is itself a shipping/WMS platform with rate shopping, so it generally replaces ShipStation rather than integrating with it. A ShipStation-to-ShipHero connector exists only via iPaaS vendors (one-way, ShipStation to ShipHero). — [ShipHero home](https://www.shiphero.com/); [iPaaS.com dataflow](https://ipaas.com/integrations/dataflow/shipstation-and-shiphero/)

**Veeqo (Amazon)**
- Plans: Shipping free (unlimited orders); Inventory from $19/month and High Volume from $350/month, both priced by order volume; unlimited users, warehouse locations and SKUs on all plans; picking, "Veeqo scanner" and team picking stats listed under Inventory and High Volume. — [Veeqo pricing](https://www.veeqo.com/pricing)
- Picking: batches default to 10 orders, max 20 items; methods Single Tote ("Pick to Pile"), Pick to Order (tote per order), and "Most Efficient" (pile if more than 50% of orders are single-line); bin locations entered on product page or CSV; products presented in ascending bin order; scan or tap to confirm; hardware is the Veeqo Scanner or the mobile app; multiple pickers/packers concurrently. — [Veeqo digital picking help](https://help.veeqo.com/en/articles/8306650-digital-picking-overview)
- Cycle stock takes via scanner or Android/iOS app; returns with refund/restock/write-off; one-click POs for below-reorder items. — [Veeqo features (search results)](https://www.veeqo.com/features/returns); [Veeqo inventory features](https://veeqo.com/inventory-management-software-system/inventory-features)
- Veeqo integrates with ShipStation? Not found. Veeqo has its own shipping (free Shipping plan), so it is an alternative to, not an add-on for, ShipStation. (No source stating integration was found.) — [Veeqo pricing](https://www.veeqo.com/pricing)

**Packiyo**
- Published plan: "3PL" $949/month, 5 users, up to 5,000 shipments/month; Starter and Enterprise are quote-only. Third-party sites list $599 (FitGap) or $850 (Capterra Singapore); these conflict. — [Packiyo pricing](https://www.packiyo.com/pricing); [FitGap](https://us.fitgap.com/products/packiyo-wms); [Capterra SG](https://www.capterra.com.sg/software/1042504/packiyo)
- Features: batch picking, guided pick/pack, configurable packing validation rules, barcode validation, returns, multi-client dashboards (fulfillment performance, shipping spend, inventory velocity, productivity). Cartonization, mobile app, cycle counts, replenishment, hardware and ShipStation were "not mentioned" on its features page. — [Packiyo features](https://www.packiyo.com/features)
- Packiyo's mobile app supports picking and "Copilot" rules can assign boxes and shipping methods automatically (directory description). — [FitGap](https://us.fitgap.com/products/packiyo-wms)
- No evidence found that Packiyo is open source; sources describe it as commercial cloud SaaS. — [FitGap](https://us.fitgap.com/products/packiyo-wms)

**Logiwa**
- Quote-only pricing; one review calls it steep for small operations; another source says it suits mid-to-large operations. — [Software Advice](https://www.softwareadvice.com/distribution/la-wms-profile/); [ToolsForHumans](https://www.toolsforhumans.ai/ai-tools/logiwa)
- Reviewers/aggregators say it supports wave, batch, zone, cluster and voice picking, and a DTC "multi-item order" job: mobile order picking -> pick and sort by tote -> pack and print labels -> ship; cartonization and returns depth described as weaker; pre-built KPI dashboards (order cycle time, picking accuracy, labor productivity) per aggregator. (low-confidence aggregator content) — [rfp.wiki Logiwa](https://www.rfp.wiki/supply-chain-logistics-transportation/third-party-logistics/logiwa); [Dupple](https://dupple.com/learn/best-warehouse-management-software)

**SkuVault Core (Linnworks)**
- Pricing: formerly $449 (up to 2,000 orders), $849 (2,001-5,000), $1,349 (5,001-10,000); tiers later hidden, "starting at $449/month"; ITQlick says $349 (conflict). A September 2026 change restricted Core's QC, 3PL and serialization features to North America. — [PricingSaaS history](https://pricingsaas.com/companies/skuvault/diffs/2024Q3); [PricingSaaS Sep 2026](https://pricingsaas.com/companies/skuvault/diffs/2026W38); [ITQlick](https://www.itqlick.com/skuvault-software/pricing)
- Marketing claims: "automatically generates the most efficient pick route" for paper or digital pick lists; paperless wave picking with built-in QC; connects to shipping tools "like Shipstation"; no mobile app or cycle count mentioned on that page. — [Linnworks SkuVault WMS page](https://www.linnworks.com/core/sv-warehouse-management-na)

**Finale Inventory**
- Essentials from $499/month; Growth from $799/month; Enterprise custom; barcode/mobile WMS module (Wi-Fi handhelds, wave/batch/pick-and-pack, lot/serial/expiry, label printing) is "included with Growth and Enterprise"; 12/24/36-month contracts common; ShipStation listed as a shipping integration but no plan details. — [Finale pricing](https://www.finaleinventory.com/pricing/)

**Zenventory**
- Starter $499/month (10,000 shipments, 1 warehouse), Growth $799 (50,000 shipments, 3 warehouses), $1,000 setup fee, first 3 months half price, unlimited users, extra warehouses $100/month; pick and pack, cycle counting, POs, transfers on all plans; Android mobile app. — [Zenventory pricing](https://www.zenventory.com/pricing)
- ShipStation integration: sync interval "15 minutes (maximum)" in each direction. — [Zenventory ShipStation page](https://www.zenventory.com/integration/shipstation)

**inFlow Inventory**
- Pricing sources conflict: Capterra $186/$436/$999 per month; CostBench Aug 2026 snapshot $161/$436/$874. Mobile app (iOS/Android) included in all plans, with "Guided Picking" (marketing); rugged Android scanner sold separately. — [Capterra inFlow pricing](https://capterra.com/p/78431/inFlow-Inventory/pricing/); [CostBench inFlow](https://costbench.com/software/inventory-management/inflow); [inFlow mobile](https://inflowinventory.com/features/mobile)
- ShipStation: when an order is fully picked, inFlow sends it to ShipStation as a pending shipment, then pulls back carrier, tracking and ship date. — [inFlow ShipStation support](https://www.inflowinventory.com/support/cloud/connecting-inflow-to-shipstation)

**Cin7 Core**
- $349 Standard / $599 Pro / $999 Advanced per month (one source says Advanced $1,199); seat counts conflict (5 vs 10 users). Standard WMS is single warehouse; Advanced WMS adds more (sources conflict on whether tier or add-on). Cin7 says Core offers directed and zone picking. — [Eightx Cin7](https://eightx.co/blog/compare/how-much-does-cin7-cost); [ERPResearch](https://erpresearch.com/erp-add-ons/distribution/cin7-core/pricing); [Cin7 Core help: WMS intro](https://help.core.cin7.com/hc/en-us/articles/9034461577487-Introduction-to-Warehouse-Management-System-WMS)

**Ordoro**
- Sources conflict. FitGap (citing Ordoro): Shipping Essential free (100 orders), Advanced $59 (3,000), Premium $149; Inventory Advanced $349 and Premium $499 (1,000 orders each; $100 per extra 1,000). Capterra also lists Dropshipping around $299. — [FitGap Ordoro](https://us.fitgap.com/products/011340/ordoro); [Capterra Ordoro](https://www.capterra.com/p/126681/ordoro/)
- Capterra highlights kitting, PO management, API, write-back of stock and shipping confirmations; no picking workflow details were found. — [Capterra Ordoro](https://www.capterra.com/p/126681/ordoro/)

**Peoplevox (Descartes)**
- Vendor pages list platform fee from $2,050/month, users about $195-$234/month each, add-ons from $255/month, implementation about $9,600-$11,600 (two vendor versions disagree). Pick-and-sort-to-trolley is a paid add-on; mobile scanning and offline mode included; Shopify tier $99/month for under 100 daily parcels. — [Peoplevox pricing](https://www.peoplevox.com/pvx-pricing/); [Shopify listing](https://apps.shopify.com/descartes-peoplevox-wms)

**Pulpo WMS**
- Aggregators cite Power plan $590/month and 3PL plan $1,290/month; Startup and Enterprise quote-only; web app plus Android app; picking methods described inconsistently; one description mentions "digital warehouse mapping" (not verified; no 3D confirmed). — [Capterra Pulpo](https://www.capterra.com/p/168648/Clover/); [rfp.wiki Pulpo](https://www.rfp.wiki/supply-chain-logistics-transportation/third-party-logistics/pulpo-wms)

**Hopstack, Shipedge, Deposco, Easy WMS, Infoplus, Extensiv Warehouse Manager, Fulfil.io**
- Hopstack: quote-based; product page names mobile ops, rule engines, audit trails, kitting; no 3D map, no pick-to-light, no named picking methods, ShipStation not named. — [Hopstack WMS](https://www.hopstack.io/products/hopstack-wms); [AWS Marketplace](https://aws.amazon.com/marketplace/pp/prodview-qh6z2nz6ak4ac)
- Shipedge: entry about $500/month (Software Advice listing), unpublished tiers; FIFO/LIFO picks, rate shop, kitting, returns, BI reporting (listing text). — [Software Advice Shipedge](https://www.softwareadvice.com/manufacturing/shipedge-profile/); [GetApp Shipedge](https://www.getapp.com/operations-management-software/a/shipedge/pricing)
- Deposco Bright Warehouse: quote-only; median contract about $11,000/year from only 4 data points; one review says not recommended below $25M revenue; cartonization listed under advanced picking on that tier; Bright Basics is the SMB offer. — [CostBench Deposco](https://www.costbench.com/software/warehouse-management/deposco/); [SoftwareConnect Deposco](https://softwareconnect.com/reviews/deposco-bright-warehouse/)
- Mecalux Easy WMS: pricing on request; listed features include wave picking, kitting, cross-docking, putaway, barcode labeling, multi-carrier shipping module; no mobile picking evidence found. — [Capterra Easy WMS](https://www.capterra.com/p/114409/Easy-WMS/); [Software Advice Easy WMS](https://www.softwareadvice.com/scm/easy-wms-profile/)
- Infoplus: quote-only; Capterra 4.4 (116 reviews); G2 "visualization" score refers to reporting, not a bin map; ShipStation integration not confirmed in search results. — [Capterra Infoplus](https://www.capterra.co.uk/software/158602/infoplus); [G2 Infoplus vs Logiwa](https://www.g2.com/compare/infoplus-wms-vs-logiwa-corp-logiwa)
- Extensiv Warehouse Manager: 3PL-focused (multi-client, billing); no published rates (an aggregator's $99 figure is unverified); help center documents guided/non-guided pick, pick to carton, packing in 1+ cartons ("double verification"), mobile packing; no automated cartonization found. — [Extensiv help: order packing](https://help.extensiv.com/wm-order-pickpack-information/1619031-order-packing); [Extensiv help: guided pick](https://help.extensiv.com/en_US/1619027-step-by-step-guided-order-pick-on-device); [ToolsForHumans Extensiv](https://www.toolsforhumans.ai/ai-tools/extensiv-3pl)
- Fulfil.io: ERP with WMS; no published pricing; a directory benchmark of $1,000/user/month plus implementation estimates is unverified. — [SoftwareFinder Fulfil](https://softwarefinder.com/enterprise-resource-planning-software/fulfil); [Shopify listing](https://apps.shopify.com/fulfil-retail-erp)

**SKUSavvy (not on list; closest to the proposed 3D map concept)**
- Order-volume pricing: free under 50 orders/month, then $0.25/order (50+) down to $0.06 (100k+); all inbound/outbound/POS/cross-dock orders count; unlimited users/locations; optional onboarding $2,750 + $250/month. An SKUSavvy comparison shows $324.19/month at 1,000 orders vs ShipStation Standard $149.99 (competitor-authored). — [SKUSavvy pricing](https://skusavvy.com/skusavvy-pricing); [SKUSavvy ShipStation page](https://skusavvy.com/shipstation-wms)

### Inferences
- A mobile pick app with bin-sorted routing, tote-per-order, and scan-to-verify is available in the $350-$1,000/month band; Freeze Pipe's realistic "displaced spend" is a WMS subscription of $350-$2,000/month (or an upgrade from ShipStation Standard to Premium) plus implementation fees ($1,000 setup at Zenventory, $2,750 at SKUSavvy, ~$10k at Peoplevox).
- Several incumbents (ShipHero, Veeqo, Ordoro, Packiyo 3PL plan) are shipping platforms that replace ShipStation; only the ERP-style products (inFlow, Zenventory, SkuVault, Cin7) explicitly integrate with ShipStation. A custom module that stays on ShipStation is architecturally closer to the Zenventory/inFlow/SkuVault pattern.

### Gaps
- Official pricing pages for ShipHero, Logiwa, Hopstack, Infoplus, Easy WMS, Deposco, Fulfil, Extensiv were unavailable (quote-only or 404); numbers above are third-party.
- Per-product detail on LPN/container models, multi-level location hierarchies, and cartonization was not retrievable for most products; vendor pages are thin.
- Peoplevox, Pulpo, Shipedge, Easy WMS ShipStation integration depth was not found.
- No G2 review text was retrievable (G2 pages mostly return only summary or comparison content); Reddit threads did not appear in search results.

---

## 2. Group B: open-source reference designs (Odoo, ERPNext/Frappe, OpenBoxes, Packiyo)

### Takeaway
Odoo is the most complete open-source reference for batch/wave/cluster picking, putaway with capacity-limited storage categories, and removal strategies; ERPNext's pick list is simpler (multi-order pick lists, FIFO/expiry-based warehouse selection, but warehouses are logical, not bins); OpenBoxes is useful for lot/bin allocation rules (first-expiring lot, then smallest-quantity bin) and min/max/reorder per location. Packiyo is not open source.

### Cited Findings
- Odoo batch picking: one picker handles multiple orders; requires enabling "Batch, Wave & Cluster Transfers", Storage Locations and Multi-Step Routes; manual or automatic batches grouped by Contact, Carrier, Destination Country, Source Location or Destination Location; after picking, products go to an output location to be sorted into packages. — [Odoo batch picking docs](https://www.odoo.com/documentation/master/applications/inventory_and_mrp/inventory/shipping_receiving/picking_methods/batch.html)
- Odoo wave transfers: a wave is a batch with an extra step - picking lines are split first and then grouped; waves only contain lines from the same operation type; can group by product, location or carrier; automatic waves by Product or Product Category; assign Responsible, dock location, vehicle. — [Odoo wave docs (19.0)](https://www.odoo.com/documentation/19.0/applications/inventory_and_mrp/inventory/shipping_receiving/picking_methods/wave.html)
- Odoo cluster picking: each picking gets a reusable destination package (e.g., CLUSTER-PACK-1/2/3), set per product in Detailed Operations. — [Odoo cluster picking docs](https://www.odoo.com/documentation/master/applications/inventory_and_mrp/inventory/shipping_receiving/picking_methods/cluster.html)
- Odoo Barcode app batch screen: lines grouped by storage location; same-order lines share a left-edge color; completed pickings turn green; app prompts "Scan the source location barcode", then product and package; destination package name shown in italics under the product; serial-tracked products prompt for serial; counters like "3/3". — [Odoo barcode batch docs](https://www.odoo.com/documentation/master/applications/inventory_and_mrp/barcode/operations/process_transfers.html)
- Odoo storage categories (16.0 docs): extra location attribute used by putaway rules; capacity by weight, by product, or by package type; "Allow New Product" setting (empty only / same product only / mixed). — [Odoo storage categories (16.0)](https://www.odoo.com/documentation/16.0/applications/inventory_and_mrp/inventory/shipping_receiving/daily_operations/storage_category.html)
- Odoo removal strategies: FIFO, LIFO, FEFO, Closest Location, Least Packages (official docs reference); set on product category or location. — [Odoo removal strategies (16.0)](https://cdn.odooapp.cn/documentation/16.0/applications/inventory_and_mrp/inventory/routes/strategies/removal.html)
- Odoo 3D layout: a third-party app "Smart Warehouse Visualizer" (Odoo 18) offers a WebGL drag/drop/rotate rack and bin designer with occupancy heatmap coloring, about $98. — [Odoo Apps: warehouse visualizer](https://apps.odoo.com/apps/modules/18.0/warehouse_visualizer)
- ERPNext Pick List: created from a Sales Order or directly, "Get Items" pulls multiple pending Sales Orders into one Pick List; warehouses suggested FIFO; batched items choose the batch nearer expiry; submitted Pick List creates a Delivery Note; "Pick Manually" prevents overwrite. — [ERPNext Pick List docs](https://docs.frappe.io/erpnext/user/manual/en/pick-list)
- ERPNext limits (vendor ECOSIRE claim, unverified): warehouses are logical buckets rather than physical bins, only basic Putaway Rules, no batch picking across multiple orders in native form; the vendor sells an add-on adding Storage Bin, wave/pick tasks, FEFO enforcement. — [ECOSIRE ERPNext Advanced WMS](https://ecosire.com/apps/erpnext/erpnext-advanced-wms) (vendor; note conflict with ERPNext docs that multi-order pick lists exist via Get Items)
- OpenBoxes: Pick page assigns specific lots and bin locations; default allocates first-expiring lot, then smallest-quantity bin; printable picklist; min/max/reorder per product and location; separate movement types for receipts, movements, replenishments, returns; stock adjustment and count workflow documented via training course. — [OpenBoxes docs: benefits](https://docs.openboxes.com/en/latest/about/benefits/); [OpenBoxes picklist/outbound docs](https://openboxes.helpscoutdocs.com/article/302-outbound-shipment-documents)
- Packiyo: described as commercial cloud SaaS; no open-source reference found. — [FitGap Packiyo](https://us.fitgap.com/products/packiyo-wms)

### Inferences
- Odoo's data model (location hierarchy, package types as tote/box entities, putaway rules with capacity, removal strategy, batch -> wave -> cluster as progressive grouping, destination package per picking) is a good schema template for the custom module on Supabase.
- Open-source references do not provide true path optimization; Odoo groups lines by location only.

### Gaps
- Odoo putaway-rule documentation for 19.0 was not retrieved from the official site (only 16.0 storage category page); Odoo 19 claims (seven removal strategies, rule priorities) are from a third-party blog (ecosire) and unconfirmed.
- OpenBoxes cycle count and putaway specifics were only available through course listings.
- No separate "Frappe" WMS product was found beyond ERPNext.

---

## 3. Table-stakes capabilities across serious SMB pick-and-pack systems

### Takeaway
Every serious product reviewed provides: barcode/scan-driven picking on a mobile or scanner device, bin/location assignment per SKU, batch picking with either tote-per-order or single pile, scan-to-verify at pack with label print before shipment, inventory sync to sales channels, cycle counting/stock takes, PO receiving, and basic reporting. Bin-ordered pick routing is nearly universal; mapped/graph-based routing is not.

### Cited Findings
- Barcode scan-to-confirm picking with mobile device/scanner: ShipStation (Standard), Veeqo, ShipHero, inFlow, Zenventory, Finale (barcode module), Peoplevox, Pulpo (Android). — [ShipStation pricing](https://www.shipstation.com/pricing/); [Veeqo help](https://help.veeqo.com/en/articles/8306650-digital-picking-overview); [ShipHero MPI](https://software-help.shiphero.com/hc/en-us/articles/40363495768077); [inFlow mobile](https://inflowinventory.com/features/mobile); [Zenventory pricing](https://www.zenventory.com/pricing); [Finale pricing](https://www.finaleinventory.com/pricing/); [Peoplevox](https://apps.shopify.com/descartes-peoplevox-wms)
- Scan-to-verify at packing and gate label print on match: ShipStation (Premium), Packiyo validation rules, Extensiv double verification, inFlow scans into Ship tab. — [ShipStation WMS](https://www.shipstation.com/fulfillment/warehouse-management/); [Packiyo features](https://www.packiyo.com/features); [Extensiv help](https://help.extensiv.com/wm-order-pickpack-information/1619031-order-packing); [inFlow support](https://inflowinventory.com/support/cloud/how-can-i-pick-ship-the-items-on-my-sales-order)
- Cycle counting / stock takes: Zenventory (all plans), Veeqo (cycle stock takes), Packiyo (listing). — [Zenventory pricing](https://www.zenventory.com/pricing); [Veeqo inventory features](https://veeqo.com/inventory-management-software-system/inventory-features)
- Returns: Veeqo (restock/write-off/reasons), ShipHero returns management, Packiyo reverse logistics, Shipedge. — [Veeqo returns](https://www.veeqo.com/features/returns); [ShipHero home](https://www.shiphero.com/); [Packiyo features](https://www.packiyo.com/features)
- Purchase orders / receiving / reorder points: Veeqo, ShipStation Premium, Zenventory, Ordoro. — [Veeqo inventory features](https://veeqo.com/inventory-management-software-system/inventory-features); [ShipStation pricing](https://www.shipstation.com/pricing/); [Zenventory pricing](https://www.zenventory.com/pricing)
- Lot/serial/expiry (FIFO/FEFO): ShipStation Standard+, Finale, Zenventory, Shipedge. — [ShipStation pricing](https://www.shipstation.com/pricing/); [Finale pricing](https://www.finaleinventory.com/pricing/)
- Batch picking with multi-user concurrency and status tracking: ShipStation (batch statuses), Veeqo (multiple pickers concurrently). — [ShipStation blog](https://www.shipstation.com/blog/warehouse-picking-packing/); [Veeqo help](https://help.veeqo.com/en/articles/8306650-digital-picking-overview)
- Printing: custom pick lists / packing slips with bin locations and barcodes (HTML + Liquid templating at ShipStation). — [ShipStation WMS](https://www.shipstation.com/fulfillment/warehouse-management/)
- Overpick prevention, picking exceptions (empty bin, damaged, qty mismatch -> skip and log), pause/resume: ShipStation; ShipHero "Enforce All Pick Scans" hides manual quantity input and optional location scan before pick. — [ShipStation blog](https://www.shipstation.com/blog/warehouse-picking-packing/); [ShipHero MPI](https://software-help.shiphero.com/hc/en-us/articles/40363495768077)
- Unlimited users and warehouses are common at the low end (Veeqo, Zenventory, SKUSavvy), so per-seat pricing is not a differentiator for a 2-5 person team. — [Veeqo pricing](https://www.veeqo.com/pricing); [Zenventory pricing](https://www.zenventory.com/pricing); [SKUSavvy pricing](https://skusavvy.com/skusavvy-pricing)

### Inferences
- Table-stakes list for the custom module (see Section 11 for the full list): scan-confirmed pick, location-per-SKU, tote-per-order batch, scan-to-verify pack, exceptions flow, cycle counts, receiving/putaway, returns, per-picker stats, audit trail.

### Gaps
- A few items (LPN/container tracking, dock-to-stock) were not confirmed as table stakes by any source in this scan.

---

## 4. Visual / 3D warehouse maps: who offers one and what it does

### Takeaway
Among reviewed SMB products only SKUSavvy clearly markets a 3D/visual warehouse map; its map is used to find bins, view filled/empty bins, show heatmaps, display pick routes, generate cycle count paths, and assign waves/replenishment. No other reviewed SMB WMS (ShipHero, Veeqo, ShipStation, Hopstack, Zenventory, Cin7, Finale) showed a 3D map; Mecalux offers heatmap slotting for larger operations.

### Cited Findings
- SKUSavvy page lists: build map layer-by-layer with racks, shelves, bins, areas, conveyors, packing stations, zones; view filled vs empty bins; heatmaps by activity for slotting; automated pick routes shown on the map; cycle counts with a count path; assign pick waves, cross-dock requests and replenishment from the map; map-guided putaway; 3D inventory search; viewable "on any device". No dimensions/capacity, performance data, or pricing on that page; claims such as "fastest cycle count path" and "pinpoint accuracy" are marketing. — [SKUSavvy warehouse mapping](https://www.skusavvy.com/warehouse-mapping-software)
- SKUSavvy visual page: "point and click editor" for racks/shelves/bins, allocate inventory by dragging on the map, switch rack levels; bin dimensions and capacity are not stated; the only literal "3D" items are image alt text and a separate "3D Palletization" feature (box size suggestions and 3D box packing). — [SKUSavvy visual inventory](https://skusavvy.com/visual-inventory-management-system)
- SKUSavvy runs in the browser on any phone or tablet; cites "over 1,500 brands signed up since 2021" (marketing). — [SKUSavvy ShipStation page](https://skusavvy.com/shipstation-wms); [SKUSavvy visual inventory](https://skusavvy.com/visual-inventory-management-system)
- Odoo third-party "Smart Warehouse Visualizer": WebGL 3D layout designer, drag/drop/rotate racks and bins, occupancy heatmap; about $98. — [Odoo Apps](https://apps.odoo.com/apps/modules/18.0/warehouse_visualizer)
- Mecalux Slotting for WMS: heatmap with filters to check utilization by operation type (aimed at larger operations). — [Mecalux heatmap slotting](https://www.mecalux.com/software/updates/heatmap-slotting)
- 3DLogistiX markets a real-time 3D digital twin for small/mid-size businesses, but its G2 listing has zero reviews (unverified). — [G2 3DLogistiX](https://www.g2.com/products/3dlogistix/discuss)
- Hopstack product page: no visualization tools described; ShelfPilot (Shopify app) has a mobile floor app, free tier 1 warehouse/50 bins, apparently no layout editor or heatmap. — [Hopstack WMS](https://www.hopstack.io/products/hopstack-wms); [ShelfPilot listing](https://pickyourapp.com/products/shelfpilot-3)
- Infoplus' G2 "Visualization" score (9.2 vs Logiwa 6.8) reflects reporting visualization, not a bin map. — [G2 Infoplus vs Logiwa](https://www.g2.com/compare/infoplus-wms-vs-logiwa-corp-logiwa)

### Inferences
- The map's proven use cases are: locate a bin, show occupancy, heatmap for slotting, overlay pick route, generate cycle count path, assign tasks by location. For a few-hundred-SKU, single-room warehouse, the highest-value uses are (1) "where is it / where do I put it" and (2) route overlay and count path; 3D rendering is likely a differentiator for presentation, not a table stake.
- A 3D map that shows every unit and master carton location is ahead of what most competitors ship (they track bin-level quantities, not unit-level positions).

### Gaps
- No pricing or independent user review of SKUSavvy's 3D map was found (no G2/Capterra text retrieved).
- No evidence found on whether Pulpo, Logiwa or Easy WMS have visual bin maps.

---

## 5. Path-optimized picking: what is claimed and how it is described

### Takeaway
Documented "path optimization" in SMB products is mostly sorting pick lines by location code (ShipHero explicitly; Veeqo ascending bin order), with ShipHero adding pick-priority and "pick down" rules; SkuVault and SKUSavvy claim "most efficient route" without describing the algorithm. No SMB vendor documented a graph/aisle-aware algorithm.

### Cited Findings
- ShipHero: route is calculated when the batch is created (not real-time); factors are pickable inventory (non-pickable bins excluded), pick priority numbers (lower first, only matters when SKU is in several bins; default pick-down visits least-stock bin first), then location name sequence; consistent naming like A-01-01, A-01-02, A-02-01 yields aisle-by-aisle path; inventory added to a new location after batch start won't appear. — [ShipHero pick path article](https://software-help.shiphero.com/hc/en-us/articles/46894155095565)
- ShipHero: if the app can't generate a path, stock may sit only in non-pickable bins; fix by transferring stock to a pickable location. — [ShipHero batch load article](https://software-help.shiphero.com/hc/en-us/articles/4419345822093-Why-are-batches-taking-so-long-to-load)
- ShipHero's Picker Performance dashboard needs location-aware picking so it can compute walking distance per batch; unmapped areas make batches unscored. — [ShipHero picker performance dashboard](https://software-help.shiphero.com/hc/en-us/articles/42452761934861-Picker-Performance-Dashboard)
- Veeqo: each batch comes with an "optimized path"; products listed in ascending bin location, with bin codes sorting as text (pad numbers: 02, not 2). — [Veeqo digital picking help](https://help.veeqo.com/en/articles/8306650-digital-picking-overview); [Veeqo picking page](https://www.veeqo.com/gb/picking-and-packing-software)
- SkuVault Core (marketing): "automatically generate the most efficient pick route" for paper or digital lists. — [Linnworks SkuVault WMS page](https://www.linnworks.com/core/sv-warehouse-management-na)
- SKUSavvy (marketing): automated pick routes shown on the visual map; route planning "reduces travel time". — [SKUSavvy warehouse mapping](https://www.skusavvy.com/warehouse-mapping-software)
- ShipStation: no explicit route-optimization claim found; the pick-to-tote claim is reduced walking from batching. — [ShipStation blog](https://www.shipstation.com/blog/warehouse-picking-packing/)
- Academic routing heuristics: S-shape (traverse every aisle with a pick), largest-gap (enter aisle only to the biggest unvisited gap), combined/aisle-by-aisle hybrid; results vary by layout and pick density; largest-gap tends to win with few picks per aisle; one simulation reported S-shape optimality gaps of 18-28% vs 31-37% for largest-gap; a "MinH" heuristic reportedly beat standard policies by about 14%. — [Roodbergen routing background](https://www.roodbergen.com/warehouse/background.php); [ERIM routing strategies](https://erim.eur.nl/material-handling-forum/research-education/tools/calc-order-picking-time/what-to-do/routing-strategies); [Udemedellin evaluation](https://repository.udemedellin.edu.co/items/abc4394a-e430-4ffc-9b80-05520734c3c8)
- Odoo Barcode batch groups lines by storage location (no routing algorithm described). — [Odoo barcode batch docs](https://www.odoo.com/documentation/master/applications/inventory_and_mrp/barcode/operations/process_transfers.html)

### Inferences
- With a location map (aisle/rack coordinates), the custom module can implement S-shape or largest-gap routing, a real step beyond the competitors' sort-by-bin-name, but the incremental benefit in a small single-room warehouse is probably small; ordering correctness (consistent location naming, pickable vs non-pickable flags, pick priority) matters more.
- Treat ShipHero's rules (pickable-only, priority, least-stock-first, compute at batch creation) as a spec for the "which bin do I pick from" decision, separate from "in what order do I visit bins".

### Gaps
- Pricing/benefit studies for small warehouses were not found; the efficiency figures quoted by vendors (e.g., 30-40% from mobile picking) are marketing.

---

## 6. Pick-to-tote / cluster picking on mobile: tote assignment, slot colors, tote scanning

### Takeaway
The common pattern is: batch of about 10 orders (Veeqo default, max 20 items), one tote per order for multi-line orders (or one shared tote for single-line pile picks), tote barcode scan to start, scan item into the right order tote, summary at end. Explicit slot-color UIs are documented only in Odoo (color per picking line) and in the ShipStation Pick-to-Light plan (tote slot lights).

### Cited Findings
- ShipHero MIB: "one tote equals one order"; screen shows how many totes an item belongs to; pickers can split quantities across totes; clearer tote-scan success/failure states; end summary shows tote assignments including "hospital totes" for flagged items; SIB uses one tote for all orders and the packer separates; optional per-account location scan before each pick (wrong scan prompts retry); optional per-user Enforce All Pick Scans hides the manual quantity input. Colors and slots are not mentioned in the article. — [ShipHero MPI beta](https://software-help.shiphero.com/hc/en-us/articles/40363495768077)
- ShipHero SIB flow: log in, choose Single Item Batch, scan a tote, app shows next item, picker confirms quantity. — [ShipHero help 10172821](https://help.shiphero.com/knowledgeBase/10172821)
- Veeqo: Pick to Order (tote per order; no sorting at pack), Single Tote (all orders in one tote scanned at pack station), Most Efficient (pile if more than 50% of orders are single-line); tote need = batch order limit x pickers (e.g., 10 x 3 = 30), doubled if picker and packer differ; totes released when order dispatched; laminate tote barcodes. — [Veeqo digital picking help](https://help.veeqo.com/en/articles/8306650-digital-picking-overview)
- ShipStation: pick-to-tote (Premium) lets a picker sort items for several orders into designated totes; v2 API added a /v2/totes endpoint (GET/POST batch creation, quantities, GET/PUT/DELETE by id) in February 2026; /v2/batches/{id}/user assign/unassign user (September 2026); batch packing slip generation (October 2026). — [ShipStation blog](https://www.shipstation.com/blog/warehouse-picking-packing/); [ShipStation API release notes](https://docs.shipstation.com/apis/release-notes.md)
- Starshipit (another vendor): assign a tote to each order by scanning the tote barcode to link to the order, then move by location placing items in the correct tote. — [Starshipit picking orders](https://support.starshipit.com/articles/14700000000011-picking-orders)
- Odoo Barcode batch screen: lines from the same order share a left-edge color; completed pickings turn green; destination package name displayed under product; cluster picking uses a reusable destination package per picking. — [Odoo barcode batch docs](https://www.odoo.com/documentation/master/applications/inventory_and_mrp/barcode/operations/process_transfers.html); [Odoo cluster docs](https://www.odoo.com/documentation/master/applications/inventory_and_mrp/inventory/shipping_receiving/picking_methods/cluster.html)
- Peoplevox sells "pick-and-sort-to-trolley" as a paid add-on; Logiwa describes a pick-and-sort-by-tote job. — [Peoplevox pricing](https://www.peoplevox.com/pvx-pricing/); [Dupple (Logiwa)](https://dupple.com/learn/best-warehouse-management-software)

### Inferences
- A solid design: batch builder (size cap by items/orders), tote entity with barcode and status (free/assigned/hospital), tote scanned to order at batch start, per-tote slot color on screen, scan-in confirmation per item, exceptions routed to a hospital tote, end-of-batch summary; plus Veeqo-style "most efficient" auto-selection between pile and tote-per-order.
- ShipStation's own totes API (Feb 2026) suggests a possible alignment point for tote IDs, but its purpose was not documented in the notes retrieved.

### Gaps
- No vendor documented slot/LED color semantics; ShipHero's LED colors and ShipStation's colors are not documented.
- Veeqo/ShipHero tote-slot UI screenshots were not examined.

---

## 7. ShipStation integration depth, sync latency, and double entry

### Takeaway
Integrations commonly follow two patterns: (a) WMS pulls orders from the store (or ShipStation) and pushes picked orders to ShipStation as pending shipments for labels, then pulls tracking back (inFlow, Zenventory, SkuVault, Extensiv); (b) the WMS replaces ShipStation. ShipStation order import is polling-based and not instant, API limits are modest (40 requests/min per key on V1), and double entry arises when inventory is owned in both places.

### Cited Findings
- ShipStation documents two WMS integration patterns: "Shipping" (WMS picks, ShipStation labels) and "Pick-Pack" (ShipStation syncs orders to the WMS for picking), plus direct API integration and middleware. — [ShipStation WMS page](https://www.shipstation.com/fulfillment/warehouse-management/)
- inFlow: fully picked order -> pending shipment in ShipStation; carrier, tracking number and ship date pulled back to update the sales order. — [inFlow support](https://www.inflowinventory.com/support/cloud/connecting-inflow-to-shipstation)
- Zenventory: two-way update interval "15 minutes (maximum)"; setup by generating ShipStation API keys. — [Zenventory ShipStation page](https://www.zenventory.com/integration/shipstation)
- A NetSuite-ShipStation connector guide: inventory pushed on a schedule (e.g., every 15 minutes), reservations in the ERP prevent overselling despite staleness; ShipStation order sync "is not instant" due to API polling. — [Folio3 NetSuite connector FAQs](https://netsuite.folio3.com/shipstation-connector-faqs/); [FreshySites ShipStation sync delay](https://freshysites.com/resources/fix-shipstation-time-mismatch-sync-delay-woocommerce/)
- ShipStation Shopify import timing is inconsistently reported: roughly every 5 minutes for Shopify (ShipCalm, third-party) vs a minimum two-hour gap on the automatic setting (Candid Wholesale, third-party); one Shopify App Store reviewer says orders are imported only once so later edits (e.g., removing hold tags) don't carry over (single review). — [ShipCalm sync intervals](https://help.shipcalm.com/en/knowledge-base/shipcalm-system-syncing-and-refresh-intervals); [Candid Wholesale](https://help.candidwholesale.com/article/112-why-isnt-shipstation-syncing); [Shopify App Store ShipStation](https://apps.shopify.com/shipstation?locale=he)
- ShipStation V1 API: 40 requests/minute per API key/secret pair, HTTP 429 on excess, headers X-Rate-Limit-Limit/Remaining/Reset, basic auth, times in PST/PDT; endpoints for orders (create/update, hold, mark shipped, assign user, tags add/remove/list), shipments (create label, get rates, void), warehouses, products, stores, webhooks (list/subscribe/unsubscribe). — [ShipStation API requirements](https://www.shipstation.com/docs/api/requirements/); [ShipStation API overview](https://www.shipstation.com/docs/api/)
- ShipStation V2 (ShipEngine-powered): inventory, inventory_warehouses, inventory_locations endpoints (January 2025), totes (February 2026), batches user assignment (September 2026) and packing slip generation (October 2026); /v2/warehouses (list/get). — [ShipStation API release notes](https://docs.shipstation.com/apis/release-notes.md)
- ShipStation suggests choosing one system as the inventory owner; managing stock in both causes double entry (secondary summary of ShipStation material). — [ShipStation WMS page](https://www.shipstation.com/fulfillment/warehouse-management/)
- SKUSavvy migration notes say to turn off ShipStation's inventory sync so "only one system updates stock"; SKUSavvy says it does not integrate with ShipStation (competitor page). — [SKUSavvy ShipStation page](https://skusavvy.com/shipstation-wms)
- SkuVault Capterra reviewers credit easy integrations with ShipStation, QuickBooks and Shopify; one Cin7 reviewer says automation works well once configured with Shopify and ShipStation. — [Capterra SkuVault reviews](https://capterra.com/p/139964/SkuVault/reviews/); [Capterra Cin7 Core reviews](https://capterra.com/p/133038/Cin7-Core/reviews/)

### Inferences
- "Real-time" with ShipStation will be bounded by its polling and the 40 req/min V1 limit; an ERP that pushes orders to ShipStation and listens for shipment events should rely on webhooks plus periodic reconciliation, and should hold inventory ownership in the ERP (disable ShipStation inventory sync) to avoid double entry.
- Use ShipStation tags/custom fields/hold status as the signal for "in warehouse workflow" so manual edits in ShipStation are not overwritten; the single-import behavior (if confirmed) means the ERP must be the source of truth for order edits after import.

### Gaps
- Official webhook event names and payload semantics were not retrieved (docs page returned 403); secondary sources mention ORDER_NOTIFY and SHIP_NOTIFY-type events but this is unverified here.
- Real user reports (Reddit/forums) on ShipStation sync latency and double entry were not found in search results.
- Whether ShipStation V2 totes endpoint maps to physical tote workflows was not confirmed.

---

## 8. Common customer complaints (to avoid)

### Takeaway
Recurring complaints: price/add-on creep and reports gated behind fees, slow or shuffled support, slowness/instability, rigid or missing reporting, hardware limits (no Android handheld support), learning curve/setup, gotchas in location naming/sorting, and sync/import timing.

### Cited Findings
- ShipHero (Capterra 4.3 from 88 reviews, March 2026): late shipping (3PL-side), slow support, "lack of dashboard and reporting", Android handheld scanner gap, learning curve, price; one reviewer reports paying an extra $500/month for custom reports. — [Capterra ShipHero reviews](https://capterra.com/p/166930/ShipHero/reviews/)
- Veeqo (Capterra 4.2 from 87 reviews): limited customization (e.g., extra shipment info), price a little high; customer service scored 4.3. — [Capterra Veeqo reviews](https://www.capterra.com/p/150907/Veeqo/reviews)
- Cin7 Core: support shuffling, one reviewer says a shipping workflow bug took five months to fix, limited delivery scheduling flexibility, add-ons expensive; G2 comparison (competitor page) scores pick and pack 8.1 vs ShipHero 9.0. — [Capterra Cin7 Core reviews](https://capterra.com/p/133038/Cin7-Core/reviews/); [G2 Cin7 vs ShipHero](https://www.g2.com/compare/cin7-core-vs-shiphero)
- SkuVault Core (Capterra): slowness, printing glitches, outages, weak kit/bundle handling, multi-DC difficulty, incomplete reports, dated portal, slow/uneven support, cancellation billing dispute. — [Capterra SkuVault reviews](https://capterra.com/p/139964/SkuVault/reviews/)
- Finale (Capterra 4.7 from 218 reviews): learning curve, no drag-and-drop screen arrangement, price; new features sometimes need fixes. — [Capterra Finale reviews](https://www.capterra.com/p/149851/Finale-Inventory/reviews/?page=4)
- inFlow (Capterra 4.6 from 504 reviews): reports lacking complete info, report printing problems, no API per one reviewer, annual maintenance model disliked by some, older mobile complaints. — [Capterra inFlow reviews](https://capterra.com/p/78431/inFlow-Inventory/reviews/)
- Zenventory: only one Capterra review found (5.0, 2017) with initial setup difficulty as the con - evidence is thin. — [Capterra Zenventory reviews](https://www.capterra.co.uk/reviews/136507/zenventory)
- Logiwa: price steep for smaller operations; Deposco: not recommended below $25M revenue (review site); Packiyo: ERP links via partners can add fees. — [Software Advice Logiwa](https://www.softwareadvice.com/distribution/la-wms-profile/); [SoftwareConnect Deposco](https://softwareconnect.com/reviews/deposco-bright-warehouse/); [rfp.wiki Packiyo vs Cin7](https://www.rfp.wiki/supply-chain-logistics-transportation/warehouse-management-systems/packiyo/cin7-core) (low confidence)
- Operational gotchas documented by vendors themselves: bin codes sort as text unless padded (Veeqo); inconsistent location names create zig-zag routes and stock only in non-pickable bins breaks batch generation (ShipHero). — [Veeqo help](https://help.veeqo.com/en/articles/8306650-digital-picking-overview); [ShipHero pick path article](https://software-help.shiphero.com/hc/en-us/articles/46894155095565)
- A ShipStation Shopify user review says imported orders are not updated after first import. — [Shopify App Store ShipStation](https://apps.shopify.com/shipstation?locale=he)

### Inferences
- The module should avoid: paywalled reports, text-sort bin codes (use structured aisle/bay/level coordinates), pick path computed only at batch creation without a re-plan on exception, one-way order import, and unclear tote/hospital handling.

### Gaps
- No Reddit thread content was retrievable (searches returned vendor and aggregator pages); G2 review text was largely unavailable. Complaint evidence is concentrated in Capterra and mostly older reviews.
- Extensiv mobile app crash complaints appeared only in a low-confidence aggregator summary and were not verified.

---

## 9. KPIs and reports shipped by competitors

### Takeaway
Reporting is generally basic; the most developed picker KPI is ShipHero's 0-10 batch-complexity-normalized score (which needs location-aware picking). Picks/hour, accuracy, order cycle time and dock-to-stock are named by vendors or aggregators but with few definitions.

### Cited Findings
- ShipHero Picker Performance Dashboard: score 0-10 compared with an AI-generated time estimate per batch (5 = exactly on estimate; above 5 = faster); evaluates complexity rather than raw units/hour; requires location-aware picking (walking distance); filters by team member, shift, date, position; CSV export of visible rows; older Picker Report shows items, orders and unique items picked per date. — [ShipHero picker performance](https://software-help.shiphero.com/hc/en-us/articles/42452761934861-Picker-Performance-Dashboard)
- ShipHero marketing: labor cost, picker, packer performance dashboards; reports from "COGS to Picker/Packer Efficiency to Replenishment"; claims 99%+ accuracy, 3x picking efficiency (marketing). — [ShipHero home](https://www.shiphero.com/)
- ShipStation: "Analytics and performance dashboard" on Standard+; batch statuses visible to managers. — [ShipStation pricing](https://www.shipstation.com/pricing/); [ShipStation blog](https://www.shipstation.com/blog/warehouse-picking-packing/)
- Veeqo: "team picking stats" on Inventory/High Volume plans; order, sales and fulfilment reports; stock history report; error alerts prevent incorrect picks. — [Veeqo pricing](https://www.veeqo.com/pricing); [Veeqo features](https://www.veeqo.com/features/reports)
- Packiyo: dashboards for fulfillment performance, shipping spend, inventory velocity, productivity at 3PL/client/brand levels. — [Packiyo features](https://www.packiyo.com/features)
- Logiwa (aggregator, low confidence): pre-built KPIs for order cycle time, picking accuracy and labor productivity; custom reporting lighter than analytics-first rivals. — [rfp.wiki Logiwa](https://www.rfp.wiki/supply-chain-logistics-transportation/third-party-logistics/logiwa)
- SkuVault: sales velocity and stock forecasting with PO generation. — [Linnworks SkuVault WMS page](https://www.linnworks.com/core/sv-warehouse-management-na)
- Hopstack: fulfillment/inventory/warehouse metrics, on-demand reports, audit trails for orders, shipments and inventory movement. — [Hopstack WMS](https://www.hopstack.io/products/hopstack-wms)

### Inferences
- A sensible KPI baseline: picks (lines/units) per hour per picker, pick accuracy (exceptions + pack-verify mismatches), order cycle time (order received -> shipped), pick/pack time per order, orders per batch, exception rate by SKU/location, cycle count variance, stockout/hospital-tote rate, location utilization and slot heat. Normalizing by walking distance or order complexity (ShipHero approach) is a differentiator.

### Gaps
- Dock-to-stock (receive-to-putaway time) was not documented by any source retrieved.
- Exact KPI definitions in Logiwa, Packiyo and Veeqo were not available.

---

## 10. Pick-to-light and hardware support

### Takeaway
Pick-to-light for SMB e-commerce is emerging as cart-mounted LED tote indicators: ShipHero sells a kit today; ShipStation lists it as "coming soon" on Premium. Hardware is cheap relative to fixed-bin systems but the software integration is the real work.

### Cited Findings
- ShipHero Pick-to-Light: LED light bars guide pickers to the correct tote and quantity for multi-item batches (about 10-30 orders); vendor claims 20% efficiency gain, 30% cost reduction, ~45-minute new-hire training, setup under 30 minutes (marketing); no price listed. — [ShipHero pick-to-light](https://www.shiphero.com/pick-to-light)
- ShipHero hardware detail: kit has a cart-front "Shield", QR placard, 26 LEDs, battery pack, connectors; requires a pick cart, barcode scanner, and an iPad running the ShipHero Mobile App; flow is scan container barcode, LEDs show the location/quantity, picker presses a button to confirm; the article does not state the communication protocol, LED colors or tote-slot semantics. — [ShipHero pick-to-light help](https://software-help.shiphero.com/hc/en-us/articles/36575614089741-How-to-Use-ShipHero-s-Pick-to-Light)
- ShipHero also markets pack-to-light and receive-to-light (up to 450% throughput boost for pack-to-light is a marketing claim). — [ShipHero home](https://www.shiphero.com/)
- ShipStation Pick to Light (coming soon, Premium): picker scans an item at a bin and the LED device on the matching tote slot of the picking cart lights up; mounts on existing carts in under an hour; no release date found. — [ShipStation blog](https://www.shipstation.com/blog/warehouse-picking-packing/)
- Fixed-bin pick-to-light cost estimates: roughly EUR 80-250 per bin, plus EUR 50-150 per bin wiring if wired (wireless avoids it) (marketing-style vendor page); a US trade source estimates $150-$250 per SKU face. — [ekko.io pick-to-light cost](https://www.ekko.io/en/wissen/pick-to-light-cost); [Contracting Business](https://www.contractingbusiness.com/hvacrdb/article/20859799/stepping-away-from-the-dark-side-picktolight-picking-system-benefits)
- Other scanning hardware: Veeqo Scanner (stand-alone wireless device), inFlow Smart Scanner (rugged Android), ShipStation Cubiscan (dimensioning) integration on Premium; Finale uses Wi-Fi handhelds. — [Veeqo help](https://help.veeqo.com/en/articles/8306650-digital-picking-overview); [inFlow mobile](https://inflowinventory.com/features/mobile); [ShipStation pricing](https://www.shipstation.com/pricing/); [Finale pricing](https://www.finaleinventory.com/pricing/)

### Inferences
- The "pick to light" that actually exists in SMB products is put-to-light on a cart (light the tote slot for the scanned item). That aligns with the tote-per-order model and is a modest add-on (BLE/Wi-Fi LED strip per slot driven by an event "item scanned for order X -> light slot N") rather than the fixed-bin pick-to-light that costs tens of thousands.
- Design the tote model so each slot has a stable ID and color from day one; the light hardware can then be attached later.

### Gaps
- Hardware protocols (BLE vs Wi-Fi), LED color conventions and kit prices for ShipHero/ShipStation were not published.
- Reliable US pricing for cart-based put-to-light kits was not found.

---

## 11. Synthesis: table stakes vs differentiators vs enterprise-only/skip, with pricing context

### Takeaway
Table stakes are scan-verified pick/pack, location-aware batch picking with a tote per order, pack verification, exceptions, counts, receiving, returns and per-picker stats. Differentiators the custom module could own: a real 3D map tied to unit/carton-level locations, true route optimization on the map, tote-slot UI with colors and later light hardware, deep ShipStation sync with ERP-owned inventory. Enterprise-only items (LPN/pallet-level directed putaway, voice, automation integrations, advanced cartonization, 3PL billing) can be skipped.

### Cited Findings (pricing context)
- A custom module displaces: ShipStation Standard $149.99/month (1,000 shipments) or Premium $599.99 for pick-to-tote/scan-verify/Cubiscan; SKUSavvy about $324/month at 1,000 orders + $2,750 onboarding; Zenventory $499 + $1,000 setup; Finale Growth $799; Cin7 Core $349-$999; ShipHero about $1,995 + $150/extra user; Peoplevox $2,050+ platform + users + ~$10k implementation. — [ShipStation pricing](https://www.shipstation.com/pricing/); [SKUSavvy ShipStation page](https://skusavvy.com/shipstation-wms); [Zenventory pricing](https://www.zenventory.com/pricing); [Finale pricing](https://www.finaleinventory.com/pricing/); [Eightx Cin7](https://eightx.co/blog/compare/how-much-does-cin7-cost); [Eightx ShipHero](https://eightx.co/blog/compare/how-much-does-shiphero-cost); [Peoplevox pricing](https://www.peoplevox.com/pvx-pricing/)
- Cartonization at low volume: small merchants with a few daily orders may not justify cartonization software; hardware box makers need $150k-$300k+ of equipment (vendor-adjacent source). — [Optioryx cartonization guide](https://www.optioryx.com/blog/best-cartonization-software-2026)

### Inferences

**Table stakes (must have for viability)**
1. Location master: warehouse -> zone -> aisle/rack -> shelf/bin, per-SKU primary and overflow bins, pickable vs non-pickable flag, pick priority (ShipHero model); unit and master-carton (case) locations; location barcodes.
2. Mobile guided picking on a phone: scan-to-confirm item (and optionally location), enforce-scan option, quantity entry, overpick prevention, pause/resume, hand-off to another picker, exceptions (empty bin, damaged, short, substitution) with logging and skip.
3. Batch creation with size caps; modes: single-order, single-tote pile (single-line orders), tote-per-order (multi-line), "most efficient" auto-select; tote entity with barcode; hospital tote for exceptions.
4. Pack station: scan order/tote, scan items to verify SKU/qty, block label until match, print label via ShipStation, packing slip/pick list templates with bin locations and barcodes.
5. ShipStation: orders in, label/shipment out, tracking/status back, tag/hold handling, webhook-driven plus reconciling poll within V1 40 req/min limit (and V2 if used), idempotency; ERP as inventory owner.
6. Inventory control: receiving against POs, putaway suggestions, cycle counts/stock takes without shutdown, adjustments with reason and audit history, reorder points, lot/expiry if needed, returns with restock/write-off.
7. Reporting: picks/hour, accuracy/exceptions, order cycle time, pack time, per-picker stats, count variance; CSV export.
8. Label/printing: bin labels, tote labels, location QR/barcodes, shipping label and packing slip printing from a phone/tablet (browser AirPrint-style).
9. Roles/permissions, multi-user concurrency, offline tolerance (Peoplevox lists offline mode as included).

**Strong differentiators (what could make the custom module better)**
- Interactive 2D/3D warehouse map with filled/empty bins, search "where is this", map-guided putaway, heatmap-based slotting, pick-route overlay, count path (only SKUSavvy markets this; its map details are marketing).
- Unit-level and master-carton-level location assignment and a break-carton/replenishment flow from carton locations to forward pick bins.
- True route optimization (S-shape / largest-gap / hybrid) over a real aisle graph, plus walking-distance-normalized picker scoring like ShipHero's.
- Tote-slot UI: color per tote, count per slot, tote scanning success/failure states, split quantities across totes, end summary.
- Pick-to-light (put-to-light) on cart tote slots, with slot-level event API; ShipHero kit exists, ShipStation is only announcing.
- Cartonization/box suggestion based on SKU dimensions (SKUSavvy offers "3D box packing" suggestions; Cubiscan on ShipStation Premium); Odoo-like package types with capacity.
- Replenishment tasks by min/max per location (OpenBoxes) and capacity-based putaway rules (Odoo storage categories).
- Capacity-aware, FEFO/FIFO or "pick-down least-stock-first" removal strategy selectable per product category (Odoo, OpenBoxes, ShipHero).

**Enterprise-only / skip**
- Voice picking, RFID, pallet/LPN-level directed putaway and slotting optimization at scale (Mecalux heatmap slotting), automation/AS-RS/robot integrations, wave planning with dock/carrier cutoff scheduling and yard/dock management, 3PL multi-client billing, EDI, SSO/SLA/audit logs, advanced multi-warehouse allocation/ATP, full cartonization with carrier-rule optimization.
- Hardware box-making (Packsize class) and fixed-bin pick-to-light per-bin deployments.

### Gaps
- Pick-to-light and 3D-map ROI at Freeze Pipe's scale (2-5 staff, few hundred SKUs) was not supported by any independent data; vendor efficiency numbers (20-50%) are marketing.
- Dock-to-stock KPI, LPN/container model details at SMB vendors, and Reddit-level user sentiment were not found.

---

## Source-quality notes
- Primary vendor pages used: ShipStation (pricing, WMS, blog, API docs), Veeqo (pricing, help), ShipHero (help center, pick-to-light, picker dashboard), Packiyo (pricing, features), Zenventory (pricing, ShipStation), Finale (pricing), SKUSavvy, Odoo docs, ERPNext docs, OpenBoxes docs.
- Aggregator/low-confidence: CostBench, Eightx, Toolradar, FitGap, rfp.wiki (AI-generated), ECOSIRE (vendor), SoftwareConnect. Where these conflict with vendor pages the conflict is flagged.
- Pricing last verified (via search/fetch) on 2026-10-19; Cin7, inFlow, Ordoro, ShipHero figures are conflicting across sources and should be re-confirmed before budgeting.
