/**
 * Warehouse map geometry (design §9.3 FloorPlan / LayoutEditor, §4.3 layout
 * tables, §5.3 generator). Pure: millimetres in, millimetres out.
 *
 * Conventions (header of supabase/migrations/20261022000001_wh_layout.sql):
 *   - Origin is the inside top-left corner of the building; X runs east,
 *     Y south.
 *   - A rack's x_mm/y_mm is the top-left corner of its footprint. rot_deg
 *     0/180 runs the bays along X, 90/270 along Y. width_mm is the length
 *     along the bays (template bays × bay width when null), depth_mm across.
 *   - A face's walk_dir decides which end is bay 01; its side decides the
 *     edge the bay centre sits on (east/west on a vertical rack, north/south
 *     on a horizontal one; anything else sits on the centre line).
 *   - bayPoint() is the TypeScript twin of _wh_location_plan(): it returns
 *     exactly the x_mm/y_mm the generator stores, so a bay cell drawn here
 *     always lands on its generated locations (map-geometry.test.ts checks
 *     every staging bay-level).
 *   - Fixtures: x_mm/y_mm is the top-left corner; width along X and depth
 *     along Y at rot 0/180, swapped at 90/270. Named locations store their
 *     centre point plus extent (workbook-import.ts).
 */

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TemplateGeom {
  id: string;
  code?: string;
  bays?: number;
  levels?: number;
  bay_width_mm: number;
  depth_mm: number;
  level_heights_mm?: number[] | null;
  overflow_top_level?: boolean | null;
}

export interface RackGeom {
  id: string;
  code: string;
  template_id: string | null;
  x_mm: number;
  y_mm: number;
  rot_deg: number;
  bays: number;
  levels: number;
  width_mm: number | null;
  depth_mm: number | null;
  active?: boolean;
}

export interface FaceGeom {
  id: string;
  rack_id: string;
  face_code: string;
  side: string | null;
  walk_dir: string | null;
  walk_pass?: number;
  first_bay_no: number;
  zone_by_bay: string[] | null;
  pickable_levels?: number[] | null;
  aisle?: string | null;
}

export interface FixtureGeom {
  id: string;
  name: string;
  kind: string;
  x_mm: number;
  y_mm: number;
  width_mm: number | null;
  depth_mm: number | null;
  rot_deg: number;
  zone?: string | null;
  blocked?: boolean;
  location_id?: string | null;
}

export interface LayoutGeom {
  templates: TemplateGeom[];
  racks: RackGeom[];
  faces: FaceGeom[];
  fixtures: FixtureGeom[];
}

export type FaceEdge = "north" | "south" | "east" | "west" | null;
export type WalkDir = "N" | "S" | "E" | "W";

/** Round half up: Postgres round(numeric) for the positive offsets the generator rounds. */
export const rnd = (v: number): number => Math.floor(v + 0.5);

export const SNAP_MM = 100;

export function snapMm(v: number, step = SNAP_MM): number {
  return Math.round(v / step) * step;
}

export function isVertical(rotDeg: number): boolean {
  return rotDeg === 90 || rotDeg === 270;
}

export function templateFor(rack: Pick<RackGeom, "template_id">, templates: TemplateGeom[]): TemplateGeom | undefined {
  return rack.template_id ? templates.find((t) => t.id === rack.template_id) : undefined;
}

/** Length along the bays: COALESCE(width_mm, bays × template bay width, bays × 1000), as the generator. */
export function rackLength(rack: RackGeom, tpl?: TemplateGeom): number {
  return rack.width_mm ?? (tpl ? rack.bays * tpl.bay_width_mm : rack.bays * 1000);
}

/** Depth across the bays: COALESCE(depth_mm, template depth, 0). */
export function rackDepth(rack: RackGeom, tpl?: TemplateGeom): number {
  return rack.depth_mm ?? tpl?.depth_mm ?? 0;
}

