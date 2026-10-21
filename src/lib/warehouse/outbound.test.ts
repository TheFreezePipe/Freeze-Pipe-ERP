import { describe, it, expect } from "vitest";
import { effectiveOutboundMode } from "./outbound";

describe("effectiveOutboundMode", () => {
  it("passes live through on production only", () => {
    expect(effectiveOutboundMode("live", "prod")).toBe("live");
    expect(effectiveOutboundMode("live", "staging")).toBe("blocked");
    expect(effectiveOutboundMode("live", "dev")).toBe("blocked");
    expect(effectiveOutboundMode("live", undefined)).toBe("blocked");
  });

  it("keeps practice and blocked everywhere", () => {
    expect(effectiveOutboundMode("practice", "staging")).toBe("practice");
    expect(effectiveOutboundMode("practice", "prod")).toBe("practice");
    expect(effectiveOutboundMode("blocked", "prod")).toBe("blocked");
  });

  it("treats a missing or unknown setting as blocked", () => {
    expect(effectiveOutboundMode(undefined, "prod")).toBe("blocked");
    expect(effectiveOutboundMode(null, "prod")).toBe("blocked");
    expect(effectiveOutboundMode("LIVE", "prod")).toBe("blocked");
  });
});
