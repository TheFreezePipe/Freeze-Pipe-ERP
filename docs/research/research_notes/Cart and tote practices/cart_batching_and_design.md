# Picking-Cart Design and Batch (Cluster) Picking Parameters for Small E-commerce Warehouses (as of Oct 2026)

Evidence labels used throughout: **[Study]** = peer-reviewed or academic work; **[Ergonomics std]** = published ergonomics guidance; **[Vendor]** = product page or vendor/WMS marketing or docs; **[Practitioner]** = blog or guide by a 3PL, consultancy or software firm (not independently validated); **[Inference]** = my own reasoning from the cited material and the plan's numbers, not a sourced fact.

Research limits: about 17 search/fetch calls. Full texts of de Koster et al. (2007), Henn & Wascher (2012) and Bartholdi & Hackman were **not** retrieved. Academic claims below come from abstracts, publisher pages and citing papers. No source gave a measured curve of travel saving against batch size for a warehouse this small.

---

## 1. Batch/cluster size: orders per batch vs travel savings, practical batch sizes, capacity-constrained batching

### Takeaway
The academic literature agrees that batching is the policy with the largest travel-time savings, and the savings are biggest when orders are small (1-5 lines fits that case). No retrieved source quantifies diminishing returns by batch size. Practitioner guidance puts cluster sizes at roughly 4-25 orders, with 12 a common commercial cart size. A 14-order cart is inside that range. In a 3,500 sq ft building, though, the route length saturates after about 10-15 picks, so most of the travel saving per order has already been captured by around 8-10 orders (inference).

