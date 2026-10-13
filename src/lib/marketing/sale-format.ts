/**
 * Sale dashboards — number and day formatting. Tabular, signed with a real
 * minus sign, "—" for nothing.
 */

export const MINUS = "−";
export const NONE_TEXT = "—";

const DOWN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Day key (YYYY-MM-DD) → epoch ms at UTC midnight; keys are calendar days, never instants. */
export const dayT = (k: string): number => Date.parse(k + "T00:00:00Z");
export const dow = (k: string): number => new Date(dayT(k)).getUTCDay();
export const addDays = (k: string, n: number): string => new Date(dayT(k) + n * 864e5).toISOString().slice(0, 10);
export const daysBetween = (a: string, b: string): number => Math.round((dayT(b) - dayT(a)) / 864e5);
export const sum = (a: ReadonlyArray<number | null | undefined>): number => a.reduce<number>((s, v) => s + (v || 0), 0);

export const F = {
  int: (n: number | null | undefined): string => (n == null ? NONE_TEXT : Math.round(n).toLocaleString("en-US")),
  money: (n: number | null | undefined): string =>
    n == null ? NONE_TEXT : (n < 0 ? MINUS : "") + "$" + Math.round(Math.abs(n)).toLocaleString("en-US"),
  cell: (n: number | null | undefined): string =>
    n == null ? NONE_TEXT : (n < 0 ? MINUS : "") + Math.round(Math.abs(n)).toLocaleString("en-US"),
  k: (n: number | null | undefined): string =>
    n == null
      ? NONE_TEXT
      : (n < 0 ? MINUS : "") +
        "$" +
        (Math.abs(n) >= 1000
          ? (Math.abs(n) / 1000).toLocaleString("en-US", { maximumFractionDigits: 1, minimumFractionDigits: 1 }) + "k"
          : Math.round(Math.abs(n)).toLocaleString("en-US")),
  pct0: (x: number | null | undefined): string => (x == null ? NONE_TEXT : Math.round(x * 100) + ""),
  pct1: (x: number | null | undefined): string => (x == null ? NONE_TEXT : (x * 100).toFixed(1)),
  rate: (n: number | null | undefined): string => (n == null ? NONE_TEXT : Number(n).toFixed(1)),
  dec2: (n: number | null | undefined): string => (n == null ? NONE_TEXT : Number(n).toFixed(2)),
  x: (n: number | null | undefined): string => (n == null ? NONE_TEXT : Number(n).toFixed(1) + "×"),
  signed: (d: number | null | undefined, unit: "pct" | "pts" = "pct"): string => {
    if (d == null) return NONE_TEXT;
    if (unit === "pts") {
      const v = Math.round(d * 100);
      return v === 0 ? "0 pts" : (v > 0 ? "+" : MINUS) + Math.abs(v) + " pts";
    }
    const a = Math.abs(d) * 100;
    const s = a >= 10 ? Math.round(a) + "%" : a.toFixed(1) + "%";
    return a < 0.05 ? "0%" : (d > 0 ? "+" : MINUS) + s;
  },
  md: (k: string): string => MON[Number(k.slice(5, 7)) - 1] + " " + Number(k.slice(8, 10)),
  dayDow: (k: string): string => DOWN[dow(k)] + " " + MON[Number(k.slice(5, 7)) - 1] + " " + Number(k.slice(8, 10)),
  range: (a: string, b: string): string => {
    const ma = Number(a.slice(5, 7)), mb = Number(b.slice(5, 7));
    return ma === mb
      ? MON[ma - 1] + " " + Number(a.slice(8, 10)) + " – " + Number(b.slice(8, 10))
      : MON[ma - 1] + " " + Number(a.slice(8, 10)) + " – " + MON[mb - 1] + " " + Number(b.slice(8, 10));
  },
  hour: (h: number): string => (h === 0 ? "12 am" : h < 12 ? h + " am" : h === 12 ? "12 pm" : h - 12 + " pm"),
  /** "2:00 pm" from an ISO instant, in Eastern time. */
  timeET: (iso: string | null | undefined): string => {
    if (!iso) return NONE_TEXT;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return NONE_TEXT;
    return d.toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }).toLowerCase();
  },
  /** "Oct 5, 2:00 pm" in Eastern time. */
  stampET: (iso: string | null | undefined): string => {
    if (!iso) return NONE_TEXT;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return NONE_TEXT;
    const day = d.toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" });
    return day + ", " + F.timeET(iso);
  },
};
