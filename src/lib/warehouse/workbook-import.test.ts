import { describe, it, expect } from "vitest";
import scaleCsv from "./__fixtures__/scale.csv?raw";
import racksCsv from "./__fixtures__/racks.csv?raw";
import facesCsv from "./__fixtures__/faces.csv?raw";
import fixturesCsv from "./__fixtures__/fixtures.csv?raw";
import locationsCsv from "./__fixtures__/locations.csv?raw";
import pythonTwin from "./__fixtures__/layout-payload.json";
import { parseCsv, rowsToObjects } from "./csv";
import {
  compareWithLocationsTab,
  importWorkbook,
  parsePickableLevels,
  parseWalkDir,
  readScale,
  type ScaleRow,
  type SheetRow,
  type WorkbookTabs,
} from "./workbook-import";

// Fixtures: the workbook's tabs exported with openpyxl, raw values only (formula cells blank).
function sheet(csv: string): SheetRow[] {
  return rowsToObjects(parseCsv(csv));
}

function scaleRows(csv: string): ScaleRow[] {
  return sheet(csv).map((r) => ({ label: r.label, value: r.value }));
}

function tabs(): WorkbookTabs {
  return { scale: scaleRows(scaleCsv), racks: sheet(racksCsv), faces: sheet(facesCsv), fixtures: sheet(fixturesCsv) };
}

const result = importWorkbook(tabs());
const { payload, named, warnings } = result;
const face = (rack: string, code: string) => payload.faces.find((f) => f.rack_code === rack && f.face_code === code);
const rack = (code: string) => payload.racks.find((r) => r.code === code);
const fixture = (name: string) => payload.fixtures.find((f) => f.name === name);

describe("importWorkbook: parity with load_layout.py", () => {
  it("produces exactly the payload and named geometry the Python twin wrote", () => {
    expect(payload).toEqual(pythonTwin.payload);
    expect(named).toEqual(pythonTwin.named);
  });
});

describe("importWorkbook: scale", () => {
  it("computes pixels per foot from the bay length and bay width (the formula cell has no value)", () => {
    expect(result.scale.pxPerFt).toBeCloseTo(155 / 9, 10);
    expect(result.scale.beamHeightsIn).toEqual([0, 54, 108]);
    expect(result.scale.building).toBeNull();
  });

  it("reads the building extents out of the computed rows' formulas when the UI passes them", () => {
    const rows = scaleRows(scaleCsv).map((r) =>
      String(r.label).startsWith("Building inside width, computed")
        ? { ...r, formula: "=(905-180)/B10" }
        : String(r.label).startsWith("Building inside length, computed")
          ? { ...r, formula: "=(1510-72)/B10" }
          : r,
    );
    expect(readScale(rows).building).toEqual({ width_mm: 12831, depth_mm: 25450, source: "drawing" });
  });

  it("prefers the measured building size once typed", () => {
    const rows = scaleRows(scaleCsv).map((r) =>
      String(r.label).startsWith("Building inside width, measured")
        ? { ...r, value: 42 }
        : String(r.label).startsWith("Building inside length, measured")
          ? { ...r, value: 83.5 }
          : r,
    );
    expect(readScale(rows).building).toEqual({ width_mm: 12802, depth_mm: 25451, source: "measured" });
  });

  it("refuses a workbook without a bay width", () => {
    const rows = scaleRows(scaleCsv).filter((r) => !String(r.label).startsWith("Bay width"));
    expect(() => importWorkbook({ ...tabs(), scale: rows })).toThrow(/bay width/);
  });
});

