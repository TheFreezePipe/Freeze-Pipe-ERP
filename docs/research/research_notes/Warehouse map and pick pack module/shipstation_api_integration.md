# ShipStation API and Platform Capabilities for a Real-Time Two-Way Pick-and-Pack Integration (as of Oct 2026)

Research scope note: Sources are official ShipStation V1 docs (shipstation.com/docs/api), official V2 docs (docs.shipstation.com), and ShipEngine webhook docs hosted on docs.shipstation.com. Some secondary sources were also used and are labeled as such. ShipStation Help Center (help.shipstation.com) and community.shipstation.com returned HTTP 403 to direct fetches, so help-center content below comes from search-result summaries of those pages. Treat those points as lower confidence. Anything recalled from prior knowledge and not re-verified is labeled "UNVERIFIED".

## 1. V1 vs V2: status, auth, rate limits, plan gating, webhooks

### Takeaway
V1 (ssapi.shipstation.com, Basic auth, 40 req/min) is officially deprecated with no published removal date, but it is still the only API with a full Orders resource (list/create-update/tags/holds/mark-shipped) and the classic order webhooks. V2 (api.shipstation.com/v2, `API-Key` header, 200 req/min) is ShipEngine-based and shipment/label-centric. Its own docs still call it "early release", and it does not expose a full sales-order model. For Freeze Pipe's flow, the realistic 2026 design is a hybrid: keep V1 for order ingest and write-back while it lasts, and use V2 for labels, batches and shipment tags. Isolate both behind an adapter, because V1 will be removed eventually.

