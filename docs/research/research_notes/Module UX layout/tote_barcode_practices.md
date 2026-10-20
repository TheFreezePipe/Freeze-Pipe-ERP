# Tote barcode practices in e-commerce warehouse systems (as of Oct 2026)

Method note: about 20 tool calls. Several ShipHero/Veeqo/Starshipit facts come from WebFetch summaries of the help pages (a small model summarised the page), not verbatim reads. Items marked (SNIPPET) came only from search-result summaries and were not confirmed on the page itself. Items marked UNVERIFIED are not backed by a fetched source.

## 1. Per product: is the tote barcode permanent or per-order, who prints it, how is it tied to an order, how does packing use it

### Takeaway
Every product that has a true tote entity (ShipHero, Veeqo, ShipStation, Starshipit, Pikr) treats the tote barcode as a permanent, reusable asset label that is printed once in bulk by the WMS. The tote is tied to an order dynamically at pick time (scan or system assignment) and released at ship/clear. The pack screen is driven by scanning the tote, which resolves to the linked order(s).

### Cited Findings
**ShipHero**
- Totes are containers used in Multi-Item Batch and Single Item Batch flows; "items are collected into totes tracked by unique barcodes." Totes are created only from the Totes page and ShipHero auto-generates names. — [ShipHero Overview: Totes](https://software-help.shiphero.com/hc/en-us/articles/4419345058445-Overview-Totes-in-ShipHero)
- Totes are warehouse-specific (cannot be shared across warehouses) and are assigned only during batch picking, not in Single Order or Bulk Ship flows. — [ShipHero Overview: Totes](https://software-help.shiphero.com/hc/en-us/articles/4419345058445-Overview-Totes-in-ShipHero)
- Totes are bulk-created in Orders > Totes ("Create Tote": warehouse, count, optional PDF of the new barcodes). The new Totes page is Dynamic Slotting accounts only; Static Slotting accounts use a Legacy page. (SNIPPET) — [ShipHero: How to Create Totes and Print Tote Barcodes](https://software-help.shiphero.com/hc/en-us/articles/4419345058445-How-to-Create-Totes-and-Print-Tote-Barcodes)
- A replacement label for a damaged/non-scanning tote can be reprinted from the Totes page; the same tote entity keeps its identity. Bulk renaming is not in the UI (support can do it from a CSV). (SNIPPET) — [ShipHero: Create/Manage Totes](https://software-help.shiphero.com/hc/en-us/articles/28617230628877-How-to-Create-Manage-Totes), [Troubleshooting Tote Scanning](https://software-help.shiphero.com/hc/en-us/articles/45885922541965-Troubleshooting-Tote-Scanning-Issues)
- When a pick is confirmed in the mobile app, inventory moves from the bin location into the tote (the tote holds inventory in the WMS). — [ShipHero Overview: Totes](https://software-help.shiphero.com/hc/en-us/articles/4419345058445-Overview-Totes-in-ShipHero)
- Multi-Item Batch: each order gets its own tote, so no sorting at packing; the app prompts the picker to choose a number of totes, and "Scanners confirm that the right item is placed in the correct tote for each order." The exact moment of the tote-to-order link (scan at start vs first drop) was NOT stated on any page I could fetch. — [ShipHero blog: pick methods and totes](https://www.shiphero.com/blog/pick-methods-and-totes), (SNIPPET) [ShipHero picking methods](https://software-help.shiphero.com/hc/en-us/articles/46892350249997)
- Packing: for MIB-picked orders the packer starts by scanning the tote barcode; "Tote QA" is a per-user setting. Without it, scanning the tote marks picked items packed automatically; with it on, the packer scans the tote then every unit. ShipHero suggests Tote QA for high-value items, complex SKU mixes, new staff. (SNIPPET - not confirmed on the Tote QA page) — [ShipHero Help search results](https://software-help.shiphero.com/hc/en-us/articles/4419345190925)
- Single Item Batch packing: scanning the tote barcode opens the packing screen for that batch; an order still in an active SIB tote errors on Bulk Ship ("Order [x] is currently in tote [name]"). — [ShipHero SIB packing](https://software-help.shiphero.com/hc/en-us/articles/8492413204365)
- Totes are empty after a `cleared_tote` event, i.e. the tote-to-order link is transient while the barcode is permanent. — [ShipHero community thread](https://community.shiphero.com/t/search-records-by-tote-id-barcode/1529)

**Veeqo**
- Three picking options: Single Tote (pick to pile; one tote for the whole batch, scanning it at the pack station retrieves all orders in the batch), Pick to Order (each order in the batch gets its own tote; scanning a tote at the pack station retrieves that order "for label purchase"), and Most Efficient (Veeqo chooses per batch). — [Veeqo digital picking overview](https://help.veeqo.com/en/articles/8306650-digital-picking-overview)
- Veeqo prints the tote barcodes ("Set Batch Size and Print Tote Barcodes"), recommends laminating them before attaching, and states "A tote is released when your order is dispatched so can be reused." So labels are permanent, order assignment is transient. — [Veeqo digital picking overview](https://help.veeqo.com/en/articles/8306650-digital-picking-overview)
- Tote count formula for Pick to Order: max order batch limit x number of pickers (e.g. 10 x 3 = 30), doubled if a different person packs; Pick to Pile: one per picker (doubled if different packer). — [Veeqo digital picking overview](https://help.veeqo.com/en/articles/8306650-digital-picking-overview)
- Packers can be forced to scan every item before shipping. (SNIPPET) — [Veeqo picking help](https://help.veeqo.com/en/articles/3802625-picking-your-orders)
- Whether the tote-to-order link is made by a scan at pick start or by Veeqo's batch assignment is not stated in what I read. Symbology/size of Veeqo's tote labels not stated.

**ShipStation**
- API v2 totes (added Feb 2026 per release notes): `POST /v2/totes` batch-creates totes; each needs `inventory_warehouse_id` and a name; `tote_barcode` is optional, max 100 chars, "Used for scanning during warehouse operations." Failures (e.g. duplicate names) are returned per tote. Also GET list, GET `/v2/totes/quantities`, GET/PUT/DELETE `/v2/totes/{tote_id}`; PUT can change name or barcode; delete is permanent. "Scan a tote barcode and retrieve its details with GET /v2/totes/{tote_id}." — [ShipStation: manage totes](https://docs.shipstation.com/manage-totes), [ShipStation V2 release notes](https://docs.shipstation.com/apis/release-notes.md), [Totes API reference](https://docs.shipstation.com/openapi/totes)
- The docs describe totes as used to organise items during picking and transport products to packing stations. They do NOT say totes are permanent assets, do not describe the pick-to-tote scan workflow, and do not define how a tote is bound to an order.
- ShipStation marketing describes pick-to-tote as batch picking where pickers "drop items into the right totes with barcode verification"; "Pick to Light" (LED-guided tote slot) was described as upcoming. Marketing material only. (SNIPPET) — [ShipStation blog: warehouse picking and packing](https://www.shipstation.com/blog/warehouse-picking-packing/)

**Starshipit** (comparable, clearest published workflow)
- Setting "One order per tote": picking 3 orders = scan 3 totes; "Each scanned tote is automatically linked to one of the orders." Optional "Must scan tote to place items" forces a tote scan before each item. With totes set to None, multiple orders can share a tote. After picking, "The totes are cleared and ready for the next pick." — [Starshipit: Scan totes for picking](https://support.starshipit.com/articles/12616572135055-scan-totes-for-picking)
- Packing: mobile Packing tab, scan or type the tote ID and "only see orders linked to that tote"; web "Pack by Tote" opens straight into the order if the tote holds one, otherwise lists the orders. — [Starshipit: Scan totes for picking](https://support.starshipit.com/articles/12616572135055-scan-totes-for-picking)
- The article does not say whether tote barcodes are pre-printed; the "reused" language implies permanent totes.
- Shippit: staff scan a tote when starting pick and when starting pack. (SNIPPET) — [Shippit: scanning a tote](https://support.shippit.com/en-US/shippit/article/mJaB8IN4-scanning-a-tote)

**Pikr** (a picking app that sits beside a third-party shipping system)
- Tote setup generates sequential barcodes numbered 1-100 for rapid scanning; pickers "Scan to Assign" 1 picking tote to 1 order. (SNIPPET) — [Pikr: setup totes for picking](https://pikr.helpscoutdocs.com/article/56-setup-totes-for-picking). Pikr's other setup pages (articles 79, 94) returned 404 when fetched; a search snippet claimed Pikr specifies Code 128 for custom tote barcodes (UNVERIFIED, not read on the page).

**Logiwa**
- Pick and Sort needs a mobile cart and tote (LP type) configured in MyLogiwa. Each order gets one cell on the cart, so cells >= orders; a cart holds one job at a time. The picker scans the LP number (not the location) when allocation is to an LP; the screen then shows SKU, qty, source location and the assigned cell. (SNIPPET) — [Logiwa: Pick and Sort](https://intercom.help/mylogiwa/en/articles/7033157-pick-and-sort)
- LP labels by default carry a barcode plus physical properties (dimensions, weight), editable in the report designer. Scanning an LP never triggers GS1 parsing; lot/expiry are inherited from the LP's tracking data. (SNIPPET) — [Logiwa: printouts](https://intercom.help/mylogiwa/en/articles/7308684-printouts-in-logiwa), [Logiwa: GS1 and custom barcode parsing](https://intercom.help/mylogiwa/en/articles/17336499-gs1-and-custom-barcode-parsing)
- Cell-barcode printing/scanning details were not found.

**Odoo**
- Package = logistics container such as a tote or pallet. Cluster/batch picking: recommended to give each picking its own (disposable) package recorded in the Destination Package field; once a package is assigned to a picking Odoo suggests it (name in italics) under the product. Barcode app flow: scan source location, then product and package. Each operation type can be configured to require scanning of source location, product, serials, package, destination location. (SNIPPET) — [Odoo docs: process batch transfers](https://www.odoo.com/documentation/master/applications/inventory_and_mrp/barcode/operations/process_transfers.html), [Cybrosys Odoo 18 batch transfers](https://www.cybrosys.com/odoo/odoo-books/v18/barcode/batch-transfers/)
- Odoo packages are described as disposable per-pick objects, unlike ShipHero/Veeqo totes; whether Odoo packages can be reused across batches was not confirmed here.

**Infoplus** (cart positions)
- Each cart position gets a barcode label (an LPN); the picker scans a cart position per order, then scans and places items into those positions. (SNIPPET) — [Infoplus: pick to cart](https://www.infopluscommerce.com/knowledge-base/use-the-pick-to-cart-fulfillment-option-1)

**Not covered:** Packiyo (only a Getting Started page about pack-station barcode scans found, no tote documentation), SkuVault, Linnworks, SKULabs (not searched due to budget).

### Inferences
- Common industry pattern: permanent tote entity with barcode (and warehouse scope) plus a transient tote-to-order binding created by the WMS at pick and released at ship/clear. Only the binding is per-order.
- ShipStation's bulk `POST /v2/totes` with name + optional barcode points to the same model (pre-created assets, probably printed once), but ShipStation docs do not confirm it.
- Binding moment varies: explicit scan per order (Starshipit, Pikr, likely ShipHero MIB), cart-cell pre-assignment (Logiwa), system assignment (Veeqo likely). Not confirmed for ShipHero and Veeqo.

### Gaps
- Exact ShipHero MIB binding moment, and the Tote QA article itself ("How to Use Tote QA in ShipHero", "Overview: Using Totes in ShipHero") were not fetched.
- Veeqo and ShipStation: how the tote-to-order binding is made at pick time.
- Packiyo, SkuVault, Linnworks, SKULabs: no data.

## 2. Does any product put the ORDER barcode on the tote (per-order label)?

### Takeaway
Among the products with totes as entities, none was found that prints the order number on the tote as the primary mechanism. Order-barcode-on-paper (packing slip) is ShipStation's Scan to Print model, and a ShipHero community case shows operators who have only a tote barcode and no paperwork.

### Cited Findings
- ShipHero community: integrators describe users with "only a tote barcode, with no order paperwork," needing to look up the order from the tote. The tote barcode, not an order barcode, is the only thing on the container. — [ShipHero community thread](https://community.shiphero.com/t/search-records-by-tote-id-barcode/1529)
- Infoplus paperless flow: tote IDs are shown on the operator view and disappear once the order ships so the tote can be reused (tote permanent; order looked up). (SNIPPET) — [Paperless Pick and Pack Workflow](https://justservematerials.byu.edu/DSF/documentation/en/HTML/AdminHelp/Fulfillment/Paperless_Pick_and_Pack_Workflow.htm)
- ShipStation's Scan to Print model: the workstation has Scan to Print open and the only other equipment needed is a barcode scanner; the scan target is the order barcode (packing slip / action sheets). The order barcode lives on paper, not on the tote. — [ShipStation blog: scan to print](https://www.shipstation.com/en-ca/blog/scan-to-print-shipping-workflow.md), [Spartan POS hardware guide](https://spartanpos.com/pages/shipstation-hardware-guide-printers-scanners-scales-labels)

### Inferences
- Per-order container labels (order number on a tag/slip dropped in the tote) are the fallback when the pack software cannot own a tote entity; the cost is printing per order and no container tracking. No source found stating this reasoning explicitly; this is inference.

### Gaps
- No vendor documentation found that uses a per-order label on the tote as a designed workflow. Vendors' stated reasons for permanent labels are thin (Veeqo only says totes are reusable and recommends lamination).

## 3. Third-party pack station resolving a fixed tote barcode (e.g. ShipStation Scan page, keyboard-wedge translators)

### Takeaway
I found no evidence of anyone using fixed tote barcodes with ShipStation's Scan to Print page, and no "translator" tool mapping a tote scan to an order barcode. The closest evidence is the ShipHero integrator thread, which shows a third party needs an API tote-to-order lookup that the WMS must expose, and ShipHero's was poorly documented.

### Cited Findings
- ShipHero community: a developer building a shipping integration wanted the shipper to scan the tote barcode and have the system pull in order info to ship; the `tote_history` query needed a `tote_uuid`, `tote_id` inconsistently expected name/ID/UUID, and a user found an under-documented `tote(barcode:)` GraphQL query returning the tote's orders and picks. ShipHero said the tote-to-orders view exists in the UI (Dashboard > Totes), and in Nov 2022 said feedback had been passed to the team; no endpoint was announced in the thread. — [ShipHero community thread](https://community.shiphero.com/t/search-records-by-tote-id-barcode/1529)
- ShipStation Scan to Print: only a workstation with Scan to Print open plus a scanner; ShipStation lists the Zebra LS2208 as a tested scanner. — [ShipStation blog: scan to print](https://www.shipstation.com/en-ca/blog/scan-to-print-shipping-workflow.md), [Spartan POS hardware guide](https://spartanpos.com/pages/shipstation-hardware-guide-printers-scanners-scales-labels)
- A Shopify community user asked how to tie a bin barcode scanned during picking into ShipStation's scan-to-verify; no solution was given. — [Shopify community](https://community.shopify.com/t/how-to-integrate-a-wireless-1d-barcode-scanner-with-shipstation-for-order-fulfillment/105021)
- Scandit "Keyboard Wedge" is a general app that makes a phone/tablet camera type into any focused field; nothing ties it to ShipStation or tote mapping. — [DC Velocity](https://www.dcvelocity.com/articles/42202-scandit-keyboard-wedge-enables-companies-to-add-barcode-scanning-capabilities-to-any-app)
- ShipStation `GET /v2/totes/{tote_id}` can retrieve a tote when you "scan a tote barcode," but the docs do not say the Scan page or any ShipStation UI resolves a tote scan to an order. — [ShipStation: manage totes](https://docs.shipstation.com/manage-totes)
- Pikr is a separate picking app that assigns totes to orders; I could not read its integration pages (404), so whether it works with ShipStation is UNVERIFIED.

### Inferences
- A third-party pack station can resolve a fixed tote barcode only if the system that owns the tote-to-order binding exposes a lookup (as the ShipHero thread shows). A separate app (like ShipStation's Scan page) that expects an order number/barcode would need a translation layer (keyboard-wedge helper or custom app) built by the user; no precedent found. Treat as feasible engineering, not established practice.

### Gaps
- No Reddit/ShipStation Community posts found on fixed tote barcodes with ShipStation's Scan page (searches returned none; the ShipStation community site was not searched directly). Absence of evidence, not evidence of absence.
- Whether ShipStation's Scan to Print accepts a user-defined barcode or only order number/tracking/SKU was not verified.

## 4. Reusable tote label specs, cost, totes per cart, colour coding

### Takeaway
Code 128 is the common symbology for LPN-style labels; laminated labels with permanent adhesive are standard. Specific 2x4 in sizing, short-side/lid placement, cost, and colour conventions were not found in vendor docs.

### Cited Findings
- Code 128 (or GS1-128) is the common choice for LPN/container labels; legacy sites use Code 39. Labels should include human-readable text, a quiet zone, adequate x-dimension and bar height to reach grade C or better. (SNIPPET) — [Racklify: LPN guide](https://racklify.com/encyclopedia/lpn-comprehensive-guide-to-license-plate-numbers-in-warehousing/), [Cleverence LPN template](https://cleverence.com/label/templates/gallery-lpn-pallet-tag)
- Vendor tote bin labels exist as laminated 2" x 10" and 2.5" x 10" sets with permanent adhesive (bin-edge labels; price not captured). (SNIPPET) — [ASG tote bin labels](https://asgonlinestore.com/2-x-10-laminated-tote-bin-labels-qty-150/)
- Veeqo recommends laminating tote barcodes; tote count rules above (e.g. 10-order batch limit x 3 pickers = 30 totes). — [Veeqo digital picking overview](https://help.veeqo.com/en/articles/8306650-digital-picking-overview)
- ShipHero troubleshooting for non-scanning totes: check for damage/obscuring, check warehouse assignment, reprint the label. (SNIPPET) — [ShipHero Troubleshooting Tote Scanning](https://software-help.shiphero.com/hc/en-us/articles/45885922541965-Troubleshooting-Tote-Scanning-Issues)
- Logiwa: a cart needs cells >= orders; one job per cart; no cell count given. (SNIPPET) — [Logiwa: Pick and Sort](https://intercom.help/mylogiwa/en/articles/7033157-pick-and-sort)
- ShipHero names totes automatically, but a community user wanted custom names like "Green-42", hinting at colour+number naming by operators (user preference, not vendor convention). — [ShipHero community thread](https://community.shiphero.com/t/search-records-by-tote-id-barcode/1529)

### Inferences
- A 2x4 in label on the short side and lid is a reasonable design (two scan faces) but is my own suggestion, not from a source.

### Gaps
- No vendor-published tote label dimensions, cost per tote label, or lid/short-side placement guidance found.
- Totes per cart not specified by ShipHero, ShipStation, Starshipit, or Veeqo (Veeqo gives only a tote-count formula). Colour-coding conventions not found.

## 5. E-ink / electronic shelf labels as dynamic tote labels

### Takeaway
No product or case study was found using e-ink tags as dynamic tote labels showing an order barcode. Nothing on update latency or scan reliability.

### Cited Findings
- A search for e-ink tote/cart displays returned only software tote workflows (Infoplus cart-position LPNs, Pikr, Starshipit); no display-hardware material. — [Infoplus pick to cart](https://www.infopluscommerce.com/knowledge-base/use-the-pick-to-cart-fulfillment-option-1)
- ShipStation mentions "Pick to Light" (LED-guided tote slot on a cart) as an upcoming capability; related dynamic indication, but not e-ink. (SNIPPET, marketing) — [ShipStation blog](https://www.shipstation.com/blog/warehouse-picking-packing/)

### Inferences
- Because the WMS owns the tote-to-order binding in all products found, vendors have no reason to write order IDs on the tote; dynamic labelling mainly arises when the pack station is a separate tool.

### Gaps
- E-ink barcode scan reliability, refresh latency, cost, vendor case studies: not found. Would need a targeted search of ESL vendors (e.g. Hanshow, SES-imagotag, Pricer) for pick-to-cart use; not done.
