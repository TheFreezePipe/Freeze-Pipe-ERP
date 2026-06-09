/**
 * Shared filter shape + helpers for the Change Log data hooks
 * (useInventoryTransactions / useAuditLogs).
 *
 * The Change Log page used to fetch only the latest 500 rows and filter
 * them in the browser, so date/type/SKU filters could never reach events
 * older than the loaded window (with ShipStation volume, ~2-3 days). These
 * filters are now pushed down to the database so filtering searches the
 * FULL history.
 */

export interface ChangeLogFilters {
  /** Inclusive local-day lower bound (yyyy-mm-dd). */
  dateFrom?: string;
  /** Inclusive local-day upper bound (yyyy-mm-dd). */
  dateTo?: string;
  /** Exact transaction_type (inventory) / action (audit). undefined = any. */
  type?: string;
  /** 'system' (null actor), a profile uuid, or undefined = any. */
  userId?: string;
  /** Free text matched across sku/name/notes/type/reference. */
  search?: string;
  /** Max rows to fetch. Defaults to 500 in the hooks. */
  limit?: number;
}

export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Strip characters that would break a PostgREST `or()` filter expression
 * (quotes, parens, commas, asterisks). SKUs/notes searches don't use these,
 * so the loss is harmless and it keeps the generated filter string safe.
 */
export function sanitizeSearch(q: string): string {
  return q.replace(/["(),*]/g, " ").replace(/\s+/g, " ").trim();
}

/** Local start-of-day for a yyyy-mm-dd string, as an ISO timestamp. */
export function dayStartIso(d: string): string {
  return new Date(d + "T00:00:00").toISOString();
}

/** Local end-of-day for a yyyy-mm-dd string, as an ISO timestamp. */
export function dayEndIso(d: string): string {
  return new Date(d + "T23:59:59.999").toISOString();
}

/** Normalize the legacy `number` arg (a bare limit) into a filters object. */
export function toFilters(arg: number | ChangeLogFilters): ChangeLogFilters {
  return typeof arg === "number" ? { limit: arg } : arg;
}
