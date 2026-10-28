/**
 * Digitizing workbook → layout (design §9.6 steps 1-3, §4.3, §5.3).
 *
 * Pure: takes the workbook's Scale, Racks, Faces and Fixtures tabs already
 * parsed into rows (SheetJS in the UI, CSV in tests) and returns the exact
 * rpc_wh_save_layout payload, the named-location geometry for
 * rpc_wh_save_location, and warnings. The workbook's formula cells carry no
 * cached values, so every foot and millimetre is computed here from the raw
 * pixel columns and the Scale tab.
 *
 * Twin: scripts/refresh-staging/load_layout.py applies the same rules to the
 * .xlsx. Keep the two in step: workbook-import.test.ts compares this module's
 * output with __fixtures__/layout-payload.json, which the script writes
 * (`--write-fixture`).
 *
 * Rules (owner conventions from the workbook README):
 *   - Origin is the drawing's inside top-left corner at pixel (180, 72), the
 *     corner nearest the left dock door; X runs east, Y south; px → ft divides
 *     by Scale's pixels per foot (bay px ÷ bay ft), ft → mm × 304.8, in → mm × 25.4.
 *   - Racks: x_mm/y_mm are the top-left corner of the drawn footprint, snapped
 *     to the layout editor's 100 mm grid so runs drawn a pixel apart line up
 *     (facing bays then tie and keep the workbook's face order, §5.3).
 *     Vertical racks get rot_deg 90 (bays along Y), horizontal 0 (bays along
 *     X), the slice 1 migration's convention. width_mm runs along the bays:
 *     bays × the measured bay width for pallet racks (the Locations tab puts
 *     bay centres at (n − 0.5) × bay width), the drawn length otherwise;
 *     depth_mm is the drawn depth.
 *   - A Racks row with no face codes, or noted "not a stock location" (R06,
 *     the UV curing rack; R08 and R09, the bottom-wall misc shelving, which
 *     never hold labelled stock), is imported as a fixture.
 *   - Templates: one per rack kind and level count (pallet_rack, shelving,
 *     end_cap, floor from the description); pallet racks with 3+ levels have
 *     overflow_top_level (level 3 is overflow, never pickable).
 *   - Faces: one row per rack the face spans. walk_dir is the direction of
 *     travel; zone_by_bay is the Racks
 *     tab's north→south (or west→east) list for the face's side, reversed
 *     when the face walks north (or west), so index 1 is bay 01.
 *     walk_pass is the face's "Walk order of face", except that consecutive
 *     faces sharing an aisle and a walk direction (01+02, 05+06) are one pass
 *     and take the first face's number; 99 means not routed.
 *   - Fixtures: kind from the Type column and the name; named locations get
 *     their geometry (centre point plus extent) from one fixture each.
 */

export type Cell = string | number | boolean | null | undefined;
export type SheetRow = Record<string, Cell>;

/** One Scale row: column A label, column B value; `formula` is B's formula text when the UI has it. */
export interface ScaleRow {
  label: Cell;
  value: Cell;
  formula?: string | null;
}

export interface WorkbookTabs {
  scale: ScaleRow[];
  racks: SheetRow[];
  faces: SheetRow[];
  fixtures: SheetRow[];
}

export type RackKind = "pallet_rack" | "shelving" | "end_cap" | "floor";
export type FixtureKind = "door" | "pack_station" | "desk" | "staging" | "obstacle" | "other";
export type WalkDir = "N" | "S" | "E" | "W";

export interface TemplatePayload {
  code: string;
  name: string;
  kind: RackKind;
  bays: number;
  levels: number;
  bay_width_mm: number;
  depth_mm: number;
  level_heights_mm: number[];
  overflow_top_level: boolean;
  capacity_cartons_per_level: number | null;
}

export interface RackPayload {
  code: string;
  description: string | null;
  template_code: string;
  x_mm: number;
  y_mm: number;
  rot_deg: 0 | 90;
  bays: number;
  levels: number;
  width_mm: number;
  depth_mm: number;
}

export interface FacePayload {
  rack_code: string;
  face_code: string;
  side: string | null;
  aisle: string | null;
  walk_pass: number;
  walk_dir: WalkDir | null;
  first_bay_no: number;
  zone_by_bay: string[];
  pickable_levels: number[];
}

export interface FixturePayload {
  name: string;
  kind: FixtureKind;
  x_mm: number;
  y_mm: number;
  width_mm: number;
  depth_mm: number;
  rot_deg: 0;
  zone: string | null;
  blocked: boolean;
  location_code: string | null;
}

