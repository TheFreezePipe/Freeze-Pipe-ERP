import { describe, it, expect } from "vitest";
import { bayParts, bayWords, cartonCode, parseScan, stationCode } from "./scan";

describe("parseScan", () => {
  it("reads ERP labels by prefix", () => {
    expect(parseScan("%02-01-2")).toEqual({ kind: "location", value: "02-01-2" });
    expect(parseScan("%DOCK")).toEqual({ kind: "location", value: "DOCK" });
    expect(parseScan("%C-466-007")).toEqual({ kind: "carton", value: "C-466-007" });
    expect(parseScan("%ZC-466-007")).toEqual({ kind: "practice", value: "C-466-007" });
    expect(parseScan("%Z02-01-2")).toEqual({ kind: "practice", value: "02-01-2" });
  });

  it("decodes ShipStation packing-slip order barcodes to their hex id", () => {
    expect(parseScan("^#^499602D2^")).toEqual({ kind: "order", value: "499602D2" });
    expect(parseInt(parseScan("^#^499602D2^").value, 16)).toBe(1234567890);
  });

  it("does not treat malformed order payloads as orders", () => {
    expect(parseScan("^#^499602d2^").kind).toBe("sku");
    expect(parseScan("^#^^").kind).toBe("sku");
    expect(parseScan("^#^ABC").kind).toBe("sku");
  });

  it("classifies digit strings of GTIN lengths", () => {
    for (const code of ["383325", "1383325", "13833251", "13833200005", "138332000051", "0138332000051"]) {
      expect(parseScan(code)).toEqual({ kind: "gtin", value: code });
    }
  });

  it("falls back to SKU for everything else", () => {
    expect(parseScan("BW20")).toEqual({ kind: "sku", value: "BW20" });
    expect(parseScan("10-Filters")).toEqual({ kind: "sku", value: "10-Filters" });
    expect(parseScan("12345")).toEqual({ kind: "sku", value: "12345" });
    expect(parseScan("123456789")).toEqual({ kind: "sku", value: "123456789" });
  });

  it("trims scanner whitespace", () => {
    expect(parseScan("  BW20\r\n")).toEqual({ kind: "sku", value: "BW20" });
    expect(parseScan(" 138332000051 ")).toEqual({ kind: "gtin", value: "138332000051" });
  });
});

describe("stationCode", () => {
  it("reads station labels, practice ones included", () => {
    expect(stationCode("%ST-MFG-1")).toBe("ST-MFG-1");
    expect(stationCode("%st-dock\r\n")).toBe("ST-DOCK");
    expect(stationCode("%ZST-S4")).toBe("ST-S4");
  });

  it("ignores locations, cartons and unprefixed codes", () => {
    expect(stationCode("%02-01-2")).toBeNull();
    expect(stationCode("%C-466-007")).toBeNull();
    expect(stationCode("ST-MFG-1")).toBeNull();
    expect(stationCode("%ST-")).toBeNull();
  });
});

describe("cartonCode", () => {
  it("reads LPN labels with or without the prefix", () => {
    expect(cartonCode("%C-466-007")).toBe("C-466-007");
    expect(cartonCode("%ZC-466-007R1")).toBe("C-466-007R1");
    expect(cartonCode(" c-ob-0012-pa ")).toBe("C-OB-0012-PA");
  });

  it("ignores everything else", () => {
    expect(cartonCode("%02-01-2")).toBeNull();
    expect(cartonCode("%ST-DOCK")).toBeNull();
    expect(cartonCode("BW20")).toBeNull();
    expect(cartonCode("%C-")).toBeNull();
  });
});

describe("bayParts and bayWords", () => {
  it("splits a bay-level code into face, bay and level", () => {
    expect(bayParts("02-01-3")).toEqual({ face: "02", bay: "01", level: "3" });
    expect(bayWords("02-01-3")).toBe("Face 02 · Bay 01 · Level 3");
  });

  it("returns null for named locations", () => {
    expect(bayParts("IN-01")).toBeNull();
    expect(bayWords("ST-MFG-2")).toBeNull();
    expect(bayParts(null)).toBeNull();
  });
});
