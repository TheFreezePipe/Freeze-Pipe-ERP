/**
 * Layout editor draft (design §9.3 LayoutEditor). Pure: the editor keeps a
 * local copy of the layout rows, edits it here, and Save sends
 * buildLayoutPayload(base, draft) as ONE rpc_wh_save_layout payload
 * (contract: comment block "G." of 20261022000001_wh_layout.sql):
 *   - existing rows go by id with the row_version they were loaded with, so
 *     a row someone else saved meanwhile comes back as a "stale" problem;
 *   - new racks go by code (template_code), their faces by rack_code, new
 *     fixtures by name; a removed fixture is {id, row_version, _delete};
 *   - the RPC cannot delete racks or faces: a removed rack is saved as
 *     active = false (its bay-levels deactivate on the next generator run,
 *     which refuses any that still hold stock), and only unsaved faces can
 *     be removed.
 */
import type { Database } from "@/lib/database.types";
import {
  fixtureRect,
  locationCode,
  rackLength,
  rackRect,
  rectCenter,
  rotateRackCw,
  snapMm,
  templateFor,
  type Point,
} from "./map-geometry";

type Tables = Database["public"]["Tables"];
export type TemplateRow = Tables["wh_rack_templates"]["Row"];
export type RackRow = Tables["wh_racks"]["Row"];
export type FaceRow = Tables["wh_rack_faces"]["Row"];
export type FixtureRow = Tables["wh_fixtures"]["Row"];
export type DraftFixture = FixtureRow & { _deleted?: boolean };

export interface DraftLayout {
  templates: TemplateRow[];
  racks: RackRow[];
  faces: FaceRow[];
  fixtures: DraftFixture[];
}

export type DraftTarget = { type: "rack" | "fixture"; id: string };

export const FIXTURE_KINDS = ["door", "pack_station", "desk", "staging", "obstacle", "other"] as const;
export type FixtureKind = (typeof FIXTURE_KINDS)[number];

export const FIXTURE_LABELS: Record<FixtureKind, string> = {
  door: "Door",
  pack_station: "Pack station",
  desk: "Desk",
  staging: "Staging area",
  obstacle: "Obstacle",
  other: "Other",
};

/** Default footprint (width along X, depth along Y) per fixture kind, mm. */
export const FIXTURE_SIZES: Record<FixtureKind, { w: number; d: number }> = {
  door: { w: 2400, d: 250 },
  pack_station: { w: 1800, d: 900 },
  desk: { w: 1500, d: 750 },
  staging: { w: 1200, d: 1000 },
  obstacle: { w: 1000, d: 1000 },
  other: { w: 800, d: 800 },
};

export const FACE_SIDES = ["north", "south", "east", "west", "both"] as const;
export const WALK_DIRS = ["N", "S", "E", "W"] as const;
export const RACK_ZONES = ["RTS", "RAW", "BOX", "WIP", "ACC", "MISC"] as const;

const NEW = "new:";
let seq = 0;

export function isNewId(id: string): boolean {
  return id.startsWith(NEW);
}

