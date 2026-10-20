# Pick-Path Optimization, Order Batching, and Cluster (Pick-to-Tote) Picking for a Small E-commerce Warehouse

Scope: what's needed to plan a guided picking engine in the Freeze Pipe custom ERP (React/TS + Supabase Postgres + Deno edge functions). The warehouse is one small site with a few hundred SKUs, orders of 1-5 lines, and 2-5 pickers. Research date: October 2026.

Evidence key: [ACADEMIC] = peer-reviewed or thesis. [VENDOR] = practitioner or marketing content. [DOCS] = official software documentation. [INFERENCE] = the researcher's engineering judgment; no source backs it.

## 1. Routing heuristics (S-shape, return, midpoint, largest gap, composite/combined, aisle-by-aisle, Ratliff-Rosenthal optimal, TSP + 2-opt): which work best for short pick lists, and how large are the gains?

### Takeaway
The literature agrees on the ranking: optimal routing beats every heuristic. Composite/combined and largest gap are clearly the best simple heuristics. S-shape and return are the weakest. Reported gaps between optimal and heuristics run from about 6% to 39%, depending on layout and pick-list size. Largest-gap-type methods do relatively best on small pick lists. Freeze Pipe has few locations and short lists, so exact optimal routing is computationally trivial. A heuristic is only worth using as a fallback or as a teaching aid for pickers.

