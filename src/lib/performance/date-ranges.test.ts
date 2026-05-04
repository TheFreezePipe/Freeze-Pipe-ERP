import { describe, it, expect } from "vitest";
import {
  ymdInET,
  hourInET,
  startOfEtDay,
  endOfEtDay,
  addDays,
  diffDays,
  makeRange,
  rangeToSearchParams,
  rangeFromSearchParams,
  rangeLabel,
  pickGranularity,
} from "./date-ranges";

describe("date-ranges / TZ helpers", () => {
  describe("ymdInET", () => {
    it("returns the ET date for a mid-day UTC instant", () => {
      // 2026-04-15 18:00 UTC = 14:00 ET (EDT)
      expect(ymdInET("2026-04-15T18:00:00Z")).toBe("2026-04-15");
    });

    it("rolls back to previous day when UTC is early morning", () => {
      // 2026-04-15 03:00 UTC = 23:00 ET on 2026-04-14
      expect(ymdInET("2026-04-15T03:00:00Z")).toBe("2026-04-14");
    });

    it("handles DST correctly — spring forward (March 2026)", () => {
      // DST begins 2026-03-08 02:00 ET → jumps to 03:00.
      // Before DST (standard time): 2026-03-01 06:00 UTC = 01:00 ET (EST, UTC-5)
      expect(ymdInET("2026-03-01T06:00:00Z")).toBe("2026-03-01");
      // After DST (daylight time): 2026-04-01 05:00 UTC = 01:00 ET (EDT, UTC-4)
      expect(ymdInET("2026-04-01T05:00:00Z")).toBe("2026-04-01");
    });
  });

  describe("hourInET", () => {
    it("returns the hour 0-23 in ET", () => {
      // 2026-04-15 14:30 UTC = 10:30 ET
      expect(hourInET("2026-04-15T14:30:00Z")).toBe(10);
    });
  });

  describe("startOfEtDay / endOfEtDay", () => {
    it("produces a UTC instant matching midnight ET", () => {
      // 2026-04-15 midnight ET (EDT = UTC-4) = 2026-04-15 04:00:00 UTC
      const iso = startOfEtDay("2026-04-15").toISOString();
      expect(iso).toBe("2026-04-15T04:00:00.000Z");
    });

    it("endOfEtDay is startOfEtDay of the next day", () => {
      const end = endOfEtDay("2026-04-15").toISOString();
      expect(end).toBe("2026-04-16T04:00:00.000Z");
    });

    it("handles standard time (EST, UTC-5)", () => {
      // 2026-02-10 midnight ET = 2026-02-10 05:00:00 UTC
      expect(startOfEtDay("2026-02-10").toISOString()).toBe("2026-02-10T05:00:00.000Z");
    });
  });

  describe("addDays / diffDays", () => {
    it("addDays handles month boundaries", () => {
      expect(addDays("2026-04-30", 1)).toBe("2026-05-01");
      expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    });

    it("diffDays is inclusive of the math — same day returns 0", () => {
      expect(diffDays("2026-04-15", "2026-04-15")).toBe(0);
      expect(diffDays("2026-04-20", "2026-04-15")).toBe(5);
      expect(diffDays("2026-04-10", "2026-04-15")).toBe(-5);
    });
  });

  describe("makeRange", () => {
    it("today covers a single-day range", () => {
      const r = makeRange("today");
      expect(r.fromYmd).toBe(r.toYmd);
    });

    it("last_7_days spans 7 days ending today", () => {
      const r = makeRange("last_7_days");
      expect(diffDays(r.toYmd, r.fromYmd)).toBe(6); // inclusive 7 days
    });

    it("last_30_days spans 30 days", () => {
      const r = makeRange("last_30_days");
      expect(diffDays(r.toYmd, r.fromYmd)).toBe(29);
    });

    it("custom accepts specific from/to", () => {
      const r = makeRange("custom", "2026-01-01", "2026-03-31");
      expect(r.fromYmd).toBe("2026-01-01");
      expect(r.toYmd).toBe("2026-03-31");
    });
  });

  describe("URL serialization", () => {
    it("round-trips a preset via URLSearchParams", () => {
      const original = makeRange("last_7_days");
      const sp = rangeToSearchParams(original);
      const parsed = rangeFromSearchParams(sp);
      expect(parsed.preset).toBe(original.preset);
      expect(parsed.fromYmd).toBe(original.fromYmd);
      expect(parsed.toYmd).toBe(original.toYmd);
    });

    it("round-trips a custom range", () => {
      const original = makeRange("custom", "2026-02-01", "2026-02-07");
      const sp = rangeToSearchParams(original);
      const parsed = rangeFromSearchParams(sp);
      expect(parsed.preset).toBe("custom");
      expect(parsed.fromYmd).toBe("2026-02-01");
      expect(parsed.toYmd).toBe("2026-02-07");
    });

    it("defaults to last_7_days when params are missing", () => {
      const parsed = rangeFromSearchParams(new URLSearchParams());
      expect(parsed.preset).toBe("last_7_days");
    });

    it("defaults when preset is invalid", () => {
      const sp = new URLSearchParams();
      sp.set("range", "garbage");
      const parsed = rangeFromSearchParams(sp);
      expect(parsed.preset).toBe("last_7_days");
    });
  });

  describe("rangeLabel", () => {
    it("uses preset names for non-custom ranges", () => {
      expect(rangeLabel(makeRange("today"))).toBe("Today");
      expect(rangeLabel(makeRange("last_30_days"))).toBe("Last 30 days");
    });

    it("formats custom range as 'From – To'", () => {
      expect(rangeLabel(makeRange("custom", "2026-01-15", "2026-01-20")))
        .toContain("Jan");
    });
  });

  describe("pickGranularity", () => {
    it("single day -> hourly", () => {
      expect(pickGranularity(makeRange("today"))).toBe("hourly");
    });

    it("week -> daily", () => {
      expect(pickGranularity(makeRange("last_7_days"))).toBe("daily");
    });

    it("30 days -> daily", () => {
      expect(pickGranularity(makeRange("last_30_days"))).toBe("daily");
    });

    it("custom 60 days -> weekly", () => {
      const r = makeRange("custom", "2026-01-01", "2026-03-15");
      expect(pickGranularity(r)).toBe("weekly");
    });
  });
});
