# ERP UI shell and patterns (for the Warehouse module)

Read-only survey, 2026-10-19. Paths relative to `C:\Dev\Freeze-Pipe-ERP`; `src/` implied unless stated. The data model is covered in `docs/research/research_notes/Warehouse map and pick pack module/erp_current_state.md` and is not repeated. Correction to the brief: `src/components/freight/ReceivingPanel.tsx` no longer exists; its rows were folded into `components/freight/ShipmentManifest.tsx` (comment at L27-30; `pages/freight/FreightDetail.tsx` L65).

## 1. App shell

- **Layout** (`components/layout/Layout.tsx` L8-38): `flex h-screen overflow-hidden`; desktop `Sidebar` in `hidden md:flex`; below `md` the same Sidebar renders inside a left `Sheet` (`w-60 p-0`, L20-24, closes on nav click). `<main>` is `flex-1 overflow-auto p-4 md:p-6` wrapping `<Outlet/>` in an `ErrorBoundary` keyed by pathname (L31). Uses `h-screen`, not `dvh`.
- **Header** (`Header.tsx` L36-76): 56 px bar. Mobile-only hamburger on the left; on the right a role badge (outline; `roleColors` only covers admin/manager/user, no supplier) and an avatar dropdown (Settings, Sign out). No page title and no breadcrumbs anywhere: pages render their own `<h1>`, and detail pages use a ghost `ArrowLeft` icon button as "back".
- **Sidebar** (`Sidebar.tsx`): static `navGroups` array (L47-103) of `{label?, items:[{to,label,icon,roles,badge?}]}`, filtered by `role` (L151-156). Labelled groups are collapsible folders (state persisted in `localStorage` key `sidebar.collapsedGroups`, L105-140; a group containing the active route force-opens). 240 px wide, 64 px icon-only when collapsed. Active style `bg-sidebar-accent text-primary` (L213). The `end` prop is hard-coded for `/manufacturing /freight /inventory /economics /supplier /marketing` (L209), so any new module root path must be added there or its root link stays highlighted on child pages. `PdReviewBadge` shows how a live count renders at the right of a label (L86).
- **Nav today** (icon in brackets): Dashboard [LayoutDashboard] (admin, manager). **Manufacturing**: Overview [Factory], Workspace [ScanLine], Performance [BarChart3] (admin, manager, user). **Inventory**: Stock Levels [Package], Shipments [Ship, route `/freight`], Factory Orders [Truck], Materials [Beaker] (admin, manager). **Economics**: SKU Costs [DollarSign], Suppliers [Building2] (admin). **Marketing**: Calendar [Calendar], Sales [Tag], Launches [Rocket], Broadcasts [Megaphone], Product Development [Beaker] (admin, manager). Settings [Settings] (admin). **Supplier Portal**: Overview [Home], Factory Orders [ClipboardList], Shipments [PackageOpen] (supplier only).
- **Theme**: `<html class="dark">` in `index.html` L2; no theme toggle. Viewport meta is plain `width=device-width, initial-scale=1.0` (L6). The environment banner (`App.tsx` L88-100) sits above the shell outside the `h-screen` flex, so on staging/demo the page is one banner line taller than the viewport.

### Routes (`App.tsx` L101-308)

Public: `/login`, `/register`. Everything below sits under `RequireAuth` + `Layout`, and each element is wrapped in `<RequireRole allowed=[...]>` (spinner until `roleResolved`; unauthorised users are redirected to their role landing page, `RequireRole.tsx`). `*` runs `DefaultRedirect` (L67-81): `user` goes to `/manufacturing/workspace`, `supplier` to `/supplier`, else `/dashboard`.