export interface LayoutPayload {
  templates: TemplatePayload[];
  racks: RackPayload[];
  faces: FacePayload[];
  fixtures: FixturePayload[];
}

/** Geometry for a named location (rpc_wh_save_location): centre point and footprint. */
export interface NamedLocationUpdate {
  code: string;
  x_mm: number;
  y_mm: number;
  z_mm: number;
  width_mm: number;
  depth_mm: number;
}

export interface ScaleInfo {
  bayPx: number;
  bayWidthIn: number;
  rackDepthIn: number;
  /** Beam top per level in inches, index 0 = level 1. */
  beamHeightsIn: number[];
  pxPerFt: number;
  capacityPerLevel: number | null;
  /** Inside extents: the measured rows when typed, else the drawing (the computed rows' formulas). */
  building: { width_mm: number; depth_mm: number; source: "measured" | "drawing" } | null;
}

export interface WorkbookImport {
  payload: LayoutPayload;
  named: NamedLocationUpdate[];
  warnings: string[];
  scale: ScaleInfo;
}

export const ORIGIN_PX = { x: 180, y: 72 } as const;
export const MM_PER_FT = 304.8;
export const MM_PER_IN = 25.4;
export const RACK_SNAP_MM = 100;
export const WH_ZONES = ["RTS", "RAW", "BOX", "WIP", "ACC", "MISC", "IN", "OUT", "MFG", "PACK", "SPARE", "VIRTUAL"];

/** Named locations the workbook places, with the zone a linked fixture inherits. */
const NAMED_ZONES: Record<string, string> = {
  "IN-01": "IN",
  "OUT-UPS": "OUT",
  "OUT-GAY-1": "OUT",
  "OUT-GAY-2": "OUT",
  "ST-S1": "PACK",
  "ST-S2": "PACK",
  "ST-S3": "PACK",
  "ST-S4": "PACK",
  "ST-MFG-1": "MFG",
  "ST-MFG-2": "MFG",
  "ST-MFG-3": "MFG",
  "ST-MFG-4": "MFG",
  "SPARES-01": "SPARE",
  "CART-START": "PACK",
  "MFG-LINE": "MFG",
};

/** Floor locations that hold stock: their fixture is a staging area. */
const STOCK_FLOOR = new Set(["IN-01", "OUT-UPS", "OUT-GAY-1", "OUT-GAY-2", "SPARES-01", "MFG-LINE"]);

/**
 * Fixture name → named location. `primary` supplies the location's geometry;
 * a secondary fixture (the door beside a staging area, a pack bench) is only
 * linked. Pack station Sn's geometry is its AV cart (laptop, printer, cart
 * park point); the S2/S3 bench serves two stations and is not linked.
 */
const NAMED_RULES: { re: RegExp; code: (m: RegExpMatchArray) => string; primary: boolean }[] = [
  { re: /^inbound staging/i, code: () => "IN-01", primary: true },
  { re: /^dock door r\b/i, code: () => "IN-01", primary: false },
  { re: /^ups table/i, code: () => "OUT-UPS", primary: true },
  { re: /^dock door l\b/i, code: () => "OUT-UPS", primary: false },
  { re: /^gaylord pallet base (\d)\b/i, code: (m) => `OUT-GAY-${m[1]}`, primary: true },
  { re: /^av cart s(\d)\b/i, code: (m) => `ST-S${m[1]}`, primary: true },
  { re: /^pack station s(\d) box stock/i, code: (m) => `ST-S${m[1]}`, primary: false },
  { re: /^fill\/cap desk (\d)\b/i, code: (m) => `ST-MFG-${m[1]}`, primary: true },
  { re: /\bspares?\b/i, code: () => "SPARES-01", primary: true },
  { re: /^cart start/i, code: () => "CART-START", primary: true },
  { re: /^(uv curing rack|manufacturing line)/i, code: () => "MFG-LINE", primary: true },
];

/** Named locations with no fixture in the workbook (reported, left without geometry). */
const UNPLACED_NAMED = ["ST-DOCK"];

const TEMPLATE_ABBR: Record<RackKind, string> = { pallet_rack: "PR", shelving: "SH", end_cap: "EC", floor: "FL" };
const TEMPLATE_NAME: Record<RackKind, string> = {
  pallet_rack: "Pallet rack",
  shelving: "Shelving",
  end_cap: "End cap",
  floor: "Floor",
};
const SIDES = ["north", "south", "east", "west", "both"];
const DIRS: Record<string, WalkDir> = { north: "N", south: "S", east: "E", west: "W" };
const FIRST_END: Record<WalkDir, string> = { S: "north", N: "south", E: "west", W: "east" };

