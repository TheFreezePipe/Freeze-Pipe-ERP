/**
 * Pure aggregation functions for the Performance dashboard.
 *
 * Each function takes task logs + a date range and returns a plain data shape.
 * No side effects, no React state — easy to test, easy to adapt for CSV export.
 *
 * The whole page's data flow is:
 *   rawLogs ──filterByRange──▶ filtered ──▶ { kpis, buckets, byEmployee, bySku }
 */

import type { TaskLog } from "@/types/database";
import type { DateRange, BucketGranularity } from "./date-ranges";
import { ymdInET, hourInET, addDays, diffDays, pickGranularity } from "./date-ranges";

type TaskLogExt = TaskLog & { employee_name?: string; sku_name?: string };
export type TaskType = TaskLog["task_type"];

/** Task types that represent "units completed" (ready to ship). */
export const COMPLETED_TASK_TYPES: TaskType[] = ["rtsing", "prefilled_rtsing"];

// --- Filtering --------------------------------------------------------------

export function filterByRange(logs: TaskLogExt[], range: DateRange): TaskLogExt[] {
  const startMs = Date.parse(range.startIso);
  const endMs = Date.parse(range.endIso);
  return logs.filter(t => {
    // Use time_completed if present (what actually happened), else created_at.
    const t0 = t.time_completed ?? t.created_at;
    if (!t0) return false;
    const ms = Date.parse(t0);
    return ms >= startMs && ms < endMs;
  });
}

// --- KPI card calculations --------------------------------------------------

export interface KpiValues {
  unitsCompleted: number;  // sum of qty on RTSing + Pre-Filled RTSing
  totalTasks: number;      // count of all tasks in range
  itemsProcessed: number;  // sum of qty across all task types
  avgTasksPerHour: number; // totalTasks / totalLaborHours (team-weighted)
  totalLaborHours: number; // for display in tooltip
  laborHoursSource: "homebase" | "task_span" | "mixed";
}

/**
 * @param labourHoursByEmployee  Map from employee_id → hours worked in range.
 *                               If an employee isn't in the map, their hours
 *                               fall back to their summed task spans.
 */
export function computeKpis(
  filtered: TaskLogExt[],
  labourHoursByEmployee: Map<string, { hours: number; source: "homebase" | "task_span" }>
): KpiValues {
  let unitsCompleted = 0;
  let itemsProcessed = 0;
  for (const t of filtered) {
    itemsProcessed += t.quantity_processed;
    if (COMPLETED_TASK_TYPES.includes(t.task_type)) {
      unitsCompleted += t.quantity_processed;
    }
  }

  let totalHours = 0;
  const sources = new Set<"homebase" | "task_span">();
  for (const { hours, source } of labourHoursByEmployee.values()) {
    totalHours += hours;
    sources.add(source);
  }

  const laborHoursSource: KpiValues["laborHoursSource"] =
    sources.size === 0 ? "task_span" :
    sources.size > 1 ? "mixed" :
    sources.has("homebase") ? "homebase" : "task_span";

  return {
    unitsCompleted,
    totalTasks: filtered.length,
    itemsProcessed,
    avgTasksPerHour: totalHours > 0 ? filtered.length / totalHours : 0,
    totalLaborHours: totalHours,
    laborHoursSource,
  };
}

// --- Time-bucketed chart data -----------------------------------------------

export type ChartMetric = "units_completed" | "total_tasks" | "items_processed";

export interface EmployeeBucketValues {
  employeeId: string;
  employeeName: string;
  units_completed: number;
  total_tasks: number;
  items_processed: number;
}

export interface TimeBucket {
  /** Sort key: ISO-ish string usable as a dict key. */
  key: string;
  /** Short display label for the X axis. */
  label: string;
  units_completed: number;
  total_tasks: number;
  items_processed: number;
  /** Per-employee breakdown keyed by employee_id. Used when the chart is
   *  rendered in "stack by employee" mode. */
  byEmployee: Record<string, EmployeeBucketValues>;
}

export function bucketByTime(filtered: TaskLogExt[], range: DateRange): TimeBucket[] {
  const granularity = pickGranularity(range);
  const buckets = new Map<string, TimeBucket>();

  // Seed empty buckets for the full range so the chart has continuous bars.
  for (const key of enumerateBuckets(range, granularity)) {
    buckets.set(key.key, {
      ...key,
      units_completed: 0,
      total_tasks: 0,
      items_processed: 0,
      byEmployee: {},
    });
  }

  for (const t of filtered) {
    const ts = t.time_completed ?? t.created_at;
    if (!ts) continue;
    const key = bucketKeyFor(ts, granularity);
    const bucket = buckets.get(key);
    if (!bucket) continue; // shouldn't happen, but guards against off-by-one
    bucket.total_tasks += 1;
    bucket.items_processed += t.quantity_processed;
    if (COMPLETED_TASK_TYPES.includes(t.task_type)) {
      bucket.units_completed += t.quantity_processed;
    }

    // Per-employee tally for stacked rendering.
    let emp = bucket.byEmployee[t.employee_id];
    if (!emp) {
      emp = {
        employeeId: t.employee_id,
        employeeName: t.employee_name ?? t.employee_id,
        units_completed: 0,
        total_tasks: 0,
        items_processed: 0,
      };
      bucket.byEmployee[t.employee_id] = emp;
    }
    emp.total_tasks += 1;
    emp.items_processed += t.quantity_processed;
    if (COMPLETED_TASK_TYPES.includes(t.task_type)) {
      emp.units_completed += t.quantity_processed;
    }
  }

  return Array.from(buckets.values());
}

