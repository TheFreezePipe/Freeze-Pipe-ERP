import { describe, it, expect } from "vitest";
import { averageSeaTransitDays } from "./transit-time";

const ship = (
  type: string,
  shipDate: string | null,
  arrival: string | null,
) => ({ freight_type: type, ship_date: shipDate, actual_arrival_date: arrival });

const TODAY = "2026-08-06";

describe("averageSeaTransitDays", () => {
  it("averages sea transits whose arrival falls in the window", () => {
    const r = averageSeaTransitDays(
      [
        ship("sea", "2026-07-01", "2026-07-31"), // 30d
        ship("sea", "2026-06-26", "2026-07-31"), // 35d
      ],
      30,
      TODAY,
    );
    expect(r).toEqual({ avgDays: 33, count: 2 }); // 32.5 rounds to 33
  });

  it("ignores air freights, missing dates, and arrivals older than the window", () => {
    const r = averageSeaTransitDays(
      [
        ship("air", "2026-07-28", "2026-08-01"), // air — excluded
        ship("sea", null, "2026-08-01"), // no ship date
        ship("sea", "2026-07-01", null), // still in transit
        ship("sea", "2026-05-01", "2026-06-10"), // arrived before cutoff
        ship("sea", "2026-07-02", "2026-08-01"), // 30d — the only qualifier
      ],
      30,
      TODAY,
    );
    expect(r).toEqual({ avgDays: 30, count: 1 });
  });

  it("includes an arrival exactly on the cutoff day", () => {
    const r = averageSeaTransitDays(
      [ship("sea", "2026-06-07", "2026-07-07")],
      30,
      TODAY, // cutoff = 2026-07-07
    );
    expect(r.count).toBe(1);
  });

  it("skips negative transits from bad data entry", () => {
    const r = averageSeaTransitDays(
      [ship("sea", "2026-08-05", "2026-08-01")],
      30,
      TODAY,
    );
    expect(r).toEqual({ avgDays: 0, count: 0 });
  });

  it("returns count 0 on empty input", () => {
    expect(averageSeaTransitDays([], 30, TODAY)).toEqual({ avgDays: 0, count: 0 });
  });
});
