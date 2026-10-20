# Shipment export analysis and cart sizing

Source: ShipStation shipment export for the last 365 days supplied by the owner 2026-10-20 (63,402 shipments, 62,997 distinct orders, shipped 2025-10-20 to 2026-10-20; columns: ship date, order number, box L/W/H, weight). Supersedes the YTD-only pass, which missed the Q4 peak. No line items in this export, so lines and units per order are still unknown; see "Second export" at the end.

## Daily volume (260 ship days)

| Statistic | Shipments per ship day |
|---|---|
| Median | 217 |
| Mean | 244 |
| 75th percentile | 336 |
| 90th percentile | 429 |
| 95th percentile | 491 |
| 99th percentile | 692 |
| Maximum | 758 (Dec 29, 2025) |
| Days at or above 300 | 80 |
| Days at or above 400 | 37 |
| Days at or above 500 | 13 |
| Days at or above 600 | 6 |

**November and December 2025 alone**: 44 ship days, median 379, 90th percentile 609, maximum 758. Busiest seven-day window: 3,077 shipments ending Dec 4. The six 600-plus days are Nov 28, Dec 1, Dec 8, Dec 22, Dec 29 and Feb 17.

Weekday medians over the year: Monday 360, Tuesday 213, Wednesday 160, Thursday 172, Friday 172, Saturday 196 (Saturdays ship in Q4). Monday carries the weekend's orders and is the routine peak.

Monthly: Oct 2025 (from the 20th) 2,816 · Nov 7,069 · Dec 9,776 · Jan 6,264 · Feb 6,237 · Mar 5,501 · Apr 5,741 · May 3,860 · Jun 3,577 · Jul 3,349 · Aug 3,248 · Sep 3,966 · Oct 2026 (to the 20th) 1,998. December runs three times the summer rate.

405 orders shipped in more than one shipment (0.6 percent). About 1,050 shipments carry non-numeric order numbers (manual or replacement orders).

## Box mix (the six sizes, plus strays)

| Box (in) | Share, full year | Share, Nov–Dec | Volume (cu in) |
|---|---|---|---|
| 12 × 5 × 5 | 45.8% | 44.3% | 300 |
| 14 × 12 × 6 | 14.3% | 12.2% | 1,008 |
| 18 × 12 × 8 | 12.7% | 10.2% | 1,728 |
| 10 × 8 × 6 | 10.3% | 9.5% | 480 |
| 4 × 4 × 4 | 7.1% | 5.2% | 64 |
| 15 × 12 × 12 | 1.9% | — | 2,160 |
| 18 × 16 × 8 | 1.3% | — | 2,304 |
| 20 × 20 × 12 | 0.6% | — | 4,800 |
| No dimensions recorded | 5.8% | 12.9% | — |

The mix is stable across the year. Cumulative: about 65% of orders ship in a box of 480 cu in or less, 80% in 1,008 or less, 94% in 1,728 or less. Longest box side is 18 in at the 99th percentile; only 0.7% of orders exceed 18 in. Weight: median 28 oz, 90th percentile 99 oz (6.2 lb), 95th 115 oz. The share of shipments with no recorded dimensions more than doubles in Nov–Dec (12.9%), which looks like labels printed without a box preset, probably the bulk-lane singles; worth confirming because those are the orders the bulk-lane rule should catch.

## What this means for totes and carts

Note: the tote and cart figures in this section were my first pass and are corrected in "Plan versus best practice" below (12 orders per cart on a purpose-built cart with 18 × 13 × 12 totes, no large slots, decant at stations, three pickers in Q4). The volume analysis and the single-line observation stand.

The box is an upper bound on the order's contents (it includes bubble wrap and void fill), so a tote only needs to hold what goes into the box, not the box.