### Cited Findings
- [ACADEMIC] Petersen (1997), "An evaluation of order picking routeing policies," *IJOPM* 17(11):1098-1111. The optimal procedure produced significantly shorter routes than the heuristics. Composite and largest gap were significantly better than the simpler heuristics. Warehouse shape and the pick-up/drop-off (depot) location also affected efficiency. — [IAOR abstract](https://iaorifors.com/paper/23908); [DOI](https://www.doi.org/10.1108/01443579710177860)
- [ACADEMIC] Ratliff & Rosenthal (1983), *Operations Research* 31(3):507-521. Order picking in a rectangular warehouse is "a solvable case of the TSP." For a single-block rectangular warehouse, dynamic programming finds the optimal route in time linear in the number of aisles. — [Roodbergen site references](https://www.roodbergen.com/warehouse/background.php); [INFORMS Transportation Science supplement, 2023](https://pubsonline.informs.org/doi/suppl/10.1287/trsc.2023.1198/suppl_file/trsc.2023.1198.sm1.pdf)
- [ACADEMIC] Roodbergen & de Koster (2001b), *EJOR* 133(1):32-43, extended exact routing to a layout with a middle cross aisle (three aisle-change points: front, middle, rear). Each added cross aisle makes the problem much harder. Roodbergen's own tool computes optimal routes only for 1-2 blocks. Branch-and-bound could in principle handle any number of blocks, but he calls it too complex for the tool. — [Roodbergen: Routing order pickers in a warehouse](https://www.roodbergen.com/warehouse/background.php)
- [ACADEMIC] Heuristic definitions (Roodbergen, citing Roodbergen & de Koster 2001a, *IJPR* 39(9):1865-1883, and Vaughan & Petersen 1999, *IJPR* 37(4):881-897), all of which work on multi-block layouts — [Roodbergen](https://www.roodbergen.com/warehouse/background.php):
  - **S-shape (traversal):** every aisle that holds a pick is walked end to end; empty aisles are skipped. In multi-block layouts the route works block by block.
  - **Largest gap:** a gap is the distance between adjacent picks, or between a cross aisle and the nearest pick. The picker enters each aisle from front or back only as far as its largest gap and leaves the same way. The last aisle of a block is walked fully to reach the next cross aisle.
  - **Combined/composite (Roodbergen & de Koster 2001a):** each aisle with picks is visited once, in left-to-right or right-to-left order. A small dynamic program per block, with two states (picker at the front or rear of the block), decides whether to traverse each aisle or return.
  - **Aisle-by-aisle (Vaughan & Petersen 1999):** each main aisle is visited once. Cross aisles between aisles are chosen to minimize distance.
  - Note: Roodbergen's page does not describe return or midpoint routing.
- [ACADEMIC] Order picking may take up to 60% of all warehouse labor activities. — [Roodbergen](https://www.roodbergen.com/warehouse/background.php)
- [ACADEMIC] Largest gap is also described as "like S-shape" except that each aisle is split at its largest gap. — [arXiv 2002.00167, joint order batching and picker routing for large instances](https://arxiv.org/pdf/2002.00167)
- [ACADEMIC] A thesis (RePEc working paper) reports optimal tours 10.29%-39.08% shorter than heuristic tours in a chevron layout. In a conventional single-block warehouse, an S*-shape heuristic was 6.32%-35.34% longer than optimal. — [IDEAS/RePEc dar/wpaper/119000](https://ideas.repec.org/p/dar/wpaper/119000.html)
- [ACADEMIC] An "improved largest gap" method beat traditional largest gap at every order size tested, with the biggest advantage at small order sizes. — [core.ac.uk 31244699](https://core.ac.uk/works/31244699)
- [ACADEMIC] Travel makes up about half of total order-picking time (Dukic & Oluic 2007, *Int. J. Logistics Systems and Management*). This is the figure usually cited to explain why routing matters. — [Inderscience](https://www.inderscience.com/filter.php?aid=13214)

### Inferences
- [INFERENCE] With 1-15 picks (a single 1-5 line order, or a cluster cart of 3-8 orders with 5-25 lines), the search space is tiny. Held-Karp DP over picks is O(n²·2ⁿ), roughly 7M basic operations at n=15, which runs in milliseconds in TypeScript. Brute-force permutation is fine up to about n=9. So "optimal on a distance matrix" is reachable without Ratliff-Rosenthal's layout-specific DP. Ratliff-Rosenthal matters when you can't precompute shortest paths or lists are long. Neither applies here.
- [INFERENCE] Recommended stack:
  1. Precompute a shortest-path distance matrix between all pick faces, the depot/cart-staging point, and the pack station.
  2. Solve the open path (start = cart staging, end = pack station) exactly when there are 12 or fewer stops; Held-Karp handles open paths natively.
  3. Above that, use nearest neighbor, then 2-opt plus Or-opt until no improvement.
  4. Cap compute at about 50 ms.
  This is optimal in practice, layout-agnostic, and handles blocked or one-way aisles through the graph.
- [INFERENCE] The value of optimal over S-shape is largest for small, scattered pick lists. S-shape walks whole aisles for single picks, and the 6-39% gap ranges above come from such cases. For a 1-line order, any method that walks to the face and back is optimal. For 1-5 line single orders, gains over a static walk sequence are probably small; most of the benefit comes from batching and slotting.
- [INFERENCE] Nearest neighbor alone is a poor choice in aisle layouts. It can strand the picker at the far end of an aisle. Use it only as the starting tour for 2-opt.

### Gaps
- I could not access Petersen (1997) full-text percentages for each heuristic versus optimal by pick-list size, or the Roodbergen & de Koster (2001a) comparative tables. Only abstracts were reachable.
- I found no source that quantifies routing gains specifically for 1-5 pick lists in a small, single-block e-commerce warehouse.
- Return and midpoint heuristics were not described in the sources I fetched. They are standard (Hall 1993 is cited on the Roodbergen page), but I couldn't cite performance numbers for them.

## 2. Representing the warehouse as a graph (aisle nodes, cross-aisles, pick faces, one-way and blocked aisles, distance matrices, vertical levels, pick sequence numbers)

### Takeaway
Use a graph and a precomputed distance matrix. pgRouting, which Supabase supports, provides Dijkstra cost matrices and a TSP function natively. The same graph can also be loaded into TypeScript. Vertical levels and handling time are best modeled as per-pick service-time penalties, not as graph distance. A static pick-sequence number per location (a "walk order") is the cheap baseline and fallback.

### Cited Findings
- [DOCS] pgRouting's `pgr_dijkstraCostMatrix` uses Dijkstra to compute and return a cost matrix (start_vid, end_vid, agg_cost). That matrix is designed as input to `pgr_TSP`. `directed => false` gives a symmetric matrix on an undirected graph. — [pgRouting 3.4 pgr_dijkstraCostMatrix](https://docs.pgrouting.org/3.4/en/pgr_dijkstraCostMatrix.html); [pgRouting 3.3 pgr_TSP](https://access.crunchydata.com/documentation/pgrouting/3.3.4/pgr_TSP.html)
- [DOCS] In the pgr_TSP examples, vertices not connected to the rest of the graph are left out of the tour. A missing or blocked edge can therefore silently drop a pick, so validation is required. — [pgRouting 3.3 pgr_TSP](https://access.crunchydata.com/documentation/pgrouting/3.3.4/pgr_TSP.html)
- [DOCS] `pgr_bdDijkstraCostMatrix` (bidirectional Dijkstra) also feeds pgr_TSP, but it only processes edges with positive costs. — [pgRouting 3.3 pgr_bdDijkstraCostMatrix](https://access.crunchydata.com/documentation/pgrouting/3.3.4/pgr_bdDijkstraCostMatrix.html)
- [DOCS] Table naming changed between versions (2.x `edge_table`; 3.4 `edges`/`vertices`). Match the installed version. — [pgRouting 2.6 pgr_TSP](https://docs.pgrouting.org/2.6/en/pgr_TSP.html); [pgRouting 3.4](https://docs.pgrouting.org/3.4/en/pgr_dijkstraCostMatrix.html)
- [DOCS] Supabase supports pgRouting. Enable it from Dashboard > Extensions, or with `create extension pgrouting cascade;`. The Supabase docs page includes a traveling salesperson example. — [Supabase pgrouting docs](https://supabase.com/docs/guides/database/extensions/pgrouting.md)
- [ACADEMIC] Layout vocabulary for modeling: a warehouse is blocks of parallel aisles with storage on both sides. Front and rear aisles hold no items but allow aisle changes, and cross aisles sit between blocks. — [Roodbergen](https://www.roodbergen.com/warehouse/background.php)
- [ACADEMIC] Depot (pick-up/drop-off) location measurably affects route length. — [Petersen 1997 via IAOR](https://iaorifors.com/paper/23908)

### Inferences
- [INFERENCE] Suggested schema:
  - `wh_node(id, kind['aisle_end','cross_aisle','aisle_point','depot','pack'], x, y)`
  - `wh_edge(id, source, target, cost_m, reverse_cost_m)`: pgRouting convention; `reverse_cost < 0` marks one-way, and blocking means setting cost to -1 or deleting the edge.
  - `location(id, code 'A03-B05-L2', node_id, side['L','R'], level, walk_seq, x, y)`
  - `location_distance(from_loc, to_loc, meters)`: materialized; recompute when layout or edges change.
  
  Pick faces on both sides of an aisle map to the same `aisle_point` node at that bay's depth. For a few hundred locations, the full matrix is under 250k rows. In practice, only the matrix between graph nodes (aisle points, perhaps 100-300) is needed, plus a location-to-node lookup.
- [INFERENCE] Vertical levels: add a per-pick service time, not a distance. For example, `level_penalty_s`: about 0 s at waist level, extra seconds for floor level, and more if a step stool is needed. Optionally convert to meter-equivalents using walking speed (about 1 m/s is a common planning assumption; unverified here). Include it in the batching/cost objective and slotting, but not in sequencing, because the stop happens regardless.
- [INFERENCE] `walk_seq` (static pick sequence): assign every location an integer along a serpentine walk of the whole warehouse, which is S-shape over all aisles. Sorting picks by walk_seq gives an S-shape-quality route at zero compute. It works offline, on printed slips, and as a fallback when the solver fails. Store it as a column now even if dynamic routing is added later.
- [INFERENCE] For a single small block, a simple grid generator is enough: aisle count, bays per aisle, bay width, and cross-aisle positions produce nodes and edges. The ERP's warehouse-map editor can produce this automatically.

### Gaps
- I did not confirm which pgRouting version Supabase ships today, or which algorithm current `pgr_TSP` uses. Older docs mention simulated-annealing parameters; newer versions may use a different approximation. Check `select pgr_version();` on the project.
- No literature source fetched gives validated per-level time standards for ladder or step picks.

## 3. Order batching (seed and savings heuristics, time windows, capacity, affinity/zone), cluster picking vs batch-then-sort, single-line fast lanes, and when single-order picking is fine

### Takeaway
Even simple batching significantly beats first-come-first-served single-order picking. Petersen & Aase found batching gives the greatest savings of all policies tested, especially when orders are small. That describes Freeze Pipe's 1-5 line orders exactly. Seed heuristics are simple, transparent, and fast, and they pair well with S-shape routing and large cart capacity. Savings-type heuristics do better with largest-gap routing and small capacity. For glass items and 2-5 pickers, pick-to-tote cluster picking (sort-while-pick) avoids a separate sort step and is the natural fit. Batch-then-sort mainly suits single-line orders.

### Cited Findings
- [ACADEMIC] de Koster, van der Poort & Wolters (1999), "Efficient order batching methods in warehouses," *IJPR*:1479-1504:
  - Even simple batching methods significantly improve on FCFS.
  - Seed algorithms work best with S-shape routing and large pick-device capacity.
  - Time-savings (Clarke-Wright-style) algorithms work best with largest gap and small capacity.
  - If CPU time matters, simple seed algorithms are recommended.
  - Simplicity, transparency, and CPU time matter for real WMS use.
  
  — [EUR repository](https://repub.eur.nl/pub/11852); [WUR record](https://research.wur.nl/en/publications/efficient-orderbatching-methods-in-warehouses/)
- [ACADEMIC] Batching heuristic families are savings-based (adapting Clarke-Wright from vehicle routing), seed/priority-rule (seed introduced by Elsayed 1981), and others (metaheuristics). A seed method opens a batch with a seed order and then adds orders by a proximity rule. — [arXiv 2207.05305](https://arxiv.org/pdf/2207.05305)
- [ACADEMIC] Petersen & Aase (2004), *IJPE* 92(1):11-19. In a simulation starting from single-order picking, random storage, and simple routing, batching gave the greatest savings, especially with small orders. Class-based or volume-based storage gave nearly the same savings and was less sensitive to order size. — [IAOR 47394](https://www.iaorifors.com/paper/47394); [Petersen CV listing](https://accymac.niu.edu/_pdf/directory/petersen-charles-cv.pdf)
- [ACADEMIC] Re-batching and re-routing real data from a Finnish warehouse with simulated annealing cut travel distance about 16% over three months versus the existing method. The paper appears to be Matusiak et al., *EJOR* 236(3):968-977 (2014); attribution taken from the index page. — [IDEAS/RePEc](https://ideas.repec.org/a/eee/ejores/v236y2014i3p968-977.html)
- [ACADEMIC] Survey of order-batching solution approaches: Henn, Koch & Wäscher (2011) working paper. — [OVGU FEMM working paper](https://journals.ub.ovgu.de/index.php/FEMM-WPS/article/view/439/430)
- [VENDOR] Cluster picking definition: one picker, one pass, a cart with one tote per order. Gains come from less walking and less sorting at pack, since orders are separated during picking. It needs no conveyors or sorters, which suits smaller operations. Constraints: tote count per cart limits cluster size. The main risk is wrong-tote (put-to-wrong-container) errors, which need scan verification. — [ShipBob cluster picking guide](https://www.shipbob.com/au/blog/cluster-picking/); [Racklify: benefits and drawbacks](https://racklify.com/encyclopedia/cluster-picking-benefits-and-drawbacks-when-to-use-it-in-fulfillment/); [Racklify: cluster vs batch](https://racklify.com/encyclopedia/cluster-picking-vs-batch-picking-choosing-the-right-method/)
- [VENDOR, unclear provenance] A Racklify scenario reports 40% lower travel time per order after a cluster-picking trial. It is unclear whether this is a real case or an illustration, so treat it as anecdotal. Racklify also recommends piloting in one zone or SKU family first. — [Racklify step-by-step guide](https://racklify.com/encyclopedia/how-cluster-picking-works-step-by-step-guide-for-warehouse-managers/)
- [VENDOR] Trolley (cart) picking is presented as a productivity feature in mid-market WMSs (Aptean Proteus). — [Aptean](https://www.aptean.com/en-NZ/resources/industry-insights/blog/warehouse-software-proteus-wms-features-trolley-picking)

### Inferences
- [INFERENCE] **Recommended batching algorithm (seed + route-aware insertion, capacity-constrained):**
  1. Take the pool of released, unpicked orders and sort by priority: expedited first, then ship-by cutoff, then age.
  2. Seed with the highest-priority order.
  3. Repeatedly add the candidate order with the smallest marginal route cost (route(batch + o) - route(batch)), using the fast route evaluator from section 1. Respect the cart's tote-slot count, per-tote volume/weight (glass is bulky and fragile, so store SKU dims and a "fragile" flag), and optionally a max-lines-per-cart cap.
  4. Stop when slots are full or the best marginal cost exceeds a threshold. A good threshold is the cost of walking that order alone; otherwise it is better left for the next cart.
  
  This is a seed heuristic with a savings-style criterion. At this scale (tens to low hundreds of open orders), exact marginal-cost evaluation is cheap.
- [INFERENCE] Cheap proxy for marginal cost: overlap in aisles visited, or the minimum and maximum walk_seq span. Use it to pre-filter candidates before running full route evaluation.
- [INFERENCE] **Single-line fast lane:** single-unit and single-line orders need no per-order tote. Pick them in "batch-then-sort" mode: one bin, a route over all SKUs, then at pack each item is matched to its order by scanning (scan item, get oldest matching order, print label). Many small DTC shops use this pattern. Here it avoids burning tote slots on one-item orders. Multi-line orders go to the cluster cart with one tote per order.
- [INFERENCE] **When single-order picking is fine:** expedited or same-day exceptions, very large orders that fill a tote alone, oversized items, or when only 1-2 orders are open. The engine should allow a cart of one.
- [INFERENCE] Tote-slot count of about 6-12 per cart is typical of cluster carts. Make it a cart-profile setting (slots, slot volume, max weight) rather than a constant.

### Gaps
- Henn & Wäscher's numerical results (tabu search, ILS, savings vs seed gaps) were not retrievable from the abstracts found.
- I found no independent, non-vendor measurement of cluster-picking gains in a small DTC warehouse. The 40% Racklify figure is unverified.
- Quantitative guidance on optimal cart size versus pick density for 1-5 line orders was not found.

## 4. Wave vs waveless (continuous) picking for a ShipStation-driven flow; cutoffs and priority handling

### Takeaway
For e-commerce with orders trickling in all day, waveless/continuous release (build the next cart whenever a picker is free) is the generally recommended model. The main academic study confirms its advantages. Its main downside, sorter gridlock, applies to automated sorters that Freeze Pipe does not have. Waves still make sense at carrier cutoff times.

### Cited Findings
- [ACADEMIC] Gallien & Weber (2010), "To Wave or Not to Wave?", *M&SOM*. Wave (batch) release was the norm in warehouses with automated sorters. Continuous release is an emerging alternative adopted by several firms and has advantages. It requires more expensive technology and risks congestion-induced gridlock at the sorter. The study used data from a large U.S. online retailer. — [INFORMS](https://pubsonline.informs.org/doi/10.1287/msom.1100.0291); [LBS summary](https://www.london.edu/faculty-and-research/academic-research/t/to-wave-or-not-to-wave-order-release-policies-for-warehouses-with-an-automated-sorter)
- [VENDOR/trade press] A ProMat/MHI seminar argued waveless suits e-commerce better. The point quoted: "It's the exception processes that are driving waves crazy" (Eldred). — [Food Logistics](https://www.foodlogistics.com/warehousing/material-handling-equipment/news/12059607/mhi-promat-seminar-why-waveless-picking-makes-more-sense-for-ecommerce)
- [VENDOR] Downside of waves: a wave can't close until every order is done, which leaves pickers idle. Waves group orders by ship deadline, carrier schedule, location, or priority. One glossary claims 15-30% throughput gains from waves; that figure is unverified marketing. — [Fulfill.com glossary](https://www.fulfill.com/glossary/wave-picking)
- [VENDOR] Waveless: a continuous allocation engine evaluates incoming orders and releases tasks in real time, smoothing labor demand. — [Racklify waveless](https://racklify.com/encyclopedia/query/waveless-picking/); [Racklify continuous flow allocation](https://racklify.com/encyclopedia/foundations-of-continuous-flow-allocation/)
- [VENDOR/trade press] Eliminating batch processing to speed DC throughput (MMH article in results; not fetched in detail). — [MMH](https://www.mmh.com/article/eliminate_batch_processing_to_speed_dc_throughput)

### Inferences
- [INFERENCE] **Recommended release model, "pull-based waveless":** when a picker taps "Start cart," the engine builds the best batch from the current pool (section 3) and locks those orders. Lock with a `pick_batch` row plus row-level locking, e.g. `SELECT ... FOR UPDATE SKIP LOCKED` on orders, so two pickers never get the same order. Building at request time instead of on a timer gives the freshest pool and maximum batching density.
- [INFERENCE] **Cutoffs and priority:** score orders as `priority = w1*expedited + w2*(minutes until carrier cutoff)^-1 + w3*age`. Near a cutoff (for example, USPS pickup at 3 pm), switch to a "cutoff sweep": seed only with must-ship-today orders and lower the marginal-cost threshold so carts close faster. Expedited orders always seed a cart or are inserted into the next one built. Don't hold a cart waiting for more orders.
- [INFERENCE] **ShipStation integration:** order intake from ShipStation (or from Shopify directly into the ERP) feeds the pool. When a pick completes, the order is marked picked in the ERP, and labels are created at pack. Batching belongs entirely to the ERP; ShipStation only needs to know the order is ready to ship. (Integration details are covered by other research notes.)

### Gaps
- No academic source studies wave vs waveless for small, manual, sorter-less operations. The Gallien & Weber results are for a large automated DC.
- The 15-30% wave throughput figure has no traceable study behind it.

## 5. Zone picking and pick-and-pass for a team of 2-5 pickers

### Takeaway
I found no direct evidence for small teams. The literature I saw ties zoning to larger operations. For a single small block with 2-5 pickers and a few hundred SKUs, zone picking adds handoffs and consolidation overhead for little travel saved. The default should be cluster picking across the whole warehouse, with optional "soft zones" only if picker congestion appears.

### Cited Findings
- [ACADEMIC] The de Koster, Le-Duc & Roodbergen (2007) literature review, "Design and control of warehouse order picking," *EJOR* 182(2):481-501, is the standard reference for zoning as a decision alongside batching, routing, and storage assignment. Only the citation was retrieved, not its zoning findings. — [EUR repository](https://repub.eur.nl/pub/11877); [IDEAS](https://ideas.repec.org/a/eee/ejores/v182y2007i2p481-501.html)
- [VENDOR] Cluster picking needs no conveyors or sorters, which helps smaller operations or zones with mixed SKUs. — [Racklify](https://racklify.com/encyclopedia/cluster-picking-benefits-and-drawbacks-when-to-use-it-in-fulfillment/)

### Inferences
- [INFERENCE] Zone picking pays off when the pick area is large, pickers specialize (e.g., hazmat or high-value cages), or travel between zones dominates. None of these is evident at Freeze Pipe. Pick-and-pass needs a conveyor or handoff discipline and balanced zones; with 2-5 people, one absent picker unbalances it.
- [INFERENCE] One zone-like idea that may help: a small locked or secure high-value area (premium glass), handled as a separate pick task merged at pack, or always visited last.
- [INFERENCE] With 3+ pickers on concurrent carts, congestion in narrow aisles is possible. A simple mitigation: when building carts, slightly penalize batches whose aisle sets overlap with carts already in progress.

### Gaps
- I found no study quantifying zone vs cluster picking for teams under 5 people or warehouses under about 500 SKUs.

## 6. Slotting (ABC/velocity, cube-per-order index, affinity/co-pick clustering, golden zone, re-slot frequency, metrics)

### Takeaway
Slotting is one of the biggest levers alongside batching. Petersen & Aase found class/volume-based storage nearly matches batching's savings and is less sensitive to order size. Cube-per-order index (COI) is provably optimal only for single-command picking. For multi-line or batched picks, affinity (co-pick) slotting can matter. For a few hundred SKUs, simple ABC-by-picks near the pack station, plus golden-zone placement of A items, captures most of the value.

### Cited Findings
- [ACADEMIC] Class-based or volume-based storage gives nearly the same savings as batching and is less sensitive to average order size. — [Petersen & Aase 2004, IAOR](https://www.iaorifors.com/paper/47394)
- [ACADEMIC] Class-based storage reduces picker travel versus random storage and approaches volume-based (full turnover) storage performance (Petersen, Aase & Heiser 2004, *IJPDLM*). — [Emerald](https://www.emerald.com/insight/content/doi/10.1108/09600030410552230/full/html)
- [ACADEMIC] COI ranks SKUs by required storage space per pick frequency; low COI goes closest to the depot. COI is known to minimize travel for single-command picking. For multi-command (several picks per route) it is no longer optimal, and the paper argues the worst case can be unbounded. — [Schuur, MHI Colloquium 2014](https://og.mhi.org/downloads/learning/cicmhe/colloquium/2014/24-Schuur%20paper.pdf)
- [ACADEMIC] Order-oriented slotting (Mantel, Schuur & Heragu 2007) places items that appear together in orders close together. The problem is computationally hard, so heuristics are proposed. — [Inderscience](https://www.inderscience.com/offer.php?id=14689)
- [ACADEMIC] Bartholdi & Hackman's *Warehouse & Distribution Science* (free PDF) covers order picking, storage locations, and fast-pick area design. It may be freely copied for educational purposes with attribution. — [Georgia Tech PDF v0.98](https://www2.isye.gatech.edu/~jjb/wh/book/editions/wh-sci-0.98.pdf)
- [ACADEMIC, secondary] A USPTO patent cites Bartholdi & Hackman (2010) as attributing about 55% of warehouse operating costs to order picking. This comes from a search snippet; I did not verify which patent text or the edition. — [USPTO](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/10956858)

### Inferences
- [INFERENCE] **Practical slotting for Freeze Pipe:**
  1. Compute picks (order lines, not units) per SKU over the trailing 60-90 days.
  2. Classify ABC by cumulative pick share; a typical pattern is about 80/15/5, to be verified on real data.
  3. Rank locations by distance to the pack/cart-start point (from `location_distance`) and by level ergonomics, with waist-to-shoulder level as the "golden zone."
  4. Put A SKUs in the best locations, adjusted for size: large, light glass pieces may not fit golden-zone bays, which is where COI's space term matters.
  5. Then apply an affinity nudge. Using co-pick counts from order lines (pairs of SKUs in the same order), keep strong pairs in the same aisle or bay where it doesn't push A items out of prime spots.
- [INFERENCE] **Re-slotting cadence:** re-slot only on a meaningful change. Examples: a new product launch, a seasonal shift, or an SKU moving between A and C. Run a monthly report of "misslotted" SKUs (rank of velocity vs rank of location quality) and move the top 10-20 offenders. Full re-slots are labor-heavy and confuse pickers who memorize locations. The ERP can generate a move list with the projected travel saving.
- [INFERENCE] **Simulation:** with the route engine, a candidate slotting can be scored by replaying last month's orders through the batching and routing engine and comparing total meters. This gives an internal, evidence-based estimate of the gain before moving anything.
- [INFERENCE] **Fragility:** glass breakage risk argues for keeping heavy or large items at low or waist level and not above shoulder height. This is also a golden-zone consideration.

### Gaps
- I could not extract Bartholdi & Hackman text on fast-pick area sizing, "viscosity," or pick density; the PDF wasn't parseable in this session.
- I found no cited quantitative guidance on re-slot frequency, and no sourced golden-zone height standards or productivity gains.
- Slotting vendors suggested in the brief (Optioryx, Slot3D, Lucas) were not reached, so no vendor gain claims are reported.

## 7. Practical implementation: libraries (JS/TS, Python, OR-Tools, jsprit), Postgres (pgRouting) vs edge function vs client-side, and complexity vs benefit

### Takeaway
At Freeze Pipe's scale, there is no need for OR-Tools or a VRP solver. A few hundred lines of TypeScript (Dijkstra/Floyd-Warshall, Held-Karp for 12 or fewer stops, NN + 2-opt/Or-opt above that, seed batching) covers everything. That code can run in a Deno edge function or in the browser. pgRouting on Supabase is a valid alternative for the distance matrix and routing. OR-Tools has no maintained official JS binding.

### Cited Findings
- [DOCS] Google OR-Tools officially supports C++, Python, C#, and Java. No official JavaScript/TypeScript wrapper was found. — [GitHub google/or-tools](https://github.com/google/or-tools); [Google OR-Tools site](https://developers.google.com/optimization?hl=de)
- [DOCS] `node_or_tools` (Mapbox) is a Node binding for OR-Tools TSP/VRP. It is dated, targeting Node LTS 4/6 with a 2017 copyright. `@revolugo/ortools` wraps only integer-programming classes, not routing. — [mapbox/node-or-tools](https://redirect.github.com/mapbox/node-or-tools); [npm @revolugo/ortools](https://npmjs.com/package/@revolugo/ortools)
- [DOCS] Python 2-opt packages exist (py2opt; tspy says 2-opt "gives good solutions rather quickly"). — [PyPI py2opt](https://pypi.org/project/py2opt/1.1.6/); [tspy](https://pypi.tcis.de/data/web/json/tspy)
- [DOCS] JS/TS TSP packages on npm are mostly small or low-maintenance (e.g., a functional-JS genetic algorithm solver). — [ecosyste.ms npm "TSP" keyword](https://packages.ecosyste.ms/registries/npmjs.org/keywords/TSP)
- [DOCS] pgRouting is available on Supabase and supports `pgr_dijkstraCostMatrix` feeding `pgr_TSP`. — [Supabase pgrouting](https://supabase.com/docs/guides/database/extensions/pgrouting.md); [pgRouting docs](https://docs.pgrouting.org/3.4/en/pgr_dijkstraCostMatrix.html)
- [ACADEMIC] Practical WMS batching should favor simplicity, transparency, and low CPU time. Simple seed algorithms are recommended when CPU time is critical. — [de Koster et al. 1999](https://repub.eur.nl/pub/11852)

### Inferences
- [INFERENCE] **Where to run what:**
  - **Postgres (SQL/RPC):** the source of truth for the layout graph, locations, the materialized `location_distance` matrix, and batch/pick-task tables. Batch claiming uses `FOR UPDATE SKIP LOCKED`. The matrix can be built once with pgRouting (`pgr_dijkstraCostMatrix`) or with a TS script that writes the table. pgRouting is optional; a 300-node graph is small enough for TS Floyd-Warshall (27M operations).
  - **Deno edge function `build-pick-batch`:** loads the open order pool, SKU-to-location map, and the distance-matrix subset. It runs seed batching with route-aware insertion and the TSP sequence, then writes `pick_batch`, `pick_batch_tote`, and `pick_task(seq, location, sku, qty, tote_slot)` in one transaction (or calls an RPC that does). Server-side keeps it authoritative and race-free across pickers.
  - **Client (React):** re-sequences the remaining tasks from the picker's current location after a skip, deviation, or short. This needs the matrix subset for the batch's locations, which is tiny, so the same TS routing module can be shared between Deno and the browser.
- [INFERENCE] **Complexity vs benefit, in suggested build order:**
  1. Location codes + `walk_seq` + scan-verified pick-to-tote with a sorted list. This captures most of the value.
  2. Seed batching with tote/cart capacity and priority/cutoffs.
  3. Graph + distance matrix + exact or 2-opt routing.
  4. Slotting analytics and re-slot suggestions.
  5. Congestion awareness and multi-picker coordination.
  
  Each step is independently useful.
- [INFERENCE] Avoid pgr_TSP for the open start-to-end path unless the docs for the installed version confirm start/end vertex support and an exact or good-quality algorithm for small n. A TS Held-Karp gives deterministic optimal results for n ≤ 12-15.
- [INFERENCE] jsprit (Java) and OR-Tools (Python) would need a separate service, which isn't justified at this scale. Revisit only if the business moves to multi-site, large catalogs, or time-windowed VRP.

### Gaps
- I did not benchmark any JS TSP library or verify a currently maintained TypeScript 2-opt package. The ecosystem looked thin, which supports writing it in-house.
- The pgRouting version on the target Supabase project and current pgr_TSP algorithm details are unverified.

## 8. Human factors: presenting the "next location," re-sequencing after deviation, skip/short handling, and measuring improvement (baseline KPIs)

### Takeaway
I found almost no sourced, non-vendor guidance on picker UI design. The cited evidence is mainly that wrong-tote errors are the key cluster-picking risk and need scan verification, and that changes should be piloted and measured. The UI and KPI recommendations below are engineering inferences.

### Cited Findings
- [VENDOR] Wrong-to-container errors are the main cluster-picking risk and are hard to detect without scanning and verification. Pilot in one zone or SKU family and measure travel and error impacts before scaling. — [Racklify](https://racklify.com/encyclopedia/cluster-picking-benefits-and-drawbacks-when-to-use-it-in-fulfillment/); [Racklify step-by-step](https://racklify.com/encyclopedia/how-cluster-picking-works-step-by-step-guide-for-warehouse-managers/)
- [VENDOR/trade press] In waves, exception processes (shorts, holds) drive inefficiency. Exception handling deserves first-class design. — [Food Logistics / ProMat](https://www.foodlogistics.com/warehousing/material-handling-equipment/news/12059607/mhi-promat-seminar-why-waveless-picking-makes-more-sense-for-ecommerce)

### Inferences
- [INFERENCE] **Next-location screen:** one large card showing the location code split into readable parts (AISLE 3 / BAY 5 / LEVEL 2), SKU image (important for visually similar glass pieces), name, quantity, and target tote slot with a color or letter (e.g., "Put 2 in Tote C"). Use a strip of the next 2-3 stops as a preview. A small optional mini-map (warehouse SVG with a highlighted path and current position) helps training. The primary interaction should be scan-driven: scan location (optional), then scan item, then scan tote, with haptic/audio feedback and a hard stop on a wrong item or tote.
- [INFERENCE] **Deviation and skip:** when a picker scans an out-of-sequence location or item that belongs to the batch, accept it and re-solve the remaining sequence from that location client-side. A "skip for now" option moves the task to the end and re-solves. Never force backtracking.
- [INFERENCE] **Short pick:** a "short" action records the found quantity, creates an inventory exception task (cycle count of that location), and flags the order tote. Policy options: ship partial, hold the tote, or substitute. Shorted orders shouldn't block the rest of the cart; at pack, the tote shows a red "incomplete" state.
- [INFERENCE] **Baseline KPIs (capture 2-4 weeks before go-live from the current ShipStation slip flow, timing manually or with scan timestamps):**
  - Orders per labor hour.
  - Lines per hour and units per hour.
  - Average pick time per order (cart start to cart drop).
  - Travel distance per line, estimated from the route model. Compute it for the old flow by replaying historical orders as single-order walk_seq routes.
  - Mis-pick and wrong-tote rate.
  - Short rate.
  - Order dock-to-stock is out of scope; instead track order-release-to-packed time and the percent shipped by cutoff.
  
  After launch, the system logs every scan with a timestamp, so KPIs come for free. Compare by week and picker, and A/B test (e.g., walk_seq vs optimized routing on alternate carts) to measure routing's marginal value separately from batching.
- [INFERENCE] **Simulation before rollout:** replay last month's orders through (a) single-order walk_seq, (b) batched walk_seq, and (c) batched optimal routing to estimate meters saved for each layer. This gives Freeze Pipe its own evidence instead of relying on vendor percentages.

### Gaps
- I found no peer-reviewed or rigorous practitioner study on the mobile UI for guided picking (list vs map, preview depth), or on the effect of re-sequencing on picker acceptance.
- No sourced KPI benchmarks for small DTC warehouses (e.g., typical lines per hour for cart picking) were found. Vendor benchmarks were not retrieved.
- Practitioner blogs named in the brief (Logiwa, ShipHero, Peoplevox, Deposco, Hopstack, Easy WMS, Lucas Systems) were not reached within the tool budget.