// ---- small helpers (mirrored in load_layout.py) -------------------------------

/** Round half up; the Python twin uses math.floor(v + 0.5) so both agree on .5. */
export const rnd = (v: number): number => Math.floor(v + 0.5);
const snap = (v: number, step: number): number => Math.floor(v / step + 0.5) * step;

function norm(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** A row's value under the first header equal to (else starting with) one of `keys`, compared alphanumerically. */
function get(row: SheetRow, ...keys: string[]): Cell {
  const headers = Object.keys(row);
  for (const k of keys) {
    const nk = norm(k);
    const exact = headers.find((h) => norm(h) === nk);
    if (exact !== undefined) return row[exact];
    const prefix = headers.find((h) => norm(h).startsWith(nk));
    if (prefix !== undefined) return row[prefix];
  }
  return undefined;
}

function text(v: Cell): string {
  return v == null ? "" : String(v).trim();
}

function num(v: Cell): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const t = text(v);
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function isDash(t: string): boolean {
  return t === "" || t === "-" || t === "–" || t === "—";
}

function mean(xs: number[]): number {
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/** Most common value; ties go to the larger. */
function mode(xs: number[]): number {
  const counts = new Map<number, number>();
  for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1);
  let best = xs[0];
  let bestN = 0;
  for (const [x, n] of counts) {
    if (n > bestN || (n === bestN && x > best)) {
      best = x;
      bestN = n;
    }
  }
  return best;
}

/** "north → south" → "S" (the direction of travel); a dash → null. */
export function parseWalkDir(value: Cell): WalkDir | null {
  const words = text(value).toLowerCase().match(/north|south|east|west/g);
  if (!words) return null;
  return DIRS[words[words.length - 1]];
}

/** "1,2" → [1, 2]; a dash → []. */
export function parsePickableLevels(value: Cell): number[] {
  const t = text(value);
  if (isDash(t)) return [];
  const out: number[] = [];
  for (const part of t.split(/[^0-9]+/)) {
    if (!part) continue;
    const n = Number(part);
    if (Number.isInteger(n) && n >= 1 && n <= 9 && !out.includes(n)) out.push(n);
  }
  return out.sort((a, b) => a - b);
}

// ---- Scale ------------------------------------------------------------------

const SPAN_RE = /\(\s*(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*\)/;

export function readScale(rows: ScaleRow[]): ScaleInfo {
  let bayPx: number | null = null;
  let bayWidthIn: number | null = null;
  let rackDepthIn: number | null = null;
  let pxPerFtCell: number | null = null;
  let capacity: number | null = null;
  const beams: (number | null)[] = [];
  let measuredW: number | null = null;
  let measuredL: number | null = null;
  let drawnW: number | null = null;
  let drawnL: number | null = null;

  for (const r of rows) {
    const label = text(r.label).toLowerCase();
    if (!label) continue;
    const v = num(r.value);
    const span = r.formula ? SPAN_RE.exec(r.formula) : null;
    const spanPx = span ? Number(span[1]) - Number(span[2]) : null;
    const beam = /level\s*(\d+)\s*beam height/.exec(label);
    if (label.includes("average bay length")) bayPx = v;
    else if (label.includes("bay width")) bayWidthIn = v;
    else if (label.includes("rack depth")) rackDepthIn = v;
    else if (beam) beams[Number(beam[1]) - 1] = v;
    else if (label.includes("pixels per foot")) pxPerFtCell = v;
    else if (label.includes("capacity")) capacity = v;
    else if (label.includes("inside width") && label.includes("measured")) measuredW = v;
    else if (label.includes("inside length") && label.includes("measured")) measuredL = v;
    else if (label.includes("inside width")) drawnW = spanPx;
    else if (label.includes("inside length")) drawnL = spanPx;
  }

  if (bayPx == null || bayPx <= 0) throw new Error("Scale tab: the average bay length on the drawing (px) is missing.");
  if (bayWidthIn == null || bayWidthIn <= 0) throw new Error("Scale tab: the bay width (inches) is missing.");
  if (rackDepthIn == null || rackDepthIn <= 0) throw new Error("Scale tab: the rack depth (inches) is missing.");
  const pxPerFt = pxPerFtCell != null && pxPerFtCell > 0 ? pxPerFtCell : bayPx / (bayWidthIn / 12);
  const beamHeightsIn: number[] = [];
  for (let i = 0; i < beams.length; i++) {
    const b = beams[i];
    if (b == null) break;
    beamHeightsIn.push(b);
  }

  let building: ScaleInfo["building"] = null;
  if (measuredW != null && measuredL != null && measuredW > 0 && measuredL > 0) {
    building = { width_mm: rnd(measuredW * MM_PER_FT), depth_mm: rnd(measuredL * MM_PER_FT), source: "measured" };
  } else if (drawnW != null && drawnL != null && drawnW > 0 && drawnL > 0) {
    building = {
      width_mm: rnd((drawnW / pxPerFt) * MM_PER_FT),
      depth_mm: rnd((drawnL / pxPerFt) * MM_PER_FT),
      source: "drawing",
    };
  }

  return {
    bayPx,
    bayWidthIn,
    rackDepthIn,
    beamHeightsIn,
    pxPerFt,
    capacityPerLevel: capacity != null && capacity > 0 ? Math.floor(capacity) : null,
    building,
  };
}

// ---- Racks ------------------------------------------------------------------

interface RackRow {
  code: string;
  description: string;
  notes: string;
  zoneText: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  vertical: boolean;
  bays: number;
  levels: number;
  faceCodes: string[];
  kind: RackKind | "fixture";
}

function rackKind(description: string, notes: string, faceCodes: string[]): RackKind | "fixture" {
  if (faceCodes.length === 0 || /not a stock location/i.test(notes)) return "fixture";
  if (/end\s*-?\s*caps?\b/i.test(description)) return "end_cap";
  if (/shel(f|v)/i.test(description)) return "shelving";
  if (/\bfloor\b/i.test(description)) return "floor";
  return "pallet_rack";
}

function readRacks(rows: SheetRow[], warnings: string[]): RackRow[] {
  const out: RackRow[] = [];
  for (const row of rows) {
    const code = text(get(row, "Rack")).toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9-]{0,15}$/.test(code)) continue;
    const [x1, y1, x2, y2] = ["x1 px", "y1 px", "x2 px", "y2 px"].map((k) => num(get(row, k)));
    if (x1 == null || y1 == null || x2 == null || y2 == null) {
      warnings.push(`Racks: ${code} has no pixel extents; skipped.`);
      continue;
    }
    const orientation = text(get(row, "Orientation")).toLowerCase();
    let vertical: boolean;
    if (orientation.startsWith("vert")) vertical = true;
    else if (orientation.startsWith("hor")) vertical = false;
    else {
      vertical = Math.abs(y2 - y1) >= Math.abs(x2 - x1);
      warnings.push(`Racks: ${code} has no orientation; read as ${vertical ? "vertical" : "horizontal"} from its shape.`);
    }
    const bays = num(get(row, "Bays"));
    const levels = num(get(row, "Levels"));
    if (bays == null || bays < 1 || levels == null || levels < 1) {
      warnings.push(`Racks: ${code} needs bays and levels; skipped.`);
      continue;
    }
    const faceCodes = text(get(row, "Face codes"))
      .split(/[^0-9]+/)
      .filter((p) => p !== "")
      .map((p) => p.padStart(2, "0"));
    const description = text(get(row, "Description"));
    const notes = text(get(row, "Notes"));
    out.push({
      code,
      description,
      notes,
      zoneText: text(get(row, "Zone by bay")),
      x1: Math.min(x1, x2),
      y1: Math.min(y1, y2),
      x2: Math.max(x1, x2),
      y2: Math.max(y1, y2),
      vertical,
      bays: Math.floor(bays),
      levels: Math.floor(levels),
      faceCodes,
      kind: rackKind(description, notes, faceCodes),
    });
  }
  return out;
}

