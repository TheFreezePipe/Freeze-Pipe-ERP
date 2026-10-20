# Warehouse operations audit: current state, quick wins, and what it means for the module

Date: 2026-10-19. Based on the owner's description of the 3,500 sq ft warehouse and high-volume workflow, plus two research lanes saved in `docs/research/research_notes/Warehouse ops audit/` (ShipStation Standard-plan features read from ~60 help-center articles; small-warehouse benchmark literature, which is thin and mostly vendor-sourced). Numbers below marked "estimate" are engineering judgment to be replaced by a stopwatch baseline.

## 1. What is already good

- **The single-item bulk lane is best practice.** Batching the 3-4 top SKUs (70-100 orders), printing labels directly and handing them to the manufacturing team for bulk packing is exactly the "identical-order lane" pattern that WMS vendors sell as a feature. Many operations this size never do it.
- **The pack step is close to the ceiling for a Scan to Print bench.** Scan slip, scale auto-weight, preset barcode for box, purchase-and-print barcode is a four-touch flow. There is at most one touch left to remove (the scale, for known-weight orders).
- **Hardware is right-sized.** Four benches with laptop, USB scanner and scale on ShipStation Connect is the pack-station design the module report recommends; nothing needs to be bought for packing.
- **Six box sizes** is the sourced recommendation (a small fixed set); it also makes box suggestion in the module trivial.

## 2. Where the time goes

The constraint is picking, not packing, and it sits on one person.

| Step | Who | Method | Assessment |
|---|---|---|---|
| Print 30-40 slips | Lead | Wave of slips | Fine as a wave size |
| Pick | Lead, alone | One order at a time, no location on the slip, items grouped with slip on a cart | Discrete picking: one full walk per order; about half of picker time is travel (academic consensus) |
| Carry to station | Lead | Cart | Extra trip per wave; acceptable |
| Pack, weigh, box preset, print | 4 packers | Scan to Print | Efficient; no item verification scan (order barcode only) |
| Tote to staging by carrier | Packers | Wheeled tote | Re-handled once at staging |

Rough arithmetic (estimate, not sourced): on a 400-order morning, about 300-330 orders go through the lead. Discrete picking of 1-5 line orders in a 3,500 sq ft building plausibly runs 40-60 orders per hour, so picking alone is 5-8 lead-hours. Four packers at 40-60 packs per hour each could clear the same orders in 1.5-2 hours if fed continuously. The pack side is therefore over-provisioned by roughly three to four times relative to picking, and packers are either waiting or doing other work for much of the morning. Every improvement that matters in the next year is on the pick side.

Secondary findings:

- **No locations exist in the system.** Slips carry no shelf address, so picking depends on the lead's memory. This is also the single prerequisite for the module, so doing it now is not throwaway work.
- **No item-level verification at pack.** Scan to Print confirms the order, not the contents. With fragile, look-alike glass (coil colours, bong sizes), mis-ships are expensive. ShipStation Standard can force an item scan per line (Verify & Print) once UPCs are loaded.
- **Known-weight orders still get weighed.** Product Defaults can auto-fill weight, dimensions and package for single-line orders and skip the scale.
- **No baseline KPIs.** Nothing today records orders per hour, lines per hour, mis-ship rate or import-to-label time, so the gain from any change cannot be shown.

## 3. Efficiency rating

Maturity scale used (adapted from the vendor models found; no validated instrument exists): L1 paper, discrete picking. L2 paper batch/cluster picking from location-sorted lists. L3 scan-guided mobile picking against bins. L4 optimized (routing, slotting, KPIs, lights). L5 automated (goods-to-person, robots). L5 is not appropriate at this size.

| Area | Now | After quick wins (weeks) | After the module (phases 1-3) |
|---|---|---|---|
| Picking | L1 (bulk lane earns a half-step) | L2 | L4 |
| Packing | L3 | L3+ (scale skipped, items verified) | L4 (tote-driven pack screen, carrier colour) |
| Inventory accuracy | L1-2 (SKU totals, no bins) | L2 (locations loaded, cycle counts by location) | L4 (bins, carton LPNs, nightly reconciliation) |
| Overall | **about 2 / 5** | **about 3 / 5** | **about 4 / 5** |

Expressed as labour on a 400-order morning (estimates to be verified by baseline): picking 5-8 lead-hours now, 2.5-3.5 hours with cart cluster picking from location-sorted lists, 1.5-2.5 hours with scan-guided routed picking and slotting. As a share of attainable efficiency: roughly 45-50% now, about 70% after quick wins, about 90% after the module.

## 4. Small wins to capture now (ordered by effort, all on ShipStation Standard)

