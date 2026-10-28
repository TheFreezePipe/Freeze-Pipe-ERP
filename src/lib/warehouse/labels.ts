import { toSVG } from "bwip-js/generic";

/**
 * Warehouse labels (design §5.5): one pure module that turns a print job's
 * payload (_wh_label_payload in 20261022000004_wh_rpcs.sql) into
 *   - ZPL for a 203 dpi thermal printer: Code 128 (`^BC`, automatic subsets)
 *     at 3 dots per module, free text through `^FH` so `^`, `~` and `_` are
 *     hex-escaped, UTF-8 (`^CI28`) for "·" and "×";
 *   - a label model plus Code 128 SVG (bwip-js) for the browser path and the
 *     on-screen preview (LabelSheet).
 * The print agent imports the same module, so a label looks the same
 * whichever path prints it. Practice jobs (outbound mode "practice") carry
 * `%Z` barcodes and the "PRACTICE · STAGING" band.
 *
 * The 4×6 carton label (the pair: `copies` 2, one per adjacent face) feeds
 * 4 in wide and 6 in long but reads landscape, 6 in wide × 4 in tall. Its
 * layout is drawn in landscape dots and every field is rotated `R` in ZPL
 * (90° clockwise); the browser turns the same box 90° onto a 4 × 6 page.
 * Its barcode is 5 dots per module. Each label prints `copies` times (`^PQ`,
 * or that many pages).
 */

export type LabelKind = "lpn" | "lpn_rts" | "location" | "station";
export type LabelSize = "4x2" | "3x1" | "4x6";

/** A location or station label as the payload carries it. */
export interface LocationLabelData {
  id: string;
  code: string;
  barcode: string;
  name?: string | null;
  kind?: string | null;
  words?: string | null;
  overflow?: boolean | null;
}

/** A carton (LPN) label as the payload carries it. */
export interface LpnLabelData {
  id: string;
  code: string;
  barcode: string;
  sku?: string | null;
  product_name?: string | null;
  contents?: string | null;
  qty?: number | null;
  bucket?: string | null;
  label_stock?: "white" | "green" | null;
  shipment?: string | null;
  carton_seq?: number | null;
  carton_of?: number | null;
  worker?: string | null;
  finished_at?: string | null;
  suggested?: string | null;
  from_code?: string | null;
  date?: string | null;
}

export interface LabelPayload {
  kind: LabelKind;
  practice: boolean;
  size: LabelSize;
  /** Identical labels per item (2 for the 4×6 carton pair). parseLabelPayload always sets it; absent means 1. */
  copies?: number;
  labels: (LocationLabelData | LpnLabelData)[];
}

/** What one printed label shows, independent of the renderer. */
export interface LabelModel {
  id: string;
  kind: LabelKind;
  size: LabelSize;
  /** How many identical labels to print (^PQ on the printer, pages in the browser). */
  copies: number;
  stock: "white" | "green";
  practice: boolean;
  /** The barcode's data: '%' + code, or '%Z' + code on a practice label. */
  barcode: string;
  /** The code in large type. */
  code: string;
  /** "OVERFLOW" on a level-3 location, "RTS" on a green carton label. */
  badge: string | null;
  /** Smaller lines under the code, top to bottom. */
  lines: string[];
}

export const LABEL_DPI = 203;
export const MODULE_DOTS = 3;
/** Code 128 module on the 4×6 carton label: 5 dots at 203 dpi (≈ 0.63 mm). */
export const MODULE_DOTS_4X6 = 5;
/** rpc_wh_request_labels accepts p_copies 1..5; a payload asking for more prints 5. */
export const MAX_COPIES = 5;
export const PRACTICE_BAND = "PRACTICE · STAGING";
/** One Code 128 module at 3 dots and 203 dpi, in millimetres (≈ 0.375 mm). */
export const MODULE_MM = (MODULE_DOTS / LABEL_DPI) * 25.4;

/** The media as it feeds: width across the printer, height along the feed. */
export const LABEL_INCHES: Record<LabelSize, { width: number; height: number }> = {
  "4x2": { width: 4, height: 2 },
  "3x1": { width: 3, height: 1 },
  "4x6": { width: 4, height: 6 },
};

/**
 * Sizes whose content reads landscape on the media: the 4×6 label reads 6 in
 * wide × 4 in tall, turned 90° clockwise onto the 4 in media (ZPL `R`).
 */
export const LANDSCAPE: Record<LabelSize, boolean> = { "4x2": false, "3x1": false, "4x6": true };

