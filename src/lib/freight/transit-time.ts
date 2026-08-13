/**
 * Average sea-freight transit time over a trailing arrival window.
 *
 * "Transit" = actual_arrival_date − ship_date, for sea shipments whose
 * arrival falls inside the window. Arrival date is the carrier/operator
 * delivery stamp — receipt confirmation status is irrelevant here (a
 * shipment sitting unconfirmed at the dock still arrived). Rows missing
 * either date are skipped, as are negative transits (bad data entry —
 * an arrival before the ship date tells us nothing about the lane).
 */

export interface TransitShipmentLike {
  freight_type: string;
  ship_date: string | null;
  actual_arrival_date: string | null;
}

export interface SeaTransitSummary {
  /** Mean transit in whole days (rounded); 0 only when count is 0. */
  avgDays: number;
  /** Number of qualifying arrivals in the window. */
  count: number;
}

const DAY_MS = 86_400_000;

export function averageSeaTransitDays(
  shipments: readonly TransitShipmentLike[],
  windowDays = 30,
  todayIso: string = new Date().toISOString().slice(0, 10),
): SeaTransitSummary {
  const cutoffIso = new Date(
    Date.parse(todayIso + "T00:00:00Z") - windowDays * DAY_MS,
  )
    .toISOString()
    .slice(0, 10);

  let totalDays = 0;
  let count = 0;
  for (const s of shipments) {
    if (s.freight_type !== "sea") continue;
    if (!s.ship_date || !s.actual_arrival_date) continue;
    // Date-only ISO strings compare correctly as strings.
    if (s.actual_arrival_date < cutoffIso) continue;
    const transit = Math.round(
      (Date.parse(s.actual_arrival_date + "T00:00:00Z") -
        Date.parse(s.ship_date + "T00:00:00Z")) /
        DAY_MS,
    );
    if (transit < 0) continue;
    totalDays += transit;
    count++;
  }

  return { avgDays: count > 0 ? Math.round(totalDays / count) : 0, count };
}
