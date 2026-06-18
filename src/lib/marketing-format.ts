/**
 * marketing-format — pure display helpers for the Marketing module.
 * No React, no Supabase. Keeps the composable-offer → human-text logic
 * in one tested place.
 */

/** Drop trailing zeros from a numeric value for display (20.00 → "20"). */
function trimNum(n: number): string {
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 });
}

export interface OfferLike {
  percent_off: number | null;
  dollar_off: number | null;
  free_item_sku_id: string | null;
  min_order_amount: number | null;
  buy_qty: number | null;
  get_qty: number | null;
  scope: string;
  category: string | null;
  code: string | null;
}

/**
 * Render a composable offer into readable parts:
 *   deal   — "20% off + free Grinder over $75"
 *   target — "Sitewide" | "<Category>" | "Select SKUs"
 *   code   — the coupon code or null
 */
export function describeOffer(
  o: OfferLike,
  freeItemName?: string | null,
): { deal: string; target: string; code: string | null } {
  const parts: string[] = [];
  if (o.percent_off != null) parts.push(`${trimNum(o.percent_off)}% off`);
  if (o.dollar_off != null) parts.push(`$${trimNum(o.dollar_off)} off`);
  if (o.buy_qty != null && o.get_qty != null) parts.push(`buy ${o.buy_qty} get ${o.get_qty}`);
  if (o.free_item_sku_id) parts.push(`free ${freeItemName ?? "item"}`);

  let deal = parts.join(" + ") || "Offer";
  deal = deal.charAt(0).toUpperCase() + deal.slice(1);
  if (o.min_order_amount != null) deal += ` over $${trimNum(o.min_order_amount)}`;

  const target =
    o.scope === "sitewide"
      ? "Sitewide"
      : o.scope === "category"
        ? o.category || "Category"
        : "Select SKUs";

  return { deal, target, code: o.code || null };
}

export const SALE_STATUS_COLOR: Record<string, string> = {
  planned: "bg-muted/50 text-muted-foreground",
  scheduled: "bg-blue-500/10 text-blue-400",
  live: "bg-green-500/10 text-green-400",
  ended: "bg-muted/40 text-muted-foreground",
  canceled: "bg-red-500/10 text-red-400",
};

export const LAUNCH_STATUS_COLOR: Record<string, string> = {
  planned: "bg-muted/50 text-muted-foreground",
  scheduled: "bg-blue-500/10 text-blue-400",
  live: "bg-green-500/10 text-green-400",
  sold_out: "bg-amber-500/10 text-amber-400",
  ended: "bg-muted/40 text-muted-foreground",
  canceled: "bg-red-500/10 text-red-400",
};

/** Marketing event-type colors for the calendar (sale / launch / broadcast). */
export const EVENT_TYPE_COLOR = {
  sale: "hsl(45, 85%, 55%)",
  launch: "hsl(270, 67%, 60%)",
  broadcast: "hsl(190, 80%, 55%)",
} as const;
