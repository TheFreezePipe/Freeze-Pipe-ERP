import { describe, it, expect } from "vitest";
import catalogCsv from "../../../docs/research/warehouse-map/sku_catalog_with_upc.csv?raw";
import { gtinCandidates, upcaCheckDigit, expandUpcE } from "./gtin";

interface CatalogRow {
  sku: string;
  upc_gtin12: string;
  upc_upce8: string;
  upc_raw: string;
  upc_symbology: string;
}

function parseCatalog(csv: string): CatalogRow[] {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const header = lines[0].split(",");
  const col = (name: string) => {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`catalog CSV is missing column ${name}`);
    return i;
  };
  const idx = {
    sku: col("sku"),
    upc_gtin12: col("upc_gtin12"),
    upc_upce8: col("upc_upce8"),
    upc_raw: col("upc_raw"),
    upc_symbology: col("upc_symbology"),
  };
  return lines.slice(1).map((line) => {
    const cells = line.split(",");
    return {
      sku: cells[idx.sku],
      upc_gtin12: cells[idx.upc_gtin12] ?? "",
      upc_upce8: cells[idx.upc_upce8] ?? "",
      upc_raw: cells[idx.upc_raw] ?? "",
      upc_symbology: cells[idx.upc_symbology] ?? "",
    };
  });
}

const catalog = parseCatalog(catalogCsv);
const withUpc = catalog.filter((r) => r.upc_gtin12);

describe("upcaCheckDigit", () => {
  it("computes the UPC-A check digit", () => {
    expect(upcaCheckDigit("03600029145")).toBe(2); // 036000291452
    expect(upcaCheckDigit("13833200005")).toBe(1); // 138332000051
    expect(upcaCheckDigit("00000000000")).toBe(0);
  });

  it("rejects anything but 11 digits", () => {
    expect(() => upcaCheckDigit("123")).toThrow();
  });
});

describe("expandUpcE", () => {
  it("expands each last-digit family", () => {
    // d6 0-2: NS d1 d2 d6 0000 d3 d4 d5
    expect(expandUpcE(1, "924350")).toBe("192000004352");
    expect(expandUpcE(0, "425261")).toBe("042100005264");
    // d6 3: NS d1 d2 d3 00000 d4 d5
    expect(expandUpcE(0, "123453")).toBe("012300000451");
    // d6 4: NS d1 d2 d3 d4 00000 d5
    expect(expandUpcE(0, "123454")).toBe("012340000053");
    // d6 5-9: NS d1 d2 d3 d4 d5 0000 d6
    expect(expandUpcE(1, "383325")).toBe("138332000051");
  });
});

describe("gtinCandidates", () => {
  it("expands 10-Filters from its raw and UPC-E forms", () => {
    expect(gtinCandidates("1383325")).toEqual(["138332000051"]);
    expect(gtinCandidates("13833251")).toEqual(["138332000051", "13833251"]);
    expect(gtinCandidates("138332000051")).toEqual(["138332000051"]);
  });

  it("strips non-digits before branching", () => {
    expect(gtinCandidates(" 1-383325 ")).toEqual(["138332000051"]);
  });

  it("drops the leading 0 of a UPC-A read as EAN-13", () => {
    expect(gtinCandidates("0138332000051")).toEqual(["138332000051"]);
    expect(gtinCandidates("4006381333931")).toEqual(["4006381333931"]);
  });

  it("returns the 12 as scanned plus the corrected code when the check digit is wrong", () => {
    expect(gtinCandidates("138332000059")).toEqual(["138332000059", "138332000051"]);
  });

  it("appends the check digit to 11 digits", () => {
    expect(gtinCandidates("13833200005")).toEqual(["138332000051"]);
  });

  it("treats an 8-digit code outside number system 0/1 as EAN-8", () => {
    expect(gtinCandidates("96385074")).toEqual(["96385074"]);
  });

  it("reads 6 digits as a UPC-E body under number system 0", () => {
    expect(gtinCandidates("383325")).toEqual([expandUpcE(0, "383325")]);
  });

  it("returns nothing for other lengths", () => {
    expect(gtinCandidates("")).toEqual([]);
    expect(gtinCandidates("12345")).toEqual([]);
    expect(gtinCandidates("BW20")).toEqual([]);
  });

  it("covers the catalog fixture", () => {
    // 86 SKUs carry a UPC today (design §3.10 exit criterion).
    expect(withUpc.length).toBe(86);
  });

  it.each(withUpc.map((r) => [r.sku, r] as const))(
    "%s resolves from every catalog form",
    (_sku, row) => {
      expect(gtinCandidates(row.upc_raw)).toContain(row.upc_gtin12);
      expect(gtinCandidates(row.upc_upce8 || row.upc_gtin12)).toContain(row.upc_gtin12);
    },
  );
});
