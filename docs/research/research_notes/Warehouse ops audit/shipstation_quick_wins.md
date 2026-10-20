# ShipStation Quick Wins for Picking and Packing (Standard plan, October 2026)

Research date: 2026-10-19. All help-center articles were read in full through Zendesk's public Help Center JSON API (`https://help.shipstation.com/api/v2/help_center/en-us/articles/{id}.json`). The "updated" date given for each article is its `updated_at` value. Plan check-marks in the plan article are images; they were decoded from their alt text ("Green checkmark ... Yes" / "Red X ... No").

Labels used:
- **[OFFICIAL]** — a ShipStation-owned page.
- **[UNVERIFIED]** — inferred, or seen only in a snippet.
- **[INFERENCE]** — my own conclusion.

Companion notes with deeper coverage of Pick to Tote, Picking Queue, Inventory locations and the V2 API: `docs/research/research_notes/Warehouse map and pick pack module/shipstation_native_wms_features.md`.

---

## 1. Pick lists: consolidated vs per-order, contents, sort by location, printing with packing slips

### Takeaway
- **Consolidated pick list:** yes. ShipStation's built-in **Pick List** document turns any selection of orders or shipments into one consolidated list. Set "Summarize By" to SKU and each SKU gets one row with the total quantity. The order numbers that need each item can be printed on that row.
- **Sort by location:** yes. The list can be ordered by "Warehouse location" or "Warehouse location then SKU".
- **Per-order pick list:** yes, from the single-order Print menus.
- **Pick list and packing slips in one job:** this is **not** documented. They are separate print actions. Each has its own hotkey or scannable barcode (P+L and P+S).

### Cited Findings