/** Zones of one face's bays on one rack, in walk order (index 0 = the face's first bay on this rack). */
function zonesFor(
  rack: RackRow,
  side: string | null,
  dir: WalkDir | null,
  fallback: string,
  ctx: string,
  warnings: string[],
): string[] {
  let generic: string | null = null;
  let specific: string | null = null;
  for (const seg of rack.zoneText
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)) {
    const m = /^(north|south|east|west)\b[\s:]*(.*)$/i.exec(seg);
    if (m) {
      if (side && m[1].toLowerCase() === side) specific = m[2];
    } else if (generic === null) {
      generic = seg;
    }
  }
  const chosen = specific ?? generic;
  const zones: string[] = [];
  if (chosen) {
    for (const raw of chosen
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)) {
      const rep = /^([A-Za-z]+)\s*[x×]\s*(\d+)$/.exec(raw);
      const zone = (rep ? rep[1] : raw).toUpperCase();
      const times = rep ? Number(rep[2]) : 1;
      const ok = WH_ZONES.includes(zone);
      if (!ok) warnings.push(`${ctx}: zone "${raw}" is not a warehouse zone; using ${fallback}.`);
      for (let i = 0; i < times; i++) zones.push(ok ? zone : fallback);
    }
  }
  if (zones.length === 0) zones.push(fallback);
  if (zones.length > rack.bays) {
    warnings.push(`${ctx}: ${zones.length} zones for ${rack.bays} bays; the extra zones are ignored.`);
    zones.length = rack.bays;
  }
  while (zones.length < rack.bays) zones.push(zones[zones.length - 1]);
  // The Racks tab lists zones north→south (vertical) or west→east (horizontal).
  const againstRun = rack.vertical ? dir === "N" : dir === "W";
  return againstRun ? zones.reverse() : zones;
}