### Cited Findings
- V1 auth: "ShipStation API V1 uses Basic HTTP authentication". The API Key is the username and the API Secret is the password. — [ShipStation V1 Requirements](https://www.shipstation.com/docs/api/requirements/)
- V1 rate limit: "The current Rate limit for each set of the API Key and Secret is 40 requests per minute." Responses carry X-Rate-Limit-Limit, X-Rate-Limit-Remaining and X-Rate-Limit-Reset headers. Over the limit, the API returns HTTP 429 `{"message": "Too Many Requests"}`, and "your application should stop making requests until X-Rate-Limit-Reset seconds have elapsed." — [ShipStation V1 Requirements](https://www.shipstation.com/docs/api/requirements/)
- V1 time zone: "The time zone represented in all responses is PST/PDT". Submitted dates use `yyyy-mm-dd hh:mm:ss` (24h). This matters for `modifyDateStart` polling windows. — [ShipStation V1 Requirements](https://www.shipstation.com/docs/api/requirements/)
- V1 deprecation: the V2 Security and Authentication page says V1 is deprecated and "will be removed in the future", with no date given. An earlier announcement promised advance notice. — [docs.shipstation.com/authentication (via search summary)](https://docs.shipstation.com/authentication); [Introducing ShipStation API blog](https://www.shipstation.com/blog/introducing-shipstation-api/)
- Third-party claim (April 2025): "API v1 will be sunset in approximately one year". This is not an official date, and V1 still appears to be live as of Oct 2026. — [1TeamSoftware](https://1teamsoftware.com/documentation/shipstation-shipping/using/shipstation-api-access-limited-to-gold-amp-scale-plans-effective-may-2025/)
- V2 base URL: `https://api.shipstation.com/v2`. "ShipStation API V2 is currently in an early release stage, which means you may find edge cases when trying out this API." Elsewhere the same page says "While the API is tested and stable...". — [V2 Getting Started](https://docs.shipstation.com/getting-started)
- V2 auth uses a single `API-Key` header. One V2 key can be active at a time, versus two V1 key/secret sets. V1 and V2 keys are not interchangeable. — [getmacha.com (secondary)](https://www.getmacha.com/blog/shipstation-ai-support-agent); key-count and non-interchangeability also reported from the help center via [search summary](https://help.shipstation.com/hc/en-us/articles/360025856212-ShipStation-API)
- V2 rate limit: "By default, ShipStation allows you to send up to 200 requests per minute." Over the limit, the API returns 429 with a `Retry-After` header (seconds). The docs recommend global retry logic. Use the `error_source` field to tell ShipStation limits from carrier limits. Increases can be requested at apisupport@shipstation.com. Use batch label and multi-shipment rate endpoints for bulk work. — [V2 Rate Limits](https://docs.shipstation.com/rate-limits)
- V2 endpoint groups in the Shipping API: Rates, Shipments (create, update, list, tag, cancel), Labels (create, download, list, void), Products, Multi-package labels, Batches, Return labels, Custom package types, Manifests, Pickups, Users. Inventory API: `/v2/inventory`, `/v2/inventory_warehouses`, `/v2/inventory_locations`. Address validation and tracking were listed as "coming". — [V2 Getting Started](https://docs.shipstation.com/getting-started)
- V2 orders model: a Sales Order "is not currently represented in full in the API". Its properties appear on the Shipment object. To make a shipment show in the Orders tab, pass `create_sales_order: true`. The page also warns that "nulling out the items on a Shipment may cause issues" with marketplace notification. — [V2 Getting Started](https://docs.shipstation.com/getting-started)
- V2 also exposes `/v2/fulfillments` (GET/POST) and `/v2/downloads/...` per a third-party connector catalog. Not confirmed on official pages. — [withone.ai mirror](https://www.withone.ai/knowledge/ship-station?page=3)
- V2 webhooks exist under `/v2/environment/webhooks` (POST/GET/PUT/DELETE). A third-party mirror of the reference lists these event enum values: `batch`, `carrier_connected`, `order_source_refresh_complete`, `rate`, `report_complete`, `sales_orders_imported`, `track`, `batch_processed_v2`, `fulfillment_rejected_v2`, `fulfillment_shipped_v2`, `label_created_v2`, `shipment_created_v2`, `track_event_v2`. Optional `store_id` and custom headers are supported. — [withone.ai mirror (secondary; verify against official reference)](https://withone.ai/knowledge/ship-station/conn_mod_def%3A%3AGJ7FK6_0SOA%3A%3AptyxG47sReixvSaAgE_kzg)
- ShipEngine-family webhook mechanics, documented on docs.shipstation.com:
  - Payloads carry `resource_url` and `resource_type`, plus `data` for some events.
  - Signature is RSA-SHA256, in the headers `x-shipengine-rsa-sha256-key-id`, `x-shipengine-rsa-sha256-signature` and `x-shipengine-timestamp`. Verify against the JWKS at `https://api.shipengine.com/jwks`. The signed string is `timestamp.rawBody`, and timestamps more than 5 minutes off should be rejected.
  - Listeners have 10 seconds to return 2xx. Failures get "a maximum of two additional attempts", typically 30 minutes apart, and the event is dropped after 3 failures.
  - A duplicate event subscription returns 409.
  - No per-order "updated" event exists. `sales_orders_imported` (Beta) is batch-level only. — [ShipEngine webhooks guide on docs.shipstation.com](https://docs.shipstation.com/apis/shipengine/docs/guides/webhooks)
- V1 webhooks: `POST /webhooks/subscribe` takes `target_url`, `event`, optional `store_id` (only fires for that store) and `friendly_name`. Events: ORDER_NOTIFY, ITEM_ORDER_NOTIFY, SHIP_NOTIFY, ITEM_SHIP_NOTIFY, FULFILLMENT_SHIPPED, FULFILLMENT_REJECTED. Existing webhooks can only be modified in the UI. — [V1 Subscribe to Webhook](https://www.shipstation.com/docs/api/webhooks/subscribe/)
- Plan gating conflict:
  - ShipStation help center (via search summary): V1 API access is limited to accounts "on a Standard or Accelerate plan or higher". — [help.shipstation.com ShipStation API](https://help.shipstation.com/hc/en-us/articles/360025856212-ShipStation-API)
  - 1TeamSoftware: "beginning May 19, 2025, API usage will be limited to Gold-plan accounts in the US and Canada" (Scale in UK/AU/NZ/EU). Starter/Growth "will lose API access". — [1TeamSoftware](https://1teamsoftware.com/documentation/shipstation-shipping/using/shipstation-api-access-limited-to-gold-amp-scale-plans-effective-may-2025/)
  - V2 requires "a plan that offers shipping functionality and have a valid API key". — [V2 Getting Started](https://docs.shipstation.com/getting-started)
  - 2026 pricing-review sites disagree on tier names (Starter/Standard/Premium vs Starter/Growth/Scale/High-Volume) and on the API threshold ($29.99 Standard vs $99.99 Scale). — [revenuegeeks](https://revenuegeeks.com/software/shipstation/pricing); [1TeamSoftware pricing review](https://1teamsoftware.com/2025/05/12/shipstation-pros-cons/); [Capterra](https://www.capterra.com/p/155621/ShipStation/)

### Inferences
- Freeze Pipe's existing V1 integration (webhook plus nightly `/orders` reconcile) implies their current plan includes API access. Any plan downgrade could silently cut it off, so confirm in Account > API Settings.
- Because V2 has no full Orders resource or order-level change webhooks, a pure-V2 order ingest would have to be built on `/v2/shipments` (each ShipStation order is backed by a shipment) and polling on `modified_at_start`. This is workable but less direct than V1 `/orders`.
- 40 req/min on V1 is the binding constraint for a "real-time" picker UI. The ERP must never call ShipStation per screen view. It should serve pickers from Supabase and treat ShipStation calls as queued background sync.

### Gaps
- No official V1 removal date found as of Oct 2026.
- The exact current plan names and API threshold could not be confirmed. Help center pages returned 403, and secondary sources conflict.
- The official V2 webhook event enum was confirmed only via a third-party mirror. Retry semantics for the `_v2` events specifically were not confirmed.
- Whether a V1 and a V2 key can be used concurrently on the same account was not explicitly confirmed. Secondary sources imply they can, as separate credentials.

## 2. Orders: fields, filters, pagination, webhooks, near-real-time pull

### Takeaway
V1 `/orders` provides everything a pick module needs. Order-level fields include orderId (ShipStation PK), orderKey (source-system key), orderNumber and orderStatus. Item-level fields include orderItemId, lineItemKey, sku, quantity, warehouseLocation, upc, fulfillmentSku and adjustment. Filters include modifyDateStart and orderStatus, with pageSize up to 500. Webhooks are thin pings (`resource_url` + `resource_type`) with undocumented retries, so they must be paired with modifyDate polling.

### Cited Findings
- List Orders (`GET /orders`) query parameters:
  - `customerName`, `itemKeyword`
  - date ranges: `createDateStart/End`, `modifyDateStart/End`, `orderDateStart/End`, `paymentDateStart/End`
  - `orderNumber`, `orderStatus`, `storeId`, `customsCountryCode`
  - `sortBy`, `sortDir`, `page`, `pageSize`
  - "Max value is 500" for pageSize. The default sort is ascending `orderId`. Responses carry `total`, `page` and `pages`. — [V1 List Orders](https://www.shipstation.com/docs/api/orders/list-orders/)
- orderStatus values for the list filter: `awaiting_payment`, `awaiting_shipment`, `pending_fulfillment`, `shipped`, `on_hold`, `cancelled`, `rejected_fulfillment`. "If left empty, orders of all statuses are returned." — [V1 List Orders](https://www.shipstation.com/docs/api/orders/list-orders/)
- `orderNumber` filtering is a starts-with match ("109" also matches "1096" and "1097"). Always confirm an exact match client-side. — [getmacha.com (secondary)](https://www.getmacha.com/blog/shipstation-ai-support-agent)
- OrderItem fields:
  - `orderItemId` (read-only)
  - `lineItemKey`: "An identifier for the OrderItem in the originating system"
  - `sku`, `name`, `imageUrl`, `weight`, `quantity`, `unitPrice`, `taxAmount`, `shippingAmount`
  - `warehouseLocation`: "The location of the product within the seller's warehouse (e.g. Aisle 3, Shelf A, Bin 5)"
  - `options`, `productId`
  - `fulfillmentSku`: used "if the fulfillment provider requires an identifier other than the SKU"
  - `adjustment`: "non-physical adjustment to the order (e.g. a discount or promotional code)"
  - `upc`
  - `createDate`, `modifyDate` (read-only). "modifyDate will equal createDate until a modification is made." — [V1 OrderItem model](https://www.shipstation.com/docs/api/models/order-item/)
- advancedOptions in the Create/Update example: `warehouseId`, `storeId`, `customField1`, `customField2`, `customField3`, `source`, `mergedOrSplit`, `mergedIds`, `parentId`. `mergedOrSplit` "is always required for merged or split orders". — [V1 Create/Update Order](https://www.shipstation.com/docs/api/orders/create-update-order/)
- Webhook model: `resource_url` is described as "Use this URL to get the resource that triggered the webhook" (200-char limit), accessed "with ShipStation API Basic Authentication credentials". `resource_type` is one of the six event names. — [V1 Webhook model](https://www.shipstation.com/docs/api/models/webhook/)
- V1 webhooks: "V1 offers no signature or HMAC". "V1 retry behavior isn't documented, so you can't assume a failed delivery will be retried." Recommended practices: validate the resource_url host, keep the endpoint URL secret, return 200 immediately and fetch asynchronously, queue fetches under 40/min, and reconcile. — [Hookdeck guide (secondary)](https://hookdeck.com/webhooks/platforms/guide-to-shipstation-webhooks-features-and-best-practices.md)
- A real-world failure mode: a vendor's webhook subscription was pinned to one `store_id`, so orders routed to other stores produced no notification and arrived only via the nightly poll, up to a day late. The fix was account-wide subscriptions. — [Endless Commerce changelog, Aug 2026](https://endlesscommerce.com/changelog/2026-08-02-shipstation-order-routing-and-notifications/)
- Webhook backlog reports: "Shipstation is struggling to process webhooks that are being sent" (Subbly support). — [Subbly](https://support.subbly.co/orders/why-my-orders-don-t-appear-in-my-shipstation-admin)
- V2 shipments list: `GET /v2/shipments`
  - `shipment_status` is one of `pending`, `processing`, `label_purchased`, `cancelled`
  - other filters: `modified_at_start/end`, `created_at_start/end`, `sales_order_id`, `tag`, `page`, `page_size`
  - When filtering by batch, the API ignores status, date and tag filters. — [V2 List Shipments (search summary)](https://docs.shipstation.com/list-shipments); [OpenAPI list_shipments](https://docs.shipstation.com/apis/openapi/shipments/list_shipments)
- V2 `sales_order_id` is ShipStation's internal ID, not the customer-facing order number. — [getmacha.com (secondary)](https://www.getmacha.com/blog/shipstation-ai-support-agent)

### Inferences
- Use `orderId` as the ShipStation-side primary key in the ERP. It is needed for every V1 write call. Store `orderKey`/`orderNumber` plus `storeId` for cross-reference to Shopify. Use `orderItemId` (and `lineItemKey`, which typically carries the Shopify line item ID) as the item-level identity for pick lines.
- Near-real-time pull pattern:
  1. ORDER_NOTIFY ping triggers a queued GET on `resource_url`.
  2. A short-interval poll (e.g., every 2-5 min) of `GET /orders?modifyDateStart=<last watermark minus overlap>&pageSize=500&sortBy=ModifyDate` catches edits, cancellations and missed pings. The sortBy value "ModifyDate" is UNVERIFIED. Confirm the allowed `sortBy` enum.
  3. The nightly full reconcile stays as the safety net.
  4. Convert PST/PDT for watermarks.
- UNVERIFIED (prior knowledge): the V1 ORDER_NOTIFY `resource_url` typically looks like `https://ssapi.shipstation.com/orders?importBatch=<guid>` and returns a paged orders list. SHIP_NOTIFY points to `/shipments?batchId=...`. Page through it, because one ping can cover multiple orders.
- ORDER_NOTIFY fires on import, not on edits. Edits, cancellations and holds made in ShipStation or Shopify after import are only caught by polling on modifyDate.
- Freeze Pipe's existing "signature check" on V1 webhooks cannot be a ShipStation-documented HMAC, because V1 has none. It is likely a shared secret in the target URL, or the undocumented `x-shipengine-*` headers. Verify what the current edge function actually validates.

### Gaps
- An official statement on V1 webhook retry count and timeouts was not found.
- The exact `sortBy` allowed values were not retrieved.
- Whether `modifyDate` on the order changes when only item-level data or tags change was not verified.

## 3. Writing back to orders (tags, custom fields, notes, status, mark shipped, holds, updateorder risk)

### Takeaway
V1 supports targeted, low-risk writes: `addtag`/`removetag` (by tagId), `holduntil`/`restorefromhold`, `assignuser` and `markasshipped`. Anything else (custom fields, internal notes, item warehouseLocation) requires `POST /orders/createorder` in update mode. That call has no partial updates, so the full order must be sent, and only open orders can be updated. Prefer tags and holds as the "picking in progress" signal, and avoid full-order upserts on marketplace-imported orders except for carefully round-tripped fields.

### Cited Findings
- Add tag: `POST https://ssapi.shipstation.com/orders/addtag` with body `{orderId, tagId}`. Get tagIds from Accounts ListTags. The same doc set lists Remove Tag, List By Tag, List Account Tags, Hold Order Until, Restore From Hold and Assign User. — [V1 Add Tag](https://www.shipstation.com/docs/api/orders/add-tag/)
- Holds: `POST /orders/holduntil` holds an order until a date, after which it automatically returns to Awaiting Shipment. `POST /orders/restorefromhold` releases it early. V2 has no hold endpoint. — [getmacha.com (secondary)](https://www.getmacha.com/blog/shipstation-ai-support-agent); endpoints listed at [V1 Add Tag page links](https://www.shipstation.com/docs/api/orders/add-tag/)
- Create/Update Order (`POST /orders/createorder`):
  - "If the `orderKey` is specified, ShipStation will attempt to locate the order with the specified `orderKey`". If it is not found, a new order is created.
  - "This call does not currently support partial updates." "The entire resource must be provided in the body of the request."
  - Only `awaiting_payment`, `awaiting_shipment` and `on_hold` orders can be updated. "Orders in the `cancelled` and `shipped` states may not be updated."
  - Including `orderId` "will help prevent duplicate order records". `orderKey` is "always required when updating a split order".
  - The example sets `"warehouseLocation": "Aisle 1, Bin 7"` on an item. — [V1 Create/Update Order](https://www.shipstation.com/docs/api/orders/create-update-order/)
- Note: V1 has no separate `/orders/updateorder` endpoint. "Update" means calling `createorder` with an existing orderKey/orderId. — [V1 Create/Update Order](https://www.shipstation.com/docs/api/orders/create-update-order/)
- Mark as shipped: `POST /orders/markasshipped` with `orderId` (req), `carrierCode` (req), `shipDate`, `trackingNumber`, `notifyCustomer` (default false) and `notifySalesChannel` (default false). It "Marks an order as Shipped without creating a label in ShipStation." — [V1 Mark as Shipped](https://www.shipstation.com/docs/api/orders/mark-as-shipped/)
- `DELETE /orders/{orderId}` is a soft delete. It removes the order from the UI but keeps it in the database. — [getmacha.com (secondary)](https://www.getmacha.com/blog/shipstation-ai-support-agent)
- V2 shipment updates: `PUT /v2/shipments/{shipment_id}` takes a similar full object. V2 allows writing shipment tags and internal notes. — [getmacha.com (secondary)](https://www.getmacha.com/blog/shipstation-ai-support-agent); [V2 Getting Started](https://docs.shipstation.com/getting-started) (lists "tag" under Shipments)

### Inferences
- Recommended write-back primitives for pick/pack status:
  - Use account tags created once in the UI (e.g., "ERP-PICKING", "ERP-PICKED", "ERP-PACKED", "ERP-EXCEPTION"), applied via addtag/removetag. Tags are visible in ShipStation, filterable, and usable by automation rules, and they never touch order data.
  - Optionally use `holduntil` while an order is being picked, so nobody prints a label in ShipStation mid-pick. This changes status to `on_hold`, which may affect Shopify-side views and automation. Test it.
- Pushing bin locations into ShipStation by rewriting `warehouseLocation` with full-order createorder upserts is risky:
  - The full payload must round-trip every field (items, addresses, advancedOptions, amounts).
  - Any omitted field may be nulled. This is an inference from "entire resource must be provided".
  - It can collide with Shopify re-imports.
  - Each order costs a call against the 40/min budget.
  - Better: set `warehouseLocation` at the product level in ShipStation, which feeds packing slips and pick lists, or just print bin locations from the ERP itself. Product-level Location as the source for item warehouseLocation is UNVERIFIED in this research.
- If the ERP purchases labels outside ShipStation, call `markasshipped` with `notifySalesChannel: true` (and `notifyCustomer` per policy) so Shopify gets tracking. This also produces the SHIP_NOTIFY that the existing inventory deduction depends on. Whether markasshipped triggers SHIP_NOTIFY is UNVERIFIED and must be tested.

### Gaps
- Exact list-tags endpoint path (believed to be `GET /accounts/listtags`) and remove-tag body were not fetched. UNVERIFIED but likely symmetric with addtag.
- Whether internalNotes/customField edits via createorder survive later Shopify re-syncs was not confirmed.

## 4. Shipments and labels (rates, carriers, formats, voids, batches, external label purchase)

### Takeaway
Both APIs can buy labels for an existing ShipStation order. V1 `POST /orders/createlabelfororder` returns a base64 PDF. V2 offers `POST /v2/labels/shipment/:shipment_id`, `/v2/labels/rates/:rate_id`, `/v2/labels` and batches, with PDF, PNG and ZPL output. So an ERP-driven "packer verifies, then label prints" step is technically feasible. The risks are postage spend, irreversible voids, and keeping ShipStation as the system of record for the shipment.

### Cited Findings
- V1 Create Label for Order:
  - Body: `orderId`, `carrierCode`, `serviceCode`, `confirmation` (none, delivery, signature, adult_signature, direct_signature), `shipDate`, `testLabel` (required; USPS-only test), plus optional `weight`, `dimensions`, `insuranceOptions`, `internationalOptions`, `advancedOptions`. `packageCode` appears in the example.
  - Response: `shipmentId`, `shipmentCost`, `insuranceCost`, `trackingNumber`, `labelData` ("a base64 encoded PDF value"). The page documents only PDF output. — [V1 Create Label for Order](https://www.shipstation.com/docs/api/orders/create-label/)
- V1 void: `POST /shipments/voidlabel` by shipmentId. V2 void: `PUT /v2/labels/{label_id}/void`. `PUT /v2/shipments/{id}/cancel` requires voiding first. Voided labels "Cannot Be Un-Voided!" — [getmacha.com (secondary)](https://www.getmacha.com/blog/shipstation-ai-support-agent)
- V2 label creation options:
  - `POST /v2/labels` (full shipment)
  - `POST /v2/labels/rates/:rate_id`
  - `POST /v2/labels/shipment/:shipment_id`
  - `POST /v2/labels/rate_shopper_id/:rate_shopper_id` (cheapest / fastest / best_value)
  - `POST /v2/labels/shipping_rules/:shipping_rule_id`
  - "When you use POST /v2/labels to create labels with your production API key, you are purchasing the label."
  - Examples use `label_format: "pdf"` and `label_layout: "4x6"`. Downloads come in PDF, PNG and ZPL. `label_download_type: "inline"` returns the label in the same response. Multi-package downloads do not support PNG. — [V2 Create Labels](https://docs.shipstation.com/create-labels); [ShipEngine label guide on docs.shipstation.com](https://docs.shipstation.com/apis/shipengine/docs/labels/create-a-label)
- V2 batches: `POST /v2/batches/{id}/add`, `/remove`, `/process/labels`, `GET /v2/batches/{id}/errors`, `PUT` (archive), `DELETE`. Batch-complete notification uses the `batch` / `batch_processed_v2` webhook. — [withone.ai mirror (secondary)](https://www.withone.ai/knowledge/ship-station?page=3); [ShipEngine webhooks guide](https://docs.shipstation.com/apis/shipengine/docs/guides/webhooks)
- V2 adds batch labels, return labels and manifests that V1 lacks. — [V2 Getting Started](https://docs.shipstation.com/getting-started)
- The V2 docs recommend batch label and multi-shipment rate endpoints to stay under rate limits. — [V2 Rate Limits](https://docs.shipstation.com/rate-limits)
- ShipEngine webhooks/label docs hosted at docs.shipstation.com still document `api.shipengine.com/v1` paths, while V2 paths are `/v2/...`. Documentation is split across the two products. — [ShipEngine webhooks guide](https://docs.shipstation.com/apis/shipengine/docs/guides/webhooks)

### Inferences
- For Freeze Pipe, the minimal-re-keying design keeps carrier/service/package selection in ShipStation automation rules. Rules pre-populate the order when it imports. The ERP's pack-verify step then calls a label endpoint with those preset values, plus the measured weight and box, and prints the returned label.
- V2 `/v2/labels/shipment/:shipment_id` against the order's backing shipment is the cleanest path. It supports ZPL for thermal printers. Confirm in a test account that this marks the ShipStation order shipped and notifies Shopify. The docs reviewed do not say, so this is UNVERIFIED.
- V1 `createlabelfororder` is simpler to adopt immediately with current credentials, but it is PDF-only per docs and tied to a deprecated API.
- No official statement was found on whether API-created labels count toward ShipStation plan shipment limits. The working assumption, UNVERIFIED, is that they do, because they become ShipStation shipments.
- Rates: V1 rate endpoint (`POST /shipments/getrates`) and carrier list (`GET /carriers`) are UNVERIFIED in this pass. V2 has a Rates group, per Getting Started.

### Gaps
- Whether V2 label purchase on a sales-order-linked shipment triggers marketplace notification and V1 SHIP_NOTIFY.
- Whether API labels count toward plan label/shipment quotas.
- The full `label_format` and `label_layout` enum lists for V2 (e.g., letter) were not confirmed.

## 5. Built-in ShipStation features that overlap with the plan

### Takeaway
ShipStation natively offers barcode-driven Scan to Print, Scan to Verify, and Verify and Print. Packing slips carry an order barcode. Item verification works by SKU or UPC. Bin locations ride on the item `warehouseLocation` field, which appears on documents. ShipStation does not provide true pick-to-tote, multi-order wave picking with tote assignment, or bin-level inventory with putaway. That is the gap an ERP pick module, or WMS add-ons like SkuVault, fill.

### Cited Findings
- Scan tab workflows (help center via search summary):
  - Scan to Verify: scan the SKU or UPC of each item while packing.
  - Scan to Print: scan the order barcode on the packing slip to open the shipment. A USB scale weight auto-fills, then Print Label or the `P` hotkey.
  - Scan to Verify and Print: combines both.
  - Requirements: a scanner sending carriage return, and packing slips with a "Scan to View" or order-number barcode. — [Verify & Print Shipments with Barcode Scan](https://help.shipstation.com/hc/en-us/articles/360031021831-Verify-Print-Shipments-with-Barcode-Scan); [Barcode Scanning Overview](https://help.shipstation.com/hc/en-us/articles/360026158591-Barcode-Scanning-Overview); [Mobile: Scan to View](https://help.shipstation.com/hc/en-us/articles/360026139411-Mobile-Scan-to-View)
- Verification needs product records with UPC/fulfillment SKUs. The match rule is set under Settings > Shipping > Workflow Settings > "Scan To Verify Items By". — [meetstring.com (secondary)](https://www.meetstring.com/blog/how-scan-to-verify-works-in-shipstation/)
- `warehouseLocation` is defined as the item's location "within the seller's warehouse (e.g. Aisle 3, Shelf A, Bin 5)". — [V1 OrderItem model](https://www.shipstation.com/docs/api/models/order-item/)
- The SkuVault partner listing says it uses ShipStation tags to pull orders or create pick sessions, displays SkuVault locations on ShipStation packing slips, and prints labels inside SkuVault. — [ShipStation partner page: SkuVault Core](https://www.shipstation.com/en-ca/partners/skuvault-core.md)
- ShipStation Connect: assign a default printer per document type (labels, packing slips) and set label format and print order. Use USB printers on the workstation. — [ShipStation Connect page](https://www.shipstation.com/fulfillment/shipping/shipstation-connect.md)
- Plan gating for Scan to Verify, batches, pick lists and inventory: not confirmed. Pricing-review sites say mid tiers include "basic warehouse management" and mention a paid Inventory Sync add-on. — [Capterra](https://www.capterra.com/p/155621/ShipStation/); [revenuegeeks](https://revenuegeeks.com/software/shipstation/pricing)

### Inferences
- The lowest-effort hybrid: the ERP does guided picking into totes on mobile and records tote-to-order mapping. At the pack station, the packer either:
  - (a) uses ShipStation's native Scan to Verify and Print with the existing barcoded packing slip, which is zero label-API risk, or
  - (b) uses an ERP verify screen and then triggers the label via API.

  Option (a) gives "seamless" behavior quickly. Option (b) gives a single UI but more engineering.
- If the ERP owns bin locations, printing them on the ERP's own pick sheet avoids the createorder rewrite risk altogether.

### Gaps
- Official details on pick-list document contents, ShipStation Mobile app pick features, and inventory module plan gating were not retrievable (help center 403).
- Whether Scan to Verify can scan a tote barcode (versus the order barcode) is unknown.

## 6. Recommended real-time patterns, idempotency, edits/cancels/splits, concurrency, how WMS vendors integrate

### Takeaway
Use webhook-as-trigger plus watermark polling plus nightly reconcile. Key on `orderId`, with `orderKey`+`storeId` as secondary and `orderItemId` for lines. Re-validate order status and modifyDate at pick start and again before label purchase. Enforce picker locking in Postgres, not in ShipStation. WMS vendors split two ways: some pick and pack in the WMS while ShipStation prints labels, and others print labels in the WMS (SkuVault, SKUSavvy) using ShipStation as the label/carrier engine.

### Cited Findings
- V1 thin pings with no documented retries call for persisting pings and reconciling against the API, and queuing fetches under 40/min. — [Hookdeck guide (secondary)](https://hookdeck.com/webhooks/platforms/guide-to-shipstation-webhooks-features-and-best-practices.md)
- Subscribe account-wide, not per store, or pings from other stores will be missed. — [Endless Commerce changelog](https://endlesscommerce.com/changelog/2026-08-02-shipstation-order-routing-and-notifications/)
- Split and merged orders require `advancedOptions.mergedOrSplit`, and split-order updates need `orderKey` and `orderId`. `mergedIds` and `parentId` exist in advancedOptions. — [V1 Create/Update Order](https://www.shipstation.com/docs/api/orders/create-update-order/)
- SKULabs + ShipStation patterns:
  - (1) ShipStation prints labels in groups and SKULabs picks, by scanning ShipStation packing-slip order barcodes. Set ShipStation to "delay shipment notifications until your end-of-day".
  - (2) SKULabs picks and packs, then "Scan the order barcode on packing slips to open the order on ShipStation" to print.
  - Inventory deduction runs either on the marketplace shipped status or via imported ShipStation shipments. — [SKULabs help](https://www.skulabs.com/help/en/articles/8240397-how-to-pick-pack-and-ship-using-both-skulabs-and-shipstation)
- SkuVault prints labels inside SkuVault and uses tags to drive pick sessions. — [ShipStation partner page: SkuVault Core](https://www.shipstation.com/en-ca/partners/skuvault-core.md)
- SKUSavvy describes itself as a front-end WMS that "will talk to ShipStation behind the scenes to get labels". — [SKUSavvy FAQ](https://skusavvy.com/blog/shipstation-wms-frequently-asked-questions)

### Inferences
- Idempotency:
  - Upsert orders on `orderId`, and store `modifyDate` so stale fetches never overwrite newer data.
  - Upsert lines on `orderItemId`.
  - Dedupe webhook pings by hashing `resource_url` and processing the fetched orders idempotently.
  - Shipments upsert on `shipmentId` / V2 `label_id`. Inventory deduction must be idempotent per shipment, which Freeze Pipe's existing ship-deduction likely already handles. Verify voids reverse deductions.
- Edits and cancels after pick start:
  - At pack verify, and again immediately before label purchase, re-fetch the order with `GET /orders/{orderId}`. That path is UNVERIFIED but standard.
  - Abort if the status is not `awaiting_shipment`/`on_hold`-by-ERP, or if `modifyDate` changed.
  - Surface a "changed since pick" exception and return the tote.
- Concurrency: assign orders to pickers transactionally in Supabase (e.g., `SELECT ... FOR UPDATE SKIP LOCKED` or an atomic claim RPC). Optionally mirror the claim to ShipStation with a tag or `assignuser`, so UI users see it. ShipStation has no API-level lock.
- Multi-store: filter or segment by `storeId`, subscribe webhooks without `store_id`, and include `storeId` in dedupe keys alongside `orderKey`.

### Gaps
- Public documentation of Finale, Veeqo, Packiyo and Ordoro ShipStation connector directions was not retrieved in this pass. Veeqo is an Amazon-owned shipping/WMS platform and typically replaces ShipStation rather than integrating with it, but that is UNVERIFIED here.

## 7. Printing from a web ERP

### Takeaway
Browsers cannot print silently to thermal printers. Realistic options are:
- QZ Tray (a local agent with a JS API for raw ZPL and PDF, used by Ship&co, Shipium and Amazon)
- PrintNode (hosted cloud printing with a local client)
- browser print dialogs for PDF 4x6
- leaving label printing to ShipStation Connect inside ShipStation's own UI

### Cited Findings
- QZ Tray lets browser apps print to local thermal printers. It needs a raw printer queue, QZ Tray 2.2.5+ per Ship&co, and a user "Allow" prompt. Shipium's console and Amazon use it for PDF and ZPL. — [Ship&co ZPL article](https://support.shipandco.com/hc/en-us/articles/52978688247449); [Shipium Print Labels](https://docs.shipium.com/docs/print-labels)
- ZPL "allows direct printing to thermal printers without generating a PDF file". — [Ship&co](https://support.shipandco.com/hc/en-us/articles/52978688247449-How-to-use-thermal-printer-to-print-ZPL-shipping-labels-in-Ship-co)
- PrintNode is a hosted service to "add remote printing to your application". It has a Zapier link to ShipStation. — [Zapier PrintNode + ShipStation](https://zapier.com/apps/PrintNode/integrations/shipstation)
- ShipStation Connect handles printing for ShipStation's own UI (default printer per document type). — [ShipStation Connect](https://www.shipstation.com/fulfillment/shipping/shipstation-connect.md)

### Inferences
- For Freeze Pipe, PrintNode suits server-side printing from Supabase edge functions. The edge function posts the label (PDF/ZPL base64) to the PrintNode API, and the pack station's PrintNode client prints it. Mobile devices then need no local agent. QZ Tray suits desktop pack stations. Tote labels can be ZPL generated by the ERP.
- ShipStation Connect is not usable as a print target for third-party apps. No public printing API was found.

### Gaps
- No evidence was found of a ShipStation API to send print jobs to ShipStation Connect. Rollo-specific ZPL/PDF support was not researched.

## 8. ShipEngine as an alternative or complement

### Takeaway
V2 is effectively ShipEngine under the ShipStation brand: same webhook signature scheme, JWKS, and error_source naming ShipEngine. A custom ERP could buy labels through ShipEngine/V2 directly. But labels bought outside the ShipStation order context would not automatically close the ShipStation order or notify Shopify. Using V2 labels against the ShipStation-backed shipment, or `markasshipped` afterward, keeps the two in sync.

### Cited Findings
- V2 runs on what was formerly ShipEngine, so errors name ShipEngine as the source. — [getmacha.com (secondary)](https://www.getmacha.com/blog/shipstation-ai-support-agent)
- Existing ShipEngine-origin customers can use the same key against `https://api.shipstation.com/v2/`. — [1TeamSoftware key guide (search summary)](https://1teamsoftware.com/documentation/shipstation-shipping/using/howto-get-your-shipstation-api-key-v1-to-v2/)
- ShipStation positions V2 as "ShipEngine's Next Evolution". — [ShipStation blog](https://www.shipstation.com/blog/introducing-shipstation-api/)
- ShipEngine-style webhooks: RSA-SHA256 via JWKS, 10s ack, 2 retries about 30 min apart. — [ShipEngine webhooks guide on docs.shipstation.com](https://docs.shipstation.com/apis/shipengine/docs/guides/webhooks)

### Inferences
- Use standalone ShipEngine only if Freeze Pipe wanted to drop ShipStation's order UI entirely, with the ERP pulling directly from Shopify. Otherwise, use ShipStation V2 labels so ShipStation remains the record of shipments, voids and Shopify fulfillment.
- Existing ShipStation carrier connections and rates (ShipStation Carriers / discounted USPS-UPS) are available to V2 calls on the same account. This is UNVERIFIED for standalone ShipEngine accounts, which have separate billing.

### Gaps
- The help.shipengine.com "New ShipStation API" article returned 403. Official guidance on when to choose ShipEngine versus ShipStation V2, and on pricing differences, was not retrieved.
