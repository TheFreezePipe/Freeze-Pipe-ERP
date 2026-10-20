# Warehouse Location Data Models and 3D/Visual Warehouse Map Implementations

Research date: 2026-10-19. Scope: single small DTC e-commerce warehouse (Freeze Pipe / FRESHeTECH), custom ERP on React 18 + Vite + TS + Tailwind/shadcn, Supabase Postgres (RPC, RLS) + Deno edge functions, existing carton-native freight receiving (freight_carton_groups, freight_receipts), ShipStation as shipping hub. Enterprise-only complexity is flagged as optional.

## 1. Location hierarchy, naming/numbering conventions, and location barcodes

### Takeaway
The industry-standard address is a fixed-width, zero-padded hierarchy of roughly Zone-Aisle-Bay(Section)-Level-Position, with odd bays on one side of the aisle and even on the other, levels counted from the floor up, and positions left to right. Location labels are almost always Code 128 (QR only where space is tight), black on white/yellow, often with a check digit used to confirm the picker is at the right slot.

### Cited Findings
- Hierarchy example: Aisle-Section-Level-Position, e.g. "01-01-1-1" = left position on level 1 of the first bay in aisle 01; every location should identify aisle, section (bay), level and position; a section is the space between uprights — [We Are The Practitioners: Location Numbering](https://www.wearethepractitioners.com/index.php/topics/warehouse-operations/functions-terms/location-numbering-warehouses)
- Same source: number aisles (not rack rows) ascending from 01 from one end of the building, use a separate aisle sequence per work area (repack, pallet rack, floor stack), plan for two- or three-digit aisle numbers for growth — [We Are The Practitioners](https://www.wearethepractitioners.com/index.php/topics/warehouse-operations/functions-terms/location-numbering-warehouses)
- Odd-numbered sections on the left side of the aisle and even on the right when facing the back of the building; sections numbered from 01 starting at the entry end near receiving — [We Are The Practitioners](https://www.wearethepractitioners.com/index.php/topics/warehouse-operations/functions-terms/location-numbering-warehouses)
- Levels start at floor = level 1 and go up; positions numbered left to right facing the section; pallet rack typically has 2 positions per level; hand-stack (shelving) rack usually has 4-8 locations per level; small-item drawers can use a 9x9 row/column grid; bulk floor storage gets one section number per pallet row facing the aisle — [We Are The Practitioners](https://www.wearethepractitioners.com/index.php/topics/warehouse-operations/functions-terms/location-numbering-warehouses)
- That author argues against alphabetic characters in location codes (letters acceptable only for elements with five or six options such as levels or building areas, not aisles) and recommends "Never place more than one SKU in a location at one time" — [We Are The Practitioners](https://www.wearethepractitioners.com/index.php/topics/warehouse-operations/functions-terms/location-numbering-warehouses). Contrasting view: Warehance recommends letters for zones and aisles, numbers for bay/level/position, format "Zone-Aisle-Bay-Level-Position" (e.g. A-A-01-01-01) — [Warehance blog](https://warehance.com/blog/smart-warehouse-setup-zoning-and-location-naming-that-works)
- Always zero-pad (01 not 1) so the WMS sorts locations in physical order; leave room to expand by starting numbering mid-range (e.g. Aisle F, Bay 10) so you can grow either direction — [Warehance blog](https://warehance.com/blog/smart-warehouse-setup-zoning-and-location-naming-that-works). Do not mix formats like A-1-1 and A-01-01 — [Cleverence warehouse name list](https://www.cleverence.com/articles/for-business/warehouse-name-list-4827/)
- Serpentine: walk up one aisle, cross, walk back down the next; alternate bay numbering by aisle (one aisle bays 1-4, next aisle 4-1) so a sort by location code produces a continuous route without backtracking — [Warehance blog](https://warehance.com/blog/smart-warehouse-setup-zoning-and-location-naming-that-works). Vendor guidance says experts "generally recommend" serpentine labeling to reduce walking — [Cleverence aisle numbering](https://www.cleverence.com/amp/articles/for-business/warehouse-aisle-numbering-4827/)
- SAP EWM: a bin's address is a "coordinate" (e.g. 01-02-03 = aisle 01, stack 02, level 03), up to 18 characters, unique within the warehouse; bins are generated from Customizing "templates" after defining the coding of aisle/stack/level/subdivision/depth — [SAP Learning: Creating Storage Bins](https://learning.sap.com/courses/basic-customizing-in-sap-s-4hana-ewm/creating-storage-bins); [SAP Learning: Outlining Warehouse Structures](https://learning.sap.com/courses/processes-in-sap-s-4hana-ewm/outlining-warehouse-structures)
- Skustack (Sellercloud) Visualize terms: Floor, Area (zone), Aisle, Rack, Bay, Bin (smallest unit), plus Level, Column, Row and "Group" for bins with no shelving system; its configurator auto-detects existing bin-name patterns and lets the user map name segments to hierarchy terms — [Sellercloud LMS: Visualize Module Workflow](https://lms.sellercloud.com/courses/skustack-and-skustack-lens/lessons/visualize-module-workflow/)
- OpenBoxes (open source) hierarchy: Depot > Zone locations > Bin Location Types > Bin locations; a bin "designates a particular shelf, pallet position, or bin" within a depot — [OpenBoxes: Managing Bin and Zone Locations](https://openboxes.helpscoutdocs.com/article/289-managing-bin-and-zone-locations)
- Barcode symbology: Code 128 is the usual choice for location labels; Code 39 for legacy; QR codes in tight shelf spaces; GS1-128 users should keep location identifiers in a separate namespace from item/lot/serial data — [Cleverence rack numbering](https://www.cleverence.com/articles/for-business/warehouse-rack-numbering-system-4827/); free Code 128 rack-beam label template — [Cleverence label template](https://www.cleverence.com/label/templates/gallery-warehouse-rack-beam-location)
- Check digits: a Mod10/weighted-sum check digit reduces keying and wrong-slot errors; the scanner/app can prompt for it to confirm the worker is at the correct bay and level — [Cleverence rack numbering](https://www.cleverence.com/articles/for-business/warehouse-rack-numbering-system-4827/)
- Label placement: overhead beam labels can be retroreflective and scan from 15-30 ft with long-range scanners; stagger barcodes on upright/summary labels so a scanner doesn't read the wrong one; directional arrows distinguish the level above from below — [Cleverence rack numbering](https://www.cleverence.com/articles/for-business/warehouse-rack-numbering-system-4827/); [Interlake Mecalux rack labels](https://www.interlakemecalux.com/blog/rack-labels-warehouse)
- Use only black on white or black on yellow labels; add end-of-aisle markers that extend into cross aisles; choose adhesive for environment — [We Are The Practitioners](https://www.wearethepractitioners.com/index.php/topics/warehouse-operations/functions-terms/location-numbering-warehouses)

### Inferences
- For Freeze Pipe (one small building, mostly shelving), a code like `A-03-2-B` or `01-03-02-02` (aisle-bay-level-position) is enough; "site" and "zone" can live as attributes/parent rows rather than characters in the printed code. Keep the printed code short so it's readable on a phone and on a 1x3" or 2x1" shelf label.
- Recommend a separate immutable `location_code` (human, printed) and `barcode_value` (what's encoded; can add a prefix like `L:` so the scanner app can distinguish location scans from SKU/UPC/carton scans without a lookup). The prefix approach is analogous to the "separate namespace" guidance for GS1-128.
- Decide early between sequential bay numbering + a separate `pick_sequence` integer (decouples route from naming; easiest to change later) vs. serpentine-encoded bay numbers (route = alphabetical sort). For a custom ERP the `pick_sequence` column is more flexible; a re-layout only rewrites integers, not labels.
- Glass products are fragile and SKUs are visually similar (colors/variants of the same glass piece), which argues for one SKU per pick face where possible and a check-digit or scan-confirm step.

### Gaps
- No authoritative standard (e.g., GS1 or MHI) prescribing location-code format was found; conventions are vendor/consultant guidance. GS1 location guidance for internal bins (vs. GLN for sites) was not researched.
- No primary source found specifying the exact check-digit algorithm warehouses use for spoken/visual location check digits (voice picking typically uses random 2-3 digit "check strings," but this was not confirmed in this research).

## 2. License plates (LPN), master cartons, case break, mixed-SKU bins, lots, reserve vs. forward pick and min/max replenishment

### Takeaway
WMS products treat a pallet or carton as a container with its own ID (license plate number) that carries SKU, quantity, lot and current location; inventory moves by moving the LPN. Master cartons live in reserve (bulk) locations and are "broken" to feed forward each-pick faces, replenished by min/max triggers that should move whole cartons and fill the face to its max.

### Cited Findings
- A WMS gives each pallet a license plate number that ties SKU, lot, expiration and location to that pallet, and enables blocking transactions (e.g., picking from a pallet on hold) — [Racklify: pallet management and license plates](https://racklify.com/encyclopedia/wms-and-erp-pallet-management-tracking-license-plates-and-tier-locations/)
- Case-level picking pulls the intact master case; "breaking bulk" opens it and picks less than full; most operations use both: full master cases from reserve for wholesale/high-volume, broken cases feeding forward pick locations — [Racklify: case-level picking vs breaking bulk](https://racklify.com/encyclopedia/case-level-picking-vs-breaking-bulk-warehouse-strategies-for-master-carton-handling/)
- Min/max: the minimum is the threshold that creates a replenishment task; the quantity moved from storage should fill the forward location to its maximum; replenishment should match the pick face's unit of measure (split-case faces replenished with full cases); example of an 8-case pick face fed from 72-case reserve pallets — [Racklify reserve storage](https://racklify.com/encyclopedia/reserve-storage-location-definition-and-role-in-fulfillment/); [Softeon glossary: replenishment](https://www.softeon.com/glossary/replenishment/)
- Infor WMS pick-location setup: mandatory capacity field, min and max per SKU-location, a "minimum replenishment UOM" that can require a full case/pallet before dispatching a task, replenishment priority 1 (highest) to 9 (lowest) — [Infor WMS: Assigning pick location maximums and minimums](https://docs.infor.com/wms/2026.x/en-us/useradminlib/scereplenug/jhl1612893973659.html)
- In LPN-enabled systems (e.g., Dynamics 365 via Tasklet Factory mobile), when items use license plates the picker must specify the license plate during picking — [Tasklet Factory: Pick from License Plates](https://taskletfactory.atlassian.net/wiki/x/qJe0B)
- OpenBoxes inventory reports are per product per bin per lot: bin location, lot number, expiration date, quantity on hand, quantity available — [OpenBoxes Inventory Reports](https://openboxes.helpscoutdocs.com/article/310-inventory-reports)
- OpenBoxes "hold bins" (a bin location type with the "Hold stock" activity): stock in a hold bin is not available to be picked — i.e., quarantine is modeled as a location type/flag, not a separate inventory status table — [OpenBoxes: Creating Hold Bins](https://openboxes.helpscoutdocs.com/article/67-creating-hold-bins)
- Odoo models containers as "Packages" with package types; storage capacity checks can be based on package types, and putaway rules can match on product, product category and/or package type — [Odoo 16 docs: Storage categories](https://www.odoo.com/documentation/16.0/applications/inventory_and_mrp/inventory/shipping_receiving/daily_operations/storage_category.html); [Odoo 16 putaway docs mirror](https://cdn.odooapp.cn/documentation/16.0/zh_CN/applications/inventory_and_mrp/inventory/routes/strategies/putaway.html)
- Forward-reserve literature: the quantities stored forward determine the labor required to keep the forward area supplied (restocks); the problem has two decisions: which SKUs go forward (assignment) and how much space each gets (allocation) — [Bartholdi & Hackman 2008, IIE Transactions](https://www2.isye.gatech.edu/~jjb/papers/2008_IIE_Bartholdi_Hackman.pdf); [Subramanian thesis, Georgia Tech](https://repository.gatech.edu/entities/publication/258c0f9e-6213-4f9c-97fb-d15d01a42c80)
- Forward areas are most suitable for small-parts warehouses (pharma, cosmetics, footwear, office supplies) because items are small enough to store in sufficient quantity in a limited area — [Walter, Boysen & Scholl 2013, EJOR (via IDEAS)](https://ideas.repec.org/a/eee/ejores/v229y2013i3p585-594.html)

### Inferences
- Freeze Pipe's existing carton-native receiving maps naturally to LPNs: each received master carton (from freight_carton_groups/freight_receipts) should get a `container` row (type = master_carton, barcode = printed LPN label or factory carton mark) with its contents (sku, qty, lot = PO/shipment) and a current `location_id`. Putaway = scan LPN, scan location.
- Model "case break" as an explicit movement: decrement the carton container's content, increment loose (container_id NULL) balance at the forward pick bin. When a carton hits zero, mark it consumed/closed. This keeps carton-level traceability back to the freight receipt.
- Mixed-SKU cartons (factories sometimes pack assortments) are naturally supported if `container_contents` is a child table (container_id, sku_id, qty) rather than sku/qty columns on the container.
- Min/max for a small DTC shop: store `min_qty`, `max_qty`, and `replen_uom` (each/inner/master carton) on a `sku_location_assignment` (fixed pick face) row; a nightly or on-pick RPC creates replenishment tasks "move N cartons from reserve LPNs (FIFO by receipt date) to face." Enterprise features like priority 1-9 and demand-based dynamic replen are optional.
- Lots: for glass accessories lot/expiry is likely not regulatory, but tracking `receipt_id`/PO as a pseudo-lot gives FIFO and defect traceability by factory batch at near-zero cost.

### Gaps
- Packiyo's own docs/schema on LPNs and locations were not found via search (only a third-party changelog mentioning Packiyo warehouse mapping: [Endless Commerce changelog](https://endlesscommerce.com/changelog/2026-08-21-packiyo-warehouse-mapping)). Packiyo is open-source-adjacent (Laravel) on GitHub; schema not verified here.
- The exact Bartholdi optimal-allocation formula could not be extracted (PDF text not machine-readable via fetch). From the researcher's background knowledge (unverified in this session): Warehouse & Distribution Science shows optimal forward space allocation is proportional to the square root of each SKU's flow, and equal-space and equal-time allocations produce the same total restocks; a summary found here states equal space is "equivalent to" equal time and optimal allocation cut restocks ~3-6% vs. those in their study — [summary via Walter et al./related](https://ideas.repec.org/a/eee/ejores/v229y2013i3p585-594.html). Report-writer should treat the sqrt rule as needing confirmation from the book PDF ([wh-sci-0.97](https://www2.isye.gatech.edu/~jjb/wh/book/editions/wh-sci-0.97.pdf)).

## 3. Location attributes: dimensions, capacity, pick sequence, location type, ABC class; how pick sequence drives routing

### Takeaway
Real WMS location masters carry type/category, dimensions and capacity (often by package type), a pick sequence or XYZ coordinates used for travel/route calculation, and flags such as hold/quarantine. For a small warehouse, a single integer `pick_sequence` sorted ascending (serpentine path) is the practical routing mechanism; XYZ-based distance routing is optional.

### Cited Findings
- SAP EWM: you specify which coordinate axis corresponds to aisle or stack so the system can compute "next aisle/next stack"; Graphical Warehouse Layout (GWL) is a 2D view; travel distance calculation is based on bin coordinates; XYZ layout coordinates are separate fields from aisle/stack/level and can be added to existing bins or supplied in the bin-creation input file; bin dimensions defined per storage bin type; GWL length unit = warehouse length unit from Customizing — [SAP Learning: Creating Storage Bins](https://learning.sap.com/courses/basic-customizing-in-sap-s-4hana-ewm/creating-storage-bins); [SAP Community: Graphical Warehouse Layout in SAP EWM](https://groups.community.sap.com/t5/supply-chain-management-blogs-by-members/graphical-warehouse-layout-in-sap-ewm/bc-p/13563953)
- Odoo: "Storage Categories" group locations and act as an extra attribute on putaway rules; capacity checks by package type; putaway rules evaluated sequentially until a match — [Cybrosys: storage categories in Odoo 18](https://www.cybrosys.com/blog/how-to-manage-storage-categories-and-locations-in-odoo-18); [Odoo 16 docs: Storage categories](https://www.odoo.com/documentation/16.0/applications/inventory_and_mrp/inventory/shipping_receiving/daily_operations/storage_category.html)
- Infor: capacity is a mandatory field on pick locations — [Infor WMS min/max](https://docs.infor.com/wms/2026.x/en-us/useradminlib/scereplenug/jhl1612893973659.html)
- Location types seen in practice: pickable bins vs overstock (Warehance); hold/quarantine bins (OpenBoxes); typical small-warehouse zones are Picking & Packing, Receiving (inbound), Overstock, with overstock accessible from both receiving and picking — [Warehance blog](https://warehance.com/blog/smart-warehouse-setup-zoning-and-location-naming-that-works); [OpenBoxes hold bins](https://openboxes.helpscoutdocs.com/article/67-creating-hold-bins)
- Pick path sequencing by location order: InventoryPro's warehouse map offers "automatic pick path sequencing" with up to 50 zones; Skustack's planner numbers picked-item locations in each employee's assigned color — [CISS InventoryPro warehouse map](https://cissltd.com/docs/utilities/warehouse-map/); [Sellercloud Visualize](https://lms.sellercloud.com/courses/skustack-and-skustack-lens/lessons/visualize-module-workflow/)
- Skustack bin cards show name, products and quantities, item images and a capacity progress bar — [Sellercloud Visualize](https://lms.sellercloud.com/courses/skustack-and-skustack-lens/lessons/visualize-module-workflow/)
- ABC classes: one common split is A = top 20%, B = next 30%, C = remaining 50% by lines picked, with A closest to dispatch; ABC can also be by revenue or margin — [Cleverence inventory slotting](https://www.cleverence.com/articles/for-business/inventory-slotting-7463/)

### Inferences
- Suggested `locations` columns: `id, parent_id, path (ltree), code, barcode_value, kind (site|zone|aisle|rack|bay|level|bin), location_type (pick_face|reserve|staging_inbound|pack_station|outbound_staging|returns|quarantine|damaged|virtual_in_transit), is_pickable, is_sellable, pick_sequence int, zone, aisle, bay, level, position, width_mm, depth_mm, height_mm, max_weight_g, max_units (nullable), max_containers (nullable), velocity_class (A/B/C, nullable, usually derived), golden_zone bool (derived from level height), x_mm, y_mm, z_mm, rot_deg, template_id, active, notes`.
- `is_sellable=false` on quarantine/damaged/returns-unprocessed lets the ATP (available-to-promise) query exclude them in one predicate — mirrors OpenBoxes hold-bin semantics.
- Routing for one small warehouse: order the pick list by `pick_sequence` (serpentine). This is the S-shape heuristic; true shortest-path (TSP) routing is an enterprise optimization with little gain at this size.
- Capacity: track at least `max_containers` for reserve shelves (cartons per shelf) and `max_units` per SKU-assignment for pick faces; cubic capacity math requires product dims (verify product master has L/W/H/weight) and is optional for v1.

### Gaps
- Manhattan, Blue Yonder, Deposco, Logiwa, Hopstack location-master field lists were not found in public docs via search (mostly gated). Field lists above come from SAP, Odoo, Infor, OpenBoxes, and Skustack.

## 4. Inventory-at-location data model patterns in Postgres (locations, balances, ledger, reservations, cycle counts, ltree, 3D coordinates)

### Takeaway
The consensus pattern is an append-only movement ledger as source of truth plus a maintained balance table keyed by (sku, location, container/lot) with on_hand / allocated / available, updated atomically in the same transaction. Postgres `ltree` (GiST-indexed) or a simple parent_id + materialized path handles the location hierarchy; 3D coordinates are separate numeric fields from the logical address (as SAP does).

### Cited Findings
- Store both the transaction ledger and a derived on-hand table; the ledger is the immutable ground truth, the on-hand table accelerates reads; maintain atomically via triggers/stored procedures/app services to avoid divergence — [Cleverence: inventory control database schema](https://www.cleverence.com/amp/articles/for-business/inventory-control-database-schema-4721/)
- Balance table keyed by item_id, location_id, lot_id (nullable), optional serial; track on_hand, allocated, available — [Cleverence: how to create an inventory database in SQL](https://www.cleverence.com/articles/for-business/how-to-create-an-inventory-database-in-sql-4732/)
- Transfers as paired rows (negative at source, positive at destination) under one reference; available quantity anywhere = algebraic sum — [Data model and querying inventory status with stock movement](https://answer.demo.spiceai.io/questions/10010000000034685)
- Physical counts recorded as an adjustment equal to (counted - system), not overwriting history — [Access Programmers forum: Basic Inventory](https://www.access-programmers.co.uk/forums/goto/post?id=1797184)
- Use DECIMAL/NUMERIC for quantities, not floats; materialized views for item-location balances are a common read-side denormalization — [Cleverence inventory database](https://www.cleverence.com/amp/articles/for-business/inventory-database-4827/)
- ltree: dot-separated labels (alphanumeric + underscore, max 255 chars per label per Neon docs); operators `@>` / `<@` (ancestor/descendant), `~` lquery match; functions `nlevel()`, `subpath()`, `lca()`; GiST index for ancestor/descendant, B-tree for equality — [Neon docs: ltree](https://neon.com/docs/extensions/ltree); [PostgreSQL docs: ltree](https://www.postgresql.org/docs/current/ltree.html)
- SAP EWM keeps XYZ layout coordinates as separate fields from aisle/stack/level and uses them for GWL rendering and travel distance — [SAP Community GWL blog](https://groups.community.sap.com/t5/supply-chain-management-blogs-by-members/graphical-warehouse-layout-in-sap-ewm/bc-p/13563953)
- Bartholdi's heat-map tool needs only a unique text address per rack section and a CSV of (address, value); matching is case-sensitive and duplicates/unknown addresses are flagged — i.e., a stable address key is the join point for all visualization — [Warehouse Science: heat map tool](https://www.warehouse-science.com/apps/heatmap/index.html)

### Inferences
Suggested Supabase schema sketch (v1, single site; enterprise extras marked optional):

```
warehouse_layouts(id, name, version, width_mm, depth_mm, published_at)          -- optional versioning for re-layouts
rack_templates(id, name, kind(shelving|pallet_rack|floor|bin_wall|cart),
               bays int, levels int, positions_per_level int,
               bay_width_mm, depth_mm, level_heights_mm int[], default_location_type)
racks(id, layout_id, template_id, code, aisle, side(L|R), x_mm, y_mm, rot_deg, first_bay_no, bay_direction(+1|-1))
locations(id, parent_id, path ltree, kind, code unique, barcode_value unique, location_type,
          is_pickable, is_sellable, pick_sequence, rack_id, bay, level, position,
          x_mm, y_mm, z_mm, width_mm, depth_mm, height_mm, max_weight_g, max_containers,
          velocity_class, active)                                           -- GiST index on path
containers(id, lpn unique, type(master_carton|inner|tote|pallet), parent_container_id null,
           location_id, status(open|sealed|consumed|shipped), freight_receipt_id, freight_carton_group_id,
           created_at)
container_contents(container_id, sku_id, lot_id null, qty numeric)        -- supports mixed-SKU cartons
inventory_balances(sku_id, location_id, container_id null, lot_id null,
                   on_hand numeric, allocated numeric, available generated (on_hand - allocated),
                   unique(sku_id, location_id, coalesce(container_id), coalesce(lot_id)))
inventory_movements(id, movement_group_id, ts, user_id, type(receive|putaway|move|case_break|pick|pack|
                    ship|adjust|count|replenish|return), sku_id, qty_delta, location_id, container_id, lot_id,
                    ref_type, ref_id (order/shipment/receipt/count), device_id)   -- append-only, RLS insert-only
sku_location_assignments(sku_id, location_id, role(primary_pick|secondary_pick), min_qty, max_qty,
                         replen_uom, active)                                -- fixed pick faces
allocations(id, order_line_id, sku_id, location_id, container_id null, qty, status(soft|hard|picked|released))
pick_tasks / pick_lists(order_id or batch_id, location_id, sku_id, qty, sequence, status)
cycle_counts(id, scope (location set / sku set / ABC class), status, assigned_to)
cycle_count_lines(count_id, location_id, sku_id, container_id, expected_qty, counted_qty, variance, posted_movement_id)
```

- All quantity-changing writes go through `SECURITY DEFINER` RPCs (e.g., `rpc_move_inventory`, `rpc_case_break`, `rpc_confirm_pick`) that insert ledger rows and upsert balances in one transaction with `SELECT ... FOR UPDATE` on the balance row; this matches the ledger+balance consensus and Supabase's RPC pattern already used in the ERP. Use NUMERIC or integer (units are discrete; integer is fine for glass items).
- Reconcile with ShipStation: ShipStation remains the label/shipping system; the ERP owns location-level allocation and picking, and posts a `ship` movement on ShipStation shipment webhook/poll.
- ltree vs parent_id: for a few thousand locations, `parent_id` + a generated `code` is sufficient; ltree is cheap to add and makes "everything in aisle 03" or "all bins in rack R2" a single indexed predicate (`path <@ 'wh.a03'`). ltree labels can't contain hyphens, so the path should use underscores/dots (e.g., `fp.z_main.a03.b02.l2.p1`) separate from the printed code.
- Store coordinates in millimeters as integers at the rack level (origin = rack's front-left-floor corner, rotation) and derive bin-level boxes from the template; persist computed bin x/y/z too so the renderer and route calculations don't need template math.
- Cycle counting: ABC-driven frequency (A monthly, C quarterly) and "count on empty / count on zero-pick" triggers are cheap wins; posting a count creates an `adjust` movement for the variance (consistent with the adjustment-row finding).

### Gaps
- No authoritative PostgreSQL/Supabase-specific benchmark or reference schema for WMS ledgers was found; sources are vendor blogs and forums. OpenBoxes and Packiyo schemas on GitHub were not inspected in this session.
- Reservation semantics (soft vs. hard allocation at location level vs. SKU level) were not sourced from a primary vendor doc; above is design inference.

## 5. Slotting basics: velocity, affinity, size, golden zone, re-slotting

### Takeaway
Slotting combines velocity (picks/lines per period, ABC), cube (cube-per-order index), ergonomics (golden zone = waist-to-shoulder height near pack-out), and order affinity, and is reviewed periodically using 6-12 months of order lines. Commercial tools surface this via heatmaps overlaid on the layout.

### Cited Findings
- Rank SKUs by lines per period and put the hottest items in golden zones close to docks at waist-to-shoulder height; fast movers also drive replenishment effort — [Cleverence inventory slotting](https://www.cleverence.com/articles/for-business/inventory-slotting-7463/)
- Golden zone = ergonomic height where pickers retrieve items with minimal bending or stretching — [CLTD Top 20 Concepts: Slotting Strategy (PDF)](https://pages.fhyzics.net/hubfs/CLTD-Top-20-Concepts-Slotting%20Strategy.pdf?hsLang=en)
- Cube-per-order index (COI) balances cube against demand; a small ultra-fast item can beat a large moderately fast one for a premium slot; lower COI => closer slot — [Cleverence](https://www.cleverence.com/articles/for-business/inventory-slotting-7463/); [MetricGate warehouse slotting optimization](https://metricgate.com/docs/warehouse-slotting-optimization/)
- Affinity: co-locate items often ordered together; matters most for B/C items; over-grouping can spike replenishment in one zone or make similar variants easy to confuse — [Cleverence what is slotting](https://www.cleverence.com/articles/for-business/what-is-slotting-in-a-warehouse-5927/)
- Re-slotting: XYZ classification (demand variability) informs how often to re-slot; periodic re-slotting captures seasonality/lifecycle; use 6-12 months of order-line history — [Cleverence](https://www.cleverence.com/articles/for-business/inventory-slotting-7463/); [MetricGate](https://metricgate.com/docs/warehouse-slotting-optimization/)
- Small-warehouse placement: fastest movers near the start of the picking area, larger bins for high-volume items (less replenishment), slow movers farther away or on higher shelves; size the pickable area by SKU profile — [Warehance blog](https://warehance.com/blog/smart-warehouse-setup-zoning-and-location-naming-that-works)
- Mecalux's "Slotting for WMS" module (Easy WMS) provides a heatmap color overlay on the warehouse layout showing intensity/frequency of processes, filterable by operation type (picking, replenishment, shipping), identifying hot/cold zones and slotting inefficiencies — [Mecalux: heatmap slotting](https://www.mecalux.com/software/updates/heatmap-slotting)

### Inferences
- For Freeze Pipe, a v1 slotting assistant can be a SQL view: picks per SKU over last 90/180 days (from ShipStation/ERP order lines) -> ABC class -> suggested level (golden zone levels flagged on the location) -> list of "A SKUs not in golden zone" and "C SKUs occupying golden zone." Re-slot is then a guided "move" task pair in the mobile app (move from old face to new face, update `sku_location_assignments`).
- Affinity matters for bundles/kits (e.g., a piece + its accessory); a simple co-occurrence count from order lines is enough to suggest adjacent faces.
- Fragility/weight constraints (glass on lower/stable shelves, heavy cartons low) should be a hard rule in suggestions, not just a score.

### Gaps
- No vendor-neutral quantitative benchmark found for travel savings from slotting at small-warehouse scale; most sources are consultant/vendor blogs.

## 6. 3D / 2.5D / 2D rendering options for a React 18 + Vite app

### Takeaway
three.js via react-three-fiber (+ drei) is the most natural fit for a React app and handles thousands of bins via InstancedMesh with per-instance click (instanceId) and per-instance color (heatmaps). Critical version constraint: current R3F v9 / drei v10 / react-konva 19 / @pixi/react 8 all require React 19; on React 18 the ERP must pin R3F 8.18.0 + drei 9.122.0 (last React-18 releases, Feb 2025) or upgrade React. A 2D top-down + rack-elevation view (SVG or Konva) is cheaper, more usable on phones, and is what most commercial WMS actually ship.

### Cited Findings
- Current versions (npm registry, queried 2026-10-19): three 0.186.1 (published 2026-09-24); @react-three/fiber 9.8.2 with peer `react >=19 <19.4`; @react-three/drei 10.7.9 with peer `react ^19`, `@react-three/fiber ^9`; konva 10.9.0; react-konva 19.3.2 with peer `react ^19.3.0`; pixi.js 8.22.0; @pixi/react 8.0.5 with peer `react >=19`; @babylonjs/core 9.31.0; @three.ez/instanced-mesh 0.3.16 — [npm registry: three](https://registry.npmjs.org/three/latest); [@react-three/fiber](https://registry.npmjs.org/@react-three/fiber/latest); [@react-three/drei](https://registry.npmjs.org/@react-three/drei/latest); [react-konva](https://registry.npmjs.org/react-konva/latest); [@pixi/react](https://registry.npmjs.org/@pixi/react/latest); [pixi.js](https://registry.npmjs.org/pixi.js/latest); [@babylonjs/core](https://registry.npmjs.org/@babylonjs/core/latest)
- React-18-compatible lines: @react-three/fiber 8.18.0 (peer `react >=18 <19`, published 2025-02-19); @react-three/drei 9.122.0 (peer `react ^18`, `fiber ^8`, published 2025-02-19); react-konva 18.2.16 (peer `react >=18`); @pixi/react 7.1.2 (React >=17, Pixi v6/v7 packages, not Pixi v8) — [npm registry: @react-three/fiber](https://registry.npmjs.org/@react-three/fiber); [@react-three/drei](https://registry.npmjs.org/@react-three/drei); [react-konva](https://registry.npmjs.org/react-konva); [@pixi/react](https://registry.npmjs.org/@pixi/react)
- R3F docs list the pairings React 18 -> @react-three/fiber@8 and React 19 -> @react-three/fiber@9; v9 migration guide covers React 19 changes — [R3F v9 Migration Guide](https://r3f.docs.pmnd.rs/tutorials/v9-migration-guide); [R3F llms.txt index](https://r3f.docs.pmnd.rs/llms.txt)
- R3F dist-tags show 10.0.0-alpha.6 / canary (WebGPU-focused per a third-party page) — not for production — [npm registry dist-tags](https://registry.npmjs.org/@react-three/fiber); [skills.sh R3F page](https://skills.sh/anthemflynn/ccmp/react-three-fiber)
- InstancedMesh picking: raycast hits include `instanceId`; after `setColorAt` you must set `instanceColor.needsUpdate = true`; don't raycast on every mousemove (flag + raycast in render loop); compute pointer coords from `getBoundingClientRect()` when the canvas isn't full-viewport — [three.js forum: change color of instance on raycast](https://discourse.threejs.org/t/change-color-of-instance-mesh-index-on-raycast/38136.md); [threejs raycaster skill notes](https://skillselion.com/skills/openaec-foundation/three.js-claude-skill-package/threejs-core-raycaster); [three.js forum: how to select InstancedMesh](https://discourse.threejs.org/t/how-to-select-object-instancedmesh/66572)
- InstancedMesh2 (@three.ez/instanced-mesh) adds BVH-accelerated raycasting and per-instance frustum culling for large counts; BatchedMesh is an alternative — [@three.ez/instanced-mesh docs](https://docsearch.algolia.com/mcp/docs/repo/agargaro/instanced-mesh); [three.js forum: many objects low fps](https://discourse.threejs.org/t/many-objects-caused-low-fps-can-we-optimize-it-without-losing-control-over-individual-mesh/76837)
- drei includes an HDRI environment preset named "warehouse" (lighting only) — [skills.sh R3F page](https://skills.sh/anthemflynn/ccmp/react-three-fiber)
- Konva performance: each layer is a separate canvas (2 canvases each, ~41 MB on a 1920x1080 retina stage before drawing), Konva warns above 5 layers; use `listening(false)` on non-interactive shapes/layers, `shape.cache()`, `perfectDrawEnabled(false)`, hide off-screen nodes with `visible(false)` (skips draw and hit test); for tens of thousands of nodes a single custom `sceneFunc` is faster but loses per-item events; Mobile Safari has a hard canvas memory limit beyond which the canvas goes blank; `Konva.pixelRatio = 1` reduces memory — [Konva: All Performance Tips](https://konvajs.org/docs/performance/All_Performance_Tips.html)
- react-konva size: ~122.8 KB minified / 38.4 KB gzipped (v19.2.3, DepScope) — [DepScope react-konva](https://depscope.dev/pkg/npm/react-konva)
- Open-source example: Breta01/virtual-warehouse — desktop app with 2D top-down and 3D views, side view of vertical levels for a hovered location, 2D heatmap of order frequency (Viridis scale, "all levels" vs "separate level"), sidebar of Locations/Items/Orders with search — [virtual-warehouse docs](https://virtual-warehouse.readthedocs.io/en/latest/user_guide/user_interface.html)
- Indoor-map approach: Mappedin renders facility digital twins with deck.gl heatmap layers fed by WMS data — [Mappedin blog](https://mappedin.com/resources/blog/visualizing-warehouse-operations-with-indoor-maps)
- Bartholdi's heat-map tool shows the "2D map in a spreadsheet grid + CSV metric" approach is enough for pick-frequency, restock frequency, product age and travel-distance visualizations; showing all rack levels reveals how high picks occur — [Warehouse Science heat map](https://www.warehouse-science.com/apps/heatmap/index.html)

### Inferences
- Comparison for this ERP (inference, sizes approximate from general knowledge unless cited):
  - R3F 8 + drei 9 + three: best React ergonomics, declarative scene from Supabase rows, `<Instances>`/InstancedMesh for bins, `onClick` returns `instanceId`, `<Html>` for labels, `<Line>` for pick routes, OrbitControls/MapControls. three.js core adds a few hundred KB minified to the bundle (lazy-load the map route via `React.lazy` so the rest of the ERP isn't affected). Main risk is pinning to the React-18 line (no new features since Feb 2025) — consider whether a React 19 upgrade is planned.
  - Babylon.js 9: full engine with built-in GUI/inspector, but heavier and less idiomatic in React (react-babylonjs wrapper); not recommended unless the team already knows it.
  - Konva/react-konva (2D/isometric): ~38 KB gzipped, excellent hit detection and drag-and-drop (good for an in-app layout editor and drag-to-reslot), very good on phones if layers are few. Isometric look can be faked with transforms.
  - PixiJS 8: fastest 2D WebGL for very large sprite counts, but @pixi/react 8 needs React 19; overkill for a few thousand bins.
  - Plain SVG + React: zero dependency, perfect for a rack-elevation view (bays x levels grid) and a top-down floor plan with a few hundred racks; trivially accessible, printable, and tappable on mobile. Heatmap = fill color; route = `<polyline>`.
- Recommended architecture: one data model (racks + derived bin boxes in mm), two or three renderers: (a) top-down 2D floor plan (SVG or Konva) as the default and for the layout editor and mobile pick guidance; (b) rack elevation (SVG) when a rack is tapped, showing levels x positions with contents; (c) optional 3D "showcase/overview" (R3F) lazy-loaded on desktop for the owner's 3D requirement. Mobile pickers rarely benefit from orbiting a 3D scene; a 2D map with the next bin highlighted plus the elevation view is clearer.
- 3D scale for Freeze Pipe: a small warehouse likely has under ~5,000 bins, which is trivial for InstancedMesh (one draw call per material). Per-instance color handles stock-level/pick-frequency heatmaps; route drawing = drei `<Line>` through aisle waypoints ordered by pick_sequence.
- Performance hygiene for phones: `frameloop="demand"` in R3F (render only on change), `dpr={[1, 2]}`, avoid shadows/HDRI on mobile, text via a few `<Html>` labels or a texture atlas rather than thousands of 3D text meshes.

### Gaps
- No current (2026) Bundlephobia gzip numbers were retrieved for three.js 0.186 or pixi.js 8.22; measure with `vite build` + rollup-plugin-visualizer.
- No mature, maintained open-source React/three.js warehouse visualizer specifically for WMS bins was found on GitHub via search; virtual-warehouse (Breta01) is the closest found and is a desktop app (tech stack not confirmed from the page fetched).
- No measured benchmarks for click latency/FPS with thousands of instanced boxes on mid-range Android phones were found.

## 7. How commercial WMS visualize warehouses and what map views actually deliver

### Takeaway
Most commercial WMS map views are 2D (top-down layout with bin drill-in), focused on: search/locate SKU, filled vs. empty/capacity, activity heatmaps for slotting, and numbered pick-path overlays. True 3D is a differentiator for a few (SKUSavvy, Tecsys digital twin) rather than the norm; public documentation for Logiwa, Deposco, Hopstack, Manhattan, Blue Yonder map features was not found.

### Cited Findings
- SAP EWM Graphical Warehouse Layout: 2D layout based on bin XYZ coordinates; coordinates also drive travel distance calculation — [SAP Community GWL blog](https://groups.community.sap.com/t5/supply-chain-management-blogs-by-members/graphical-warehouse-layout-in-sap-ewm/bc-p/13563953); [SAP Learning](https://learning.sap.com/courses/basic-customizing-in-sap-s-4hana-ewm/creating-storage-bins)
- Mecalux Easy WMS "Slotting for WMS" heatmap: color overlay on layout for process intensity/frequency, filter by picking/replenishment/shipping, hot/cold zones; no source confirmed a 3D view or an occupancy-specific mode — [Mecalux heatmap slotting](https://www.mecalux.com/software/updates/heatmap-slotting); Easy Assistant lets you view the warehouse and spatial data used to calculate distances/workflow times — [Mecalux Easy Assistant](https://mecalux.com/software/warehouse-management-system-wms/assistant)
- Tecsys: no-code "digital twin" that automatically maps Elite WMS data to a 3D representation of the warehouse floor (3D heat map) — [Tecsys press release via Seeking Alpha](https://seekingalpha.com/pr/19215146-tecsys-democratizes-digital-twins-in-the-warehouse-with-click-of-a-button-functionality); [MH&L: Digital Twins in the Warehouse](https://www.mhlnews.com/new-products/article/21279269/digital-twins-in-the-warehouse)
- SKUSavvy (small/mid e-commerce WMS): layer-by-layer layout builder positioning each rack, area and bin individually (no templates mentioned), conveyors/packing stations/sorting areas/zones, filled vs. empty bins, traffic heatmaps "for simple slotting efficiencies," 3D heatmaps, "3D visual pick routing," designs "display in 3D on any device" — [SKUSavvy warehouse mapping software](https://www.skusavvy.com/warehouse-mapping-software)
- Skustack Visualize (Sellercloud, premium add-on): 2D grid-based plan (drag hierarchy elements onto a grid sized by width/height), search bins/barcodes/SKUs with highlight and product thumbnails, last 15 picklists with picked locations numbered in each picker's color, empty-bins report by rack, bin cards with contents, images and capacity bar; no 3D described — [Sellercloud LMS Visualize](https://lms.sellercloud.com/courses/skustack-and-skustack-lens/lessons/visualize-module-workflow/)
- CISS InventoryPro warehouse map: up to 50 configurable zones, drag location cards between zones, automatic pick path sequencing — [CISS warehouse map docs](https://cissltd.com/docs/utilities/warehouse-map/)
- Logiwa/Hopstack: only a generic comparison page was found describing both as cloud WMS without map details — [rfp.wiki Hopstack vs Logiwa](https://www.rfp.wiki/supply-chain-logistics-transportation/warehouse-management-systems/hopstack/logiwa)

### Inferences
- The feature set worth copying for Freeze Pipe's v1 map: (1) search SKU/LPN/order -> highlight bins; (2) color modes: occupancy (empty/partial/full vs. capacity), stock level vs. min, pick frequency (last 30/90 days), days-since-last-count; (3) tap bin -> contents card (SKU image, qty, cartons/LPNs, lot/receipt); (4) pick-list overlay with numbered stops in pick_sequence order; (5) drag a SKU from one bin to another in the editor creates a re-slot move task (not an instant data change).
- 3D is a "wow" overview and owner-facing feature; the operational value (pick guidance, putaway, counting) is delivered equally or better by 2D + elevation views, which is what the most comparable small-ecom products (Skustack) ship.

### Gaps
- Logiwa, Deposco, Hopstack, Packiyo, Manhattan Active WM, Blue Yonder map/visualization features could not be verified from public documentation in this session (feature pages not indexed or gated). Report should not claim these vendors have or lack heatmaps/3D without further verification.

## 8. Practical layout digitization for a small warehouse (measure, templates, import, in-app editing)

### Takeaway
The proven path is: measure racks/shelving and aisles once, define reusable rack templates (bays x levels x positions with dimensions), place template instances on a floor plan (grid or coordinates), auto-generate bin codes and labels from the templates, and allow spreadsheet import/export plus in-app edits. SAP's template-based bin generation, Skustack's grid placement and Bartholdi's spreadsheet map all follow this shape.

### Cited Findings
- SAP EWM generates bin master data from templates after defining the coding of the coordinate (aisle/stack/level/subdivision/depth); XYZ coordinates can be supplied in the bin-creation input file — [SAP Learning: Creating Storage Bins](https://learning.sap.com/courses/basic-customizing-in-sap-s-4hana-ewm/creating-storage-bins); [SAP Community GWL blog](https://groups.community.sap.com/t5/supply-chain-management-blogs-by-members/graphical-warehouse-layout-in-sap-ewm/bc-p/13563953)
- Skustack: Configure detects existing bin-name patterns (with % of bins matching each), user maps name segments to hierarchy terms, then places elements on a grid in "Configure Warehouse Plan," with configurable grid width/height and undo — [Sellercloud LMS Visualize](https://lms.sellercloud.com/courses/skustack-and-skustack-lens/lessons/visualize-module-workflow/)
- Bartholdi: draw the layout once in an Excel grid, labeling each rack section with a unique text address; statistics come from a separate CSV — [Warehouse Science heat map](https://www.warehouse-science.com/apps/heatmap/index.html)
- Free bin-location generators exist (e.g., Fulfil's bin location generator) for producing code ranges — [Fulfil bin location generator](https://www.fulfil.io/tools/bin-location-generator/)
- Use a plan drawing of the layout to verify the numbering works and share it with pickers/stockers; separate each location with a divider, bin box, or tape line — [We Are The Practitioners](https://www.wearethepractitioners.com/index.php/topics/warehouse-operations/functions-terms/location-numbering-warehouses)
- SKUSavvy builds layouts "layer by layer," positioning each rack, area and bin individually — [SKUSavvy](https://www.skusavvy.com/warehouse-mapping-software)

### Inferences
- Practical workflow for Freeze Pipe:
  1. Measure: building footprint, each shelving unit (width, depth, upright height, shelf heights), aisle widths, pack stations, receiving/staging areas, door positions. A tape measure + phone photos is enough; record in mm.
  2. Define 2-4 rack templates (e.g., "48in 5-shelf wire shelving, 4 positions/shelf", "pallet rack bay 2 levels x 2 positions", "floor pallet spot", "pack bench"). Template = bays, levels, positions, bay width, depth, level heights, default location type per level (e.g., top level = reserve cartons, levels 2-3 = golden-zone pick faces).
  3. Place instances on a 2D floor-plan editor (snap grid, rotate 0/90/180/270, set aisle + side + bay direction). Generating bins = template x instance; the system computes codes, barcodes, x/y/z boxes and a default serpentine pick_sequence (alternate direction per aisle).
  4. Spreadsheet import/export (CSV of racks and/or bins) for bulk edits and as a backup; validate unique codes and flag unknowns (mirrors Bartholdi's duplicate/unknown checks).
  5. Print labels (Code 128 + human-readable + optional check digit) in rack order; walk the warehouse scanning each label to "verify" the location (also catches mislabeled shelves).
  6. Initial stock load: scan LPN/carton or SKU, scan location, enter qty -> `adjust`/`putaway` movements; then cycle count to validate.
  7. Editing later: layout versioning (draft vs. published) so moving a rack doesn't corrupt history; bins that move keep their id, deactivated bins must be empty.
- Rack templates also make the 3D renderer simple: draw uprights/shelves per template, and bins as instanced boxes.

### Gaps
- No small-warehouse case study with measured time-to-digitize was found.
- Commercial template-based layout editors for SMB WMS (beyond SAP and Skustack) were not documented in sources found.
