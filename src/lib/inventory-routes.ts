/**
 * Inventory module routes (IA change, owner approved 2026-10-21; see
 * docs/design/INVENTORY_MODULE_IA.md).
 *
 * The Inventory and Warehouse sidebar groups merged into one Inventory
 * group. Shipments moved from /freight to /inventory/shipments, the old
 * Stock Levels page moved from /inventory to /inventory/stock (the root is
 * now the Overview), and the Warehouse placeholders became views of Stock,
 * a Shipments filter, or a Settings tab. Every bookmarked or emailed route
 * keeps resolving through legacyRedirect().
 */

export const INVENTORY_ROUTES = {
  overview: "/inventory",
  stock: "/inventory/stock",
  factoryOrders: "/inventory/factory-orders",
  shipments: "/inventory/shipments",
  newShipment: "/inventory/shipments/new",
  materials: "/inventory/materials",
  issues: "/inventory/issues",
  floor: "/go",
} as const;

/** The four ways of looking at stock, kept in `?view=` on the Stock page. */
export type StockView = "sku" | "location" | "map" | "counts";

export const STOCK_VIEWS: readonly StockView[] = ["sku", "location", "map", "counts"];

/**
 * Link to one Stock view. "sku" is the default and, like every
 * useUrlFilter default, is not written to the URL.
 */
export function stockView(view: StockView): string {
  return view === "sku" ? INVENTORY_ROUTES.stock : `${INVENTORY_ROUTES.stock}?view=${view}`;
}

/** Stock by SKU, pre-filtered by the search box (`?q=`). */
export function stockSearch(query: string): string {
  return `${INVENTORY_ROUTES.stock}?${new URLSearchParams({ q: query }).toString()}`;
}

/** One shipment's page (check-in lives here). */
export function shipmentPath(id: string): string {
  return `${INVENTORY_ROUTES.shipments}/${id}`;
}

/**
 * Route patterns that only exist to redirect. App.tsx mounts a
 * <LegacyRedirect> on each; legacyRedirect() resolves the target.
 */
export const LEGACY_ROUTE_PATHS = [
  "/freight",
  "/freight/new",
  "/freight/:id",
  "/warehouse",
  "/warehouse/map",
  "/warehouse/putaway",
  "/warehouse/counts",
  "/warehouse/locations",
  "/inventory/quality-issues",
] as const;

type Rule = [pattern: RegExp, target: (match: RegExpMatchArray) => string];

// Order matters: /freight/new must win over /freight/:id.
const RULES: Rule[] = [
  [/^\/freight$/i, () => INVENTORY_ROUTES.shipments],
  [/^\/freight\/new$/i, () => INVENTORY_ROUTES.newShipment],
  [/^\/freight\/([^/]+)$/i, (m) => shipmentPath(m[1])],
  [/^\/warehouse$/i, () => INVENTORY_ROUTES.overview],
  [/^\/warehouse\/map$/i, () => stockView("map")],
  [/^\/warehouse\/putaway$/i, () => `${INVENTORY_ROUTES.shipments}?filter=receiving`],
  [/^\/warehouse\/counts$/i, () => stockView("counts")],
  [/^\/warehouse\/locations$/i, () => "/settings?tab=warehouse"],
  [/^\/inventory\/quality-issues$/i, () => INVENTORY_ROUTES.issues],
];

/**
 * Merge the old URL's query string into the target. Parameters the target
 * sets itself (view=, filter=, tab=) win over what the old URL carried.
 */
function withSearch(target: string, search: string): string {
  const [path, targetQuery = ""] = target.split("?");
  const merged = new URLSearchParams(search);
  new URLSearchParams(targetQuery).forEach((value, key) => merged.set(key, value));
  const query = merged.toString();
  return query ? `${path}?${query}` : path;
}

/**
 * Where a pre-merge route now lives, with its query string carried over, or
 * null when `pathname` is not a legacy route.
 */
export function legacyRedirect(pathname: string, search: string): string | null {
  // A trailing slash resolves to the same route in React Router.
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  for (const [pattern, target] of RULES) {
    const match = path.match(pattern);
    if (match) return withSearch(target(match), search);
  }
  return null;
}