/** The label as the reader sees it, in inches (a landscape size swaps the media's sides). */
export function contentInches(size: LabelSize): { width: number; height: number } {
  const { width, height } = LABEL_INCHES[size];
  return LANDSCAPE[size] ? { width: height, height: width } : { width, height };
}

const BUCKET_WORDS: Record<string, string> = {
  raw: "RAW",
  prefilled_raw: "PREFILLED RAW",
  in_production: "IN PRODUCTION",
  finished: "FINISHED",
  other: "OTHER",
};

const KINDS: LabelKind[] = ["lpn", "lpn_rts", "location", "station"];

/**
 * The size a kind prints at: carton labels 4×2 unless the payload asks for
 * 4×6 (wh_settings.labels.lpn), locations and stations always 3×1. A size
 * the kind cannot take falls back to the kind's default.
 */
export function labelSizeFor(kind: LabelKind, payloadSize?: unknown): LabelSize {
  if (kind === "lpn" || kind === "lpn_rts") return payloadSize === "4x6" ? "4x6" : "4x2";
  return "3x1";
}

/** A payload's `copies`: a whole number from 1 to MAX_COPIES, else 1. */
export function labelCopies(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) return 1;
  return Math.min(value, MAX_COPIES);
}

/** The barcode data for a code: '%' + code, '%Z' + code on a practice label. */
export function barcodeValue(code: string, practice: boolean): string {
  return (practice ? "%Z" : "%") + code;
}

/** Make a payload barcode agree with the job's practice flag (the server already does; this is a guard). */
function normaliseBarcode(barcode: string | null | undefined, code: string, practice: boolean): string {
  const value = barcode && barcode.length > 0 ? barcode : barcodeValue(code, false);
  if (practice && !value.startsWith("%Z")) return "%Z" + value.replace(/^%/, "");
  return value;
}