export function newId(): string {
  const rand = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${++seq}`;
  return `${NEW}${rand}`;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** R01…: one past the highest numbered rack code. */
export function nextRackCode(racks: Pick<RackRow, "code">[]): string {
  let max = 0;
  for (const r of racks) {
    const m = /^R(\d+)$/i.exec(r.code);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `R${pad2(max + 1)}`;
}

/** 01…99: one past the highest face code (faces are site-wide codes). */
export function nextFaceCode(faces: Pick<FaceRow, "face_code">[]): string {
  let max = 0;
  for (const f of faces) {
    const n = Number(f.face_code);
    if (Number.isInteger(n)) max = Math.max(max, n);
  }
  return pad2(Math.min(99, max + 1));
}

export function uniqueFixtureName(base: string, fixtures: Pick<FixtureRow, "name">[]): string {
  const taken = new Set(fixtures.map((f) => f.name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; i < 1000; i++) {
    const name = `${base} ${i}`;
    if (!taken.has(name.toLowerCase())) return name;
  }
  return `${base} ${Date.now()}`;
}

function blankRow() {
  return { created_at: "", updated_at: "", row_version: 0 };
}

function defaultPickable(levels: number, overflowTop: boolean): number[] {
  const top = overflowTop && levels > 1 ? levels - 1 : levels;
  return [1, 2].filter((l) => l <= top);
}

/** A new rack from a template, centred on `at` (snapped), with one routed-later face. */
export function rackFromTemplate(tpl: TemplateRow, at: Point, draft: DraftLayout): { rack: RackRow; face: FaceRow } {
  const width = tpl.bays * tpl.bay_width_mm;
  const id = newId();
  const rack: RackRow = {
    ...blankRow(),
    id,
    code: nextRackCode(draft.racks),
    site_location_id: draft.racks[0]?.site_location_id ?? "",
    template_id: tpl.id,
    description: null,
    x_mm: snapMm(at.x - width / 2),
    y_mm: snapMm(at.y - tpl.depth_mm / 2),
    rot_deg: 0,
    bays: tpl.bays,
    levels: tpl.levels,
    width_mm: width,
    depth_mm: tpl.depth_mm,
    active: true,
  };
  const zone = tpl.kind === "end_cap" ? "ACC" : "RTS";
  const face: FaceRow = {
    ...blankRow(),
    id: newId(),
    rack_id: id,
    face_code: nextFaceCode(draft.faces),
    side: "south",
    aisle: null,
    walk_pass: 99,
    walk_dir: "E",
    first_bay_no: 1,
    zone_by_bay: Array.from({ length: tpl.bays }, () => zone),
    pickable_levels: defaultPickable(tpl.levels, tpl.overflow_top_level),
  };
  return { rack, face };
}

/** A new fixture of a kind, centred on `at` (snapped). */
export function fixtureOfKind(kind: FixtureKind, at: Point, draft: DraftLayout): DraftFixture {
  const { w, d } = FIXTURE_SIZES[kind];
  return {
    ...blankRow(),
    id: newId(),
    name: uniqueFixtureName(FIXTURE_LABELS[kind], draft.fixtures),
    kind,
    x_mm: snapMm(at.x - w / 2),
    y_mm: snapMm(at.y - d / 2),
    width_mm: w,
    depth_mm: d,
    rot_deg: 0,
    zone: kind === "pack_station" ? "PACK" : null,
    location_id: null,
    blocked: false,
  };
}

function resizeZones(zones: string[] | null, bays: number): string[] {
  const src = zones && zones.length ? zones : ["MISC"];
  return Array.from({ length: bays }, (_, i) => src[i] ?? src[src.length - 1]);
}

export type RackPatch = Partial<Pick<RackRow, "code" | "description" | "template_id" | "bays" | "levels" | "x_mm" | "y_mm" | "rot_deg" | "width_mm" | "depth_mm" | "active">>;

/**
 * Change a rack. Bays keep the bay width (width_mm scales) and resize the
 * faces' zone lists; a template change takes the template's levels, depth
 * and bay width; fewer levels drop pickable levels above the top.
 */
export function patchRack(draft: DraftLayout, id: string, patch: RackPatch): DraftLayout {
  const rack = draft.racks.find((r) => r.id === id);
  if (!rack) return draft;
  let next: RackRow = { ...rack, ...patch };
  if (patch.template_id !== undefined && patch.template_id !== rack.template_id) {
    const tpl = draft.templates.find((t) => t.id === patch.template_id);
    if (tpl) {
      next = { ...next, levels: patch.levels ?? tpl.levels, depth_mm: tpl.depth_mm, width_mm: next.bays * tpl.bay_width_mm };
    }
  }
  if (patch.bays !== undefined && patch.bays !== rack.bays && patch.width_mm === undefined) {
    const bayW = rackLength(rack, templateFor(rack, draft.templates)) / rack.bays;
    next = { ...next, width_mm: Math.round(bayW * next.bays) };
  }
  const faces = draft.faces.map((f) => {
    if (f.rack_id !== id) return f;
    let face = f;
    if (next.bays !== rack.bays) face = { ...face, zone_by_bay: resizeZones(face.zone_by_bay, next.bays) };
    if (next.levels !== rack.levels) face = { ...face, pickable_levels: face.pickable_levels.filter((l) => l <= next.levels) };
    return face;
  });
  return { ...draft, racks: draft.racks.map((r) => (r.id === id ? next : r)), faces };
}

export type FacePatch = Partial<Pick<FaceRow, "face_code" | "side" | "aisle" | "walk_pass" | "walk_dir" | "first_bay_no" | "zone_by_bay" | "pickable_levels">>;

export function patchFace(draft: DraftLayout, id: string, patch: FacePatch): DraftLayout {
  return { ...draft, faces: draft.faces.map((f) => (f.id === id ? { ...f, ...patch } : f)) };
}

export type FixturePatch = Partial<Pick<FixtureRow, "name" | "kind" | "zone" | "blocked" | "location_id" | "x_mm" | "y_mm" | "width_mm" | "depth_mm" | "rot_deg">>;

export function patchFixture(draft: DraftLayout, id: string, patch: FixturePatch): DraftLayout {
  return { ...draft, fixtures: draft.fixtures.map((f) => (f.id === id ? { ...f, ...patch } : f)) };
}

export function moveItem(draft: DraftLayout, t: DraftTarget, x: number, y: number): DraftLayout {
  if (t.type === "rack") {
    const r = draft.racks.find((x0) => x0.id === t.id);
    if (!r || (r.x_mm === x && r.y_mm === y)) return draft;
    return patchRack(draft, t.id, { x_mm: x, y_mm: y });
  }
  const f = draft.fixtures.find((x0) => x0.id === t.id);
  if (!f || (f.x_mm === x && f.y_mm === y)) return draft;
  return patchFixture(draft, t.id, { x_mm: x, y_mm: y });
}

/** Turn 90° clockwise about the centre; a rack's faces turn with it. */
export function rotateItem(draft: DraftLayout, t: DraftTarget): DraftLayout {
  if (t.type === "rack") {
    const rack = draft.racks.find((r) => r.id === t.id);
    if (!rack) return draft;
    const turned = rotateRackCw(rack, draft.faces, templateFor(rack, draft.templates));
    return { ...draft, racks: draft.racks.map((r) => (r.id === t.id ? turned.rack : r)), faces: turned.faces };
  }
  const f = draft.fixtures.find((x) => x.id === t.id);
  if (!f) return draft;
  const before = fixtureRect(f);
  const c = rectCenter(before);
  return patchFixture(draft, t.id, {
    rot_deg: (f.rot_deg + 90) % 360,
    x_mm: snapMm(c.x - before.h / 2),
    y_mm: snapMm(c.y - before.w / 2),
  });
}

/** Copy a rack (new code, new face codes) or a fixture, 500 mm along. */
export function duplicateItem(draft: DraftLayout, t: DraftTarget): { draft: DraftLayout; target: DraftTarget | null } {
  if (t.type === "rack") {
    const rack = draft.racks.find((r) => r.id === t.id);
    if (!rack) return { draft, target: null };
    const box = rackRect(rack, templateFor(rack, draft.templates));
    const id = newId();
    const copy: RackRow = {
      ...rack,
      ...blankRow(),
      id,
      code: nextRackCode(draft.racks),
      x_mm: snapMm(box.x + (box.w <= box.h ? box.w + 500 : 0)),
      y_mm: snapMm(box.y + (box.w > box.h ? box.h + 500 : 0)),
    };
    let faces = draft.faces;
    for (const f of draft.faces.filter((x) => x.rack_id === rack.id)) {
      faces = [...faces, { ...f, ...blankRow(), id: newId(), rack_id: id, face_code: nextFaceCode(faces), first_bay_no: 1 }];
    }
    return { draft: { ...draft, racks: [...draft.racks, copy], faces }, target: { type: "rack", id } };
  }
  const f = draft.fixtures.find((x) => x.id === t.id);
  if (!f) return { draft, target: null };
  const copy: DraftFixture = {
    ...f,
    ...blankRow(),
    id: newId(),
    _deleted: false,
    name: uniqueFixtureName(`${f.name} copy`, draft.fixtures),
    x_mm: f.x_mm + 500,
    y_mm: f.y_mm + 500,
    location_id: null,
  };
  return { draft: { ...draft, fixtures: [...draft.fixtures, copy] }, target: { type: "fixture", id: copy.id } };
}

/**
 * Remove a rack or fixture. Unsaved ones vanish; a saved fixture is marked
 * for _delete; a saved rack is deactivated (callers check it holds no stock).
 */
export function removeItem(draft: DraftLayout, t: DraftTarget): DraftLayout {
  if (t.type === "rack") {
    if (isNewId(t.id)) {
      return { ...draft, racks: draft.racks.filter((r) => r.id !== t.id), faces: draft.faces.filter((f) => f.rack_id !== t.id) };
    }
    return patchRack(draft, t.id, { active: false });
  }
  if (isNewId(t.id)) return { ...draft, fixtures: draft.fixtures.filter((f) => f.id !== t.id) };
  return { ...draft, fixtures: draft.fixtures.map((f) => (f.id === t.id ? { ...f, _deleted: true } : f)) };
}

/** Another face on a rack: the opposite side of its first face, same pass and direction. */
export function addFace(draft: DraftLayout, rackId: string): DraftLayout {
  const rack = draft.racks.find((r) => r.id === rackId);
  if (!rack) return draft;
  const sibling = draft.faces.find((f) => f.rack_id === rackId);
  const opposite: Record<string, string> = { north: "south", south: "north", east: "west", west: "east" };
  const face: FaceRow = {
    ...blankRow(),
    id: newId(),
    rack_id: rackId,
    face_code: nextFaceCode(draft.faces),
    side: sibling?.side ? (opposite[sibling.side] ?? "both") : rack.rot_deg === 90 || rack.rot_deg === 270 ? "east" : "south",
    aisle: null,
    walk_pass: sibling?.walk_pass ?? 99,
    walk_dir: sibling?.walk_dir ?? null,
    first_bay_no: 1,
    zone_by_bay: resizeZones(sibling?.zone_by_bay ?? ["RTS"], rack.bays),
    pickable_levels: sibling?.pickable_levels ?? [1, 2].filter((l) => l <= rack.levels),
  };
  return { ...draft, faces: [...draft.faces, face] };
}

/** Only unsaved faces can go (the RPC has no face delete). */
export function removeFace(draft: DraftLayout, faceId: string): DraftLayout {
  if (!isNewId(faceId)) return draft;
  return { ...draft, faces: draft.faces.filter((f) => f.id !== faceId) };
}

// ---- payload ----------------------------------------------------------------------

const RACK_FIELDS = ["code", "description", "template_id", "x_mm", "y_mm", "rot_deg", "bays", "levels", "width_mm", "depth_mm", "active"] as const;
const FACE_FIELDS = ["rack_id", "face_code", "side", "aisle", "walk_pass", "walk_dir", "first_bay_no", "zone_by_bay", "pickable_levels"] as const;
const FIXTURE_FIELDS = ["name", "kind", "x_mm", "y_mm", "width_mm", "depth_mm", "rot_deg", "zone", "blocked", "location_id"] as const;

function changed<T extends object>(a: T, b: T, fields: readonly (keyof T)[]): (keyof T)[] {
  return fields.filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
}

function pick<T extends object>(row: T, fields: readonly (keyof T)[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of fields) out[k as string] = row[k];
  return out;
}

export interface LayoutPayloadDiff {
  payload: { racks: Record<string, unknown>[]; faces: Record<string, unknown>[]; fixtures: Record<string, unknown>[] };
  /** Rows the payload touches. */
  count: number;
}

/** The rows that differ between the loaded layout and the draft, as one rpc_wh_save_layout payload. */
export function buildLayoutPayload(base: DraftLayout, draft: DraftLayout): LayoutPayloadDiff {
  const racks: Record<string, unknown>[] = [];
  const faces: Record<string, unknown>[] = [];
  const fixtures: Record<string, unknown>[] = [];
  const baseRacks = new Map(base.racks.map((r) => [r.id, r]));
  const baseFaces = new Map(base.faces.map((f) => [f.id, f]));
  const baseFixtures = new Map(base.fixtures.map((f) => [f.id, f]));
  const tplCode = (id: string | null) => draft.templates.find((t) => t.id === id)?.code;

  for (const r of draft.racks) {
    const was = baseRacks.get(r.id);
    if (!was) {
      const row = pick(r, RACK_FIELDS.filter((k) => k !== "template_id"));
      const code = tplCode(r.template_id);
      if (code) row.template_code = code;
      racks.push(row);
      continue;
    }
    const diff = changed(was, r, RACK_FIELDS);
    if (diff.length) racks.push({ id: r.id, row_version: r.row_version, ...pick(r, diff) });
  }

  for (const f of draft.faces) {
    const was = baseFaces.get(f.id);
    const rack = draft.racks.find((r) => r.id === f.rack_id);
    if (!was) {
      const row = pick(f, FACE_FIELDS.filter((k) => k !== "rack_id"));
      if (rack && isNewId(rack.id)) row.rack_code = rack.code;
      else row.rack_id = f.rack_id;
      faces.push(row);
      continue;
    }
    const diff = changed(was, f, FACE_FIELDS);
    if (diff.length) faces.push({ id: f.id, row_version: f.row_version, ...pick(f, diff) });
  }

  for (const f of draft.fixtures) {
    const was = baseFixtures.get(f.id);
    if (f._deleted) {
      if (was) fixtures.push({ id: f.id, row_version: f.row_version, _delete: true });
      continue;
    }
    if (!was) {
      fixtures.push(pick(f, FIXTURE_FIELDS));
      continue;
    }
    const diff = changed(was, f, FIXTURE_FIELDS);
    if (diff.length) fixtures.push({ id: f.id, row_version: f.row_version, ...pick(f, diff) });
  }

  return { payload: { racks, faces, fixtures }, count: racks.length + faces.length + fixtures.length };
}

/** Problems the RPC would refuse, caught before Save. */
export function validateDraft(draft: DraftLayout): string[] {
  const issues: string[] = [];
  const active = draft.racks.filter((r) => r.active);
  const codes = new Map<string, number>();
  for (const r of draft.racks) codes.set(r.code, (codes.get(r.code) ?? 0) + 1);
  for (const [code, n] of codes) if (n > 1) issues.push(`Rack code ${code} is used ${n} times.`);
  for (const r of draft.racks) {
    if (!/^[A-Z0-9][A-Z0-9-]{0,15}$/.test(r.code)) issues.push(`Rack code "${r.code}" must be capitals, digits or dashes (R10).`);
    if (!(r.bays >= 1 && r.bays <= 99)) issues.push(`${r.code}: bays must be 1 to 99.`);
    if (!(r.levels >= 1 && r.levels <= 9)) issues.push(`${r.code}: levels must be 1 to 9.`);
  }
  for (const f of draft.faces) {
    const rack = draft.racks.find((r) => r.id === f.rack_id);
    if (!/^\d{2}$/.test(f.face_code)) issues.push(`Face "${f.face_code}" on ${rack?.code ?? "?"} must be two digits.`);
    if (draft.faces.some((g) => g !== f && g.rack_id === f.rack_id && g.face_code === f.face_code)) {
      issues.push(`${rack?.code ?? "?"} has face ${f.face_code} twice.`);
    }
    if (!(f.walk_pass >= 0 && f.walk_pass <= 99)) issues.push(`Face ${f.face_code}: walk pass must be 0 to 99.`);
    if (!(f.first_bay_no >= 1 && f.first_bay_no <= 99)) issues.push(`Face ${f.face_code}: first bay must be 1 to 99.`);
  }
  // Two faces with one code on active racks must not reuse a bay number.
  const seen = new Map<string, string>();
  for (const f of draft.faces) {
    const rack = active.find((r) => r.id === f.rack_id);
    if (!rack) continue;
    for (let k = 0; k < rack.bays; k++) {
      const key = `${f.face_code}-${f.first_bay_no + k}`;
      const other = seen.get(key);
      if (other && other !== rack.code) issues.push(`Face ${f.face_code} bay ${pad2(f.first_bay_no + k)} is on both ${other} and ${rack.code}.`);
      seen.set(key, rack.code);
    }
  }
  const names = new Map<string, number>();
  for (const f of draft.fixtures.filter((x) => !x._deleted)) {
    if (!f.name.trim()) issues.push("A fixture has no name.");
    names.set(f.name.toLowerCase(), (names.get(f.name.toLowerCase()) ?? 0) + 1);
  }
  for (const [name, n] of names) if (n > 1 && name) issues.push(`Fixture name "${name}" is used ${n} times.`);
  return [...new Set(issues)];
}

// ---- read helpers ---------------------------------------------------------------------

export interface FaceCodes {
  faceId: string;
  face: string;
  first: string;
  last: string;
  count: number;
}

/** The FF-BB-L codes each face of a rack generates. */
export function rackCodes(draft: DraftLayout, rackId: string): FaceCodes[] {
  const rack = draft.racks.find((r) => r.id === rackId);
  if (!rack) return [];
  return draft.faces
    .filter((f) => f.rack_id === rackId)
    .map((f) => ({
      faceId: f.id,
      face: f.face_code,
      first: locationCode(f.face_code, f.first_bay_no, 1),
      last: locationCode(f.face_code, f.first_bay_no + rack.bays - 1, rack.levels),
      count: rack.bays * rack.levels,
    }));
}

/** What a rack's locations hold, from wh_location_summary rows. */
export function rackStock(
  rows: { rack_id: string | null; units: number | null; cartons: number | null; active: boolean | null }[],
  rackId: string,
): { units: number; cartons: number; locations: number } {
  let units = 0;
  let cartons = 0;
  let locations = 0;
  for (const r of rows) {
    if (r.rack_id !== rackId || r.active === false) continue;
    const u = r.units ?? 0;
    const c = r.cartons ?? 0;
    units += u;
    cartons += c;
    if (u !== 0 || c > 0) locations++;
  }
  return { units, cartons, locations };
}

export interface LinkedGeometry {
  location_id: string;
  x_mm: number;
  y_mm: number;
  width_mm: number;
  depth_mm: number;
}

/**
 * Named locations whose geometry came from a fixture that moved or resized:
 * the location's centre sat on the fixture's centre (the workbook import
 * placed it there), so it follows the fixture.
 */
export function linkedGeometryUpdates(
  base: DraftLayout,
  draft: DraftLayout,
  locations: { id: string | null; x_mm: number | null; y_mm: number | null }[],
): LinkedGeometry[] {
  const out: LinkedGeometry[] = [];
  for (const f of draft.fixtures) {
    if (f._deleted || !f.location_id) continue;
    const was = base.fixtures.find((b) => b.id === f.id);
    if (!was || was.location_id !== f.location_id) continue;
    const before = fixtureRect(was);
    const after = fixtureRect(f);
    if (before.x === after.x && before.y === after.y && before.w === after.w && before.h === after.h) continue;
    const loc = locations.find((l) => l.id === f.location_id);
    if (!loc || loc.x_mm == null || loc.y_mm == null) continue;
    const c0 = rectCenter(before);
    if (Math.abs(c0.x - loc.x_mm) > 2 || Math.abs(c0.y - loc.y_mm) > 2) continue;
    const c1 = rectCenter(after);
    out.push({ location_id: f.location_id, x_mm: Math.round(c1.x), y_mm: Math.round(c1.y), width_mm: after.w, depth_mm: after.h });
  }
  return out;
}
