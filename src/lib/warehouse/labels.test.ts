import { describe, it, expect } from "vitest";
import stagingJob from "./__fixtures__/label-job-practice.json";
import {
  barcodeSvg,
  barcodeValue,
  codeFontWidth4x6,
  contentInches,
  L4X6,
  LABEL_INCHES,
  labelBarcodeSvg,
  labelCopies,
  labelModel,
  labelModels,
  labelSizeFor,
  labelToZpl,
  LANDSCAPE,
  locationWords,
  moduleDotsFor,
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

// ---- 4×6 carton pair ----------------------------------------------------------

const carton4x6: LabelPayload = {
  kind: "lpn",
  practice: false,
  size: "4x6",
  copies: 2,
  labels: [
    {
      id: "c7",
      code: "C-466-007",
      barcode: "%C-466-007",
      sku: null,
      contents: "MIXED BW20×12 + NB4×6 + GL14×3 + DS9×1 + AB12×2",
      qty: 18,
      bucket: "finished",
      shipment: "466",
      carton_seq: 7,
      carton_of: 40,
      date: "2026-10-22",
    },
  ],
};

const rts4x6Practice: LabelPayload = { ...rtsJob, practice: true, size: "4x6", copies: 2 };

/** A field's ^FD text with the ^FH escapes decoded. */
function fieldText(field: string): string {
  const raw = /\^FD(.*)\^FS$/.exec(field)?.[1] ?? "";
  const bytes: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === "_") {
      bytes.push(parseInt(raw.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(raw.charCodeAt(i));
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

interface FieldBox {
  field: string;
  /** Native dots: x across the 4 in media, y along the 6 in feed. */
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  /** The same box as the reader sees the landscape label (X along the 6 in, Y down the 4 in). */
  X0: number;
  X1: number;
  Y0: number;
  Y1: number;
}

/**
 * Every field's native bounding box, from its ^FO and its size: ^GB width ×
 * height; ^BCR bar height × (modules × ^BY dots); ^A0R font height × (^FB
 * block width, or about 0.55 × width per character without a block).
 */
function fieldBoxes(zpl: string): FieldBox[] {
  return zpl
    .split("\n")
    .filter((f) => f.startsWith("^FO"))
    .map((field) => {
      const fo = /^\^FO(\d+),(\d+)/.exec(field);
      if (!fo) throw new Error(`no ^FO in ${field}`);
      const x0 = Number(fo[1]);
      const y0 = Number(fo[2]);
      let across: number;
      let along: number;
      const gb = /\^GB(\d+),(\d+),/.exec(field);
      const bc = /\^BY(\d+),\d+,\d+\^BCR,(\d+),/.exec(field);
      const font = /\^A0R,(\d+),(\d+)/.exec(field);
      if (gb) {
        across = Number(gb[1]);
        along = Number(gb[2]);
      } else if (bc) {
        across = Number(bc[2]);
        along = barcodeSvg(fieldText(field)).modules * Number(bc[1]);
      } else if (font) {
        across = Number(font[1]);
        const block = /\^FB(\d+),/.exec(field);
        along = block ? Number(block[1]) : Math.ceil(fieldText(field).length * 0.55 * Number(font[2]));
      } else {
        throw new Error(`a field that is not rotated: ${field}`);
      }
      const x1 = x0 + across;
      const y1 = y0 + along;
      return { field, x0, x1, y0, y1, X0: y0, X1: y1, Y0: L4X6.height - x1, Y1: L4X6.height - x0 };
    });
}

describe("4×6 carton labels", () => {
  it("is 4 in of media that reads landscape, 6 wide × 4 tall", () => {
    expect(LABEL_INCHES["4x6"]).toEqual({ width: 4, height: 6 });
    expect(LANDSCAPE["4x6"]).toBe(true);
    expect(LANDSCAPE["4x2"]).toBe(false);
    expect(contentInches("4x6")).toEqual({ width: 6, height: 4 });
    expect(contentInches("4x2")).toEqual({ width: 4, height: 2 });
    expect(L4X6).toMatchObject({ width: 1218, height: 812 });
  });

  it("a lpn payload with size 4x6 makes 4x6 models, two copies each", () => {
    const payload = parseLabelPayload({ ...carton4x6, labels: [...carton4x6.labels, { ...carton4x6.labels[0], id: "c8", code: "C-466-008" }] });
    expect(payload).toMatchObject({ kind: "lpn", size: "4x6", copies: 2 });
    const models = labelModels(payload);
    expect(models).toHaveLength(2);
    for (const m of models) expect(m).toMatchObject({ size: "4x6", copies: 2, stock: "white", badge: null });
    expect(models[0].lines).toEqual(["MIXED BW20×12 + NB4×6 + GL14×3 + DS9×1 + AB12×2", "18 units · FINISHED", "Shipment 466 · carton 7 of 40", "2026-10-22"]);
    expect(labelModels(parseLabelPayload(rts4x6Practice))[0]).toMatchObject({ size: "4x6", copies: 2, stock: "green", badge: "RTS" });
  });

  it("a location or station payload ignores a size it cannot take", () => {
    expect(parseLabelPayload({ ...locationJob, size: "4x6" }).size).toBe("3x1");
    expect(parseLabelPayload({ ...locationJob, size: "9x9" }).size).toBe("3x1");
    expect(labelModels({ ...practiceStation, size: "4x6" })[0].size).toBe("3x1");
    expect(labelSizeFor("lpn_rts", "3x1")).toBe("4x2");
    expect(labelSizeFor("lpn_rts", "4x6")).toBe("4x6");
    expect(labelSizeFor("location", "4x6")).toBe("3x1");
  });

  it("guards copies: a whole number from 1 to 5, else 1", () => {
    expect(parseLabelPayload({ kind: "lpn", labels: [] }).copies).toBe(1);
    expect(labelCopies(2)).toBe(2);
    for (const bad of [0, -1, 2.5, "2", null, Number.NaN]) expect(labelCopies(bad)).toBe(1);
    expect(labelCopies(9)).toBe(5);
    expect(labelModel("lpn", carton4x6.labels[0], false).copies).toBe(1);
  });

  it("ZPL: 812 across, 1218 along, every field rotated, 5 dots per module, ^PQ2 for the pair", () => {
    const zpl = toZpl(carton4x6);
    expect(zpl.match(/\^XA/g)).toHaveLength(1);
    expect(zpl).toContain("^PW812");
    expect(zpl).toContain("^LL1218");
    expect(zpl).toMatch(/\^A0R,150,150\^FH\^FDC-466-007\^FS/);
    expect(zpl).toMatch(/\^BY5,2,260\^BCR,260,N,N,N,A\^FH\^FD%C-466-007\^FS/);
    // the human-readable value under the bars
    expect(zpl).toMatch(/\^A0R,36,36\^FH\^FD%C-466-007\^FS/);
    expect(zpl).not.toMatch(/\^A0N|\^BCN/);
    // the lines step down 70 / 56 / 48 / 48
    expect([...zpl.matchAll(/\^A0R,(\d+),/g)].map((m) => Number(m[1]))).toEqual([150, 70, 56, 48, 48, 36]);
    expect(zpl).toContain("^PQ2\n^XZ");
    expect(zpl).not.toContain("^PQ1");
  });

  it("^PQ1 when the payload asks for one copy (Reprint one), and on the other sizes", () => {
    const one = toZpl(parseLabelPayload({ ...carton4x6, copies: 1 }));
    expect(one).toContain("^PQ1\n^XZ");
    expect(one).not.toContain("^PQ2");
    expect(toZpl(locationJob).match(/\^PQ1\n\^XZ/g)).toHaveLength(2);
    // a 4×2 payload asking for copies prints them too
    expect(toZpl({ ...rtsJob, copies: 3 })).toContain("^PQ3\n^XZ");
  });

  it("a practice 4×6 job carries the band and %Z on the bars and the value", () => {
    const zpl = toZpl(rts4x6Practice);
    expect(zpl).toContain("^FO764,0^GB48,1218,48^FS");
    expect(zpl).toMatch(/\^FB1218,1,0,C\^A0R,32,32\^FR\^FH\^FDPRACTICE _C2_B7 STAGING\^FS/);
    expect(zpl).toMatch(/\^BCR,260,N,N,N,A\^FH\^FD%ZC-466-007R1\^FS/);
    expect(zpl).toMatch(/\^A0R,36,36\^FH\^FD%ZC-466-007R1\^FS/);
    expect(zpl).toMatch(/\^FB400,1,0,R\^A0R,190,190\^FH\^FDRTS\^FS/);
    expect(zpl).toContain("^PQ2");
  });

  it("every rotated field lies inside the label, code top-left, badge top-right, barcode bottom-left", () => {
    for (const payload of [carton4x6, rts4x6Practice, { ...carton4x6, practice: true }, { ...rtsJob, size: "4x6" as const }]) {
      const boxes = fieldBoxes(toZpl(payload));
      for (const b of boxes) {
        expect(b.x0, b.field).toBeGreaterThanOrEqual(0);
        expect(b.y0, b.field).toBeGreaterThanOrEqual(0);
        expect(b.x1, b.field).toBeLessThanOrEqual(812);
        expect(b.y1, b.field).toBeLessThanOrEqual(1218);
      }
      const code = boxes.find((b) => b.field.includes("^A0R,150,"));
      const bars = boxes.find((b) => b.field.includes("^BCR"));
      const human = boxes.find((b) => b.field.includes("^A0R,36,"));
      const lines = boxes.filter((b) => /\^A0R,(70|56|48),/.test(b.field));
      if (!code || !bars || !human) throw new Error("missing a field");
      const band = payload.practice ? L4X6.band : 0;
      // the code at the top-left of the landscape label, below the band on practice
      expect(code.X0).toBe(L4X6.margin);
      expect(code.Y0).toBe(payload.practice ? band + 12 : L4X6.margin);
      // the lines under the code, the barcode under the lines, the value under the barcode
      for (const l of lines) {
        expect(l.X0).toBe(L4X6.margin);
        expect(l.Y0).toBeGreaterThanOrEqual(code.Y1);
        expect(l.Y1).toBeLessThanOrEqual(bars.Y0);
      }
      expect(bars.X0).toBe(L4X6.barX); // the barcode's quiet zone starts further in than the text margin
      expect(bars.Y1).toBeLessThanOrEqual(human.Y0);
      expect(human.Y1).toBe(L4X6.height - L4X6.margin);
      expect(bars.Y1 - bars.Y0).toBe(260);
      if (payload.kind === "lpn_rts") {
        const badge = boxes.find((b) => b.field.includes("^FDRTS^FS"));
        if (!badge) throw new Error("no RTS badge");
        expect(badge.X1).toBe(L4X6.width - L4X6.margin);
        expect(badge.Y0).toBeLessThan(code.Y1);
        expect(badge.Y0).toBeGreaterThanOrEqual(band);
        // the code (at ~0.55 × its width a character) ends clear of where "RTS" starts at the right margin
        expect(code.X1).toBeLessThanOrEqual(badge.X1 - 3 * 0.55 * L4X6.badge - 30);
      }
      if (payload.practice) {
        const fill = boxes.find((b) => b.field.includes("^GB"));
        expect(fill).toMatchObject({ X0: 0, X1: 1218, Y0: 0, Y1: L4X6.band });
      }
    }
  });

  it("keeps the code 150 tall, narrowing it only when it would reach the badge or the margin", () => {
    expect(codeFontWidth4x6("C-466-007", null)).toBe(150);
    expect(codeFontWidth4x6("C-466-007R1", "RTS")).toBe(131);
    expect(codeFontWidth4x6("C-123456-12345R12", null)).toBe(121);
    expect(toZpl({ ...rtsJob, size: "4x6" })).toMatch(/\^A0R,150,131\^FH\^FDC-466-007R1\^FS/);
  });

  it("keeps a long line inside the label by truncating it", () => {
    const zpl = toZpl(carton4x6);
    const first = zpl.split("\n").find((f) => f.includes("^A0R,70,"));
    expect(first && fieldText(first)).toMatch(/…$/);
  });

  it("barcode modules: 5 dots on 4×6, stepping down for a code too long to fit, 3 elsewhere", () => {
    expect(moduleDotsFor("4x6", 178)).toBe(5);
    expect(moduleDotsFor("4x6", 230)).toBe(4);
    expect(moduleDotsFor("4x6", 400)).toBe(3);
    expect(moduleDotsFor("4x2", 178)).toBe(3);
    expect(moduleDotsFor("3x1")).toBe(3);
    const { modules, widthMm } = barcodeSvg("%C-466-007", 5);
    expect(widthMm).toBeCloseTo(modules * (5 / 203) * 25.4, 1);
    expect(barcodeSvg("%C-466-007").widthMm).toBeCloseTo(modules * (3 / 203) * 25.4, 1);
    // the browser path sizes a model's barcode at the module its size prints at
    expect(labelBarcodeSvg({ barcode: "%C-466-007", size: "4x6" }).widthMm).toBe(widthMm);
    expect(labelBarcodeSvg({ barcode: "%C-466-007", size: "4x2" }).widthMm).toBe(barcodeSvg("%C-466-007").widthMm);
  });

  it("leaves the 4×2 and 3×1 blocks as they were", () => {
    const zpl = labelToZpl(labelModels(rtsJob)[0]);
    expect(zpl.startsWith("^XA\n^CI28\n^PW812\n^LL406\n^LH0,0\n")).toBe(true);
    expect(zpl.endsWith("^PQ1\n^XZ")).toBe(true);
    expect(toZpl(locationJob)).not.toMatch(/\^A0R|\^BCR/);
  });
});