// ---- Fixtures ---------------------------------------------------------------

interface FixtureRow {
  name: string;
  type: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

function namedFor(name: string): { code: string; primary: boolean } | null {
  for (const rule of NAMED_RULES) {
    const m = name.match(rule.re);
    if (m) return { code: rule.code(m), primary: rule.primary };
  }
  return null;
}

function fixtureKind(name: string, type: string, link: { code: string; primary: boolean } | null): FixtureKind {
  const t = type.toLowerCase();
  if (t === "door" || /\bdoor\b/i.test(name)) return "door";
  if (/\bdesk\b/i.test(name)) return "desk";
  if (/^(pack station|av cart|bubble wrap station)/i.test(name)) return "pack_station";
  if ((link?.primary && STOCK_FLOOR.has(link.code)) || ["in", "out", "spare"].includes(t)) return "staging";
  if (t === "fixture" || /machine|barrel|\bac unit\b/i.test(name)) return "obstacle";
  return "other";
}

// ---- main -------------------------------------------------------------------

interface FaceRow {
  face: string;
  rackCodes: string[];
  side: string | null;
  aisle: string | null;
  dir: WalkDir | null;
  bays: number | null;
  firstAt: string;
  zoneDefault: string;
  pickable: number[];
  order: number;
  pass: number;
}

export function importWorkbook(tabs: WorkbookTabs): WorkbookImport {
  const warnings: string[] = [];
  const scale = readScale(tabs.scale);
  const ppf = scale.pxPerFt;
  const mmX = (px: number) => ((px - ORIGIN_PX.x) / ppf) * MM_PER_FT;
  const mmY = (px: number) => ((px - ORIGIN_PX.y) / ppf) * MM_PER_FT;
  const mmLen = (px: number) => (px / ppf) * MM_PER_FT;

  // racks and templates
  const rackRows = readRacks(tabs.racks, warnings);
  const stockRacks = rackRows.filter((r) => r.kind !== "fixture");
  const templates: TemplatePayload[] = [];
  const templateOf = new Map<string, TemplatePayload>();
  for (const r of stockRacks) {
    const kind = r.kind as RackKind;
    const key = `${kind}:${r.levels}`;
    if (templateOf.has(key)) continue;
    const group = stockRacks.filter((x) => x.kind === kind && x.levels === r.levels);
    const heights: number[] = [];
    for (let l = 1; l <= r.levels; l++) {
      const h = scale.beamHeightsIn[l - 1];
      if (h == null) {
        throw new Error(`Scale tab: level ${l} beam height is missing (needed by ${group.map((g) => g.code).join(", ")}).`);
      }
      heights.push(rnd(h * MM_PER_IN));
    }
    const pallet = kind === "pallet_rack";
    const along = (x: RackRow) => mmLen(x.vertical ? x.y2 - x.y1 : x.x2 - x.x1);
    const across = (x: RackRow) => mmLen(x.vertical ? x.x2 - x.x1 : x.y2 - x.y1);
    const tpl: TemplatePayload = {
      code: `${TEMPLATE_ABBR[kind]}-${r.levels}L`,
      name: `${TEMPLATE_NAME[kind]}, ${r.levels} level${r.levels === 1 ? "" : "s"}`,
      kind,
      bays: mode(group.map((g) => g.bays)),
      levels: r.levels,
      bay_width_mm: pallet ? rnd(scale.bayWidthIn * MM_PER_IN) : rnd(mean(group.map((g) => along(g) / g.bays))),
      depth_mm: pallet ? rnd(scale.rackDepthIn * MM_PER_IN) : rnd(mean(group.map(across))),
      level_heights_mm: heights,
      overflow_top_level: pallet && r.levels >= 3,
      capacity_cartons_per_level: scale.capacityPerLevel,
    };
    templateOf.set(key, tpl);
    templates.push(tpl);
  }

  const racks: RackPayload[] = stockRacks.map((r) => {
    const tpl = templateOf.get(`${r.kind}:${r.levels}`) as TemplatePayload;
    const alongPx = r.vertical ? r.y2 - r.y1 : r.x2 - r.x1;
    const acrossPx = r.vertical ? r.x2 - r.x1 : r.y2 - r.y1;
    return {
      code: r.code,
      description: r.description || null,
      template_code: tpl.code,
      x_mm: snap(mmX(r.x1), RACK_SNAP_MM),
      y_mm: snap(mmY(r.y1), RACK_SNAP_MM),
      rot_deg: r.vertical ? 90 : 0,
      bays: r.bays,
      levels: r.levels,
      width_mm: tpl.kind === "pallet_rack" ? r.bays * tpl.bay_width_mm : rnd(mmLen(alongPx)),
      depth_mm: rnd(mmLen(acrossPx)),
    };
  });
  const rackByCode = new Map(stockRacks.map((r) => [r.code, r]));

  // faces
  const faceRows: FaceRow[] = [];
  for (const row of tabs.faces) {
    const raw = text(get(row, "Face"));
    if (!/^\d{1,2}$/.test(raw)) continue;
    const face = raw.padStart(2, "0");
    const sideText = text(get(row, "Side")).toLowerCase();
    const side = SIDES.includes(sideText) ? sideText : null;
    if (!side && !isDash(sideText)) {
      warnings.push(`Faces: face ${face} side "${sideText}" is not north, south, east, west or both.`);
    }
    const aisleText = text(get(row, "Aisle"));
    const zoneDefault = text(get(row, "Zone default")).toUpperCase();
    const orderNum = num(get(row, "Walk order"));
    faceRows.push({
      face,
      rackCodes: text(get(row, "Rack"))
        .toUpperCase()
        .split(/[^A-Z0-9-]+/)
        .filter(Boolean),
      side,
      aisle: isDash(aisleText) ? null : aisleText,
      dir: parseWalkDir(get(row, "Walk direction")),
      bays: num(get(row, "Bays")),
      firstAt: text(get(row, "First bay at")).toLowerCase(),
      zoneDefault: WH_ZONES.includes(zoneDefault) ? zoneDefault : "MISC",
      pickable: parsePickableLevels(get(row, "Pickable levels")),
      order: orderNum == null || orderNum >= 99 ? 99 : Math.max(0, Math.floor(orderNum)),
      pass: 99,
    });
  }

  // walk passes: consecutive routed faces sharing aisle and direction are one pass
  const routed = faceRows
    .filter((f) => f.order < 99)
    .sort((a, b) => a.order - b.order || (a.face < b.face ? -1 : a.face > b.face ? 1 : 0));
  let prev: FaceRow | null = null;
  for (const f of routed) {
    const samePass =
      prev !== null && f.aisle !== null && f.aisle === prev.aisle && f.dir !== null && f.dir === prev.dir;
    f.pass = samePass && prev ? prev.pass : f.order;
    prev = f;
  }

  const faces: FacePayload[] = [];
  for (const f of faceRows) {
    const ctx = `Face ${f.face}`;
    const members: RackRow[] = [];
    for (const code of f.rackCodes) {
      const rack = rackByCode.get(code);
      if (rack) members.push(rack);
      else warnings.push(`${ctx}: rack ${code} is not a stock rack on the Racks tab; skipped.`);
    }
    if (members.length === 0) continue;
    const key = (r: RackRow) =>
      f.dir === "E" ? r.x1 : f.dir === "W" ? -r.x2 : f.dir === "S" ? r.y1 : f.dir === "N" ? -r.y2 : 0;
    members.sort((a, b) => key(a) - key(b));
    const total = members.reduce((s, r) => s + r.bays, 0);
    if (f.bays != null && f.bays !== total) {
      warnings.push(`${ctx}: the Faces tab says ${f.bays} bays, its racks have ${total}.`);
    }
    if (f.dir && !isDash(f.firstAt) && !f.firstAt.startsWith(FIRST_END[f.dir])) {
      warnings.push(`${ctx}: walks ${f.dir} but bay 01 is said to be at the ${f.firstAt}; the walk direction wins.`);
    }
    let first = 1;
    for (const rack of members) {
      if (rack.faceCodes.length > 0 && !rack.faceCodes.includes(f.face)) {
        warnings.push(`${ctx}: the Racks tab does not list face ${f.face} on ${rack.code}.`);
      }
      faces.push({
        rack_code: rack.code,
        face_code: f.face,
        side: f.side,
        aisle: f.aisle,
        walk_pass: f.pass,
        walk_dir: f.dir,
        first_bay_no: first,
        zone_by_bay: zonesFor(rack, f.side, f.dir, f.zoneDefault, `${ctx} on ${rack.code}`, warnings),
        pickable_levels: f.pickable,
      });
      first += rack.bays;
    }
  }
  for (const r of stockRacks) {
    for (const fc of r.faceCodes) {
      if (!faces.some((f) => f.rack_code === r.code && f.face_code === fc)) {
        warnings.push(`Racks: ${r.code} lists face ${fc}, which has no row on the Faces tab.`);
      }
    }
  }

  // fixtures: the Fixtures tab plus racks that are not stock locations
  const fixtureRows: FixtureRow[] = [];
  for (const r of rackRows.filter((x) => x.kind === "fixture")) {
    const name = r.description.replace(/\s*\([^)]*\)\s*$/, "") || r.code;
    const zone = r.zoneText.split(/[;,]/)[0].trim().toUpperCase(); // first zone of a multi-bay list
    fixtureRows.push({ name, type: WH_ZONES.includes(zone) ? zone : "fixture", x1: r.x1, y1: r.y1, x2: r.x2, y2: r.y2 });
    warnings.push(`Racks: ${r.code} (${name}) is not a stock location; imported as a fixture.`);
  }
  for (const row of tabs.fixtures) {
    const name = text(get(row, "Fixture"));
    if (!name) continue;
    const [x1, y1, x2, y2] = ["x1 px", "y1 px", "x2 px", "y2 px"].map((k) => num(get(row, k)));
    if (x1 == null || y1 == null || x2 == null || y2 == null) continue;
    fixtureRows.push({
      name,
      type: text(get(row, "Type")),
      x1: Math.min(x1, x2),
      y1: Math.min(y1, y2),
      x2: Math.max(x1, x2),
      y2: Math.max(y1, y2),
    });
  }

