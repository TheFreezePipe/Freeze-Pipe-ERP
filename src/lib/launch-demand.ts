/**
 * Launch-aware demand for manufacturing priority.
 *
 * A product that hasn't launched has no sales history, so its demand is 0
 * and the priority score (demand pressure × unfilled ratio × ABC) collapses
 * to 0 — new drops sank to the bottom of the Overview while their raw units
 * sat unfilled (owner, 2026-08-31). An upcoming launch IS demand: the
 * launch's expected first-30-day units stand in for monthly demand (or a
 * floor when the planner left it blank), and urgency ramps as launch day
 * approaches.
 */
import { daysBetween } from "@/lib/marketing/workback";

/** When a launch member has no expected-units estimate: enough to surface it. */
export const LAUNCH_DEMAND_FLOOR = 60;
/** Score multipliers by days until launch. */
export const LAUNCH_BOOST_INSIDE_14D = 1.5;
export const LAUNCH_BOOST_INSIDE_30D = 1.25;

export interface LaunchDemandInput {
  launch_date: string; // YYYY-MM-DD
  name: string;
  expected_first_30d_units: number | null;
}

export interface LaunchAwareDemand {
  /** Monthly demand to rank with: max(real, launch expectation). */
  demand: number;
  /** Multiplier on the priority score (1 when no launch). */
  boost: number;
  /** The launch that drove the result, or null. */
  launch: { name: string; launch_date: string; daysOut: number } | null;
}

/**
 * Pick the soonest upcoming launch and let it stand in for demand when it
 * exceeds what sales history says. `today` is an ISO date.
 */
export function launchAwareDemand(
  realMonthlyDemand: number,
  launches: readonly LaunchDemandInput[],
  today: string,
): LaunchAwareDemand {
  const upcoming = launches
    .filter((l) => l.launch_date >= today)
    .sort((a, b) => a.launch_date.localeCompare(b.launch_date));
  const next = upcoming[0];
  if (!next) return { demand: realMonthlyDemand, boost: 1, launch: null };

  const expected = next.expected_first_30d_units ?? LAUNCH_DEMAND_FLOOR;
  const demand = Math.max(realMonthlyDemand, expected);
  const daysOut = daysBetween(today, next.launch_date);
  const boost = daysOut <= 14 ? LAUNCH_BOOST_INSIDE_14D : daysOut <= 30 ? LAUNCH_BOOST_INSIDE_30D : 1;
  return { demand, boost, launch: { name: next.name, launch_date: next.launch_date, daysOut } };
}
