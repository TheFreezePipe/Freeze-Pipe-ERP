/**
 * Stable color per drop tag — the PD board paints a thin left band and a
 * chip on every card that shares a drop so the eye groups them without a
 * legend.
 *
 * Colors come from the tag's hash, but two names can hash to the same slot
 * ("Q4 Studio" and "Alien Studio" both did). dropColorMap resolves that for
 * the drops actually on the board: the OLDER drop keeps its hash color and
 * a newer colliding drop takes the next free slot — so adding a drop never
 * recolors the ones already there.
 */

/** Tailwind-safe hexes (sky-400, violet-400, pink-400, orange-400, green-400, yellow-400). */
export const DROP_PALETTE = ["#38bdf8", "#a78bfa", "#f472b6", "#fb923c", "#4ade80", "#facc15"] as const;

function slotOf(tag: string): number {
  const key = tag.trim().toLowerCase();
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return Math.abs(h) % DROP_PALETTE.length;
}

/** Hash color alone — the fallback when a tag isn't in a board map. */
export function dropTagColor(tag: string): string {
  return DROP_PALETTE[slotOf(tag)];
}

export interface DropForColor {
  tag: string;
  /** Oldest member's created_at — decides who keeps a contested slot. */
  since: string;
}

/** tag → color for one board, distinct for up to six drops. */
export function dropColorMap(drops: readonly DropForColor[]): Map<string, string> {
  const ordered = [...drops].sort((a, b) => a.since.localeCompare(b.since) || a.tag.localeCompare(b.tag));
  const taken = new Set<number>();
  const out = new Map<string, string>();
  for (const d of ordered) {
    let slot = slotOf(d.tag);
    if (taken.size < DROP_PALETTE.length) {
      let tries = 0;
      while (taken.has(slot) && tries++ < DROP_PALETTE.length) slot = (slot + 1) % DROP_PALETTE.length;
    }
    taken.add(slot);
    out.set(d.tag, DROP_PALETTE[slot]);
  }
  return out;
}

/** Color for a tag from a board map, falling back to the hash color. */
export function dropColorFor(map: ReadonlyMap<string, string> | undefined, tag: string): string {
  return map?.get(tag) ?? dropTagColor(tag);
}
