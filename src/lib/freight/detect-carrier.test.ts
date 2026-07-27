import { describe, it, expect } from "vitest";
import { detectCarrier } from "./detect-carrier";

describe("detectCarrier", () => {
  it("detects UPS 1Z numbers regardless of case and spacing", () => {
    expect(detectCarrier("1Z999AA10123456784")).toBe("UPS");
    expect(detectCarrier("1z 999 aa1 012 345 6784")).toBe("UPS");
  });

  it("detects FedEx 12- and 15-digit numbers", () => {
    expect(detectCarrier("881263905122")).toBe("FedEx");
    expect(detectCarrier("123456789012345")).toBe("FedEx");
  });

  it("detects FedEx 20/22-digit ground barcodes", () => {
    expect(detectCarrier("96123456789012345678")).toBe("FedEx");
    expect(detectCarrier("9261290100123456789012")).toBe("FedEx");
  });

  it("detects DHL 10-digit waybills", () => {
    expect(detectCarrier("1234567890")).toBe("DHL");
  });

  it("returns null for unknowns, empties, and near-misses", () => {
    expect(detectCarrier("")).toBeNull();
    expect(detectCarrier("   ")).toBeNull();
    expect(detectCarrier("MSKU1234567")).toBeNull(); // ocean container
    expect(detectCarrier("1Z999")).toBeNull(); // truncated UPS
    expect(detectCarrier("12345678901")).toBeNull(); // 11 digits — ambiguous
    expect(detectCarrier("ABC-123")).toBeNull();
  });
});
