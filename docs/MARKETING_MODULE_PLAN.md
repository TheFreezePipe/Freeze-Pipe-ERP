# Marketing Module — Planning Doc

> Status: **v0.3 — Phase 1 (calendar + CRUD shell) SHIPPED 2026-06-18; audited + industry-researched 2026-07-03; building the connective phases next.** Living document; expect iteration.
> Last updated: 2026-07-03.
> Companion to the parked Analytics module plan. Honors the **2022-01-01 data-relevance floor** (pre-2022 store/promo data is not representative).

---

## 0. v0.3 addendum — audit + industry research (2026-07-03)

A full audit of the shipped Phase 1 shell plus deep research on industry leaders
(DTC demand planning: Cogsy, Inventory Planner, Netstock, Alloy, Flieber,
Prediko, Fabrikatör, Toolio · campaign calendars: Klaviyo, CoSchedule, Asana,
Monday, Airtable, Planable · NPD/stage-gate: Stage-Gate Intl, Productboard,
Kanbanize, Delogue, Anvyl, Arena, Backbone). Three conclusions:

**A. The shell is sound and the original design is validated.** The learning
flywheel this doc specifies (§4.1 predict→record→observe→update, promo-labeled
history, uplift priors, launch analogs) is precisely what the market leaders
sell as their differentiator (Netstock "ML Events", Alloy de-promoted baseline,
Cogsy reference-SKU launch sims). Build THIS plan; don't pivot.

**B. Organizing principle (owner mandate): the CALENDAR is the operating
system.** Every capability below either renders ON the calendar or hangs off an
event opened FROM it. No feature ships as a disconnected page.

**C. What the audit found missing (the connective tissue), with the concrete
mechanics research contributed:**

1. **Scope→SKU expansion** (blocker for everything): a view/RPC resolving any
   offer to concrete SKUs by date range (sitewide → active SKUs; category →
   display_category; sku_set → mkt_offer_skus). Everything downstream keys on it.