/** "02-01-2" → "Face 02 · Bay 01 · Level 2" (the payload's own words win when present). */
export function locationWords(code: string): string | null {
  const m = /^(\d{2})-(\d{2})-(\d)$/.exec(code);
  return m ? `Face ${m[1]} · Bay ${m[2]} · Level ${m[3]}` : null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Read a job's payload (JSON from rpc_wh_request_labels or wh_print_jobs). Throws on a malformed one. */
export function parseLabelPayload(json: unknown): LabelPayload {
  if (!isRecord(json) || !Array.isArray(json.labels)) throw new Error("The print job has no labels.");
  const kind = json.kind as LabelKind;
  if (!KINDS.includes(kind)) throw new Error(`Unknown label kind: ${String(json.kind)}`);
  const labels = json.labels.filter(
    (l): l is LocationLabelData | LpnLabelData => isRecord(l) && typeof l.code === "string" && typeof l.id === "string",
  );
  return {
    kind,
    practice: json.practice === true,
    size: labelSizeFor(kind, json.size),
    copies: labelCopies(json.copies),
    labels,
  };
}

function formatFinished(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(d);
}

function skuLine(l: LpnLabelData): string | null {
  if (l.sku && l.product_name) return `${l.sku} · ${l.product_name}`;
  return l.sku ?? l.contents ?? null;
}

/** The job-level settings a label model takes from its payload. */
export interface LabelModelOptions {
  /** The payload's size; one the kind cannot take falls back to its default (labelSizeFor). */
  size?: LabelSize;
  /** Identical labels per item; 1 when absent or invalid. */
  copies?: number;
}

/** The label model for one payload entry. */
export function labelModel(
  kind: LabelKind,
  data: LocationLabelData | LpnLabelData,
  practice: boolean,
  options: LabelModelOptions = {},
): LabelModel {
  const size = labelSizeFor(kind, options.size);
  const copies = labelCopies(options.copies ?? 1);
  const barcode = normaliseBarcode(data.barcode, data.code, practice);
  const base = { id: data.id, kind, size, copies, practice, barcode, code: data.code };

  if (kind === "location" || kind === "station") {
    const l = data as LocationLabelData;
    const isBay = /^\d{2}-\d{2}-\d$/.test(l.code);
    const words = l.words || (isBay ? locationWords(l.code) : null) || l.name || null;
    return {
      ...base,
      stock: "white",
      badge: l.overflow ? "OVERFLOW" : null,
      lines: words && words !== l.code ? [words] : [],
    };
  }

  const l = data as LpnLabelData;
  const lines: string[] = [];
  if (kind === "lpn_rts") {
    const sku = skuLine(l);
    if (sku) lines.push(sku);
    if (l.qty != null) lines.push(`${l.qty} units`);
    const done = [l.worker, formatFinished(l.finished_at)].filter(Boolean).join(" · ");
    if (done) lines.push(done);
    const where = [l.suggested ? `Put in ${l.suggested}` : null, l.from_code ? `from ${l.from_code}` : null]
      .filter(Boolean)
      .join(" · ");
    if (where) lines.push(where);
    return { ...base, stock: "green", badge: "RTS", lines };
  }

  // a single-SKU carton shows SKU and name; a mixed one the payload's "MIXED BW20×12 + NB4×6"
  const what = l.sku ? skuLine(l) : (l.contents ?? null);
  if (what) lines.push(what);
  const qty = [l.qty != null ? `${l.qty} units` : null, l.bucket ? (BUCKET_WORDS[l.bucket] ?? l.bucket.toUpperCase()) : null]
    .filter(Boolean)
    .join(" · ");
  if (qty) lines.push(qty);
  const ship = [
    l.shipment ? `Shipment ${l.shipment}` : null,
    l.carton_seq != null ? (l.carton_of ? `carton ${l.carton_seq} of ${l.carton_of}` : `carton ${l.carton_seq}`) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  if (ship) lines.push(ship);
  if (l.date) lines.push(l.date);
  return { ...base, stock: l.label_stock === "green" ? "green" : "white", badge: null, lines };
}

export function labelModels(payload: LabelPayload): LabelModel[] {
  const options = { size: payload.size, copies: payload.copies };
  return payload.labels.map((l) => labelModel(payload.kind, l, payload.practice, options));
}

// ---- 4×6 geometry (landscape dots) -------------------------------------------

/**
 * The 4×6 carton label in landscape dots at 203 dpi: X along the 6 in
 * (0..1218), Y down the 4 in (0..812). Contract item 2: margin 40; code 150
 * at the top-left; RTS badge 190 at the top-right; up to four lines at
 * 70 / 56 / 48 / 48; Code 128 260 tall at the bottom-left with its value
 * (36) under it; a 48 band across the top on practice jobs.
 */
export const L4X6 = {
  width: Math.round(6 * LABEL_DPI),
  height: Math.round(4 * LABEL_DPI),
  margin: 40,
  /** Where the barcode starts: a quiet zone of 10 modules at 5 dots needs 50; 56 is 7 mm. */
  barX: 56,
  band: 48,
  bandText: 32,
  code: 150,
  /** Gap between the practice band and the code (the band stands in for the top margin). */
  codeBelowBand: 12,
  badge: 190,
  /** The badge is right-aligned in a block this wide that ends at the right margin. */
  badgeBlock: 400,
  badgeTop: 10,
  /** Clear space kept between the end of the code and the start of the badge. */
  badgeGap: 30,
  lines: [70, 56, 48, 48],
  linesBelowCode: 10,
  lineGap: 8,
  bar: 260,
  human: 36,
  humanGap: 6,
} as const;

/**
 * Dots per Code 128 module for a size: 3, or 5 on the 4×6 label. A 4×6
 * barcode of `modules` modules too long for the space between its quiet zone and the right margin
 * steps down a dot at a time (never below 3) so it stays on the label; codes
 * up to about 17 characters fit at 5.
 */
export function moduleDotsFor(size: LabelSize, modules = 0): number {
  if (size !== "4x6") return MODULE_DOTS;
  const room = L4X6.width - L4X6.barX - L4X6.margin;
  let dots = MODULE_DOTS_4X6;
  while (dots > MODULE_DOTS && modules * dots > room) dots -= 1;
  return dots;
}

// ---- ZPL --------------------------------------------------------------------

/**
 * Field data for `^FH^FD…^FS`: `_` (the hex indicator), `^` and `~` become
 * _5F, _5E and _7E; anything outside printable ASCII is written as its UTF-8
 * bytes (with ^CI28 the printer reads them as UTF-8); control characters drop.
 */
export function zplEscape(value: string): string {
  let out = "";
  for (const ch of value) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp < 0x20 || cp === 0x7f) continue;
    if (ch === "_" || ch === "^" || ch === "~" || cp > 0x7e) {
      for (const byte of new TextEncoder().encode(ch)) out += "_" + byte.toString(16).toUpperCase().padStart(2, "0");
    } else {
      out += ch;
    }
  }
  return out;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, Math.max(0, max - 1)) + "…";
}

function text(x: number, y: number, h: number, value: string, reverse = false): string {
  return `^FO${x},${y}^A0N,${h},${h}${reverse ? "^FR" : ""}^FH^FD${zplEscape(value)}^FS`;
}