- **Tote**: an inside size around 16 × 11 × 8 in (about 1,400 cu in; the common 16 × 11 × 8 stack-nest tote) holds the contents of every order that ships in a 14 × 12 × 6 or smaller box, which is 80% of orders, and most 18 × 12 × 8 orders once the dunnage is excluded. Reserve two larger slots per cart (about 21 × 15 × 12 in) for the 6 to 8% of orders that ship in 15 × 12 × 12 and up, or in two boxes. Totes must be shorter than the shelf gap on the cart with a hand's clearance; 8 in deep totes on 12 in shelf spacing works.
- **Cart**: a three-shelf picking cart with 48 × 24 in shelves fits six 16 × 11 totes per shelf (three along, two deep). Two shelves of small totes plus one shelf holding two large totes gives **14 slots per cart (12 standard + 2 large)**, which is the number used throughout the wireframes. A 60 × 24 cart gives 18 slots; the wider cart is harder in the aisle beside the open floor when gaylords build up, so 48 in is the safer default. Measure the aisle before buying.
- **Orders per cart trip**: 14 orders at roughly 20 to 25 lines is an 8 to 12 minute trip once routing and slotting are live, so one picker turns 70 to 85 cart orders an hour. Sizing against the Q4 90th percentile of about 610 shipments a day: assume 150 to 200 go to the bulk lane, leaving 400 to 460 cart orders. Two pickers clear that in about three hours, inside a 9 AM start and a 2 PM cutoff. The six days above 600 need a third picker or an earlier start; the 758 record day needs both. A median 217-order day is a one-picker morning.
- **Carts and tote count**: four carts (two being picked, two parked at stations) with totes fixed to them is 56 totes, right for two pickers through 95% of the year. For the Q4 weeks, a fifth and sixth cart let a third picker run without waiting for a station to free up. Add 8 to 10 spare totes for reshelve, spares and breakage, so **order about 65 totes of the standard size and 10 large now, and plan 28 more if a third picker is added for Q4**.
- **Single-line orders**: 46% of orders ship in the 12 × 5 × 5 box, which is the strongest sign that single-line and near-identical orders are a large share. Those should not occupy a tote each: the bulk lane takes the top SKUs, and remaining single-line orders go to a pile tote on the cart, sorted by the slip at hand-off.

## Plan versus best practice (research 2026-10-20)

Two research lanes (`research_notes/Cart and tote practices/`) checked the plan above against the order-picking literature, commercial cart and tote products, WMS vendor rules and practitioner guidance. Three corrections and several confirmations.

**Correction 1: the 14-slot 48 × 24 cart does not exist as drawn.** Stack-nest totes are sold by inside size; a 16 × 11 × 8 tote is about 20 × 13 in outside. On a 48 × 24 shelf that is three totes sideways per shelf, nine per three-shelf cart, not twelve plus two. The purpose-built product is Uline's H-9094 order-picking cart: 68 × 28 × 70 in, three slanted 58 × 16 shelves, four 18 × 13 × 12 totes per shelf, twelve per cart, 1,000 lb rating, about $610 with totes extra in six colours. A 60 × 24 three-shelf utility cart also holds twelve 20 × 13 totes sideways. **Revised plan: 12 orders per cart, letters A to L, using 18 × 13 × 12 totes (about 2,800 cu in inside).** That tote holds the contents of every order up to the 15 × 12 × 12 box, which is 98% of orders, so the separate large-slot idea is dropped; the 2% that ship in 18 × 16 × 8 or 20 × 20 × 12 are flagged oversize by the batcher from SKU dimensions and picked last onto the cart top or a second trip. Measure the open-floor aisle for a 28 in wide, 68 in long cart before buying; a 60 × 24 utility cart is the fallback if 68 in cannot turn there.

**Correction 2: my throughput estimate was optimistic.** Published rates for cart cluster picking are 60 to 85 lines per hour for experienced pickers and 35 to 50 for new ones (vendor and practitioner sources; no study measures 10 to 14 order carts). At 1.7 lines per order a 12-order cart is 20 lines, or 15 to 20 minutes per trip, not 8 to 12. Reworked staffing against the Q4 90th percentile of about 610 shipments a day, with 150 to 200 in the bulk lane: about 430 cart orders, 730 lines, 10 to 11 picker-hours. **Two pickers no longer fit a 9 AM to 2 PM window in Q4; three pickers are the routine Q4 staffing, and the record 758-day needs four or an earlier start.** Outside Q4 the median 217-day is still a one-picker morning. The baseline stopwatch numbers in Phase 0 will replace these published rates with Freeze Pipe's own.