2. **Ops surfacing** (alignment goal): marketing badges on Stock Levels rows,
   NewFactoryOrderDialog lines, and the order builder ("sale in 12d", "launch
   Aug 1"); a "Marketing — next 14 days" section in the 8am daily report;
   read access for all internal roles. *(Monday.com digest pattern.)*
3. **Uplift as data** (§2.1 already spec'd it; Phase 1 omitted it): restore
   `planner_uplift_pct` + per-SKU overrides on `mkt_offer_skus`, add
   offer-level `expected_uplift_pct` for sitewide/category, and
   `effective_discount_pct`. Rule (Inventory Planner): uplift is ALWAYS a
   percent over baseline, never absolute units.
4. **Recurring-event guard** (Cogsy): an `annual_recurring` flag on sales;
   recurring events show on the calendar + label history but their uplift is
   NOT overlaid on the forecast (YoY baseline already contains them) —
   prevents double-counting BFCM/4-20.
5. **Outcomes loop** (§2.5 fc_predictions, now concretized): when an event
   ends, auto-compute actual-vs-baseline lift per affected SKU from
   sales_daily; store on the event; PRE-FILL the measured lift next time a
   similar event is scheduled (Netstock). Same for launches:
   `actual_first_30d_units` vs expected, and persist `sold_out_at` per member
   (censoring signal — currently derived live and lost on restock).
6. **Launch↔ops linkage**: nullable `factory_order_id` on launch members;
   derive "must order by" = ready-by − lead time; red **stock-risk chip on the
   calendar event** when projected cover (run-rate + uplift) or PO ETA
   conflicts with the event window. Derived, never manual — consistent with
   the no-stored-status philosophy. *(Cogsy/Anvyl work-back pattern.)*
7. **Inventory-aware broadcasts** (Fabrikatör): broadcasts gain optional
   featured-SKU links; the form + calendar show a stock-adequacy hint
   ("12 days of cover vs 80k-recipient send"). Broadcast metrics get typed
   columns + surfaced results + a "log results" nudge on past sends.
8. **Backfill/sync hooks**: `source` + `external_ref` (partial UNIQUE) on
   sales/offers/broadcasts NOW, while tables are near-empty — prerequisite for
   the 2022+ manual backfill and the eventual Shopify/Klaviyo import phase.
9. **Launch cold-start via reference SKUs** (§4.4 confirmed; Cogsy/Flieber
   mechanics): `reference_sku_id` + scale factor on launch members; forecast
   blends reference curve → own actuals with a decaying weight, gated by the
   existing 60/mo trust threshold.
10. **NPD kanban mechanics** (for §2.4, stages unchanged): append-only
    `stage_events` with outcome enum advance/hold/kill/recycle + required
    reason on kill/hold (Stage-Gate) — Purgatory/Halted become outcomes with
    stories; time-in-stage badges with per-stage expected days (Kanbanize);
    an `npd_samples` child table for prototype rounds w/ verdicts + photos
    (Delogue); structured card fields (factory, MOQ, quoted cost, lead-time,
    target quarter — Backbone); soft WIP limits (Trello); and the handoff:
    "Ready for Confirmation" → drafts the linked `mkt_launches` row;
    "Complete/Ordered" → links the factory order with work-back milestone
    dates (Productboard/Anvyl). Post-launch 60–90d review task closes the loop.

**Reconciliations with prior decisions (old decision wins unless noted):**
- *Holiday overlay* (research) vs *"don't seed holidays"* (§8): keep NOT
  seeding events. If ever added, it's a read-only visual overlay layer,
  default OFF — owner's call later.
- *Approval lifecycle Draft→Ops-Confirmed* (Planable) vs *derived-only
  statuses* (§2.1): rejected. Alignment pressure comes from the DERIVED
  stock-risk chip + daily digest, not manual workflow states.
- *ICS calendar feed* (Airtable pattern): nice-to-have, phase-later.

**Revised phasing (supersedes §7 ordering; Q4 clock: the promo-aware forecast
must land by early August for the Aug–Sep ordering window):**
- **Phase A — Make it real:** scope-expansion view · ops badges + digest
  section · calendar upgrades (agenda view for the weekly sync, +N-more day
  popover, filters) · read access for all roles · additive schema (uplift
  fields, source/external_ref, effective_discount_pct, annual_recurring) ·
  manual backfill of 2022–2025 major events with the owner.
- **Phase B — Close the loop:** post-event lift reports · broadcast results
  surfacing + nudges · sold_out_at persistence · launch↔factory-order link,
  order-by chips, stock-risk calendar chips.
- **Phase C — Feed the forecast (by early Aug):** promo-labeled sales_daily
  view → engine de-promotes baseline · fc_demand_events overlay replacing
  scripts/forecast-overrides.json · recurring guard · reference-SKU launch
  forecasts.
- **Phase D — NPD kanban** per §2.4 + mechanics above.
- **Phase E (last, unchanged):** Shopify/Klaviyo/Mailchimp import.

Hardening backlog from the audit (fold into nearest phase): atomic
launch+members / offer-SKU writes via RPCs · ON DELETE RESTRICT on
launch/offer SKU FKs · category CHECK on offers · ends≥starts CHECK ·
missing indexes · sale timestamp vs day-key semantics.

---

## 1. Purpose

A new top-level module that becomes the **single source of truth for the marketing team** and the connective tissue between marketing, operations, and forecasting. Four jobs:

1. **Unified marketing calendar** — every sale (dates, SKUs, the offer itself), product launch, and drop in one place.
2. **Plan ahead + guide operations** — map campaigns weeks-to-months out and translate them into inventory/purchasing timelines (the 60–75 day lead-time bridge).
3. **Feed forecasting** — sale data, launch data, and broadcast (email/SMS) data become first-class inputs so the forecast understands demand spikes instead of being surprised by them.
4. **Plan new product development** — manage NPD through the company's specific dev cycle (kanban).

### Scope decisions (locked in discussion)
- **In scope:** the *commercial* calendar (sales, launches, drops) + the *big broadcasts* (email + SMS).
- **Out of scope (for now):** general content/creative, paid-ads management.
- **Operations integration = alerts only.** The module *surfaces* order-by deadlines; it does **not** auto-create factory orders.
- **Planning horizon:** ~70 days to 6 months (variable). Note: 70 days ≈ the lead time, so some plans land *inside* the reorder window — the calendar must flag this.
- **Shopify import is the LAST phase.** Coupon codes have a decade of mixed use (affiliate / customer-service / employee / one-off), so they can't be trusted for learning until validated. Everything must work on **manually-entered / planner-curated** data first.

---

## 2. Data model

Naming convention: marketing tables are prefixed `mkt_`; the forecasting/learning layer `fc_`. All money is `numeric`, all timestamps `timestamptz`, all ids `uuid`.

### 2.1 Calendar spine — Sales as containers, Offers as children

The key structural insight from discovery: **a Sale is a container; the Offers are its children.** One sale (e.g. "Valentine's Day") can carry several offers (codes `LOVE`, `CUPID`, `HEART`), each a different mechanic. Offers are **composable** (not a rigid type enum) — "type" is just which components are set.

**`mkt_campaigns`** *(optional umbrella that groups a themed push)*
- `id` · `name` · `theme` · `starts_on` date · `ends_on` date · `goal` · `status` (planned/active/done/archived) · timestamps

**`mkt_sales`** *(the container)*
- `id` · `campaign_id` (nullable FK) · `name` · `starts_at` · `ends_at`
- *(no stored status — the running state **Upcoming / Live / Ended** is derived from `starts_at`/`ends_at` at display time so it can't drift; unconfirmed/canceled sales are deleted, not parked)*
- `notes` · `created_by` · timestamps

**`mkt_offers`** *(composable child offer)*
- `id` · `sale_id` FK
- `label` (human description, e.g. "LOVE — 20% off sitewide + free grinder")
- `code` (nullable; null = automatic / no-code sale)
- `scope` (sitewide / sku_set / category)
- `category` (nullable; a `product_skus.display_category` value — the existing "Category" / Product Line — set when scope = category)
- Components (any combination):
  - `percent_off` numeric (nullable)
  - `dollar_off` numeric (nullable)
  - `free_item_sku_id` FK → product_skus (nullable)
  - `min_order_amount` numeric (nullable; the "$Y threshold")
  - `buy_qty` / `get_qty` int (nullable; BOGO mechanics)
- `effective_discount_pct` numeric — normalized depth for the elasticity model (derived; see §4)
- timestamps

**`mkt_offer_skus`** *(which SKUs an offer covers when scope = sku_set)*
- `offer_id` FK · `sku_id` FK · optional per-SKU override (`percent_off` / `dollar_off`) · optional `planner_uplift_pct`

> **No new collections table.** "Collection" segmentation **reuses the existing `product_skus.display_category`** field — the "Category" / Product Line list (`DISPLAY_CATEGORIES` in `src/lib/constants.ts`). An offer with `scope = category` applies to every SKU whose `display_category` matches; arbitrary curated sets use `scope = sku_set` (explicit list via `mkt_offer_skus`). Deliberately decoupled from Shopify collections.

> Mapping check — every case from discovery fits: `$ off SKU` → {dollar_off, sku_set}; `% off sitewide` → {percent_off, sitewide}; `free item over $X` → {free_item_sku_id, min_order_amount}; `X% off over $Y` → {percent_off, min_order_amount}; `code = x% off + free item` → {code, percent_off, free_item_sku_id}; `Valentine's LOVE/CUPID/HEART` → one sale, three offers.

### 2.2 Broadcasts (email + SMS)

**`mkt_broadcasts`** *(one entity, channel field)*
- `id` · `channel` (email / sms) · `name` (subject/title)
- `scheduled_at` · `sent_at` (nullable)
- `audience_segment` · `audience_size` int
- `sale_id` (nullable FK) · `launch_id` (nullable FK) — what it's amplifying
- `metrics` jsonb (nullable; channel-specific — email (Klaviyo): recipients / opens / clicks / attributed revenue; SMS (Mailchimp): recipients / clicks / attributed revenue, no "opens"). Manually entered in v1; auto-pulled from the ESP later.
- timestamps

### 2.3 Launches & Drops

A launch is a **titled event with a list of member SKUs (1…N)** — a normal launch is a 1-member list; a **Studio Drop** typically has 3–4. Per-SKU quantities live on each member.

**`mkt_launches`** *(the event)*
- `id` · `name` (event title) · `kind` (launch / drop / **studio_drop** / restock)
- `pd_project_id` (nullable FK — genealogy link; Phase 2)
- `launch_date` date · `inventory_ready_by` date · `preorder` boolean · `notes`
- *(no stored status — derived: **Upcoming** (future date) → **Launched**, with a partial **"N of M sold out"** indicator and full **Sold out** when every member SKU has zero on-hand stock. Canceled launches are deleted.)*
- timestamps

**`mkt_launch_skus`** *(member products)*
- `id` · `launch_id` FK · `sku_id` (nullable FK) · `planned_name` (working name pre-SKU)
- per-SKU: `expected_first_30d_units` · `limited_qty` · `planner_confidence` (1–5) · `sort_order`
- each member identifies a product (sku_id OR planned_name)

> **Planned-SKU concept** is essential: launches and PD projects refer to products that don't exist in `product_skus` yet. They carry a `planned_name` + nullable `sku_id`, and a "promote to real SKU" action links them once the SKU is created (happens at the PD "Ordered" stage — see §2.4).

### 2.4 Product Development (the kanban)

**`mkt_pd_projects`**
- `id` · `name` (working name) · `description`
- `stage` (purgatory / good_ideas / ready_to_begin / china_working / prototype_sent / ready_for_confirmation / ordered / halted)
- `owner_id` FK → profiles · `intended_category`
- `target_launch_date` date (nullable)
- `linked_sku_id` (nullable; set at "ordered") · `linked_factory_order_id` (nullable) · `linked_launch_id` (nullable)
- timestamps

Stage semantics (from discovery):
- **Purgatory** = low-conviction icebox (logged, never worked on). **Good Ideas** = vetted, worth pursuing.
- **Halted** = killed *after* work was done (keeps its history) → collapsed archive lane.
- **Ordered** = success exit and the **handoff seam** (see below).

**`mkt_pd_stage_events`** *(background transition log — always on, no UI/targets yet)*
- `id` · `project_id` FK · `from_stage` · `to_stage` · `moved_by` · `moved_at`
- Purpose: free cycle-time history (e.g. "China Working averages N days") for *future* stalled-card alerts and realistic launch-date prediction. Pure optionality, zero burden now.

#### The "Ordered" handoff
When a PD card reaches **Ordered**:
1. its `planned_name` is **promoted to a real `product_skus` row** (`linked_sku_id` set),
2. a **factory order** is created/linked (`linked_factory_order_id`),
3. a **Launch** is scheduled forward: order date + 60–75d lead → arrival (= `inventory_ready_by`) → `launch_date`.

This gives every product a full **genealogy**: idea → stages → order → freight → launch → first sales. That genealogy is exactly the training data the launch-estimate learner uses (§4).

### 2.5 Forecasting / learning layer

**`fc_predictions`** — the **prediction ledger** (freeze every estimate at the moment it's made; this is what makes the system *learn*).
- `id` · `kind` (launch_estimate / promo_uplift / baseline_forecast / …)
- `subject_type` · `subject_id` (sku / launch / offer)
- `horizon_start` · `horizon_end`
- `predicted_value` · `predicted_low` · `predicted_high` (interval)
- `model_version`
- `inputs` jsonb (features used incl. **context**: season, email support, audience size, concurrent promos)
- `planner_input` jsonb (nullable; their estimate + confidence)
- `created_at` (frozen) · `actual_value` (filled later) · `scored_at` · `error` jsonb

**`fc_demand_events`** — the **decoupling overlay** the forecaster reads (generated from `mkt_*` by a projection job, so marketing schema can change without touching the forecast engine).
- `id` · `sku_id` · `date_start` · `date_end` · `type` (promo / launch / drop / broadcast) · `source_table` · `source_id` · `multiplier` (nullable) · `units` (nullable) · `confidence`

**Promo-labeled sales history** — extend the existing `sales_daily` work with a labeling view that tags each (sku, date) with any active offer, so the model can separate **baseline** from **promo-driven** demand. (Built from manually-curated sales first; Shopify-derived labels added in the final phase.)

---

## 3. Relationships to the existing system

- `mkt_offer_skus`, `mkt_launches`, `mkt_pd_projects` → **`product_skus`** (with the planned-SKU nullable pattern).
- `mkt_pd_projects` "Ordered" → **`factory_orders`** + promotes a `product_skus` row.
- `mkt_launches.inventory_ready_by` ← derived from factory order + the 60–75d lead time → drives **operations alerts**.
- Forecast layer reads **`sales_daily`** (demand history, 2022+), **`sku_forecasts`** (existing engine), and the cross-effect structure from **`product_boms`** (complements) + product families (substitutes).
- Stockout/oversell signal from **`shipstation_oversell_warning`** feeds de-censoring (§4).
- **Shared with Analytics (planned):** the `fc_*` learning layer, the promo-labeled sales history, and the order-by / Reorder-Radar surface are built as shared infrastructure the future Analytics module will also consume — so it slots in later without rework (see §8).

---

## 4. Forecasting adaptation

### 4.1 The learning flywheel
**predict → record (`fc_predictions`) → observe actual → score error → update priors.** Every launch and every promo becomes a labeled training example. This loop *is* the continuous learning; everything below flows through it.

### 4.2 Decomposed, promo-aware forecast
> **Forecast(sku, date) = Baseline(sku) × Season(category, week) × Holiday(date) × Promo(active offer) × Email(active broadcast) × Cross(related-on-sale)**

Each factor is learned separately (data-efficient) and the forecast becomes *readable/attributable* ("800 units = 300 baseline × 1.8 December × 1.5 sale × 1.2 email"). Factors assumed multiplicatively independent initially; season×promo interaction deferred until data supports it.

### 4.3 The hard parts (and the techniques)
- **Seasonality vs promo double-count.** Promos cluster in Q4 = peak season. Estimate seasonality from **de-promoted baseline** (strip promo/email days first), iteratively. Never let one factor absorb another's credit.
- **Growth vs seasonality.** The business grew fast, so raw year-over-year is distorted. **Detrend** for growth before computing seasonal indices.
- **Stockout censoring (dangerous feedback loop).** Sold-out days understate true demand → model under-orders → sells out again. Use `shipstation_oversell_warning` + stockout periods to **de-censor** (treat stocked-out demand as unknown/estimated, not zero).
- **Holiday/event spikes.** Beyond smooth seasonality, model discrete event days (4/20, BFCM, Christmas, Father's Day, Valentine's, etc.). The event calendar is **not seeded** — the team marks event days in-app as plans are made, and the model learns each day's effect from those marks + historical sales spikes.
- **Per-category seasonal shapes** with pooling toward a global curve when a category is thin.

### 4.4 Launch cold-start
- **Analogs, not big-model regression** (few launches): find k most similar prior launches (category, price band, fillable/non-fillable, flagship vs accessory, season) and blend their normalized first-30-day curves. Explainable ("like BW40SP and NB6").
- **Confidence-weighted blend with planner** via inverse-variance: planner estimate's spread set by their stated confidence, model's spread by its historical accuracy. Planner dominates early; model earns weight as it proves out.
- **Track planner calibration** — learn + correct each planner's systematic bias over time.
- Learn the **launch curve shape** (ramp/decay), not just the 30-day total — it drives inventory timing.

### 4.5 Promo response + cannibalization
- Normalize all mechanics to an **effective discount %** (a $-off and a free item map onto one axis), then learn an **elasticity curve**, with a per-type adjustment (free gift ≠ same-% off psychologically).
- **Per-SKU sensitivity with shrinkage** toward the category mean when a SKU has few promo observations (partial pooling — the key small-data move).
- **Net of pull-forward** — a sale borrows from future demand; learn lift-during *minus* dip-after, or ordering over-counts.
- **Cross-SKU only within structured groups**: substitutes (product families, e.g. BW20 / BW20DNA / BW20P) and complements (BoM pairs). No full N×N matrix. Early estimates shown as **directional, low-confidence flags** (with n).

### 4.6 Data scale (corrected)
The ERP is ~1 year old, but **sales + promo history is deep** (Shopify since 2014, **using 2022+ per the floor** ≈ 4.5 years). So seasonality, holiday effects, and promo elasticity are learnable from real data — the genuine cold-start problem is limited to *brand-new launches* and cleanly mapping promos to SKUs.

---

## 5. UX / UI

1. **Marketing Calendar** (month + quarter) — the home; color-coded by type (sale / launch / drop / PD milestone / broadcast).
2. **Timeline / Gantt** (planning, up to 6 months) — campaign bars, PD target dates, and **lead-time / order-by bars**; flags any plan that lands *inside* the 60–75d reorder window.
3. **PD Kanban** — 8 columns (Purgatory … Ordered), Halted as a collapsed archive lane; drag to advance (logs a stage event).
4. **Sale detail** — its offers, covered SKUs, expected lift, linked broadcasts, and performance once live.
5. **Launch detail** — SKU/planned name, dates, ready-by, expected first-30d units + confidence, PD genealogy.
6. **Broadcast detail** — channel, audience, linked sale/launch, metrics.
7. **Operations bridge** — order-by alerts on the dashboard + a "marketing-driven demand" view; the inside-the-window warning.
8. **Forecast surfaces** — show the decomposition on SKU forecasts so planners can argue with each factor.

---

## 6. Permissions
- **No dedicated `marketing` role.** Marketing stakeholders are already **admin-level**, so they get full read/write access to the module out of the box.
- Gate module **writes** to admin/manager; expose **read-only** to other roles where appropriate. (Roles today: admin / manager / user / supplier.)

---

## 7. Phasing

| Phase | Scope | Notes |
|---|---|---|
| **0** | Schema + calendar read-model | `mkt_*` tables, RLS, the unified calendar view |
| **1** | Sales + Offers + Launches + Broadcasts CRUD + Calendar/Timeline | **manual entry** — the source of truth, useful alone |
| **2** | PD Kanban + genealogy + Ordered→Factory-Orders handoff | planned-SKU promotion |
| **3** | Prediction ledger + demand-events overlay + decomposed forecast (season/holiday/promo/email) + launch analogs + ops order-by alerts | uses **manually-curated** promo data; de-censoring; planner calibration |
| **4 (LAST)** | Shopify historical import + **classify** campaigns vs operational codes, validated before feeding the model | deferred deliberately — codes are noisy/ambiguous |

---

## 8. Decisions (resolved 2026-06-18)
- ✅ **Role:** no dedicated `marketing` role — stakeholders are already **admin-level**; gate writes to admin/manager.
- ✅ **Collection scope:** reuse the existing **`display_category`** ("Category" / Product Line) — **no new table**; deliberately **not** Shopify. Arbitrary curated sets use an explicit SKU list (`sku_set`).
- ✅ **Planner confidence:** integer **1–5**.
- ✅ **Holiday/event calendar:** **not seeded** — the team fills it in as plans are made; the model learns from those marks + historical spikes.
- ✅ **Analytics sequencing:** build Marketing now **with forward-compatibility** for the parked Analytics module — the `fc_*` layer (prediction ledger, demand-events overlay), the promo-labeled sales history, and the order-by / Reorder-Radar surface are designed as **shared infrastructure both modules consume**, so Analytics slots in later without rework.
- ✅ **ESP for broadcast metrics:** **Email = Klaviyo, SMS = Mailchimp.** Auto-pull is **deferred** (alongside Shopify); v1 enters `mkt_broadcasts.metrics` manually. Both expose APIs, so the eventual integration is a clean drop-in — Klaviyo (email: recipients / opens / clicks / placed-order revenue), Mailchimp (SMS: recipients / clicks / revenue; no "opens").

*All open decisions are now resolved — the plan is ready to build from when you are.*

---

## 9. Risks & guardrails
- **Stockout censoring** feedback loop → de-censor with oversell data.
- **Season vs promo** double-counting → de-promote before seasonal estimation.
- **Growth vs seasonality** → detrend first.
- **Small-n overfitting** (per-SKU promo, cross-effects) → shrinkage / partial pooling, show confidence + n.
- **Shopify code ambiguity** → deferred to Phase 4 and validated (classify, human-confirm) before trusting.
- **Confounders** (email/ad push, concurrent promos, season) → record as context features in `fc_predictions.inputs` so lift is attributed, not misattributed.
