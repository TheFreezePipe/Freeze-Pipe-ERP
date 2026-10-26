/**
 * Client-side hint for what a scanned value is. The server
 * (rpc_wh_resolve_scan) decides; this only routes the UI.
 *
 * Every ERP-printed barcode is "%" + the human code (§4.3): "%Z" marks a
 * practice label, "%C-" a carton, anything else after "%" a location.
 * ShipStation packing slips encode the order id as ^#^HEX^.
 */
export type ScanKind = "location" | "carton" | "practice" | "order" | "gtin" | "sku";

export interface ParsedScan {
  kind: ScanKind;
  value: string;
}

const ORDER_RE = /^\^#\^([0-9A-F]+)\^$/;
const GTIN_LENGTHS = new Set([6, 7, 8, 11, 12, 13]);

export function parseScan(raw: string): ParsedScan {
  const value = raw.trim();
  if (value.startsWith("%Z")) return { kind: "practice", value: value.slice(2) };
  if (value.startsWith("%C-")) return { kind: "carton", value: value.slice(1) };
  if (value.startsWith("%")) return { kind: "location", value: value.slice(1) };
  const order = ORDER_RE.exec(value);
  if (order) return { kind: "order", value: order[1] };
  if (/^\d+$/.test(value) && GTIN_LENGTHS.has(value.length)) return { kind: "gtin", value };
  return { kind: "sku", value };
}

const STATION_RE = /^%Z?(ST-[A-Z0-9]+(?:-[A-Z0-9]+)*)$/;
const CARTON_RE = /^(?:%Z?)?(C-[A-Z0-9]+(?:-[A-Z0-9]+)*)$/;
const BAY_RE = /^(\d{2})-(\d{2})-(\d)$/;

/**
 * A station label ("%ST-MFG-1", or "%ZST-MFG-1" printed in practice mode)
 * starts a station session wherever a ScanSink is live (§5.5). Returns the
 * station code, or null for anything else.
 */
export function stationCode(raw: string): string | null {
  const m = STATION_RE.exec(raw.trim().toUpperCase());
  return m ? m[1] : null;
}

/**
 * The carton code of an LPN scan: "%C-466-007", the practice "%ZC-466-007"
 * or the code typed without the prefix. Upper-cased; null for anything else.
 */
export function cartonCode(raw: string): string | null {
  const m = CARTON_RE.exec(raw.trim().toUpperCase());
  return m ? m[1] : null;
}

export interface BayParts {
  face: string;
  bay: string;
  level: string;
}

/** "02-01-3" → { face: "02", bay: "01", level: "3" }; named codes (IN-01, ST-DOCK) → null. */
export function bayParts(code: string | null | undefined): BayParts | null {
  const m = BAY_RE.exec((code ?? "").trim());
  return m ? { face: m[1], bay: m[2], level: m[3] } : null;
}

/** "02-01-3" → "Face 02 · Bay 01 · Level 3" (the label's words line); null for named codes. */
export function bayWords(code: string | null | undefined): string | null {
  const p = bayParts(code);
  return p ? `Face ${p.face} · Bay ${p.bay} · Level ${p.level}` : null;
}
