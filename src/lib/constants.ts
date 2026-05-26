export const TASK_TYPES = {
  emptying: {
    label: "Emptying",
    description: "Separate fillable pieces from packaging onto trays",
    color: "text-blue-400",
    bgColor: "bg-blue-400/10",
  },
  filling_capping: {
    label: "Filling & Capping",
    description: "Fill with glycerin and affix caps",
    color: "text-orange-400",
    bgColor: "bg-orange-400/10",
  },
  rtsing: {
    label: "RTSing",
    description: "Repackage filled units - Ready to Ship",
    color: "text-green-400",
    bgColor: "bg-green-400/10",
  },
  prefilled_rtsing: {
    label: "Pre-Filled RTSing",
    description: "RTS for pre-filled items (skip filling)",
    color: "text-purple-400",
    bgColor: "bg-purple-400/10",
  },
  breakage: {
    label: "Log Breakage",
    description: "Remove broken units from finished inventory",
    color: "text-red-400",
    bgColor: "bg-red-400/10",
  },
} as const;

export type TaskType = keyof typeof TASK_TYPES;

export const FREIGHT_STATUSES = {
  // Pre-departure — supplier declares the shipment in 'pending'. Once
  // the supplier submits tracking + carrier, migration 035's RPC
  // auto-promotes to 'on_the_water' (booked was collapsed out — there's
  // no meaningful difference between "booked with carrier" and "on the
  // water" in practice).
  pending: { label: "Pending", color: "text-slate-400", bgColor: "bg-slate-400/10" },
  // In-flight / post-departure
  on_the_water: { label: "On the Water", color: "text-indigo-400", bgColor: "bg-indigo-400/10" },
  high_risk: { label: "High Risk", color: "text-red-400", bgColor: "bg-red-400/10" },
  cleared_customs: { label: "Cleared Customs", color: "text-yellow-400", bgColor: "bg-yellow-400/10" },
  tracking: { label: "Tracking", color: "text-cyan-400", bgColor: "bg-cyan-400/10" },
  // Out for Delivery — carrier has handed the package to a driver for
  // final delivery. Sits between tracking (in motion at a facility)
  // and delivered (in operator's hands). Set automatically by
  // tracking-reconcile when the carrier flips its own status.
  out_for_delivery: { label: "Out for Delivery", color: "text-blue-400", bgColor: "bg-blue-400/10" },
  delivered: { label: "Delivered", color: "text-green-400", bgColor: "bg-green-400/10" },
} as const;

export type FreightStatus = keyof typeof FREIGHT_STATUSES;

export const FREIGHT_TYPES = {
  air: { label: "Air Freight", icon: "Plane" },
  sea: { label: "Sea Freight", icon: "Ship" },
} as const;

export type FreightType = keyof typeof FREIGHT_TYPES;

export const ABC_CLASSIFICATIONS = ["A", "B", "C"] as const;
export type ABCClassification = (typeof ABC_CLASSIFICATIONS)[number];

export const PRODUCT_CATEGORIES = {
  fillable: { label: "Fillable", description: "Requires glycerin filling" },
  non_fillable: { label: "Non-Fillable", description: "Ships as-is" },
} as const;

export type ProductCategory = keyof typeof PRODUCT_CATEGORIES;

export const DISPLAY_CATEGORIES = [
  "Pipes",
  "Bubblers",
  "Joint Chiller",
  "Bongs",
  "Dab Rigs",
  "Ash Catchers",
  "Accessories",
  "Bowls",
  "Coils",
  "Bases",
  "Studio",
] as const;

export type DisplayCategory = (typeof DISPLAY_CATEGORIES)[number];

// Operational priority order for default sorts on operator-facing tables
// (Stock Levels, SKU Economics). Distinct from DISPLAY_CATEGORIES above
// which is the catalog of valid values — that list is in roughly-alpha
// order for use in filter dropdowns; this list reflects Chase's preferred
// display sequence (high-velocity / customer-facing categories first,
// component categories last). Set 2026-05-07.
//
// Translations from Chase's spoken list to the canonical category values:
//   "joint products" → "Joint Chiller" (only joint-related category)
//   "Studio Products" → "Studio"
// Lookup is case-insensitive; anything not in this list lands at the
// bottom of the table so catalog drift surfaces visibly.
export const DISPLAY_CATEGORY_PRIORITY: ReadonlyArray<string> = [
  "Pipes",
  "Bubblers",
  "Joint Chiller",
  "Bongs",
  "Dab Rigs",
  "Studio",
  "Ash Catchers",
  "Bowls",
  "Accessories",
  "Coils",
  "Bases",
];
const DISPLAY_CATEGORY_PRIORITY_INDEX: ReadonlyMap<string, number> = new Map(
  DISPLAY_CATEGORY_PRIORITY.map((c, i) => [c.toLowerCase(), i]),
);
/**
 * Sort key for ordering rows by Chase's preferred category sequence.
 * Unknown / null categories return a value past the end so they sort to
 * the bottom (where catalog drift is easy to spot).
 */
export function displayCategoryRank(
  displayCategory: string | null | undefined,
): number {
  if (!displayCategory) return DISPLAY_CATEGORY_PRIORITY.length + 1;
  const idx = DISPLAY_CATEGORY_PRIORITY_INDEX.get(displayCategory.toLowerCase());
  return idx === undefined ? DISPLAY_CATEGORY_PRIORITY.length + 1 : idx;
}

// Material categories — consumables tracking (migration
// 20260526000001_materials_consumables_tracking). Distinct taxonomy
// from DISPLAY_CATEGORIES above; materials are non-sellable inputs
// (glycerin, caps, boxes, etc.) and don't share the sellable-product
// hierarchy. Priority order reflects operational urgency: things that
// block production (Filling Materials, Caps) before things that block
// fulfillment (Packaging).
export const MATERIAL_CATEGORIES = [
  "Filling Materials",
  "Caps",
  "Packaging",
  "Other",
] as const;

export type MaterialCategory = (typeof MATERIAL_CATEGORIES)[number];

const MATERIAL_CATEGORY_PRIORITY_INDEX: ReadonlyMap<string, number> = new Map(
  MATERIAL_CATEGORIES.map((c, i) => [c.toLowerCase(), i]),
);

/**
 * Sort key for ordering material rows by operational priority. Unknown
 * categories return a value past the end so they sort to the bottom
 * (same convention as displayCategoryRank for SKUs).
 */
export function materialCategoryRank(category: string | null | undefined): number {
  if (!category) return MATERIAL_CATEGORIES.length + 1;
  const idx = MATERIAL_CATEGORY_PRIORITY_INDEX.get(category.toLowerCase());
  return idx === undefined ? MATERIAL_CATEGORIES.length + 1 : idx;
}

// FACTORIES / Factory type retired when the hardcoded nancy/yx enum was
// replaced by the suppliers table (migration 017+). If you need a label for
// a supplier, look it up on the suppliers row directly.

export const FACTORY_ORDER_STATUSES = {
  ordered: { label: "Ordered", color: "text-blue-400", bgColor: "bg-blue-400/10" },
  in_production: { label: "In Production", color: "text-yellow-400", bgColor: "bg-yellow-400/10" },
  finished: { label: "Finished", color: "text-green-400", bgColor: "bg-green-400/10" },
  shipped: { label: "Shipped", color: "text-purple-400", bgColor: "bg-purple-400/10" },
} as const;

export type FactoryOrderStatus = keyof typeof FACTORY_ORDER_STATUSES;
