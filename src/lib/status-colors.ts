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

/**
 * Warehouse zones (wh_locations.zone) for chips. The map's browse mode
 * paints the same hues from WH_ZONE_FILLS: RTS green, RAW grey, BOX amber,
 * WIP orange, ACC blue, MISC slate; floor zones get their own.
 */
export const WH_ZONE_COLORS: Record<string, string> = {
  RTS: "bg-green-500/10 text-green-400 border-green-500/30",
  RAW: "bg-zinc-400/10 text-zinc-300 border-zinc-400/30",
  BOX: "bg-amber-500/10 text-amber-400 border-amber-500/30",
  WIP: "bg-orange-500/10 text-orange-400 border-orange-500/30",
  ACC: "bg-blue-500/10 text-blue-400 border-blue-500/30",
  MISC: "bg-slate-500/10 text-slate-400 border-slate-500/30",
  IN: "bg-cyan-500/10 text-cyan-400 border-cyan-500/30",
  OUT: "bg-indigo-500/10 text-indigo-400 border-indigo-500/30",
  MFG: "bg-rose-500/10 text-rose-400 border-rose-500/30",
  PACK: "bg-teal-500/10 text-teal-400 border-teal-500/30",
  SPARE: "bg-purple-500/10 text-purple-400 border-purple-500/30",
  VIRTUAL: "bg-slate-500/10 text-slate-400 border-slate-500/30",
};

/** SVG fills for the same zones (the map draws them at partial opacity). */
export const WH_ZONE_FILLS: Record<string, string> = {
  RTS: "#22c55e",
  RAW: "#a1a1aa",
  BOX: "#f59e0b",
  WIP: "#f97316",
  ACC: "#3b82f6",
  MISC: "#64748b",
  IN: "#06b6d4",
  OUT: "#818cf8",
  MFG: "#fb7185",
  PACK: "#14b8a6",
  SPARE: "#a78bfa",
  VIRTUAL: "#64748b",
};

/** sealed / open / empty / void (wh_containers.state) */
export const CONTAINER_STATE_COLORS: Record<string, string> = {
  sealed: "bg-cyan-500/10 text-cyan-400 border-cyan-500/30",
  open: "bg-amber-500/10 text-amber-400 border-amber-500/30",
  empty: "bg-slate-500/10 text-slate-400 border-slate-500/30",
  void: "bg-slate-500/10 text-slate-500 border-slate-500/30",
};
