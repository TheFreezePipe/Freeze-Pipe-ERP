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
