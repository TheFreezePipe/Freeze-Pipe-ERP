// =============================================================
// One of One markdown rules (pure — no I/O, unit-testable)
// =============================================================
// Every One of One variant is a single unique piece (inventory 1). Its
// price steps DOWN $10 for each full STEP_DAYS-day period it has sat
// unsold since its clock started, and stops at the floor: half of its
// original price.
//
//   steps         = floor(days since clock_start / STEP_DAYS)
//   target(steps) = max(floor, original - STEP_DOLLARS * steps)
//   floor         = round2(original * 0.5)
//
// The rule is a FUNCTION OF TIME, not of "how many times the job ran":
// a day that was missed (outage, paused cron) is caught up on the next
// run, and running twice in one day changes nothing. Prices only ever
// move down; a price someone set lower by hand is left alone.
//
// History: 7-day steps at launch (2026-10-22); 4-day steps from 2026-11-03.
// Because the rule is time-based, shortening the step applies retroactively
// to every piece's elapsed time on the next run.
// =============================================================

export const STEP_DOLLARS = 10;
export const STEP_DAYS = 4;
export const FLOOR_FRACTION = 0.5;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Round to cents, half-up, on the integer-cents grid (avoids 0.1+0.2 drift). */
export function round2(n: number): number {
  return Math.round(n * 100 + Number.EPSILON) / 100;
}

export function floorPrice(original: number): number {
  return round2(original * FLOOR_FRACTION);
}

/** Full days elapsed between start and now (never negative). */
export function daysSince(start: Date, now: Date): number {
  const ms = now.getTime() - start.getTime();
  return ms <= 0 ? 0 : Math.floor(ms / DAY_MS);
}

/** Full markdown steps elapsed between start and now (never negative). */
export function stepsSince(start: Date, now: Date, stepDays = STEP_DAYS): number {
  return Math.floor(daysSince(start, now) / stepDays);
}

/** The price this variant should carry after `steps` unsold steps. */
export function targetPrice(original: number, steps: number): number {
  const stepped = round2(original - STEP_DOLLARS * steps);
  return Math.max(floorPrice(original), stepped);
}

/** Steps until the floor is reached (0 if already there). */
export function stepsToFloor(original: number): number {
  return Math.ceil(round2(original - floorPrice(original)) / STEP_DOLLARS);
}

export interface VariantDecision {
  days: number;
  steps: number;
  target: number;
  /** New price to write, or null when nothing changes (already at/below target). */
  newPrice: number | null;
  atFloor: boolean;
}

/**
 * Decide what to do with one variant.
 *  - `current` is the live Shopify price; `original` the price the clock
 *    started at (stored in a metafield on first sighting).
 *  - Never raises a price: if `current` is already <= target, newPrice is null.
 */
export function decide(original: number, current: number, start: Date, now: Date, stepDays = STEP_DAYS): VariantDecision {
  const days = daysSince(start, now);
  const steps = Math.floor(days / stepDays);
  const target = targetPrice(original, steps);
  const floor = floorPrice(original);
  const newPrice = current > target ? target : null;
  const effective = newPrice ?? current;
  return { days, steps, target, newPrice, atFloor: effective <= floor };
}
