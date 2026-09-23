import { describe, it, expect } from "vitest";
import { readyByDefault, READY_BY_LEAD_DAYS } from "./workback";

describe("readyByDefault", () => {
  it("is 21 days", () => {
    expect(READY_BY_LEAD_DAYS).toBe(21);
  });

  it("launch date only: three weeks before the launch", () => {
    expect(readyByDefault("", "2026-09-30")).toBe("2026-09-09");
  });

  it("early access set: three weeks before early access, the earlier date", () => {
    expect(readyByDefault("2026-09-25", "2026-09-30")).toBe("2026-09-04");
  });

  it("early access after the launch date (invalid but typed): the launch date still wins", () => {
    expect(readyByDefault("2026-10-05", "2026-09-30")).toBe("2026-09-09");
  });

  it("crosses a month and a year boundary", () => {
    expect(readyByDefault("", "2026-11-12")).toBe("2026-10-22");
    expect(readyByDefault("2027-01-10", "2027-01-15")).toBe("2026-12-20");
  });

  it("no dates: empty", () => {
    expect(readyByDefault("", "")).toBe("");
  });
});
