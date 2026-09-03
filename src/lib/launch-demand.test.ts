import { describe, it, expect } from "vitest";
import { LAUNCH_DEMAND_FLOOR, launchAwareDemand } from "./launch-demand";

const TODAY = "2026-08-31";

describe("launchAwareDemand", () => {
  it("no launch → real demand, no boost", () => {
    expect(launchAwareDemand(120, [], TODAY)).toEqual({ demand: 120, boost: 1, launch: null });
  });

  it("an unlaunched product borrows the launch's expected units and ramps with proximity", () => {
    const r = launchAwareDemand(0, [{ name: "Halloween Studio Drop", launch_date: "2026-09-18", expected_first_30d_units: 150 }], TODAY);
    expect(r.demand).toBe(150);
    expect(r.boost).toBe(1.25); // 18 days out
    expect(r.launch).toEqual({ name: "Halloween Studio Drop", launch_date: "2026-09-18", daysOut: 18 });
    expect(launchAwareDemand(0, [{ name: "x", launch_date: "2026-09-05", expected_first_30d_units: 150 }], TODAY).boost).toBe(1.5);
    expect(launchAwareDemand(0, [{ name: "x", launch_date: "2026-10-20", expected_first_30d_units: 150 }], TODAY).boost).toBe(1);
  });

  it("blank expectation falls back to the floor; real demand wins when larger", () => {
    expect(launchAwareDemand(0, [{ name: "x", launch_date: "2026-09-18", expected_first_30d_units: null }], TODAY).demand).toBe(LAUNCH_DEMAND_FLOOR);
    expect(launchAwareDemand(400, [{ name: "x", launch_date: "2026-09-18", expected_first_30d_units: 150 }], TODAY).demand).toBe(400);
  });

  it("uses the soonest upcoming launch and ignores past ones", () => {
    const r = launchAwareDemand(
      0,
      [
        { name: "past", launch_date: "2026-08-01", expected_first_30d_units: 999 },
        { name: "later", launch_date: "2026-11-01", expected_first_30d_units: 50 },
        { name: "soon", launch_date: "2026-09-10", expected_first_30d_units: 80 },
      ],
      TODAY,
    );
    expect(r.launch?.name).toBe("soon");
    expect(r.demand).toBe(80);
  });
});