| Module | Routes | Roles |
|---|---|---|
| Dashboard | `/dashboard` | admin, manager |
| Manufacturing | `/manufacturing`, `/manufacturing/workspace`, `/manufacturing/performance` | admin, manager, user |
| Freight | `/freight`, `/freight/new`, `/freight/:id` | admin, manager |
| Inventory | `/inventory/materials`, `/inventory/materials/:materialId`, `/inventory`, `/inventory/factory-orders`, `/inventory/factory-orders/:id`, `/inventory/quality-issues` (no sidebar link) | admin, manager |
| Economics | `/economics`, `/economics/suppliers`, `/economics/suppliers/:id`, `/economics/:skuId` | admin |
| Marketing | `/marketing`, `/marketing/sales`, `/marketing/sales/:id`, `/marketing/launches`, `/marketing/broadcasts`, `/marketing/product-development` | admin, manager |
| Settings | `/settings` (tabs: Profile, Change Log, User Management, Reporting API) | admin |
| Supplier portal | `/supplier`, `/supplier/orders`, `/supplier/orders/new`, `/supplier/orders/:id`, `/supplier/shipments`, `/supplier/shipments/new`, `/supplier/shipments/:id`, `/supplier/breakage`, `/supplier/variances` | supplier, admin |

`UserRole` is `"admin"|"manager"|"user"|"supplier"` (`lib/auth-context.tsx` L12), backed by DB `profiles_role_check` (baseline migration L3286), so a new "warehouse" role needs a migration, not just UI.

## 2. Page archetypes

Common grammar: root `div.space-y-6` (some `max-w-5xl` / `max-w-lg`), `<h1 className="text-2xl font-bold">` plus a `<p className="text-muted-foreground">` subtitle, actions right-aligned in a `flex justify-between` row. There is **no PageHeader component**; the block is copy-pasted (`Dashboard.tsx` L53-56, `FreightDashboard.tsx` L267-290, `Settings.tsx` L31-34).

- **KPI + card list** (`pages/freight/FreightDashboard.tsx`): header with outline "Refresh tracking" and primary "New Shipment" buttons; `StatCard` grid `sm:grid-cols-2 lg:grid-cols-4` (L293-); `Tabs` used purely as a filter strip (All/Sea/Air/High Risk, L333-340); `ShipmentCard` list (whole card clicks through to detail, interactive children stop propagation) with centered section dividers (`h-px` rules plus a `text-[10px] uppercase tracking-wider` label, L357-380); empty state is a Card with one muted centered line (L343-347); a ghost "show more" button reveals older rows in batches.
- **Dense spreadsheet** (`pages/inventory/InventoryDashboard.tsx`, also `economics/SKUList.tsx`): full-height flex column (L864); collapsible KPI band that animates via `grid-rows-[0fr/1fr]` as the grid scrolls (L910-925); one Card whose header is a single filter row (search `Input` with `Search` icon, two `Select`s, Clear ghost button, "Show archived" checkbox, "n of m" count, L938-1005); body is one scroll region with a raw `<table min-w-[900px]>`, sticky `thead`, sticky first column (L1027-1035). Edit mode and "Build order" mode swap the header action buttons in place (L870-912). Filters live in the URL through `lib/use-url-filter.ts` (`useUrlFilter`, `useUrlBoolFilter`; replace-history, defaults not serialised).
- **List table** (`pages/marketing/SalesList.tsx`, `Launches.tsx`): Card around a raw `<table>`, rows `cursor-pointer border-t hover:bg-muted/20` that navigate to detail, `stopPropagation` on cells holding controls, phase chips and `ConfirmCell`; upcoming first, then past under a quiet divider.
- **Detail** (`freight/FreightDetail.tsx`, `economics/SKUDetail.tsx`, `marketing/SalesDetail.tsx`): top row = ghost `ArrowLeft` icon button + `h1` + status badges; metric Cards `grid-cols-2 lg:grid-cols-4` with `p-4`, label `text-xs`, value `text-2xl font-bold tabular-nums` (FreightDetail L517-590); a horizontal `ShipmentStepper`; banner + manifest Card; cost strip; irreversible actions behind a Dialog (close short button at L627). Inline-edit idiom: pencil appears on hover, becomes an `Input` with check/x buttons (Enter saves, Esc cancels), error text inline (FreightDetail L84-95, SKUDetail L744-790). Detail loading is a bare `<div className="p-8 text-muted-foreground">Loading…</div>` (SKUDetail L740).
- **Settings** (`settings/Settings.tsx`): shadcn `Tabs`, `TabsContent mt-4`; profile Card `max-w-lg`; `UserManagement` is a raw table with a role `Select` per row and Dialogs for link/promote.
- **Supplier portal** (`pages/supplier/*`): same primitives, narrower (`max-w-5xl`), `grid-cols-1 sm:grid-cols-2 lg:grid-cols-3` of linked Cards with outline `Badge text-[10px]` chips (SupplierDashboard L76-117), an overdue list, Dialog drill-downs. No separate layout shell: the supplier sees the same sidebar filtered to its group.
- **Kanban + sheet** (`marketing/ProductDevelopment.tsx`, `components/marketing/pd/*`): the only use of `Sheet` besides the mobile nav (`PdCardSheet.tsx` L117, `side="right" w-full overflow-y-auto sm:max-w-3xl`).

