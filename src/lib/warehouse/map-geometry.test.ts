import { describe, expect, it } from "vitest";
import staging from "./__fixtures__/staging-layout.json";
import {
  bayCells,
  bayPoint,
  buildingRect,
  clampViewBox,
  fitViewBox,
  fixtureRect,
  hitTestCell,
  locationCode,
  matchAspect,
  pxToMm,
  rackPolygon,
  rackRect,
  rectContains,
  rotateRackCw,
  snapMm,
  templateFor,
  walkPath,
  zoomViewBox,
  type FaceGeom,
  type LayoutGeom,
  type RackGeom,
} from "./map-geometry";

// Exported once from staging (8 racks, 10 face rows, 36 fixtures, 74 bay-levels).
const layout = staging as unknown as LayoutGeom & {
  locations: {
    id: string;
    code: string;
    kind: string;
    face_id: string | null;
    face: string | null;
    bay: number | null;
    level: number | null;
    x_mm: number | null;
    y_mm: number | null;
    width_mm: number | null;
    depth_mm: number | null;
    pick_sequence: number | null;
  }[];
};
const bayLevels = layout.locations.filter((l) => l.kind === "bay_level");
const cells = bayCells(layout);
const key = (face: string | null, bay: number | null) => `${face}-${String(bay).padStart(2, "0")}`;

describe("staging fixture", () => {
  it("has the layout the brief describes", () => {
    expect(layout.racks).toHaveLength(8);
    expect(layout.faces).toHaveLength(10);
    expect(layout.fixtures).toHaveLength(36);
    expect(bayLevels).toHaveLength(74);
  });
});

describe("bay cells against the generated locations", () => {
  it("one cell per bay of every face row (face 09 spans R08 and R09)", () => {
    const bays = new Set(bayLevels.map((l) => key(l.face, l.bay)));
    expect(new Set(cells.map((c) => c.key))).toEqual(bays);
    expect(cells.filter((c) => c.face === "09").map((c) => `${c.rackCode}:${c.bay}`)).toEqual(["R08:1", "R08:2", "R09:3"]);
  });

  it("every bay-level's x_mm/y_mm falls inside or on its computed cell", () => {
    for (const loc of bayLevels) {
      const cell = cells.find((c) => c.faceId === loc.face_id && c.bay === loc.bay);
      expect(cell, loc.code).toBeDefined();
      expect(rectContains(cell!.rect, { x: loc.x_mm!, y: loc.y_mm! }), `${loc.code} in ${JSON.stringify(cell!.rect)}`).toBe(true);
    }
  });

  it("bayPoint reproduces the generator's x_mm/y_mm exactly", () => {
    for (const loc of bayLevels) {
      const cell = cells.find((c) => c.faceId === loc.face_id && c.bay === loc.bay)!;
      expect(cell.point, loc.code).toEqual({ x: loc.x_mm, y: loc.y_mm });
    }
  });

  it("hit-testing a location's point finds its own bay", () => {
    for (const loc of bayLevels) {
      const hit = hitTestCell(cells, { x: loc.x_mm!, y: loc.y_mm! });
      expect(hit?.key, loc.code).toBe(key(loc.face, loc.bay));
    }
  });

  it("hit-testing open floor finds nothing", () => {
    expect(hitTestCell(cells, { x: 6000, y: 2000 })).toBeNull();
  });

  it("splits a two-faced rack's depth between its faces", () => {
    const r02 = layout.racks.find((r) => r.code === "R02")!;
    const f02 = cells.find((c) => c.key === "02-01")!;
    const f03 = cells.find((c) => c.key === "03-01")!;
    expect(f02.rect.w).toBeCloseTo(r02.depth_mm! / 2);
    expect(f03.rect.x).toBeCloseTo(r02.x_mm + r02.depth_mm! / 2);
    // single-faced R01 keeps its full depth
    expect(cells.find((c) => c.key === "01-01")!.rect.w).toBe(885);
  });

  it("walk direction decides which end is bay 01", () => {
    // face 03 walks north: bay 01 is the south end of R02
    expect(cells.find((c) => c.key === "03-01")!.rect.y).toBeGreaterThan(cells.find((c) => c.key === "03-03")!.rect.y);
    // face 02 walks south: bay 01 is the north end
    expect(cells.find((c) => c.key === "02-01")!.rect.y).toBeLessThan(cells.find((c) => c.key === "02-03")!.rect.y);
  });

  it("cells never overlap", () => {
    for (let i = 0; i < cells.length; i++) {
      for (let j = i + 1; j < cells.length; j++) {
        const a = cells[i].rect;
        const b = cells[j].rect;
        const overlap =
          Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 1 && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 1;
        expect(overlap, `${cells[i].key} / ${cells[j].key}`).toBe(false);
      }
    }
  });

  it("zones come from zone_by_bay", () => {
    expect(cells.find((c) => c.key === "01-03")!.zone).toBe("BOX");
    expect(cells.find((c) => c.key === "05-02")!.zone).toBe("RAW");
    expect(cells.find((c) => c.key === "07-01")!.zone).toBe("ACC");
  });
});