/** The rack's footprint (axis-aligned: rotations are multiples of 90°). */
export function rackRect(rack: RackGeom, tpl?: TemplateGeom): Rect {
  const len = rackLength(rack, tpl);
  const dep = rackDepth(rack, tpl);
  return isVertical(rack.rot_deg)
    ? { x: rack.x_mm, y: rack.y_mm, w: dep, h: len }
    : { x: rack.x_mm, y: rack.y_mm, w: len, h: dep };
}

/** Corners clockwise from the top-left. */
export function rectPolygon(r: Rect): Point[] {
  return [
    { x: r.x, y: r.y },
    { x: r.x + r.w, y: r.y },
    { x: r.x + r.w, y: r.y + r.h },
    { x: r.x, y: r.y + r.h },
  ];
}

export function rackPolygon(rack: RackGeom, tpl?: TemplateGeom): Point[] {
  return rectPolygon(rackRect(rack, tpl));
}

export function rectCenter(r: Rect): Point {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

/** Position of bay k (0 = the face's first bay on this rack) along the rack, from the rack's x/y origin. */
export function baySlot(rack: RackGeom, face: Pick<FaceGeom, "walk_dir">, k: number): number {
  if (isVertical(rack.rot_deg)) return face.walk_dir === "N" ? rack.bays - 1 - k : k;
  return face.walk_dir === "W" ? rack.bays - 1 - k : k;
}

/** The edge a face's bay centres sit on; null = the centre line (side "both", unset, or across the run). */
export function faceEdge(rack: RackGeom, face: Pick<FaceGeom, "side">): FaceEdge {
  if (isVertical(rack.rot_deg)) return face.side === "east" || face.side === "west" ? face.side : null;
  return face.side === "north" || face.side === "south" ? face.side : null;
}

/** The generator's x_mm/y_mm for bay k of a face (twin of _wh_location_plan's gx/gy). */
export function bayPoint(rack: RackGeom, tpl: TemplateGeom | undefined, face: FaceGeom, k: number): Point {
  const len = rackLength(rack, tpl);
  const dep = rackDepth(rack, tpl);
  const bayW = len / rack.bays;
  const along = rnd((baySlot(rack, face, k) + 0.5) * bayW);
  // `dep_mm / 2` is integer division in the SQL.
  const half = Math.trunc(dep / 2);
  if (isVertical(rack.rot_deg)) {
    const x = face.side === "east" ? rack.x_mm + dep : face.side === "west" ? rack.x_mm : rack.x_mm + half;
    return { x, y: rack.y_mm + along };
  }
  const y = face.side === "north" ? rack.y_mm : face.side === "south" ? rack.y_mm + dep : rack.y_mm + half;
  return { x: rack.x_mm + along, y };
}

/** One bay of one face on the plan; every level of the bay shares it. */
export interface BayCell {
  /** `${face}-${bay}` with the bay zero-padded, i.e. the location code without its level. */
  key: string;
  faceId: string;
  face: string;
  rackId: string;
  rackCode: string;
  bay: number;
  slot: number;
  zone: string;
  rect: Rect;
  point: Point;
  edge: FaceEdge;
  walkDir: string | null;
  walkPass: number;
  levels: number;
}

export function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function locationCode(face: string, bay: number, level: number): string {
  return `${face}-${pad2(bay)}-${level}`;
}

export function bayKey(face: string, bay: number): string {
  return `${face}-${pad2(bay)}`;
}

/** Zone of the bay at position k (a short zone_by_bay repeats its last zone; none = MISC), as the generator. */
export function zoneForBay(face: Pick<FaceGeom, "zone_by_bay">, k: number): string {
  const zones = face.zone_by_bay ?? [];
  return zones[k] ?? zones[zones.length - 1] ?? "MISC";
}

/**
 * The cell of bay k: the bay's span along the rack and, across it, the half
 * of the depth on the face's side when another face of the same rack uses
 * the opposite edge (R02, R03), else the full depth. The generated point
 * sits on the cell's outer edge (or its centre line).
 */
export function bayCellRect(rack: RackGeom, tpl: TemplateGeom | undefined, face: FaceGeom, k: number, sharedDepth: boolean): Rect {
  const len = rackLength(rack, tpl);
  const dep = rackDepth(rack, tpl);
  const bayW = len / rack.bays;
  const slot = baySlot(rack, face, k);
  const edge = faceEdge(rack, face);
  const cellDep = edge && sharedDepth ? dep / 2 : dep;
  if (isVertical(rack.rot_deg)) {
    const x = edge === "east" ? rack.x_mm + dep - cellDep : rack.x_mm;
    return { x, y: rack.y_mm + slot * bayW, w: cellDep, h: bayW };
  }
  const y = edge === "south" ? rack.y_mm + dep - cellDep : rack.y_mm;
  return { x: rack.x_mm + slot * bayW, y, w: bayW, h: cellDep };
}

const OPPOSITE: Record<string, string> = { north: "south", south: "north", east: "west", west: "east" };

/** Every bay cell of the active racks' faces, ordered by face then bay. */
export function bayCells(layout: LayoutGeom, opts: { includeInactive?: boolean } = {}): BayCell[] {
  const cells: BayCell[] = [];
  const racks = new Map(layout.racks.map((r) => [r.id, r]));
  for (const face of layout.faces) {
    const rack = racks.get(face.rack_id);
    if (!rack || (!opts.includeInactive && rack.active === false)) continue;
    const tpl = templateFor(rack, layout.templates);
    const edge = faceEdge(rack, face);
    const sharedDepth =
      !!edge &&
      layout.faces.some((f) => f.rack_id === rack.id && f.id !== face.id && faceEdge(rack, f) === OPPOSITE[edge]);
    for (let k = 0; k < rack.bays; k++) {
      const bay = face.first_bay_no + k;
      cells.push({
        key: bayKey(face.face_code, bay),
        faceId: face.id,
        face: face.face_code,
        rackId: rack.id,
        rackCode: rack.code,
        bay,
        slot: baySlot(rack, face, k),
        zone: zoneForBay(face, k),
        rect: bayCellRect(rack, tpl, face, k, sharedDepth),
        point: bayPoint(rack, tpl, face, k),
        edge,
        walkDir: face.walk_dir,
        walkPass: face.walk_pass ?? 99,
        levels: rack.levels,
      });
    }
  }
  return cells.sort((a, b) => a.face.localeCompare(b.face) || a.bay - b.bay);
}

/** A fixture's footprint. Missing extents draw as a 500 mm square so the fixture stays clickable. */
export function fixtureRect(f: FixtureGeom): Rect {
  const w = f.width_mm ?? 500;
  const d = f.depth_mm ?? 500;
  return isVertical(f.rot_deg) ? { x: f.x_mm, y: f.y_mm, w: d, h: w } : { x: f.x_mm, y: f.y_mm, w, h: d };
}

/** A rect from a centre point plus extent (named locations); null without a position. */
export function centeredRect(
  x: number | null | undefined,
  y: number | null | undefined,
  w: number | null | undefined,
  h: number | null | undefined,
  fallback = 600,
): Rect | null {
  if (x == null || y == null) return null;
  const ww = w ?? fallback;
  const hh = h ?? fallback;
  return { x: x - ww / 2, y: y - hh / 2, w: ww, h: hh };
}

export function unionRect(rects: (Rect | null | undefined)[]): Rect | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of rects) {
    if (!r) continue;
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.w);
    maxY = Math.max(maxY, r.y + r.h);
  }
  if (!Number.isFinite(minX)) return null;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/**
 * The building's inside outline. The layout stores no wall extents, so this
 * is the origin to the far edge of every rack and non-door fixture, or to a
 * door's centre (doors straddle the wall), rounded up to 100 mm.
 */