  const fixtures: FixturePayload[] = [];
  const seenNames = new Set<string>();
  const geometry = new Map<string, { row: FixtureRow; primary: boolean }>();
  for (const fx of fixtureRows) {
    let name = fx.name;
    for (let n = 2; seenNames.has(name.toLowerCase()); n++) name = `${fx.name} (${n})`;
    if (name !== fx.name) warnings.push(`Fixtures: a second "${fx.name}" was renamed "${name}".`);
    seenNames.add(name.toLowerCase());
    const link = namedFor(fx.name);
    if (link) {
      const had = geometry.get(link.code);
      if (!had || (link.primary && !had.primary)) geometry.set(link.code, { row: fx, primary: link.primary });
      else if (link.primary && had.primary) warnings.push(`Fixtures: ${link.code} is placed twice; using ${had.row.name}.`);
    }
    const type = fx.type.toUpperCase();
    fixtures.push({
      name,
      kind: fixtureKind(fx.name, fx.type, link),
      x_mm: rnd(mmX(fx.x1)),
      y_mm: rnd(mmY(fx.y1)),
      width_mm: rnd(mmLen(fx.x2 - fx.x1)),
      depth_mm: rnd(mmLen(fx.y2 - fx.y1)),
      rot_deg: 0,
      zone: WH_ZONES.includes(type) ? type : link ? (NAMED_ZONES[link.code] ?? null) : null,
      // The gaylord overflow spot is open floor most of the year (owner, 2026-10-20);
      // `blocked` is a toggle for peak season, flipped in the editor, never by the import.
      blocked: false,
      location_code: link ? link.code : null,
    });
  }

