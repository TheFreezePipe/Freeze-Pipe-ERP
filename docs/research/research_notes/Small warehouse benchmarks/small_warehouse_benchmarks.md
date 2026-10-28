# Small warehouse benchmarks: how peers at our size run, and whether we have overbuilt (October 2026)

Research date: 2026-10-28. Question from the owner: how are the best-run warehouses of our size organising and running their operation, and have we overbuilt? Our profile: 3,500 sq ft, ~130 active SKUs of fragile glass, median 217 orders per ship day (p90 429, Q4 peaks 600-758), 62% single-line, 2-3 pickers at peak plus an in-house fill-and-finish team, ShipStation Scan to Print at four pack stations, custom ERP. Built on staging: bins with barcode labels and a floor map, an LPN per carton at check-in, phone putaway with suggested bins, blind cycle counts with manager approval, nightly bins-versus-ledger reconciliation, a print queue with print agent and station sessions, and a manufacturing carton flow (scan carton to line, green relabel at RTS). Guided cart picking is next.

This note complements `research_notes/Warehouse ops audit/smb_fulfillment_benchmarks.md` (2026-10-19), which could not retrieve the WERC quintile tables; those tables and the Descartes 2025 benchmark report are reported here from the primary PDFs.

## Summary

Peers at 100-500 orders a day mostly run on ShipStation alone (bins on pick lists, batch pick lists sorted by location) or ShipStation plus a light WMS (ShipHero, Veeqo, SKUSavvy, SkuVault). The light-WMS customers report using a small, consistent feature set day to day: a bin per SKU on the pick list, batch or tote picking, a barcode scan at pick or pack, bulk label printing, and rolling cycle counts. The practices that separate well-run sites are the cheap ones: fixed labelled locations, pick lists in walk order, scan verification before the label prints, receiving checked against the PO, location-based cycle counts by trained counters, and simple velocity slotting. Credible accuracy targets are order-picking accuracy of about 99.2-99.4% at the WERC median and 99.7-99.9% best-in-class, location inventory accuracy of about 98.4% median and 99.5-99.9% best-in-class, and dock-to-stock under 3.5 hours best-in-class. Carton-level license plates sit late on the adoption curve. Light WMS products offer them as optional, pallet- and wholesale-oriented features (ShipHero's LPN batch picking is still beta), and Katana, SKUSavvy, Fulfil's WMS page and Shopify's new bin API do not mention them. DTC peers track units per bin with the bins themselves as the stock ledger, so they have no nightly bins-versus-ledger reconciliation to run. Light manufacturers (Katana, MRPeasy, RoasterTools customers) track raw, WIP and finished as stock buckets or order status, not locations; tying stages to locations is an ERP pattern (Odoo three-step manufacturing). The evidence on complexity is consistent: record accuracy falls as process complexity rises, technology underdelivers without basic process discipline, and the warning signs of a failing rollout are overrides, paper workarounds and lost floor trust. Read against this, our build is at or above best-run peers on locations, labels, counts and print infrastructure, well above them on carton tracking, reconciliation and stage-to-location tracking, and below them on the one control nearly every peer story mentions: a barcode scan that verifies items before the label prints, which today's Scan to Print flow does not do.

## 1. Tooling and process at 100-500 orders/day and 100-300 SKUs

Findings
- ShipStation alone is a normal setup at our volume. ShipStation's warehouse-picking post targets brands shipping "hundreds of orders a day" and uses a 500-order busy day as its example. Its features are mobile picking with barcode scan, pick-to-tote, picking exceptions and scan to verify at packing; bin locations are not a separate feature, but pick lists can be configured to show them. The pricing page lists mobile picking and "Barcode scan (verify & print)" on Standard, and pick-to-tote, purchase orders and scan-to-receive on Premium ($349.99+/month). (ShipStation blog, updated 2026-06-26; ShipStation pricing page, read 2026-10-28)
- Peer example on ShipStation alone: Sydney Sock Project grew to as many as 260 orders a day with three warehouse staff, batch picking from pick lists printed in warehouse-layout order (up to 500 orders printed at once). No WMS, bins or scan verification are mentioned. (ShipStation customer story, 2025-06-02)
- ShipStation's bin handling is thin, per user reports: pick lists read a single manually maintained warehouse-location field, only the first location prints on the slip when stock sits in several, bulk location updates have duplicated stock, and walk-order sorting does not work as users expect. These come from community posts and a help article seen through search excerpts (the pages returned 403 to direct fetch), so dates and current behaviour are unverified. (ShipStation Community and Help Center)
- Vendor thresholds for adding a WMS cluster around our band: SKUSavvy's FAQ names daily volume above 350 orders as a sign; Sapio puts the tipping point from spreadsheets to a system at 50-100 orders a day with a few hundred SKUs across channels. Both are software sellers. (SKUSavvy warehouse FAQ, undated; Sapio Systems, 2026-09-21)
- What light-WMS customers say they use day to day:
  - SportStop (lacrosse e-commerce, $7M, 10 FTE, ShipHero): scan-to-pick and scan-to-tote on iPads, merge orders; one person picks 70-80 orders an hour; new pickers trained in minutes. (ShipHero case study, 2022-12-05)
  - James Enterprise (ShipHero, about 300k orders a year across DCs): paperless tablet picking, re-slotting to shorten walks, bin system generating pick paths; a new picker went from 55 to 34 seconds per order in five days. (ShipHero case study, 2024-10-18)
  - DFTBA (outgrew ShipStation at 56,000 orders a month): bulk label printing is the most-used feature; monthly shipping errors fell from 86 to 37. (ShipHero case study, 2022-07-01)
  - Indigo Herbs (Veeqo): a bin location for every product, scanner picking, batch dispatch, rolling weekly stock takes instead of shutdown counts; 99.89% picking accuracy. (Veeqo customer story, undated)
  - Bunker 27 (12 stores plus a warehouse, left ShipStation for SKUSavvy): scan-to-pick and pack, bin locations, transfer scanning. Scarpetta Shoes ran ShipStation plus SkuVault. (SKUSavvy testimonials page; ShipStation story, 2018-03-12)
  - None of these stories mentions carton license plates, a bins-versus-ledger reconciliation job or putaway suggestions; label printing is built into the product.
- Cost at our size: SKUSavvy is $179 a month including 249 orders, then $0.20, $0.19 and $0.13 per order in graduated bands. At our 365-day average (about 5,300 orders a month) that is roughly $1,100 a month, and about $1,700 in a December-sized month (my arithmetic from the published rate card). ShipHero and Logiwa quote on request; Logiwa positions itself for high-volume parcel shippers. (SKUSavvy pricing, read 2026-10-28; Logiwa listings)
- Shopify is moving toward native bins: a "Bin name" column in the inventory CSV (changelog, 2025-08-25) and a Physical inventory feature preview with bins and per-bin counts, in which a location's on-hand is the sum of its bins. The preview has no containers or LPNs. (Shopify changelog; shopify.dev preview page, undated)
- Context: in a March 2025 Radial/Dynata survey of 200 brand decision-makers, about 70% fulfil in-house, and outsourcing rises sharply above $50M revenue. Radial is a 3PL, so read the framing with care. (SupplyChain 24/7 coverage, 2025)
- Gap: Reddit (r/ecommerce, r/smallbusiness, r/logistics) could not be fetched and search returned no threads. Community evidence here comes from the ShipStation and Shopify communities and from vendor customer stories.

Bottom line: at our volume, the best-documented peers run ShipStation alone or ShipStation plus a light WMS costing $1,000-2,000 a month, and they use bins, batch picking, a scan at pick or pack, and rolling counts. Nothing heavier shows up in their stories.

## 2. Practices that separate well-run small warehouses

Findings
- Fixed, labelled locations: Piasecki argues that almost every warehouse should track locations in some form and that a simple system is enough for many; sorting picks by location improves efficiency even if nothing else changes. Use an address format from largest to smallest (zone, aisle, section, shelf, bin), keep it consistent across aisles, and leave gaps for expansion. One SKU per location is the default but not required. (InventoryOps, "Using Bin Locations", undated)
- Pick lists in walk order: Piasecki says the pick document should follow the walking route, with fast movers near the main cross aisle. SKUSavvy names pickers who walk the same aisles twice as the main symptom of ShipStation pick lists that show bins without a route, and Sydney Sock's gain came from layout-ordered pick lists. (InventoryOps "Order Picking"; SKUSavvy ShipStation WMS page, 2026-10-22; ShipStation story, 2025-06-02)
- Scan verification before the label: ShipStation's Scan to Verify & Print requires scanning each item's barcode "before you can print the label"; plain Scan to Print does no item check. Fulfil's Scan Required setting blocks pick or pack completion until the barcode is scanned, with no picker override. Cadre recommends 100% scan checks over sample audits. Piasecki adds a caution: scanners can slow fast piece picking, trained pickers can be accurate without them, and scanners suit order checking better. (ShipStation Help Center, V3 Scan to Verify; Fulfil WMS page; Cadre Technologies, 2026-10-20; InventoryOps)
- Batch/cart picking: Piasecki describes 4-12 orders per multi-tier cart with a tote per order, working best when orders have few picks (our 62% single-line fits). The Descartes benchmark in section 6 is measured on pick-and-sort-to-trolley. ShipStation claims 30-40% labour efficiency from mobile picking versus printed lists (vendor claim). (InventoryOps; Descartes 2025; ShipStation WMS feature page)
- Cycle counting: Piasecki prefers counting by location, using only well-trained counters, recounting every variance under blind counts, avoiding tolerance-based "good count, bad count" schemes, and parking unexplained stock in variance locations instead of adjusting back and forth. He advises tracking your own accuracy over time rather than benchmarking against others. Indigo Herbs runs rolling weekly stock takes; Fulfil schedules counts by location or ABC class with two-step verification of discrepancies; Sapio suggests counting the fastest 20% of SKUs weekly. Oliver Wight's Class A target is 95%+ record accuracy sustained by cycle counting. Piasecki's location audit (walk each slot, check the item belongs there, record no quantities) is a cheap complement that finds lost stock faster than counts. (InventoryOps "Cycle Counting and Physical Inventories" and "Location Audits"; Veeqo; Fulfil; Sapio, 2026-09-21; Oliver Wight IRA course)
- Receiving discipline: Descartes says "Accurate inventory starts at goods-in/goods receiving" and that cycle counts cannot fix untracked inbound stock. Sapio says to check inbound cartons against the PO before stock reaches a shelf. WERC best-in-class dock-to-stock is under 3.5 hours (2025). (Descartes 2025 report; Sapio; WERC via Yale 2025)
- Slotting by velocity: rank items by times picked (not units) and give the fastest movers the best slots. Piasecki calls absolute optimisation impractical and says even a simple times-picked ranking helps. (InventoryOps "Warehouse Slotting")
- Measurement is itself a differentiator: WERC's most-used metrics are order-picking accuracy, on-time shipments, capacity, dock-to-stock and inventory count accuracy. Descartes notes that most brands learn of mis-ships only from customer complaints. (WERC 2019, 2022, 2025; Descartes 2025)

Bottom line: the separating practices are inexpensive. They are labelled fixed locations, walk-ordered batch picking, a verification scan before the label, receiving against the PO, and location-based counts by trained counters with a measured accuracy figure.

## 3. Carton LPNs, physical-versus-book reconciliation and print infrastructure on the adoption curve

Findings
- Light WMS products treat LPNs as optional container features oriented to pallets and wholesale. ShipHero's LPN features are available but optional and are described as a barcode for a box or pallet. Receiving to LPN is a setting, the help articles cover wholesale picking from LPNs, and the multi-item batch flow that picks from LPNs is in beta. (ShipHero help center, updated 2026-10-27 and 2026-10-28)
- A 2026 buyer's guide for small 3PLs frames pallet LPN tracking as "a B2B fulfillment requirement" and recommends a DTC-focused WMS for operations that do not need it. It also claims ShipHero lacks LPNs, which ShipHero's current docs contradict. (Packem WMS guide, 2026-05-08)
- Extensiv 3PL Warehouse Manager uses movable-unit (pallet) license plates at 3PLs, with system-assigned plates at receiving. Logiwa offers parent-child license plate hierarchies. Both lean toward 3PL or enterprise use. (Extensiv help; Logiwa)
- The small-DTC tools do not mention them: SKUSavvy's pricing and docs, Katana's storage bins, Fulfil's WMS page (which identifies inbound cartons by SSCC at receiving only) and Shopify's physical inventory preview list bins and counts but no containers or LPNs. (SKUSavvy; Katana help; Fulfil; shopify.dev)
- What small DTC operations do instead is track units per bin, with the bins as the stock ledger. In SKUSavvy the total of all bins is on-hand, and its docs say "SKUSavvy is the source of truth for inventory quantities once connected"; Shopify's preview also defines on-hand as the sum of bins. Reconciliation is exception-driven, not nightly. SKUSavvy creates a reconciliation record when stock leaves without a bin (off-system fulfilment, POS, edits made in Shopify), and a person resolves it to a bin or a loss. ShipHero's own help center shows the failure mode of keeping two records: with one Shopify setting enabled, on-hand drops but bin stock does not, so bins show more units than the warehouse holds. (SKUSavvy "Very Important" and "Inventory Reconciliation" docs; Shopify preview; ShipHero help article, updated 2026-04-27)
- Where the sources say carton-level identity earns its keep: pallets, cases and totes moved intact, multi-client 3PL storage, mixed or nested packaging, and traceability (Hopstack, 2024-09-18; Piasecki). Piasecki names a failure mode: a static LPN becomes invalid after a partial pick and forces manual entry of item and quantity. Dynamic LPNs avoid this but need software support. (InventoryOps "License Plates in the Warehouse")
- Lot or batch tracking, not LPNs, is the usual traceability tool in small DTC and light manufacturing (ShipStation Standard lot tracking; Katana and Fulfil lots; Cornbread Hemp's recall readiness through lots). (ShipStation pricing; Katana; Fulfil; Katana case study)
- Print infrastructure is standard inside light WMS, but peers buy it rather than build it. ShipHero's Workstation Desktop App (the "Print Listener") manages the printers and scales at each workstation, each user has a Default Print Station, and jobs appear in a printing queue. PrintNode is the common bought bridge for smaller tools. (ShipHero help, updated 2026-10-27; ChannelDock page, search excerpt)

Bottom line: carton LPNs and a bins-versus-ledger reconciliation are uncommon at our size. The peers that use LPNs are 3PLs, wholesale shippers or pallet operations. DTC peers count units per bin and make the bins the ledger, so their reconciliation is an exception queue. Station-based print routing is ordinary, but peers get it built into the product.

## 4. Light manufacturing or kitting combined with DTC fulfilment

Findings
- Katana is the usual tool for Shopify brands that make what they sell. In Katana, WIP is a manufacturing-order status: "Work in progress" moves no stock, and inventory updates when the order is completed. Bins are an add-on ("Storage bins are part of the Warehouse Management add-on"), and multi-bin tracking with bin references on MO pick lists arrived on 2026-09-04. The docs have no WIP location or container concept. (Katana help center; Katana blog, 2026-09-04)
- MRPeasy (small manufacturers) moves stock from raw to WIP to finished automatically as workers report consumption and completion. Storage bins are not part of that page's model. (MRPeasy WIP page)
- RoasterTools serves coffee roasters, a close analogue of fill-and-finish. Green stock is deducted as it is roasted, unpacked roasted carryover is tracked to offset demand, and packaged stock comes from packaging tasks. No lots, bins or locations are described. (RoasterTools inventory page)
- Fulfil (an ERP for DTC brands) assigns routing steps to work centres, tracks progress per stage and values WIP in an account. Goods at a co-packer sit in a dedicated warehouse location and a WIP account. Made by Mary cites cycle counts and visibility of raw materials. The page does not tie stages to bins. (Fulfil manufacturing page)
- Tying stage transitions to locations is an ERP pattern. Odoo's three-step manufacturing creates a pick-components transfer to the production area, then the manufacturing order, then a store-finished-products transfer back to stock. (Odoo 18 docs)
- Piasecki: if each stage produces its own stocked item, the intermediate product is inventory with its own SKU, not WIP. Backflushing should draw from a controlled machine location so reporting errors surface quickly. The WIP account is a compromise that avoids very complex tracking. (InventoryOps "Work-In-Process" and "Backflushing")
- Kitting at DTC scale is usually virtual. ShipStation bundles (Standard plan) and Ordoro's kitting deduct components at shipment, with no WIP. (ShipStation pricing; Ordoro case study)

Bottom line: small make-and-ship peers track stage as stock buckets or order status, with bins (if any) only for raw and finished stock. Our carton flow (scan to line, green relabel, putaway) resembles Odoo-style location-based staging with carton identity added, which goes beyond the light-manufacturing tools.

## 5. The cost of process complexity at small scale

Findings
- Complexity raises record error. In 369,567 records across 37 stores of one retailer, 65% were inaccurate; auditing practices reduced inaccuracy, and the complexity of the store environment and distribution structure increased it. (DeHoratius and Raman, Management Science, 2008)
- Technology alone underdelivers. WERC reported that "the impact of technology was not as strong as we hypothesized" and turned its attention to process efficiency (2019 handout). Piasecki says barcoding and similar tools "will not eliminate all errors", that poor implementations can leave you worse off, and that the basics come first. He also says WMSs are data-dependent and restrictive by design, that the cultural change is often the hardest part, and that each added technology layer brings overhead and new failure points. (WERC DC Measures 2019; InventoryOps "Inventory Accuracy" and "WMS")
- Warning signs that the system and the shelf are drifting apart: staff override suggested locations and sequences, transactions are done on paper and keyed in later, spreadsheets come back because the data is not trusted, count differences stop falling, and adjustments become routine. A wrong opening count can cost the floor's trust within days and take months to rebuild. Target Canada is the large-scale precedent: its product data was accurate about 30% of the time. (FindWMS analysis, 2026-09-19)
- Phantom stock most often comes from cartons received but not scanned, scans to the wrong SKU, or stock placed in unrecorded locations. Where scanning is deployed but accuracy stays poor, gaps in scan compliance are the usual culprit. (Racklify, Advanced Automation, WareGo; vendor content seen through search excerpts, consistent with each other)
- Mitigations that worked in the sources:
  - Make the system the easy path. Onboarding in minutes rather than weeks is the most repeated win: SportStop trains pickers in "a few minutes", BW Retail cut onboarding to 15-20 minutes from 2-3 weeks, and VRG GRL gets new staff effective in hours. Descartes adds that training is needed to stop people falling back into old habits. (ShipHero; Descartes 2025)
  - Gate features. ShipHero's LPN receiving is a setting and its LPN batch flow needs support to enable; Fulfil's scan requirement is set per product and cannot be overridden; ShipStation lets you choose a verify mode. (ShipHero; Fulfil; ShipStation help)
  - Keep the rules few and explicit. SKUSavvy publishes five non-negotiables: fulfil only in the WMS, unpick abandoned batches, treat the sync as one-way, reconcile stock that left without a bin, and handle POS orders. (SKUSavvy docs)
  - Enforce process discipline: documented procedures enforced immediately, formal training and testing, miscellaneous adjustments restricted to inventory staff, and counts done by trained counters. (InventoryOps)
  - Handle cutover carefully: a location-level count right before go-live, a short parallel run, and no go-live at peak. (FindWMS; Orbital Tech)
  - Use a wide range of training methods, which a survey of 322 warehouse technology decision-makers found supports adoption. (MIT CTL, 2025-05-01)

Bottom line: the risk at our size is not that a feature is missing but that a step gets skipped and the records diverge. Every extra mandatory scan is a compliance obligation. Peers that succeed keep the required steps few, gate the optional ones, and measure whether people actually do them.

## 6. Benchmark numbers

| Metric | Value | Source and caveat |
|---|---|---|
| Order-picking accuracy (percent by order) | Median 99.4%, best-in-class >=99.89%, major opportunity <98.0% | WERC DC Measures 2019 handout |
| Order-picking accuracy | Median 99.20%, best-in-class >=99.85%, major opportunity <97% | WERC DC Measures 2022 (2021 performance) |
| Order-picking accuracy | Best-in-class >=99.68% (2025); 99.7%+ (2026) | WERC 2025 via Yale white paper; WERC 2026 via CognitOps (secondary) |
| Inventory count accuracy by location | Median 98.4%, typical 97-99.01%, best-in-class >=99.9%, major opportunity <90% | WERC 2019 handout |
| Inventory count accuracy by location | Best-in-class >=99.5% | WERC 2025 via CognitOps (secondary) |
| Inventory record accuracy target | 95%+ (Class A) | Oliver Wight IRA course |
| Dock-to-stock | Best-in-class <3.5 h (2025); <3.1 h (2026) | WERC 2025 via Yale; WERC 2026 via CognitOps (secondary) |
| Lines picked and shipped per person-hour | Best-in-class 70+ | WERC 2025 via CognitOps (secondary) |
| On-time shipments | Median 98% (2019), 96.8% (2022); best-in-class >=99.5% (2025) | WERC 2019, 2022; Yale 2025 |
| Orders picked per person-hour (pick and sort to trolley) | Average 23.5; Wellness/Health/Beauty 29.1; Sports & Hobbies 20.1; Home & Garden 16.6; best customer 128 | Descartes Peoplevox customer data, 2025 report (vendor WMS users) |
| Orders shipped complete | 97.7-100% by sector | Descartes 2025 (vendor) |
| Stock-take count accuracy | 99.3-100% by sector | Descartes 2025 (vendor; metric definition ambiguous) |
| Mean time to ship (pick start to label) | Average 35 h; best 1.56 h | Descartes 2025 (vendor) |
| Shipping errors | 86 to 37 a month at about 56,000 orders a month (about 0.15% to 0.07%) | DFTBA, ShipHero case study, 2022 |
| Picking accuracy, small DTC with scanner picking | 99.89% | Indigo Herbs, Veeqo story |
| Picker rate, small DTC with scan-to-tote | 70-80 orders per picker-hour; 34 s per order after 5 days | SportStop, 2022; James Enterprise, 2024 (ShipHero) |
| E-commerce mixed picking | 80-120 units an hour; 80-130 for batch | CognitOps 2026, labelled directional, not audited |
| Manual picking error rate | 1-3% | Sapio 2026 (vendor, cites unnamed studies) |

Caveats: WERC respondents skew large (only 19.2% had revenue under $100M in 2022), although WERC reported in 2019 that it rarely sees statistically significant performance differences by firm demographics. Best-in-class means the top 20% of respondents. Descartes and ShipHero figures come from their own customers. No audited benchmark for a 3,500 sq ft DTC site was found.

## Read against our build (interpretation, not sourced fact)

- At peer level or better: labelled bin locations, the floor map, walk-ordered locations, phone putaway, blind counts with manager approval (which match Piasecki's blind count with recount and Fulfil's two-step verification), ABC count scheduling, and station-based print routing (the same shape as ShipHero's Workstation app).
- Above what best-run peers of our size run: an LPN per carton at check-in, a separate physical layer reconciled nightly against the stock ledger, and a manufacturing carton flow with relabelling. Peers either avoid the second record (the bins are the ledger) or only adopt LPNs when they handle pallets, wholesale or multi-client storage. Our carton loop through manufacturing is a better reason for carton identity than most peers have, but it raises the number of scans each worker must do.
- Below peers today: the outbound flow has no item-verification scan. ShipStation Scan to Print does not check items. The control peers cite most is a scan before the label: ShipStation Scan to Verify & Print (listed on the Standard plan), ShipHero scan-to-pick, or Fulfil's Scan Required. The Phase 2 per-unit UPC scan at pick would close this gap. Batch/cart picking, the other common peer practice, is not live yet either, and there is no measured baseline for mis-ship rate or location accuracy.

## Method and limits

Web search (standard and extended) plus direct reads of primary pages and PDFs: the WERC 2019 and 2022 handouts, the Yale white paper on WERC 2025, the Descartes 2025 report, vendor help centres and InventoryOps articles. Reddit, G2, Capterra, some ShipStation Community and Help Center pages, and Business Wire returned errors to direct fetch; the points that rely on search excerpts are marked. Most practitioner evidence at this size is published by vendors, and vendor claims are labelled.

## Sources

WERC and benchmark reports
- WERC DC Measures 2019 Snapshot in Time (handout, 2019): https://cdn2.hubspot.net/hubfs/476052/2019_WERC_DC_Measures%202019_Handout.pdf
- WERC DC Measures 2022 Snapshot in Time (abbreviated report, 2022): https://cdn.ymaws.com/werc.org/resource/resmgr/pdf/2022_dcm/22-0011_werc_abbreviated_rep.pdf
- Yale, Benchmarking and improving distribution center metrics (WERC 2025 findings; file dated 2025-08): https://www.yale.com/globalassets/coms/yale/north-america/documents/white-papers/0000ybc0wp001_e_en-us_benchmarking-and-improving-dc-metrics.pdf
- CognitOps, Warehouse KPIs (WERC 2025 and 2026 figures; updated 2026-10-04): https://cognitops.com/warehouse-kpis-advanced-strategies/
- CognitOps, Warehouse pick rate benchmarks by industry (2026-05-14, updated 2026-10-13): https://cognitops.com/warehouse-pick-rate-benchmarks-by-industry/
- Descartes, 2025 Warehouse Performance Benchmark Report (Nov 2025): https://www.descartes.com/sites/default/files/media/documents/2025-11/The-2025-Warehouse-Performance-Benchmark-Report-Final.pdf
- Oliver Wight, Inventory Record Accuracy course (undated): https://www.oliverwight-americas.com/private-courses/inventory-record-accuracy-course/
- DeHoratius and Raman, Inventory Record Inaccuracy: An Empirical Analysis, Management Science 54(4), 2008: https://econpapers.repec.org/RePEc:inm:ormnsc:v:54:y:2008:i:4:p:627-641
- Lavia, The Future of Warehousing: Workforce Management Insights for Technology Adoption, MIT CTL (2025-05-01): https://ctl.mit.edu/publications/future-warehousing-workforce-management-insights-technology-adoption

Practitioner and consultant
- InventoryOps (Dave Piasecki), Using Bin Locations: https://www.inventoryops.com/articles/bin-locations.html
- InventoryOps, Order Picking Methods: https://www.inventoryops.com/articles/order-picking-methods.html
- InventoryOps, Warehouse Slotting: https://www.inventoryops.com/articles/warehouse-slotting.html
- InventoryOps, Cycle Counting and Physical Inventories: https://www.inventoryops.com/articles/cycle-counting-and-physical-inventories.html
- InventoryOps, Guide to Inventory Accuracy: https://www.inventoryops.com/articles/inventory-accuracy.html
- InventoryOps, Location Audits: https://www.inventoryops.com/articles/location-audits.html
- InventoryOps, Warehouse Management Systems: https://www.inventoryops.com/articles/warehouse-management-systems-wms.html
- InventoryOps, License Plates in the Warehouse: https://www.inventoryops.com/articles/license-plates-in-the-warehouse.html
- InventoryOps, Work-In-Process: https://www.inventoryops.com/articles/work-in-process.html
- InventoryOps, Backflushing: https://www.inventoryops.com/articles/backflushing.html
- InventoryOps, Kitting versus Work Orders: https://www.inventoryops.com/articles/kitting-versus-work-orders.html
- FindWMS, Why do WMS projects fail? (2026-09-19): https://findwms.com/analysis/why-wms-projects-fail
- Sapio Systems, WMS for small ecommerce: when do you actually need one (2026-09-21): https://sapiosystems.com/wms-for-small-ecommerce-when-do-you-actually-need-one/
- Cadre Technologies, Pack station accuracy rate benchmark (2026-10-20): https://www.cadretech.com/blog/warehouse-pack-station-accuracy-rate-industry-benchmark
- Hopstack, Inventory control with LPNs (2024-09-18): https://www.hopstack.io/blog/inventory-control-warehouse-with-license-plate-numbers-lpns
- Packem WMS, Best WMS for small 3PLs (2026-05-08): https://packemwms.com/best-wms-small-3pl-buyers-guide/
- SupplyChain 24/7 on the Radial/Dynata survey (2025): https://www.supplychain247.com/article/in-house-fulfillment-slowing-business-growth-radial-survey
- Search excerpts only (not fetched in full): Racklify on phantom inventory https://racklify.com/encyclopedia/ghosting-isnt-just-for-dating-the-high-cost-of-phantom-inventory/ ; Advanced Automation on barcode data errors https://www.advanced-automationinc.com/learning-center/10-causes-of-warehouse-barcode-data-errors-and-what-theyre-actually-costing-your-operation/ ; WareGo on WMS versus shelf counts https://warego.co/blog/inaccurate-warehouses-why-wms-shelves-dont-match/ ; Orbital Tech on parallel running https://www.orbitaltechltd.com/insights/warehouse-management-system ; ChannelDock on PrintNode https://channeldock.com/en/blogs/printnode-ecommerce-wms-label-printing/

ShipStation
- Built for the Warehouse Floor (updated 2026-06-26): https://www.shipstation.com/blog/warehouse-picking-packing/
- Warehouse management features: https://www.shipstation.com/features/warehouse-management/
- Pricing (read 2026-10-28): https://www.shipstation.com/pricing/
- V3 Scan to Verify / Print help article: https://help.shipstation.com/hc/en-us/articles/360031021831-V3-Scan-to-Verify-Print
- Sydney Sock Project story (2025-06-02): https://www.shipstation.com/stories/sydney-sock-project
- Scarpetta Shoes story (2018-03-12): https://www.shipstation.com/?p=17491
- Community threads and help article on bin locations (search excerpts only): https://community.shipstation.com/t5/ShipStation-Features/Organize-products-on-packing-slips-pick-lists-by-the-order-they/m-p/25912 ; https://community.shipstation.com/t5/Printing-Documents/Pick-list-to-get-product-location-from-inventory-location-not/m-p/6591 ; https://help.shipstation.com/hc/en-us/articles/360036064071

Light WMS and ERP vendors
- ShipHero case studies index: https://www.shiphero.com/case-studies ; SportStop (2022-12-05): https://www.shiphero.com/case-studies/sportstop ; James Enterprise (2024-10-18): https://www.shiphero.com/case-studies/james-enterprise ; DFTBA (2022-07-01): https://www.shiphero.com/case-studies/dftba
- ShipHero LPN overview (updated 2026-10-28): https://software-help.shiphero.com/hc/en-us/articles/47399856639757 ; Receive to LPN: https://software-help.shiphero.com/hc/en-us/articles/42830706961549-Receiving-Inbound-Shipments-on-ShipHero-Mobile-LPNs-Required ; Workstation / Print Listener (updated 2026-10-27): https://software-help.shiphero.com/hc/en-us/articles/4421491732621
- Veeqo, Indigo Herbs: https://veeqo.com/customer-stories/indigo-herbs
- SKUSavvy ShipStation WMS page (updated 2026-10-22): https://www.skusavvy.com/shipstation-wms ; Warehouse FAQ: https://www.skusavvy.com/docs/frequently-asked-questions/warehouse ; Pricing: https://www.skusavvy.com/pricing ; Very Important: https://www.skusavvy.com/docs/guides/very-important ; Inventory Reconciliation: https://skusavvy.com/docs/guides/warehouse/inventory-reconciliation ; Testimonials: https://www.skusavvy.com/testimonials
- Fulfil WMS: https://www.fulfil.io/products/warehouse-management/ ; Fulfil manufacturing: https://www.fulfil.io/solutions/manufacturing-production
- Katana storage bins basics: https://support.katanamrp.com/en/articles/8340252-basics-of-storage-bins ; multi-bin (2026-09-04): https://katanamrp.com/blog/multiple-bin-locations/ ; MO statuses: https://support.katanamrp.com/en/articles/271-manufacturing-order-production-statuses ; Cornbread Hemp: https://www.casestudies.com/company/katana/case-study/cornbread-hemps-journey-to-scalable-production
- MRPeasy WIP tracking: https://www.mrpeasy.com/wip-tracking-software/
- RoasterTools inventory: https://roastertools.com/features/manage-inventory
- Odoo 18 three-step manufacturing: https://www.odoo.com/documentation/18.0/applications/inventory_and_mrp/manufacturing/basic_setup/three_step_manufacturing.html
- ShipHero help, deducting 3PL client inventory (on-hand versus bin discrepancy; updated 2026-04-27): https://software-help.shiphero.com/hc/en-us/articles/17311728496013-How-to-Deduct-3PL-Client-Inventory-for-Orders-Not-Fulfilled-Through-ShipHero
- Extensiv 3PL Warehouse Manager, receiving movable units: https://extensiv.helpjuice.com/movable-units/receiving-movable-units
- Logiwa license plate hierarchy: https://logiwa.com/?p=19692
- Ordoro kitting case study (quilting supply, in-house fulfilment): https://www.casestudies.com/company/ordoro/case-study/how-this-family-owned-quilting-supply-business-trusts-our-fractional-kitting-engine-to-streamline-their-in-house-fulfillment
- Shopify changelog, Bin name column (2025-08-25): https://changelog.shopify.com/posts/track-your-stock-with-new-bin-name-column ; Physical inventory feature preview: https://shopify.dev/docs/apps/build/inventory-management-apps/physical-inventory-feature-preview