export function buildingRect(layout: LayoutGeom, extra: (Rect | null)[] = []): Rect {
  let maxX = 0;
  let maxY = 0;
  for (const rack of layout.racks) {
    if (rack.active === false) continue;
    const r = rackRect(rack, templateFor(rack, layout.templates));
    maxX = Math.max(maxX, r.x + r.w);
    maxY = Math.max(maxY, r.y + r.h);
  }
  for (const f of layout.fixtures) {
    const r = fixtureRect(f);
    if (f.kind === "door") {
      const c = rectCenter(r);
      maxX = Math.max(maxX, c.x);
      maxY = Math.max(maxY, c.y);
    } else {
      maxX = Math.max(maxX, r.x + r.w);
      maxY = Math.max(maxY, r.y + r.h);
    }
  }
  for (const r of extra) {
    if (!r) continue;
    maxX = Math.max(maxX, r.x + r.w);
    maxY = Math.max(maxY, r.y + r.h);
  }
  const up = (v: number) => Math.ceil(v / 100) * 100;
  return { x: 0, y: 0, w: up(maxX), h: up(maxY) };
}

export function rectContains(r: Rect, p: Point, tol = 0): boolean {
  return p.x >= r.x - tol && p.x <= r.x + r.w + tol && p.y >= r.y - tol && p.y <= r.y + r.h + tol;
}

