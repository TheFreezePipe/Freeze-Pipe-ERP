import { describe, it, expect } from "vitest";
import stagingJob from "./__fixtures__/label-job-practice.json";
import {
  barcodeSvg,
  barcodeValue,
  labelModel,
  labelModels,
  labelToZpl,
  locationWords,
  parseLabelPayload,
  toZpl,
  zplEscape,
  type LabelPayload,
} from "./labels";

const locationJob: LabelPayload = {
  kind: "location",
  practice: false,
  size: "3x1",
  labels: [
    { id: "l1", code: "02-01-2", barcode: "%02-01-2", name: null, kind: "bay_level", words: "Face 02 · Bay 01 · Level 2", overflow: false },
    { id: "l2", code: "02-01-3", barcode: "%02-01-3", name: null, kind: "bay_level", words: "Face 02 · Bay 01 · Level 3", overflow: true },
  ],
};

const practiceStation: LabelPayload = {
  kind: "station",
  practice: true,
  size: "3x1",
  labels: [{ id: "s1", code: "ST-MFG-1", barcode: "%ZST-MFG-1", name: "Mfg desk 1", kind: "station", words: "Mfg desk 1", overflow: false }],
};

const rtsJob: LabelPayload = {
  kind: "lpn_rts",
  practice: false,
  size: "4x2",
  labels: [
    {
      id: "c1",
      code: "C-466-007R1",
      barcode: "%C-466-007R1",
      sku: "BW20",
      product_name: "Beaker 20",
      qty: 12,
      bucket: "finished",
      label_stock: "green",
      worker: "Ana",
      finished_at: "2026-10-22T18:05:00Z",
      suggested: "02-01-1",
      from_code: "C-466-007",
    },
  ],
};

describe("label models", () => {
  it("a location label: code, words, OVERFLOW on level 3", () => {
    const [l2, l3] = labelModels(locationJob);
    expect(l2).toMatchObject({ code: "02-01-2", barcode: "%02-01-2", badge: null, lines: ["Face 02 · Bay 01 · Level 2"], size: "3x1" });
    expect(l3.badge).toBe("OVERFLOW");
  });

  it("fills the words from the code when the payload has none", () => {
    expect(locationWords("09-03-1")).toBe("Face 09 · Bay 03 · Level 1");
    const m = labelModel("location", { id: "x", code: "05-04-3", barcode: "%05-04-3" }, false);
    expect(m.lines).toEqual(["Face 05 · Bay 04 · Level 3"]);
  });

  it("a station label shows the station name", () => {
    const [m] = labelModels(practiceStation);
    expect(m).toMatchObject({ code: "ST-MFG-1", lines: ["Mfg desk 1"], practice: true, barcode: "%ZST-MFG-1" });
  });

  it("forces the %Z prefix on a practice job even if a barcode came without it", () => {
    const m = labelModel("location", { id: "x", code: "02-01-2", barcode: "%02-01-2" }, true);
    expect(m.barcode).toBe("%Z02-01-2");
    expect(barcodeValue("IN-01", false)).toBe("%IN-01");
    expect(barcodeValue("IN-01", true)).toBe("%ZIN-01");
  });

  it("an RTS label is green with RTS, the worker, the time and where it goes", () => {
    const [m] = labelModels(rtsJob);
    expect(m.stock).toBe("green");
    expect(m.badge).toBe("RTS");
    expect(m.lines[0]).toBe("BW20 · Beaker 20");
    expect(m.lines[1]).toBe("12 units");
    expect(m.lines[2]).toMatch(/^Ana · Oct 22, 2:05/);
    expect(m.lines[3]).toBe("Put in 02-01-1 · from C-466-007");
  });

  it("a white LPN label: contents, units and bucket, shipment and carton n of N", () => {
    const m = labelModel(
      "lpn",
      { id: "c", code: "C-466-007", barcode: "%C-466-007", sku: null, contents: "MIXED BW20×12 + NB4×6", qty: 18, bucket: "raw", shipment: "466", carton_seq: 7, carton_of: 40, date: "2026-10-22" },
      false,
    );
    expect(m.lines).toEqual(["MIXED BW20×12 + NB4×6", "18 units · RAW", "Shipment 466 · carton 7 of 40", "2026-10-22"]);
    expect(m.size).toBe("4x2");
  });
});