### Workspace (floor-staff landing page) in detail

`pages/manufacturing/Workspace.tsx` (288 lines). Root `mx-auto max-w-lg space-y-4 md:space-y-6` (L108): h1 "Workspace" + subtitle; `MyOutputStrip` (a `Link` card to Performance showing today / this week units; it uses the lean `useMyRecentTaskLogs` query because "this strip renders on crew phones", `MyOutputStrip.tsx` L17-21); four stacked Cards; full-screen success overlay.
1. **Select SKU** (L131-166): autofocused `Input h-12 text-base` ("Search or scan SKU...") that doubles as the filter; below it a 2-column grid of up to 8 `min-h-[56px]` tiles (SKU bold, name line-clamped). Selected tile: `border-primary bg-primary/10 ring-1`. There is no Enter-to-select, so a wedge scanner types text but does not choose a SKU. Fillable SKUs only, except breakage (any active SKU).
2. **Task type** (L169-202): `TASK_TYPES` (`lib/constants.ts` L1-32) as a `grid-cols-3 md:grid-cols-5` of `min-h-[64px]` toggle tiles coloured per type (blue emptying, orange filling and capping, green RTS, purple pre-filled RTS, red breakage via `text-X-400` + `bg-X-400/10`).
3. **Quantity** (L207-247): 56 px round minus/plus buttons flanking a `text-4xl tabular-nums` number; auto-fills `standard_quantity_per_carton`; a `CardDescription` caption under the title.
4. **Notes + submit** (L250-285): `h-12` notes input, inline red error box (`border-red-500/40 bg-red-500/10 text-red-300`), full-width `h-14 text-lg` "Log Task" button disabled until SKU, type and quantity are set, then a summary line.

Interaction model: all state is local `useState`; validation by `taskCompletionSchema` + `safeValidate`; submit calls `useLogTask` (RPC `rpc_log_task_completion`); success shows a 1.5 s full-screen green check overlay (`fixed inset-0 bg-background/80`, L119-128), then resets. Targets use `touch-manipulation` and `active:scale-[0.97]` (L154, L190, L226). RPC envelope errors surface verbatim in the red box, not a toast.

### Tables, tabs, dialogs, states, badges

