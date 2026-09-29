/**
 * Launch vocabulary shared by the launch form, the Launches page, the launch
 * confirm dialogs and the PD launch picker: the kind label map (never show
 * the raw mkt_launches.kind value) and the date formats the launch-link
 * dialogs use. fmtDay / relDays are also the PD sheet's formatters
 * (pd-field-utils re-exports them), so both sides format dates one way.
 */
import { humanizeEnum } from "@/lib/utils";

/** mkt_launches.kind values, in form order, with their labels. */
export const LAUNCH_KINDS: readonly { value: string; label: string }[] = [
  { value: "launch", label: "Launch" },
  { value: "drop", label: "Drop" },
  { value: "studio_drop", label: "Studio drop" },
  { value: "restock", label: "Restock" },
];

export const LAUNCH_KIND_LABEL: Readonly<Record<string, string>> = Object.fromEntries(
  LAUNCH_KINDS.map((k) => [k.value, k.label]),
);

/** Label for a launch kind; unknown values are humanized, never shown raw. */
export function launchKindLabel(kind: string | null | undefined): string {
  if (!kind) return "";
  return LAUNCH_KIND_LABEL[kind] ?? humanizeEnum(kind);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2027-01-21" (or any ISO timestamp) -> "Jan 21"; "—" when empty. */
export function fmtDay(iso: string | null | undefined): string {
  if (!iso) return "—";
  const m = Number(iso.slice(5, 7));
  const d = Number(iso.slice(8, 10));
  if (!m || !d) return "—";
  return `${MONTHS[m - 1]} ${d}`;
}

/** "2027-01-21" -> "Jan 21, 2027"; "—" when empty. */
export function fmtDayLong(iso: string | null | undefined): string {
  const short = fmtDay(iso);
  if (short === "—" || !iso) return short;
  return `${short}, ${iso.slice(0, 4)}`;
}

/** Relative-day phrasing for a deadline: "today", "in 29d", "6d late". */
export function relDays(days: number): string {
  if (days === 0) return "today";
  return days > 0 ? `in ${days}d` : `${-days}d late`;
}
