import { format, formatDistanceToNow, parseISO } from "date-fns";

/** "Oct 26, 2:14 PM" */
export function when(iso: string | null | undefined): string {
  if (!iso) return "—";
  return format(parseISO(iso), "MMM d, h:mm a");
}

/** "3 hours ago" */
export function ago(iso: string | null | undefined): string {
  if (!iso) return "never";
  return formatDistanceToNow(parseISO(iso), { addSuffix: true });
}

/** "+3", "−2", "0" with the typographic minus. */
export function signed(n: number): string {
  if (n > 0) return `+${n.toLocaleString()}`;
  if (n < 0) return `−${Math.abs(n).toLocaleString()}`;
  return "0";
}

export function varianceClass(n: number): string {
  return n > 0 ? "text-blue-400" : n < 0 ? "text-red-400" : "text-muted-foreground";
}

export function errorText(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

export const TH = "px-3 py-2.5 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground";
export const TD = "px-3 py-2 align-top";

/** The Counts view's tabs, kept in `?tab=` next to `?view=counts`. */
export type CountsTab = "variances" | "tasks" | "schedule" | "moves" | "reconcile" | "replenishment";
export const COUNTS_TABS: readonly CountsTab[] = ["variances", "tasks", "schedule", "moves", "reconcile", "replenishment"];