function centred(width: number, y: number, h: number, value: string, reverse = false): string {
  return `^FO0,${y}^FB${width},1,0,C^A0N,${h},${h}${reverse ? "^FR" : ""}^FH^FD${zplEscape(value)}^FS`;
}

function barcode(x: number, y: number, h: number, value: string): string {
  // ^BCo,h,f,g,e,m: no interpretation line (the code is printed large), automatic subsets
  return `^FO${x},${y}^BY${MODULE_DOTS},2,${h}^BCN,${h},N,N,N,A^FH^FD${zplEscape(value)}^FS`;
}

/**
 * The native `^FO` of a rotated (`R`) field whose landscape box starts at
 * (x, y) and is `h` tall: native x = 812 − y − h, native y = x (contract
 * item 1; ^FO is the rotated field's bounding-box top-left).
 */
function rotatedOrigin(x: number, y: number, h: number): string {
  return `^FO${L4X6.height - y - h},${x}`;
}

/** Text `h` tall (and `w` wide a character, ^A0's width parameter) at landscape (x, y), reading along the 6 in. */
function rotatedText(x: number, y: number, h: number, value: string, w = h): string {
  return `${rotatedOrigin(x, y, h)}^A0R,${h},${w}^FH^FD${zplEscape(value)}^FS`;
}

/** One line of text, `h` tall, in a block `width` wide at landscape (x, y), centred or right-aligned. */
function rotatedBlock(x: number, y: number, width: number, h: number, value: string, align: "C" | "R", reverse = false): string {
  return `${rotatedOrigin(x, y, h)}^FB${width},1,0,${align}^A0R,${h},${h}${reverse ? "^FR" : ""}^FH^FD${zplEscape(value)}^FS`;
}

/** A filled box at landscape (x, y), `width` along the 6 in and `h` down the 4 in. */
function rotatedFill(x: number, y: number, width: number, h: number): string {
  return `${rotatedOrigin(x, y, h)}^GB${h},${width},${Math.min(width, h)}^FS`;
}

/** Code 128 `h` tall at landscape (x, y), `dots` per module, no interpretation line. */
function rotatedBarcode(x: number, y: number, h: number, dots: number, value: string): string {
  return `${rotatedOrigin(x, y, h)}^BY${dots},2,${h}^BCR,${h},N,N,N,A^FH^FD${zplEscape(value)}^FS`;
}

/** An ^A0 capital or digit is at most about this many times the font width wide. */
const A0_CHAR = 0.55;

/** The most characters of a line `h` tall that fit between the margins (29 at 70, 36 at 56, 43 at 48). */
function lineChars(h: number): number {
  return Math.floor((L4X6.width - 2 * L4X6.margin) / (h * A0_CHAR));
}

/**
 * ^A0's width parameter for the 4×6 code: 150 like its height, narrower when
 * a long code would otherwise run into the RTS badge (or past the right
 * margin). The code always stays 150 tall.
 */
export function codeFontWidth4x6(code: string, badge: string | null): number {
  const g = L4X6;
  const end = g.width - g.margin - (badge ? badge.length * A0_CHAR * g.badge + g.badgeGap : 0);
  const room = end - g.margin;
  return Math.max(1, Math.min(g.code, Math.floor(room / (Math.max(1, code.length) * A0_CHAR))));
}

/** The fields of a 4×6 carton label (contract item 2), laid out in landscape dots. */
function carton4x6Fields(m: LabelModel): string[] {
  const g = L4X6;
  const out: string[] = [];
  const top = m.practice ? g.band : 0;
  if (m.practice) {
    out.push(
      rotatedFill(0, 0, g.width, g.band),
      rotatedBlock(0, (g.band - g.bandText) / 2, g.width, g.bandText, PRACTICE_BAND, "C", true),
    );
  }
  const codeY = m.practice ? g.band + g.codeBelowBand : g.margin;
  out.push(rotatedText(g.margin, codeY, g.code, m.code, codeFontWidth4x6(m.code, m.badge)));
  if (m.badge) {
    out.push(rotatedBlock(g.width - g.margin - g.badgeBlock, top + g.badgeTop, g.badgeBlock, g.badge, m.badge, "R"));
  }
  let y = codeY + g.code + g.linesBelowCode;
  m.lines.slice(0, g.lines.length).forEach((line, i) => {
    const h = g.lines[i];
    out.push(rotatedText(g.margin, y, h, truncate(line, lineChars(h))));
    y += h + g.lineGap;
  });
  const humanY = g.height - g.margin - g.human;
  const barY = humanY - g.humanGap - g.bar;
  const dots = moduleDotsFor(m.size, barcodeSvg(m.barcode).modules);
  out.push(rotatedBarcode(g.barX, barY, g.bar, dots, m.barcode), rotatedText(g.margin, humanY, g.human, m.barcode));
  return out;
}

