import { describe, expect, it } from "vitest";
import staging from "./__fixtures__/staging-layout.json";
import {
  addFace,
  buildLayoutPayload,
  duplicateItem,
  fixtureOfKind,
  isNewId,
  linkedGeometryUpdates,
  moveItem,
  nextFaceCode,
  nextRackCode,
  patchFace,
  patchFixture,
  patchRack,
  rackCodes,
  rackFromTemplate,
  rackStock,
  removeFace,
  removeItem,
  rotateItem,
  uniqueFixtureName,
  validateDraft,
  type DraftLayout,
} from "./layout-draft";

// The staging export lacks the bookkeeping columns; give every row a version.
function load(): DraftLayout {
  const s = structuredClone(staging) as unknown as DraftLayout;
  const stamp = <T extends object>(rows: T[]) => rows.map((r) => ({ created_at: "", updated_at: "", row_version: 1, ...r }));
  return {
    templates: stamp(s.templates),
    racks: stamp(s.racks).map((r) => ({ ...r, site_location_id: r.site_location_id ?? "site" })),
    faces: stamp(s.faces),
    fixtures: stamp(s.fixtures),
  } as DraftLayout;
}

const base = load();
const rackId = (code: string, d: DraftLayout = base) => d.racks.find((r) => r.code === code)!.id;
const fixtureId = (name: string, d: DraftLayout = base) => d.fixtures.find((f) => f.name === name)!.id;

describe("codes and names", () => {
  it("numbers new racks and faces past the highest", () => {
    expect(nextRackCode(base.racks)).toBe("R10");
    expect(nextFaceCode(base.faces)).toBe("10");
    expect(uniqueFixtureName("Desk", [{ name: "Desk" }, { name: "Desk 2" }])).toBe("Desk 3");
    expect(uniqueFixtureName("UPS table", base.fixtures)).toBe("UPS table 2");
  });
});

describe("an unchanged draft", () => {
  it("sends nothing", () => {
    expect(buildLayoutPayload(base, load()).count).toBe(0);
    expect(validateDraft(base)).toEqual([]);
  });
});

describe("edits become one save_layout payload", () => {
  it("a moved rack goes by id with its row_version and only the changed fields", () => {
    const d = moveItem(base, { type: "rack", id: rackId("R05") }, 9600, 20700);
    const { payload, count } = buildLayoutPayload(base, d);
    expect(count).toBe(1);
    expect(payload.racks).toEqual([{ id: rackId("R05"), row_version: 1, x_mm: 9600 }]);
  });

  it("a new rack goes by code with its template code, and its face by rack_code", () => {
    const tpl = base.templates.find((t) => t.code === "SH-1L")!;
    const { rack, face } = rackFromTemplate(tpl, { x: 5000, y: 3000 }, base);
    const d = { ...base, racks: [...base.racks, rack], faces: [...base.faces, face] };
    const { payload } = buildLayoutPayload(base, d);
    expect(payload.racks).toHaveLength(1);
    expect(payload.racks[0]).toMatchObject({ code: "R10", template_code: "SH-1L", bays: 2, levels: 1, rot_deg: 0, active: true });
    expect(payload.racks[0]).not.toHaveProperty("id");
    expect(payload.racks[0]).not.toHaveProperty("template_id");
    expect(payload.faces[0]).toMatchObject({ rack_code: "R10", face_code: "10", walk_pass: 99, zone_by_bay: ["RTS", "RTS"], pickable_levels: [1] });
    expect(payload.faces[0]).not.toHaveProperty("rack_id");
    // centred on the drop point, snapped
    expect(rack.x_mm % 100).toBe(0);
    expect(rack.width_mm).toBe(2 * 1248);
  });

  it("a face added to a saved rack goes by rack_id", () => {
    const d = addFace(base, rackId("R01"));
    const { payload } = buildLayoutPayload(base, d);
    expect(payload.faces).toEqual([
      expect.objectContaining({ rack_id: rackId("R01"), face_code: "10", side: "west", walk_pass: 1, walk_dir: "S" }),
    ]);
  });

  it("a removed fixture is a _delete; a removed new fixture never reaches the payload", () => {
    const id = fixtureId("Tray stack");
    const d = removeItem(base, { type: "fixture", id });
    expect(buildLayoutPayload(base, d).payload.fixtures).toEqual([{ id, row_version: 1, _delete: true }]);
    const added = fixtureOfKind("desk", { x: 1000, y: 1000 }, base);
    const d2 = removeItem({ ...base, fixtures: [...base.fixtures, added] }, { type: "fixture", id: added.id });
    expect(buildLayoutPayload(base, d2).count).toBe(0);
  });

  it("a removed saved rack is deactivated, a removed new rack disappears with its faces", () => {
    const d = removeItem(base, { type: "rack", id: rackId("R09") });
    expect(buildLayoutPayload(base, d).payload.racks).toEqual([{ id: rackId("R09"), row_version: 1, active: false }]);
    const { rack, face } = rackFromTemplate(base.templates[0], { x: 0, y: 0 }, base);
    const d2 = removeItem({ ...base, racks: [...base.racks, rack], faces: [...base.faces, face] }, { type: "rack", id: rack.id });
    expect(buildLayoutPayload(base, d2).count).toBe(0);
  });

  it("the blocked flag and a renamed face are field-level patches", () => {
    let d = patchFixture(base, fixtureId("Gaylord overflow position"), { blocked: true });
    const f03 = base.faces.find((f) => f.face_code === "03")!;
    d = patchFace(d, f03.id, { walk_pass: 2 });
    const { payload } = buildLayoutPayload(base, d);
    expect(payload.fixtures).toEqual([{ id: fixtureId("Gaylord overflow position"), row_version: 1, blocked: true }]);
    expect(payload.faces).toEqual([{ id: f03.id, row_version: 1, walk_pass: 2 }]);
  });
});

