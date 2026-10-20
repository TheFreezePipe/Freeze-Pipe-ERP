# Visual Warehouse Map Builders: UX Patterns (state as of Oct 2026)

Evidence labels used throughout:
- **[Observed]** = I saw it myself: in SKUSavvy's public interactive demo (https://www.skusavvy.com/warehouse-layout-preview), which I drove in a browser on 2026-10-19, or in vendor help-doc screenshots that I downloaded and viewed.
- **[Doc]** = vendor help/LMS/technical documentation text.
- **[Marketing]** = vendor marketing page or app-store copy (treat as claims).
- **[Review]** = third-party user review.
- Anything under "Inferences" is my reasoning, not a sourced fact.

Method note: YouTube transcripts could not be retrieved. The caption endpoints return 404 or FAILED_PRECONDITION, and the browser pane is blocked from youtube.com. For SKUSavvy videos I used the full video descriptions and chapter lists, scraped from the watch-page HTML and the channel RSS feed. The SKUSavvy help center has many annotated screenshots, and I viewed those directly. That gives stronger visual evidence than video would have.

---

## 1. SKUSavvy: how the builder and the operational map actually work

### Takeaway
SKUSavvy's builder is a **top-down 2D grid canvas with a separate read-only 3D (WebGL, perspective) view**. In the 2D canvas you place rectangles: **Shelves** (which own **Levels** and hold **Bins**), **Areas** (non-pickable zones) and **Walls/Doors**. You then bulk-generate bins with a rows × columns × levels dialog and auto-name them as `<level><letter>`. The same map is reused in picking, receiving/put-away, cycle counts and heatmaps, usually as a split screen with the task list. Its strengths are speed tools (copy/paste, shift multi-select, arrow-key nudge, generate bins, copy level to levels, generate names) and one map reused across every workflow. Its weaknesses are a coarse naming scheme, edit mode being 2D-only, levels that can only be viewed one at a time in 2D, and a mobile experience that is just the responsive web app.

### Cited Findings

