# ShipStation Native Warehouse / Picking Features and API Exposure (state as of October 2026)

Research date / access date for every source below: 2026-10-19. Official pages that returned HTTP 403 to WebFetch (help.shipstation.com) were read with the in-app browser and through Zendesk's public Help Center JSON API (`/api/v2/help_center/en-us/articles/{id}.json`). Plan check-marks in the help-center plan article are images; they were decoded from each image's alt text ("Green checkmark. Supported feature. Yes." / "Red X mark. Unsupported feature. No."). The V2 API facts come from the live OpenAPI bundle `https://docs.shipstation.com/_bundle/apis/@shipstation-v2/openapi.json` (info.version 2.0.0) and from the V2 release notes. The community forum (community.shipstation.com) now requires login ("Access forbidden ... not logged in"), so forum content below comes only from search snippets and is marked unverified.

Labels used: **[OFFICIAL]** = a ShipStation-owned page (help center, docs, pricing, blog, or ShipStation's own app-store listing). **[THIRD-PARTY]** = anyone else. **[UNVERIFIED]** = seen only in a search snippet or inferred.

---

## 1. Plan tiers in 2026 and feature gating

### Takeaway
ShipStation (US/CA) has three plans in 2026: Starter (from $14.99/mo, 3 users), Standard (from $29.99/mo, 10 users) and Premium (from $349.99/mo, 15 users). Price rises with shipment volume.
- **Standard is the minimum plan** for API access, Mobile Picking and the Scan page (Scan to Verify / Print).
- **Premium only:** Pick to Tote, Scan to Receive, Cubiscan, Purchase Orders, Transfer Orders, Forecasting, and "advanced" inventory management.
- **Pick to Light:** announced as Premium and "coming soon". It is not released.

### Cited Findings

**Prices and users [OFFICIAL]**
- Pricing page tiers (monthly price by shipments/month) — [ShipStation Pricing](https://www.shipstation.com/pricing/)
  - **Starter:** 50 for $14.99; 100 for $29.99; 500 for $39.99; 1,000 for $79.99; 2,000 for $119.99; 5,000 for $174.99.
  - **Standard:** 50 for $29.99; 100 for $59.99; 500 for $89.99; 1,000 for $149.99; 2,000 for $174.99; 5,000 for $249.99; 7,500 for $349.99; 10,000 for $449.99; 15,000 for $649.99; 20,000 for $799.99; 30,000 for $1,149.99; 40,000 for $1,499.99; 50,000 for $1,849.99; 75,000 for $2,799.99; 100,000 for $3,599.99.
  - **Premium:** 50 for $349.99; 100 for $399.99; 500 for $449.99; 1,000 for $599.99; 2,000 for $699.99; 5,000 for $799.99; 7,500 for $949.99; 10,000 for $1,099.99; 15,000 for $1,349.99; 20,000 for $1,499.99; 30,000 for $2,249.99; 40,000 for $2,999.99; 50,000 for $3,749.99; 75,000 for $5,699.99; 100,000 for $7,499.99.
  - An annual option advertises 20% savings. Standard is labelled "MOST POPULAR".
- Users included: Starter 3, Standard 10, Premium 15. "Purchase Additional Users" is available on all plans. The help-center plan table lists "$14.99/month / $29.99/month / $349.99/month" as starting prices (US & CA). AU prices are $20 / $50 / $540; UK prices are £10 / £25 / £270. The article was updated 2026-09-30 — [Learn About ShipStation Subscription Plans](https://help.shipstation.com/hc/en-us/articles/38800795536027-Learn-About-ShipStation-Subscription-Plans)

**Warehouse Management table (Starter / Standard / Premium), decoded from the help center [OFFICIAL]** — [Subscription Plans](https://help.shipstation.com/hc/en-us/articles/38800795536027-Learn-About-ShipStation-Subscription-Plans)

| Feature | Starter | Standard | Premium |
|---|---|---|---|
| Hot Keys (Basic) | Yes | Yes | Yes |
| Hot Keys: Barcode actions & Custom Hot Keys | No | Yes | Yes |
| Pick Lists | Yes | Yes | Yes |
| Packing Slips | Yes | Yes | Yes |
| Packing Slips (Customized) | No | Yes | Yes |
| Mobile Picking | No | Yes | Yes |
| **Pick to Tote** | No | No | **Yes** |
| Barcode Scanning (Scan Page Access) | No | Yes | Yes |
| Barcode Scanning (Reports page) | No | Yes | Yes |
| **Cubiscan** | No | No | **Yes** |

**Inventory Management table, same article [OFFICIAL]**

| Feature | Starter | Standard | Premium |
|---|---|---|---|
| Product Catalog | Yes | Yes | Yes |
| Inventory Grid (CSV uploads for tracking) | Yes | Yes | Yes |
| Product Bundles | No | Yes | Yes |
| Lot Tracking | No | Yes | Yes |
| Inventory Sync | No | Yes | Yes |
| Serial Number Tracking | No | Yes | Yes |
| Forecasting / Reorder Assist | No | No | Yes |
| Purchase Orders | No | No | Yes |
| **Scan to Receive** | No | No | **Yes** |
| Transfer Orders | No | No | Yes |

- The summary row "Inventory Management" in the same article's top table shows No / No / **Yes**, so it reads as Premium-only. This conflicts with the detail rows above, where several inventory features are on Starter and Standard.

**API, webhooks and other rows, same article [OFFICIAL]**

| Feature | Starter | Standard | Premium |
|---|---|---|---|
| API Access | No | Yes | Yes |
| Webhooks | Yes | Yes | Yes |
| Zapier | Yes | Yes | Yes |

- **Conflict on ODBC.** The top table shows ODBC as Premium-only. The "Data & Reporting" table shows ODBC on Standard and Premium. — [Subscription Plans](https://help.shipstation.com/hc/en-us/articles/38800795536027-Learn-About-ShipStation-Subscription-Plans)

**Pricing-page wording [OFFICIAL]** — [ShipStation Pricing](https://www.shipstation.com/pricing/)
- Starter WMS: "Basic hot keys only".
- Standard: "Basic warehouse management".
- Premium: "Advanced warehouse management (pick to tote)".
- "Barcode scan, verify & print" is Standard and Premium.
- "Advanced inventory management", Scan to Receive and Cubiscan are Premium only.
- The only "coming soon" badge on the pricing page is "AI Copilot (coming soon)". Pick to Light, mobile app and warehouse locations do not appear on the pricing page.

**Blog wording (last updated June 26, 2026, author Rob Zaleski) [OFFICIAL]** — [ShipStation blog: Built for the Warehouse Floor](https://www.shipstation.com/blog/warehouse-picking-packing/)
- "Warehouse picking features are available on ShipStation Standard and Premium plans."
- "Mobile Picking and barcode scanning are available on Standard."
- "Pick-to-Tote, Picking Exceptions, Scan to Verify, and Pick to Light (coming soon) are available on Premium."
- **Conflict on Scan to Verify.** The blog puts Scan to Verify on Premium. The help-center plan table and the pricing page put the Scan page ("Barcode scan, verify & print") on Standard. The blog may mean scan-verify inside the mobile picking/packing flow, but that is unconfirmed.

**Cubiscan [OFFICIAL]**
- Help article (updated 2025-12-16): "Your account must either be on the Premium plan or you must activate the Cubiscan add-on for your account." So a non-Premium add-on exists. — [Use a Cubiscan Dimensioner](https://help.shipstation.com/hc/en-us/articles/9974733791387-Use-a-Cubiscan-Dimensioner)
- Supported models: Cubiscan 110, 125, 150, 225, 75, and 75 Pro.
- Requires ShipStation Connect, a static IP, and port 1050 by default.

**Branding [OFFICIAL]**
- The help center uses the name "ShipStation Inventory", for example "If you're using ShipStation Inventory, inventory is automatically allocated when orders are marked as Ready to Pick." — [Introduction to Mobile Picking](https://help.shipstation.com/hc/en-us/articles/49132708040347-Introduction-to-Mobile-Picking)
- No "ShipStation WMS" product name appears on the official pages checked. The pricing page uses "Basic/Advanced warehouse management".
- A page titled "ShipStation WMS" exists but is a competitor's (SKUSavvy) comparison page, not ShipStation's. — [SKUSavvy](https://www.skusavvy.com/shipstation-wms) [THIRD-PARTY]

### Inferences
- For Freeze Pipe (2-5 staff), here is what each plan gives:
  - **Standard ($29.99+):** API, webhooks, Mobile Picking (basic batch picking with barcode scan), the Scan to Verify/Print page, pick lists, location-sorted pick lists and lot tracking.
  - **Premium ($349.99+ at 50 shipments, $599.99 at 1,000/mo, $799.99 at 5,000/mo):** additionally Pick to Tote, Scan to Receive, POs, Transfer Orders, Cubiscan, and Pick to Light when it ships.
  - The step from Standard to Premium is roughly $300-$550/month at small-warehouse volumes.
- The Picking Queue methods (Single-Order, Single-SKU and Multi-Item with totes) need totes. Their plan tier is not stated explicitly. They are probably covered by the Premium "Pick to Tote" row (see Gaps).

### Gaps
- No official page states the plan tier for the "Picking Queue" or for "Picking Exceptions" on its own. Picking Exceptions is named Premium only in the blog.
- The price of the Cubiscan add-on for non-Premium accounts was not found. The "Manage Account Add-Ons" article was not read.
- The ODBC conflict and the "Inventory Management" summary-row conflict are unresolved.

---

## 2. What ShipStation Pick to Tote / Picking Queue actually does

### Takeaway
- **Device:** pick-to-tote runs only in the ShipStation Mobile app (iOS, Android or Android scanner). The web app is only used to mark orders "Ready to Pick" into a batch or into the Picking Queue.
- **Tote assignment:** the picker chooses how many totes are on the cart. ShipStation assigns that many orders FIFO. The picker scans an empty tote barcode to bind it to an order, scans the location (skippable), scans the item, and drops it in that order's tote.
- **What it does not do:** there is no documented path optimization, warehouse map, tote-slot lights (yet), partial picking, or documented tote-scan step at packing.
- **Prerequisite:** it requires ShipStation Inventory and ShipStation warehouse locations to be the system of record.

### Cited Findings

**Two workflows [OFFICIAL]** — [Introduction to Mobile Picking](https://help.shipstation.com/hc/en-us/articles/49132708040347-Introduction-to-Mobile-Picking) (updated 2026-09-07)
- "Batch Picking: groups by order items so your Pickers can move through the warehouse and pick items in bulk to bring back to your packing station. You can use basic mobile picking or pick to tote with the batch picking method."
- "The Picking Queue: lets you assign an order to a tote so your Pickers can pack individual orders as they move through the warehouse. You can set your pick by single SKU, single-item, or multi-item orders."

**Getting orders into picking [OFFICIAL]** — [Mark Orders as Ready to Pick](https://help.shipstation.com/hc/en-us/articles/49132661261211-Mark-Orders-as-Ready-to-Pick) (updated 2026-04-14)
- Web app steps: Orders tab → Awaiting Shipment → select orders → **Ready to Pick** → choose a method.
  - "Add to new batch if you are using Basic Mobile Picking or Pick to Tote."
  - "Add to picking queue if you are using Single-Order, Single-Item SKU, or Multi-Item SKU picking."
- "If you are using ShipStation's Inventory feature order items must have inventory available to be able to mark orders as Ready to Pick."

**Pick to Tote requirements [OFFICIAL]** — [Pick Using Batches](https://help.shipstation.com/hc/en-us/articles/49132678007451-Pick-Using-Batches) (updated 2026-04-14)
- "Use Mobile Picking from ShipStation with a supported device."
- "Create and manage Totes in ShipStation."
- "Manage Inventory in ShipStation."
- "Manage Warehouse Locations."
- "Maintain accurate SKUs and UPCs for all products in ShipStation."

**Pick to Tote steps [OFFICIAL]** — [Pick Using Batches](https://help.shipstation.com/hc/en-us/articles/49132678007451-Pick-Using-Batches)
1. Mobile app → Pick tab → Batch Picking.
2. "Select the number of totes in your cart and click Next."
3. "If fewer totes than orders are available, the system will automatically assign orders to totes using FIFO (first in, first out). The number of orders will match the available totes, and any remaining orders will stay in Ready to Pick status in the mobile app."
4. "Go to the location shown on your screen and scan the location barcode." A "Skip Locations Scan" option exists.
5. "Scan an empty tote to assign it for your first pick ... You will need to scan a new tote for each order that includes the item you're currently picking."
6. "Scan the item barcode and place it in the corresponding orders tote. Continue to Pick your order items by following the location prompts on your screen."

**Basic mobile picking without per-order totes [OFFICIAL]** — [Pick Using Batches](https://help.shipstation.com/hc/en-us/articles/49132678007451-Pick-Using-Batches)
- The flow is: scan the location, then "Scan a tote to assign it for your first pick. You will need to scan a new tote for each item you're currently picking", then scan the SKU. The app tracks remaining quantities.

**Picking Queue methods [OFFICIAL]** — [The Picking Queue](https://help.shipstation.com/hc/en-us/articles/49132708418203-The-Picking-Queue) (updated 2026-06-11)
- Orders "flow into the mobile app as soon as they're marked ready to pick" and are organized FIFO. Requirements are the same as Pick to Tote.
- **Single-Order:** search the order number or scan the packing-slip barcode, then pick location by location into a tote.
- **Single-Item SKU:** "Select the SKUs you would like to pick. ShipStation will group all Single SKU orders ... Confirm the number of totes required for this pick. Each product requires its own tote." Also: "The mobile app will guide the picker through inventory locations if configured."
- **Multi-Item:** "Select the number of totes in your cart" (FIFO overflow rule as above). "Once completed each tote will contain a fully picked order that is ready to be packed."

**Tote setup (web) [OFFICIAL]** — [Manage Totes for Mobile Picking](https://help.shipstation.com/hc/en-us/articles/49132700371611-Manage-Totes-for-Mobile-Picking) (updated 2026-04-14)
- Totes are configured per inventory warehouse: Inventory Management Settings → Warehouses → (warehouse) → **Totes** tab.
- You can "Create a new tote(s) manually or via a CSV file", "Print Barcodes for existing tote(s)", and "Delete a single or multiple tote(s)."

**Item verification and statuses [OFFICIAL]** — [Introduction to Mobile Picking](https://help.shipstation.com/hc/en-us/articles/49132708040347-Introduction-to-Mobile-Picking)
- The scanned value is matched against "SKU, UPC or Fulfillment SKU". A mismatch gives an error message and an error sound. Manual entry is allowed.
- Statuses:
  - "Ready to Pick" — set in the web app.
  - "Picking" — "Triggered automatically when a user begins picking the batch from the mobile app".
  - "Picked" — "All items in the order were successfully verified and picked."
  - "These statuses are visible in both the mobile and web apps."
- Constraints:
  - "Orders must be in the Awaiting Shipping status to be eligible for Mobile Picking. Labels can only be created after picking."
  - "Partial picking is not supported. All order items must be picked, a partially picked order will be flagged as an exception."

**Sort order and route [OFFICIAL]**
- "Items can be sorted by: Item Quantity, Item Name, Item SKU, or Inventory Warehouse Location." This is under Settings → Warehouse → Picking. — [Configure Mobile Picking](https://help.shipstation.com/hc/en-us/articles/49132708104219-Configure-Mobile-Picking) (updated 2026-08-10)
- The same article grants per-user access through an "Order Picking" permission checkbox.
- On route optimization, the blog says only that pick-to-tote "cuts walking distance per order". There is no description of path optimization or a warehouse map. — [ShipStation blog](https://www.shipstation.com/blog/warehouse-picking-packing/)

**Exceptions and pickable locations [OFFICIAL]**
- Picking Exceptions: "If a bin is empty, an item is damaged, or a quantity doesn't match, pickers can flag the exception directly in the app." — [ShipStation blog](https://www.shipstation.com/blog/warehouse-picking-packing/)
- Non-Pickable locations (new, article updated 2026-09-24): reserve, overflow, quarantine, damaged and staging locations can be excluded from picking. This is set per location in the UI or through the CSV column `isPickable`. "Pickable settings are configured at the location level." — [Configure Pickable Inventory Locations](https://help.shipstation.com/hc/en-us/articles/52980439800347-Configure-Pickable-Inventory-Locations)

**Tote reporting gap [THIRD-PARTY / UNVERIFIED]**
- A search-engine summary of a ShipStation Community thread ("Mobile Picking Challenges/Opportunities", around Oct 2025) says users reported no reporting on which tote holds which order, making lost orders hard to find. The workaround was notes in bins. The thread could not be opened because it requires login. — [Community thread](https://community.shipstation.com/t5/ShipStation-Features/Mobile-Picking-Challenges-Opportunities/td-p/29746)

### Inferences
- **Cluster picking only.** The model is cluster picking onto a multi-tote cart, with one order per tote (Multi-Item) or one SKU per tote (Single-SKU). Orders are bound to totes at pick time by scanning the tote. There is no pre-assigned tote slot or cart position. Tote barcodes are free strings.
- **No tote-based packing hand-off.** No documented step at packing scans a tote to pull up its order. The documented packing flow is Scan to Verify, which starts from a **packing-slip barcode or order number**, not a tote (see Section 6).
- **"Route" is a sort.** The "route" is a sort by the location string (Area-Unit-Shelf-Bin). If location codes are named in walk order, the sort is a crude serpentine path. That is not true path optimization.
- **No hard cap found.** The only documented batch limiter is the number of totes on the cart, with FIFO overflow.
- **Multiple warehouses.** Totes and locations are scoped per inventory warehouse, so multiple warehouses are supported. A pick happens within one warehouse.

### Gaps
- How a packer uses a picked tote at the pack station (tote scan → order lookup) is not documented in any article found.
- Maximum orders, totes or items per batch are not documented.
- Whether a SKU stocked in several pickable locations is split across locations, or which location is chosen during a pick, is not documented.

---

## 3. ShipStation Mobile app in 2026

### Takeaway
"ShipStation Mobile" by Auctane is on iOS (4.6 stars, 6.2K ratings) and Android (2.3 stars, about 960 reviews). Version 2.12.05 was released Oct 6, 2026.
- **Warehouse functions:** Mobile Picking (batch, pick-to-tote, picking queue), Mobile Scan to Receive, Stock Audits (cycle counts and on-the-spot adjustments), and inventory views by product and location.
- **Other functions:** labels, pick lists and packing slips.
- **Complaints:** forced browser re-login, notification bugs, missing funding and insurance options, and that the app "has not kept up". No 2026 picking-specific reviews were found.

### Cited Findings

**Store listings**
- **iOS [OFFICIAL listing]:** "ShipStation Mobile", seller Auctane LLC. 4.6 / 6.2K ratings. Requires iOS 15.0 or later. Version 2.12.05, Oct 6. What's New: "V3 Required USPS dimensions". — [App Store](https://apps.apple.com/us/app/shipstation-mobile/id972151811)
  - Listed features include "Scan barcodes to find orders fast", "View & print pick lists & packing slips", and "VIEW INVENTORY • Keep track of on hand quantities • Filter by low stock • View empty locations • Filter by warehouse".
- **Android [OFFICIAL listing]:** 2.3 stars, 960 reviews, 100K+ downloads, "Updated on Oct 6, 2026". — [Google Play](https://play.google.com/store/apps/details?id=com.shipstation.app&hl=en_US)
  - The listing has a "MOBILE PICKING" section: "Eliminate paper pick lists • Reduce picking errors with barcode scanning • Track real-time progress and picker performance".

**Supported devices for picking [OFFICIAL]** — [Introduction to Mobile Picking](https://help.shipstation.com/hc/en-us/articles/49132708040347-Introduction-to-Mobile-Picking)
- iOS 15.0+.
- Android phone or tablet 10.0+.
- "Android-based barcode scanners".
- Bluetooth handheld scanners paired to a phone acting as keyboard input.
- "Camera-based scanning is supported natively on both Android and iOS platforms."

**Feature list and staleness [OFFICIAL]**
- An older features article (updated 2025-07-29) lists import orders, create/print labels, assign orders, hold/cancel, void labels, returns, and "Use your device as a Barcode scanner to pull up orders" and "Mobile Picking". — [ShipStation Mobile: Features](https://help.shipstation.com/hc/en-us/articles/360025853692-ShipStation-Mobile-Features)
- It says postage purchase is "Android App Only".
- Its requirements line ("iOS 11.0 and up or Android OS 6.0") is out of date compared with the picking article.

**Inventory in the app [OFFICIAL]**
- Inventory view: on-hand, allocated and available by product, plus "stock counts for each inventory location the product is stored in". — [Mobile: View Products & Inventory](https://help.shipstation.com/hc/en-us/articles/360028674672-Mobile-View-Products-Inventory) (updated 2026-06-03)
  - The same article says "Mobile Inventory is currently view-only". This conflicts with the newer Stock Audits and Scan to Receive articles below, which describe mobile stock changes.
- Mobile Scan to Receive: Inventory → warehouse → Receive Stock → scan or search the SKU → quantity → optional lot fields → Submit. — [Mobile Scan to Receive](https://help.shipstation.com/hc/en-us/articles/51191772130715-Mobile-Scan-to-Receive) (updated 2026-06-08)
  - Premium per the plan table.
- Stock Audits (article updated 2026-08-14): — [Stock Audits](https://help.shipstation.com/hc/en-us/articles/54438805190555-Stock-Audits)
  - Audits are assigned from the web and completed on mobile: go to the location, "Scan or manually verify the location", confirm the count, "stock levels will be updated immediately".
  - There is also an on-the-spot single-SKU adjustment.
  - Requires the inventory management permission and ShipStation-managed inventory.
- A search-engine summary claimed the App Store release notes mention a bin-to-bin "Move Stock" workflow. This was not visible on the listing page read. [UNVERIFIED]

**Reviews [OFFICIAL listings, user content]**
- iOS (Aug 29 [2026 presumed]): "The app has not kept up with the service". Cannot add funds; ParcelGuard insurance is unavailable in the app. — [App Store](https://apps.apple.com/us/app/shipstation-mobile/id972151811)
- Android (Apr and Jun 2025): users are forced to log in through a browser before the app, repeatedly, and get phantom or delayed new-order notifications. Auctane replied (May 12, 2025) that it is "actively working on resolving the issues with the browser-based login". — [Google Play](https://play.google.com/store/apps/details?id=com.shipstation.app&hl=en_US)

### Inferences
- **Fit for Freeze Pipe.** The app is a credible floor tool for picking and receiving at Freeze Pipe's scale.
- **Login friction.** Session and re-login problems reported on Android could hurt shared warehouse devices. This is worth piloting before committing.
- **Locked-down UX.** The pick flow cannot be customized or extended. There is no SDK, plugin or deep-link API (none found).

### Gaps
- Full App Store version history (2026 entries) could not be expanded.
- No reviews specific to mobile picking or pick-to-tote in 2026 were found on app stores, G2 or Capterra.

---

## 4. ShipStation inventory, warehouses and bin locations (UI and API)

### Takeaway
ShipStation Inventory has a real location model. It goes Inventory Warehouse → Locations (Area/Unit/Shelf/Bin hierarchy, an optional location barcode, and a Pickable flag). Stock is tracked per SKU per location (on_hand, allocated, available).
- **API:** the V2 API exposes `/v2/inventory`, `/v2/inventory_warehouses` and `/v2/inventory_locations`, available on ShipStation Standard and Premium.
- **Legacy field:** the old V1 `warehouseLocation` is a single free-text string per product or order item.
- **Pick lists:** these can pull either the legacy "Shipping Location" string or the real "Inventory Location".
- **Packing slips:** these print only the first location.

### Cited Findings

**Location model [OFFICIAL]** — [Set Up & Manage ShipStation Internal Inventory](https://help.shipstation.com/hc/en-us/articles/360026158531-Set-Up-Manage-ShipStation-Internal-Inventory) (updated 2026-09-28)
- An Inventory Warehouse must be linked as "Inventory Source" to a Ship From Location.
- "You can also configure your Inventory Warehouse to mirror your actual warehouse layout (for example, if your warehouse is separated into aisles, rows, and bins). By adding Locations, you can have ShipStation show specifically where each item is located (for example, Toy A is located in B-24-7)."
- Warehouse Layout levels: "Area, Unit, Shelf, and Bin".

**Packing slips and pick lists [OFFICIAL]**
- Packing slips: "If you have more than one warehouse in your product's inventory list, ShipStation will always print the first Location in this list on the packing slip." Items must be allocated for the location to print. A custom-template field replacement `[Product Location]` exists. — [Internal Inventory Settings](https://help.shipstation.com/hc/en-us/articles/360036064071-Internal-Inventory-Settings) (updated 2026-10-07)
- Pick lists: "ShipStation can pull warehouse location data from 2 different places: Shipping Location and Inventory Location. Shipping Location exists in your Products > Parent Product Details under the Shipping tab. Inventory Location exists in ... the Inventory tab." — [Pick Lists](https://help.shipstation.com/hc/en-us/articles/360026157971-Pick-Lists) (updated 2026-05-05)
  - "To show the inventory location, the order must first be allocated as committed inventory."
  - Pick-list order options include "Warehouse location" and "Warehouse location then SKU".

**Internal inventory features [OFFICIAL]** — [Inventory in ShipStation](https://help.shipstation.com/hc/en-us/articles/360025870392-Inventory-in-ShipStation) (updated 2026-09-09)
- Committed inventory, Reorder Assist, Inventory Sync (Shopify, Amazon, Etsy, eBay, Walmart, WooCommerce, BigCommerce), lot tracking, bundles, POs, Scan to Receive, serial numbers, Transfer Orders, and Units of Measure.
- ShipStation can alternatively display **external** inventory counts from Shopify or partner systems such as Finale, Cin7 and SkuVault. In that mode ShipStation "makes a special API call to the inventory management system to request stock counts only when you view the order".

**V1 API field [OFFICIAL]**
- V1 `OrderItem.warehouseLocation` is a "string | The location of the product within the seller's warehouse (e.g. Aisle 3, Shelf A, Bin 5)". — [V1 Order Item model](https://docs.shipstation.com/apis/shipstation-v1/docs/models/order-item.md)
- V1 `Product.warehouseLocation` is a string "associated with the product record". — [V1 Product model](https://docs.shipstation.com/apis/shipstation-v1/docs/models/product.md)

**V2 inventory endpoints [OFFICIAL]** — [V2 OpenAPI bundle](https://docs.shipstation.com/_bundle/apis/@shipstation-v2/openapi.json); [Release notes](https://docs.shipstation.com/apis/release-notes.md)
- Added January 2025:
  - `GET/POST /v2/inventory`
  - `GET/POST/GET{id}/PUT/DELETE /v2/inventory_warehouses`
  - `GET/POST/GET{id}/PUT/DELETE /v2/inventory_locations`
- `GET /v2/inventory` "Lists the inventory-related properties (`on_hand`, `allocated`, `available` and `average_cost`) of the SKUs ... Filter by `sku`, `inventory_warehouse_id` or `inventory_location_id`."
  - Has a `group_by` parameter with enum `warehouse | location`.
  - Each response row carries `sku, on_hand, allocated, available, average_cost, inventory_warehouse_id, inventory_location_id`. In other words, multiple locations per SKU are supported.
- `POST /v2/inventory` requires `transaction_type` (`increment`, `decrement`, `adjust`, ...), `sku`, `quantity` and `inventory_location_id`.
- `POST /v2/inventory_locations`: "The `name` must follow the area - unit - shelf - bin layout defined in ShipStation, for example `A1 - 12 - B2 - 24`."
  - The body is `name`, `inventory_warehouse_id`, and optional `barcode` ("Physical barcode label for warehouse location bins/shelves used during pick/pack operations").
  - The API create schema has no `isPickable` field. That flag is set in the UI or by CSV.
- **Plan gating:** every one of these endpoints has the Endpoint-access block "ShipStation: Standard, Premium" (Free/Starter greyed out). For ShipStation API (formerly ShipEngine), the plans are "Free, Advanced, Enterprise". The docs explain: "Plans highlighted in green can access the endpoint. Plans in gray do not include access". — [Products and Plans](https://docs.shipstation.com/products-and-plans.md)

### Inferences
- **The location model could serve as Freeze Pipe's bin master.**
  - ShipStation's model (warehouse → location string with 4 levels → barcode → per-location stock) is close to a basic WMS bin model and is writable over the V2 API.
  - It has no coordinates, no zones or pick-sequence number, no capacity or dimensions, and no 3D map.
  - Path order can only come from how location names sort.
- **ShipStation must own the stock.** Pick to Tote and the Picking Queue require "Manage Inventory in ShipStation". If the ERP is the stock-of-record, using ShipStation's tote picking means either:
  - syncing stock and locations both ways ERP↔ShipStation through `/v2/inventory` and `/v2/inventory_locations`, or
  - making ShipStation the stock-of-record.
  - Either way there is a risk of drift and double entry.
- **Plan split.** Inventory API access appears on Standard, but Scan to Receive, POs and Transfer Orders in the UI are Premium.

### Gaps
- Whether the V2 inventory endpoints refuse calls when the account's internal inventory features are not enabled was not tested.
- Rate limits for V2 were not checked here; this was covered by the earlier researcher.

---

## 5. V2 API endpoints relevant to picking, and the 2026 changelog

### Takeaway
- `/v2/totes` (Feb 2026) is CRUD for **tote master data only**: name, barcode and warehouse. It has no order assignment, contents, or pick state.
- Batch user assignment (Sep 2026), shipment user assignment (Apr 2026) and batch packing slips (Oct 2026) exist.
- **Nothing in the V2 spec exposes Ready to Pick / Picking / Picked / Verified statuses, pick lists, or picking webhooks.**

### Cited Findings

**V2 release notes, verbatim [OFFICIAL]** — [ShipStation API v2 Release Notes](https://docs.shipstation.com/apis/release-notes.md)
- **October 2026:**
  - "Packing slips for batches. Set `generate_packing_slips` when creating (`process_labels`) or processing a batch to place packing slips in line with the labels in `label_download` and to receive a `packing_slip_download` link in the batch response."
    - "POST /v2/batches - `process_labels.generate_packing_slips` request property"
    - "POST /v2/batches/{batch_id}/process/labels - `generate_packing_slips` request property"
  - Also added: `delivery_prediction` and `POST /v2/delivery_predictions`.
- **September 2026:**
  - "User assignment for batches."
    - "PUT /v2/batches/{batch_id}/user - Assign a user to a batch"
    - "DELETE /v2/batches/{batch_id}/user - Unassign a user from a batch"
  - Also added: shipment hold/restore (single and up to 500).
- **August 2026:** `/v2/products` get/create/update/deactivate.
- **July 2026:** Checkout Rates.
- **June 2026:** Carrier Document Upload (customs docs).
- **April 2026:**
  - "POST /v2/shipments/user - Assign a user to up to 500 shipments at once"
  - Also added: `/v2/mailing`.
- **March 2026:** `/v2/purchase_orders` (including `/receives`) and `/v2/suppliers`.
- **February 2026:** "`/v2/totes` endpoint with the following operations":
  - "GET /v2/totes - List all totes, optionally filtered by warehouse"
  - "POST /v2/totes - Create multiple totes in batch"
  - "GET /v2/totes/quantities - Get tote counts grouped by warehouse"
  - "GET /v2/totes/{tote_id} - Get a specific tote by ID"
  - "PUT /v2/totes/{tote_id} - Update a tote's name or barcode"
  - "DELETE /v2/totes/{tote_id} - Delete a tote"
- **August 2025:** `/v2/fulfillments`.

**Tote schema [OFFICIAL]** — [V2 OpenAPI bundle](https://docs.shipstation.com/_bundle/apis/@shipstation-v2/openapi.json); [Manage Totes guide](https://docs.shipstation.com/manage-totes.md)
- `tote` = `{tote_id, inventory_warehouse_id, tote_name (max 100), tote_barcode (max 100, optional), created_at}`. Description: "A tote (bin or container) used in warehouse picking and packing operations."
- `POST /v2/totes` takes `{totes:[{inventory_warehouse_id, tote_name, tote_barcode?}], return_succeeded_totes}`. It returns `succeeded_totes` and `failed_totes`, with errors such as "A tote with this name already exists in the warehouse".
- The guide warns: "Deleting a tote is permanent and cannot be undone. Ensure the tote is no longer in use before deleting it."
- Access: ShipStation Standard and Premium.

**Batches [OFFICIAL]**
- The batch object has `assigned_user` (uuid, read-only). `POST /v2/batches` accepts `assigned_user` at creation ("The user must be an active member of your account"). `PUT /v2/batches/{id}/user` "replaces any existing assignment".
- `batch_status` enum: `open, queued, processing, completed, completed_with_errors, archived, notifying, invalid`. These are **label-processing** states, not picking states.
- Shipments carry `assigned_user`. `shipment_status` enum: `pending, processing, label_purchased, cancelled`.
- `GET /v2/users` lists account users (to obtain user UUIDs).
- Source: [V2 OpenAPI bundle](https://docs.shipstation.com/_bundle/apis/@shipstation-v2/openapi.json)

**Webhooks [OFFICIAL]**
- V2 `webhook_event` enum: `batch, carrier_connected, order_source_refresh_complete, rate, report_complete, sales_orders_imported, track, batch_processed_v2, fulfillment_rejected_v2, fulfillment_shipped_v2, label_created_v2, shipment_created_v2, track_event_v2`. **No pick, pack, tote or verify events.** — [V2 OpenAPI bundle](https://docs.shipstation.com/_bundle/apis/@shipstation-v2/openapi.json)
- "The ShipStation platform supports creating ShipStation API v1 ... webhook events only. To create ShipStation API v2 webhook events, use the API endpoint" `POST /v2/environment/webhooks`. — [Webhooks Overview](https://docs.shipstation.com/apis/docs/guides/webhooks-overview.md)

**Full-spec search [OFFICIAL]**
- A text search of the entire V2 OpenAPI bundle for `ready_to_pick`, `picking`/`picked` status fields and `verified` found only:
  - tote descriptions ("picking and packing operations"),
  - carrier/freight "picked up" wording,
  - address-validation "verified".
- There is **no pick-list endpoint, no picking-status field, and no packing-verification field.**
- Source: [V2 OpenAPI bundle](https://docs.shipstation.com/_bundle/apis/@shipstation-v2/openapi.json)

### Inferences
- **What an external ERP can do over the API:**
  - pre-create and print tote master records with barcodes,
  - create and maintain locations and stock,
  - create label batches and assign them to a user,
  - assign shipments to users,
  - get batch packing slips.
- **What it cannot do:**
  - see which order is in which tote,
  - mark orders Ready to Pick,
  - read Picking/Picked progress,
  - get picker or exception data.
- **Batches are probably label batches.** V2 "batches" are label batches (`process/labels`). Whether a V2-created batch is the same object as a mobile "picking batch" created by "Ready to Pick → Add to new batch" is not documented. The OpenAPI batch schema has no picking fields, so treat them as label batches.

### Gaps
- No official statement was found on whether picking statuses will be added to the API or webhooks.
- Whether V2 batch `assigned_user` appears in the mobile picking UI is undocumented.

---

## 6. Can pick/pack status flow to or from an external ERP in real time?

### Takeaway
**No, not in either direction through any documented API.**
- **Out of ShipStation:** the Picking statuses and the Scan to Verify "Verified" state are visible only in the ShipStation web and mobile UIs. Webhooks fire only on order import, shipment and label creation, batch processing, fulfillment and tracking.
- **Into ShipStation:** there is no endpoint to mark an order picked or verified.
- **What the ERP can use:**
  - V1 order/shipment webhooks (as already used by Freeze Pipe),
  - V2 `label_created_v2` / `shipment_created_v2` / `fulfillment_shipped_v2` as "packed/shipped" proxies,
  - tags, holds and user assignment as coarse signals.

### Cited Findings

**Scan to Verify behaviour [OFFICIAL]** — [Verify & Print Shipments with Barcode Scan](https://help.shipstation.com/hc/en-us/articles/360031021831-Verify-Print-Shipments-with-Barcode-Scan) (updated 2026-08-09)
- Three workflows: "Scan to Print will print labels for orders as you scan them. Scan to Verify confirms the picker has the right items to pack. Scan to Verify and Print will confirm the item you pack then allow you to print the label."
- Requires "Packing slips with a Scan to View Barcode or an order number barcode".
- Verification by "UPC, Item SKU, and/or Fulfillment SKU". "Scan to Verify does not support using multiple UPC codes or Fulfillment SKUs on a single product."
- "In Scan to Verify mode, ShipStation will mark orders as Verified once all items in a shipment are scanned."
- Verification methods (scan, Verify, Verify All) are "tracked and reported differently".
- New layout only.
- The print step needs ShipStation Connect and either preconfigured weights or a USB scale.

**Status visibility and the API [OFFICIAL]**
- Picking statuses "are visible in both the mobile and web apps". No API or webhook exposure is mentioned. — [Introduction to Mobile Picking](https://help.shipstation.com/hc/en-us/articles/49132708040347-Introduction-to-Mobile-Picking)
- The V2 webhook event list and the shipment/batch status enums contain no pick or verify states (see Section 5). — [V2 OpenAPI bundle](https://docs.shipstation.com/_bundle/apis/@shipstation-v2/openapi.json)

### Inferences
- **Option 1: ERP does verification.** If the ERP does its own guided pick/verify, it should hand off to ShipStation only at label time. Possible methods:
  - push the order (or an order tag or note) and let the packer use Scan to Print on the packing-slip barcode, or
  - create labels from the ERP through the V1/V2 label APIs.
  - ShipStation's "Verified" flag would simply not be used. Nothing requires an order to be Verified before Scan to Print.
- **Option 2: ShipStation does picking.** If ShipStation's mobile picking is used, the ERP will only learn the outcome when the label or shipment is created. That event is the first API-visible state after "awaiting_shipment".
- **No mid-process signals.** The ERP gets no real-time "picked", "short-pick exception" or "tote" signal. This matters if the ERP is meant to drive a warehouse map, replenishment or picker KPIs.
- **Scraping is not an option.** There is no documented supported way to poll for picking state (for example, an order-list filter on Picked status in the API). Unofficial UI scraping is not advisable.

### Gaps
- It was not verified whether the V1 `orders` list exposes any picking or verified flag. The V1 order model fields were not fully re-read for this; the earlier researcher covered V1. [UNVERIFIED]
- Whether Scan to Verify accepts an order put into ShipStation by API with a packing slip printed from the ERP (with the ShipStation order-number barcode) is assumed, not tested. The help text says an "order number barcode" works.

---

## 7. Pick to Light in ShipStation

### Takeaway
Pick to Light is **announced but not released** ("coming soon", Premium). The design is an LED device mounted on each **tote slot of a picking cart**. When the picker scans at a bin, ShipStation lights the slot for the matching order's tote. No hardware model, price or release date has been published.

### Cited Findings
- **Status:** "Pick-to-Tote, Picking Exceptions, Scan to Verify, and Pick to Light (coming soon) are available on Premium." Pick to Light is described as "in the pipeline". Blog last updated June 26, 2026. — [ShipStation blog](https://www.shipstation.com/blog/warehouse-picking-packing/) [OFFICIAL]
- **How it works:** "Pick to Light brings LED-guided picking into ShipStation." "ShipStation sends a real-time signal to the LED device mounted on the corresponding tote slot of the picking cart." A search snippet of the same text reads "Scanning at a bin causes ShipStation to push a live signal to the LED unit on the matching tote slot." — [ShipStation blog (.md)](https://www.shipstation.com/blog/warehouse-picking-packing.md) [OFFICIAL]
- **Installation:** "Devices install on existing picking carts in under an hour, require no infrastructure changes." — [ShipStation blog (.md)](https://www.shipstation.com/blog/warehouse-picking-packing.md) [OFFICIAL]
- **Help center:** a search for "pick to light" across help.shipstation.com returned no article titled or dedicated to it. Only general picking articles matched. — [Help Center search API](https://help.shipstation.com/api/v2/help_center/articles/search.json?query=%22pick%20to%20light%22) [OFFICIAL]
- **Not in the pricing table:** Pick to Light does not appear on the pricing page. — [ShipStation Pricing](https://www.shipstation.com/pricing/) [OFFICIAL]
- **Competitor comparison:** ShipHero sells a pick-to-light cart that works with multi-item batch picking. It is behind a feature flag and requires its "Attainable Automation Kit". — [ShipHero help](https://software-help.shiphero.com/hc/en-us/articles/36575614089741-How-to-Use-ShipHero-s-Pick-to-Light) [THIRD-PARTY]

### Inferences
- **Lights only on totes.** ShipStation's version, as described, is put-to-light on cart tote slots. There are no lights on shelf bins. It will almost certainly be tied to its own mobile picking session and hardware.
- **No API control expected.** Based on the current API surface, there is no reason to expect an external ERP to be able to drive or read those lights.

### Gaps
- Hardware vendor and model, pricing (purchase or subscription), release date, cart-size limits, and whether it needs the Premium plan plus a hardware add-on are all unknown.

---

## 8. Build-vs-buy implications for the Freeze Pipe ERP

### Takeaway
On **Premium** (about $350-$800/mo at small volumes), ShipStation covers the following out of the box, inside its own mobile app:
- guided mobile cluster picking with barcode verify, per-order totes and location-sorted prompts,
- exceptions, receiving and cycle counts,
- Scan to Verify / Print packing.

The price of using it:
- ShipStation must own inventory and locations,
- the ERP is blind to pick and pack progress,
- nothing can be customized.

On **Standard** you get basic mobile batch picking and Scan to Verify/Print, but not per-order tote picking.

Anything involving a warehouse map, path optimization, ERP-owned bins, live pick status, or custom pick-to-light must be built in the ERP. If built, the ERP should own picking end-to-end and hand off to ShipStation only for labels, to avoid running two inventory systems.

### Cited Findings (basis)
- Pick to Tote and the Picking Queue require ShipStation-managed inventory and warehouse locations. — [Pick Using Batches](https://help.shipstation.com/hc/en-us/articles/49132678007451-Pick-Using-Batches); [The Picking Queue](https://help.shipstation.com/hc/en-us/articles/49132708418203-The-Picking-Queue)
- Pick to Tote is Premium only; Mobile Picking is Standard+. — [Subscription Plans](https://help.shipstation.com/hc/en-us/articles/38800795536027-Learn-About-ShipStation-Subscription-Plans)
- The only sort or route control is sorting by Quantity, Name, SKU or Inventory Warehouse Location. — [Configure Mobile Picking](https://help.shipstation.com/hc/en-us/articles/49132708104219-Configure-Mobile-Picking)
- There are no pick/pack status fields or webhooks in V2. Totes are master data only. — [V2 OpenAPI bundle](https://docs.shipstation.com/_bundle/apis/@shipstation-v2/openapi.json)
- Location, stock and tote master data are writable through V2 on Standard/Premium. — [V2 OpenAPI bundle](https://docs.shipstation.com/_bundle/apis/@shipstation-v2/openapi.json)
- Partial picks are not supported, and labels can only be created after picking when mobile picking is used. — [Introduction to Mobile Picking](https://help.shipstation.com/hc/en-us/articles/49132708040347-Introduction-to-Mobile-Picking)
- Mobile inventory once documented as view-only. Stock Audits and Scan to Receive now change stock from mobile. — [Mobile: View Products & Inventory](https://help.shipstation.com/hc/en-us/articles/360028674672-Mobile-View-Products-Inventory); [Stock Audits](https://help.shipstation.com/hc/en-us/articles/54438805190555-Stock-Audits)

### Inferences

**What the ERP must still build, even on Premium:**
1. Unit or carton-level bin assignment and putaway logic, with capacity, slotting and replenishment from Non-Pickable reserve. ShipStation has only the `isPickable` flag and per-location quantities.
2. Pick path optimization and a 2D/3D warehouse map. ShipStation only sorts by location string.
3. Real-time pick, pack and exception telemetry and picker KPIs inside the ERP. ShipStation has no API or webhook for these.
4. Tote-to-order traceability visible to the ERP. The API has no tote↔order link.
5. Any custom pick-to-light. ShipStation's version is unreleased, closed, cart-tote only, and has no API.

**Overlap and double-entry risks if both systems are used:**
- Two stock ledgers: ERP versus ShipStation Inventory (which can also run Inventory Sync to Shopify and might fight the ERP or Shopify as source of truth).
- Two location masters: ERP bins versus ShipStation `inventory_locations`. Names must follow ShipStation's "A - U - S - B" format.
- Two tote registries.
- Allocation done twice: ShipStation allocates at Ready to Pick.
- Possible double deduction of inventory: ShipStation deducts on ship (see "How ShipStation Deducts Inventory", not read).

**Low-risk hybrid patterns:**
- **(a) Fully ERP-native:** the ERP does guided pick, tote and verify on its own mobile web app. ShipStation is used only for rate/label (Scan to Print from the packing-slip barcode, or the label API). ShipStation internal inventory tracking stays off. Standard is sufficient, and API access is required for V2.
- **(b) Fully ShipStation-native:** Premium mobile picking. ShipStation is the inventory and location master. The ERP mirrors stock through `GET /v2/inventory` polling and learns completion only from shipment/label webhooks. A map or path optimizer cannot be layered on top.

**Fit for Freeze Pipe.** For 2-5 staff and one warehouse, (b) is fastest to deploy if the owner accepts ShipStation as the inventory master and gives up live visibility. (a) is needed if the ERP's warehouse map, bin model and pick-to-light ambitions are core.

### Gaps
- No total cost of ownership was found for ShipStation Pick to Light hardware.
- No first-hand 2026 user reports on Pick to Tote throughput or reliability were found (forum content is login-gated).
- The "How ShipStation Deducts Inventory" article (updated 2026-05-26) was not read. Its exact deduction trigger (label creation versus ship) should be confirmed before any hybrid design.