/** The bay cell under a point; when cells touch, the one whose centre is nearest. */
export function hitTestCell(cells: BayCell[], p: Point, tol = 0): BayCell | null {
  let best: BayCell | null = null;
  let bestD = Infinity;
  for (const c of cells) {
    if (!rectContains(c.rect, p, tol)) continue;
    const m = rectCenter(c.rect);
    const d = (m.x - p.x) ** 2 + (m.y - p.y) ** 2;
    if (d < bestD) {
      best = c;
      bestD = d;
    }
  }
  return best;
}

// ---- viewBox ------------------------------------------------------------------

export type ViewBox = Rect;

/** The bounds plus a margin, widened or heightened to the viewport's aspect (width / height). */
export function fitViewBox(bounds: Rect, aspect: number, marginFrac = 0.04): ViewBox {
  const m = Math.max(bounds.w, bounds.h) * marginFrac;
  let w = bounds.w + 2 * m;
  let h = bounds.h + 2 * m;
  const a = aspect > 0 && Number.isFinite(aspect) ? aspect : 1;
  if (w / h > a) h = w / a;
  else w = h * a;
  const c = rectCenter(bounds);
  return { x: c.x - w / 2, y: c.y - h / 2, w, h };
}

/** Zoom by `factor` (> 1 zooms in) keeping the point `about` fixed on screen. */
export function zoomViewBox(vb: ViewBox, factor: number, about: Point = rectCenter(vb)): ViewBox {
  const f = factor > 0 ? factor : 1;
  const w = vb.w / f;
  const h = vb.h / f;
  return { x: about.x - (about.x - vb.x) / f, y: about.y - (about.y - vb.y) / f, w, h };
}

/** The same view (centre and width) at another aspect, after the viewport resizes. */
export function matchAspect(vb: ViewBox, aspect: number): ViewBox {
  if (!(aspect > 0) || !Number.isFinite(aspect)) return vb;
  const c = rectCenter(vb);
  const h = vb.w / aspect;
  return { x: vb.x, y: c.y - h / 2, w: vb.w, h };
}

export function panViewBox(vb: ViewBox, dxMm: number, dyMm: number): ViewBox {
  return { ...vb, x: vb.x + dxMm, y: vb.y + dyMm };
}

/**
 * Keep the view usable: its width between minW and maxW (aspect kept) and
 * its centre inside the bounds.
 */
