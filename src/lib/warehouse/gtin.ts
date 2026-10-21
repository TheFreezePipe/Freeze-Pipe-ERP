/**
 * GTIN candidate expansion — the TypeScript twin of the database's
 * fn_gtin_candidates(p_scan text). Both must implement the same table
 * (WAREHOUSE_MODULE_PHASE0_1.md §3.6) so a code normalised in the browser
 * matches what rpc_wh_resolve_scan looks up.
 *
 * Non-digits are stripped first, then by length:
 *   13  EAN-13; a leading 0 means UPC-A, so the 12 digits after it, else the 13
 *   12  UPC-A as scanned; when its check digit is wrong, also the corrected 12
 *   11  UPC-A without its check digit: append it
 *    8  number system 0/1: UPC-E with check → [expanded GTIN-12, raw 8];
 *       otherwise EAN-8 → [raw 8]
 *    7  UPC-E without check: NS + 6-digit body → [expanded GTIN-12]
 *    6  UPC-E body only, NS 0 → [expanded GTIN-12]
 * Any other length yields no candidates.
 */

function digitsOnly(value: string): string {
  return value.replace(/\D/g, "");
}

/** UPC-A check digit for 11 digits: odd positions ×3 plus even positions. */
export function upcaCheckDigit(d11: string): number {
  const digits = digitsOnly(d11);
  if (digits.length !== 11) {
    throw new Error(`upcaCheckDigit needs 11 digits, got ${digits.length}`);
  }
  let sum = 0;
  for (let i = 0; i < 11; i++) {
    const d = digits.charCodeAt(i) - 48;
    // Position i + 1 is odd when i is even.
    sum += i % 2 === 0 ? d * 3 : d;
  }
  return (10 - (sum % 10)) % 10;
}

/**
 * Expand a UPC-E body (6 digits) under number system `ns` to the full
 * 12-digit GTIN-12, check digit included. Keys on the last body digit d6:
 *   0-2 → NS d1 d2 d6 0000 d3 d4 d5
 *   3   → NS d1 d2 d3 00000 d4 d5
 *   4   → NS d1 d2 d3 d4 00000 d5
 *   5-9 → NS d1 d2 d3 d4 d5 0000 d6
 */
export function expandUpcE(ns: string | number, body6: string): string {
  const nsDigit = String(ns);
  const body = digitsOnly(body6);
  if (!/^\d$/.test(nsDigit)) throw new Error(`expandUpcE needs a one-digit number system, got "${nsDigit}"`);
  if (body.length !== 6) throw new Error(`expandUpcE needs a 6-digit body, got ${body.length}`);
  const [d1, d2, d3, d4, d5, d6] = body;
  let d11: string;
  if (d6 <= "2") {
    d11 = `${nsDigit}${d1}${d2}${d6}0000${d3}${d4}${d5}`;
  } else if (d6 === "3") {
    d11 = `${nsDigit}${d1}${d2}${d3}00000${d4}${d5}`;
  } else if (d6 === "4") {
    d11 = `${nsDigit}${d1}${d2}${d3}${d4}00000${d5}`;
  } else {
    d11 = `${nsDigit}${d1}${d2}${d3}${d4}${d5}0000${d6}`;
  }
  return `${d11}${upcaCheckDigit(d11)}`;
}

/** Every normalised code a scan could stand for, most likely first, no duplicates. */
export function gtinCandidates(scan: string): string[] {
  const d = digitsOnly(scan);
  const out: string[] = [];
  const add = (code: string) => {
    if (!out.includes(code)) out.push(code);
  };

  switch (d.length) {
    case 13:
      add(d.startsWith("0") ? d.slice(1) : d);
      break;
    case 12: {
      add(d);
      const corrected = `${d.slice(0, 11)}${upcaCheckDigit(d.slice(0, 11))}`;
      add(corrected);
      break;
    }
    case 11:
      add(`${d}${upcaCheckDigit(d)}`);
      break;
    case 8:
      if (d[0] === "0" || d[0] === "1") {
        add(expandUpcE(d[0], d.slice(1, 7)));
      }
      add(d);
      break;
    case 7:
      add(expandUpcE(d[0], d.slice(1, 7)));
      break;
    case 6:
      add(expandUpcE(0, d));
      break;
    default:
      break;
  }
  return out;
}