function bucketKeyFor(iso: string, g: BucketGranularity): string {
  const d = new Date(iso);
  if (g === "hourly") {
    const ymd = ymdInET(d);
    const hour = hourInET(d).toString().padStart(2, "0");
    return `${ymd}T${hour}`;
  }
  if (g === "daily") {
    return ymdInET(d);
  }
  // weekly — anchor on the ET date of the Monday of the week
  const ymd = ymdInET(d);
  return mondayOf(ymd);
}

function enumerateBuckets(range: DateRange, g: BucketGranularity): { key: string; label: string }[] {
  const out: { key: string; label: string }[] = [];
  if (g === "hourly") {
    // Single-day or two-day hourly — just 0-23 for each day in the range.
    const days = diffDays(range.toYmd, range.fromYmd) + 1;
    for (let di = 0; di < days; di++) {
      const ymd = addDays(range.fromYmd, di);
      for (let h = 0; h < 24; h++) {
        const key = `${ymd}T${h.toString().padStart(2, "0")}`;
        const label = days === 1
          ? `${h % 12 === 0 ? 12 : h % 12}${h < 12 ? "a" : "p"}`
          : `${ymd.slice(5)} ${h.toString().padStart(2, "0")}h`;
        out.push({ key, label });
      }
    }
    return out;
  }
  if (g === "daily") {
    const days = diffDays(range.toYmd, range.fromYmd) + 1;
    for (let i = 0; i < days; i++) {
      const ymd = addDays(range.fromYmd, i);
      out.push({ key: ymd, label: shortDateLabel(ymd) });
    }
    return out;
  }
  // weekly
  let cursor = mondayOf(range.fromYmd);
  const end = range.toYmd;
  while (cursor <= end) {
    out.push({ key: cursor, label: `Wk of ${shortDateLabel(cursor)}` });
    cursor = addDays(cursor, 7);
  }
  return out;
}

function mondayOf(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const dow = date.getUTCDay(); // 0=Sun..6=Sat
  const toMonday = dow === 0 ? -6 : 1 - dow;
  return addDays(ymd, toMonday);
}

function shortDateLabel(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

// --- By-employee leaderboard ------------------------------------------------

export interface EmployeeSummary {
  employeeId: string;
  employeeName: string;
  totalTasks: number;
  itemsProcessed: number;
  unitsCompleted: number;
  /** Per-task-type breakdown for the badge row. */
  byTaskType: Record<TaskType, number>;
  /** Full list of tasks (for the popup). */
  tasks: TaskLogExt[];
  laborHours: number;
  laborHoursSource: "homebase" | "task_span";
  tasksPerHour: number;
}

export function summarizeByEmployee(
  filtered: TaskLogExt[],
  labourHoursByEmployee: Map<string, { hours: number; source: "homebase" | "task_span" }>
): EmployeeSummary[] {
  const map = new Map<string, EmployeeSummary>();

  for (const t of filtered) {
    let s = map.get(t.employee_id);
    if (!s) {
      const hours = labourHoursByEmployee.get(t.employee_id);
      s = {
        employeeId: t.employee_id,
        employeeName: t.employee_name ?? t.employee_id,
        totalTasks: 0,
        itemsProcessed: 0,
        unitsCompleted: 0,
        byTaskType: { emptying: 0, filling_capping: 0, rtsing: 0, prefilled_rtsing: 0 },
        tasks: [],
        laborHours: hours?.hours ?? 0,
        laborHoursSource: hours?.source ?? "task_span",
        tasksPerHour: 0,
      };
      map.set(t.employee_id, s);
    }
    s.totalTasks += 1;
    s.itemsProcessed += t.quantity_processed;
    s.byTaskType[t.task_type] += t.quantity_processed;
    if (COMPLETED_TASK_TYPES.includes(t.task_type)) {
      s.unitsCompleted += t.quantity_processed;
    }
    s.tasks.push(t);
  }

  // Finalize: tasks-per-hour + sort tasks chronologically (newest first).
  for (const s of map.values()) {
    s.tasksPerHour = s.laborHours > 0 ? s.totalTasks / s.laborHours : 0;
    s.tasks.sort((a, b) => (b.time_completed ?? b.created_at ?? "").localeCompare(a.time_completed ?? a.created_at ?? ""));
  }

  return Array.from(map.values()).sort((a, b) => b.itemsProcessed - a.itemsProcessed);
}

// --- By-SKU insights --------------------------------------------------------

export interface SkuSummary {
  skuId: string;
  skuName: string;
  totalTasks: number;
  itemsProcessed: number;
  byTaskType: Record<TaskType, number>;
  tasks: TaskLogExt[];
}

export function summarizeBySku(filtered: TaskLogExt[]): SkuSummary[] {
  const map = new Map<string, SkuSummary>();
  for (const t of filtered) {
    let s = map.get(t.sku_id);
    if (!s) {
      s = {
        skuId: t.sku_id,
        skuName: t.sku_name ?? t.sku_id,
        totalTasks: 0,
        itemsProcessed: 0,
        byTaskType: { emptying: 0, filling_capping: 0, rtsing: 0, prefilled_rtsing: 0 },
        tasks: [],
      };
      map.set(t.sku_id, s);
    }
    s.totalTasks += 1;
    s.itemsProcessed += t.quantity_processed;
    s.byTaskType[t.task_type] += t.quantity_processed;
    s.tasks.push(t);
  }
  for (const s of map.values()) {
    s.tasks.sort((a, b) => (b.time_completed ?? b.created_at ?? "").localeCompare(a.time_completed ?? a.created_at ?? ""));
  }
  return Array.from(map.values()).sort((a, b) => b.itemsProcessed - a.itemsProcessed);
}
