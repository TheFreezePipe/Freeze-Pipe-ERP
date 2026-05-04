/**
 * Labor hours per employee, for a given date range.
 *
 * Today: computes from task_logs' time_started / time_completed spans, plus
 * mocked Homebase hours for linked users. In production, the Homebase branch
 * hits a cached `labor_hours_daily` rollup (synced via webhooks + nightly
 * reconcile) keyed by (homebase_employee_id, date).
 *
 * Design choices:
 *   - Users with a homebase_employee_id use Homebase hours (more accurate;
 *     includes shift time outside of logged tasks).
 *   - Users without a link fall back to summed task spans — conservative but
 *     defensible (can't claim productivity for time we can't measure).
 *   - The `source` field on each entry lets the UI surface data-provenance.
 */

import type { TaskLog } from "@/types/database";
import type { DateRange } from "./date-ranges";

export type LaborHoursSource = "homebase" | "task_span";

export interface LaborHoursEntry {
  hours: number;
  source: LaborHoursSource;
}

/**
 * Returns a Map from employee_id → { hours, source } covering every employee
 * who appears in `filteredLogs`.
 *
 * Currently uses task time spans as the labor hours source. When a Homebase
 * integration is available, this can be swapped to query the `labor_hours_daily`
 * rollup table keyed by (homebase_employee_id, date).
 */
export function computeLaborHours(
  filteredLogs: TaskLog[],
  _range: DateRange
): Map<string, LaborHoursEntry> {
  const result = new Map<string, LaborHoursEntry>();

  const touchedEmployeeIds = new Set<string>(filteredLogs.map(t => t.employee_id));

  for (const employeeId of touchedEmployeeIds) {
    result.set(employeeId, {
      hours: sumTaskSpans(filteredLogs.filter(t => t.employee_id === employeeId)),
      source: "task_span",
    });
  }

  return result;
}

/** Sum of (time_completed - time_started) across tasks, in hours. */
function sumTaskSpans(logs: TaskLog[]): number {
  let ms = 0;
  for (const t of logs) {
    if (!t.time_started || !t.time_completed) continue;
    const dur = Date.parse(t.time_completed) - Date.parse(t.time_started);
    if (dur > 0) ms += dur;
  }
  return ms / 3_600_000;
}
