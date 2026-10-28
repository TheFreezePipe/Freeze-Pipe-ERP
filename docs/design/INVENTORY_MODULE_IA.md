# One Inventory module: merging Inventory and Warehouse

Date: 2026-10-20, revised 2026-10-21 after owner review (Counts folded into Stock as a view; Floor confirmed as the phone hub beside the Manufacturing Workspace). Applied to the app on branch feat/warehouse-phase0 on 2026-10-21, staging only; production untouched. Research behind it: `docs/research/research_notes/Inventory module IA/` (navigation trees of Odoo, ERPNext, Katana, Cin7, Zoho, ShipHero, Veeqo, NetSuite, Fishbowl, inFlow, Shopify, plus NN/g guidance) and the audit of our own pages.

## The principle

Inventory is one subject with three questions: **what do we have and what is coming**, **where does it physically sit**, and **what does someone do to it today**. The products that feel elegant (Odoo, Cin7 Core, ShipHero, Zoho) answer all three under one word, usually "Inventory", with this second level: an Overview that shows the work waiting, then the work queues, then the stock itself, with setup data under Settings. None keeps a sibling "Warehouse" module that also shows stock. Our Warehouse group is four placeholders and an overview, so the merge costs nothing now and would cost a migration later.

Owner constraints honoured: the module is called **Inventory**; **Materials** (boxes, glycerin, misc) keeps its own section because they are not shippable SKUs; **Shipments** keeps check-in on the shipment page because that is where the team does it; the **Floor** phone surface lives inside the module.

## Proposed sidebar

| Item | Route | Roles | What it is |
|---|---|---|---|
| **Inventory** (group) | | | |
| Overview | `/inventory` | admin, manager | Operation cards with live counts (Arriving this week, On the dock, To put away, Counts due, Variances to approve, Low pick faces, Issues; To pick in Phase 2) above one stock strip (in warehouse by stage, in transit, on order). The daily report already links here. |
| Stock | `/inventory/stock` | admin, manager | Today's Stock Levels page, renamed. Phase 1 adds three views on the same page, kept in the URL: `?view=sku` (table with the SKU drawer), `?view=location` (bins and cartons, face by face), `?view=map` (the floor plan) and `?view=counts` (count tasks, the A/B/C schedule, variances to approve). One page, four ways of looking at the same stock. The Stock Levels edit-mode bulk count becomes a per-SKU "Adjust" action in the SKU drawer, so there is one reason list and one history. Material counts stay on Materials. |
| Factory Orders | `/inventory/factory-orders` | admin, manager | Unchanged. |
| Shipments | `/inventory/shipments` | admin, manager | Today's Shipments page, moved from `/freight`. Shipment detail keeps check-in and gains the carton labels and the putaway queue (Phase 1), so dock-to-shelf is one page. |
| Materials | `/inventory/materials` | admin, manager | Unchanged, its own section. |
| Floor | `/go` | admin, manager, user | The phone home: Put away, Count, Move, Look up, Pick (Phase 2), Manufacture. Floor staff see only this item in the group. |
| Pick & Pack | `/inventory/fulfillment` | admin, manager | Phase 2. The supervisor board. |

Six items now, seven with Pick & Pack, inside the NN/g band for a submenu. Counts is a view of Stock rather than a page because a count is a stock figure with a verification step: the same SKU, bin and carton the other views show, plus "expected vs found" and an approval. A sidebar item of its own would put the same numbers in two places, which is the redundancy this merge removes. The group label stays "Inventory", so nobody's collapsed-sidebar state resets.

**Gone from the sidebar**: the Warehouse group (Overview, Map, Putaway, Counts, Locations). Map and Counts become views of Stock. Putaway becomes a queue on the Overview and on the shipment page, done on the phone. Locations is setup data.

**Settings gains a Warehouse tab** (admin): Locations and racks (the table and the layout editor, which the Map's "Edit layout" button also opens), rack templates, cart definitions, tote classes, scan rules, outbound mode, label printers. This is where every product studied keeps it.

**Economics keeps SKU Costs and Suppliers.** The SKU detail page becomes the SKU hub (below) and Economics links to its Costs tab.

## The SKU hub

The audit's sharpest finding: stock lives in a modal on Stock Levels, costs live on an admin-only page, and nothing shows why a number changed. Proposed, as Phase 1b: `/inventory/skus/:id` with tabs **Stock** (stage buckets, bins and cartons, pick face min/max, forecast), **History** (the ledger slice for that SKU including ShipStation deductions, receipts, counts and moves, readable by managers), **Costs** (today's economics page, admin), **Aliases and recipes**. `/economics/:skuId` redirects to the Costs tab. Stock table rows, Look up results and alerts all land on this page instead of a modal.

## Routes and redirects

Every bookmarked or emailed route keeps resolving.