- **Tables**: always raw `<table>` with Tailwind (`text-xs uppercase tracking-wider text-muted-foreground` heads, `border-b border-border/50` rows). No shadcn `Table`; `@tanstack/react-table` is not installed. Sorting is `components/shared/table-sort.tsx` (`useTableSort`, `applySort`, `SortableTh`; cycle asc, desc, default; nulls last). Sale dashboards add `Th/Tile/ModuleCard/Chip/Pin` atoms in `components/marketing/sale/sale-ui.tsx`.
- **Tabs**: filter strips (FreightDashboard), settings sections, and week/month toggles inside charts (`FreightCostChart.tsx`). `Performance.tsx` L97-118 builds a segmented control from two bordered `Button`s (Team / Just me).
- **Dialogs**: `Dialog` for forms and reports (`max-w-lg` default; `max-w-5xl max-h-[90vh] overflow-y-auto` for big ones), `AlertDialog` for destructive confirms, `Popover` for inventory breakdowns. `DialogContent` is a centered modal with `p-6`; there is no mobile bottom-sheet variant.
- **Loading**: no `Skeleton` in `ui/`; one exists in `marketing/sale/sale-ui.tsx` (used by sale tiles). `animate-pulse` appears on in-flight stepper buttons (ShipmentManifest L529, L552) and PD photo placeholders. Route guard spinner = `h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent` (App.tsx L56-58, duplicated in RequireRole). Most pages default `data = []` and render empty while loading.
- **Empty states**: one muted centered line in a Card or `<td colSpan>`, e.g. "No shipments match the current filter."; no icon or CTA pattern.
- **Toasts**: Radix toast, `variant: default|destructive` only (no success variant), `TOAST_LIMIT = 1` (`hooks/use-toast.ts` L11), viewport top on mobile, bottom-right from `sm` (`ui/toast.tsx` L14-35). Pattern: `toast({title, description})` on success; `toast({..., variant:"destructive", description: describeError(err)})` on failure.
- **Badges/chips**: shadcn `Badge` (`outline` + custom classes). Three coexisting recipes: (a) `bg-X-500/10 text-X-400 border-X-500/30` maps in `lib/status-colors.ts` (factory order, freight, breakage, variance); (b) `{label,color,bgColor}` objects in `lib/constants.ts` rendered by `shared/StatusBadge.tsx`; (c) tiny bordered tags `rounded border border-cyan-500/50 px-1 text-[9px] uppercase` (pre-filled, sample). Colour semantics: green = done/good/finished, amber = needs action/warning, red = failure/risk/breakage, blue = ordered/upcoming, indigo = on the water, cyan = pre-filled, violet = launch/early-access/pre-launch, slate = pending/terminal-neutral. Stock pipeline bars: raw blue, pre-filled cyan, WIP orange, finished green (`ManufacturingDashboard.tsx` L205-260); `ModeTile.tsx` gives warehouse green, sea blue, air cyan, factory orange.
- **Formatting**: no central formatter. Mostly inline `n.toLocaleString()` with `tabular-nums` and `date-fns` `format(..., "MMM d, yyyy")`. Domain helpers: `lib/marketing/sale-format.ts` (`F`), `lib/marketing/format-day.ts`, `lib/performance/date-ranges.ts` (`formatEtYmd`), a local `fmtUsd` in FreightDetail L56-58. Stored calendar days are parsed as local dates to avoid UTC shifts (`SalesList.tsx` L13-17).

## 3. Receiving UI (what putaway will extend)

`ShipmentManifest.tsx` (723 lines), mounted by FreightDetail; props `shipment, lineItems, groups, receivingActive, foItemIdToOrder`. The active rule lives in `lib/freight/receiving.ts` (`isReceivingActive`: not confirmed, not pending, and landed status OR ETA reached OR carrier pieces delivered OR any received qty), computed once so the chip, banner, column and close-short button agree.
- **Dock banner** (L326-440), three states via `bannerState`: *action* (amber card; giant `text-4xl` count of cartons awaiting check-in, a carrier-detail caption, right-aligned green outline "Check in all N cartons"); *calm* (green card with `PackageCheck`); *neutral* (big `received / total` numerals, amber until done then green). A closed-short note is an amber bordered card with `AlertTriangle`.
- **Manifest table** (L443-): columns Item / Qty / Pack / Ctns / From order / [Received]. Carton-group rows: single-SKU shows SKU + name (+ cyan "pre-filled" tag); multi-SKU shows "Mixed carton" with a "SKU x12 + SKU x6" subline. Received cell: thin amber `Progress` (`h-1.5 w-16`), `n/total` text, then 28 px icon buttons Minus (correction; disabled at 0), Plus (green outline, +1) and a small "all N" button for the remainder. Completed rows go green with `CheckCircle2` and "n/N · X credited" plus a ghost minus. Legacy unit-mode rows use a numeric `Input` ("± units", Enter submits) plus "Record"; negatives correct. Sample lines are muted at 60 % opacity and never credited. A totals footer row closes the table; a footnote at L716 explains negative corrections.
- **Mutation flow**: `tapCarton` sets `pendingKey` (`"<groupId>:+1"`) so only the tapped control pulses while every write control disables (`anyPending`); calls `useRecordFreightReceipt` (RPC `rpc_record_freight_receipt`, `entries` array); toasts only on completion ("All cartons checked in") or on error. It is delta-based, not scan-based: no per-scan confirmation, undo stack or bin capture.
- **CloseShortDialog.tsx** (213 lines): `max-w-lg` Dialog, red `AlertTriangle` title, small bordered shortfall table (`SKU / Received n of N / Short`), required reason `Select`, conditional required `Textarea` for "Other", destructive footer button whose label states the consequence ("Close short — N units back to on order"). Resets state on open via `useEffect`.
- **For putaway**: this is a desktop table with 28 px targets and `title=` tooltips. A putaway extension should lift the carton row into a phone-sized card (>= 56 px targets, as Workspace does), keep the three-state banner idea, and keep the "pendingKey + disable all" mutation guard.