  const named: NamedLocationUpdate[] = [];
  for (const code of Object.keys(NAMED_ZONES)) {
    const g = geometry.get(code);
    if (!g) {
      warnings.push(`Named location ${code}: no fixture on the workbook places it; its geometry is left as it is.`);
      continue;
    }
    const { x1, y1, x2, y2 } = g.row;
    named.push({
      code,
      x_mm: rnd(mmX((x1 + x2) / 2)),
      y_mm: rnd(mmY((y1 + y2) / 2)),
      z_mm: 0,
      width_mm: rnd(mmLen(x2 - x1)),
      depth_mm: rnd(mmLen(y2 - y1)),
    });
  }
  for (const code of UNPLACED_NAMED) {
    warnings.push(`Named location ${code}: not on the drawing; place it when the dock printer is set up.`);
  }

  return { payload: { templates, racks, faces, fixtures }, named, warnings, scale };
}

// ---- comparison with the Locations tab (§9.6 step 2) -------------------------

export interface GeneratorCode {
  code: string;
  pick_sequence?: number | null;
  zone?: string | null;
  pickable?: boolean | null;
  is_overflow?: boolean | null;
}

export interface SequenceDiff {
  code: string;
  workbook: number | null;
  generator: number | null;
}

/** A matched code whose zone or pick flag disagrees with the Locations tab. */
export interface FlagDiff {
  code: string;
  field: "zone" | "pickable" | "is_overflow";
  workbook: string;
  generator: string | boolean | null;
}