| Old | New | Note |
|---|---|---|
| `/inventory` | Overview | Daily report link lands on the Overview, whose cards match the email's sections |
| `/inventory` (Stock Levels) | `/inventory/stock` | AlertsPanel's four `/inventory?q=` links become `/inventory/stock?q=`; filters `q`, `category`, `abc`, `archived` unchanged |
| `/freight`, `/freight?filter=` | `/inventory/shipments` | redirect, filter carried |
| `/freight/:id`, `/freight/new` | `/inventory/shipments/:id`, `/inventory/shipments/new` | redirect; fixes the Shipments highlight on detail pages |
| `/warehouse` | `/inventory` | redirect |
| `/warehouse/map` | `/inventory/stock?view=map` | redirect |
| `/warehouse/putaway` | `/inventory/shipments?filter=receiving` | redirect |
| `/warehouse/counts` | `/inventory/stock?view=counts` | redirect |
| `/warehouse/locations` | `/settings?tab=warehouse` | redirect |
| `/inventory/quality-issues` (orphan) | `/inventory/issues`, linked from the Overview "Issues" card | fixes the orphan |
| `/economics/skus/:id` (broken link) | `/inventory/skus/:id` | fixes the bug |

Roles are declared once, in a route table that both the sidebar and the route guards read, instead of twice.

## What each friction becomes

| Friction (audit) | Resolution |
|---|---|
| Three count surfaces | The Counts view of Stock plus a per-SKU Adjust action; Materials keeps its own count because materials are not SKUs |
| Two notions of location | "Stage" for raw, prefilled, in production, finished; "location" only ever means a bin or a site |
| Receiving split across groups | Shipment detail owns check-in, labels and putaway; the Floor does the walking |
| Materials stranded | Its own item, by the owner's call; recipes stay on the SKU hub |
| Duplicated KPIs | The stock strip lives on the Overview; the Dashboard shows one tile that links there |
| No SKU hub | `/inventory/skus/:id` |
| Ledger invisible | The hub's History tab |
| Naming drift | Stock, Shipments, Counts, Materials, Floor; one Overview per group |
| Highlight loss | Redirect `/freight/*` and widen the `end` rule |
| Orphans and bugs | Issues card; the broken Products link; the missing `other` input in edit mode |
| Role asymmetry | Floor staff get Look up, Put away and Count without seeing orders or costs |
| Page weight | Stock's three views split the 1,500-line page by view |

## Sequencing

1. **Now, on the Phase 0 branch, before its commit**: rename and move routes, add the redirects, collapse the two groups into one, build the Overview with the cards the current data already supports (arriving, on the dock, issues) and the stock strip, rename Stock Levels to Stock. About one to two days, no database change.
2. **Phase 1** lands its pages in the merged places: the location, map and counts views on Stock, the putaway queue on the shipment page, the Warehouse tab in Settings, the Floor tasks.
3. **Phase 1b**: the SKU hub and the History tab.
4. **Phase 2**: Pick & Pack joins the group and To pick joins the Overview cards.

## Floor and the Manufacturing Workspace

Floor (`/go`) is the phone home for everyone who works on the floor, and it does not replace the Manufacturing Workspace. The Workspace stays its own page under Manufacturing because its job is different: it logs filling, assembly and QC batches against recipes, which is a manufacturing record, not a stock movement. Floor is the hub that routes a phone to the right task: Put away, Count, Move and Look up open the Inventory tasks, and the Manufacture tile opens the Workspace. A floor user has one landing page and never needs the sidebar. If the Workspace later gets a scan-first mobile layout it can reuse the Floor's scan-sink and card components, but it keeps its own route and its own data.

## Mockups

Every page in the group has a board on the design canvas: https://claude.ai/artifact/Eg5UQZMox6LMyG4CJRdsTm. Row 1: Overview, Stock by SKU, Stock by location, Stock map, rack elevation. Row 2: Factory Orders, Shipments list, one shipment's check-in and putaway, Stock counts, Materials. Row 3: the layout editor under Settings and the phase 2 Pick & Pack board. Row 4: the Floor phone screens. Row 5 (added 2026-10-28, not yet built): Insights, reached from the Overview rather than the sidebar, with Flow (pipeline strip and cumulative flow), Lead time (box plots per leg by supplier and an on-time-in-full scorecard), Loss and ageing (Pareto of loss causes and stock by age bucket), Cover (projected stock against the measured reorder point), and the carton passport (one carton's timeline from factory order to shelf). Proposed build order: Flow and Cover, then Lead time, then Loss and ageing; the passport is nearly free.

## Open questions for the owner

1. Overview cards versus the current Dashboard: the Dashboard keeps company-wide tiles and links to the Inventory Overview for detail, or the Overview replaces the Dashboard's inventory half. Proposed: keep both, with the Dashboard linking.
2. Should managers see the SKU hub's Costs tab? Proposed: no, costs stay admin.
3. Issues: fold breakage and shipment variances into one Issues page, or keep variances on the shipment page. Proposed: one Issues page reached from the Overview card.