### Cited Findings
- **[Study]** Petersen & Aase (2004) simulated a manual picking operation and compared batching, storage and routing policies against picking one order at a time. Batching gave the greatest savings, especially at smaller average order sizes. Class-based and volume-based storage gave nearly equivalent savings and were less sensitive to order size. — [ResearchGate abstract](https://www.researchgate.net/publication/222974621_A_comparison_of_picking_storage_and_routing_policies_in_manual_order_picking); [Scirp reference record (IJPE 92, 11-19)](https://www.scirp.org/reference/referencespapers?referenceid=1938860)
- **[Study]** Citing papers report that Petersen & Aase found batching affected picking time more than routing or storage choices, and that overly complicated routing or storage adds unnecessary cost. The simulation used fixed order sizes. — [Search summary of citing literature; Petersen & Aase on Scribd](https://www.scribd.com/document/76331596/Charles-G-Petersen-Gerald-Aase-2004)
- **[Study]** Gademann & van de Velde (2005, IIE Transactions 37(1):63-75) say picking may be up to 60% of warehouse labor and up to 65% of operating expense. Their abstract notes that practice relies on "simple rules of thumb or straightforward constructive heuristics", even in state-of-the-art WMSs. They prove the batching problem minimizing total travel is NP-hard in the strong sense, but polynomial if no batch contains more than two orders. They solve it by branch-and-price. — [repub.eur.nl record](https://repub.eur.nl/pub/12328/)
- **[Study]** de Koster, Le-Duc & Roodbergen (2007), "Design and control of warehouse order picking: a literature review," EJOR 182(2):481-501, is the standard review. Only the bibliographic record was retrieved, not its batching content. — [IDEAS/RePEc](https://ideas.repec.org/a/eee/ejores/v182y2007i2p481-501.html)
- **[Study]** A journal article citing Bartholdi & Hackman says walking is more than half of order-picking time. A 1999 study describes first-come-first-served filling "until the pick device is full" as a common practical batching rule. — [Studia i Prace WNEiZ US](https://wnus.usz.edu.pl/sip/en/issue/361/article/5863)
- **[Study]** Batching cuts travel two ways: fewer trips, and shorter individual trips. A very-narrow-aisle warehouse simulation found that picking by article rather than by order cut absolute travel distance by 10.2%. Sorting articles back into orders then added 36.4% to travel distance, which shows how sort/deconsolidation work can wipe out batch gains. — [Tandfonline, Simulation and order picking in a VNA warehouse](https://www.tandfonline.com/doi/full/10.1080/1331677X.2018.1505532)
- **[Study]** Batching models generally treat picker or device capacity as a hard constraint on batch size. Larger capacity gives the algorithm more room to combine orders. None of the retrieved sources quantified the gain as a function of capacity. — [ResearchGate: Order batching using an approximation for distance travelled](https://www.researchgate.net/publication/338667621_Order_batching_using_an_approximation_for_the_distance_travelled_by_pickers); [ResearchGate: Large-scale order batching in parallel-aisle systems](https://www.researchgate.net/publication/232883450_Large-scale_order_batching_in_parallel-aisle_picking_systems)
- **[Practitioner]** Rule of thumb from one implementation guide: 8-15 orders per batch for paper-based systems, 12-25 for RF-scanner systems. The same guide says too large a batch causes congestion and long sorting times, while too small loses efficiency. — [Pallite: How to implement batch picking](https://pallitegroup.com/en/news/how-to-implement-batch-picking/)
- **[Practitioner]** Cluster sizes of 4-8 orders, and 4-20 depending on cart size and order profile. One guide says a pick cart should hold 10-12 orders. — [Optioryx: picking strategies](https://www.optioryx.com/blog/complete-guide-warehouse-picking-strategies); [Optioryx: cluster vs batch](https://www.optioryx.com/blog/cluster-vs-batch-picking)
- **[Vendor]** Claim of "up to 40%" travel reduction from batching. It is unsourced marketing. — [NetSuite](https://www.netsuite.com/portal/resource/articles/inventory-management/batch-picking.shtml)
- **[Vendor]** SKUSavvy's pick-to-tote batching takes the cart's tote count as the batch size, one order per tote. — [SKUSavvy docs](https://www.skusavvy.com/docs/guides/warehouse/pick-to-tote)

### Inferences
- **[Inference] Diminishing returns in this building.** Assume picks spread uniformly over about 5 pick faces/aisles. The expected number of aisles visited with k picks is m(1-(1-1/m)^k). For m=5 that gives 3.4 aisles at k=5 picks, 4.5 at k=10, 4.9 at k=20, and 5.0 at k=25. After about 10-15 picks, nearly every aisle is visited anyway, so route length stops growing and travel per order falls roughly as 1/n. Going from 8 to 14 orders cuts travel per order by about 40%. In absolute terms that is small: a full loop of a 3,500 sq ft building is probably about 150-300 ft, so roughly 5-15 s per order. Above about 10-12 orders, cart size here is driven more by fewer cart cycles and hand-offs than by walking.
- **[Inference]** Petersen & Aase found batching beats routing in importance. For this plan, cart capacity and the release rule matter more than the "optimized route" feature. In a 5-run building, a simple S-shape or return route is close to optimal.
- **[Inference]** The gains in the literature come from larger facilities where travel is about 50% or more of time. In a tiny building, per-pick handling and scanning (and careful handling of glass) take a larger share. Batch size therefore moves throughput less than the textbook results suggest.

### Gaps
- Henn & Wascher (2012, EJOR tabu-search batching) and the Bartholdi & Hackman batching chapter were not retrieved, so their numbers are not reported. No source gave a measured curve of savings against batch size (6/8/10/12/16/20/24) for a small facility.
- No source tied the optimal batch size to lines per order quantitatively. Petersen & Aase say only that batching helps most for small orders.

---

## 2. Cart configurations in practice (totes per cart, dimensions, ergonomics, labeling, devices)

### Takeaway
Commercial tote-picking carts usually hold 6-12 totes on 3 shelves. The 12-tote Uline cart with 18x13x12 totes is 68x28x70 in and rated 1,000 lb. Narrow carts down to 18.5 in wide exist for tight aisles. Ergonomic guidance points to a push handle near elbow height (about 35 in) and an initial push force at or under about 50 lb. A 48x24 in cart is compact by commercial standards and fits easily in 7-9 ft aisles. Whether 14 totes physically fit on it depends on the totes' **outside** dimensions, which for stack-nest totes are much larger than the nominal size.

### Cited Findings
- **[Vendor]** Uline H-9094 Tote Picking Cart: 68 x 28 x 70 in, three slanted shelves (shelves 58 x 16 in), 1,000 lb capacity, 5 in polyurethane casters (2 rigid, 2 swivel with brakes). Includes 12 corrugated plastic totes, 18x13x12 in, rated 80 lb each. Price $610 each, or $595 at 3+, per an Aug 2026 page capture. — [Uline H-9094BL](https://www.uline.com/Product/Detail/H-9094BL/Stock-Picking-Carts/Tote-Picking-Cart-18-x-13-x-12-Black-Totes); [Uline H-9094R](https://www.uline.com/Product/Detail/H-9094R/Stock-Picking-Carts/Tote-Picking-Cart-18-x-13-x-12-Red-Totes)
- **[Vendor]** Rubbermaid/RCP 2144269 tote picking cart: 3 angled shelves, 57 x 18.5 x 55 in, 450 lb capacity. Marketed as fitting "the narrowest aisles" at 18.5 in wide. Totes not included. — [Azor listing](https://shop.azorinc.com/Product/RCP/2144269/RCP2144269); [MyWorkSupply](https://myworksupply.com/products/tote-picking-cart-metal-3-shelves-450-lb-capacity-57-x-18-5-x-55-red)
- **[Vendor]** National Cart sells tote pick carts holding 6-8 totes. The Peggs Company sells a 6-tote "e-commerce picking cart." A Dynamics 365 example process uses 12 totes. — [National Cart](https://nationalcart.com/product-category/tote-pick-carts/); [Peggs](https://thepeggscompany.com/product/e-commerce-picking-cart/); [Dynamics community](https://community.dynamics.com/blogs/post/?postid=0fd44b78-2e41-4c14-a60e-2aac6683e888)
- **[Practitioner/WMS vendor]** Warehance cart-setup guidance:
  - Cart height about 4.5-5 ft. Keep carts narrow, and avoid extra-long carts that cause gridlock when pickers pass.
  - Tote count should follow product size.
  - Label each tote with a barcode plus large text in the format cart number / shelf colour / position, e.g. "8 Red 1". One colour per shelf (red, blue, yellow, green), positions 1-4 across. Colour is faster than numbers alone.
  - Give the tablet or phone a designated spot on the cart.
  - Leave the bottom shelf for oversized orders instead of keeping dedicated large-item carts that sit idle.
  - Add carts if pickers wait for them; remove carts if they sit unused.
  - [Warehance blog](https://warehance.com/blog/how-to-set-up-your-picking-carts-for-maximum-efficiency)
- **[Vendor]** Newcastle Systems (mobile powered carts) says four swivel casters turn tighter than fixed-wheel setups. Larger casters roll more smoothly. Carts should run parallel to racks with minimal protrusions, and locking casters hold the cart during scanning. No numbers given. — [Newcastle: aisle-friendly cart design](https://www.newcastlesys.com/blog/aisle-friendly-cart-design)
- **[Ergonomics std]** Liberty Mutual / Snook & Ciriello tables give maximum acceptable push forces. A safety summary of the 1991 guidelines suggests a starting push force of 50 lb or less, assuming a handle around waist height or a little higher. It cites Hoozemans et al. (1998) for a preferred handle height near elbow height, about 35 in. — [State Fund CA ErgoMatters: Carts](https://content.statefundca.com/safety/ErgoMatters/Carts.asp); [Snook Tables guide](https://ergo-plus.com/wp-content/uploads/Snook-Tables-Guide-v-5.0.pdf)
- **[Study]** A CDC-hosted analysis concluded the 1991 push/pull recommendations remain reasonable, and gave regressions of force against handle height, frequency and distance. Steele et al. (2014) found some sustained-push table values exceed physiological criteria. — [CDC stacks 36973](https://stacks.cdc.gov/view/cdc/36973/cdc_36973_DS1.pdf); [CDC stacks 230763](https://stacks.cdc.gov/view/cdc/230763/cdc_230763_DS1.pdf)
- **[Regulatory, via practitioner]** OSHA (1910.176, 1910.22) requires "sufficient safe clearances" and marked permanent aisles but sets no fixed aisle width for manual carts. State and local fire codes may be stricter. — [ifactory summary](https://ifactoryapp.com/industries/manufacturing-plant/aisle-width-clearance-fire-code-osha-compliance); [J.J. Keller](https://jjkellercompliancenetwork.com/news/optimizing-safety-the-importance-of-understanding-aisle-width-in-your-facility)
- **[Vendor]** Stack-and-nest totes are sold by **inside** dimensions, and the outside is much larger. Uline S-14602 "16 x 11 x 5" is 16x11x5 in inside but **20 x 13 x 6 in outside** (0.6 lb), $15/$14/$13 each at 3/12/24+ (Jul-Aug 2026 capture). Uline does not list a 16x11x8 stack-nest size. — [Uline S-14602](https://www.uline.com/Product/Detail/S-14602GR/Stack-and-Nest-Containers/Stack-and-Nest-Container-16-x-11-x-5-Gray); [Uline stack-and-nest category](https://www.uline.com/BL_314/Stack-and-Nest-Containers)

### Inferences
- **[Inference] Aisle fit.** A 24 in wide cart in a 7-9 ft (84-108 in) aisle leaves 60-84 in, enough for a picker beside the cart or two carts passing. The cart's diagonal is about 54 in, so turning at aisle ends is not a concern. The aisle is generous; width is not a constraint.
- **[Inference] Shelf geometry is the real risk.** A 48x24 shelf holds 12 standard + 2 large only if the standard tote's outside footprint is about 16x11-12 in: 3 across x 2 deep on each of two shelves (6+6), with 2 large 21x15 totes side by side (42 in) on the third. If "16x11x8" is the inside size and the outside is about 20x13 like Uline's 16x11 family, a 48x24 shelf fits only 2-3 totes per shelf (48/20 = 2.4; 48/13 = 3.7 one-deep). That gives about 8-9 standard slots, not 12. Confirm the exact SKU's outside dimensions before buying the cart.
- **[Inference]** A 2-deep layout means back-row totes are reached from the other side of the cart. That works in 7-9 ft aisles but adds walk-around steps. A slanted-shelf, 1-deep layout (like Uline's 58x16 shelves) needs a longer cart for the same slot count.
- **[Inference]** A 48x24 cart is shorter than common 57-68 in commercial carts. That is a plus for maneuvering and a minus for slot count. With 14 totes of glass (say 3-8 lb each, about 40-110 lb) plus cart weight, push force on 5 in polyurethane casters should stay well under the 50 lb starting guideline. Set the handle at about 35-42 in.

### Gaps
- Global Industrial, Akro-Mils, Quantum, Bito, SSI Schaefer, Pickpro, Fastbins, Lightning Pick and Zebra specs were not retrieved in this pass. No source gave a numeric turning radius or push force for a loaded tote cart.

---

## 3. Throughput benchmarks for cart cluster picking

### Takeaway
Published benchmarks are mostly vendor or practitioner figures and inconsistent: about 50-85 lines/hour for experienced cart pickers (35-50 for new hires) and 60-120 items/hour for "well-optimized" cluster picking. No retrieved source gave orders/hour or minutes per cart for 10-14 order carts. Using these ranges, a 14-order cart takes about 20-40 minutes to pick, and Q4 90th-percentile volume needs about 3 pickers.

### Cited Findings
- **[Practitioner]** Pallite: experienced pickers 60-85 lines/hour; new workers 35-50. — [Pallite eaches KPIs](https://pallitegroup.com/en/news/kpis-for-eaches-picking/)
- **[Practitioner]** A "well-optimized cluster picking operation" reaches 60-120 items/hour at >99.5% accuracy. The source adds that benchmarks vary widely by industry and size. — [Item.com glossary](https://www.item.com/glossary/cluster-picking)
- **[Practitioner]** One 3PL glossary gives a target of 50+ lines/hour and says cluster picking roughly doubles picks/hour compared with single-order picking. — [Logos 3PL](https://www.logos3pl.com/glossary/cluster-picking/)
- **[Practitioner]** Optioryx says published pick rates range widely (about 71 picks to 175 pieces/hour) and recommends using your own baseline. — [Optioryx: measuring picking performance](https://www.optioryx.com/blog/improving-warehouse-picking-performance)

### Inferences
- **[Inference] Sizing math.** The plan does not state lines/order. Assume about 1.5-2 lines/order, so a 14-order cart is about 21-28 lines:
  - At 60-85 lph: about 15-28 min per cart, about 30-55 orders per picker-hour.
  - At 35-50 lph (new hires, fragile handling): about 25-48 min per cart.
  - Daily load: median 217 orders is about 16 carts, 4-7 picker-hours. Q4 p90 609 is about 44 carts, 11-20 picker-hours. Max 758 is about 54 carts, 14-25 picker-hours.
  - Two pickers at about 7 productive hours give 14 h, which is marginal at Q4 p90. The planned third Q4 picker is consistent with this math. Pile and bulk lanes would take orders off carts and lower these figures.
- **[Inference]** In a 3,500 sq ft building, walk time per line is low, so the main drivers are scan steps (location, item, tote = up to 3 scans per line), careful placement of glass, and stops per cart. Removing one scan per line (for example, tote scan only on the first put into each tote) may matter more than adding orders per cart.
- **[Inference]** Packing fragile glass (wrapping, void fill) is likely slower per order than picking. Pack rate, not pick rate, will probably set daily capacity. Measure both before fixing cart counts.

### Gaps
- No primary time-study data on 10-14-order carts in small e-commerce sites. No orders/hour benchmark specific to cluster picking. Lucas, Honeywell, ShipHero, Logiwa, Easy WMS and Veeqo benchmark pages were not retrieved.

---

## 4. Tote sizing practice (picking totes vs order contents, fragile goods, colour, barcodes, cost)

### Takeaway
Size totes to the **items** in the order, not the shipping box. Fragile-goods guides recommend foam-lined or divided totes and one order per tote, kept separate. Stack-nest totes are cheap (about $13-15 each for a 16x11x5 at Uline) but tapered, and are sold by inside dimensions. Barcode plus large human-readable text on the front of each tote is standard practice.

### Cited Findings
- **[Vendor]** Uline 16x11x5 stack-nest tote: inside 16x11x5 in, outside 20x13x6 in. Stacks when full and nests when empty. $13-15 each; lids sold separately. — [Uline S-14602](https://www.uline.com/Product/Detail/S-14602GR/Stack-and-Nest-Containers/Stack-and-Nest-Container-16-x-11-x-5-Gray)
- **[Vendor]** Uline's 12-tote cart uses 18x13x12 corrugated plastic totes rated 80 lb. — [Uline H-9094](https://www.uline.com/Product/Detail/H-9094BL/Stock-Picking-Carts/Tote-Picking-Cart-18-x-13-x-12-Black-Totes)
- **[Practitioner]** Warehance: tote count should follow product size, with larger products needing fewer, larger totes. Pick totes with a front shape that eases grabbing and placing. Label each tote with a barcode and large readable text. — [Warehance](https://warehance.com/blog/how-to-set-up-your-picking-carts-for-maximum-efficiency)
- **[Practitioner]** Fragile and glass guidance:
  - Foam-lined totes, corrugated partition trays or divided bins, plus carts with cushioned surfaces and separators to keep bottles upright ([Racklify: glass bottle fulfillment](https://racklify.com/encyclopedia/how-glass-bottle-fulfillment-works-processes-best-practices/)).
  - Divided totes or trolleys let pickers batch several orders while keeping them separate, and fewer touches mean less breakage ([Pallite: storing glass bottles](https://pallitegroup.com/en/news/how-to-store-glass-bottles/)).
- **[Practitioner]** One illustrative case reports that moving to 12-cell partitions cut glass-jar breakage from 4% to 0.5% for $0.08 more per jar. It is an anecdote, not independent data. — [Racklify: cellular partitions](https://racklify.com/encyclopedia/query/cellular-partition/)

### Inferences
- **[Inference] Fit against the plan's box profile.** A 12x5x5 shipping box (46% of orders) implies contents of about 10x3x3 in or less, which fits a 16x11x8 tote easily. The 14x12x6 class (80% cumulative) implies items up to about 12x10x4, which fits. The 18x12x8 class (94% cumulative) implies items up to about 16x10x6, borderline in a 16x11 tote, especially at the tapered bottom.
- **[Inference] Large-slot demand is 6-20% of orders**, depending on where the cutoff falls. With 2 large slots per 14-order cart and orders assigned at random:
  - If p = 6%, about 95% of carts need 2 or fewer large slots.
  - If p = 20%, only about 45% do.
  - Batching therefore needs to be capacity-aware by slot type: fill large slots from a separate large-order queue rather than taking orders FIFO.
- **[Inference]** For glass, a thin foam pad in each tote floor is cheap insurance, and a single cut foam sheet per shelf would also work. Placing tote-in-tote (nesting) when transferring to pack is a breakage risk, so totes should go onto a shelf one high.
- **[Inference]** Stack-nest walls taper, so the tote floor is smaller than the nominal (top) inside dimension. Long glass items lying flat may not fit even when the nominal size suggests they do.
- **[Inference]** Permanent tote barcodes with WMS assignment of tote to order per cart load is standard. Colour per shelf (or per cart) plus big slot numbers speeds the put.

### Gaps
- No source on tote cost/size trade-off specific to glassware or smoking accessories. No retrieved specs for a 16x11x8 stack-nest tote (outside dimensions, taper, weight rating).

---

## 5. Pack-station hand-off: parking carts vs decanting; carts per picker

### Takeaway
I found no published norm for carts per picker. The practitioner rule is to add carts when pickers wait and remove them when carts sit idle. Two carts per picker (one picking, one parked) is the minimum double buffer: any time packing a cart takes longer than picking one, the picker idles. Put walls suit batch-then-sort of overlapping SKUs; cluster carts with order totes do not need one.

### Cited Findings
- **[Practitioner]** "Add carts if pickers wait for them; reduce carts if they sit unused." Start small and scale. — [Warehance](https://warehance.com/blog/how-to-set-up-your-picking-carts-for-maximum-efficiency)
- **[Practitioner]** Cluster carts are faster than single-order picking with less sorting, but cart space limits scaling. Put walls sort batch-picked items into order cubbies. — [SPS Commerce: Pick and Pack 101](https://www.spscommerce.com/community/articles/pick-and-pack-101-methods-kpis-costs-and-tech)
- **[Vendor]** Softeon claims put walls with good software can beat pick carts on cost and throughput. This is a vendor claim. — [Softeon](https://www.softeon.com/blog/understanding-opportunities-put-walls-order-picking)
- **[Practitioner]** Keep the number of active order slots at pack matched to the order profile. Too many open orders block aisles and slow packing. — [Cleverence: layout hacks](https://www.cleverence.com/amp/articles/3pl-business/10-warehouse-layout-hacks-for-better-flow-3847/)

### Inferences
- **[Inference] Two carts per picker is a two-slot buffer between picking and packing.** With pick time P and pack time K per cart, the picker blocks whenever K > P on a given cycle, and the packer starves whenever P > K. Fragile packing variance (wrap-heavy orders, oversize items) makes blocking likely. Options:
  - **(a)** Add 1 spare cart per 2 pickers, at about $600 per commercial cart.
  - **(b)** Decant totes onto a gravity or flat shelf at the pack station so the cart returns immediately. Totes cost about $15 versus about $600 per cart, and permanent tote barcodes already carry the order identity, so decanting costs only a few seconds per tote.
- **[Inference]** Parking whole carts at pack keeps the slot-to-order map intact and avoids a touch, which suits glass. Decanting adds one handling of each tote, so it should be careful lift-and-place, not stacking.
- **[Inference]** The plan's wording ("one parked at a pack station each") implies one pack station per picker. If the same people pick and pack, the buffer question changes: carts then only need to cover pick/pack alternation, and 2 per person is reasonable.

### Gaps
- No quantitative source on carts per picker, station starvation or picker idling for cart-based small e-commerce. A short time study (P and K distributions) would settle it.

---

## 6. Single-line order handling (pile / batch-then-sort) and thresholds

### Takeaway
Batching single-line (especially quantity-1) orders by SKU, with no sort step, is standard WMS functionality and widely recommended. Multi-line orders go to cluster carts. I found no published numeric threshold for when a SKU warrants a pile tote, and no source for a "10+ identical orders" bulk lane threshold.

### Cited Findings
- **[Vendor/WMS docs]** Infor WMS has a "Batch for Quantity 1 Orders" option. It creates waves and batches for quantity-1 e-commerce orders, and "sort station logic is not required since all orders are single line quantity 1 orders." — [Infor WMS docs](https://docs.infor.com/wms/2024.x/en-us/useradminlib_op/scebpug/pih1689917156624.html)
- **[Practitioner]** The fastest operations often blend approaches: batch small single-item orders and pick large multi-item orders discretely. Batching multi-line orders adds sort complexity and error risk. — [OneCart](https://www.getonecart.com/batch-picking/); [Racklify: batch vs wave](https://racklify.com/encyclopedia/batch-vs-wave-picking-a-strategic-guide-to-optimizing-your-warehouse-picking-process/)
- **[Practitioner simulation]** A public simulation project reports that clustering mono-line orders cut walking distance by 34% (a variant by 10%). Not peer-reviewed. — [samirsaci/picking-route on GitHub](https://github.com/samirsaci/picking-route)
- **[Study]** Sorting picked articles back into orders can add substantial travel or handling (+36.4% in one VNA simulation). This is why single-line orders, which need no sort, are the cleanest batch case. — [Tandfonline VNA study](https://www.tandfonline.com/doi/full/10.1080/1331677X.2018.1505532)

### Inferences
- **[Inference]** A pile tote for same-SKU single-line orders is aligned with practice. A minimum count is still needed (for example, 3 or more orders of the SKU in the release window); below that, those orders should go on carts so carts fill. No source fixes the number. Set it from data: travel saved vs one extra tote and label handling.
- **[Inference]** Pile and bulk lanes strip the easiest orders out of the cart stream. At low volume (median 217/day), carts may then wait to fill 14 slots. The release rule should be "fill to 14 OR release at time T," not a fixed count.
- **[Inference]** Pile totes must also respect glass: piling many units of a glass SKU in one tote risks contact breakage, so use dividers or cap units per pile tote.
- **[Inference]** A bulk lane for 10+ identical orders is plausible: pick once by quantity, then pack an assembly line of identical orders. No source found to support or contradict the threshold of 10.

### Gaps
- No published thresholds for pile-tote or bulk-lane minimums. ShipHero/ShipStation "bulk ship" documentation was not retrieved.

---

## 7. Fragile glass picking (bongs, glassware, ceramics)

### Takeaway
Only practitioner guidance exists, and it is consistent: one order per divided or padded container, no stacking, minimal touches, cushioned cart surfaces, a fragile zone or experienced pickers for high-value glass, and WMS flags for fragile SKUs. Use the bottom shelf, rather than a separate cart, for oversize items. I found no peer-reviewed data on breakage by picking method.

### Cited Findings
- **[Practitioner]** Use foam-lined totes, partition trays or divided bins, and carts with cushioned surfaces and separators. A dedicated fragile station is an option for high-value glass. — [Racklify: glass fulfillment](https://racklify.com/encyclopedia/how-glass-bottle-fulfillment-works-processes-best-practices/)
- **[Practitioner]** Divided totes or trolleys keep batched orders separate. Fewer handling touches lower breakage. Use a fragile zone with the most experienced pickers. — [Pallite](https://pallitegroup.com/en/news/how-to-store-glass-bottles/)
- **[Practitioner]** The WMS can flag fragile SKUs at pick and route them to trained packers. — [Racklify: fragile pack](https://racklify.com/encyclopedia/how-fragile-pack-solutions-are-transforming-modern-supply-chains/)
- **[Practitioner]** Grid dividers add seconds per carton; measure before rollout and pilot on worst-case SKUs with drop tests. — [Racklify: carton dividers](https://racklify.com/encyclopedia/when-should-a-warehouse-use-carton-dividers-operational-guidelines/)
- **[Practitioner]** Reserve the bottom shelf for oversized orders instead of idle dedicated large-item carts. — [Warehance](https://warehance.com/blog/how-to-set-up-your-picking-carts-for-maximum-efficiency)

### Inferences
- **[Inference]** One order per tote, which the plan already has, is the main breakage control: no glass-on-glass contact between orders. Inside multi-line orders, items should still be separated, for example with a foam sheet or by putting the heaviest item first.
- **[Inference]** Large 21x15x12 totes on the bottom shelf follow the Warehance pattern and keep heavy, tall glass low (stability, lower tip risk, less lifting).

### Gaps
- No quantitative breakage data comparing cluster carts with discrete picking for glassware. No source specific to bongs or scientific glass.

---

## Scorecard

| Plan parameter | Rating | Reason |
|---|---|---|
| **14 orders per cart** (12 std + 2 large) | **Aligned** | Inside practitioner ranges: 4-20 ([Optioryx](https://www.optioryx.com/blog/cluster-vs-batch-picking)), 12-25 for RF ([Pallite](https://pallitegroup.com/en/news/how-to-implement-batch-picking/)), and the common 12-tote commercial cart ([Uline H-9094](https://www.uline.com/Product/Detail/H-9094BL/Stock-Picking-Carts/Tote-Picking-Cart-18-x-13-x-12-Black-Totes)). Batching helps most for small orders ([Petersen & Aase](https://www.researchgate.net/publication/222974621_A_comparison_of_picking_storage_and_routing_policies_in_manual_order_picking)). Caveat (inference): in a 5-run building the travel gain from 10 to 14 orders is small, so 14 is fine but not critical. Use "fill or time-out" release so low-volume days don't stall. |
| **2 large slots per cart** | **Questionable** | Large-order share is roughly 6-20%, depending on which item sizes overflow a 16x11x8 tote. At 20%, about 55% of random 14-order carts would need more than 2 large slots (binomial inference). Needs capacity-aware batching by slot type, or a measured oversize share. |
| **16x11x8 stack-nest tote** | **Questionable** | Content fit is good for about 80-90% of orders (inference from the box profile). But stack-nest totes are sold by inside size, and Uline's 16x11 family is 20x13 outside ([Uline S-14602](https://www.uline.com/Product/Detail/S-14602GR/Stack-and-Nest-Containers/Stack-and-Nest-Container-16-x-11-x-5-Gray)). Tapered floors reduce usable length for flat glass. No padding is specified, while glass guidance calls for foam or dividers ([Racklify](https://racklify.com/encyclopedia/how-glass-bottle-fulfillment-works-processes-best-practices/); [Pallite](https://pallitegroup.com/en/news/how-to-store-glass-bottles/)). Cost about $13-15 each is fine. |
| **48x24 in, 3-shelf cart** | **Aligned for aisles; questionable for slot count** | 24 in width in 7-9 ft aisles leaves lots of clearance; commercial carts run 18.5-28 in wide ([RCP](https://shop.azorinc.com/Product/RCP/2144269/RCP2144269); [Uline](https://www.uline.com/Product/Detail/H-9094BL/Stock-Picking-Carts/Tote-Picking-Cart-18-x-13-x-12-Black-Totes)). Fitting 12 standard + 2 large on 48x24 needs a 2-deep layout and an outside footprint of about 16x11-12 in per tote. With about 20x13 outside it holds only about 8-9 standard (inference). Set handle near 35-42 in ([State Fund CA](https://content.statefundca.com/safety/ErgoMatters/Carts.asp)); push force should be well under the 50 lb start guideline. |
| **2 carts per picker** (1 picking, 1 parked at pack) | **Questionable** | It is the minimum double buffer. The picker idles whenever packing a cart takes longer than picking one, which is likely with fragile wrapping. No published norm; the practitioner rule is add carts if pickers wait ([Warehance](https://warehance.com/blog/how-to-set-up-your-picking-carts-for-maximum-efficiency)). Cheap fixes: one spare cart, or decant barcoded totes to a pack shelf so carts cycle back (inference). If pickers also pack their own carts, 2 per person is adequate. |
| **3rd picker + 2 carts in Q4** | **Aligned** | Throughput arithmetic (inference from 35-85 lph benchmarks, [Pallite KPIs](https://pallitegroup.com/en/news/kpis-for-eaches-picking/)) puts Q4 p90 (609/day) at about 11-20 picker-hours, beyond 2 pickers' capacity on slow days. |
| **Pile tote for same-SKU single-line orders** | **Aligned (threshold unspecified)** | Matches qty-1 single-line batching in WMS practice ([Infor](https://docs.infor.com/wms/2024.x/en-us/useradminlib_op/scebpug/pih1689917156624.html)) and blended strategies ([OneCart](https://www.getonecart.com/batch-picking/)). The plan needs a minimum count per SKU and a cap on glass units per pile tote; no source gives a number. |
| **Bulk lane for 10+ identical orders** | **Not supported or contradicted (no evidence found)** | Logic is sound (inference), but no source on the threshold. Validate against order data: how often 10+ identical sets occur, and the time saved vs carts. |
| **Phone-guided optimized route** | **Aligned, low marginal value** | Batching matters more than routing ([Petersen & Aase](https://www.researchgate.net/publication/222974621_A_comparison_of_picking_storage_and_routing_policies_in_manual_order_picking)). In 5 runs a simple S-shape is near optimal (inference). A device mount on the cart is standard ([Warehance](https://warehance.com/blog/how-to-set-up-your-picking-carts-for-maximum-efficiency)). |
| **Permanent tote barcodes / slot labels** | **Aligned** | Barcode plus large text per tote, with cart/shelf-colour/position IDs, is recommended practice ([Warehance](https://warehance.com/blog/how-to-set-up-your-picking-carts-for-maximum-efficiency)). Add shelf colour coding if not already planned. |
| **Fragile handling** (not explicit in plan) | **Questionable / gap in plan** | Guidance calls for padded or divided totes, cushioned shelves, no stacking and minimal touches ([Racklify](https://racklify.com/encyclopedia/how-glass-bottle-fulfillment-works-processes-best-practices/); [Pallite](https://pallitegroup.com/en/news/how-to-store-glass-bottles/)). The plan should specify a tote liner and a rule against tote-in-tote at hand-off. |