describe("importWorkbook: templates and racks", () => {
  it("derives one template per rack kind and level count", () => {
    expect(payload.templates.map((t) => t.code)).toEqual(["PR-3L", "EC-1L"]);
    const pr = payload.templates[0];
    expect(pr).toMatchObject({
      kind: "pallet_rack",
      levels: 3,
      bay_width_mm: 2743,
      depth_mm: 1067,
      level_heights_mm: [0, 1372, 2743],
      overflow_top_level: true,
    });
    expect(payload.templates[1]).toMatchObject({ kind: "end_cap", levels: 1, overflow_top_level: false });
  });

  it("imports every stock rack with the workbook's codes; R06, R08 and R09 (not stock locations) become fixtures", () => {
    expect(payload.racks.map((r) => r.code)).toEqual(["R01", "R02", "R03", "R04", "R05", "R07"]);
    expect(fixture("UV curing rack")).toMatchObject({ zone: "MFG", location_code: "MFG-LINE", kind: "staging" });
    // the bottom-wall misc shelving never holds labelled stock, so it gets no face, no codes and no labels
    expect(fixture("Bottom-wall shelving, left pair")).toMatchObject({ kind: "other", zone: "MISC", location_code: null, width_mm: 2513 });
    expect(fixture("Bottom-wall shelving, right")).toMatchObject({ kind: "other", zone: "MISC", location_code: null, width_mm: 1239 });
    for (const code of ["R06", "R08", "R09"]) expect(warnings.some((w) => w.includes(code))).toBe(true);
  });

  it("rotates vertical runs 90° and horizontal ones 0°", () => {
    for (const code of ["R01", "R02", "R03", "R04", "R05"]) expect(rack(code)?.rot_deg).toBe(90);
    expect(rack("R07")?.rot_deg).toBe(0);
  });

  it("places the top-left corner from the pixels, origin (180, 72), on the 100 mm grid", () => {
    // R01: x1 180 → 0 ft; y1 892 → 820 px / 17.22 px/ft = 47.6 ft = 14 512 mm → 14 500
    expect(rack("R01")).toMatchObject({ x_mm: 0, y_mm: 14500, width_mm: 4 * 2743, depth_mm: 885 });
    // R03 (y1 340) and R04 (y1 335) are drawn 5 px apart; both land on 4 700, so facing bays tie
    expect(rack("R03")?.y_mm).toBe(4700);
    expect(rack("R04")?.y_mm).toBe(4700);
    // non-pallet racks keep the drawn length along their bays
    expect(rack("R07")).toMatchObject({ width_mm: 1911, depth_mm: 177, template_code: "EC-1L" });
  });
});

describe("importWorkbook: faces", () => {
  it("keeps every face code of the stock racks; the shelving fixtures have none", () => {
    expect([...new Set(payload.faces.map((f) => f.face_code))]).toEqual(["01", "02", "03", "04", "05", "06", "07", "08"]);
    expect(payload.faces.some((f) => f.rack_code === "R08" || f.rack_code === "R09")).toBe(false);
  });

  it("merges consecutive faces that share an aisle and direction into one walk pass", () => {
    const passes = Object.fromEntries(payload.faces.map((f) => [f.face_code, f.walk_pass]));
    expect(passes).toEqual({ "01": 1, "02": 1, "03": 3, "04": 4, "05": 5, "06": 5, "07": 0, "08": 99 });
  });

  it("reads walk direction, side, aisle and pickable levels", () => {
    expect(face("R01", "01")).toMatchObject({ side: "east", aisle: "A", walk_dir: "S", pickable_levels: [1, 2] });
    expect(face("R02", "03")).toMatchObject({ side: "east", aisle: "B", walk_dir: "N" });
    expect(face("R07", "07")).toMatchObject({ side: "north", walk_dir: "E", pickable_levels: [1], zone_by_bay: ["ACC", "ACC"] });
    expect(face("R05", "08")).toMatchObject({ side: "both", walk_dir: null, pickable_levels: [], zone_by_bay: ["WIP"] });
  });

  it("splits zones per side and keeps the north→south order for a face walking south", () => {
    expect(face("R01", "01")?.zone_by_bay).toEqual(["RTS", "RTS", "BOX", "BOX"]);
    expect(face("R03", "04")?.zone_by_bay).toEqual(["RTS", "RTS", "RTS", "RTS"]);
    expect(face("R03", "05")?.zone_by_bay).toEqual(["RAW", "RAW", "RAW", "RAW"]);
    expect(face("R04", "06")?.zone_by_bay).toEqual(["RAW", "RAW", "RAW", "RAW"]);
  });

  it("reverses the north→south zone list for a face walking north, so index 1 is bay 01", () => {
    const t = tabs();
    t.racks = t.racks.map((r) => (r.Rack === "R01" ? { ...r, "Zone by bay (north→south)": "RTS, RTS, BOX, BOX" } : r));
    t.faces = t.faces.map((f) => (f.Face === "01" ? { ...f, "Walk direction": "south → north", "First bay at": "south end" } : f));
    const out = importWorkbook(t);
    expect(out.payload.faces.find((f) => f.face_code === "01")?.zone_by_bay).toEqual(["BOX", "BOX", "RTS", "RTS"]);
  });

  it("warns when the first-bay end contradicts the walk direction", () => {
    const t = tabs();
    t.faces = t.faces.map((f) => (f.Face === "01" ? { ...f, "First bay at": "south end" } : f));
    expect(importWorkbook(t).warnings.some((w) => w.startsWith("Face 01: walks S"))).toBe(true);
  });
});

