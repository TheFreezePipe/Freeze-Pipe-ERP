/**
 * Optimistic concurrency control helpers.
 *
 * In production, every UPDATE against a versioned table must include the
 * expected `row_version` in its WHERE clause. Supabase's JS client does
 * this naturally:
 *
 *   const { data, error } = await supabase
 *     .from("product_skus")
 *     .update({ retail_price: 49.99 })
 *     .eq("id", skuId)
 *     .eq("row_version", expectedVersion)
 *     .select();
 *
 *   if (!error && data.length === 0) {
 *     // 0 rows affected means another writer got there first
 *     throw new ConcurrencyConflictError();
 *   }
 *
 * This module provides a typed wrapper that codifies the pattern so it's
 * impossible to forget the version predicate, plus demo-mode parity that
 * mimics the behavior against module-level arrays.
 */

export class ConcurrencyConflictError extends Error {
  readonly table: string;
  readonly id: string;
  readonly expectedVersion: number;
  readonly actualVersion: number;

  constructor(
    table: string,
    id: string,
    expectedVersion: number,
    actualVersion: number,
  ) {
    super(
      `Concurrency conflict on ${table}#${id}: expected row_version ${expectedVersion}, ` +
      `but row is at ${actualVersion}. Another user likely modified this record. ` +
      `Reload and reapply your changes.`,
    );
    this.table = table;
    this.id = id;
    this.expectedVersion = expectedVersion;
    this.actualVersion = actualVersion;
    this.name = "ConcurrencyConflictError";
  }
}

export interface VersionedRow {
  id: string;
  row_version: number;
}

/**
 * Demo-mode: apply an update to an in-memory row, but refuse if the caller's
 * expected_version doesn't match the current. Bumps the version on success.
 *
 * Real code path (behind the same signature) calls Supabase with the
 * version predicate and translates a 0-rows result into the same error.
 */
export function updateWithVersion<T extends VersionedRow>(
  row: T,
  expectedVersion: number,
  changes: Partial<Omit<T, "id" | "row_version">>,
  opts: { table: string }
): T {
  if (row.row_version !== expectedVersion) {
    throw new ConcurrencyConflictError(opts.table, row.id, expectedVersion, row.row_version);
  }
  Object.assign(row, changes);
  row.row_version = row.row_version + 1;
  return row;
}

/**
 * Supabase update with optimistic concurrency guard.
 *
 * Usage:
 *   await supabaseUpdateWithVersion(supabase, "product_skus", id, expectedVersion, { retail_price: 49.99 });
 *
 * Translates "0 rows affected" (another writer modified the row first)
 * into a ConcurrencyConflictError so the caller can prompt the user to
 * reload. Not throwing on this case would silently clobber concurrent edits.
 *
 * If the caller omits `expectedVersion`, the guard is skipped — use only
 * for fields that are genuinely safe last-write-wins (e.g., a metadata
 * column that can't cause data loss).
 */
export async function supabaseUpdateWithVersion(
  supabase: { from: (t: string) => any },
  table: string,
  id: string,
  expectedVersion: number | null,
  updates: Record<string, unknown>,
): Promise<any> {
  let query = supabase.from(table).update(updates).eq("id", id);
  if (expectedVersion !== null) {
    query = query.eq("row_version", expectedVersion);
  }
  const { data, error } = await query.select().single();
  if (error) {
    // PGRST116 = "No rows returned" from .single() — treat as version mismatch.
    if (error.code === "PGRST116" && expectedVersion !== null) {
      // Fetch actual version so the error tells the user which version they're stale against.
      const { data: fresh } = await supabase
        .from(table)
        .select("row_version")
        .eq("id", id)
        .maybeSingle();
      throw new ConcurrencyConflictError(
        table, id, expectedVersion,
        (fresh as { row_version?: number } | null)?.row_version ?? -1,
      );
    }
    throw error;
  }
  return data;
}
