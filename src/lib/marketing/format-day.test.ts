import { describe, expect, it } from "vitest";
import { fmtDay, fmtDayLong, relDays } from "./format-day";
import { fmtDay as fromLaunchFormat } from "@/components/marketing/launch-format";
import { fmtDate as fromPdFieldUtils } from "@/components/marketing/pd/pd-field-utils";

describe("format-day", () => {
  it("fmtDay slices the ISO date (timestamps too) and never shifts a day", () => {
    expect(fmtDay("2026-11-05")).toBe("Nov 5");
    expect(fmtDay("2026-09-22T23:30:00Z")).toBe("Sep 22");
    expect(fmtDay(null)).toBe("—");
    expect(fmtDay("")).toBe("—");
    expect(fmtDay("garbage")).toBe("—");
  });
  it("fmtDayLong adds the year; relDays reads today / in Nd / Nd late", () => {
    expect(fmtDayLong("2027-01-21")).toBe("Jan 21, 2027");
    expect(fmtDayLong(undefined)).toBe("—");
    expect(relDays(0)).toBe("today");
    expect(relDays(29)).toBe("in 29d");
    expect(relDays(-6)).toBe("6d late");
  });
  it("is the one copy the launch side and the PD board both use", () => {
    expect(fromLaunchFormat).toBe(fmtDay);
    expect(fromPdFieldUtils).toBe(fmtDay);
  });
});
