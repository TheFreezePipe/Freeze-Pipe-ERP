import { addDays, todayInET } from "@/lib/performance/date-ranges";

/** The last `days` complete ship days (ET), ending yesterday, inclusive. */
export function baselineWindow(days: number, today: string = todayInET()): { from: string; to: string } {
  const to = addDays(today, -1);
  return { from: addDays(to, -(Math.max(1, Math.floor(days)) - 1)), to };
}

/** "92%" for a 0-1 share, "—" when unknown. */
export function formatShare(share: number | null | undefined): string {
  return share == null || !Number.isFinite(share) ? "—" : `${Math.round(share * 100)}%`;
}

/** "0.5 d" for days, "same day" for 0, "—" when unknown. */
export function formatDays(days: number | null | undefined): string {
  if (days == null || !Number.isFinite(days)) return "—";
  return days === 0 ? "same day" : `${days.toFixed(1)} d`;
}