describe("footprints", () => {
  it("vertical racks run their length along Y, horizontal along X", () => {
    const r01 = layout.racks.find((r) => r.code === "R01")!;
    expect(rackRect(r01)).toEqual({ x: 0, y: 14500, w: 885, h: 10972 });
    const r07 = layout.racks.find((r) => r.code === "R07")!;
    expect(rackRect(r07)).toEqual({ x: 3200, y: 15000, w: 1911, h: 177 });
    expect(rackPolygon(r07)).toEqual([
      { x: 3200, y: 15000 },
      { x: 5111, y: 15000 },
      { x: 5111, y: 15177 },
      { x: 3200, y: 15177 },
    ]);
  });

  it("falls back to the template's bay width and depth", () => {
    const rack: RackGeom = { id: "r", code: "R99", template_id: "t", x_mm: 0, y_mm: 0, rot_deg: 0, bays: 3, levels: 3, width_mm: null, depth_mm: null };
    expect(rackRect(rack, { id: "t", bay_width_mm: 1000, depth_mm: 600 })).toEqual({ x: 0, y: 0, w: 3000, h: 600 });
  });

  it("fixtures swap extents when turned", () => {
    expect(fixtureRect({ id: "f", name: "x", kind: "desk", x_mm: 10, y_mm: 20, width_mm: 800, depth_mm: 400, rot_deg: 90 })).toEqual({
      x: 10,
      y: 20,
      w: 400,
      h: 800,
    });
  });

  it("the building outline is about 12.8 m by 25.5 m", () => {
    const b = buildingRect(layout);
    expect(b.x).toBe(0);
    expect(b.y).toBe(0);
    expect(b.w).toBeGreaterThanOrEqual(12_800);
    expect(b.w).toBeLessThanOrEqual(13_000);
    expect(b.h).toBeGreaterThanOrEqual(25_400);
    expect(b.h).toBeLessThanOrEqual(25_600);
  });
});