1. **Name the shelves and load locations into ShipStation.** Decide the location code format (section 6), label the shelves, and bulk-import the product CSV with `WarehouseLocation`, `UPC`, `WeightOz` and L/W/H. Blank CSV cells overwrite existing values with null, so fill every row. Cost: label stock and a day of walking. This is phase 0 of the module done early.
2. **Print one consolidated, location-sorted pick list per wave.** Orders, select the wave, Print, Pick List, with "Summarize by SKU", sort "Warehouse location then SKU", and "show order numbers" on. The lead now walks the building once per wave instead of once per order. Cart cluster picking: a cart with 12-16 numbered slots (one slot per order, slip in the slot); at each location pick the total and drop into the listed slots. Two U-Line picking carts: roughly $300-600.
3. **Custom packing slip.** Add `[Warehouse Location]` per line sorted by location, product image, and a large `Code128A` order barcode (ShipStation warns the default Code128C misreads long or zero-heavy numbers). Slips become a cross-check, not the pick document.
4. **Skip the scale where weight is known.** Set Product Defaults (weight, dims, package) on the top 30 or so SKUs; for the single-item lane turn "Use Scale" off so scan slip then scan Purchase-and-Print is the whole flow. For common multi-line combos, Automation Rules on product tags can set package and total weight at import.
5. **Verify items at pack for multi-line orders.** Remove the "Packing (Scan Page): Manual Verification" permission from packers so Verify & Print requires a UPC scan per item, with Workflow Settings auto-advancing to print. Costs a few seconds per item; buys accuracy on glass.
6. **Rebalance people.** On 400+ days run two pickers and two to three packers instead of one and four. Cross-train one packer to pick from the consolidated list.
7. **Extend the bulk lane to identical two-SKU orders.** Group By "Item SKU" plus "# Line Items" in the Orders grid, or product tags to order tags via Automation Rules, then batch and bulk-pack like the singles.
8. **Sort by carrier at the bench.** One tote per carrier at each station (or a colour sticker) so staging is a drop, not a re-sort; print the USPS SCAN form and UPS manifest at cutoff.
9. **Baseline for two to four weeks.** Stopwatch three waves (slips printed to last order on the cart), count orders and lines per picker-hour, log mis-ships and reprints. The module's gains will be measured against this.

Not recommended now: ShipStation Mobile Picking (needs ShipStation Inventory locations, conflicts with the ERP owning inventory) and a Premium upgrade.

## 5. What this changes in the module design

- **Decision 1 as the owner stated it:** `inventory_levels` stays the effective count (deducted at ShipStation import); the new `inventory_balances` per bin is the physical count and decrements only at pick confirmation. The picker screen reads balances, never levels, so "2 on shelf for a 2-unit order" always shows 2.
- **Cluster picking to cart slots is the picking model**, matching how the lead already groups orders. The phone replaces the slip as the pick document; waves become ERP cart batches sized to the cart's slots.
- **Bulk-lane builder is a first-class feature.** The ERP should detect identical orders (single SKU and identical SKU sets) above a threshold, present them as one pick of N units plus a bench hand-off, and leave label printing to ShipStation batches exactly as today.
- **Pack screen runs on the four existing laptops.** USB scanners act as keyboards; the ShipStation Connect scale stays; the ERP pack screen shows tote, items to verify, suggested box, and the order-number barcode the packer scans into ShipStation Scan to Print. Carrier colour on screen drives the bench-side tote sort.
- **Bluetooth scanners for pickers' phones**, camera scanning optional. Screens must be typing-free (a paired scanner hides the iPhone keyboard).
- **No lighting in the first build**; keep the dormant tote-slot colour scheme so it can be added later.
- **Cancellations deferred**; cycle counts by location remain the cleanup mechanism, so the counting workflow in phase 1 must be quick enough to run weekly on A-SKUs.

## 6. Location code format (decision 7)

`AA-BB-L`: aisle (2 digits), bay (2 digits), level from the floor (1 digit), with an optional `-P` position when a shelf holds several SKUs side by side. Example `03-05-2`. Rules: zero-pad everything so text sorts match walk order (ShipStation's pick-list sort is text); number bays in the direction of travel for that aisle (serpentine), so even the paper pick list walks a loop; levels count up from the floor; start aisle numbering with room to grow. The ERP will add its own `pick_sequence` so the codes never need renumbering again. Labels: Code 128, black on white, at eye level on the shelf edge, one per bay-level, plus one zone sign per aisle end. Reserve carton areas get their own aisle numbers (for example 90-xx) so cartons sort last.

## 7. What to hand over when digitizing the building (decision 9)

A spreadsheet with four tabs plus a floor plan:

1. **Floor plan** (photo of a hand sketch is fine, roughly to scale): outer walls with dimensions in feet and inches, doors and dock, every shelving unit as a rectangle with an ID (R01, R02, ...), which side faces which aisle, aisle widths, the four pack stations (P1-P4), staging, receiving and carton reserve, manufacturing bench, obstacles (columns, HVAC).
2. **Rack templates** tab: one row per distinct shelving type: template name, width, depth, height, bays per unit, levels per bay, shelf spacing, positions per level, max weight per shelf.
3. **Racks** tab: one row per unit: rack ID, template, X and Y of the front-left corner measured from one chosen corner of the building, facing direction (N/E/S/W), aisle number it serves, single- or double-sided.
4. **Stock placement** tab: one row per SKU per location: SKU, location code, units, cartons. This is also the ShipStation `WarehouseLocation` CSV, so it pays off immediately.
5. **Photos**: one per rack face.

With that I can generate every location code, barcode label PDF and the ShipStation import file, and later seed the ERP's location tables from the same sheet.
