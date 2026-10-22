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
 */

export type LabelKind = "lpn" | "lpn_rts" | "location" | "station";
export type LabelSize = "4x2" | "3x1";

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
  labels: (LocationLabelData | LpnLabelData)[];
}

/** What one printed label shows, independent of the renderer. */
export interface LabelModel {
  id: string;
  kind: LabelKind;
  size: LabelSize;
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
export const PRACTICE_BAND = "PRACTICE · STAGING";
/** One Code 128 module at 3 dots and 203 dpi, in millimetres (≈ 0.375 mm). */
export const MODULE_MM = (MODULE_DOTS / LABEL_DPI) * 25.4;

export const LABEL_INCHES: Record<LabelSize, { width: number; height: number }> = {
  "4x2": { width: 4, height: 2 },
  "3x1": { width: 3, height: 1 },
};

const BUCKET_WORDS: Record<string, string> = {
  raw: "RAW",
  prefilled_raw: "PREFILLED RAW",
  in_production: "IN PRODUCTION",
  finished: "FINISHED",
  other: "OTHER",
};

const KINDS: LabelKind[] = ["lpn", "lpn_rts", "location", "station"];

export function labelSizeFor(kind: LabelKind): LabelSize {
  return kind === "lpn" || kind === "lpn_rts" ? "4x2" : "3x1";
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
    size: json.size === "4x2" || json.size === "3x1" ? json.size : labelSizeFor(kind),
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

/** The label model for one payload entry. */
export function labelModel(kind: LabelKind, data: LocationLabelData | LpnLabelData, practice: boolean): LabelModel {
  const size = labelSizeFor(kind);
  const barcode = normaliseBarcode(data.barcode, data.code, practice);
  const base = { id: data.id, kind, size, practice, barcode, code: data.code };

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
  return payload.labels.map((l) => labelModel(payload.kind, l, payload.practice));
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

/** ZPL for one label (^XA … ^XZ). */
export function labelToZpl(m: LabelModel): string {
  const { width, height } = LABEL_INCHES[m.size];
  const w = Math.round(width * LABEL_DPI);
  const h = Math.round(height * LABEL_DPI);
  const out = ["^XA", "^CI28", `^PW${w}`, `^LL${h}`, "^LH0,0"];
  const margin = 30;

  if (m.size === "3x1") {
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
  out.push("^PQ1", "^XZ");
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
  /** Printed width at 3 dots per module and 203 dpi. */
  widthMm: number;
}

/**
 * Code 128 as SVG (bwip-js), one viewBox unit per module, bars stretched to
 * the box the caller gives it (preserveAspectRatio none). Size it with
 * `widthMm` so the browser prints the same module width as the thermal path.
 */
export function barcodeSvg(value: string): BarcodeSvg {
  const raw = toSVG({ bcid: "code128", text: value, scale: 1, height: 10, includetext: false });
  const vb = /viewBox="0 0 (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)"/.exec(raw);
  const modules = vb ? Number(vb[1]) : 0;
  const svg = raw.replace("<svg ", '<svg preserveAspectRatio="none" shape-rendering="crispEdges" ');
  return { svg, modules, widthMm: Math.round(modules * MODULE_MM * 10) / 10 };
}