export interface LocationsComparison {
  /** Bay-level codes in both. */
  matched: string[];
  /** Bay-level codes on the Locations tab that the generator does not produce. */
  onlyInWorkbook: string[];
  /** Codes the generator produces that the Locations tab lacks. */
  onlyInGenerator: string[];
  /** Matched codes whose pick_sequence differs, in generator order. */
  sequenceDiffs: SequenceDiff[];
  /** Matched codes whose zone or pick flags differ (only checked when the generator rows carry them). */
  flagDiffs: FlagDiff[];
  /** Named (non bay-level) codes on the tab: placed by rpc_wh_save_location, not generated. */
  named: string[];
}

const BAY_LEVEL_RE = /^\d{2}-\d{2}-\d$/;

/**
 * Compare a generator run (dry run `codes`) with the workbook's Locations tab
 * by code. Only pick_sequence should differ (§5.3 interleaving); the Python
 * twin prints the same comparison.
 */
export function compareWithLocationsTab(generatorCodes: GeneratorCode[], locationsTab: SheetRow[]): LocationsComparison {
  const workbook = new Map<string, SheetRow>();
  const named: string[] = [];
  for (const row of locationsTab) {
    const code = text(get(row, "Code")).toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9-]*$/.test(code)) continue;
    if (BAY_LEVEL_RE.test(code)) workbook.set(code, row);
    else named.push(code);
  }
  const generator = new Map(generatorCodes.map((g) => [g.code.toUpperCase(), g]));
  const matched: string[] = [];
  const onlyInWorkbook: string[] = [];
  const sequenceDiffs: SequenceDiff[] = [];
  const flagDiffs: FlagDiff[] = [];
  for (const [code, row] of workbook) {
    const g = generator.get(code);
    if (!g) {
      onlyInWorkbook.push(code);
      continue;
    }
    matched.push(code);
    const seq = num(get(row, "Pick seq"));
    const gSeq = g.pick_sequence ?? null;
    if (gSeq !== seq) sequenceDiffs.push({ code, workbook: seq, generator: gSeq });
    const zone = text(get(row, "Zone")).toUpperCase();
    if (zone && g.zone !== undefined && g.zone !== zone) {
      flagDiffs.push({ code, field: "zone", workbook: zone, generator: g.zone ?? null });
    }
    const pick = text(get(row, "Pickable")).toLowerCase();
    if (pick && g.pickable !== undefined && (pick === "yes") !== !!g.pickable) {
      flagDiffs.push({ code, field: "pickable", workbook: pick, generator: g.pickable ?? null });
    }
    if (pick === "overflow" && g.is_overflow !== undefined && !g.is_overflow) {
      flagDiffs.push({ code, field: "is_overflow", workbook: pick, generator: g.is_overflow ?? null });
    }
  }
  const onlyInGenerator = [...generator.keys()].filter((c) => !workbook.has(c));
  sequenceDiffs.sort((a, b) => (a.generator ?? Infinity) - (b.generator ?? Infinity) || (a.code < b.code ? -1 : 1));
  return {
    matched: matched.sort(),
    onlyInWorkbook: onlyInWorkbook.sort(),
    onlyInGenerator: onlyInGenerator.sort(),
    sequenceDiffs,
    flagDiffs,
    named,
  };
}
