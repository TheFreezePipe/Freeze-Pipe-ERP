/**
 * Stable color per drop tag — the PD board paints a thin left band on every
 * card that shares a drop so the eye groups them without a legend.
 */

/** Tailwind-safe hexes (sky-400, violet-400, pink-400, orange-400, green-400, yellow-400). */
const PALETTE = ["#38bdf8", "#a78bfa", "#f472b6", "#fb923c", "#4ade80", "#facc15"] as const;

export function dropTagColor(tag: string): string {
  const key = tag.trim().toLowerCase();
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return PALETTE[Math.abs(h) % PALETTE.length];
}