**Correction 3: carts parked at stations are a picker-idle risk.** With totes fixed to the cart, the cart stays at the station until every order on it is packed. Four packers clear a 12-order cart in a few minutes on a normal day, but on a peak day stations back up and the picker waits for a cart. The practitioner fix is to decant: a two-tier tote rack at each pack station takes the cart's totes, the picker takes the empty cart straight back, and the packer works from the rack. **Revised fleet: three carts for two pickers, four for three pickers, plus one tote rack per station and about 90 totes** (12 per cart, 12 per station rack, plus spares). Tote barcodes make the decant free of data entry: scanning a tote at the station rack records the hand-off.

**Confirmed by the evidence**

- Batching 12 orders per cart: within the practitioner range of 4 to 25, and the literature says batching gives the largest travel savings of any policy, especially for 1 to 5 line orders. In a five-run building the route touches nearly every aisle after 10 to 15 picks, so going beyond 12 saves seconds; release a cart when full or after a set wait.
- Optimized routing on the phone: aligned but low marginal value next to batching; the walk-order fallback is nearly as good.
- Pile totes for single-line orders and a bulk lane for identical sets: standard practice (Infor's WMS has it built in). No source gives thresholds; set the pile at six or more single-line orders of one SKU in the queue, capped by glass units per tote, and the bulk lane at ten identical orders, then tune both from the item data.
- Permanent tote barcodes and colour-coded slots: standard.
- Aisles: a 24 to 28 in cart in 7 to 9 ft aisles is comfortable. Push handle near elbow height, about 35 in; starting push force under 50 lb.

**Gap the plan did not cover: fragile handling.** Practitioner sources agree on padded or divided totes, cushioned shelf liners, no stacking of glass in a tote, one order per tote, and as few touches as possible. Add foam or felt liners to every tote, a rule that glass never stacks inside a tote, and a per-tote unit cap for glass in the pile tote.

Revised shopping list: 3 to 4 purpose-built 12-tote picking carts, about 90 totes of 18 × 13 × 12 in six colours with liners, four two-tier tote racks for the pack stations, phone holders and scanner holsters on each cart. The wireframes' 14-slot tote strip becomes 12 slots; the slot count is a cart-definition setting in the ERP, so nothing else changes.

## DIY cart: Uline wire cart plus shelf bins (owner direction 2026-10-20)

Specs verified on uline.com 2026-10-20 (`research_notes/Cart and tote practices/uline_bins_and_wire_carts.md`). Uline shelf bins are open-front, 12/18/24 in deep, 4/7/8.5/11 in wide, 4/6 in tall (8 in only at 12 in deep), 45 lb dynamic, colours blue, black, yellow, red, green, not stackable, with a label slot. Nothing in the shelf-bin line is tall enough for the large class, so large uses the divider box Uline puts on its own picking cart (20 × 15 × 8 in inside). ShipHero's cart kit is the same recipe: your cart, your bins, one LED bar per slot, phone and Bluetooth scanner supplied by you, so this cart takes lights later with no rebuild.

**Layout on a 48 × 24 wire cart** (usable width about 45 in between posts):

| Shelf (bottom to top) | Bins | Class | Colour |
|---|---|---|---|
| 1 | 2 × divider box S-16978, 20 × 15 × 8 inside | Large | red label |
| 2 | 4 × shelf bin S-15647, 11 × 18 × 6 | Medium | blue |
| 3 | 6 × shelf bin S-15645, 7 × 18 × 6 | Small | yellow |
| 4 (four-shelf cart only) | 6 × shelf bin S-15645, 7 × 18 × 6 | Small | yellow |

Three-shelf cart H-1521 (48 × 24, 41 in tall, about $240): 12 slots as 6 small, 4 medium, 2 large, which matches the 12-order cart in the plan and keeps every bin between knee and waist. Four-shelf mobile shelving H-11891 (48 × 24 × 60, about $275): 18 slots as 12 small, 4 medium, 2 large, for Q4 when the batcher can be allowed 14 to 16 orders per cart. Shelves adjust in 1 in steps; set the large shelf gap to 11 in and the bin shelves to 8 in so product boxes standing proud of a 6 in bin still clear the shelf above. Slot letters run A to L (or A to R) bottom-left to top-right, the same order the batcher fills them.

**Bill of materials per cart** (Uline prices seen 2026-10-20, 3-plus-carton rate): cart $240 to $275 · 6 or 12 small bins at $5.30 · 4 medium bins at $12.05 · 2 divider boxes at $23.55 · snap-on 4 in front ledges H-1763 (two 24 in per shelf, $7.50 each) to stop bins sliding, or a 48 × 24 liner H-2440 at $29 per shelf · label holders S-21114 for the slot letter · a phone clamp on the handle post and a scanner holster. **About $440 for the three-shelf 12-slot cart and about $560 for the four-shelf 18-slot cart**, roughly what Uline's turnkey 8-bin picking cart costs ($545 to $560), so the DIY wins on slot count and the three sizes rather than on price.

**Decision 2026-10-20: the four-shelf 18-slot cart (H-11891).** Cart definition in the ERP: 18 slots A to R, 12 small, 4 medium, 2 large; the batcher's orders-per-cart cap is a setting, starting at 14 and raised toward 18 in Q4. The owner is buying the carts.

**Two checks before ordering**: (1) the largest product boxes must fit a 20 × 15 × 8 divider box standing proud by no more than a couple of inches; if any product box exceeds about 10 in in two dimensions, the large slots become 18 × 13 × 12 totes on the bottom shelf instead; (2) the open-floor aisle must pass a 24 in wide, 48 in long cart with a picker beside it, which it should at 7 to 9 ft.

## Lines and units per order (production ERP, read 2026-10-20)

Source: production `shipstation_orders` and `shipstation_order_items`, orders dated 2026-06-01 to 2026-10-20 with item rows, shipped or awaiting shipment: 15,766 orders. The ERP has complete order coverage from late April 2026; 99 orders in the window have no item rows (the known blank-SKU import issue).

| Measure | Value |
|---|---|
| Single-line orders | 62% (9,831) |
| Single-line, single-unit orders | 58% (9,187) |
| Two lines | 17% · three 8% · four 5% · five or more 7% |
| Mean lines / units per order | 1.84 / 1.97 |
| 90th percentile lines | 4 · 95th percentile units 5 |
| Top single-unit SKUs | BW20DNA 1,550 · BW20 1,022 · BW40SP 401 · BW20P 266 · S03-BW20P 264 · NB4 253 · Carbon-Filter 222 · NB6 217 · BW20-Bowl 216 |
| Orders in an identical set of 10 or more on the same day | 14.5% (2,285); at 6 or more, 22% |
| Single-unit orders of one SKU with 6 or more that day | 21% of all orders (36% of singles); at 3 or more, 32% of all orders |

Summer daily volume in the ERP (median 106, 90th percentile 154, max 210) is consistent with the shipment export for the same months, so the Q4 figures from the export can be scaled with these shares.

**Batch rule starting values**: bulk lane at 10 identical orders per day (catches about 15% of orders in summer, more in Q4 because set sizes scale with volume); single-line pile tote at 3 or more single-unit orders of one SKU in the queue (about a third of orders), capped per tote by glass units; everything else goes to cart slots. With 62% of orders being one line, the 18-slot cart with 12 small slots is the right shape, and cart orders on a Q4 90th-percentile day are nearer 350 than the 430 assumed above, which eases the three-picker arithmetic.

**Two Phase 0 findings from the same read**: (1) only 1 of 131 active SKUs has a UPC in the ERP, so scan-to-confirm at the shelf depends on whether product boxes carry a barcode at all; if not, the ERP prints SKU labels or the carton license plate is what gets scanned; (2) staging's migration history is the old 59 incremental files and none of production's 84, so staging must be rebuilt from production's schema before anything is built on it.

The workbook's SKU boxes tab is pre-filled with the 131 active SKUs from this read.