## 4. Design tokens, charts, icons

- **Tokens**: shadcn "new-york", base zinc, CSS variables (`components.json`). `tailwind.config.js` L7-58 maps `border, input, ring, background, foreground, primary, secondary, destructive, muted, accent, popover, card, sidebar.*, chart.1-5`. Radius `--radius: 0.5rem` (lg = 0.5rem, md = -2px, sm = -4px). `index.css` L5-76 has `:root` (light) and `.dark`. Dark: background `0 0% 7%`, card `10%`, border `18%`, muted-foreground `60%`; destructive is a dark maroon `0 62.8% 30.6%` (low contrast for a large red CTA). Primary is sky blue `205 94% 56%` in both themes. `--chart-1..5` = blue, green, orange, purple, pink. The light theme exists but is never selected.
- **Fonts**: none declared; Tailwind default system stack. Numerals use `tabular-nums` throughout.
- **Charts**: recharts 2.15 in 7 files (`components/dashboard/*`, `freight/FreightCostChart.tsx`, `inventory/InventoryProjectionChart.tsx`, `manufacturing/TeamPerformanceChart.tsx`, `marketing/LaunchSupplyChart.tsx`, `pages/economics/SupplierDetail.tsx`). Always `ResponsiveContainer` + `CartesianGrid`, mostly hard-coded hex (`#9a9a9a` axes, `#3d3d3d` grid, `#3b82f6`, `#22c55e`, `#fbbf24`); only `TransitReportModal.tsx` uses `hsl(var(--chart-1))`. Sale dashboards use hand-built SVG/CSS bars instead.
- **Icons**: `lucide-react` 0.475 only; `h-4 w-4` inline, `h-5 w-5` in the StatCard tile, coloured `text-*-400`. Warehouse-relevant icons already used: `Warehouse` (ModeTile), `ScanLine` (Workspace nav), `Package`, `PackageCheck`, `PackageOpen`.
- **Utilities**: `lib/utils.ts` has only `cn` and `humanizeEnum`. `lib/constants.ts` holds task types, freight statuses and display-category ordering. `lib/supabase-error.ts` has `describeError`. No shared number/date formatter.

## 5. shadcn components present / missing

Present in `components/ui/` (22 files): alert-dialog, avatar, badge, button (variants default/destructive/outline/secondary/ghost/link; sizes default h-9, sm h-8, lg h-10, icon h-9), card, checkbox, dialog, dropdown-menu, input (`text-base md:text-sm`, so iOS does not zoom), label, popover, progress, scroll-area, select, separator, sheet, switch, tabs, textarea, toast, toaster, tooltip. `@radix-ui/react-collapsible` is installed but has no wrapper file.