export function clampViewBox(vb: ViewBox, bounds: Rect, opts: { minW?: number; maxW?: number } = {}): ViewBox {
  const minW = opts.minW ?? 1500;
  const maxW = opts.maxW ?? Math.max(bounds.w, bounds.h) * 3;
  let { w, h } = vb;
  const c = rectCenter(vb);
  if (w < minW) {
    h = (h * minW) / w;
    w = minW;
  } else if (w > maxW) {
    h = (h * maxW) / w;
    w = maxW;
  }
  const cx = Math.min(Math.max(c.x, bounds.x), bounds.x + bounds.w);
  const cy = Math.min(Math.max(c.y, bounds.y), bounds.y + bounds.h);
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

/** Screen pixels per millimetre for a viewBox drawn `pxWidth` wide. */
export function pxPerMm(vb: ViewBox, pxWidth: number): number {
  return vb.w > 0 ? pxWidth / vb.w : 1;
}

/**
 * A point in the element's pixel space to plan millimetres. Assumes the
 * viewBox has the element's aspect (FloorPlan keeps it so), i.e. a linear map.
 */
export function pxToMm(vb: ViewBox, size: { width: number; height: number }, px: Point): Point {
  return {
    x: vb.x + (size.width > 0 ? (px.x / size.width) * vb.w : 0),
    y: vb.y + (size.height > 0 ? (px.y / size.height) * vb.h : 0),
  };
}

// ---- editor helpers -------------------------------------------------------------

const CW_SIDE: Record<string, string> = { north: "east", east: "south", south: "west", west: "north" };
const CW_DIR: Record<string, WalkDir> = { N: "E", E: "S", S: "W", W: "N" };

export function rotateSideCw(side: string | null): string | null {
  return side && CW_SIDE[side] ? CW_SIDE[side] : side;
}

export function rotateDirCw(dir: string | null): string | null {
  return dir && CW_DIR[dir] ? CW_DIR[dir] : dir;
}

/**
 * Turn a rack 90° clockwise about its centre (snapped to the grid). Its faces'
 * sides and walk directions turn with it, so bay 01 and the face edge stay on
 * the same physical shelf; four turns give back the original rack.
 */
export function rotateRackCw<R extends RackGeom, F extends FaceGeom>(
  rack: R,
  faces: F[],
  tpl?: TemplateGeom,
  step = SNAP_MM,
): { rack: R; faces: F[] } {
  const before = rackRect(rack, tpl);
  const c = rectCenter(before);
  const rot = (rack.rot_deg + 90) % 360;
  const w = before.h;
  const h = before.w;
  return {
    rack: { ...rack, rot_deg: rot, x_mm: snapMm(c.x - w / 2, step), y_mm: snapMm(c.y - h / 2, step) },
    faces: faces.map((f) => (f.rack_id === rack.id ? { ...f, side: rotateSideCw(f.side), walk_dir: rotateDirCw(f.walk_dir) } : f)),
  };
}

/**
 * A walk path through locations in pick_sequence order: one point per bay
 * (levels of one bay collapse), skipping locations without a sequence or a
 * position.
 */
export function walkPath<T extends { pick_sequence: number | null; x_mm: number | null; y_mm: number | null; face?: string | null; bay?: number | null }>(
  rows: T[],
): { point: Point; seq: number; row: T }[] {
  const sorted = rows
    .filter((r) => r.pick_sequence != null && r.x_mm != null && r.y_mm != null)
    .sort((a, b) => (a.pick_sequence as number) - (b.pick_sequence as number));
  const out: { point: Point; seq: number; row: T }[] = [];
  let lastKey: string | null = null;
  for (const r of sorted) {
    const key = r.face != null && r.bay != null ? bayKey(r.face, r.bay) : `${r.x_mm},${r.y_mm}`;
    if (key === lastKey) continue;
    lastKey = key;
    out.push({ point: { x: r.x_mm as number, y: r.y_mm as number }, seq: r.pick_sequence as number, row: r });
  }
  return out;
}
