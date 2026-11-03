/**
 * Measured outbound shipping ("as sold") — shared labels and helpers for
 * the rows the weekly shipping-measure job writes to sku_shipping_measured.
 */

/** Flag → short human label. Never print a raw flag. */
export const SHIPPING_FLAG_LABEL: Record<string, string> = {
  drift_cost: "Cost moved >10%",
  drift_weight: "Weight moved >10%",
  joint: "Weighed with partner",
  low_confidence: "Few orders",
  no_fit: "No solved weight",
  stale: "Not sold lately",
};

/** Flags worth a person's attention (the rest are informational). */
export const ACTIONABLE_SHIPPING_FLAGS = ["drift_cost", "drift_weight", "stale"] as const;

export function shippingFlagLabel(flag: string, jointWith?: string | null): string {
  if (flag === "joint" && jointWith) return `Weighed with ${jointWith}`;
  return SHIPPING_FLAG_LABEL[flag] ?? flag.replace(/_/g, " ");
}

export function hasActionableShippingFlag(flags: readonly string[] | null | undefined): boolean {
  return (flags ?? []).some((f) => (ACTIONABLE_SHIPPING_FLAGS as readonly string[]).includes(f));
}
