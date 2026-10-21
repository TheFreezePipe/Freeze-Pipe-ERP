import { describe, it, expect } from "vitest";
import { baselineWindow, formatDays, formatShare } from "./baseline";

describe("baselineWindow", () => {
  it("ends yesterday and spans the requested number of days", () => {
    expect(baselineWindow(14, "2026-10-20")).toEqual({ from: "2026-10-06", to: "2026-10-19" });
    expect(baselineWindow(1, "2026-10-20")).toEqual({ from: "2026-10-19", to: "2026-10-19" });
  });

  it("crosses month boundaries", () => {
    expect(baselineWindow(14, "2026-11-03")).toEqual({ from: "2026-10-20", to: "2026-11-02" });
  });

  it("never spans fewer than one day", () => {
    expect(baselineWindow(0, "2026-10-20")).toEqual({ from: "2026-10-19", to: "2026-10-19" });
  });
});

describe("formatters", () => {
  it("formats shares and days", () => {
    expect(formatShare(0.917)).toBe("92%");
    expect(formatShare(null)).toBe("—");
    expect(formatDays(1.26)).toBe("1.3 d");
    expect(formatDays(0)).toBe("same day");
    expect(formatDays(undefined)).toBe("—");
  });
});