**Canvas, element model, and 2D vs 3D**
- [Doc] One grid layout holds "shelves, bins, levels, conveyance, walls, docks, packing tables, staging". The layout's stated purpose is to visually locate inventory, orders to fulfill, bin-to-bin replenishment tasks and pick routes. — [SKUSavvy Warehouse guide](https://www.skusavvy.com/docs/guides/warehouse)
- [Doc] Build tips: "Build in the bottom right quadrant of the map ONLY". "The map can be in any unit dimension you want" (unitless; no real-world units are enforced). "Plan to make your warehouse map slightly bigger on the screen". — [SKUSavvy Warehouse guide](https://www.skusavvy.com/docs/guides/warehouse)
- [Observed, doc screenshot] An empty new layout shows a dark grid canvas with visible X/Y origin axes. A pre-drawn red-outlined rectangle labeled **"Build Here"** sits in the bottom-right quadrant. The top bar has "Bins: All", "Level 1", CANCEL and UPDATE. Zoom +/- sits top-right, a vertical five-icon tool rail bottom-right, and an "INFO" tab at the bottom. — [SKUSavvy Warehouse guide](https://www.skusavvy.com/docs/guides/warehouse) (image "build your 3d warehouse map")
- [Doc] Interface elements (numbered callouts): (1) a 2D/3D toggle ("View layout in 3D (not available in edit mode)"); (2) a filter for bins with or without products; (3) a Level selector ("think of this as shelf level… one level to another on the same shelf can have different bin sizes"); (4) an Edit button that must be on before anything can be moved or added; (5) zoom buttons plus wheel and pinch ("similarly to Google Maps"); (6) an information panel; (7) "Selecting a shelf will show all bins on the shelf. Once a shelf is selected, you can click again to select the bin"; (8) drag the canvas to pan (in edit mode, dragging a shelf or bin moves it). — [SKUSavvy Warehouse guide](https://www.skusavvy.com/docs/guides/warehouse)
- [Observed, doc screenshot] In view mode, shelves appear as dark-blue rectangles with a large translucent watermark label ("Shelf A"). Bins are smaller rectangles tiled inside, with rotated text labels ("Bin 1A", "Bin 1B"…). Areas are large colored rectangles with big labels ("Shipping" in navy, "Receiving" in olive). — [SKUSavvy Warehouse guide](https://www.skusavvy.com/docs/guides/warehouse) (image "visual warehouse layout tool")
- [Observed, live demo] The demo's top bar has a 2D/3D toggle, "Bins:" filter, "Level:" dropdown and EDIT button. There is a compass "N" control labeled "Rotate layout", a thermometer "Heatmap" button bottom-right, and an "INFO" button bottom-center that opens a bottom sheet at narrower widths. The demo floor shows about 24 shelves, many vertical (Shelf 3–10) and horizontal shelf runs, plus three areas: Receiving (brown), Fulfillment (blue) and Shipping (purple). — [SKUSavvy demo](https://www.skusavvy.com/warehouse-layout-preview)
- [Observed, live demo] In 3D mode the "Level" dropdown is replaced by a **"Racks:"** display dropdown with options **Solid / Frame / Uprights / Decks / None**. Bins render as stacked cubes per level. Area labels are painted on the floor in perspective. The camera is a perspective, orbit-style view, so this is true 3D rather than isometric. — [SKUSavvy demo](https://www.skusavvy.com/warehouse-layout-preview)
- [Observed, live demo] The **"Bins:"** filter options are **All bins / Stock levels / Stocked only / Empty only / No bins / Heat Map**. "Stock levels" shades every bin on a blue saturation scale in both 2D and 3D: light grey-blue means low or empty stock, saturated blue means high stock. — [SKUSavvy demo](https://www.skusavvy.com/warehouse-layout-preview)
- [Marketing] "3D Warehouse Mapping" and "Navigate a precise 3D model of your warehouse"; "Move bins and clear bottlenecks with a simple drag". — [skusavvy.com](https://www.skusavvy.com/); [Warehouse mapping software](https://www.skusavvy.com/warehouse-mapping-software)

**Edit mode toolbar and shortcuts**
- [Doc] The edit-mode tool rail (lower right) has five tools: Drag/Pan & select, Create Shelf/Bin, Create Area, Create Wall/Door, and Bulk tools (Generate Bins / Copy bins to other levels). The panel header has Info (go to the element's detail page), Rotate ("Rotate the selected object 90 degrees clockwise") and Delete. "Currently selected element (highlighted in red) select and drag on the edges of the element to change the size." — [SKUSavvy Warehouse guide](https://www.skusavvy.com/docs/guides/warehouse)
- [Observed, live demo] The DOM button labels in edit mode are: "CANCEL | UPDATE | INFO | Drag/Pan | Create Shelf/Bin | Create Area | Create Wall/Door | Generate Bins | Copy Levels". In edit mode the 2D/3D toggle disappears. In the demo, a drag with "Create Shelf/Bin" active did not draw a rectangle; a small red-outlined element appeared at the drag end point instead. This suggests click-to-place followed by resize. I could not confirm whether a real drag-to-draw gesture exists. — [SKUSavvy demo](https://www.skusavvy.com/warehouse-layout-preview)
- [Doc] Hot keys: Ctrl/Cmd+C and Ctrl/Cmd+V copy and paste a bin or shelf; Ctrl/Cmd+Z undoes; Shift+click multi-selects; arrow keys "precision move" selected elements. "Drag a bin from one shelf to another shelf to reassign that bin." — [SKUSavvy Warehouse guide](https://www.skusavvy.com/docs/guides/warehouse); also in the description of [Advanced Warehouse Layout Setup Tutorial (YouTube)](https://www.youtube.com/watch?v=C6qK_M0aCQQ)
- [Doc] Shelves have levels "which correspond to the next layer up". You "must set the level and update the layout before placing a shelf on that level". Each 2D "layer is one shelf level in a top down view". — [SKUSavvy Warehouse guide](https://www.skusavvy.com/docs/guides/warehouse)
- No snap-to-grid setting, grid-size setting, or alignment guides are documented. The canvas does show a grid.

**Rack / shelf / bin definition (properties panel)**
- [Doc + Observed screenshot] The "Update Shelf" panel has Name, Description, number of Levels ("Think of a level as one row of a shelf"), Start X / Start Y on the canvas, Width / Length ("adjusts in real-time on the canvas"), a "Generate bin names" button, and a list of bins on the shelf. — [SKUSavvy Warehouse guide](https://www.skusavvy.com/docs/guides/warehouse)
- [Doc + Observed screenshot] The "Update Bin" panel has Name, Description, Start X / Start Y (relative to the shelf's top-left corner; "the bin is within a shelf"), Length / Width ("bins must reside inside the confines of a shelf"), Level, a product list with quantities and an "Edit Products" action, and a pickable toggle. The header shows INFO, a rotate icon and a red delete icon. — [SKUSavvy Warehouse guide](https://www.skusavvy.com/docs/guides/warehouse)
- [Observed, doc screenshot] A shelf's "BINS" table lists Bin / Length / Width / Level per row, with editable names, plus "GENERATE BIN NAMES" and "CREATE BIN" buttons. — [SKUSavvy Warehouse guide](https://www.skusavvy.com/docs/guides/warehouse)
- [Doc] Pick sides: each shelf has N/E/S/W sides that can each be marked pickable, for example to block a side against a wall. If all four are unchecked the panel warns "This shelf is not pickable". Sides affect routing only. A batch setting, "Group picks by shelf side", sorts picks by side. — [SKUSavvy Warehouse guide](https://www.skusavvy.com/docs/guides/warehouse)
- [Doc] Bin capacity is a unit count, not a volume. Check-in and bulk allocate refuse any quantity over capacity. Adjust Inventory, single allocation and bin-to-bin transfers warn and cap the quantity instead. — [SKUSavvy Warehouse guide](https://www.skusavvy.com/docs/guides/warehouse)
- [Doc] A non-pickable bin's inventory is hidden from the pick screen, and the bin is skipped in pick routes. The inventory stays in the system. — [SKUSavvy Warehouse guide](https://www.skusavvy.com/docs/guides/warehouse)

**Bulk generation and naming**
- [Doc + Observed screenshot] **Generate Bins**: select one shelf (or several with Shift+click) and open the bulk tools. Set Rows (stepper) and Columns (stepper), tick "Replace Existing Bins", and check the Levels to generate on (Level 1, Level 2…). A live preview splits the shelf rectangle into a grid. Confirm with "ADD BINS TO 1 SHELF". — [SKUSavvy Warehouse guide](https://www.skusavvy.com/docs/guides/warehouse)
- [Doc] **Copy bins to other level(s)**: choose a source level, choose target levels, and choose to replace or add. Then rename or bulk "Generate bin Names". — [SKUSavvy Warehouse guide](https://www.skusavvy.com/docs/guides/warehouse)
- [Doc] **Generate names** overwrites all bin names on the shelf. The pattern is level number plus position letter: "Bin 2A… is a second level bin (2) on the left-top position (A)… the 3rd bin on a shelf sitting on the 5th level… 'Bin 5C'". [Observed screenshot] Letters run past Z into AA, AB… (for example "Bin 1AA" to "Bin 1BA" on a dense shelf). — [SKUSavvy Warehouse guide](https://www.skusavvy.com/docs/guides/warehouse)
- [Doc] The **warehouse prefix** is set once and must be unique per warehouse. — [SKUSavvy Warehouse guide](https://www.skusavvy.com/docs/guides/warehouse)
- [Marketing/Video description] "Apply custom naming patterns… Example: A1-S3-B4 or Zone1-Rack2-Level3". Chapters: 0:36 Add bins in bulk, 1:45 Bin capacity, 2:12 Pick sides and obstacles, 2:51 Non pickable bins, 3:24 Directed bin put-away criteria, 4:44 Custom bin labels and printing. — [Things to Know About SKUSavvy Inventory Bin Locations (YouTube)](https://www.youtube.com/watch?v=eaiRo_DxmNI). This marketing claim of "custom naming patterns" conflicts with the help doc, which documents only the fixed `<level><letter>` generator. In practice the shelf name is the other half of the full label (see label formats below).
- [Doc] "Create Bins in Bulk" lists three methods: duplicate bins between shelves, generate by rows/columns, and copy-paste whole shelves with Ctrl+C/V. Bin names can be generated in bulk. — [SKUSavvy llms-full.txt (docs mirror)](https://www.skusavvy.com/llms-full.txt)
- [Doc] Migration: "Bin locations are built fresh in the visual warehouse editor. Most source systems don't export layout data in a portable format." CSV import exists for inventory, **bin barcodes**, kits, vendors and POs. — [SKUSavvy General FAQ](https://www.skusavvy.com/docs/frequently-asked-questions/general); [llms-full.txt](https://www.skusavvy.com/llms-full.txt)

**Assigning products to bins**
- [Doc] Inventory is only pickable once it sits in a bin. The fastest method is **Bulk Allocate**: open the flattened inventory list, tap "Bulk Allocate", then do a continuous **scan item → scan bin** loop (a Bluetooth scanner is recommended), or pick the bin from a dropdown. — [SKUSavvy Warehouse guide](https://www.skusavvy.com/docs/guides/warehouse); [Quick start](https://www.skusavvy.com/docs/guides/quick-start)
- [Doc + Observed screenshot] **Allocate from the layout**: pan to the bin, click the shelf, click again for the bin, then "Bin Info". The right panel lists the bin's Level and an INVENTORY table (QTY, NAME + variant line) with per-row delete icons and an "ADD INVENTORY" button. Drag-and-drop of products onto bins is **not** documented. — [SKUSavvy Warehouse guide](https://www.skusavvy.com/docs/guides/warehouse)
- [Doc] Bin-to-bin transfers start from a product scan, an inventory item, an ad-hoc adjustment or a bin scan, with the destination chosen by dropdown or scan. The page does not mention dragging stock between bins on the map. — [Bin-to-bin transfer](https://www.skusavvy.com/docs/guides/warehouse/bin-to-bin-inventory-transfer)

**Receiving / put-away on the map**
- [Doc] PO check-in "shows you a split screen view of the warehouse map and the PO contents". Selecting a PO item shows its current bin positions on the map. The check-in 3-dot settings toggle the layout on/off, the 3D layout, barcode scans, scan-to-bin, label printing and the label format. Scans are contextual: scan item, count, scan bin, with no clicks needed. — [llms-full.txt, "PO Check-In / Allocation and Put-Away"](https://www.skusavvy.com/llms-full.txt)
- [Doc] Check-in contents can be dropped into an **Area** (for example Receiving), which marks the order delivered but leaves the stock unpickable. — [llms-full.txt](https://www.skusavvy.com/llms-full.txt); [Warehouse guide](https://www.skusavvy.com/docs/guides/warehouse)
- [Doc + screenshot description] Directed put-away scores each bin against product type/tag/SKU/option criteria. The suggestions appear in an **"Assign Location" dropdown** with **capacity bars** and a **starred preferred bin**. The doc does not say they are highlighted on the map. — [Bin put-away criteria](https://www.skusavvy.com/docs/guides/warehouse/bin-putaway-criteria)

**Picking on the map**
- [Observed, doc screenshot] The batch pick screen (desktop or tablet) shows a breadcrumb ("Austin Warehouse | Austin, TX / Orders / Fulfill / Batch #01055"), an assignee dropdown and a 3-dot menu. The **3D map fills the top half**: all shelves are drawn as translucent ghost boxes, and **only bins holding items in this batch are drawn as solid blue cubes**. The bottom half is a swipeable card carousel. Card 1 is the batch list with a filter (All/picked/unpicked), a progress count "6/23", and per-item "picked x/y" (completed items struck through). A "PACK →" button is fixed at the bottom with pagination dots. — [Batch picking guide](https://www.skusavvy.com/docs/guides/warehouse/batch-picking)
- [Observed, doc screenshot] The item card shows a product thumbnail, name, variant and SKU, and a "0/2" needed count. A table lists every bin holding the item: QTY / BIN (link) / LOT (#, exp date) / LVL / SHELF, with a per-row PICK button. On the map the **current item's bin is highlighted red**, while other batch bins stay blue. Left/right arrows cycle through items. — [Batch picking guide](https://www.skusavvy.com/docs/guides/warehouse/batch-picking)
- [Doc] "Selecting a bin on the map or in the list highlights the product" (two-way linking between map and list). The Pick button is hidden when a scan is required. With a hardware scanner you "simply start scanning bins/items". — [Batch picking guide](https://www.skusavvy.com/docs/guides/warehouse/batch-picking)
- [Observed, doc screenshot] Batch Settings include "Show warehouse layout on pick screen" and "Show warehouse layout in 3d" (per user, per device). Routing settings include a "Debug routing" toggle, a "REFINE ROUTE" button, and sliders for **Max Time** (10.0s) and **Resolution** (200.0). — [Batch picking guide](https://www.skusavvy.com/docs/guides/warehouse/batch-picking)
- [Observed, doc screenshot] **Pick route rendering (Debug routing)**: a blue polyline on a dotted occupancy grid. **Numbered grey circles** (1, 2, 3, 4…) mark stops, and a red marker marks the start/end point. Shelves appear as white obstacle blocks. In 2D a **bullseye button sets the route start point**, shown as a red dot. — [Batch picking guide](https://www.skusavvy.com/docs/guides/warehouse/batch-picking)
- [Doc] Routes are computed "using a traveling salesman algorithm against your actual warehouse layout". — [General FAQ](https://www.skusavvy.com/docs/frequently-asked-questions/general)
- Inference from the above: the numbered polyline lives in a "debug" view. The everyday picker view highlights bins in 3D and steps through items in route order, without drawing a turn-by-turn line. The docs do not say this outright.

**Cycle counts, heatmaps, other ops**
- [Doc] The cycle count screen shows the "Visual location of the bin on your warehouse layout", and a 3D view can show the **cycle count path** with an on/off toggle. Item states are over, match or under expected; the expected quantity shows only if settings allow. — [Cycle counting](https://www.skusavvy.com/docs/guides/warehouse/cycle-counting)
- [Doc + Observed screenshot] **Heatmap** panel fields: **Change Types** (multi-select chips such as "INVENTORY MOVED", order picks, adjustments, restocks, external fulfillments), **Color Scheme** (2-color blue→red or 5-color rainbow), and **Scaling** ("Cap >90%" means the top 10% of bins are left out of scaling). It renders on the 3D map with bins colored by activity. — [Warehouse guide](https://www.skusavvy.com/docs/guides/warehouse)
- [Observed, live demo] The heatmap panel also has a **Metric** dropdown ("Sum of all changes") and a ranked **BIN / LVL / SHELF / HEAT** table listing the hottest bins (for example "Bin 1T, 1, Shelf 24, 28,800"). — [SKUSavvy demo](https://www.skusavvy.com/warehouse-layout-preview)
- [Doc] The "Create Bin Replenishment" button sits on the map view. — [Bin-to-bin transfer](https://www.skusavvy.com/docs/guides/warehouse/bin-to-bin-inventory-transfer)

**Labels from the map**
- [Doc + Observed screenshot] You can print from one bin (Barcode card → printer icon), from the bin list (Layout > Bins > Print Labels, up to 250 per page), or for a **whole shelf**. Open the shelf in the layout and use "Print Barcodes" → "PRINT SHELF BIN BARCODES": pick a Label Format, tick the levels to print (Level 1–4 checkboxes), then PRINT. Labels print in level, then bin-name order. Built-in formats are "(shelf) / (level) / (bin)", "(shelf) > (bin)" and "Bin: (bin)", or a custom template (4×2, 4×4, 4×6, 2×1 in, or custom). Bins without a barcode are skipped. — [Printing guide](https://www.skusavvy.com/docs/guides/printing); [Warehouse guide](https://www.skusavvy.com/docs/guides/warehouse)

**Mobile**
- [Doc/Marketing] SKUSavvy is browser-based and "Runs in the browser on any phone or tablet (iOS and Android); no app store install". Pinch-to-zoom works on mobile. On the pick screen you cycle the pick list by swiping. — [llms-full.txt comparison tables](https://www.skusavvy.com/llms-full.txt); [Warehouse guide](https://www.skusavvy.com/docs/guides/warehouse); [Batch picking](https://www.skusavvy.com/docs/guides/warehouse/batch-picking)
- [Marketing] The Shopify listing calls the mobile mode a "Phone browser on the floor" option. The YouTube Short says "Scan any bin to see what's in it". — [Shopify App Store](https://apps.shopify.com/skusavvy); [Stop Hunting for Products (YouTube Short)](https://www.youtube.com/watch?v=WMYxN-PTgUU)
- Not found anywhere: a "you are here" indicator or live picker position.

**Reviews and complaints**
- [Review] Shopify App Store: 4.9★ from 8 reviews. One reviewer (May 2026) calls the "layout builder with warehouse location mapping" extremely helpful; another (Oct 2026) says setup was quick. — [Shopify App Store](https://apps.shopify.com/skusavvy)
- [Review] G2 (4.8★, 14 reviews): "big learning curve", "daunting… for our newer users", and KPI analytics need work. GetApp: kits can't be tracked as multiple units with Shopify, and permissions lack detail. None of these complaints is specific to the map. — [search summary of G2/GetApp](https://g2.com/products/skusavvy); [GetApp](https://www.getapp.co.uk/software/2045583/skusavvy-mobile-wms-network)
- [Marketing] SKUSavvy itself advises at least 6 weeks of setup for Shopify stores and sells managed implementation ($2,750 + $250/mo) that covers "the warehouse map, bin labels". — [Service packages](https://www.skusavvy.com/wms-services); [llms-full.txt](https://www.skusavvy.com/llms-full.txt)

### Inferences
- The "best builder" feel comes from three things together. First, **coarse objects with strong defaults**: a shelf is just a rectangle, and bins are generated, not drawn. Second, **bulk dialogs with live preview**. Third, **one map reused everywhere**, with the same top-bar filters on every screen. The drawing itself is basic: no documented snapping or alignment guides, 90° rotation only, rectangles only.
- 2D is the editing surface and 3D is the presentation and verification surface. 3D gets you "wow" and orientation; 2D gets you precision and per-level editing. The Racks display toggle (Solid/Frame/Uprights/Decks/None) is a cheap but effective way to cut occlusion in 3D.
- The level model is "a shelf owns N levels; each level has its own bin grid". The top-down editor shows one level at a time. **There is no rack-front elevation view.** That is a gap our ERP could fill, borrowing the NetBox pattern in section 7.
- Pick UI pattern worth copying: the map shows only the bins relevant to the task (solid) against a ghosted context. The current target is a distinct color (red). The list and map are cross-linked.

### Gaps
- Real mobile layout of the map (phone portrait) was not observed. The screenshots are tablet or desktop width.
- I could not confirm whether the 3D view supports clicking a bin to open its detail, or whether search-and-highlight (type a SKU, bins light up) exists on the map. Marketing says "Search any product and see exactly which aisle, rack, and shelf it sits on", but I found no doc screenshot of map highlighting from search.
- Multi-floor and mezzanine support is not documented.
- Video transcripts could not be read (YouTube blocked), so verbal tips in the tutorials are missing.

---

## 2. Skustack / Sellercloud "Visualize" (Skustack Lens Pro)

### Takeaway
Visualize is a **2D planning grid**. You drag pre-classified "storage elements" (racks/groups derived from bin names) onto a grid of configurable width and height. Its distinctive idea is **naming-convention-first setup**: it parses existing bin names into Floor/Area/Aisle/Rack/Bay/Column/Row/Level/Bin through a drag-to-map wizard. View mode shows **bin cards** with product images and a capacity progress bar. Picklists show **numbered, employee-colored processed locations**.

### Cited Findings
- [Doc] It is exclusive to Skustack Lens Pro. You open it from lens.skustack.com → Visualize, then choose "Configure Warehouse Plan" (opens on the **Elements** tab) or "Explore Warehouse"/View Mode. — [Sellercloud LMS: Visualize Module Workflow](https://lms.sellercloud.com/courses/skustack-and-skustack-lens/lessons/visualize-module-workflow/)
- [Doc] "Convention overview completion" shows bin count and naming progress. "Configure" lists the most common bin-name patterns and the share of bins using each. Group types are **Shelving unit or Racking system** (Floor, Area, Aisle, Rack (mandatory), Bay, Column, Row, Level, Bin) or **Custom/Unstructured** (Floor, Area, Group, Bin). You map terms by dragging them into fields. — [LMS](https://lms.sellercloud.com/courses/skustack-and-skustack-lens/lessons/visualize-module-workflow/)
- [Doc] The Elements tab lists the configured storage terms and their distribution, plus **Regions** and **unconfigured bins**. You drag elements onto the planning grid. "Clear all" removes everything. "Configure project" sets grid width and height. The left menu has Search, Picklists, Bins Report, 2D View, Undo (Ctrl+Z), Configure project, Elements and Convention wizard. — [LMS](https://lms.sellercloud.com/courses/skustack-and-skustack-lens/lessons/visualize-module-workflow/)
- [Doc] Search by Bins, Barcode or SKUs. Results appear as a list of location IDs, and SKU results show a product thumbnail. A go-to-rack shortcut and a bin dropdown list every bin holding the result. — [LMS](https://lms.sellercloud.com/courses/skustack-and-skustack-lens/lessons/visualize-module-workflow/)
- [Doc] Picklists: the 15 most recent show by default, with Open/Closed filters and search by ID. A warning plus "Go to Warehouse" appears if the picklist belongs to another warehouse. Details show by Steps or by Products. **"Processed locations are numbered and highlighted in each employee's assigned color."** — [LMS](https://lms.sellercloud.com/courses/skustack-and-skustack-lens/lessons/visualize-module-workflow/)
- [Doc] The Bins Report "Load" lists all empty bins by rack or group (alphabetical, with counts) and highlights them on the grid. Expand to open contents; there is a copy-name icon. — [LMS](https://lms.sellercloud.com/courses/skustack-and-skustack-lens/lessons/visualize-module-workflow/)
- [Doc] Selecting a location opens a right slide-out with its bins. Controls: an A–Z↑ sort and "Hide Levels Without Bins". **Bin cards** show the name (with copy), product count and quantities, swipeable product images, and a **capacity progress bar with % used**. — [LMS](https://lms.sellercloud.com/courses/skustack-and-skustack-lens/lessons/visualize-module-workflow/)
- [Doc] Lens Picklists also has a Movements tab with a live picking-progress graph that refreshes every 15 s. — [search summary of LMS "Modules in Skustack Lens"](https://lms.sellercloud.com/courses/skustack-and-skustack-lens/lessons/modules-in-skustack-lens/)

### Inferences
- The brief described a "pick path overlay". The LMS supports numbered, colored stops; it does not document connecting polylines. Treat it as a numbered-stop overlay unless verified.
- **Infer the hierarchy from existing bin names** is a strong pattern for an ERP that already has location codes. It avoids re-keying. It suits our case if the locations table already exists.

### Gaps
- No screenshots were viewed. The LMS pages carry images without captions, and I did not render them, so the visual style of the grid elements is unverified.
- Whether a 3D view exists: none is documented ("2D View" only).

---

## 3. Odoo: native locations UI and the 18/19 add-ons

### Takeaway
Native Odoo has **no map**. Locations are a list and form tree with slash-path names (`WH/Stock/Zone A/Refrigerator 1`), created one at a time. Visual layout comes only from third-party add-ons: Three.js WebGL designers with 0.1 m snap, G/R hotkeys and green/amber/red occupancy, or a "3D Properties" tab that derives racking from dimensions.

### Cited Findings
- [Doc] Native: enable Storage Locations, go to Inventory ‣ Configuration ‣ Locations ‣ New, then set Name and Parent Location. The example full path is `WH/Stock/Zone A/Refrigerator 1`. The form has smart buttons (Current Stock, Products, Putaway Rules) and fields for Barcode, Storage Category, Location Type, scrap/dock/replenish flags, cyclic count frequency and removal strategy. No map or bulk creation is described. — [Odoo 18 docs: Use locations](https://www.odoo.com/documentation/18.0/applications/inventory_and_mrp/inventory/warehouses_storage/inventory_management/use_locations.html)
- [Marketing/app listing] **Smart Warehouse Visualizer (Odoo 18, ~$96)**: a WebGL scene (Three.js r168). In edit mode you drag, drop and rotate racks and bins, with **0.1 m grid snap**. Shortcuts are G (move), R (rotate) and ⌘S (save). Changes are queued with a **pending-changes counter badge** and saved in one batch. An Inspector sidebar edits name, parent location, XYZ and W·D·H. View mode colors occupancy: **Green <50%, Amber 50–80%, Red >80%**, live via the Odoo bus. Autocomplete search over products and locations highlights every bin holding a product, with quantities, and **flies the camera** there. Typing a transfer reference highlights its bins with demand progress. The bin drawer shows SKU, lot/serial, expiry, on-hand, reserved per channel and available. Only Stock Managers can edit. — [Odoo Apps: warehouse_visualizer](https://apps.odoo.com/apps/modules/18.0/warehouse_visualizer)
- [Marketing/app listing] **Mindscript 3D Warehouse & Stock Location View (Odoo 19, ~$44)**: a "3D Properties" tab per location holds Location Code, L/W/H and floor position, plus optional Capacity, **Shelf Levels** and **Bins per Level** ("0 = auto-derive from size"). A one-click green→red heatmap fills racks in proportion to stock. Search moves the camera. Controls are orbit/pan/zoom plus **first-person walk mode**. A rack click opens a slide-in with status, a capacity gauge, on-hand vs capacity, a **rack grid**, and products. All warehouses can appear side by side. — [Odoo Apps: mindscript_stock_3d_view](https://apps.odoo.com/apps/modules/19.0/mindscript_stock_3d_view)
- [Marketing] ECOSIRE "Stock 3D View" is a build-to-order service for Odoo 17–19 (from $249), computing occupancy from `stock.quant`. — [ECOSIRE](https://ecosire.com/de/apps/odoo/stock-3d-view)

### Inferences
- The Odoo add-ons show the "attach geometry to existing location records" approach: XYZ plus size fields on the location model. That is the cheapest way to retrofit a map onto an ERP's existing location table. It also matches SAP EWM and Infor (section 6).
- The "pending changes" badge with batch save is a good pattern for a Supabase-backed editor: one RPC per save, not per drag.

### Gaps
- I did not verify the add-on UIs visually. Listings are vendor copy.

---

## 4. Mecalux Easy WMS

### Takeaway
Mecalux documents a **heatmap layer over the facility floor plan**. It has process filters (receiving, shipping, replenishment), area-type filters (racking/shelving, buffers, staging, docks), a time-range filter down to the hour, multi-level navigation, adjustable heat ranges with a legend config, and image/report export. I found no documentation of a layout *builder*. In Mecalux's model the layout is configured by the vendor or integrator.

### Cited Findings
- [Doc/Marketing] The heatmap is drawn over the floor plan as an interactive map. Users navigate between warehouse levels. Filters: process (all, or e.g. receiving/shipping/replenishment); facility scope (all, racking & shelving, buffer zones, staging, loading docks); time range down to the hour. Heat ranges are adjustable, and a legend configuration screen is shown. It exports as an image or report. It feeds slotting "reorganization proposals". No date is given. — [Interlake Mecalux: Heatmap / slotting update](https://www.interlakemecalux.com/software/updates/heatmap-slotting)
- [Review] A Capterra reviewer praised "location marking and easy navigation for operators". — [Capterra Easy WMS](https://www.capterra.co.uk/software/114409/easy-wms)
- [Marketing] A Mecalux GenAI add-on can produce visual summaries of real-time occupancy (March 2025 article). — [Roofing Contractor article](https://roofingcontractor.com/articles/100582-mecalux-integrative-genai-warehouse-management-system)

### Gaps
- Whether Easy WMS has a self-serve visual layout editor or a 2D/3D "warehouse map" outside the heatmap: not found.

---

## 5. Mid-market WMS/IMS: is there a map at all?

### Takeaway
Most mid-market tools have **no visual map**. Locations are text hierarchies with bulk builders or CSV import, and routing is derived from naming conventions. The exceptions are SKUSavvy (3D), PULPO WMS (a browser "Warehouse Wizard" layout tool), and Skustack Visualize (2D add-on).

### Cited Findings
- Logiwa: docs and marketing describe fixed/dynamic pick locations, capacities and algorithmic pick paths. No drawn map was found. — [Logiwa WMS](https://www.logiwa.com/wms-software) (search-based; absence of evidence)
- Deposco, Hopstack, Extensiv: no map or layout feature found in public material. Searches returned only generic feature lists. Hopstack's GoodFirms listing names features such as multi-location, dashboards and barcoding, with no map. — [GoodFirms Hopstack](https://www.goodfirms.co/software/hopstack); [Extensiv getting started](https://help.extensiv.com/wm-getting-started/1618962-step-2-setting-up-your-business)
- Infoplus: the Warehouse Setup tables are Buildings, Zones, Aisles and Locations, and a **Location Builder** creates many locations at once. No map was found. — [Infoplus KB folder](https://support.infopluscommerce.com/support/solutions/folders/11000004288) (search summary)
- Cin7 Core: two levels, Location → Bins, created at Settings → Reference books → Stock → Locations & Bins → Bins tab. A combined "Location:Bin" label format, staging bins, and **CSV import/export of bins**. Pick zones are only in the Cin7 Core WMS app. No map. — [Cin7 Core Bins](https://help.core.cin7.com/hc/en-us/articles/11321150323727-Bins); [Cin7 Core Locations](https://help.core.cin7.com/hc/en-us/articles/9034487246735-Locations). Cin7 Omni has a "Locations overview" (branch → locations), also with no map. — [Cin7 Omni Locations overview](https://help.omni.cin7.com/hc/en-us/articles/9128553363855-Locations-overview)
- inFlow: locations are buildings and sublocations are typed text (aisle/shelf/bin). **"Street-style routing"** recommends a pick order if sublocations follow a dash convention like `A-06-C`. No graphical layout. — [inFlow blog: street style routing](https://www.inflowinventory.com/blog/optimize-your-warehouse-fulfillment-process-with-street-style-routing); [inFlow sublocations](https://www.inflowinventory.com/support/cloud/can-i-track-specific-locations-like-aisle-numbers-bin-numbers-etc)
- Zoho Inventory: I could not reach a help page (404). No map evidence was found.
- PULPO WMS: a **"Warehouse Wizard"**, described by SKUSavvy as a "browser-based layout drawing tool" and by third parties as no-code. A Shopify reviewer says it helped label bins and shelf positions at setup. — [SKUSavvy comparison (competitor source)](https://www.skusavvy.com/llms-full.txt); [zoftwarehub](https://zoftwarehub.com/en-ae/products/pulpo-wms/zoftware-analysis); [PULPO Shopify reviews](https://apps.shopify.com/pulpo-wms/reviews?page=1)
- Vision Software WMS: a "Warehouse Diagram" draws an aerial view with each location as a labeled, color-coded square, and a heatmap that includes "% Filled". — [search snippet of Vision Software wiki](https://visionsoftware.atlassian.net/wiki/x/FwD4eg) (the page itself returned empty to WebFetch)

### Inferences
- A visual map is still a differentiator in the SMB/mid-market. The baseline everyone ships is: (a) a hierarchical location code, (b) a bulk location builder or CSV import, (c) convention-based pick sorting. Our module should ship (a) to (c) first and put the map on top.

### Gaps
- I did not verify Deposco, Hopstack, Logiwa or Extensiv in-app (absence of evidence ≠ evidence of absence). Zoho was not verified.

---

## 6. Enterprise references (SAP EWM, Infor, Manhattan, Blue Yonder, Körber)

### Takeaway
Enterprise systems treat the map as a **projection of bin master data**. Each bin carries XYZ coordinates, size and an access orientation. The view is rendered as a 2D layout (SAP GWL) or a 3D audit view (Infor Visual Travel Audit), filtered by storage type or section, with a rack-level ↔ bin-level zoom. Manhattan advertises a "digital representation" for people and equipment; Blue Yonder and Körber had no public map-UI evidence.

### Cited Findings
- [Doc] SAP EWM **Graphical Warehouse Layout (/SCWM/GWL)**: a 2D graphic of the warehouse interior and exterior for checking configuration, stock levels and distribution. By default the bins on one aisle side are grouped as **racks**, and switching to **bin level** shows individual bins from above. Bins need XYZ coordinates, separate from aisle/stack/level. The unit of length comes from the warehouse Customizing. The display extent comes from the largest coordinates, so a bad coordinate puts a rack outside the building outline. You can filter by storage type or storage-type level. Blocked and empty bins can be displayed. Custom objects such as walls and offices are defined in Customizing. Travel distance uses the same coordinates. — [SAP Learning: Creating Storage Bins](https://learning.sap.com/courses/basic-customizing-in-sap-s-4hana-ewm/creating-storage-bins); [SAP Community GWL blog](https://groups.community.sap.com/t5/supply-chain-management-blogs-by-members/graphical-warehouse-layout-in-sap-ewm/bc-p/13563953) (via search summary; direct fetch 403)
- [Doc] Infor WMS **Location Map Configuration**: Cartesian coordinates with (0,0) bottom-left. X/Y/Z mark the **bottom-front-center** of a location. Length is depth (drawn opposite to orientation), width is centered, and height runs up from Z. **Orientation is 0/90/180/270** for the face where product is accessed. It suggests starting at (5000,5000) to leave room for growth. "Level" is listed as unused. — [Infor: Location Map Configuration](https://docs.infor.com/wms/2026.x/en-us/wmsolh/raj1612894155541.html)
- [Doc] Infor **Visual Travel Audit**: a 3D view of locations sized and positioned from master data, with travel sections colored on the floor. Controls: wheel zoom, left-drag rotate, right-drag or arrow keys pan, toolbar recenter/reset/new window, and hover-highlight then select. A Section filter menu. Used to validate coordinates, orientation, aisle restrictions and distance-engine paths. — [Infor: Visual Travel Audit](https://docs.infor.com/wms/2026.x/en-us/wmsolh/visualtravel_loc.html)
- [Marketing] Manhattan Active WM: "see an employee or resource in a digital representation of the warehouse—and react with people, equipment, and tasks in real time". Manhattan Active Yard has a yard digital twin showing every dock door and yard position. — [SoftwareOne listing](https://platform.softwareone.com/product/manhattan-active-warehouse-management/PCP-6719-1875); [BusinessWire 2023](https://www.businesswire.com/news/home/20230524005021/en)
- Blue Yonder, Körber: no public evidence of a bin-level map UI found. — [ki-syndikat Körber review](https://www.ki-syndikat.de/tools/koerber-wms/) (no digital twin mentioned)

### Inferences
- The data contract to copy: `location { x, y, z, width, depth, height, orientation(0/90/180/270), parent }`. The map is then derived, not separately authored. Coordinates can come from the builder or from CSV, and both paths produce the same records.
- "Rack view vs bin view" zoom (SAP) is the enterprise version of SKUSavvy's "click shelf, click again for bin".

### Gaps
- No screenshots of SAP GWL or Manhattan views were viewed.

---

## 7. Open-source / indie projects and non-warehouse analogues

### Takeaway
The most transferable analogue is the **data-center rack elevation** (NetBox): a vertical front/rear elevation with numbered units, items spanning units, colors by role, optional face images, full-depth items blocking both faces, and reservations. A warehouse rack's front face (levels × positions) maps directly onto it. Open-source warehouse visualizers add the **2D plan + hover "side view" of levels** pattern (Virtual Warehouse) and instanced-mesh 3D performance techniques.

### Cited Findings
- [Doc] **Virtual Warehouse** (Breta01): a bottom-left toggle switches between 2D top-down and 3D. The heatmap is 2D only: order frequency per item, aggregated to locations, on a **Viridis** scale. Modes are "All levels" (sum) or "Separate level", set with a toggle and slider. A **Side view** shows the vertical levels of the location under the cursor (or the selected one), each level colored by its own heat value. A right sidebar has Locations/Items/Order tabs with checkbox filters and substring search. — [Virtual Warehouse UI docs](https://virtual-warehouse.readthedocs.io/en/latest/user_guide/user_interface.html); [GitHub repo](https://github.com/Breta01/virtual-warehouse) (BSD-3; the GitHub page showed 3 stars and 132 commits when fetched)
- [Doc] **NetBox**: hierarchy is Region → Site (→ Location, nested) → Rack, with flat Rack Groups for row/aisle. Racks have a height in U and **half-unit positions** (a device can sit at 2.5). Rack types carry height, unit ordering and weight. — [NetBox Facilities](https://netboxlabs.com/docs/netbox/features/facilities/)
- [Doc] NetBox elevation details: "descending units" puts U1 at the top (the default is ascending from the bottom). A device "is considered to be mounted in the lowest-numbered rack unit which it occupies". A device type can be **Full Depth**, occupying front and rear faces. Each device has a **Rack Face** and **Position**. 0U devices (vertical PDUs) take no unit. **Front & Rear Images** uploaded on the device type "will be used to render the device in rack elevation diagrams". Rack **Reservations** reserve arbitrary units with a required description and optional tenant. Default elevation unit size is 22 px tall × 220 px wide. — [NetBox device type](https://raw.githubusercontent.com/netbox-community/netbox/main/docs/models/dcim/devicetype.md); [device](https://raw.githubusercontent.com/netbox-community/netbox/main/docs/models/dcim/device.md); [racktype](https://raw.githubusercontent.com/netbox-community/netbox/main/docs/models/dcim/racktype.md); [rack reservation](https://raw.githubusercontent.com/netbox-community/netbox/main/docs/models/dcim/rackreservation.md); [default values](https://raw.githubusercontent.com/netbox-community/netbox/main/docs/configuration/default-values.md)
- [Doc] The NetBox elevation can be shown from front or rear. Devices are drawn at their U, spanning their height, **colored by role**. Empty units show as available space. — [OVHcloud NetBox elevation guide](https://docs.ovhcloud.com/en/guides/hosted-private-cloud/opcp/how-to-handle-rack-elevation)
- [Doc] **Viewer3D** (three.js warehouse SCADA): InstancedMesh pools (one draw call per pool, still raycast-pickable) and an on-demand render loop. About 90 fps / 670 draw calls / 2.6M triangles on the demo, with tens of thousands of pallets targeted. The **2D↔3D switch morphs the orthographic and perspective projections**. Edit mode (key **E**) has AutoCAD-style window/crossing marquee select, move/rotate/resize and magnet snap. A commenter reported it failing in Firefox. — [three.js forum: Viewer3D](https://discourse.threejs.org/t/viewer3d-real-time-3d-warehouse-scada-30k-pallets-in-vanilla-three-js-no-framework/92418)
- [Doc/secondary] **3d-express-warehouse** (Next.js + React Three Fiber): 3 aisles × 6 columns × 4 levels × 2 sides = 144 slots, colored by state, with selection and filtering, using mock data. **r3f-wms-visualizer**: two InstancedMesh sets (occupied and empty) with hover/click. — [juejin write-up](https://juejin.cn/post/7654641623330209802); [tomevault summary](https://tomevault.io/tome/djordjeperovic/r3f-wms-visualizer) (repos not verified directly)
- [Marketing] **Optioryx** layout editor: build from location IDs, racks, obstacles, hallways and start/end points. **Excel import** generates the structure. One-way or bi-directional hallways. Location tags (sprinklered, flammable, temperature, weight). **Layout versions** with simulation comparison and history. Velocity and congestion heatmaps. — [Optioryx](https://www.optioryx.com/solutions/warehouse-layout-management)
- [Doc] Seating-chart editors (close analogue for rows of bins): select a row and **duplicate into parallel rows**; **bulk labeling** of highlighted seats with a prefix and From/To range (A1, A2…); a choice of numbering direction; **odd/even numbering** via start/end; uniqueness required per row; **duplicate-name conflict detection** highlighted on the canvas and in the inspector. — [tixtree](https://www.tixtree.com/help/books/events/page/how-to-create-a-simple-seating-chart); [zkipster](https://support.zkipster.com/articles/2687416-designing-your-seating-chart); [Tickera odd/even](https://tickera.com/tickera-documentation/faq/create-oddeven-numbers-seating-charts-automatically/); [seatmap.pro name validation](https://seatmap.pro/knowledge-base/venue-editor/seat-name-validation) (via search summaries)
- Mappedin indoor-map platform: a heat map of high-traffic areas over a warehouse twin, rendered with deck.gl from WMS data. — [Mappedin blog](https://mappedin.com/resources/blog/visualizing-warehouse-operations-with-indoor-maps)

### Inferences
- **Rack elevation = shelf front face.** Rows are levels (numbered bottom-up, matching NetBox ascending default and typical racking), columns are positions, and a cell is a bin. Bins that span positions or levels are like multi-U devices; "full depth" is like a pallet position that blocks the back face. Reservations map to "reserved for SKU or incoming PO". Neither SKUSavvy nor Skustack has this view. Virtual Warehouse's hover side view is the nearest warehouse equivalent.
- Seating-chart labeling (prefix + range + direction + odd/even + conflict detection) is more flexible than SKUSavvy's fixed `<level><letter>` generator. It is a clear opportunity.

### Gaps
- RackTables, Unifi network maps, Floorplanner and SketchUp were not researched (time budget). Seats.io's own designer docs were not reachable (404).

---

## 8. Cross-cutting design answers (synthesized from sections 1–7)

### Takeaway
The evidence converges on a layout of **top bar (view toggles and filters) + canvas + right inspector panel**, with drill-down by clicking (shelf → bin) rather than a persistent tree. Bulk generation is how builders get fast. Stock appears as per-bin color scales or counts. The task view always pairs a map with a list.

### Cited Findings
- **Hierarchy UI.** SKUSavvy: no tree. Hierarchy is navigated by clicking (shelf, then bin), with a breadcrumb in ops screens ("Warehouse / Orders / Fulfill / Batch") and a level dropdown. — [Warehouse guide](https://www.skusavvy.com/docs/guides/warehouse); [Batch picking](https://www.skusavvy.com/docs/guides/warehouse/batch-picking). Skustack: an Elements list (terms, regions, unconfigured bins) next to the grid, plus a right slide-out of bins per location. — [LMS](https://lms.sellercloud.com/courses/skustack-and-skustack-lens/lessons/visualize-module-workflow/). Odoo native: slash-path names in a list. — [Odoo docs](https://www.odoo.com/documentation/18.0/applications/inventory_and_mrp/inventory/warehouses_storage/inventory_management/use_locations.html). SAP: rack-level vs bin-level display plus a storage-type filter. — [SAP Learning](https://learning.sap.com/courses/basic-customizing-in-sap-s-4hana-ewm/creating-storage-bins)
- **Builder speed.** Copy/paste, shift multi-select, arrow nudges, undo, rows × cols × levels generator with preview, copy level to levels, and bulk name generation (SKUSavvy). 0.1 m snap, G/R hotkeys, batched save (Odoo add-on). Excel or CSV import of structure (Optioryx, Cin7, SKUSavvy bin barcodes). Name-convention parsing (Skustack). Marquee select (Viewer3D). — sources as cited in sections 1, 3, 5, 7
- **Elevation vs floor plan.** SKUSavvy: top-down per level plus a 3D stack. Virtual Warehouse: 2D plan plus a hover side view of levels. Mindscript: rack grid in the slide-in. NetBox: front/rear elevation. None of the WMS products combine a top-down plan with an editable front elevation in one builder. — sections 1, 3, 7
- **Stock in a bin.** Saturation scale for stock level, plus filters for filled/empty (SKUSavvy, observed). Green/amber/red occupancy thresholds (Odoo add-on). Capacity progress bar and product image carousel on a bin card (Skustack). QTY/name table in the inspector (SKUSavvy). Proportional rack fill (Mindscript). Viridis for frequency (Virtual Warehouse). — sections 1, 2, 3, 7
- **Search and highlight.** Product search highlights every bin with quantities and flies the camera there; a transfer reference highlights its bins (Odoo Visualizer). Search results list with go-to-rack and a bin dropdown (Skustack). "Show only task bins solid, everything else ghosted" (SKUSavvy pick). — sections 1–3
- **Pick route display.** Numbered stops plus a polyline plus a start marker (SKUSavvy debug routing). Numbered, per-employee-colored processed locations (Skustack). A configurable start point. Pick sides and obstacles feed routing. — sections 1, 2
- **Location detail drawer.** SKUSavvy bin: name, description, X/Y, L/W, level, products × qty, edit products, pickable toggle, barcode card with print, link to the full page. Odoo add-on: SKU, lot/serial, expiry, on-hand, reserved, available. Mindscript: status, capacity gauge, rack grid. Skustack: bin cards with capacity %. — sections 1–3
- **Label printing from the map.** SKUSavvy prints a whole shelf with a level checklist and format selector, or one bin from its barcode card, or up to 250 from the bin list. Label text formats are `(shelf)/(level)/(bin)`. — [Printing guide](https://www.skusavvy.com/docs/guides/printing). No vendor documented lasso-select bins → print.
- **Mobile.** SKUSavvy runs the same responsive web app, with pinch zoom, a swipeable pick carousel, camera or Bluetooth scanning, and an optional map on the pick screen per device. No "you are here" was found in any product. — section 1
- **Complaints.** SKUSavvy has a learning curve and daunting onboarding for new staff (G2), and a multi-week setup with paid implementation that includes building the map. The Viewer3D commenter hit a WebGL/Firefox failure. There is little map-specific negative feedback in public reviews. — sections 1, 7

### Inferences (design recommendations for the Freeze Pipe ERP module)
1. **Data first.** Store geometry on the existing location rows (x, y, w, d, orientation, level count, positions per level, pick faces). Let the builder, a CSV import and naming-convention parsing all write to it.
2. **Two linked editors.** A top-down plan, where you place racks or shelves as rectangles with snap and nudge, and a front elevation for the selected rack (a NetBox-style grid of level × position) where bins are generated, merged, named and printed. This closes SKUSavvy's biggest gap.
3. **Generator dialogs with live preview.** Rows/levels × positions; a naming template with tokens `{aisle}{rack}-{level}{position}`, a start value, a direction (bottom-up or top-down, L→R), odd/even and zero-padding; and a conflict check, borrowed from seating editors.
4. **One map component, many modes.** View filters (All / Stock level / Stocked / Empty / Heat) and a "task mode" that ghosts irrelevant bins and highlights task bins, with the current target in a distinct color. Keep the list and map cross-linked.
5. **3D is optional.** Ship 2D (SVG or canvas) first. Use 3D only as a read-only overview, and hide it on low-end devices. SKUSavvy itself makes 3D read-only and lets each device turn the map off.
6. **Print from the selection.** Select a rack, then choose levels from a checklist, then a format, then print. Add marquee multi-select across racks, which nobody documents.

### Gaps
- No evidence was gathered on accessibility (keyboard-only navigation of the map, color-blind-safe palettes), except Virtual Warehouse's use of Viridis.
- Unifi-style auto-layout and RackTables were not covered.