/** ZPL for one label (^XA … ^XZ), printed `copies` times (^PQ). */
export function labelToZpl(m: LabelModel): string {
  const { width, height } = LABEL_INCHES[m.size];
  const w = Math.round(width * LABEL_DPI);
  const h = Math.round(height * LABEL_DPI);
  const out = ["^XA", "^CI28", `^PW${w}`, `^LL${h}`, "^LH0,0"];
  const margin = 30;

  if (m.size === "4x6") {
    out.push(...carton4x6Fields(m));
  } else if (m.size === "3x1") {
    const top = m.practice ? 32 : 0;
    if (m.practice) {
      out.push(`^FO0,0^GB${w},30,30^FS`, centred(w, 4, 24, PRACTICE_BAND, true));
    }
    const codeH = m.practice ? 50 : 62;
    out.push(text(margin, top + 10, codeH, m.code));
    if (m.badge) {
      out.push(`^FO${w - 180},${top + 12}^GB160,40,40^FS`, `^FO${w - 180},${top + 20}^FB160,1,0,C^A0N,28,28^FR^FH^FD${zplEscape(m.badge)}^FS`);
    }
    const wordsY = top + 14 + codeH;
    if (m.lines[0]) out.push(text(margin, wordsY, 24, truncate(m.lines[0], 38)));
    const barY = wordsY + 30;
    out.push(barcode(margin, barY, h - barY - 10, m.barcode));
  } else {
    const top = m.practice ? 40 : 0;
    if (m.practice) {
      out.push(`^FO0,0^GB${w},36,36^FS`, centred(w, 6, 28, PRACTICE_BAND, true));
    }
    out.push(text(margin, top + 12, 70, m.code));
    if (m.badge) out.push(text(w - 220, top + 6, 96, m.badge));
    m.lines.slice(0, 4).forEach((line, i) => out.push(text(margin, top + 92 + i * 34, 28, truncate(line, 44))));
    out.push(barcode(margin, h - 120, 100, m.barcode));
  }
  out.push(`^PQ${labelCopies(m.copies)}`, "^XZ");
  return out.join("\n");
}

/** ZPL for every label of a job, one ^XA … ^XZ block each. */
export function toZpl(payload: LabelPayload): string {
  return labelModels(payload).map(labelToZpl).join("\n");
}

// ---- SVG (browser) ------------------------------------------------------------

export interface BarcodeSvg {
  svg: string;
  /** Code 128 modules across, quiet zones excluded. */
  modules: number;
  /** Printed width at `moduleDots` dots per module (3 unless asked) and 203 dpi. */
  widthMm: number;
}

/**
 * Code 128 as SVG (bwip-js), one viewBox unit per module, bars stretched to
 * the box the caller gives it (preserveAspectRatio none). Size it with
 * `widthMm` so the browser prints the same module width as the thermal path;
 * pass moduleDotsFor(size, modules) for a size that is not 3 dots per module.
 */
export function barcodeSvg(value: string, moduleDots: number = MODULE_DOTS): BarcodeSvg {
  const raw = toSVG({ bcid: "code128", text: value, scale: 1, height: 10, includetext: false });
  const vb = /viewBox="0 0 (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)"/.exec(raw);
  const modules = vb ? Number(vb[1]) : 0;
  const svg = raw.replace("<svg ", '<svg preserveAspectRatio="none" shape-rendering="crispEdges" ');
  return { svg, modules, widthMm: barcodeWidthMm(modules, moduleDots) };
}

/** Printed width of `modules` Code 128 modules at `moduleDots` dots each and 203 dpi, to 0.1 mm. */
function barcodeWidthMm(modules: number, moduleDots: number): number {
  const moduleMm = (moduleDots / LABEL_DPI) * 25.4;
  return Math.round(modules * moduleMm * 10) / 10;
}

/**
 * A label's barcode as SVG, its width at the module the thermal path uses
 * for that size (moduleDotsFor: 5 dots on 4×6, 3 elsewhere), for the browser
 * path and the preview.
 */
export function labelBarcodeSvg(m: Pick<LabelModel, "barcode" | "size">): BarcodeSvg {
  const bar = barcodeSvg(m.barcode);
  const dots = moduleDotsFor(m.size, bar.modules);
  return dots === MODULE_DOTS ? bar : { ...bar, widthMm: barcodeWidthMm(bar.modules, dots) };
}