describe("viewBox", () => {
  const bounds = { x: 0, y: 0, w: 12_800, h: 25_500 };

  it("fit keeps the viewport aspect and contains the bounds", () => {
    const vb = fitViewBox(bounds, 16 / 9);
    expect(vb.w / vb.h).toBeCloseTo(16 / 9);
    expect(vb.x).toBeLessThanOrEqual(0);
    expect(vb.y).toBeLessThanOrEqual(0);
    expect(vb.x + vb.w).toBeGreaterThanOrEqual(12_800);
    expect(vb.y + vb.h).toBeGreaterThanOrEqual(25_500);
  });

  it("zoom keeps the point under the cursor fixed", () => {
    const vb = fitViewBox(bounds, 1);
    const p = { x: 3000, y: 9000 };
    const z = zoomViewBox(vb, 2, p);
    expect(z.w).toBeCloseTo(vb.w / 2);
    expect((p.x - z.x) / z.w).toBeCloseTo((p.x - vb.x) / vb.w);
    expect((p.y - z.y) / z.h).toBeCloseTo((p.y - vb.y) / vb.h);
  });

  it("clamp limits the zoom and keeps the centre on the plan", () => {
    const tiny = clampViewBox({ x: 100, y: 100, w: 100, h: 50 }, bounds, { minW: 1500 });
    expect(tiny.w).toBe(1500);
    expect(tiny.h).toBe(750);
    const far = clampViewBox({ x: 90_000, y: 90_000, w: 5000, h: 5000 }, bounds);
    expect(far.x + far.w / 2).toBe(12_800);
    expect(far.y + far.h / 2).toBe(25_500);
    const huge = clampViewBox({ x: 0, y: 0, w: 1e6, h: 5e5 }, bounds, { maxW: 50_000 });
    expect(huge.w).toBe(50_000);
    expect(huge.h).toBe(25_000);
  });

  it("keeps centre and width when the viewport aspect changes", () => {
    const m = matchAspect({ x: 0, y: 0, w: 1000, h: 1000 }, 2);
    expect(m).toEqual({ x: 0, y: 250, w: 1000, h: 500 });
  });

  it("maps pixels to millimetres linearly", () => {
    const vb = { x: -500, y: 1000, w: 10_000, h: 5000 };
    expect(pxToMm(vb, { width: 1000, height: 500 }, { x: 500, y: 250 })).toEqual({ x: 4500, y: 3500 });
  });
});

describe("editor helpers", () => {
  it("snaps to 100 mm", () => {
    expect(snapMm(1249)).toBe(1200);
    expect(snapMm(1250)).toBe(1300);
    expect(snapMm(149, 100)).toBe(100);
  });

  it("rotating a rack turns its faces with it and four turns restore it", () => {
    const r02 = layout.racks.find((r) => r.code === "R02")! as RackGeom;
    const faces = layout.faces.filter((f) => f.rack_id === r02.id) as FaceGeom[];
    const tpl = templateFor(r02, layout.templates);
    const once = rotateRackCw(r02, faces, tpl);
    expect(once.rack.rot_deg).toBe(180);
    expect(once.faces.map((f) => [f.face_code, f.side, f.walk_dir])).toEqual([
      ["02", "north", "W"],
      ["03", "south", "E"],
    ]);
    // bay 01 of face 02 was the north end; turned clockwise it is the east end
    const k0 = bayPoint(once.rack, tpl, once.faces[0], 0);
    const k2 = bayPoint(once.rack, tpl, once.faces[0], 2);
    expect(k0.x).toBeGreaterThan(k2.x);
    let r = { rack: r02, faces };
    for (let i = 0; i < 4; i++) r = rotateRackCw(r.rack, r.faces, tpl);
    expect(r.rack.rot_deg).toBe(r02.rot_deg);
    expect(r.faces.map((f) => [f.side, f.walk_dir])).toEqual(faces.map((f) => [f.side, f.walk_dir]));
    expect(Math.abs(r.rack.x_mm - r02.x_mm)).toBeLessThanOrEqual(100);
    expect(Math.abs(r.rack.y_mm - r02.y_mm)).toBeLessThanOrEqual(100);
  });

  it("location codes are FF-BB-L", () => {
    expect(locationCode("03", 5, 2)).toBe("03-05-2");
  });

  it("walk path follows pick_sequence and collapses the levels of a bay", () => {
    const path = walkPath(bayLevels);
    expect(path).toHaveLength(new Set(bayLevels.map((l) => key(l.face, l.bay))).size);
    expect(path[0].row.code).toBe("07-01-1");
    // aisle A interleaves faces 01 and 02
    expect(path.slice(2, 6).map((p) => p.row.face)).toEqual(["01", "02", "01", "02"]);
    for (let i = 1; i < path.length; i++) expect(path[i].seq).toBeGreaterThan(path[i - 1].seq);
  });
});
