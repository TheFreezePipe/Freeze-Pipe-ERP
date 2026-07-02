/**
 * status-colors — shared badge color classes per status enum.
 *
 * One source of truth for the Tailwind classes that color status badges
 * across admin + supplier pages (previously copy-pasted per page; audit
 * 2026-07-02). Keyed loosely as Record<string, string> so callers can index
 * with their own row types; unknown statuses fall back to "" (unstyled
 * outline badge), same behavior as the old per-page maps.
 *
 * NOTE: the Factory Orders LIST page (src/pages/inventory/FactoryOrders.tsx)
 * intentionally uses a different palette (finished=blue, shipped=green) to
 * emphasize pipeline progression on the card grid — that map stays local.
 */

/** ordered / in_production / finished / shipped / canceled */
export const FACTORY_ORDER_STATUS_COLORS: Record<string, string> = {
  ordered: "bg-blue-500/10 text-blue-400 border-blue-500/30",
  in_production: "bg-amber-500/10 text-amber-400 border-amber-500/30",
  finished: "bg-green-500/10 text-green-400 border-green-500/30",
  shipped: "bg-slate-500/10 text-slate-400 border-slate-500/30",
  canceled: "bg-red-500/10 text-red-400 border-red-500/30",
};

/** pending / on_the_water / high_risk / cleared_customs / tracking / delivered */
export const FREIGHT_STATUS_COLORS: Record<string, string> = {
  pending: "bg-slate-500/10 text-slate-400 border-slate-500/30",
  on_the_water: "bg-indigo-500/10 text-indigo-400 border-indigo-500/30",
  high_risk: "bg-amber-500/10 text-amber-400 border-amber-500/30",
  cleared_customs: "bg-teal-500/10 text-teal-400 border-teal-500/30",
  tracking: "bg-purple-500/10 text-purple-400 border-purple-500/30",
  delivered: "bg-green-500/10 text-green-400 border-green-500/30",
};

/** open / acknowledged / disputed / resolved / written_off */
export const BREAKAGE_STATUS_COLORS: Record<string, string> = {
  open: "bg-red-500/10 text-red-400 border-red-500/30",
  acknowledged: "bg-amber-500/10 text-amber-400 border-amber-500/30",
  disputed: "bg-purple-500/10 text-purple-400 border-purple-500/30",
  resolved: "bg-green-500/10 text-green-400 border-green-500/30",
  written_off: "bg-slate-500/10 text-slate-400 border-slate-500/30",
};

/** open / acknowledged / resolved / written_off */
export const VARIANCE_STATUS_COLORS: Record<string, string> = {
  open: "bg-red-500/10 text-red-400 border-red-500/30",
  acknowledged: "bg-amber-500/10 text-amber-400 border-amber-500/30",
  resolved: "bg-green-500/10 text-green-400 border-green-500/30",
  written_off: "bg-slate-500/10 text-slate-400 border-slate-500/30",
};
