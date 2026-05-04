/**
 * Date range primitives for the Performance dashboard.
 *
 * Timezone: America/New_York (Eastern). All day-boundary math is computed in
 * local time via Intl.DateTimeFormat to handle DST transitions correctly —
 * never hard-code UTC offsets.
 *
 * Ranges are [start, end) half-open: start inclusive, end exclusive. A task
 * whose `time_completed` falls in this half-open window belongs to the range.
 */

export const TZ = "America/New_York";

export type RangePreset = "today" | "yesterday" | "last_7_days" | "last_30_days" | "custom";

export interface DateRange {
  preset: RangePreset;
  /** Inclusive start as UTC ISO timestamp. */
  startIso: string;
  /** Exclusive end as UTC ISO timestamp. */
  endIso: string;
  /** YYYY-MM-DD in ET — what the user selected / sees. */
  fromYmd: string;
  /** YYYY-MM-DD in ET — the last day included in the range (inclusive). */
  toYmd: string;
}

// --- TZ conversion helpers ---------------------------------------------------

const ymdFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const etPartsFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

/** YYYY-MM-DD (ET) for a given instant. */
export function ymdInET(instant: Date | string): string {
  const d = typeof instant === "string" ? new Date(instant) : instant;
  return ymdFormatter.format(d);
}

/** Get the hour of day (0-23, ET) for an instant. */
export function hourInET(instant: Date | string): number {
  const d = typeof instant === "string" ? new Date(instant) : instant;
  const parts = etPartsFormatter.formatToParts(d);
  const hour = parts.find(p => p.type === "hour")?.value ?? "0";
  return parseInt(hour, 10);
}

/**
 * Convert a YYYY-MM-DD ET date + HH:MM:SS.sss clock time into the matching UTC
 * instant. We find the UTC instant whose ET wall clock is exactly what the user
 * wanted by iterating — there are at most two candidate offsets (standard /
 * daylight saving) so one correction is sufficient. This is the canonical
 * "DST-safe date->utc" pattern when you only have the Intl API.
 */
function etWallToUtc(ymd: string, h: number, m: number, s: number, ms: number): Date {
  // Algorithm: treat the desired (ymd, h:m:s.ms) tuple as if it were UTC to
  // get a first-guess UTC instant. Format that guess in ET and see how far
  // the ET wall clock drifted from what we wanted. The difference, applied
  // as an additive correction to the guess's UTC time, gives the actual
  // UTC instant whose ET wall clock matches the target.
  //
  //   correctUtc = guess + (wanted_wallclock - got_wallclock)
  //
  // For ET this correction is always +4h or +5h depending on DST, since
  // ET is UTC-4 (EDT) or UTC-5 (EST).
  const [y, mo, d] = ymd.split("-").map(Number);
  const guess = new Date(Date.UTC(y, mo - 1, d, h, m, s, ms));
  const asEt = etParts(guess);
  const wantMinutes = h * 60 + m;
  const gotMinutes = asEt.hour * 60 + asEt.minute;
  // dayDrift: +1 if asEt.ymd is the day BEFORE ymd (common — guess is in UTC
  // which runs 4-5h ahead of ET), -1 if asEt.ymd is the day AFTER.
  const dayDrift =
    Number(asEt.ymd < ymd) - Number(asEt.ymd > ymd);
  const minutesOff = (wantMinutes - gotMinutes) + dayDrift * 24 * 60;
  return new Date(guess.getTime() + minutesOff * 60_000);
}

interface EtParts { ymd: string; hour: number; minute: number }
function etParts(d: Date): EtParts {
  const parts = etPartsFormatter.formatToParts(d);
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? "0";
  return {
    ymd: `${get("year")}-${get("month")}-${get("day")}`,
    hour: parseInt(get("hour"), 10),
    minute: parseInt(get("minute"), 10),
  };
}

/** UTC instant for 00:00:00 ET on the given day (start of day, ET). */
export function startOfEtDay(ymd: string): Date {
  return etWallToUtc(ymd, 0, 0, 0, 0);
}

/** UTC instant for 00:00:00 ET on the day AFTER the given day (exclusive end). */
export function endOfEtDay(ymd: string): Date {
  return startOfEtDay(addDays(ymd, 1));
}

/** Add N days to a YYYY-MM-DD string (using UTC math — safe since date-only). */
export function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  // Format using UTC parts directly. Do NOT route through ymdFormatter here —
  // that formatter is ET-aware and would shift the date by the UTC→ET offset.
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

export function diffDays(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  const at = Date.UTC(ay, am - 1, ad);
  const bt = Date.UTC(by, bm - 1, bd);
  return Math.round((at - bt) / 86_400_000);
}

/** Today's date in ET as YYYY-MM-DD. */
export function todayInET(): string {
  return ymdInET(new Date());
}

// --- Range builders ----------------------------------------------------------

function buildRange(preset: RangePreset, fromYmd: string, toYmd: string): DateRange {
  return {
    preset,
    fromYmd,
    toYmd,
    startIso: startOfEtDay(fromYmd).toISOString(),
    endIso: endOfEtDay(toYmd).toISOString(),
  };
}

export function makeRange(preset: RangePreset, customFrom?: string, customTo?: string): DateRange {
  const today = todayInET();
  switch (preset) {
    case "today":
      return buildRange("today", today, today);
    case "yesterday": {
      const y = addDays(today, -1);
      return buildRange("yesterday", y, y);
    }
    case "last_7_days":
      return buildRange("last_7_days", addDays(today, -6), today);
    case "last_30_days":
      return buildRange("last_30_days", addDays(today, -29), today);
    case "custom":
      return buildRange("custom", customFrom ?? today, customTo ?? today);
  }
}

// --- URL serialization -------------------------------------------------------

export function rangeToSearchParams(range: DateRange): URLSearchParams {
  const sp = new URLSearchParams();
  if (range.preset === "custom") {
    sp.set("from", range.fromYmd);
    sp.set("to", range.toYmd);
  } else {
    sp.set("range", range.preset);
  }
  return sp;
}

export function rangeFromSearchParams(sp: URLSearchParams): DateRange {
  const preset = sp.get("range") as RangePreset | null;
  const from = sp.get("from");
  const to = sp.get("to");
  if (from && to) return makeRange("custom", from, to);
  if (preset && ["today", "yesterday", "last_7_days", "last_30_days"].includes(preset)) {
    return makeRange(preset);
  }
  return makeRange("last_7_days"); // sensible default
}

// --- Display helpers ---------------------------------------------------------

const RANGE_LABELS: Record<RangePreset, string> = {
  today: "Today",
  yesterday: "Yesterday",
  last_7_days: "Last 7 days",
  last_30_days: "Last 30 days",
  custom: "Custom",
};

export function rangeLabel(range: DateRange): string {
  if (range.preset !== "custom") return RANGE_LABELS[range.preset];
  const from = formatEtYmd(range.fromYmd);
  const to = formatEtYmd(range.toYmd);
  return range.fromYmd === range.toYmd ? from : `${from} – ${to}`;
}

export function formatEtYmd(ymd: string, opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" }): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { ...opts, timeZone: "UTC" });
}

// --- Bucketing ---------------------------------------------------------------

export type BucketGranularity = "hourly" | "daily" | "weekly";

export function pickGranularity(range: DateRange): BucketGranularity {
  const days = diffDays(range.toYmd, range.fromYmd) + 1;
  if (days <= 1) return "hourly";
  if (days <= 45) return "daily";
  return "weekly";
}