**Contents [OFFICIAL]** — [Pick Lists](https://help.shipstation.com/hc/en-us/articles/360026157971-Pick-Lists) (updated 2026-05-05)
- Every pick list includes:
  - Item SKUs
  - Item Name
  - Warehouse Location
  - "Quantity Required, per item and total"
  - "Order numbers for each item"
  - "Item image thumbnails, if available"
  - "The date and time the list was printed"

**Where to print it [OFFICIAL]** — [Pick Lists](https://help.shipstation.com/hc/en-us/articles/360026157971-Pick-Lists)
- For many orders: Orders or Shipments tab → select orders → **Print → Pick List**. "all items will be included in the Pick List."
- For one order: the Print menu in the Orders-grid Shipping Sidebar, or Order Details → Print All → Pick List.
- For one shipment: Shipment Actions → Print → Pick List.

**Document Options [OFFICIAL]** — [Pick Lists](https://help.shipstation.com/hc/en-us/articles/360026157971-Pick-Lists); [Document Options](https://help.shipstation.com/hc/en-us/articles/7920805135515-Document-Options) (updated 2026-08-14). These options are **account-wide**.

| Option | Choices or effect |
|---|---|
| Summarize By | SKU / Name / SKU and Name / Do not summarize items (list each item individually) |
| Order Items By | SKU / Name / # of items / Warehouse location / Warehouse location then SKU |
| Product Images | show or hide |
| Order Number(s) | show or hide |
| Product SKU | use the ShipStation product SKU instead of the channel SKU |
| Zero Quantity Items | show or hide |
| Inventory Counts | "Shows the In Stock count" |
| Warehouse Location dropdown | sets which location field is printed |

**Where the settings live: two paths documented [OFFICIAL]**
- The Pick Lists article (first section) and [Configure Mobile Picking](https://help.shipstation.com/hc/en-us/articles/49132708104219-Configure-Mobile-Picking) (updated 2026-08-10) say: **Settings → Warehouse → Picking** → "Printed Pick Lists" settings.
- The same Pick Lists article (later section) and the Document Options article say: **Settings → Printing → Printing Setup → Document Options** (next to Pick Lists).
- Both paths may exist, or the settings may have moved recently. Check in the app.

**Location source [OFFICIAL]** — [Pick Lists](https://help.shipstation.com/hc/en-us/articles/360026157971-Pick-Lists)
- "ShipStation can pull warehouse location data from 2 different places: Shipping Location and Inventory Location."
  - **Shipping Location** = Products → Product Details → **Shipping** tab → Warehouse Location.
  - **Inventory Location** = Product Details → **Inventory** tab. "To show the inventory location, the order must first be allocated as committed inventory."

**Behavior notes [OFFICIAL]** — [Pick Lists](https://help.shipstation.com/hc/en-us/articles/360026157971-Pick-Lists)
- A pick list printed for orders includes "all items on the selected order(s) ... regardless of whether multiple shipments exist".
- A pick list printed for shipments includes only the selected shipments.
- Images need an image URL in the product record or in the channel order data.
- "Enabling product images ... may cause ShipStation to take longer creating the pick list when a large number of orders ... is selected."

**Shortcuts [OFFICIAL]** — [Analytics Reports: Hotkeys & Barcode Scan Actions](https://help.shipstation.com/hc/en-us/articles/4403830407067-Analytics-Reports-Hotkeys-Barcode-Scan-Actions) (updated 2026-05-05)
- Hotkey **P + L** = "Print Pick List".
- Hotkey **P + S** = "Print Packing Slip".
- Both are also available as scannable barcodes in the "Printing Documents" scan-action group.

**Batches [OFFICIAL]** — [Print Labels with a Batch](https://help.shipstation.com/hc/en-us/articles/4405148104603-Print-Labels-with-a-Batch) (updated 2025-11-04)
- Inside a batch: "To print other documents, like Packing Slips or Pick Lists, without creating labels first, click the Print menu and choose the appropriate option."

**Blog guidance [OFFICIAL]** — [ShipStation 101: Packing Slips & Pick Lists](https://www.shipstation.com/blog/shipstation-101-packing-slips-pick-lists/)
- If pick lists with images time out, turn off Product Images.
- The author recommends ordering by Warehouse Location: "1-stop shopping!"

### Inferences
- **[INFERENCE] Replace "1 slip = 1 trip".** Select 30–40 orders, set Summarize By = SKU and Order Items By = Warehouse location then SKU, and turn on Order Number(s). The picker then walks the warehouse once, in location order, and collects total quantities per SKU. The order numbers on each row let a sorter (or the packer) split items into orders at a put wall or cart. This is the single biggest no-cost win.
- **[INFERENCE] Pad location codes.** The sort type is not documented; it is most likely a plain alphanumeric text sort on the location string. Name locations with zero-padded, walk-order codes (for example `A-01-02`, not `A-1-2`) so that the text sort equals the walk path.
- **[INFERENCE] Two print actions per wave.** Pick list and packing slips cannot go to the printer as one job. Plan on two actions per wave (P+L then P+S, or two scanned barcodes). If both documents use the same default printer, they come out back-to-back.

### Gaps
- Exact sort semantics for "Warehouse location" (natural or ASCII sort, how blanks are handled) are not documented.
- No documented single-print "pick list + packing slips" job or combined PDF in the web UI. The V2 API added `generate_packing_slips` for **label** batches (Oct 2026), but that puts packing slips in line with labels, not with a pick list. — [V2 release notes](https://docs.shipstation.com/apis/release-notes.md)
- A maximum number of orders per pick list was not found.

---

## 2. The product Warehouse Location field: setting it, bulk CSV, where it prints, limits

### Takeaway
- Every product record has a free-text **Warehouse Location** field: Product Details → **Shipping** tab.
- **No inventory needed.** It does not require ShipStation Inventory.
- **Bulk load:** it can be loaded in bulk through Products → **Import → Import Products** using the CSV column `WarehouseLocation`.
- **Where it prints:** on pick lists by default, and on custom packing slips through the `[Warehouse Location]` field replacement.
- **One value per product.** Multiple locations per SKU exist only in the separate ShipStation Inventory model (Inventory tab, "Add to Alternative Location"), which needs allocation and prints only the first location on slips.

### Cited Findings

**The field [OFFICIAL]** — [Products Overview](https://help.shipstation.com/hc/en-us/articles/360025870012-Products-Overview) (updated 2026-09-09)
- Shipping tab field "Warehouse Location": "The product's physical location in your warehouse. This information will appear on Pick Lists by default and can be added to customized packing slips. The product warehouse location is not the same as the Inventory Warehouse Location that appears on inventory reports."
- The Products grid can show and sort a Warehouse Location column.

**CSV import [OFFICIAL]** — [Add Product Records](https://help.shipstation.com/hc/en-us/articles/360026158091-Add-Product-Records) (updated 2026-09-09)
- Sample-CSV columns: SKU*, Name*, ProductDescription, **WarehouseLocation**, WeightOz, Category, Tags, Tag1–Tag5, CustomsDescription, CustomsValue, CustomsTariffNo, CustomsMIDCode, CustomsCountry, ThumbnailUrl, **UPC**, **FillSKU**, Length, Width, Height, UseProductName.
- Rules:
  - "SKU is a required field."
  - "Leaving a cell blank in the CSV file will cause ShipStation to enter a null value for that field."
  - "Order Tags can be added, but not removed, with a CSV import."
  - The tag field has a 29-character limit.
  - "Product Aliases and Product Preset Groups cannot be added or removed via the Import action."
- The importer now accepts any CSV with column mapping ("Upload and Preview" → match columns → "Start Import"). There is an optional "Overwrite Existing values" checkbox.

**Units and existing orders [OFFICIAL]** — [Product Defaults](https://help.shipstation.com/hc/en-us/articles/360029962851-Product-Defaults) (updated 2026-05-05)
- "Shopify manages product weights in grams, and we use ounces. Be sure to convert those numbers before importing."
- Changes to product defaults affect only new imports unless **"Apply changes to open orders"** is checked in Product Details. That re-applies the product's defaults to Awaiting Shipment orders containing it.

**Two location fields [OFFICIAL]** — [Document Options](https://help.shipstation.com/hc/en-us/articles/7920805135515-Document-Options); [Create Custom Packing Slips](https://help.shipstation.com/hc/en-us/articles/360057378051-Create-Custom-Packing-Slips) (updated 2026-08-05)
- Two fields are displayed as "Warehouse Location":
  - "Product Default Warehouse Location (found in the Shipping tab ...)"
  - "Inventory Warehouse Location (found in the Inventory tab ...)"
- The default-slip "Item Locations" checkbox shows only the Inventory location. It "is only selectable if you have enabled Inventory Tracking."
- To show the Shipping-tab location, use a custom slip with `[Warehouse Location]`.

**Field replacements [OFFICIAL]** — [Field Replacements in Custom Templates](https://help.shipstation.com/hc/en-us/articles/4403180517275-Field-Replacements-in-Custom-Templates) (updated 2026-08-12)
- `[Warehouse Location]` = "The Warehouse Location field as set in the Product Details under the Shipping tab. Does not display inventory warehouse location."
- `[Product Location]` = "The value set in the Product Details > Inventory tab > Location field."

**Multiple locations [OFFICIAL]**
- With ShipStation Inventory, "ShipStation will always print the first Location in this list on the packing slip." — [Internal Inventory Settings](https://help.shipstation.com/hc/en-us/articles/360036064071-Internal-Inventory-Settings) (updated 2026-10-07, via the companion notes)
- The Inventory tab has "Add to Alternative Location". — [Products Overview](https://help.shipstation.com/hc/en-us/articles/360025870012-Products-Overview)

**API type [OFFICIAL]**
- V2 `warehouse_location` is `string|null`, with example "BIN 43-6" and no `maxLength` in the OpenAPI spec. — [V2 OpenAPI bundle](https://docs.shipstation.com/_bundle/apis/@shipstation-v2/openapi.json)
- V1 `Product.warehouseLocation` is a "string". — [V1 Product model](https://docs.shipstation.com/apis/shipstation-v1/docs/models/product.md)

**Automation use [OFFICIAL]** — [Automation Rule Criteria and Actions](https://help.shipstation.com/hc/en-us/articles/1260807687290-Automation-Rule-Criteria-and-Actions) (updated 2026-10-19)
- Warehouse Location is also an Automation Rule **criterion**: "The Warehouse Location outlined in the product defaults for the order item".
- It only applies to single-line-item orders.

### Inferences
- **[INFERENCE] Fastest setup.** Export products (Products → Export), fill `WarehouseLocation` (plus `UPC`, `WeightOz`, `Length`/`Width`/`Height`, and a tag), then re-import. Be careful with blank cells, because blanks overwrite values with null.
- **[INFERENCE] SKUs in two places.** Hold one primary pick face in the field. For overflow, either encode a second location in the same string (for example `A-03-02 / OVF-B1`) or keep overflow off the pick list. The field cannot hold structured multiple locations.

### Gaps
- No documented character limit for the Shipping-tab Warehouse Location field, in either the help center or the API spec.
- Whether the pick list's "Shipping Location" option falls back to anything when the field is blank is not documented.

---

## 3. Packing slip customization: location, image, SKU, big order barcode, item barcodes, bin/tote number

### Takeaway
On Standard, the **Packing Slip template editor** (Settings → Templates → Packing Slips) is full HTML/CSS plus Liquid with bracketed field replacements. A custom slip can show per line:
- location (`[Warehouse Location]` or `[Product Location]`)
- thumbnail (`<img src="[Image Url]">`)
- SKU, UPC and Fulfillment SKU

It can also carry any field as a barcode with a `<barcode>` tag:
- a large order-number barcode in the header or footer
- per-item SKU/UPC barcodes inside the Order Items table

There is no native "bin/tote number" field. The closest are Custom Field 1–3 (settable by Automation Rules and printable or barcodable) and the batch name.

### Cited Findings

**Plan [OFFICIAL]**
- "To create and edit packing slip templates ... US, CA, UK, AU: Standard and Premium." — [Add Barcodes to Packing Slips](https://help.shipstation.com/hc/en-us/articles/360060970712-Add-Barcodes-to-Packing-Slips) (updated 2026-10-13)
- The plan table shows "Packing Slips (Customized)" No/Yes/Yes. — [Subscription Plans](https://help.shipstation.com/hc/en-us/articles/38800795536027-Learn-About-ShipStation-Subscription-Plans) (updated 2026-09-30)

**Editor [OFFICIAL]** — [Create Custom Packing Slips](https://help.shipstation.com/hc/en-us/articles/360057378051-Create-Custom-Packing-Slips)
- It has four HTML sections: Order Header, Order Items Header, Order Items, Order Footer.
- "You can edit each section using HTML, Liquid Logic, or CSS (both inline and using <style> tags)."
- The Default Template cannot be edited; copy it.
- Applying templates:
  - per store: Settings → Selling Channels → Store Setup → Edit Store Details → Packing Slips tab
  - per order: Order Details → Customer Communication
  - in bulk: Orders → Bulk Update → Packing Slip Template
  - in the print pop-up
  - by the Automation Rule action "Use a specific Packing Slip…"
- "ShipStation does not cache packing slip PDFs." Each print regenerates.

**Default-slip document options [OFFICIAL]** — [Document Options](https://help.shipstation.com/hc/en-us/articles/7920805135515-Document-Options)
- Basic options (all plans):
  - format: 4"x6" thermal, 8.5"x11" 2-per-page, or full page
  - **Sort by Items**: SKU, Name, Item Quantity, **Warehouse Location**, None
- "Advanced" options: Store Logo, Item Prices, Item SKUs, "Scan to View" Barcode, Item Locations (Inventory only), Discounts, Zero Quantity Items.
- "If you plan to use the Scan to Print feature, your packing slip must include the Scan to View Barcode."
- Contrast: the Verify article accepts "a Scan to View Barcode or an order number barcode" (see Section 5).

**Per-line fields [OFFICIAL]** — [Field Replacements](https://help.shipstation.com/hc/en-us/articles/4403180517275-Field-Replacements-in-Custom-Templates)
- Order Items fields include `[Sku]`, `[Product Sku]`, `[Fill Sku]`, `[UPC]`, `[Image Url]`, `[Item Title]`, `[Item Options]`, `[Quantity]`, `[Warehouse Location]`, `[Product Location]`, `[Dimensions]`.
- Order-level fields include `[Order #]`, `[Scan Order #]` ("order number without any dashes, typically used for barcodes"), `[Custom Field #1]`–`[#3]`, `[Internal Notes]`, `[Total Quantity]`, `[Shipping Service]`, `[Package Type]`, `[Ship By Date]`.
- `[Item List IMAGES]` is "Same as [Item List] but includes product images."
- "You can only add item-specific field replacements (like [Sku] or [Image URL]) to the Order Items section."

**How-to snippets [OFFICIAL]**
- Location column: add `<th align="left" style="width:1in">Loc.</th>` to Order Items Header and `<td>[Warehouse Location]</td>` to Order Items. — [How do I add Warehouse Locations to packing slips?](https://help.shipstation.com/hc/en-us/articles/360045435312-How-do-I-add-Warehouse-Locations-to-packing-slips) (updated 2026-01-07)
- Image: `<td><img src="[Image Url]" height="100px" /></td>`. "If no image appears ... check to see if the Image URL uses https. If it does, try removing the s." — [How do I add product images to packing slips?](https://help.shipstation.com/hc/en-us/articles/360045435292-How-do-I-add-product-images-to-packing-slips) (updated 2026-01-07)

**Barcodes [OFFICIAL]** — [Add Barcodes to Packing Slips](https://help.shipstation.com/hc/en-us/articles/360060970712-Add-Barcodes-to-Packing-Slips)
- Syntax: `<barcode size="small">[Order #]</barcode>`.
- `size`: x-small (12), small (24), medium (36), large (60), x-large (72), or any 10–100.
- `height`: 1–7.
- `humanreadable`: none, top or bottom.
- `barcodetype`: Code128Auto (default), Code128A/B/C, Code39, Code93, EAN13, UPCA, ITF14, GS1 Databar variants, and others.
- Warning: for high or zero-heavy order numbers, Code128C mis-scans (for example "10000000034 scanned as '11000'"). Use `barcodetype="Code128A"`.
- "You can include any field replacement or static value as a barcode ... Order Level information ... must remain in either the Order Header or Order Footer ... Product Level information (like SKU, Item Title, Warehouse Location, etc.) must remain inside the Order Items table."

**Custom fields and batch names [OFFICIAL]**
- Custom fields are settable by rule: actions "Set Custom Field 1…/2…/3…". Caveat: "If your store sends ... Custom Field #1 ... an action that sets the same note field will override the note imported from the store." — [Automation Rule Criteria and Actions](https://help.shipstation.com/hc/en-us/articles/1260807687290-Automation-Rule-Criteria-and-Actions)
- Batches can be renamed (Shipments → Batches → Open → click the batch number). — [Create a Batch](https://help.shipstation.com/hc/en-us/articles/4405152102171-Create-a-Batch) (updated 2025-05-15)
- No batch-name field replacement appears in the field-replacement list. — [Field Replacements](https://help.shipstation.com/hc/en-us/articles/4403180517275-Field-Replacements-in-Custom-Templates)

### Inferences
- **[INFERENCE] Slip design for Freeze Pipe.**
  - Copy the default template and add a **large Code128A `[Order #]` barcode** at the top of the Order Header, so the packer scans it without hunting.
  - Add per-line columns: `Loc.` = `[Warehouse Location]`, a thumbnail, `[Sku]`, and `[Quantity]` in large bold.
  - Optionally add a small per-line `<barcode>[UPC]</barcode>`. It works as a fallback scan target for items without a printed UPC.
  - Set Sort by Items = Warehouse Location so each slip doubles as a per-order pick path.
- **[INFERENCE] Cart-slot numbers.** There is no native "slot" field. Workable Standard-plan options:
  - The team lead writes the cart slot by hand on the slip.
  - Use Liquid or `[Total Quantity]` to print a big "ITEMS: n" badge, so packers see multi-unit orders at a glance.
  - Rules can stamp a Custom Field (for example "MULTI" or "SINGLE") at import, but they cannot assign sequential slot numbers.

### Gaps
- The Liquid variable list ("Using Liquid in ShipStation Templates") was not read. It is unknown whether a loop index or the order's position in the print job is exposed (which would allow automatic slot numbering).
- Whether pick lists themselves can be templated is not explicitly stated. They appear not to be; only Document Options exist.

---

## 4. Batches: how they work, limits, assignment, printing a batch's pick list and slips; Pick to Tote tier

### Takeaway
- **Creating batches:** in the new layout, batches are unlimited, nameable, and shared across users.
- **Assignment:** a batch can be assigned to a user in the web UI (Shipments → Batches → **Assign Batch**). Only the assignee can act on it; others are read-only.
- **The September 2026 change** was the **API** (`PUT /v2/batches/{id}/user`), not the UI.
- **Printing:** inside a batch you can print packing slips and pick lists before labels.
- **Scan to Batch:** adds orders by scanning slip barcodes.
- **Pick to Tote:** confirmed **Premium-only**.
- **No per-batch order cap** is documented.

### Cited Findings

**Creating and filling batches [OFFICIAL]** — [Create a Batch](https://help.shipstation.com/hc/en-us/articles/4405152102171-Create-a-Batch)
- Three ways to create a batch:
  - Orders sidebar **+ Create a New Batch**
  - **Batch → Create New Batch** above the Shipping Sidebar
  - select orders and **Create Label**, which makes an ad hoc batch "automatically split by Ship From Location"
- "Orders Can Be in Only One Batch."
- Legacy layout limit: "each user ... can have up to five open batches."
- New layout: "allows unlimited batches."

**Statuses and limits [OFFICIAL]** — [Introduction to Batch Shipping](https://help.shipstation.com/hc/en-us/articles/360035969752-Introduction-to-Batch-Shipping) (updated 2026-05-20)
- Statuses: Open / Processed / Archived.
- "There is no limit to the number of batches you can create."
- "Assigning a batch to a specific user will also assign all orders within that batch to that user."
- To process, each shipment needs a Ship From Location, Shipping Service, Package Type, Weight and Dimensions.

**Assigning and working in batches [OFFICIAL]** — [Working with Batches](https://help.shipstation.com/hc/en-us/articles/4405148103579-Working-with-Batches) (updated 2025-11-05)
- Assign: Shipments → Batches → select → **Assign Batch** → user → **Update Assignment**.
- "Most batch actions ... can only be taken by the user assigned to the batch. All other users will have read-only access."
- In-batch actions:
  - Process (create and print labels) and print other batch documents
  - Bulk Update of Service, Package, Weight, Size, Ship From, Insurance, Confirmation, Packing Slip and others
  - move or remove shipments, and batch notes

**Printing from a batch [OFFICIAL]** — [Print Labels with a Batch](https://help.shipstation.com/hc/en-us/articles/4405148104603-Print-Labels-with-a-Batch)
- **Process Labels** or **Process + Print Labels**.
- After processing: "Print Labels, Print Packing Slips, Print Other Docs, or Archive Batch".
- Pick lists and slips can be printed before labels from the batch Print menu.
- Quickship mode routes batch label creation to the background **Label Queue** and can print to a Connect printer as soon as labels finish. — [Using Quickship](https://help.shipstation.com/hc/en-us/articles/360025869752-Using-Quickship) (updated 2025-06-12)

**Scan to Batch [OFFICIAL]** — [Batch Orders with a Barcode Scan](https://help.shipstation.com/hc/en-us/articles/360026936052-Batch-Orders-with-a-Barcode-Scan) (updated 2025-11-05)
- Open a batch → **Scan to Batch** → scan each slip's Scan to View barcode. "Each scan will add the order to the batch."

**API batch assignment (Sept 2026) [OFFICIAL]** — [ShipStation API v2 Release Notes](https://docs.shipstation.com/apis/release-notes.md)
- September 2026: "User assignment for batches. PUT /v2/batches/{batch_id}/user ... DELETE /v2/batches/{batch_id}/user".
- October 2026: "Packing slips for batches ... `generate_packing_slips`".

**Picking tiers [OFFICIAL]** — [Subscription Plans](https://help.shipstation.com/hc/en-us/articles/38800795536027-Learn-About-ShipStation-Subscription-Plans)
- "Pick to Tote": Starter No / Standard No / **Premium Yes**.
- "Mobile Picking": No / **Yes** / Yes.
- "Pick Lists": Yes / Yes / Yes.

**Batch size [OFFICIAL]** — [Batch Summary](https://help.shipstation.com/hc/en-us/articles/360025869932-Batch-Summary) (updated 2026-05-05)
- The only size reference found is an example of "a batch with 500 order labels". It is not stated as a limit.

### Inferences
- **[INFERENCE] Standard-plan stand-in for Pick to Tote.**
  - The team lead filters the wave, creates a batch per picker or cart, and names it (for example "CART-A 10/19 AM").
  - Print the batch pick list (location-sorted, order numbers on) plus the packing slips.
  - Assign the batch to the packer.
  - Physical slot numbers come from the print sequence: if slips print in the order they were selected, slip #1 goes in slot 1 (see the Section 10 gap on sequence control).
- **[INFERENCE] Assignment is not a picking assignment.** Batch assignment gives a user ownership of label processing. It does not assign picking work in the mobile app. Restricted users see only their assigned orders (Section 6).

### Gaps
- A maximum number of orders per batch is not stated in any article read.
- Whether the print order of slips follows the grid sort, the batch order, or the order number is not documented.

---

## 5. Scan to Print / Verify: auto weight, presets, auto-print, Verify & Print and whether it can be required

### Takeaway
**Scan page (Standard):** the **Scan** tab has three workflows:
- **Scan to Print**
- **Scan to Verify**
- **Scan to Verify & Print**

Each opens an order from the packing-slip barcode.

**Skipping the scale:** turn off the **Use Scale** toggle so preconfigured weights are used. Product Defaults (Shipping tab) auto-fill:
- service, package and dimensions for single-line, quantity-1 orders
- weight for any order (sum of product weights)

So for best-seller single-SKU orders the packer can scan the slip, then scan the Purchase and Print barcode or press **P**.

**Presets:** Shipping Presets **cannot** be applied by automation. Automation Rules can set the same fields: Carrier/Service/Package, dimensions, total weight.

**Requiring scanning:** Verify cannot be forced by a setting. Removing the user permission **"Packing (Scan Page): Manual Verification"** removes the Verify / Verify All buttons, which in effect forces item scans.

### Cited Findings

**Workflows and requirements [OFFICIAL]** — [Verify & Print Shipments with Barcode Scan](https://help.shipstation.com/hc/en-us/articles/360031021831-Verify-Print-Shipments-with-Barcode-Scan) (updated 2026-08-09)
- "Scan to Print will print labels for orders as you scan them. Scan to Verify confirms the picker has the right items to pack. Scan to Verify and Print will confirm the item you pack then allow you to print the label."
- Requirements:
  - "Packing slips with a Scan to View Barcode or an order number barcode."
  - For printing: ShipStation Connect, "Preconfigured shipment weights or a connected USB scale", and auto-funding if using ShipStation Carriers.
  - The scanner should send a carriage return.
- Scan to Print steps:
  1. Scan tab → Workflow → Scan to Print.
  2. Select a printer (and scale). These are saved.
  3. Scan the slip. "The weight from your attached USB scale will update automatically. To use your preconfigured weights instead, turn off the Use Scale toggle."
  4. Press **Print Label** or the **P** hotkey.
  5. "ShipStation will immediately be ready for you to scan your next packing slip barcode."
- Verify & Print:
  - Scan each item (or click Verify / Verify All). "Each of these options ... tracked and reported differently."
  - Then **Mark as Verified** (or **V**), configure, then **P**.
  - "To view an order's history or to reprint a label, scan the barcode on the packing slip again."
- Barcode sheet: "Click Print Barcode Sheet in the Scan to Verify & Print screen ... Scan this barcode to purchase and print the labels for each order, instead of clicking the Print Label button or using the P hotkey."
- Labels need Ship From, Shipping Service and Package Type: "Use Preset Hotkeys or automation to set these options quickly."
- Other limits:
  - "Scan to Verify does not support using multiple UPC codes or Fulfillment SKUs on a single product."
  - The Verify modes are "only available in ShipStation's new layout."
  - "USB scales that don't fall asleep are ideal, as ShipStation Connect cannot wake up devices."
  - Verified orders show "Verified" in Order Details.

**Workflow Settings [OFFICIAL]** — [Workflow Settings](https://help.shipstation.com/hc/en-us/articles/360027405692-Workflow-Settings) (updated 2026-05-05). Path: Settings → Shipping → Workflow Settings.
- **Scan to Verify Items By:** UPC / Item SKU / Fulfillment SKU.
- **Mark as Verified Step:**
  - "Make users click 'Mark as Verified'", or
  - "Automatically take users to the next step once all order items are verified". In Verify & Print mode this jumps straight to configure and print.
- **Label Button:** "Create + Print Label" (default) vs "Create Label".

**Permissions [OFFICIAL]** — [Set User Permissions and Restrictions](https://help.shipstation.com/hc/en-us/articles/360025870172-Set-User-Permissions-and-Restrictions) (updated 2026-09-09)
- "Packing (Scan Page): Manual Verification — Gives a user the ability to use Verify, Clear, Verify All, Clear All actions on the scan page."
- "Mobile Picking: Manual Verification" is the mobile equivalent.
- Plan table: "User Permissions" No / Yes / Yes. — [Subscription Plans](https://help.shipstation.com/hc/en-us/articles/38800795536027-Learn-About-ShipStation-Subscription-Plans)

**Product Defaults [OFFICIAL]** — [Products Overview](https://help.shipstation.com/hc/en-us/articles/360025870012-Products-Overview); [Automatically Set Shipping Service Based on Ordered Items](https://help.shipstation.com/hc/en-us/articles/360057443992-Automatically-Set-Shipping-Service-Based-on-Ordered-Items) (updated 2026-09-02)
- "Defaults set in the Product Details Shipping tab will apply to orders that contain only that product ... (the Weight default is the notable exception)."
- "the selections for carrier, service, confirmation, and dimensions will only apply to the order if the item has a quantity of 1."
- "For multi-item and multi-quantity orders, ShipStation calculates the weight values entered as the Product Default weights and adds the total."
- **Save as shipping defaults for this product:** a link under the Configure Shipment widget, for single-product orders only. — [Product Defaults](https://help.shipstation.com/hc/en-us/articles/360029962851-Product-Defaults)

**Product Preset Groups [OFFICIAL]** — [Product Preset Groups](https://help.shipstation.com/hc/en-us/articles/360029962871-Product-Preset-Groups) (updated 2026-09-24)
- Location: Products → Preset Groups.
- Sets domestic and international service/package/confirmation, weight, dimensions and customs for many SKUs at once.
- Bulk-apply: select products → Add Preset Group.
- A more specific product default overrides the group.

**SmartFill [OFFICIAL]** — [Use SmartFill](https://help.shipstation.com/hc/en-us/articles/38048721092123-Use-SmartFill-to-Automatically-Configure-Shipment-Weight-and-Dimensions) (updated 2025-12-10)
- Location: Settings → Automation → **SmartFill** toggle.
- It "compares the new order items to the two most recent shipments for the exact same combination of items. If those shipments have identical weight and dimensions, SmartFill will add those details."
- Supports only Default and Custom package types.
- Runs after Auto-Split and before all other automation, which overwrites it.
- **[INFERENCE]** This covers repeat multi-item combinations that product defaults cannot.

**Presets cannot be automated [OFFICIAL]** — [Use Shipping Presets](https://help.shipstation.com/hc/en-us/articles/360036323651-Use-Shipping-Presets) (updated 2026-09-25)
- "You cannot currently use automation to apply presets."

**Equivalent rule actions [OFFICIAL]** — [Automation Rule Criteria and Actions](https://help.shipstation.com/hc/en-us/articles/1260807687290-Automation-Rule-Criteria-and-Actions)
- "Set Carrier/Service/Package…"
- "Set Package Dimensions…"
- "Set the Total Order Weight…"
- "Adjust the Order Weight…" ("can only be applied to an order once. It will not run when automation rules are manually reprocessed")
- "Set Rate Shopper"

**Packing Recommendations (Labs beta) [OFFICIAL]** — [Packing Recommendations](https://help.shipstation.com/hc/en-us/articles/53896390512667-Packing-Recommendations) (updated 2026-08-03)
- Status: "currently available in ShipStation Labs ... functionality and availability may change."
- Recommends the fewest-package configuration from product dimensions/weights and custom packages (with max weight). Click **Package Recommendations** → **Apply**.

**Blog workflow [OFFICIAL]** — [Scan to Print and Your Shipping Workflow](https://www.shipstation.com/blog/scan-to-print-shipping-workflow/) (modified 2026-03-20)
- The documented three-scan flow is: "Scan to View (on packing slip) / 'Get weight from scale' (on barcode sheet) / 'Purchase and Print Label' (on barcode sheet)".

### Inferences
- **[INFERENCE] Best-seller singles.** Set each top SKU's Shipping-tab defaults: service, the right one of the 6 custom package types, weight including box and dunnage, and dimensions. Every single-unit order for those SKUs then imports fully configured.
  - On the Scan page with **Use Scale off**, the flow is: scan slip → scan "Purchase and Print Label". There is no scale step and no box scan.
  - Alternatively, keep bulk-batch printing as today. The defaults make the ad hoc batch process without validation errors.
- **[INFERENCE] SKU-to-box rules.** "If order contains SKU X then box Y" is possible only with **product tags** for multi-line orders, because Item SKU criteria apply only to single-line orders (Section 6). Example rule: Order Tags includes `BOX-M` and does not include `BOX-L` → Set Package Dimensions 12×10×6 and Set Carrier/Service/Package.
- **[INFERENCE] Weight must still be right.** For multi-item orders the scale step should stay unless product weights plus a fixed "Adjust the Order Weight" packaging allowance are trusted.
- **[INFERENCE] Enforcing scan-verify.**
  - Use Scan to Verify & Print with "Automatically take users to the next step", and remove "Packing (Scan Page): Manual Verification" from packer accounts. Every unit must then be scanned before the label step.
  - Load UPCs with the product CSV (UPC column) and set Scan to Verify Items By = UPC (+ SKU).
  - Watch: multiple UPC codes per product are not supported.
  - Without that permission, packers cannot "Verify All" an item with no barcode. Make sure every SKU has a scannable code.
- **[UNVERIFIED] Bypass risk.** Nothing documented prevents a user from bypassing the Scan page and printing from the Orders grid. Removing the Shipping permission would also block Scan-page printing. "Required verification" is therefore a process control, not a hard system lock.

### Gaps
- Whether Shipping Preset hotkeys or preset barcodes work **while on the Scan page** (versus the Orders grid) is not explicitly documented. The Verify article only says "Use Preset Hotkeys or automation to set these options quickly." Freeze Pipe's current scans of its 6 box-size barcodes on the Scan page suggest they do, but this was not found in writing.
- No documented "auto-print immediately after scan" toggle exists for Scan to Print. Printing always needs P, the Purchase and Print barcode, or a click. The "Automatically take users to the next step" setting only skips the Mark as Verified click.

---

## 6. Automation Rules for sorting work: tag singles, assign user, set weight/dims/service, when rules run

### Takeaway
- **Standard plan:** includes "Unlimited automation rules types", Auto-Split, Custom Rate Shopper and User Permissions.
- **When rules run:** only when an order first enters Awaiting Shipment or On Hold (normally at import). Edits after that do not trigger rules. The **Reprocess Automation Rules** button re-applies rules and product defaults to all Awaiting Shipment orders.
- **Useful criteria:** `# of Line Items`, `Total Quantity`, `Order Tags`, `Item SKU` (single-line only), and "orders that match an existing filter".
- **Useful actions:** Add a Tag, Assign to a user, Set Carrier/Service/Package, Set Package Dimensions, Set Total Order Weight, Set Custom Field, Use a specific Packing Slip, Create an Alert, Hold, and **Send Orders to the Picking Queue**.
- **No batch action:** rules cannot create or split batches.

### Cited Findings

**Plan table [OFFICIAL]** — [Subscription Plans](https://help.shipstation.com/hc/en-us/articles/38800795536027-Learn-About-ShipStation-Subscription-Plans)
- "Automations: Basic / Unlimited / Unlimited"
- "Unlimited automation rules types No/Yes/Yes"
- "Auto-Split No/Yes/Yes"
- "Custom Rate Shopper No/Yes/Yes"
- "Automated Rate Shopper Yes/Yes/Yes"
- "Combine and split orders & shipments No/Yes/Yes"

**Timing and order of operations [OFFICIAL]** — [Introduction to Automation Rules](https://help.shipstation.com/hc/en-us/articles/360047475591-Introduction-to-Automation-Rules) (updated 2026-09-29)
- "ShipStation applies Automation Rules to orders when they import or move into the Awaiting Shipment status or On Hold status for the first time ... changes made to orders already in Awaiting Shipment will not trigger Automation Rules."
- "ShipStation processes the rules from first to last in the list."
- "Automation Rules are the last automation process ShipStation applies. They can override Product Defaults and Service Mapping."

**Reprocessing and order [OFFICIAL]**
- "Reprocess automation rules to reapply all currently active automation rules and product defaults to all orders currently in the Awaiting Shipment status." — [Troubleshoot Automation Rules](https://help.shipstation.com/hc/en-us/articles/360025853252-Troubleshoot-Automation-Rules) (updated 2026-08-03)
- The criteria option "Only apply these actions to orders that match an existing filter" exists. — [Create Automation Rules](https://help.shipstation.com/hc/en-us/articles/360026158331-Create-Automation-Rules) (updated 2026-10-18)
- Full pipeline order, assembled from several articles: Auto-Split (and Auto-Routing) → SmartFill → Product Preset Groups / Product Defaults → Service Mapping → Automation Rules. — [Automatically Split Orders](https://help.shipstation.com/hc/en-us/articles/17465241673627-Automatically-Split-Orders) (updated 2026-07-20); [SmartFill](https://help.shipstation.com/hc/en-us/articles/38048721092123-Use-SmartFill-to-Automatically-Configure-Shipment-Weight-and-Dimensions)

**Criteria and actions [OFFICIAL]** — [Automation Rule Criteria and Actions](https://help.shipstation.com/hc/en-us/articles/1260807687290-Automation-Rule-Criteria-and-Actions)
- Criteria include:
  - `# of Line Items` ("number of unique line items ... not to be confused with Total Quantity")
  - `Total Quantity` (caveat: does not apply to Shopify orders importing On Hold)
  - `Order Tags` ("If you select multiple tags ... in a single criteria line, then the rule will apply when any of the selected tags are on the order")
  - `Item SKU`, `Item Name` and `Warehouse Location`, each with the caveat "will not apply to orders that have more than one line item ... we recommend that you add tags to your product records"
  - `Assigned User`, `Order Import Time`, `Requested Service`, `Order Weight`
- Actions include: Add a Tag…, Assign to a user…, Create an Alert…, Hold…, "**Send Orders to the Picking Queue** — Sets matching orders to the Ready to Pick status", Set Carrier/Service/Package…, Set Custom Field 1/2/3…, Set Package Dimensions…, Set Rate Shopper, Set the Total Order Weight…, Stop Processing Rules for the Order, "Use a specific Packing Slip…".

**Product tags for multi-line orders [OFFICIAL]** — [How do I create Automation Rules for Multi-product Orders?](https://help.shipstation.com/hc/en-us/articles/360045864451-How-do-I-create-Automation-Rules-for-Multi-product-Orders) (updated 2026-08-06)
- "For multi-product orders, ... the only Product Defaults that will apply are Weight, Order Tags, and Customs Declarations."
- Pattern: tag products, then a rule with "Order Tags includes X AND does not include Y,Z".
- Tagging a product makes its tag apply to orders containing it. — [Order Tags](https://help.shipstation.com/hc/en-us/articles/360026156931-Order-Tags) (updated 2025-06-12)

**Auto-Split [OFFICIAL]** — [Automatically Split Orders](https://help.shipstation.com/hc/en-us/articles/17465241673627-Automatically-Split-Orders)
- Per-product options: Do not auto-split / Exclusive Bulk Shipping / Ships Individually / Ship on Custom Quantity.
- It "does not apply to new manual orders or previously imported open orders."

**Assignment [OFFICIAL]**
- Restriction: "Restrict this user to only see orders assigned to them". — [Set User Permissions and Restrictions](https://help.shipstation.com/hc/en-us/articles/360025870172-Set-User-Permissions-and-Restrictions)
- "Automation rules can also assign orders to your users as the orders import." — [Hold, Assign, and Cancel Orders](https://help.shipstation.com/hc/en-us/articles/360026156911-Hold-Assign-and-Cancel-Orders) (updated 2026-09-09)

### Inferences
- **[INFERENCE] Starter rule set for Freeze Pipe.** Order matters: rules run first to last.
  1. `# of Line Items = 1` AND `Total Quantity = 1` → Add Tag `SINGLE`.
  2. `Item SKU = <best-seller N>` (works because these are single-line) → Add Tag `BULK-<SKU>`. Product defaults already set service, box and weight.
  3. `# of Line Items = 1` AND `Total Quantity > 1` → Tag `MULTI-QTY`.
  4. `# of Line Items > 1` → Tag `MULTI-LINE`, plus Use a specific Packing Slip = "Pick slip w/ locations".
  5. Product-tag box rules (Section 5).
  6. Assignment: round-robin is **not** possible (there is no rotation). Assign by criteria only, for example by tag or by Ship By Date.
- **[INFERENCE] Rules cannot batch.** Batching stays manual: filter by a saved view, select all, Create Batch. That is two clicks per wave.
- **[INFERENCE] Run Reprocess after new rules.** Any time rules or product defaults change mid-morning, click Reprocess. Remember that "Adjust the Order Weight" will not re-run.

### Gaps
- No rule action creates or splits batches, and there is no round-robin assignment (none appear among the listed actions).
- The plan tier of the "Send Orders to the Picking Queue" action and of the Picking Queue itself is not stated. The Picking Queue requires totes and ShipStation Inventory, so it is effectively Premium/Pick-to-Tote (see companion notes).

---

## 7. Mobile Picking on Standard (ShipStation Mobile app) without Pick to Tote

### Takeaway
"Mobile Picking" is on Standard. In the web app, orders go to **Ready to Pick → Add to new batch**. In the app, the picker uses **Pick → Batch Picking**. The flow:
1. Walk location by location (the location scan can be skipped).
2. Scan a tote.
3. Scan each SKU/UPC.
4. The app counts the remaining quantity.

The app shows a mismatch error with a sound. Statuses Ready to Pick → Picking → Picked show in the web app.

Limits:
- Partial picks are not supported.
- Labels can only be created after picking.
- It is batch (bulk) picking. Per-order sorting into totes is Pick to Tote (Premium).
- It is unclear whether basic batch picking works without ShipStation Inventory, warehouse locations and totes. The step list includes "scan a tote" and "location shown on your screen".

### Cited Findings

**Overview [OFFICIAL]** — [Introduction to Mobile Picking](https://help.shipstation.com/hc/en-us/articles/49132708040347-Introduction-to-Mobile-Picking) (updated 2026-09-07)
- "Batch Picking: groups by order items so your Pickers can move through the warehouse and pick items in bulk to bring back to your packing station. You can use basic mobile picking or pick to tote with the batch picking method."
- Devices: iOS 15+, Android 10+, Android-based barcode scanners, and Bluetooth scanners paired to a phone. Camera scanning is supported.
- Matching is against SKU, UPC or Fulfillment SKU. On a mismatch the app will "display an error message and play an error sound". Manual entry is allowed.
- "Orders must be in the Awaiting Shipping status to be eligible ... Labels can only be created after picking."
- "Partial picking is not supported ... a partially picked order will be flagged as an exception."
- "If you're using ShipStation Inventory, inventory is automatically allocated when orders are marked as Ready to Pick."

**Marking orders Ready to Pick [OFFICIAL]** — [Mark Orders as Ready to Pick](https://help.shipstation.com/hc/en-us/articles/49132661261211-Mark-Orders-as-Ready-to-Pick) (updated 2026-04-14)
- Orders → Awaiting Shipment → select → **Ready to Pick** → "Add to new batch if you are using Basic Mobile Picking or Pick to Tote" → name the batch → Continue.
- The Automation Rule action "Send Orders to the Picking Queue" sets Ready to Pick. — [Automation Rule Criteria and Actions](https://help.shipstation.com/hc/en-us/articles/1260807687290-Automation-Rule-Criteria-and-Actions)

**Basic Mobile Picking steps [OFFICIAL]** — [Pick Using Batches](https://help.shipstation.com/hc/en-us/articles/49132678007451-Pick-Using-Batches) (updated 2026-04-14)
- App → Pick tab → Batch Picking → choose batch → Start Picking.
- "Go to the location shown on your screen and scan the location barcode ... 'Skip Locations Scan'."
- "Scan a tote to assign it for your first pick. You will need to scan a new tote for each item."
- "Scan the SKU ... The app will show how many of each item you need to pick and keep track of the remaining items."
- Pick to Tote additionally requires "Manage Inventory in ShipStation" and "Manage Warehouse Locations".

**Settings [OFFICIAL]** — [Configure Mobile Picking](https://help.shipstation.com/hc/en-us/articles/49132708104219-Configure-Mobile-Picking)
- Per-user permission **Order Picking** (Settings → Account → User Management → Edit → Permissions).
- Pick sort: "Item Quantity, Item Name, Item SKU, or Inventory Warehouse Location."

**Totes [OFFICIAL]** — [Manage Totes for Mobile Picking](https://help.shipstation.com/hc/en-us/articles/49132700371611-Manage-Totes-for-Mobile-Picking) (via companion notes)
- Totes are created under Inventory Management Settings → Warehouses → (warehouse) → Totes. That implies an inventory warehouse must exist.

**Older app features [OFFICIAL]** — [ShipStation Mobile: Features](https://help.shipstation.com/hc/en-us/articles/360025853692-ShipStation-Mobile-Features) (updated 2025-07-29)
- The app can "View & print pick lists & packing slips" and scan barcodes to pull up orders.

### Inferences
- **[INFERENCE] Not a quick win for Freeze Pipe today.**
  - Mobile batch picking sorts by **Inventory** Warehouse Location only, not the Shipping-tab field, and needs tote master data that lives under an inventory warehouse.
  - Setting it up means standing up ShipStation Inventory as the location/stock master. That is the double-ledger risk documented in the companion notes.
  - "Labels can only be created after picking" would also block today's direct bulk label printing for orders sent to picking.
  - The paper consolidated pick list (Section 1) gets most of the walking savings with zero setup.
- **[INFERENCE] Possible limited pilot.** Send only MULTI-LINE orders to Ready to Pick, to get scan-confirmed picks.

### Gaps
- No article states whether Basic Mobile Picking works with no ShipStation Inventory warehouse, no locations, or no totes, or what "location shown on your screen" displays in that case.
- No documented way exists to assign a picking batch to a specific picker in the mobile app. Web batch assignment is a label-processing ownership feature.

---

## 8. Separating singles vs multis and grouping "identical orders": filters, views, Group By, tags, combine/split

### Takeaway
The Orders grid (new layout) has the tools for this:
- **Group By**: Store, # Line Items, Total Quantity, Country, Item Name, Item SKU, Requested Service. Two fields can be combined. You can select an entire group and bulk-act on it.
- **filters** and unlimited **saved Custom Views** (tabs)
- account-wide **Saved Filters** that rules can reuse
- a **Tags** column

Grouping by `# Line Items` + `Item SKU` isolates single-SKU waves instantly.

**Identical multi-item orders:** no native "identical SKU-set" grouping was found. SmartFill keys on "the exact same combination of items" internally, but it does not group in the grid. **Combine Shipments** (with Combine Order Alerts) handles same-customer orders.

### Cited Findings

**Group By [OFFICIAL]** — [View, Search, and Sort Orders](https://help.shipstation.com/hc/en-us/articles/360025869052-View-Search-and-Sort-Orders) (updated 2026-08-17)
- "The Group By feature allows you to group orders in the Awaiting Shipment status ... Store, # Line Items, Total Quantity, Country, Item Name, Item SKU, Requested Service."
- "Click Combine with another field" to add a second field.
- "select entire groups to bulk update all orders within the group."
- Multi-item orders show "(Multiple)" in the Item SKU/Name columns and expand with a disclosure triangle.

**Shipping Sidebar grouping [OFFICIAL]** — [View, Search, and Sort Orders](https://help.shipstation.com/hc/en-us/articles/360025869052-View-Search-and-Sort-Orders)
- With 2 or more orders selected, the gear icon lets you group the sidebar's items by **Orders** or by **Items**.
- **[INFERENCE]** This is an on-screen consolidated item list for the selection.

**Filters and views [OFFICIAL]** — [Filter Orders](https://help.shipstation.com/hc/en-us/articles/360035969712-Filter-Orders) (updated 2026-06-29)
- Filters include Assigned To, Batch, Package, Packing Slip Printed, Quantity, **Scan to Verify**, Service, Weight, and others.
- "You can have an unlimited number of saved custom views."
- Saved Filters: Settings → Automation → Order Filters. They are "available to all users" and usable in automation rules.
- "Item SKU as a filtering criterion applies to both orders containing just the Item SKU and orders containing the Item SKU and other line items. However, when you use Item SKU as an Automation Rule criterion, the rule will only apply to orders containing a single line item."
- "All filter fields have a character limit of 2,000."

**New-layout extras [OFFICIAL]** — [Feature Updates in ShipStation's New Layout](https://help.shipstation.com/hc/en-us/articles/48668385552027-Feature-Updates-in-ShipStation-s-New-Layout) (updated 2026-04-03)
- Pinned columns (up to two).
- Multi-attribute Group By.
- Unlimited batches and views.

**Tags [OFFICIAL]** — [Order Tags](https://help.shipstation.com/hc/en-us/articles/360026156931-Order-Tags)
- Tags are color-coded. "There is no limit to the number of tags you can add to an order."
- Filters can include or exclude tags. Add the Tags column to the grid.

**Combine [OFFICIAL]** — [Combine Shipments](https://help.shipstation.com/hc/en-us/articles/360033432631-Combine-Shipments) (updated 2026-10-05)
- Select orders → Other Actions → Combine Shipments. Orders must be in Awaiting Shipment.
- "Any packing slips or pick lists you print for the combined shipment will include the item information from both orders."
- Combine Order Alerts require that "The customer ID and the Ship To address on the orders must match." — [Order Alerts](https://help.shipstation.com/hc/en-us/articles/360025869112-Order-Alerts) (updated 2025-11-05)

**Split [OFFICIAL]** — [Split Orders Into Multiple Shipments](https://help.shipstation.com/hc/en-us/articles/360028798951-Split-Orders-Into-Multiple-Shipments) (updated 2026-08-27)
- In the new layout, splitting moves items into multiple shipments within one order.
- Auto-Split is a per-product setting (Section 6).

**Custom alerts [OFFICIAL]** — [Order Alerts](https://help.shipstation.com/hc/en-us/articles/360025869112-Order-Alerts)
- Rule action "Create an Alert…" with field replacements Store Name, Recipient Name, Order Date, Order #.

### Inferences
- **[INFERENCE] Morning routine.**
  - Custom View tab "Singles" (Quantity = 1 filter, or the `SINGLE` tag) → Group By Item SKU → select a group → Create Batch → Process + Print. This is the current best-seller flow, extended to every single SKU, not just the top 3–4.
  - Custom View "Multis" (`MULTI-LINE` tag) → select 30–40 (sorted by Order Date or Ship By) → Print Pick List (consolidated, location sort) + Print Packing Slips.
- **[INFERENCE] Identical multi-item orders.** Group By `Item SKU` probably buckets every multi-line order under "(Multiple)", so it cannot detect identical bundles [UNVERIFIED]. If certain multi-SKU combinations are common, a Shopify bundle SKU or a ShipStation **Product Bundle** (Standard) would make them single-SKU orders and groupable.

### Gaps
- How Group By → Item SKU treats multi-line orders (one "(Multiple)" bucket vs per-SKU membership) is not documented.
- No "identical orders" or "same SKU set" grouping feature was found in any help article.

---

## 9. Shipping Presets, hotkeys and station barcode sheets (the official feature behind the 6 box barcodes)

### Takeaway
Freeze Pipe's six box-size barcodes are almost certainly **Shipping Preset hotkey barcodes**.
- A **Shipping Preset** (Orders → Apply Preset → Manage Presets, or Other Actions → Manage Presets) can set Ship From, Service, **Package Type**, Confirmation, Insurance, **Weight** and **Size**.
- Each preset can get a hotkey: **max 36 hotkeyed presets**.
- **"Print Hotkeys & Barcodes"** in Manage Presets prints them as scannable barcodes.
- The "finalize and print" barcode is the **Purchase and Print Label** barcode from the Scan page's **Print Barcode Sheet**.
- **Custom station sheets:** Analytics → Reports → **Barcode Scan Action Quick Reference Sheet** builds a custom sheet of up to 10 actions (presets, read weight, create label, print pick list, and so on).

### Cited Findings

**Presets [OFFICIAL]** — [Use Shipping Presets](https://help.shipstation.com/hc/en-us/articles/360036323651-Use-Shipping-Presets)
- "A preset can contain the following settings: Ship From Location, Shipping Service, Package Type, Confirmation, Insurance, Weight, Size (package dimensions)."
- "assign a Hotkey combination to each preset if desired."
- "click Print Hotkeys and Barcodes in the Manage Presets screen to print the barcode sheet."
- "you can only assign up to 36 presets to hotkeys."
- Apply to multiple orders through the sidebar Preset drop-down, the hotkey, or Bulk Update → Apply Shipping Preset.
- "You cannot currently use automation to apply presets."
- To pin a specific carrier account, sort services by Postage Provider when building the preset.

**Hotkeys and scan actions [OFFICIAL]** — [Analytics Reports: Hotkeys & Barcode Scan Actions](https://help.shipstation.com/hc/en-us/articles/4403830407067-Analytics-Reports-Hotkeys-Barcode-Scan-Actions)
- Hotkey list in the new layout: Help (?) → Hotkeys.
- Advanced hotkeys:
  - **W** read weight from scale
  - **R** get rate
  - **S** create label
  - **B** create new batch
  - **P+B** process open batch
  - **P+S** print packing slip
  - **P+L** print pick list
  - **Q** toggle Quickship
  - **Ctrl+Shift+S** Barcode Listening screen ("view, batch, or ship scanned orders")
- "Barcode Scan Action Report" types: General, **Custom Shipping Presets** ("Only Shipping Presets that have hotkeys assigned to them can be used with barcodes"), Shipping Orders, Printing Documents, Navigation.
- "Barcode Scan Action Quick Reference ... up to 10 barcodes that you select."

**Plan [OFFICIAL]** — [Subscription Plans](https://help.shipstation.com/hc/en-us/articles/38800795536027-Learn-About-ShipStation-Subscription-Plans)
- "Hot Keys: Barcode actions & Custom Hot Keys": No / **Yes** / Yes.
- "Barcode Scanning (Reports page)": No / Yes / Yes.

**Layout conflict [OFFICIAL]**
- [Other Barcode Uses](https://help.shipstation.com/hc/en-us/articles/360026158651-Other-Barcode-Uses) (updated 2025-08-07) says "Scan Action reports are currently only available when using ShipStation's Legacy layout."
- The newer Verify & Print article (2026-08-09) documents **Print Barcode Sheet** on the new-layout Scan page. The Presets article (2026-09-25) documents **Print Hotkeys & Barcodes** in Manage Presets.
- Treat the full Analytics report as possibly Legacy-only. The preset sheet and the Scan-page sheet are available in the new layout.

**Barcode search [OFFICIAL]** — [Barcode Scanning Overview](https://help.shipstation.com/hc/en-us/articles/360026158591-Barcode-Scanning-Overview) (updated 2025-11-06)
- "Barcode search mode: Using a custom barcode with the order # or order ID, ShipStation can perform the action you designate with just a scan: view the order, ship the order, or add order to a batch."

### Inferences
- **[INFERENCE] Simplify the 6 box barcodes.** Today each box preset barcode is scanned after the scale reading. If the presets contain only Package Type plus Size (no Weight), they will not overwrite the scale weight.
  - Check this: a preset that includes Weight will override the scale reading if applied after it.
  - For best-seller singles, the box preset becomes unnecessary once Product Defaults carry the box (Section 5).
- **[INFERENCE] Station sheet.** Build one laminated sheet per pack station: the 6 box presets, "Read weight from scale", "Purchase and Print Label", and "Print Packing Slip" (for reprints). Use the Quick Reference Sheet (10-barcode limit), or the preset sheet plus the Scan-page sheet.

### Gaps
- Whether preset barcodes act on the order open in the Scan page in the new layout is not explicitly written (see Section 5 Gaps). Freeze Pipe's current practice suggests they do.
- Whether the Analytics → Reports barcode reports are now available in the new layout is uncertain (the articles conflict).

---

## 10. Label printing: ShipStation Connect, default printers, label + slip layouts, batch printing

### Takeaway
- **Default printers:** set them **per user, per browser, per document type** (Settings → Printing → Printing Setup → "Always prompt" → Print via ShipStation Connect). Prints then skip the dialog. Each of the 4 laptops can have its own label printer.
- **Label + slip together:** the Label Document Options layouts **4"x6" (w/ Packing Slip)** and **8.5"x11" (w/ Packing Slip)** print label and slip together. That only works when both go to the same printer.
- **Bulk sequence:** "labels and packing slips print in the same sequence."
- **One-click labels:** the Create + Print Label default button and Quickship remove clicks.

### Cited Findings

**Default printers [OFFICIAL]** — [Set Default Printers](https://help.shipstation.com/hc/en-us/articles/360035969792-Set-Default-Printers) (updated 2026-10-19)
- "default printers are user- and browser-specific, so you can specify different default printers per user and per document type, as well as per browser."
- "Print via ShipStation Connect" requires Connect on the printer workstation.
- Users other than the Connect-registering user see only printers set as **Shared**.
- Bypass: click the arrow next to a document type in the Print menu.

**Combined layouts [OFFICIAL]** — [Can ShipStation print labels and packing slips together?](https://help.shipstation.com/hc/en-us/articles/360046802131-Can-ShipStation-print-labels-and-packing-slips-together) (updated 2026-01-07)
- Settings → Printing → Printing Setup → Labels Document Options → Shipping Label Format:
  - "4" x 6" (w/ Packing Slip): ... print at the same time, across two 4" x 6" pages"
  - "8.5" x 11" (w/ Packing Slip): ... label at the top and the packing slip at the bottom"
- "Can I print them at the same time using two different printers? Not at this time."
- "When you print in bulk, labels and packing slips print in the same sequence."

**Label button and Quickship [OFFICIAL]**
- Label Button Settings: "Create + Print Label" (default). — [Workflow Settings](https://help.shipstation.com/hc/en-us/articles/360027405692-Workflow-Settings)
- Quickship: enable under Settings → Account → Display Options → General Preferences. It "skips the cost review screen", routes labels to the Label Queue, and "allows you to print from your Connect-enabled printer as soon as labels are done processing." Each user can show or skip Warnings, Errors, Cost Summary, Label Batch Status and Print Dialog Preview. — [Using Quickship](https://help.shipstation.com/hc/en-us/articles/360025869752-Using-Quickship)

**Print tracking [OFFICIAL]**
- Smart Document Tracking marks packing slips "Printed" when printed by Connect or downloaded, but not when printed by the browser. — [Print Packing Slips](https://help.shipstation.com/hc/en-us/articles/360026157931-Print-Packing-Slips) (updated 2026-05-05)
- "ShipStation will alert you if you attempt to print a packing slip that has already been printed." — [Print Packing Slips](https://help.shipstation.com/hc/en-us/articles/360026157931-Print-Packing-Slips)
- The Orders filter "Packing Slip Printed" exists. — [Filter Orders](https://help.shipstation.com/hc/en-us/articles/360035969712-Filter-Orders)

**Scanners and scales [OFFICIAL]** — [Verify & Print Shipments with Barcode Scan](https://help.shipstation.com/hc/en-us/articles/360031021831-Verify-Print-Shipments-with-Barcode-Scan)
- Tested scanners: Zebra Symbol LS2208, Motorola LI4278.
- Scales should not auto-sleep.

### Inferences
- **[INFERENCE] Filter out already-printed slips.** Use the "Packing Slip Printed = No" filter in the team lead's Custom View so the next 30–40-slip wave never reprints slips. Always print through Connect so tracking works.
- **[INFERENCE] Keep slips on a laser printer.** For multi-item orders the slip must come before packing, for picking and Scan to Print, so the "w/ Packing Slip" label layout does not fit the current flow. It does fit the best-seller bulk-label flow if a slip is wanted in each box.

### Gaps
- Bulk print sequence control (which sort governs the PDF order) is not documented.
- Printing the pick list and packing slips in one job is not supported per the available docs (see Section 1).

---

## 11. 2026 Standard-plan features relevant now, and the ranked quick-win shortlist

### Takeaway
New in 2026, or relevant on Standard:
- unlimited automation
- custom slips and barcodes
- the Scan page (Verify / Verify & Print)
- preset barcodes
- Mobile Picking (basic)
- Auto-Split and Product Bundles
- SmartFill
- Packing Recommendations (Labs beta)

API-only 2026 additions are batch user assignment (Sep 2026) and batch packing slips (Oct 2026).

**Premium-only:** Pick to Tote, Scan to Receive, Cubiscan, POs, Transfer Orders, and "Inventory Management" as a summary row. The Picking Queue effectively also needs Premium-level prerequisites.

### Cited Findings

**Standard vs Premium rows [OFFICIAL]** — [Subscription Plans](https://help.shipstation.com/hc/en-us/articles/38800795536027-Learn-About-ShipStation-Subscription-Plans) (updated 2026-09-30)

| Feature | Standard | Premium |
|---|---|---|
| Mobile Picking | Yes | Yes |
| Pick to Tote | No | Yes |
| Barcode Scanning (Scan Page Access) | Yes | Yes |
| Packing Slips (Customized) | Yes | Yes |
| Hot Keys: Barcode actions & Custom Hot Keys | Yes | Yes |
| Product Bundles | Yes | Yes |
| Inventory Sync | Yes | Yes |
| Scan to Receive | No | Yes |
| Cubiscan | No | Yes |
| Auto-Split | Yes | Yes |
| Custom Rate Shopper | Yes | Yes |
| User Permissions | Yes | Yes |
| Users included | 10 | 15 |
| Starting price (US) | $29.99/month | $349.99/month ("High-volume ops") |

- **Conflict on Rate Shopper.** The plan table puts "Automated Rate Shopper" on all plans and "Custom Rate Shopper" on Standard+. The older [Feature Updates in ShipStation's New Layout](https://help.shipstation.com/hc/en-us/articles/48668385552027-Feature-Updates-in-ShipStation-s-New-Layout) (updated 2026-04-03) says Rate Shopper "is included with the High Volume subscription plan and available as an add-on." The plan article is newer (2026-09-30); prefer it.
- **Conflict on Scan to Verify.** The ShipStation blog (June 2026) lists "Scan to Verify" among Premium features, but the help-center plan table puts Scan Page access on Standard (see companion notes).
- **API additions (Sep / Oct 2026).** Batch user assignment and `generate_packing_slips` are V2 API features. The batch-assignment UI predates them (the [Working with Batches](https://help.shipstation.com/hc/en-us/articles/4405148103579-Working-with-Batches) article is dated 2025-11-05). — [V2 release notes](https://docs.shipstation.com/apis/release-notes.md)
- **Labs beta.** Packing Recommendations is a ShipStation Labs beta. — [Packing Recommendations](https://help.shipstation.com/hc/en-us/articles/53896390512667-Packing-Recommendations)

### Inferences
**[INFERENCE] Ranked quick wins:** settings only, no code, no plan change.

1. **Load `WarehouseLocation`, `UPC`, `WeightOz` and L/W/H for all SKUs by product CSV.** Name locations in zero-padded walk order. This underpins everything below. (Sections 2, 5)
2. **Consolidated, location-sorted pick list per wave.**
   - Set Summarize By = SKU and Order Items By = Warehouse location then SKU.
   - Turn on Order Number(s). Turn Images off if slow.
   - Print it with the 30–40 slips (P+L, then P+S).
   - The picker makes one loop per wave instead of one trip per order. Sort items to orders at the cart or pack bench using the order numbers on the list. (Section 1)
3. **Custom packing slip.** Big Code128A `[Order #]` barcode at top; per-line `[Warehouse Location]`, thumbnail, SKU and qty; items sorted by Warehouse Location; optional `[UPC]` barcodes. (Section 3)
4. **Product Defaults and Preset Groups on best sellers.** Service, box, weight and dims auto-fill for single-unit orders, so the bulk batches process with zero edits. On the Scan page with Use Scale off, the flow is scan slip → scan Purchase & Print. (Section 5)
5. **Automation Rules to tag and split the work.** SINGLE / BULK-<SKU> / MULTI-QTY / MULTI-LINE tags, custom slip by rule, and product-tag box rules. Then saved Custom Views plus Group By Item SKU build waves in seconds. Click Reprocess after changing rules. (Sections 6, 8)
6. **Scan to Verify & Print with item scanning enforced.** Set Workflow Settings to auto-advance after verification. Remove "Packing (Scan Page): Manual Verification" from packer users. Verify by UPC + SKU. This catches wrong or missing items before the label. (Section 5)
7. **One barcode sheet per station.** Six box presets (Package + Size only), Read weight, Purchase & Print, Print Packing Slip. Set default printers per laptop, and turn Quickship on for bulk batches. (Sections 9, 10)
8. **Optional:**
   - SmartFill for repeat multi-item combos.
   - Combine Order Alerts to merge same-customer orders before picking.
   - Packing Recommendations (Labs) to suggest one of the 6 boxes.
   - Product Bundles for common multi-SKU sets.

**Not recommended now:**
- Mobile Picking or the Picking Queue. They need ShipStation Inventory, locations and totes, and they block labels until orders are picked.
- Upgrading to Premium for Pick to Tote. The ERP pick module will replace this.

### Gaps
- No hands-on test account was used. All UI paths come from help articles dated 2025-05 to 2026-10, and two of them conflict (the pick-list settings location, and the Legacy-only barcode report note).
- Real-world throughput gains (minutes per wave) were not found in any source.