describe("rack changes", () => {
  it("more bays keep the bay width and grow the zone lists", () => {
    const d = patchRack(base, rackId("R02"), { bays: 4 });
    const r02 = d.racks.find((r) => r.code === "R02")!;
    expect(r02.width_mm).toBe(Math.round((8229 / 3) * 4));
    expect(d.faces.filter((f) => f.rack_id === r02.id).map((f) => f.zone_by_bay)).toEqual([
      ["RTS", "RTS", "RTS", "RTS"],
      ["RTS", "RTS", "RTS", "RTS"],
    ]);
  });

  it("fewer levels drop pickable levels above the top", () => {
    const d = patchRack(base, rackId("R01"), { levels: 1 });
    expect(d.faces.find((f) => f.face_code === "01")!.pickable_levels).toEqual([1]);
  });

  it("a template change takes the template's levels, depth and bay width", () => {
    const sh = base.templates.find((t) => t.code === "SH-1L")!;
    const d = patchRack(base, rackId("R05"), { template_id: sh.id });
    expect(d.racks.find((r) => r.code === "R05")).toMatchObject({ levels: 1, depth_mm: 531, width_mm: 1248 });
  });

  it("rotating turns the rack and its faces; four turns change nothing", () => {
    const t = { type: "rack" as const, id: rackId("R03") };
    const once = rotateItem(base, t);
    expect(once.racks.find((r) => r.id === t.id)!.rot_deg).toBe(180);
    let d = base;
    for (let i = 0; i < 4; i++) d = rotateItem(d, t);
    const { payload } = buildLayoutPayload(base, d);
    expect(payload.faces).toEqual([]);
    expect(payload.racks.every((r) => !("rot_deg" in r))).toBe(true);
  });

  it("a fixture turns about its centre", () => {
    const id = fixtureId("UPS table");
    const d = rotateItem(base, { type: "fixture", id });
    expect(d.fixtures.find((f) => f.id === id)).toMatchObject({ rot_deg: 90 });
  });

  it("duplicating a rack copies its faces under new codes beside it", () => {
    const { draft, target } = duplicateItem(base, { type: "rack", id: rackId("R02") });
    const copy = draft.racks.find((r) => r.id === target!.id)!;
    expect(copy.code).toBe("R10");
    expect(isNewId(copy.id)).toBe(true);
    expect(copy.x_mm).toBeGreaterThan(3200 + 1911);
    expect(draft.faces.filter((f) => f.rack_id === copy.id).map((f) => f.face_code)).toEqual(["10", "11"]);
    expect(validateDraft(draft)).toEqual([]);
  });

  it("only unsaved faces can be removed", () => {
    const f01 = base.faces.find((f) => f.face_code === "01")!;
    expect(removeFace(base, f01.id)).toBe(base);
    const d = addFace(base, rackId("R01"));
    const added = d.faces.find((f) => isNewId(f.id))!;
    expect(removeFace(d, added.id).faces).toHaveLength(base.faces.length);
  });
});

describe("validation", () => {
  it("catches duplicate rack codes, bad face codes and clashing bays", () => {
    let d = patchRack(base, rackId("R09"), { code: "R08" });
    expect(validateDraft(d)).toContain("Rack code R08 is used 2 times.");
    d = patchFace(base, base.faces.find((f) => f.face_code === "01")!.id, { face_code: "1" });
    expect(validateDraft(d).some((m) => m.includes('Face "1"'))).toBe(true);
    // face 09 continues at bay 3 on R09; starting it at 2 collides with R08's bay 2
    const r09face = base.faces.find((f) => f.rack_id === rackId("R09"))!;
    d = patchFace(base, r09face.id, { first_bay_no: 2 });
    expect(validateDraft(d)).toContain("Face 09 bay 02 is on both R08 and R09.");
  });
});

describe("read helpers", () => {
  it("lists the codes a rack generates", () => {
    expect(rackCodes(base, rackId("R02"))).toEqual([
      expect.objectContaining({ face: "02", first: "02-01-1", last: "02-03-3", count: 9 }),
      expect.objectContaining({ face: "03", first: "03-01-1", last: "03-03-3", count: 9 }),
    ]);
  });

  it("sums a rack's stock", () => {
    const rows = [
      { rack_id: "r", units: 12, cartons: 1, active: true },
      { rack_id: "r", units: 0, cartons: 0, active: true },
      { rack_id: "x", units: 5, cartons: 0, active: true },
    ];
    expect(rackStock(rows, "r")).toEqual({ units: 12, cartons: 1, locations: 1 });
  });

  it("a moved primary fixture carries its named location; a secondary one does not", () => {
    const av = base.fixtures.find((f) => f.name === "AV cart S1")!;
    const box = base.fixtures.find((f) => f.name === "Pack station S1 box stock")!;
    const locs = [{ id: av.location_id, x_mm: 2389, y_mm: 4106 }];
    let d = moveItem(base, { type: "fixture", id: av.id }, av.x_mm + 100, av.y_mm);
    d = moveItem(d, { type: "fixture", id: box.id }, box.x_mm + 100, box.y_mm);
    expect(linkedGeometryUpdates(base, d, locs)).toEqual([
      { location_id: av.location_id, x_mm: 2389 + 100, y_mm: 4106, width_mm: 708, depth_mm: 566 },
    ]);
  });
});