describe("importWorkbook: fixtures and named locations", () => {
  it("maps the Type column and names to fixture kinds", () => {
    expect(fixture("Dock door L")?.kind).toBe("door");
    expect(fixture("Fill/cap desk 2")?.kind).toBe("desk");
    expect(fixture("Empty/RTS desk 1")?.kind).toBe("desk");
    expect(fixture("AV cart S3")?.kind).toBe("pack_station");
    expect(fixture("UPS table")?.kind).toBe("staging");
    expect(fixture("Gaylord pallet base 1")?.kind).toBe("staging");
    expect(fixture("Sandblast machine")?.kind).toBe("obstacle");
    expect(fixture("AC unit top")?.kind).toBe("obstacle");
    expect(fixture("Tray stack")?.kind).toBe("other");
  });

  it("imports every fixture unblocked (blocked is a peak-season toggle set in the editor)", () => {
    expect(payload.fixtures.filter((f) => f.blocked).map((f) => f.name)).toEqual([]);
  });

  it("links fixtures to the named locations", () => {
    const links = Object.fromEntries(payload.fixtures.filter((f) => f.location_code).map((f) => [f.name, f.location_code]));
    expect(links).toMatchObject({
      "Inbound staging (assumed)": "IN-01",
      "Dock door R": "IN-01",
      "UPS table": "OUT-UPS",
      "Dock door L": "OUT-UPS",
      "Gaylord pallet base 1": "OUT-GAY-1",
      "Gaylord pallet base 2": "OUT-GAY-2",
      "AV cart S1": "ST-S1",
      "AV cart S4": "ST-S4",
      "Fill/cap desk 1": "ST-MFG-1",
      "Fill/cap desk 4": "ST-MFG-4",
      "Blue tote 3 (spares)": "SPARES-01",
      "Cart start (assumed)": "CART-START",
      "UV curing rack": "MFG-LINE",
    });
    expect(fixture("Pack station S2/S3 box stock")?.location_code).toBeNull();
  });

  it("gives each named location the centre and extent of its fixture", () => {
    expect(named.map((n) => n.code)).toEqual([
      "IN-01", "OUT-UPS", "OUT-GAY-1", "OUT-GAY-2", "ST-S1", "ST-S2", "ST-S3", "ST-S4",
      "ST-MFG-1", "ST-MFG-2", "ST-MFG-3", "ST-MFG-4", "SPARES-01", "CART-START", "MFG-LINE",
    ]);
    // IN-01 comes from the inbound staging area (660..875, 82..330 px), not the door strip
    expect(named[0]).toEqual({ code: "IN-01", x_mm: 10398, y_mm: 2372, z_mm: 0, width_mm: 3805, depth_mm: 4389 });
    expect(warnings.some((w) => w.startsWith("Named location ST-DOCK"))).toBe(true);
  });
});

describe("compareWithLocationsTab", () => {
  const locations = sheet(locationsCsv);
  const workbookCodes = locations
    .map((r) => ({ code: String(r.Code), pick_sequence: Number(r["Pick seq"]), zone: String(r.Zone), pickable: r.Pickable === "yes" }))
    .filter((r) => /^\d{2}-\d{2}-\d$/.test(r.code));

  it("finds all 71 bay-levels and the 11 named codes on the tab", () => {
    const cmp = compareWithLocationsTab(workbookCodes, locations);
    expect(cmp.matched).toHaveLength(71);
    expect(cmp.named).toHaveLength(11);
    expect(cmp.onlyInWorkbook).toEqual([]);
    expect(cmp.onlyInGenerator).toEqual([]);
    expect(cmp.sequenceDiffs).toEqual([]);
    expect(cmp.flagDiffs).toEqual([]);
  });

  it("reports missing and extra codes, sequence and flag differences", () => {
    const gen = workbookCodes
      .filter((c) => c.code !== "01-01-1")
      .map((c) => (c.code === "02-01-1" ? { ...c, pick_sequence: 1021 } : c.code === "05-01-1" ? { ...c, zone: "RTS" } : c));
    gen.push({ code: "10-01-1", pick_sequence: 99999, zone: "MISC", pickable: false });
    const cmp = compareWithLocationsTab(gen, locations);
    expect(cmp.onlyInWorkbook).toEqual(["01-01-1"]);
    expect(cmp.onlyInGenerator).toEqual(["10-01-1"]);
    expect(cmp.sequenceDiffs).toEqual([{ code: "02-01-1", workbook: 2011, generator: 1021 }]);
    expect(cmp.flagDiffs).toEqual([{ code: "05-01-1", field: "zone", workbook: "RAW", generator: "RTS" }]);
  });
});

describe("cell parsers", () => {
  it("reads the walk direction as the direction of travel", () => {
    expect(parseWalkDir("north → south")).toBe("S");
    expect(parseWalkDir("south -> north")).toBe("N");
    expect(parseWalkDir("west → east")).toBe("E");
    expect(parseWalkDir("-")).toBeNull();
  });

  it("reads pickable levels from text or a number", () => {
    expect(parsePickableLevels("1,2")).toEqual([1, 2]);
    expect(parsePickableLevels(1)).toEqual([1]);
    expect(parsePickableLevels("-")).toEqual([]);
    expect(parsePickableLevels("2, 1, 2")).toEqual([1, 2]);
  });
});
