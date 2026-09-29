import { describe, it, expect } from "vitest";
import { readyByDefault, READY_BY_LEAD_DAYS, IN_WAREHOUSE_LEAD_DAYS, WORKBACK } from "./workback";

describe("readyByDefault", () => {
  it("is 20 days, the in-warehouse standard shared with the PD card chain", () => {
    expect(READY_BY_LEAD_DAYS).toBe(20);
    expect(READY_BY_LEAD_DAYS).toBe(IN_WAREHOUSE_LEAD_DAYS);
    expect(WORKBACK.arrivalBufferDays).toBe(IN_WAREHOUSE_LEAD_DAYS);
  });

  it("launch date only: 20 days before the launch", () => {
    expect(readyByDefault("", "2026-09-30")).toBe("2026-09-10");
  });

  it("early access set: 20 days before early access, the earlier date", () => {
    expect(readyByDefault("2026-09-25", "2026-09-30")).toBe("2026-09-05");
  });

  it("early access after the launch date (invalid but typed): the launch date still wins", () => {
    expect(readyByDefault("2026-10-05", "2026-09-30")).toBe("2026-09-10");
  });

  it("crosses a month and a year boundary", () => {
    expect(readyByDefault("", "2026-11-12")).toBe("2026-10-23");
    expect(readyByDefault("2027-01-10", "2027-01-15")).toBe("2026-12-21");
  });

  it("no dates: empty", () => {
    expect(readyByDefault("", "")).toBe("");
  });
});
