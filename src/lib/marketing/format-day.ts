/**
 * The one short date vocabulary the launch side and the PD board share:
 * fmtDay ("Jan 21"), fmtDayLong ("Jan 21, 2027") and relDays ("in 29d").
 * Lives in lib so pure logic (launch-link's Activity text) and components
 * (launch-format, pd-field-utils re-export it) format dates one way. No
 * Date parsing: the ISO string is sliced, so timezones never shift a day.
 */

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