describe("ZPL", () => {
  it("escapes ^, ~ and the hex indicator, and writes non-ASCII as UTF-8 bytes", () => {
    expect(zplEscape("a^b~c_d")).toBe("a_5Eb_7Ec_5Fd");
    expect(zplEscape("Face 02 · Bay 01")).toBe("Face 02 _C2_B7 Bay 01");
    expect(zplEscape("line\nbreak")).toBe("linebreak");
  });

  it("one ^XA … ^XZ block per label, 3×1 at 203 dpi, Code 128 at 3 dots per module", () => {
    const zpl = toZpl(locationJob);
    expect(zpl.match(/\^XA/g)).toHaveLength(2);
    expect(zpl.match(/\^XZ/g)).toHaveLength(2);
    expect(zpl).toContain("^CI28");
    expect(zpl).toContain("^PW609");
    expect(zpl).toContain("^LL203");
    expect(zpl).toMatch(/\^BY3,2,\d+\^BCN,\d+,N,N,N,A\^FH\^FD%02-01-2\^FS/);
    expect(zpl).toContain("^FD02-01-2^FS");
    expect(zpl).toContain("^FDFace 02 _C2_B7 Bay 01 _C2_B7 Level 2^FS");
    expect(zpl.split("^XZ")[1]).toContain("^FR^FH^FDOVERFLOW^FS");
    expect(zpl.split("^XZ")[0]).not.toContain("OVERFLOW");
  });

  it("a practice label carries the PRACTICE · STAGING band and a %Z barcode", () => {
    const zpl = toZpl(practiceStation);
    expect(zpl).toContain("^FDPRACTICE _C2_B7 STAGING^FS");
    expect(zpl).toContain("^FD%ZST-MFG-1^FS");
    expect(zpl).toMatch(/\^FO0,0\^GB609,30,30\^FS/);
  });

  it("a 4×2 RTS label puts RTS in the largest type", () => {
    const zpl = labelToZpl(labelModels(rtsJob)[0]);
    expect(zpl).toContain("^PW812");
    expect(zpl).toContain("^LL406");
    expect(zpl).toMatch(/\^A0N,96,96\^FH\^FDRTS\^FS/);
    expect(zpl).toContain("^FD%C-466-007R1^FS");
    // every text height on the label is below the RTS height
    const heights = [...zpl.matchAll(/\^A0N,(\d+),/g)].map((m) => Number(m[1]));
    expect(Math.max(...heights)).toBe(96);
  });

  it("escapes a caret in free text so it cannot end the field", () => {
    const zpl = labelToZpl(labelModel("lpn", { id: "c", code: "C-1-001", barcode: "%C-1-001", contents: "MIXED A^B×2", qty: 2 }, false));
    expect(zpl).toContain("MIXED A_5EB_C3_972");
    expect(zpl).not.toContain("A^B");
  });
});

describe("parseLabelPayload", () => {
  it("reads a job payload and defaults the size from the kind", () => {
    const p = parseLabelPayload({ kind: "lpn", practice: false, labels: [{ id: "a", code: "C-1-001", barcode: "%C-1-001" }, { junk: 1 }] });
    expect(p.size).toBe("4x2");
    expect(p.labels).toHaveLength(1);
  });

  it("rejects a payload without labels or with an unknown kind", () => {
    expect(() => parseLabelPayload(null)).toThrow();
    expect(() => parseLabelPayload({ kind: "tote", labels: [] })).toThrow(/Unknown label kind/);
  });
});

describe("barcodeSvg", () => {
  it("renders Code 128 as SVG, one viewBox unit per module, sized for 3 dots at 203 dpi", () => {
    const { svg, modules, widthMm } = barcodeSvg("%02-01-2");
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain('preserveAspectRatio="none"');
    // start (11) + 8 characters (11 each) + check (11) + stop (13) = 123 modules
    expect(modules).toBe(123);
    expect(widthMm).toBeCloseTo(123 * (3 / 203) * 25.4, 1);
  });
});

describe("a real staging job (rpc_wh_request_labels in practice mode)", () => {
  it("parses, models and renders the payload the server returns", () => {
    const payload = parseLabelPayload(stagingJob);
    expect(payload).toMatchObject({ kind: "location", practice: true, size: "3x1" });
    const models = labelModels(payload);
    expect(models.map((m) => m.barcode)).toEqual(["%Z02-01-2", "%Z02-01-3", "%ZST-MFG-1"]);
    expect(models.map((m) => m.badge)).toEqual([null, "OVERFLOW", null]);
    expect(models[2].lines).toEqual(["Mfg desk 1"]);
    const zpl = toZpl(payload);
    expect(zpl.match(/\^XA/g)).toHaveLength(3);
    expect(zpl.match(/PRACTICE _C2_B7 STAGING/g)).toHaveLength(3);
  });
});