Missing: command/combobox (`cmdk` not installed), data-table (no TanStack Table), drawer (`vaul` not installed; `Sheet side="bottom"` exists as a fallback), skeleton, table, calendar/date-picker (`react-day-picker` absent), toggle / toggle-group / radio-group, accordion (keyframes exist in tailwind config, no component), resizable panels, breadcrumb, pagination, alert/banner, sonner, slider (a raw `<input type="range">` is used), hover-card. `react-hook-form` and `@hookform/resolvers` are in `package.json` but are **imported nowhere** (CLAUDE.md's stack list is stale).

## 6. Shared components and KPI building

`components/shared/`: `StatCard` (title, value, subtitle, lucide icon in a `bg-muted` tile, optional `trend`, `disabled`, and `onClick` drill-through with keyboard support), `StatusBadge`, `ModeTile`, `PreLaunchBadge`, `RequireRole`, `ErrorBoundary`, `table-sort`. The densest design vocabulary is in `marketing/sale/sale-ui.tsx` (`Tile`, `ModuleCard`, `Chip` with tones `g/r/k/a/b/v` and shape marks, `DataTip`) at 10.5-17 px type. KPI cards everywhere are `StatCard` in `gap-4 sm:grid-cols-2 lg:grid-cols-4` (Dashboard L58-98, InventoryDashboard L922-, FreightDashboard L293) or `gap-3 grid-cols-2 lg:grid-cols-4` (Performance). No PageHeader, Section, EmptyState or FormField abstraction exists.

## 7. Forms

Despite the dependency list, forms are plain controlled `useState` with manual validation. Zod schemas live in `lib/schemas/index.ts` with `safeValidate(schema, input)` returning `{ok,value}` or `{ok:false,errors}` (L166-173), used only by Workspace and `FreightNew.tsx` (L490). Dialog create flows: `NewFactoryOrderDialog.tsx` (L89-683; many `useState`s, a line-item array, budget allocator, a `submitError` string, `DialogFooter` Cancel/Create), `LaunchFormDialog`, `SaleFormDialog`, `OfferFormDialog` (uses `inputMode="decimal|numeric"`). No true multi-step wizard exists: `FreightNew.tsx` (1,418 lines) is one long sectioned page and `supplier/NewShipment.tsx` is a single page with a carton plan. Field errors are `text-[11px] text-red-400`; form-level errors are the red box from Workspace.

## 8. Data layer conventions

- Hooks live in `lib/hooks/use-*.ts`, re-exported from `lib/hooks/index.ts`. Naming: queries `useX` / `useXBySku` / `useMyRecentTaskLogs`; mutations `useLogTask`, `useRecordFreightReceipt`, `useCloseFreightShort`, `useCycleCount`, `useBulkCycleCount`.
- **Query keys**: short kebab-case roots with optional trailing ids: `["inventory"]`, `["inventory", skuId]`, `["freight", id]`, `["freight-line-items"]`, `["freight-carton-groups", shipmentId]`, `["task-logs-mine", employeeId, days]`, `["mkt-sale", id]`. Invalidation is by root so detail keys fall out.
- **Mutation pattern**: `useMutation`, RPC call, throw on transport `error`, unwrap the envelope, `onSuccess` invalidates affected roots (`use-freight.ts` L246-276 invalidates freight, freight-line-items, inventory, carton groups, pd-board). Page code does `mutateAsync` in try/catch, toasts, and clears a local `pendingKey` in `finally`.
- **Envelope handling**, two variants: `use-supplier-portal.ts` L10-30 `unwrap<T>(data, fallback)` throws `new Error(env.error ?? fallback)` (19 call sites), and freight/task hooks inline `if (!result.ok) throw new Error(result.message ?? result.error ?? "...")`; `useLogTask` appends `available/requested` extras (use-task-logs.ts L96-111). The UI shows the raw string, so RPC error text must be human-readable.
- **Global error surfacing** (`lib/query-client.ts`): any failed query toasts "Couldn't load data" (throttled 3 s global / 60 s per key); mutations without their own `onError` toast "Action failed"; all go to Sentry. Defaults: `staleTime` 2 min, `retry` 1.
- **No optimistic updates, no Supabase realtime, no polling** (only `use-sale-metrics.ts` L21 uses `refetchInterval`). Optimistic *concurrency* is separate (`row_version` via `lib/concurrency.ts` `supabaseUpdateWithVersion`). A hand-rolled paging loop handles the 1000-row PostgREST cap (`useTaskLogs`). In demo mode the supabase client is a throwing Proxy (`lib/supabase.ts`), so hooks do not serve mock data any more.

## 9. Mobile today

- Deliberate mobile work: Workspace (single column, 48-64 px targets, `touch-manipulation`), `MyOutputStrip` (lean query), the `Input` font-size rule, the sidebar Sheet, `grid-cols-3` task tiles with `[text-wrap:balance]`. Breakpoint counts across `pages/` and `components/`: `sm:` 75, `md:` 17, `lg:` 18, `xl:` 2, mostly column changes and `hidden sm:inline` text.
- Workspace is usable on a phone. Everything else is desktop-first: tables with `min-w-[860-900px]` scroll sideways, controls are 28-36 px, Dialogs are centered modals.
- Gaps for a picking app: no PWA manifest or service worker (`public/` holds only `favicon.png`, `icons.svg`), no safe-area insets, `h-screen` rather than `100dvh`, no haptics/audio/camera code, and **`vercel.json` L13-16 sets `Permissions-Policy: camera=(), microphone=(), geolocation=()`**, which blocks `getUserMedia` (camera barcode scanning) until relaxed to `camera=(self)`. "Scan" today means a hardware wedge scanner typing into the Workspace input.

## 10. UI testing

Vitest 4 + jsdom + `@testing-library/jest-dom` (setup `src/test/setup.ts`), `globals: true`, alias `@`. `@testing-library/react` and `user-event` are installed but **no `.test.tsx` exists**; all 34 test files are `.ts`. Convention: push logic into pure modules beside the component (`lib/freight/receiving.ts`, `components/freight/shipment-stages.ts`, `components/marketing/launch-format.ts`) and unit test those; hook tests mock the supabase seam and assert RPC name/args and that `{ok:false}` throws (`lib/hooks/hooks.test.ts` L1-60). E2E/Playwright is deferred (CLAUDE.md).

## 11. Owner design rule: "self-evident, no explanatory captions"

Not written down in `CLAUDE.md` or `docs/*.md` (searched for self-evident, caption, explanatory, intuitive, owner preference). The only repo trace is the prior research report (`docs/research/reports/Warehouse map and pick pack module.md` L225: "consistent with the owner's no-captions preference"). The code only partly honours it: every page has an `h1` + muted subtitle, StatCard subtitles can run long ("click for report"), Workspace has `CardDescription` hints (L211-218), `Dashboard.tsx` L134 carries a sentence-length chart caption, and ShipmentManifest has a footnote (L716). Where the rule is visible: Workspace tiles and the big-numeral stepper need no help text, the dock banner states one fact in numerals, and buttons name their consequence ("Close short — N units back to on order"). Owner decisions are recorded in code comments ("owner decision 2026-08-27", `ConfirmCell.tsx` L2) rather than UI copy; `title=` tooltips are the accepted escape hatch. Treat the rule as: state, numerals, colour and button labels carry the meaning.

---

## Fit recommendations (options, not decisions)

**Sidebar placement.**
- Option A: a new labelled "Warehouse" group between Inventory and Economics with Pick [ClipboardCheck or ListChecks], Pack [PackageCheck], Putaway [ArrowDownToLine or PackageOpen], Map [Map or LayoutGrid], Locations [MapPin]; Pick/Pack/Putaway/Map open to admin, manager and `user`, Locations to admin and manager.
- Option B: keep the group to Pick, Pack, Putaway, Map and put bin administration in a Settings tab.
- Option C: move "Shipments" (inbound receiving) next to Putaway so dock-to-shelf reads as one flow.
- In every case add `/warehouse` to the `end` list at `Sidebar.tsx` L209, and add a role colour in `Header.tsx` L29-33 if a new role is introduced.

**Archetype per screen.**
- Warehouse map: the `InventoryDashboard` full-height card shell with a `StatCard` band above (open picks, empty bins, utilisation), the map as SVG/CSS grid in the body, and a right-hand `Sheet` for bin detail (reuse the `PdCardSheet` pattern).
- Bin/location admin: dense spreadsheet archetype with inline edit mode and `useTableSort`.
- Pick/pack queue (supervisor): list-table archetype (`SalesList`/`Launches`: grouped active/done, row click to detail, `ConfirmCell`-style binary controls, status chips from a new map in `lib/status-colors.ts`).
- Pick/pack/putaway task screens (floor): Workspace archetype (single column `max-w-lg`, big tiles, numeral stepper, full-screen result flash), never a table.
- Putaway from a shipment: extend the `ShipmentManifest` Received cell with a second step; desktop stays a table, the floor view becomes a phone card list.
- Pick/pack throughput: reuse `Performance.tsx` plus a `MyOutputStrip`-style personal strip.

**shadcn/library additions** (smallest useful set): `skeleton`, `toggle-group` (replaces the hand-built segmented buttons), `drawer` via `vaul` (phone bottom sheet; `Sheet side="bottom"` is a zero-dependency fallback), `command` via `cmdk` (SKU/bin search combobox), `radio-group`, `table` (or keep raw tables for consistency), a success toast variant, and `breadcrumb` only if the module nests deeply. Camera scanning would additionally need `BarcodeDetector` or a JS barcode library plus the Permissions-Policy change. Consider extracting `PageHeader`, `EmptyState`, `Spinner` and `BigStepper` (from Workspace L222-245 and the carton +/- buttons) so the new module does not add another copy of each.

**Floor-staff ("user") landing changes for a phone picking app.**
1. `DefaultRedirect` (App.tsx L78) and `RequireRole` (L46-48) hard-code `/manufacturing/workspace` for `user`; this needs a per-user or per-role landing choice (for example a Workspace home with Pick / Pack / Putaway / Manufacture tiles) and a nav model that does not depend on the hamburger sheet.
2. New `/warehouse/*` routes need `allowed=["admin","manager","user"]`; the `user` role currently sees only the Manufacturing group, so sidebar roles and route roles change together. Consider a task-mode shell: below `md`, hide Header and Sidebar on task routes and show a thin top bar with progress ("3 of 12") and an exit control.
3. Layout: `h-screen` to `h-dvh`, safe-area padding, bottom-anchored primary action, `viewport-fit=cover`, optional PWA manifest, and a relaxed camera Permissions-Policy if camera scanning is chosen.
4. Reuse from Workspace: autofocus input as scanner sink (add Enter handling and exact-match auto-select, missing today), `min-h-[56-64px]` tiles, `touch-manipulation`, the full-screen success overlay (add a red error flash, since errors are only an inline box today), the `useMutation` + `pendingKey` guard, and `safeValidate` for payloads.
5. Data layer: no realtime or polling exists, so a shared pick queue needs `refetchInterval` or Supabase realtime; there is no optimistic-update pattern, so scan-confirm latency will be visible; new RPCs should keep the `{ok,error,...}` envelope with human-readable `error` strings because the UI prints them verbatim.
6. Tests: follow the repo convention (pure logic modules + unit tests); the first `.test.tsx` component tests would be new ground.

## Sources

- `src/App.tsx`, `src/main.tsx`, `index.html`, `vercel.json`, `components.json`, `tailwind.config.js`, `src/index.css`, `package.json`, `vitest.config.ts`
- `src/components/layout/{Layout,Sidebar,Header}.tsx`
- `src/components/shared/{StatCard,StatusBadge,ModeTile,PreLaunchBadge,RequireRole,ErrorBoundary,table-sort}.tsx`
- `src/components/ui/{badge,button,card,dialog,input,progress,sheet,toast}.tsx` and the directory listing
- `src/components/freight/{ShipmentManifest,CloseShortDialog}.tsx`, `src/lib/freight/receiving.ts`
- `src/components/manufacturing/{MyOutputStrip,NewFactoryOrderDialog}.tsx`
- `src/components/marketing/ConfirmCell.tsx`, `src/components/marketing/sale/sale-ui.tsx`
- `src/pages/Dashboard.tsx`, `pages/manufacturing/{Workspace,ManufacturingDashboard,Performance}.tsx`, `pages/freight/{FreightDashboard,FreightDetail}.tsx`, `pages/inventory/InventoryDashboard.tsx`, `pages/economics/SKUDetail.tsx`, `pages/marketing/{SalesList,SalesDetail,Launches}.tsx`, `pages/settings/{Settings,UserManagement}.tsx`, `pages/supplier/SupplierDashboard.tsx`
- `src/lib/{utils,constants,status-colors,use-url-filter,query-client,supabase-error,supabase,env,auth-context,marketing-format}.ts(x)`, `src/lib/schemas/index.ts`
- `src/lib/hooks/{index,use-task-logs,use-freight,use-inventory,use-supplier-portal,hooks.test}.ts`
- `src/hooks/use-toast.ts`, `src/test/setup.ts`
- `supabase/migrations/20260504000001_baseline_schema_from_staging.sql` (profiles role check, L3286)
- `docs/research/reports/Warehouse map and pick pack module.md` (L225), `CLAUDE.md`, `docs/*.md` (searched for the design rule; none found)
