# Warehouse module: UX layout and integration with the ERP

Date: 2026-10-19. Companion to the wireframe canvas (15 artboards) and to the scope report `Warehouse map and pick pack module.md` and the ops audit `Warehouse ops audit.md`. Research behind this layout is in `docs/research/research_notes/Module UX layout/` (visual builders incl. SKUSavvy, mobile pick/pack screen anatomy, desktop WMS information architecture, and the ERP's own UI shell survey).

## 1. Where the module sits

**One new sidebar group, "Warehouse", between Inventory and Economics**, following the existing `navGroups` pattern in `Sidebar.tsx` (collapsible folder, role-filtered, live count badges like the PD review badge). Route root `/warehouse` is added to the sidebar's `end` list so the root link does not stay highlighted on child pages.

| Sidebar item | Route | Roles | Archetype reused |
|---|---|---|---|
| Overview | `/warehouse` | admin, manager | KPI band + cards (FreightDashboard) |
| Map | `/warehouse/map` (`?mode=browse|stock|heat|route`, `?view=plan|elevation`, `?loc=`) | admin, manager | Full-height card shell (InventoryDashboard) + right Sheet (PdCardSheet) |
| Map · Edit layout | `/warehouse/map/edit` | admin | New three-pane editor |
| Rack elevation | `/warehouse/racks/:rackId` | admin, manager | Detail page |
| Pick & Pack | `/warehouse/pick` (tabs: Board, Orders, Carts, Totes, Reports) | admin, manager | Kanban columns (ProductDevelopment) + list tables |
| Putaway | `/warehouse/putaway` | admin, manager | List table; deep-links from Freight detail |
| Counts & Replenish | `/warehouse/counts` (tabs: Variances, Count tasks, Schedule, Replenishment, Moves) | admin, manager | Tabs + tables (Settings archetype) |
| Locations | `/warehouse/locations` | admin, manager | Dense spreadsheet (InventoryDashboard) with inline edit |
| Settings · Warehouse | `/settings` new tab | admin | Settings tabs |

**Floor staff get a separate task-mode shell**, not the sidebar. Role `user` lands on `/go` (the phone home) instead of `/manufacturing/workspace`; the existing Workspace becomes the "Manufacture" tile. Task routes (`/go/pick/*`, `/go/putaway/*`, `/go/count/*`, `/go/move/*`) hide Header and Sidebar below the `md` breakpoint and show a 44 px top bar with exit control, task title and progress. Layout moves from `h-screen` to `h-dvh` with safe-area padding, and the primary action is bottom-anchored.

## 2. The screens, in the order the work flows

### Receiving and putaway (extends Freight, does not replace it)
- `FreightDetail` keeps its manifest. **Check-in now mints one license plate (LPN `C-<shipment>-<nnn>`) per carton and prints the labels** from the dock banner button. The stepper gains "Check in → label cartons" and "Put away" stages. Columns added to the manifest: LPNs and Putaway status chips.
- A **Putaway queue** card lists each LPN with a suggested slot and the reason (same-SKU reserve, nearest empty, mixed carton to the break-down shelf). Re-suggest and reprint are one click.
- **Phone putaway**: scan LPN → "Put it in 90-02-3" hero → scan location to confirm. Alternatives: Suggest another, Scan any location, or "open this carton to the pick face" when the face is below max. Next LPNs are previewed so the receiver can carry two.

### Map
- **Two renderers over one data model**: top-down plan (SVG) is the operational view; rack elevation (levels × bays × positions, NetBox-style) is where stock inside a shelf is read and edited. Research found no WMS that pairs an editable floor plan with an editable rack-front view. A 3D overview is out of scope (owner decision 2026-10-19: only what provides operational value); the location records keep X, Y, Z and dimensions, so a 3D renderer can be added later without a data change if a use for it appears.
- **Modes**: Browse, Stock (blue shading by fill), Heat (picks per bin, 30 days), Route (a cart's numbered stops). **Find** highlights every bin and reserve carton holding a SKU or LPN.
- **Location drawer** (right Sheet, 340 px): code as hero, type chips, contents with min/max bar, rack/shelf facts, replenish source, label id, actions (Move stock, Count now, Print label, Rack view), and history.
- **Edit layout**: left palette of rack templates and fixtures, snap-grid canvas with handles (duplicate, rotate, nudge), right properties (aisle, side, bays, first bay, levels, positions, X/Y, facing, walk direction, use). The panel previews the codes the rack will generate and the walk-order range, flags conflicts, and prints labels. "Import spreadsheet" takes the owner's digitizing workbook; "Verify walk" sorts all locations by `pick_sequence` so a wrong serpentine is visible before labels print.

### Pick & Pack board (supervisor)
Four live columns: **Awaiting** (bulk lanes detected at the top, then the next cart batches with stops and expedited count, then on-hold orders), **Picking** (cart, picker, progress bar, tote colour strip, current stop, exceptions), **Handed off** (cart per bench, shipped count from ShipStation, hospital tote), **Done today** (lines per picker-hour vs baseline, walk per cart, catches, picked-to-shipped median, per-picker lines, carrier staging counts). The batch rule strip states cart size, priority, single-line pile rule, bulk-lane threshold and scan rule in one line each.

### Phone picking
- **Start cart**: scan the cart; the batch summary (orders, lines, stops, estimated walk) and the tote list (letter, colour, order, lines) are shown. **Totes are permanent assets with fixed Code 128 barcodes** (industry norm: ShipHero, Veeqo, Starshipit, ShipStation's own Pick to Tote all print tote labels once and bind tote to order transiently). The ERP binds each tote to its order at cart build; the picker confirms the binding by scanning the tote at the first drop. ShipStation's key for the order rides in the tote as the packing slip (see "Tote to ShipStation" below), so nothing is printed per order by the ERP.
- **Next pick**: location is the hero (56 px code, aisle/bay/level words, side and rack), route progress strip, product photo (critical for look-alike glass), name, quantity as a 40 px numeral, tote letter on a 52 px colour tile, three-step scan ladder (location ✓ → scan each unit n/N → drop in tote), a one-line "Then:" preview, and shelf quantity. No typing anywhere, because a paired Bluetooth scanner hides the iPhone keyboard. Audio and visual feedback are primary (iOS has no vibration API).
- **Exception sheet** (bottom): Fewer than N (stepper), None here (opens a count task), Damaged (hospital tote), Wrong item (creates a move); a result line states what happens to the order and the cart before Confirm.
- **Cart complete**: summary, tote strip with the short tote outlined, then "hand off" with station availability and distance; scanning the station label parks the cart at that bench and ends the ERP's part of the order.

### Packing (unchanged, in ShipStation)
Owner decision 2026-10-19: there is no ERP pack screen. The packing team takes totes off the parked cart and runs today's ShipStation flow on the bench laptop: scan the tote label (the ShipStation order barcode) into Scan to Print, weigh on the ShipStation Connect scale, scan the box preset, scan Purchase and Print. The ERP learns the outcome from the existing ship webhook and reconcile, which is what the board's "Handed off" column and the "shipped" counts show. Totes are released back to the pool when the order ships. One thing to prove in a test before relying on it: that an ERP-printed Code 128A order-number label opens the right order in Scan to Print across both Shopify stores (order numbers from the two stores must not collide, otherwise print the packing-slip barcode format instead).

### Counts & Replenish
KPIs (location accuracy, counts due, variances, faces below min, open moves). Variances table with expected/counted, who, likely cause pulled from the ledger (a short pick that morning, a carton broken down without a move), Recount or Approve. Count tasks include pick-triggered counts (bin hit 0) and the A/B/C schedule. Replenishment lists faces below min with the exact LPN to pull and creates move tasks rather than a report. Phone count is blind: expected totals stay hidden until save, variance approval stays on the desktop.

### Overview
KPI band (awaiting pick, in carts, packed today, cartons to put away, counts due, exceptions), a pace strip (done vs backlog, projected clear time vs carrier cutoff), live carts, bulk lanes, putaway queue, exceptions, replenishment.

### Tote to ShipStation: fixed tote barcodes, three ways to hand the order to the bench
Decision frame (research 2026-10-19, `research_notes/Module UX layout/tote_barcode_practices.md`): the industry uses permanent tote barcodes because totes are reusable assets, printing is done once, and the WMS owns the pack station so a tote scan resolves to the order there. Freeze Pipe's pack station is ShipStation, which accepts only its own barcodes and has no way to be taught what a tote is. So a fixed tote barcode cannot be scanned into ShipStation directly; one of three bridges is needed.

| Bridge | What the packer scans | New per-order printing | ERP visibility of pack start | Build cost | Verdict |
|---|---|---|---|---|---|
| A. Packing slip in the tote (today's practice) | The slip's Scan to View barcode | None new: slips are printed today. ERP tags each order with its cart (`ERP-CART-04`); a saved ShipStation view by tag prints the cart's slips in one click | None | Near zero | **Phase 2 default** |
| B. Bench translator helper | The fixed tote barcode | None at all (paperless) | Yes: the tote scan is a pack-start event | Small Windows helper on each bench laptop: scanner in USB-serial mode → helper looks up tote→orderId in the ERP → types `^#^HEX^` + Enter into ShipStation; forwards every other scan (box presets, print) verbatim; falls back to slips if the ERP is unreachable | **Phase 3 upgrade** |
| C. ERP-printed Scan to View label per order | The tote label | One 3×2 label per order (~$0.03; ~$3k/yr at 400/day) plus 1–2 min per cart to apply | None | Printer at the cart-build point | Fallback only |

No precedent was found for a fixed tote barcode driving ShipStation's Scan page; B as a whole is a Freeze Pipe design. Its parts are established (`research_notes/Module UX layout/scanner_translation_precedents.md`): commercial "software keyboard wedges" that run a script per scan, do a database or HTTP lookup, and type the result into the active application exist (TEC-IT TWedge, Windows, about $272 per device per year, JavaScript scripting with ODBC and HTTP listed); third-party tools already steer ShipStation from scans (GroovePacker's Chrome extension opens the scanned order; SkuVault and GroovePacker print Scan to View-compatible barcodes); ShipStation Connect itself is a local hardware-bridge agent; and a Raspberry Pi acting as a USB keyboard is a documented Linux feature. Scanner firmware rules (Zebra ADF) are static and cannot do lookups, so the translation must live in software or a bridge device. Three ways to build B, in order of effort: (1) TWedge plus a 20-line script and an ERP endpoint returning `^#^HEX^` for a tote code; (2) an in-house helper (Node or C#) owning the scanner over USB-serial mode and typing with Unicode SendInput; (3) a Pi Zero bridge between scanner and laptop, OS-agnostic. Known risks and mitigations: the helper owns every scan, so pass everything through verbatim and keep slips in totes during rollout; keep the browser unelevated (Windows blocks typing into elevated windows); US keyboard layout or Unicode input because `^` is a dead key on some layouts; show helper health on the board. B depends on the Scan to View bench test passing, since typed text and scanned text reach the browser identically.

Tote asset spec: Code 128 payload `T-<cart>-<slot>` or a plain serial (`TOTE-0047`), laminated label on the short side and a second inside the lid, colour block matching the slot colour used on the phone and board. Totes release automatically when ShipStation ships the order (webhook) or manually from the Totes tab.

**Tote size classes (owner decision 2026-10-20): three tote sizes on every cart, assigned automatically from SKU box dimensions.**
- `product_skus` gains `box_length_in`, `box_width_in`, `box_height_in`: the product's own box as it sits on the shelf, before bubble wrap. Nothing else (owner, 2026-10-20: weight and a fragile flag are not needed for this). Sources, in order: the ShipStation product export if its Length/Width/Height columns are filled, otherwise the digitizing workbook. Unknown dimensions default the order to the large class and flag the SKU for measurement.
- Order tote class = the smallest class whose inside dimensions fit the order: sum of item box volumes with a small packing allowance, and longest item dimension ≤ tote inside length. Computed at import and stored on the order; recomputed if lines change. Because the shipping-box data in the export includes bubble wrap, the real tote classes will be smaller than the box mix suggests; the slot mix is set from measured product boxes, not from the shipping boxes.
- Cart definition (Warehouse settings): an ordered list of slots, each with a letter, a size class and the class colour (small = yellow, medium = blue, large = red, or whatever the floor prefers; colour means size, the letter means the slot). A starting mix from the box data: 12 slots as 6 small, 3 medium, 3 large; tune after a month.
- Batcher: fills a cart's slots by class, allows an order to move up a class when its own class is full (never down), and releases the cart when the slots are full or the wait timer expires. Oversize orders (the 2% beyond the large tote) are flagged and picked last onto the cart top.
- Phone, board and labels show the tote letter on its class colour; tote labels are printed per class colour so a picker never puts a large order's items into a small tote.
- Physical sizes to confirm against the chosen cart's shelf: small about 13 × 10 × 6 in inside, medium 16 × 11 × 8, large 18 × 13 × 12; slot counts per shelf follow from the tote's outside footprint.

### Scan to View barcode (what bridges B and C must reproduce)
**VERIFIED on the bench 2026-10-20 by the owner: a packing-slip barcode scanned into a text editor reads `^#^` + the ShipStation orderId in uppercase hex + `^`, exactly as researched.** Research 2026-10-19 (`research_notes/Module UX layout/shipstation_scan_to_view_barcode.md`):
- **What it encodes**: Code 128, decoded text `^#^` + the ShipStation **orderId in uppercase hexadecimal** + `^`. Example: orderId 1234567890 → `^#^499602D2^`. It encodes the internal orderId, not the order number, which is why it is unambiguous across the two Shopify stores. Source is a 2025 ShipStation Community post plus ShipStation support's long-standing "print `[Barcode]` as Code128A" advice; the help center itself never documents the payload.
- **Not in the API**: no V1 or V2 field carries the barcode. The ERP does not need one: `shipstation_orders.shipstation_order_id` is already stored for every imported order, so the value is derivable at import time. SQL: `'^#^' || upper(to_hex(shipstation_order_id)) || '^'`. TypeScript: `` `^#^${id.toString(16).toUpperCase()}^` ``. Add it as a generated column or view field so every order carries its tote-label value automatically.
- **Scan page behaviour**: the Scan to View barcode opens the order from anywhere in ShipStation and reopens it after the label is bought (reprint, history). Order-number barcodes work only on the Scan screen and are ambiguous across stores.
- **Printing**: any Code 128 encoder (bwip-js, subset Auto). A 12-character payload is about 187 modules; at 203 dpi use 3 dots per module (about 2.8 in wide), so a 3×2 or 4×2 label, not 2×1. In ZPL the `^` must be escaped (`^FH` with `_5E`) or the printer reads it as a command. Scanner suffix Enter; bench laptop on a US keyboard layout because `^` is a dead key on some layouts.
- **If bridge C is used, label content**: barcode, human-readable order number, store, tote letter on its colour block, line count, picker initials, cart and date. One label per **ShipStation order record** (Shopify orders may now import as separate shipments, each with its own orderId). The same per-record rule applies to the slips in bridge A and the lookups in bridge B.
- **Edge cases the ERP must handle**: split orders create new orderIds (`parentId` set) and combined orders retire the merged ones (`mergedIds`), so a tote label printed before a split or merge is dead; watch `mergedOrSplit`, `parentId`, `mergedIds` on reconcile, void the tote, and reprint. Skip cancelled orders.
- **Bench test**: done 2026-10-20, format confirmed. Still worth a one-off check when the first ERP-printed label exists: that an ERP-generated label opens the order in Scan to Print and reopens it after the label is bought, and whether a 7-digit hex value is zero-padded (only matters for orderIds below 268,435,456).

## 3. Integration points with existing modules

| Existing surface | Change |
|---|---|
| Freight › Shipment detail | Check-in mints LPNs and prints labels; stepper gains label/putaway stages; manifest gains LPN + Putaway columns; putaway queue card |
| Inventory › Stock Levels | Row expands to a by-location breakdown (pick face, reserve cartons); the effective count stays the headline number per owner decision 1 |
| Economics › SKU detail | New "Locations" tab: pick face with min/max, reserve LPNs, pick velocity class, count history |
| ShipStation orders (DB) | Orders in `awaiting_shipment` feed the pick queue; order rows gain a pick-status chip linking to the cart; ERP writes ShipStation tags (ERP-PICKING, ERP-PICKED, ERP-HOLD); tote labels print the ShipStation order barcode; ship webhook closes the tote and the cart |
| Manufacturing › Workspace | Becomes the "Manufacture" tile on the floor home; RTS completions create putaway tasks to pick faces (later phase) |
| Dashboard | Two warehouse tiles (pace vs cutoff, exceptions) |
| Daily report | Adds lines per hour, mis-picks caught, cartons awaiting putaway > 24 h |
| Settings | New Warehouse tab: rack templates, naming scheme, cart definitions (slot count, colours), stations, printers, batch rules, scan rules, bulk-lane threshold |
| Roles | No new DB role in phase 1: `user` gets `/go`; supervisors are `manager`. A per-user landing preference replaces the hard-coded redirect |

## 4. Components and plumbing the build adds

- shadcn additions: `skeleton`, `toggle-group` (segmented controls used throughout), `drawer` via vaul (phone bottom sheet; `Sheet side="bottom"` as fallback), `command` (SKU/location search), `radio-group`, success toast variant.
- Extracted shared pieces so the module does not copy-paste: `PageHeader`, `EmptyState`, `BigStepper` (from Workspace), `ScanSink` (autofocus hidden input with Enter handling, prefix detection for location vs item vs LPN vs tote vs station), `LocationCode` (tabular, hero sizes), `ToteChip`, `StatusChip` map in `lib/status-colors.ts` for pick/putaway/count states.
- Map: SVG plan component with instanced bin rects and a `RackElevation` grid. No 3D library in the build; coordinates are stored so one could be added later.
- Data: Supabase Realtime (worker heartbeat, refetch on visibility) for the board, cart state and pack screen; IndexedDB outbox for phone scans; RPCs keep the `{ok,error}` envelope with human-readable errors.
- PWA: manifest, service worker, `viewport-fit=cover`, `h-dvh`; relax `vercel.json` Permissions-Policy to `camera=(self)` only if camera scanning is later wanted.

## 5. Design rules applied

- State, numerals, colour and button labels carry meaning; no caption paragraphs (owner rule). Where a reason is useful it is a 12 px grey line under the number, never a sentence block.
- Phone targets ≥ 52 px, primary action ≥ 56 px, location code ≥ 40 px; text 4.5:1 on the dark ground.
- Tote colours differ in lightness, not hue alone; the same 14 colours are used on cart labels, phone, board and pack screen.
- Every destructive or irreversible action names its consequence on the button (existing ERP idiom).
- Map edits never rename existing locations silently; code generation previews before save; labels print from the same record.

## 6. Open UX decisions for the owner

None at the UX level as of 2026-10-19. Settled this date: location scan on every stop is a Warehouse settings toggle (default on, one switch to relax); variance approval is managers only; the 3D view is dropped from scope, with the plan and rack elevation as the only map renderers.

Also settled 2026-10-19: no ERP pack screen; packing stays in ShipStation with the current scanner workflow. Totes are permanent assets with fixed barcodes. Phase 2 uses bridge A (ShipStation packing slip in the tote, printed per cart from a tag-filtered view). Phase 3 builds bridge B as an **in-house bench helper** (not TWedge): a small Windows service per bench laptop that owns the scanner over USB-serial mode, looks the tote up in the ERP, types the Scan to View barcode plus Enter with Unicode input, passes every other scan through verbatim, and reports health to the board. Slips remain the fallback until the helper has run clean for a month.
