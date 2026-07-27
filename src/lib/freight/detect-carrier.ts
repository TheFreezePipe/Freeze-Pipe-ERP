/**
 * Carrier auto-detection from tracking-number format.
 *
 * The system only tracks the three US final-mile carriers at the
 * carrier_name level (FedEx / UPS / DHL — the ocean line is implied by
 * freight_type='sea'), and their formats are distinctive enough for
 * near-certain detection:
 *   UPS   — "1Z" + 16 alphanumerics (the 1Z prefix is unique to UPS)
 *   FedEx — 12 or 15 digits (Express/Ground), or 20/22 digits
 *           (Ground barcodes / SmartPost, typically starting 92/96)
 *   DHL   — 10 digits (Express waybill)
 * Anything else returns null and the operator picks manually.
 */
export type DetectedCarrier = "FedEx" | "UPS" | "DHL";

export function detectCarrier(raw: string): DetectedCarrier | null {
  const t = raw.trim().toUpperCase().replace(/\s+/g, "");
  if (!t) return null;
  if (/^1Z[0-9A-Z]{16}$/.test(t)) return "UPS";
  if (/^\d{10}$/.test(t)) return "DHL";
  if (/^\d{12}$/.test(t) || /^\d{15}$/.test(t)) return "FedEx";
  if (/^\d{20}$/.test(t) || /^\d{22}$/.test(t)) return "FedEx";
  return null;
}
