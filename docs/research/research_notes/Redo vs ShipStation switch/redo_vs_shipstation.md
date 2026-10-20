# Redo vs ShipStation as the label/shipping engine behind the Freeze Pipe ERP (as of 2026-10-19)

Conventions used in these notes:
- **[Vendor]** = official statement from the vendor's own site, docs, or app listing.
- **[3rd party]** = review sites, competitor pages, affiliate blogs, or merchant reviews.
- **[Inference]** = my reasoning; not stated by any source.
- **[Unverified]** = from general background knowledge, not confirmed by a source fetched in this session.
- Every price is dated to when it was read (2026-10-19) unless a page date is given.

## 1. What Redo's shipping product is in 2026, when it launched, and what it includes

### Takeaway
Redo's shipping product is called **Redo OMS** (sold as "Shipping & Fulfillment" on the pricing page and as the "Fulfillment" plan on Shopify). It is a real label-buying OMS with auto-batching, direct-to-printer printing, packing slips, scan-to-verify, BYO carrier accounts, rate shopping, and a growing warehouse layer (pick sessions, bins, replenishment). It is newer and less proven than ShipStation. I could not find a launch date; the earliest dated material I found is from 2025, and most feature material is dated March–July 2026.

### Cited Findings
- [Vendor] The Help Center calls Redo OMS a "modern order management system" that connects to Shopify and other sales channels to manage orders, print labels, and track shipments. Article dated July 6, 2026. — [Redo Help: Redo OMS FAQ & Getting Started](https://help.getredo.com/en/articles/11590421-redo-oms-order-management-system-faq-getting-started)
- [Vendor] Features listed in the same article:
  - **Auto-batching** by shipping method, item count, or destination.
  - **Packing slips** customizable under Settings > Order Fulfillment > General > Packing Slips, with logo, messages, and a QR code to the return portal.
  - **Scan to verify**: print a barcoded packing slip, scan it, then scan each product before packing.
  - **Real-time two-way Shopify sync** of order status, address changes, tracking, and fulfillment status.
  - **Shipment statuses** Open, Ready to Ship, Closed, Voided, and On Hold.
  - **Multiple shipments per order** and a per-order activity log.
  - **DDP/DDU** for international shipments.
  - [Redo Help](https://help.getredo.com/en/articles/11590421-redo-oms-order-management-system-faq-getting-started)
- [Vendor] Redo says its advantages over ShipStation are real-time two-way Shopify sync, auto-batching, a cleaner interface, more powerful automations, and scan-to-verify. — [Redo Help](https://help.getredo.com/en/articles/11590421-redo-oms-order-management-system-faq-getting-started)
- [Vendor] A Redo product-update page (URL slug "june2025") is cited in search results for "Send shipping labels and packing slips directly to printers." The page now returns 404, so I could not confirm its date or wording directly. — [Redo Product Updates (search snippet; page 404 on fetch)](https://wf.getredo.com/en/product-updates-june2025)
- [Vendor] Blog post dated March 17, 2026, on what the OMS does:
  - It "automatically selects shipping services, creates packing slips, and tracks inventory across fulfillment locations."
  - It has a visual automation builder. Order of operations is "auto-split runs first, then automations, then merges."
  - [Redo blog: Redo OMS – What Makes It Different](https://redo.com/blogs/redo-oms-what-makes-it-different)
- [Vendor] Same post, on channels: Shopify is primary. The other platforms listed are Walmart, eBay, CommentSold, TikTok, BigCommerce, Cin7 Core, Cin7 Omni, and Faire, plus NetSuite, Apparel Magic, and WarehouseOS. Amazon appears only as a carrier, not as a sales channel. — [Redo blog](https://redo.com/blogs/redo-oms-what-makes-it-different)
- [3rd party, competitor] ShipStation's comparison page, last updated Oct 14, 2026, says Redo has a "narrower native integration footprint" with "No native Amazon, eBay, Etsy, or Walmart Marketplace connection." It also says Redo "includes basic shipping features" and offers "Order batching and packing verification in Redo OMS." This **conflicts** with Redo's own claim of Walmart and eBay support. — [ShipStation: Comparing ShipStation and Redo](https://www.shipstation.com/blog/comparing-shipstation-and-redo/)
- [Vendor] Warehouse features are showing up in the v3 GraphQL API: `pickSession(s)`, `warehouseTeamMemberProductivity`, `storageLocation(s)`, `binInventoryLevel(s)`, inventory ledger entries, `searchReplenishmentReports`, inbound shipments, and purchase orders. — [Redo v3 GraphQL API index](https://developers.redo.com/_llms/api-reference/v3-graph-ql.txt)
- [Vendor] An April 7, 2026 blog post mentions pick-session updates that show bin locations for refulfillment and return inventory. — [Redo blog: Ecommerce Shipping & Fulfillment: The OMS Advantage](https://redo.com/blogs/ecommerce-shipping-fulfillment-oms)
- [Vendor] Company facts: Redo Tech, Inc., Draper, UT. The Shopify app launched May 25, 2020. That date is for the returns app, not the OMS. — [Shopify App Store: Redo](https://apps.shopify.com/redo)
- [Vendor] The domain moved from getredo.com to redo.com; getredo.com/pricing 301-redirects to redo.com/pricing. The API is still at api.getredo.com. — [redo.com/pricing](https://redo.com/pricing)
- [3rd party] An independent review site describes the Fulfillment plan as software only: "It is not a 3PL or warehouse service." — [inso.codes Redo review (search snippet)](https://www.inso.codes/apps/reviews/redo-review)

### Inferences
- [Inference] Redo OMS appears to have launched sometime in 2025 and matured through 2026. The evidence is the "june2025" product-update slug, a run of feature and reliability posts in March–May 2026, and the July 2026 FAQ. Treat it as a roughly 1-to-1.5-year-old product next to ShipStation's 10+ years.
- [Inference] Redo is building a light WMS (pick sessions, bins, replenishment). That overlaps the job Freeze Pipe just decided its ERP should own. Freeze Pipe would pay for, or at least have to work around, features it won't use.
- [Inference] Multi-store support (two Shopify stores) is plausible, since a Shopify reviewer describes a multi-store migration (see Section 4). I found no doc explaining how two stores share one OMS workspace or carrier accounts.

### Gaps
- Exact OMS launch date: no press release or dated announcement found.
- Pick-list printing, as opposed to pick sessions, and how printing works: PrintNode, desktop agent, or browser. "Directly to printers" is claimed, but the mechanism isn't documented in anything I could fetch.
- Whether **scan-to-print** works the way ShipStation's Scan to Print does (scan a slip barcode and the label prints). Only scan-to-verify is documented.
- How two Shopify stores map to one Redo account.
- Whether Amazon or TikTok Shop order intake is supported. Sources conflict, and TikTok is listed without "Shop."

## 2. Redo pricing model for shipping, commitments, and bundling requirements

### Takeaway
Redo's own sources say the OMS software is **free** and that you pay for labels through a prepaid auto-reload balance, with "cash back on orders shipped." The Shopify listing, however, shows a **$99/month Fulfillment plan**. I found no stated requirement to buy Redo's returns coverage or package protection to use the OMS, but none is ruled out either. Confirm pricing in writing before committing.

### Cited Findings
- [Vendor] Redo's pricing page lists "Shipping & Fulfillment" as "Free," including order management software, real-time analytics, and "Cash back on orders shipped" with no amount given. Read 2026-10-19. — [redo.com/pricing](https://redo.com/pricing)
- [Vendor] Help Center: "Redo OMS is free! We do not charge you for the use of the software." Outbound labels are paid from an auto-reload balance, where you set a maximum and a trigger amount, or add one-time funds. — [Redo Help](https://help.getredo.com/en/articles/11590421-redo-oms-order-management-system-faq-getting-started)
- [Vendor] Shopify App Store pricing, read 2026-10-19, has a **Fulfillment plan at $99/month**: "Fulfillment software; Auto Batch; Auto Merge orders; bulk auto-shipping of identical orders." Other plans are Returns (free), Checkout Optimizer ($10/mo + $0.50/order), and Email & SMS ($10/mo + usage). — [Shopify App Store: Redo](https://apps.shopify.com/redo)
- [3rd party] An independent review lists the Fulfillment plan at $99/month. — [inso.codes (search snippet)](https://www.inso.codes/apps/reviews/redo-review)
- [3rd party, competitor] ShipStation describes Redo pricing as "OMS subscription, shopper-paid return coverage, enterprise by quote." — [ShipStation comparison](https://www.shipstation.com/blog/comparing-shipstation-and-redo/)
- [Vendor] Insurance: every shipment includes $100 of carrier-provided coverage, and more can be bought through Redo OMS at "competitive rates" (no figure given). — [Redo Help](https://help.getredo.com/en/articles/11590421-redo-oms-order-management-system-faq-getting-started)
- [Vendor] Returns: Redo's pricing page says "Redo covers the cost of your return labels." That is tied to Redo's shopper-paid return coverage model. — [redo.com/pricing](https://redo.com/pricing)
- [3rd party] A 1-star review dated Aug 3, 2026 complains that a "Free Unlimited Return for $1.98" checkout option was on by default. Another, dated Oct 2, 2026, says the app re-enabled itself after being disabled. — [Shopify reviews, 1-star](https://apps.shopify.com/redo/reviews?ratings%5B%5D=1&sort_by=newest)

### Inferences
- [Inference] The likely economics: OMS software at $0 or $99/month; labels at your own contract rates when you connect your own accounts, or Redo's negotiated rates otherwise; and Redo earning revenue through rate margins on Redo-negotiated labels, return coverage, and other modules. The "free" software is a funnel into the rest of the Redo suite.
- [Inference] Against ShipStation Standard at Freeze Pipe's volume (about $150–$350/month; see Section 6), Redo could save roughly $50–$350/month on software, about $600–$4,200/year. That only holds if the $99 plan isn't required, or if it is and they stay under ShipStation's tier. The saving is real but small compared with the switching cost.
- [Inference] The returns side of Redo is built around shopper-paid coverage at checkout. For glass products that break, Freeze Pipe should look at that model separately from the shipping decision.

### Gaps
- Whether the $99/month Fulfillment plan is required for OMS label buying, or is an upsell for Auto Merge and bulk auto-ship.
- The "cash back" percentage or amount.
- Whether using BYO UPS accounts carries any per-label fee.
- Contract terms, minimums, and cancellation terms. None are published.
- **Acceptable-use policy for glass smoking accessories / "paraphernalia."** Not found for Redo or its negotiated-rate accounts. This is a material risk for this merchant category and must be asked directly.

## 3. Redo developer surface: API, webhooks, auth, label creation from a third-party ERP

### Takeaway
Redo **does** have a public developer portal, and as of October 2026 its **v3 GraphQL API includes outbound label quoting, purchase, and void mutations** that take a carrier account id. On paper, an ERP can buy labels programmatically. The v2 REST API covers orders, fulfillments (tracking), inventory, and webhooks. Auth is a self-serve bearer API secret with scopes. Several things a label engine needs are undocumented or missing from what I could read: label format (ZPL/PDF), order linkage on API-bought labels, shipment webhook topics, and SLAs.

### Cited Findings
- [Vendor] The developer portal is developers.redo.com. The REST base URL is `https://api.getredo.com/v2.2` (version 2.2.1), covering "returns, refunds, shipments, and invoices." — [Redo API Introduction](https://developers.redo.com/docs/api-reference/introduction.md)
- [Vendor] Authentication: "All API endpoints are authenticated using the Bearer authorization scheme with your API secret." You create an API client yourself under Settings → Developer in the Redo dashboard. Tokens carry access scopes; a missing scope returns 403. No OAuth is described, and no rate limits are documented. — [Redo Authentication](https://developers.redo.com/docs/api-reference/authentication.md)
  - Note: an older returns integration guide says to email support@getredo.com for API keys and sandbox access. — [Integrating with Returns APIs (search snippet)](https://developers.redo.com/docs/guides/integrations/integrating-with-returns-apis)
- [Vendor] v2 REST endpoint groups (about 60 pages):
  - Orders: Create, Get, Delete Order; Create Fulfillment, which records tracking; Update Fulfillment Status.
  - Inbound Shipments; Inventory Items and Levels; bulk product upload.
  - Webhooks: list, create/update, get, update, delete, replay.
  - Returns, invoices, and checkout groups.
  - **No v2 endpoints for labels, rates, carriers, batches, or packing slips.**
  - [Redo API Reference index](https://developers.redo.com/_llms/api-reference.txt)
- [Vendor] v3 GraphQL shipping mutations:
  - `getShippingLabelQuotes` quotes rates; quotes are ephemeral.
  - `purchaseCarrierShipment` buys a label.
  - `voidCarrierShipment` voids a label and refunds the charge.
  - Related queries: `carrierShipmentTracker(s)`, `pickSession(s)`.
  - The index has no dedicated carrier-account query, and no order, batch, packing-slip, or print mutations.
  - [Redo v3 GraphQL index](https://developers.redo.com/_llms/api-reference/v3-graph-ql.txt)
- [Vendor] `purchaseCarrierShipment` details:
  - Inputs: `carrier`, `carrierAccountId`, `service` (each as returned by the quote), optional `idempotencyKey`, and `request`. The request contains from/to/return addresses, up to 5 `parcels`, `contentsSummary`, `customs`, `deliveredDutyPaid`, `signatureConfirmation`, and `taxIdentifiers`.
  - Returns: `shipmentId`, `rate` (amount and currency), and `shipmentPackages[]` with `labelUrl` and `trackingNumber`.
  - Requires scope `shipping_write`.
  - The page does not specify label format or a link to a Shopify or Redo order.
  - [Redo docs: purchaseCarrierShipment](https://developers.redo.com/docs/api-reference/v3/reference/shipping/mutations/purchase-carrier-shipment.md)
- [Vendor] Webhooks are created through `POST https://api.getredo.com/v2.2/stores/{storeId}/webhooks`:
  - Your secret is sent back as a Bearer token on each delivery.
  - Delivery is retried on non-2xx responses, then dropped.
  - Events are ordered per subject.
  - The examples shown are return topics.
  - [Redo Webhooks guide](https://developers.redo.com/docs/guides/integrations/webhooks)
- [Vendor] Redo also publishes an MCP server, an OpenAPI spec, and scheduled SFTP reports. — [developers.redo.com/llms.txt](https://developers.redo.com/llms.txt)
- [Vendor] The v3 index doesn't say whether v3 is beta or GA. — [Redo v3 GraphQL index](https://developers.redo.com/_llms/api-reference/v3-graph-ql.txt)

### Inferences
- [Inference] The v3 shipping API is shaped like a **stateless label API**: quote, buy, void, track. That is closer to EasyPost or ShipEngine than to ShipStation V1's order-centric model. An ERP could call it directly after packing. Because API-bought labels don't appear to be tied to an order, the ERP would likely have to post the Shopify fulfillment and tracking itself, through Shopify's Admin API or Redo's v2 Create Fulfillment. That needs verifying.
- [Inference] The documented v2 webhook topics are returns-centric. I found nothing like ShipStation's SHIP_NOTIFY for "a shipment was created in the OMS UI." If staff keep buying labels in Redo's UI, the ERP may have no clean push signal. It might have to poll, or listen to Shopify `fulfillments/create` instead.
- [Inference] The API's breadth is impressive for a young product, but I found no third-party developer reports (GitHub, forums) of anyone building on the shipping mutations. Maturity and stability are unproven.

### Gaps
- Label formats (ZPL for thermal 4x6 vs PDF), label size options, and whether `labelUrl` links expire.
- Full list of webhook topics: are there shipment, fulfillment, or label topics?
- Whether a carrier account connected in the UI (BYO UPS) is usable by id through the API, and how to list carrier account ids, since there's no carrier-account query in the index.
- Rate limits, sandbox or test-label mode, and SLA or uptime commitments.
- Whether v3 is GA or beta.

## 4. Customer evidence: reviews, complaints, migration stories

### Takeaway
Redo's Shopify listing is very strong overall, with **4.9 stars from 809 reviews** (read 2026-10-19), but almost all of it reflects the returns product. Fulfillment-specific reviews are few, positive, and partly from ShipStation switchers. The 1-star reviews cluster around **support responsiveness and billing errors**, not labels. I found no Reddit or independent technical critique of Redo OMS.

### Cited Findings
- [3rd party] Shopify App Store, read 2026-10-19: 4.9 stars, 809 reviews (780 five-star, 16 four-star, 0 three-star, 0 two-star, 13 one-star). The newest reviews are from Oct 5–8, 2026. One, from Wynwood Dog Food Co. (Oct 8, 2026, 3 months on the app), uses Redo for fulfillment and says it made "handling our labels and shipments a lot smoother." — [Shopify App Store: Redo](https://apps.shopify.com/redo)
- [3rd party] Migration stories from Shopify reviews (individual dates not all captured):
  - A January 2026 reviewer: "The transition from ShipStation was smooth, the interface is cleaner, and the overall workflow feels faster."
  - A 10-year ShipStation user left after "Over 100 packages with incorrectly issued tracking numbers" during the holidays.
  - A multi-store merchant: "It was a lot of work to switch from Shipstation and Aftership," and native Shopify integration ended sync lag.
  - Another reviewer said Redo's team built functionality improvements for them.
  - [Shopify App Store reviews (via search)](https://apps.shopify.com/redo/reviews?page=31)
- [3rd party] 1-star reviews (13 total; 10 read), mostly 2025–2026:
  - 7 of 10 cite slow or vanishing support (e.g., Sep 24, 2026: issues unresolved for about 3 months; Feb 16, 2026: tickets unanswered for more than a week).
  - 3 cite billing or amount errors, such as incorrect balances and wrong claim or tax amounts.
  - 1 says the app re-enabled itself after being disabled.
  - None mention labels or the OMS.
  - [Shopify reviews, 1-star newest](https://apps.shopify.com/redo/reviews?ratings%5B%5D=1&sort_by=newest)
- [Vendor] Redo's April 7, 2026 blog admits that labels had been failing "without notice" on address-format and carrier-setup edge cases, and says "Redo recently shipped a wave of reliability fixes for shipping label generation." — [Redo blog](https://redo.com/blogs/ecommerce-shipping-fulfillment-oms)
- [3rd party] Trustpilot reviewers praise support and label handling, but some note slow responses and "unexpected changes to service coverage plans." — [Trustpilot: Redo (search snippet)](https://www.trustpilot.com/review/redo.com)
- [3rd party, competitor] ShipStation calls Redo's shipping "basic" with "limited rate shopping across carriers." This is a competitor's view, published Oct 14, 2026. — [ShipStation comparison](https://www.shipstation.com/blog/comparing-shipstation-and-redo/)
- No Reddit, G2, or Capterra reviews of Redo OMS turned up in my searches.

### Inferences
- [Inference] Redo's rating is dominated by returns customers and by reviews that credit named support staff, a common Shopify review-solicitation pattern. It is weak evidence about OMS maturity at Freeze Pipe's volume.
- [Inference] The admitted label-reliability fixes in spring 2026 and the support complaints in late 2026 point to a product that is improving fast but still settling. That is a risk going into Q4 peak.

### Gaps
- No independent, volume-comparable (hundreds of labels/day) case study of Redo OMS.
- No G2, Capterra, or Reddit data on the OMS specifically.
- No reviews from a smoking-accessory or other restricted-category merchant.

## 5. Carrier coverage, negotiated accounts, international, insurance

### Takeaway
Redo says merchants can connect their own **UPS, FedEx, DHL eCommerce, DHL Express**, Canada Post, Australia Post, and others. It also offers Redo-negotiated UPS, USPS, Amazon, and First Mile rates, and by default rate-shops for the cheapest option. In principle, Freeze Pipe's September 2026 UPS contract could be connected. I found no Redo-specific UPS connection guide or confirmation that negotiated or contract rates (as opposed to list rates) come through for UPS specifically.

### Cited Findings
- [Vendor] "Redo has negotiated rates with UPS, USPS, Amazon, and First Mile." Merchants can connect their own UPS, FedEx, DHL eCommerce, DHL Express, Canada Post, Australia Post "and many more." The system compares negotiated and BYO rates, and "By default, it picks the cheapest option," with automations able to override. — [Redo blog, Mar 17, 2026](https://redo.com/blogs/redo-oms-what-makes-it-different)
- [Vendor] UniUni was added May 13, 2026 with "Bring Your Own Account support... live from day one." For connected accounts, Redo says "their negotiated contract rates are what they see in Redo, without translation or markup." The post contrasts Redo's direct carrier integrations with middleware such as EasyPost. — [Redo blog: UniUni](https://redo.com/blogs/bring-your-uniuni-account-to-redo-or-use-ours-your-labels-your-rates-one-dashboard)
- [3rd party, competitor] ShipStation lists Redo's carriers as "UPS, USPS, FedEx, DHL Express, Canada Post, and Australia Post via Redo OMS," with "Connect your own negotiated rates; limited rate shopping across carriers." — [ShipStation comparison](https://www.shipstation.com/blog/comparing-shipstation-and-redo/)
- [Vendor] International: DDP/DDU and commercial invoices are supported. The API supports customs, DDP, and IOSS tax ids. — [Redo Help](https://help.getredo.com/en/articles/11590421-redo-oms-order-management-system-faq-getting-started); [purchaseCarrierShipment](https://developers.redo.com/docs/api-reference/v3/reference/shipping/mutations/purchase-carrier-shipment.md)
- [Vendor] Insurance: $100 carrier-provided coverage per shipment is included, with more available at unstated rates. — [Redo Help](https://help.getredo.com/en/articles/11590421-redo-oms-order-management-system-faq-getting-started)
- [Vendor] ShipStation itself supports bringing existing carrier accounts on Standard and above. — [ShipStation pricing](https://www.shipstation.com/pricing/)

### Inferences
- [Inference] USPS for Freeze Pipe would most likely come through Redo's own USPS account (Ground Advantage), since a BYO USPS account isn't listed. Whether glass smoking accessories are allowed under Redo's USPS/UPS negotiated accounts is an open, high-stakes question. Category restrictions on platform-owned carrier accounts are common. [Unverified]
- [Inference] Freeze Pipe's own UPS account is the most important lever after the September 2026 contract. Any platform must pass through their contract rates, including any flat-rate or incentive structure. Test this with a live rate comparison against ShipStation on 20–30 real shipments before deciding.

### Gaps
- A Redo UPS OAuth connection guide, and confirmation that UPS negotiated rates (not daily or list rates) are returned.
- Whether a BYO USPS account (USPS Ship / EPS) is supported.
- DHL eCommerce product coverage details.
- Insurance rates above $100. Compare with ShipStation's carrier-protection options and Shipsurance; I did not research Shipsurance pricing.

## 6. ShipStation cost baseline and switching-cost considerations for this ERP

### Takeaway
At tens to a few hundred shipments/day (about 1,000–6,000/month), ShipStation **Standard costs about $149.99–$349.99/month** at list price (read 2026-10-19), more than the brief's "$30–150." API access is included on Standard. ShipStation V1 has **no announced shut-off date**, so there is no forced migration in Q4 2026. Switching to Redo would mean rewriting the ERP's V1 ingestion, SKU resolution, and inventory deduction keyed on ShipStation order ids, plus the webhook path and staff retraining, all to save at most a few hundred dollars a month.

### Cited Findings
- [Vendor] ShipStation pricing, read 2026-10-19, page undated. The Standard plan includes API access, 10 users, and BYO carrier accounts. Monthly prices by shipment tier:

  | Shipments/month | Standard price |
  |---|---|
  | 100 | $59.99 |
  | 500 | $89.99 |
  | 1,000 | $149.99 |
  | 2,000 | $174.99 |
  | 5,000 | $249.99 |
  | 7,500 | $349.99 |

  - Starter ($14.99–$174.99) has **no** API access.
  - Premium starts at $349.99.
  - The page offers 20% off for annual billing.
  - [ShipStation Pricing](https://www.shipstation.com/pricing/)
- [3rd party] A plugin vendor said that effective May 19, 2025, ShipStation would restrict API access to "Gold and Scale" plans. The current pricing page instead shows API access on Standard, under the new plan names. — [1teamsoftware](https://1teamsoftware.com/documentation/shipstation-shipping/using/howto-get-your-shipstation-api-key-v1-to-v2/); contradicted by [ShipStation Pricing](https://www.shipstation.com/pricing/)
- [Vendor] ShipStation says V1 will be deprecated at a future date with advance notice, and existing V1 integrations keep working. V1 and V2 keys are separate. V1 `orderKey` maps to V2 `external_shipment_id`, and V2 ids carry an `se-` prefix. V1's awaiting_payment, awaiting_shipment, and on_hold statuses all collapse to V2 `pending`. — [ShipStation Legacy API Migration](https://docs.shipstation.com/orders/legacy-migration); [ShipEngine Help: New ShipStation API](https://help.shipengine.com/hc/en-us/articles/34371700662299-New-ShipStation-API)
- [3rd party] Fivetran added ShipStation V2 API connector support in May 2026, a sign the ecosystem is moving to V2. — [Fivetran changelog](https://fivetran.com/docs/connectors/applications/shipstation/changelog)
- [Vendor] ShipEngine has been rebranded as the "ShipStation API." It is the same Auctane family, and V2 is effectively ShipEngine-based. — [ShipStation docs: ShipEngine Rebranded](https://docs.shipstation.com/apis/shipengine/docs/getting-started/new-shipstation-api)

### Inferences
- [Inference] ERP switching costs if Freeze Pipe moves to Redo:
  1. Replace V1 order ingestion and webhook handling with Redo or Shopify-native order intake.
  2. Re-key SKU resolution and inventory deduction away from ShipStation order ids, for example to Shopify order or line-item ids. This is the most invasive change, and arguably it should happen anyway.
  3. Rebuild pack-bench printing and scan workflows, retrain 2–5 staff, and re-enter carrier accounts, automation rules, packing-slip templates, and box presets.
  4. Run in parallel for weeks.
  5. Possibly lose a push signal for UI-created shipments (see Section 3).
- [Inference] Most of that work also has to happen when V1 is eventually retired, even if Freeze Pipe stays with Auctane. So the real decision is less "ShipStation vs Redo" than **"when V1 retirement forces a rewrite, what should the ERP integrate against?"** The best hedge is to make the ERP **key on Shopify order/line ids, not ShipStation ids**, and keep the shipping vendor behind an adapter.
- [Inference] Doing any switch during October–December peak is the worst timing.

### Gaps
- No V1 shut-off date published.
- Freeze Pipe's actual ShipStation tier and invoice. Use the real bill rather than list price.
- Whether ShipStation offers loyalty or annual pricing to existing accounts.

## 7. Alternatives for the "label engine behind a custom ERP" role

### Takeaway
For an ERP that owns picking and wants to buy labels via API on its own UPS contract, the strongest API-first candidates are **ShipStation API (ShipEngine)**, **EasyPost**, and **Shippo**. All three support BYO carrier accounts, at roughly $20–$75/month plus about $0.06–$0.08 per label. Veeqo is free but its label-purchase API is new and possibly whitelisted. Pirate Ship has no public API. Shopify Shipping cannot serve as an API label engine for a third-party ERP [Unverified].

### Cited Findings
- **ShipStation API / ShipEngine** [Vendor, read 2026-10-19]:
  - Free plan: $0, no BYO carriers; uses ShipStation's rates.
  - **Advanced plans (BYO allowed):**

    | Plan | Monthly price | Overage per label |
    |---|---|---|
    | 1,000 labels | $75 | $0.075 |
    | 5,000 labels | $325 | $0.065 |
    | 10,000 labels | $600 | $0.06 |

  - Enterprise is custom, for 25,000+ shipments.
  - The pricing page counts plan usage as API calls across endpoints, which is ambiguous.
  - [ShipStation API Pricing](https://www.shipstation.com/shipping-api/pricing/?r=shipengine)
- **EasyPost** [Vendor, read 2026-10-19]:
  - "Free for up to 3,000 labels" on wallet (EasyPost-owned) carriers.
  - **BYOCA is $20/month plus a per-label fee.** The official page does not state the amount.
  - Insurance is 1% of value, $1 minimum.
  - Tracking is $0.01–$0.03 per shipment.
  - [EasyPost Pricing](https://www.easypost.com/pricing)
  - [3rd party] puts the per-label fee at $0.08 beyond 3,000 labels. — [Carrier API Pricing 2026 (search snippet)](https://www.carrierintegrations.com/carrier-api-pricing-2026-what-7-platforms-charge/); [AfterShip: EasyPost vs Shippo](https://www.aftership.com/blog/easypost-vs-shippo)
- **Shippo** [Vendor, read 2026-10-19]:
  - API Starter is free with 30 labels/month, then **7¢ per label**.
  - Rating 1¢, tracking 2¢, address validation 2¢ (US).
  - Insurance is 1.25% of value plus shipping cost (US).
  - Premier is custom.
  - BYO-account per-label fee isn't stated on the API pricing page.
  - [Shippo API Pricing](https://goshippo.com/pricing/api)
  - [3rd party] says BYO is about 5¢/label in the web app vs 7¢ via the API. — [search summary of Shippo vs EasyPost comparisons](https://www.aftership.com/blog/shippo-vs-easypost-api-developer-verdict)
- **Veeqo** (Amazon), [Vendor forum]:
  - Older staff answers said labels could only be bought in the UI.
  - A December 2025 doc review lists new Rate Shopping API endpoints, "Requesting Shipping Rates and Purchasing Shipping Labels," usable with Amazon rates or connected carrier accounts.
  - A developer asked whether label purchase is restricted to whitelisted US accounts; I didn't find the answer.
  - [Veeqo dev forum: API Doc Review Dec 2025](https://developer-forum.veeqo.com/t/api-doc-review-completed-dec-2025/1654); [Veeqo forum: buy label endpoint](https://developer-forum.veeqo.com/t/inquiry-about-availability-of-buy-shipping-label-endpoint/1115)
  - [3rd party] Veeqo is described as free to ship with no subscription. — [Veeqo blog](https://www.veeqo.com/blog/shipstation-alternatives-united-states)
- **Pirate Ship**: no public API found. It's typically positioned as a no-subscription USPS/UPS tool for lower-volume sellers. — [Veeqo blog: ShipStation alternatives](https://www.veeqo.com/blog/shipstation-alternatives-united-states). [Unverified] Pirate Ship primarily sells its own negotiated USPS and UPS rates rather than supporting BYO UPS contracts.
- **ShipHero, Ordoro, Stamps.com/Endicia, Shopify Shipping, Shipsurance**: not researched in depth this session. Background knowledge follows, all [Unverified]:
  - ShipHero is a full WMS with its own picking. It would duplicate the ERP's module and is priced well above this need.
  - Ordoro is a mid-market multichannel shipping and inventory app with an API.
  - Stamps.com is Auctane-family and USPS-centric.
  - **Shopify Shipping labels cannot be bought by a third-party app or ERP through the Admin API**. The ERP can, however, use Shopify's Admin GraphQL `fulfillmentCreate` (FulfillmentOrder) to mark orders fulfilled with tracking from any label source.
  - Shipsurance offers third-party parcel insurance and integrates with ShipStation.

### Inferences
- [Inference] Rough cost at about 3,000 BYO labels/month, list prices read 2026-10-19:

  | Platform | Approx. monthly cost |
  |---|---|
  | EasyPost | $20 + 3,000 × ~$0.08 ≈ $260 (per-label fee unconfirmed) |
  | ShipStation API Advanced 1k | $75 + 2,000 × $0.075 = $225, or $325 on the 5k plan |
  | Shippo API | ≈ 3,000 × $0.07 ≈ $210 |
  | ShipStation Standard, 5,000-shipment tier (incl. UI) | $249.99 |
  | Redo OMS | $0–$99 + labels |

  So a pure label API **isn't cheaper** than ShipStation Standard at this volume. Its advantage is architecture: the ERP owns orders and picking, and calls quote/buy/void at the pack bench. The ERP would then have to build its own pack-bench UI, printing (for example, PrintNode or browser ZPL), and returns handling.
- [Inference] Because ShipStation V2 is essentially ShipEngine, the **lowest-friction long-term path** may be to stay in the Auctane family. Keep the ShipStation UI for staff now, and when V1 retires, move the ERP to the V2/ShipStation API, still on the same carrier connections.

### Gaps
- EasyPost's official BYOCA per-label fee amount.
- Shippo's BYO per-label fee on the API.
- Whether the Veeqo label API is generally available.
- Current ShipHero and Ordoro pricing.
- Shipsurance rates.
- **Carrier and platform acceptable-use policies for glass smoking accessories / "paraphernalia" across all candidates.** This could rule some out entirely.

## 8. Recommendation (for the owner's question: "Would it be worth transitioning away from ShipStation to a competitor like Redo?")

### Takeaway
**Don't switch now; revisit in Q1 2027 with a structured bake-off.** Redo OMS is credible and improving quickly. It is free or cheap, has BYO UPS, FedEx, and DHL, scan-to-verify, and a real GraphQL label-purchase API. But it is young: label-reliability fixes shipped in spring 2026, support complaints continue, webhook coverage for shipments is unclear, pricing conflicts ($0 vs $99/mo), and category acceptability is unknown. It also adds WMS features the ERP will own. The software saving (about $50–$350/month) doesn't justify a migration during peak season. The work that does matter is decoupling the ERP from ShipStation V1 ids, and that is needed whichever vendor wins.

### Cited Findings
- Redo OMS pricing and features: [redo.com/pricing](https://redo.com/pricing); [Redo Help](https://help.getredo.com/en/articles/11590421-redo-oms-order-management-system-faq-getting-started); [Shopify App Store: Redo](https://apps.shopify.com/redo)
- Redo shipping API (quote, purchase, void): [Redo v3 GraphQL index](https://developers.redo.com/_llms/api-reference/v3-graph-ql.txt); [purchaseCarrierShipment](https://developers.redo.com/docs/api-reference/v3/reference/shipping/mutations/purchase-carrier-shipment.md)
- Label reliability fixes in 2026: [Redo blog](https://redo.com/blogs/ecommerce-shipping-fulfillment-oms)
- Support and billing complaints: [Shopify 1-star reviews](https://apps.shopify.com/redo/reviews?ratings%5B%5D=1&sort_by=newest)
- ShipStation V1 has no shut-off date: [ShipStation Legacy Migration](https://docs.shipstation.com/orders/legacy-migration)
- ShipStation Standard tiers: [ShipStation Pricing](https://www.shipstation.com/pricing/)

### Inferences
- [Inference] **Now through peak (Oct–Dec 2026): stay on ShipStation.** Keep Scan to Verify/Print as-is and ship the ERP pick module on top of the existing V1 integration.
- [Inference] **Engineering, starting now and vendor-neutral:**
  1. Re-key ERP inventory deduction and SKU resolution on Shopify order/line-item ids, keeping the ShipStation order id as a foreign reference.
  2. Put shipping behind an adapter interface: `createLabel`, `voidLabel`, `onShipment`.
  3. Plan the V1→V2 move; a V1 shutdown will force it eventually.
- [Inference] **Q1 2027 bake-off: Redo OMS vs ShipStation (V2) vs one API-first engine (ShipStation API or EasyPost).** Run 2–4 weeks in a sandbox, then in parallel. Pass/fail criteria:
  1. Written confirmation that glass smoking accessories are allowed under the platform's AUP and any platform-owned carrier accounts.
  2. The UPS September 2026 contract rates come through exactly.
  3. Two Shopify stores in one workspace.
  4. ZPL 4x6 scan-to-print at the bench in fewer than 2 seconds.
  5. A push webhook (or reliable feed) for every label bought in the UI.
  6. Label purchase via API with idempotency and order linkage.
  7. Written pricing ($0 vs $99, cash back, BYO fees).
  8. Support response-time SLA.
- [Inference] **When Redo would win:** if Freeze Pipe also wants Redo for returns, claims, or package protection, which fits fragile glass. A single post-purchase vendor with free OMS and BYO UPS could then beat ShipStation plus a separate returns app on total cost. Evaluate it as a bundle decision, not a shipping-only swap.
- [Inference] **When an API-first engine would win:** if the ERP team wants the pack bench fully inside the ERP, with no staff in a third-party UI. Then ShipStation API (same Auctane carrier connections, easiest migration) or EasyPost (vendor-neutral, cheap BYO) is the cleaner long-term fit. Expect similar per-month cost to ShipStation Standard, plus engineering for printing and returns.

### Gaps
- None of the recommendation's go/no-go conditions (AUP for paraphernalia, UPS contract rate passthrough, Redo webhook topics, ZPL support, pricing in writing) could be verified from public sources. Each needs a sales or support conversation or a sandbox test.
