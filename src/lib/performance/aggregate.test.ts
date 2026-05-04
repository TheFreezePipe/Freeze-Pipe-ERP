import { describe, it, expect } from "vitest";
import {
  filterByRange,
  computeKpis,
  bucketByTime,
  summarizeByEmployee,
  summarizeBySku,
  COMPLETED_TASK_TYPES,
} from "./aggregate";
import { makeRange } from "./date-ranges";
import type { TaskLog } from "@/types/database";

// Fixture factory — keeps tests terse
function log(overrides: Partial<TaskLog & { employee_name?: string; sku_name?: string }> = {}): TaskLog & { employee_name?: string; sku_name?: string } {
  return {
    id: "t" + Math.random(),
    employee_id: "emp1",
    sku_id: "sku1",
    task_type: "emptying",
    quantity_processed: 10,
    time_started: "2026-04-15T10:00:00Z",
    time_completed: "2026-04-15T10:30:00Z",
    notes: null,
    created_at: "2026-04-15T10:30:00Z",
    employee_name: "Alice",
    sku_name: "BW20",
    ...overrides,
  };
}

describe("aggregate / filterByRange", () => {
  it("includes logs whose time_completed falls in [start, end)", () => {
    const logs = [
      log({ time_completed: "2026-04-15T12:00:00Z" }),
      log({ time_completed: "2026-04-20T12:00:00Z" }),
    ];
    const range = makeRange("custom", "2026-04-15", "2026-04-15");
    expect(filterByRange(logs, range)).toHaveLength(1);
  });

  it("excludes logs before the window", () => {
    const logs = [log({ time_completed: "2026-04-10T12:00:00Z" })];
    const range = makeRange("custom", "2026-04-15", "2026-04-16");
    expect(filterByRange(logs, range)).toHaveLength(0);
  });

  it("falls back to created_at when time_completed is null", () => {
    const logs = [log({ time_completed: null, created_at: "2026-04-15T12:00:00Z" })];
    const range = makeRange("custom", "2026-04-15", "2026-04-15");
    expect(filterByRange(logs, range)).toHaveLength(1);
  });
});

describe("aggregate / computeKpis", () => {
  it("unitsCompleted only counts RTSing and prefilled_rtsing", () => {
    const logs = [
      log({ task_type: "emptying", quantity_processed: 50 }),
      log({ task_type: "filling_capping", quantity_processed: 30 }),
      log({ task_type: "rtsing", quantity_processed: 20 }),
      log({ task_type: "prefilled_rtsing", quantity_processed: 100 }),
    ];
    const kpis = computeKpis(logs, new Map());
    expect(kpis.unitsCompleted).toBe(120); // 20 + 100
  });

  it("totalTasks is the raw count", () => {
    const logs = [log(), log(), log()];
    expect(computeKpis(logs, new Map()).totalTasks).toBe(3);
  });

  it("itemsProcessed sums every task's qty regardless of type", () => {
    const logs = [
      log({ quantity_processed: 10 }),
      log({ quantity_processed: 25 }),
      log({ quantity_processed: 7 }),
    ];
    expect(computeKpis(logs, new Map()).itemsProcessed).toBe(42);
  });

  it("avgTasksPerHour divides totalTasks by total labor hours", () => {
    const logs = [log(), log(), log(), log()]; // 4 tasks
    const hours = new Map([
      ["emp1", { hours: 8, source: "homebase" as const }],
    ]);
    const kpis = computeKpis(logs, hours);
    expect(kpis.avgTasksPerHour).toBe(0.5); // 4 tasks / 8 hours
  });

  it("avgTasksPerHour is 0 when no labor hours", () => {
    const logs = [log()];
    expect(computeKpis(logs, new Map()).avgTasksPerHour).toBe(0);
  });

  it("reports laborHoursSource as 'mixed' when multiple sources present", () => {
    const logs = [log({ employee_id: "emp1" }), log({ employee_id: "emp2" })];
    const hours = new Map([
      ["emp1", { hours: 8, source: "homebase" as const }],
      ["emp2", { hours: 4, source: "task_span" as const }],
    ]);
    expect(computeKpis(logs, hours).laborHoursSource).toBe("mixed");
  });
});

describe("aggregate / bucketByTime", () => {
  it("creates seeded buckets for the whole range even with no data", () => {
    const range = makeRange("custom", "2026-04-10", "2026-04-15");
    const buckets = bucketByTime([], range);
    expect(buckets.length).toBe(6); // 6 daily buckets for 6 days
    expect(buckets.every(b => b.total_tasks === 0)).toBe(true);
  });

  it("assigns tasks to the right day bucket", () => {
    const range = makeRange("custom", "2026-04-10", "2026-04-12");
    const logs = [
      log({ time_completed: "2026-04-10T15:00:00Z", quantity_processed: 5 }),
      log({ time_completed: "2026-04-12T15:00:00Z", quantity_processed: 15 }),
    ];
    const buckets = bucketByTime(logs, range);
    expect(buckets[0].total_tasks).toBe(1);
    expect(buckets[0].items_processed).toBe(5);
    expect(buckets[1].total_tasks).toBe(0);
    expect(buckets[2].total_tasks).toBe(1);
    expect(buckets[2].items_processed).toBe(15);
  });

  it("per-bucket byEmployee breakdown tracks each employee", () => {
    // Multi-day range → daily bucketing. Single log at 2026-04-15 lands in
    // the bucket for that day regardless of time-of-day.
    const range = makeRange("custom", "2026-04-14", "2026-04-16");
    const logs = [
      log({ employee_id: "emp1", quantity_processed: 10, task_type: "rtsing",
            time_completed: "2026-04-15T15:00:00Z" }),
      log({ employee_id: "emp2", quantity_processed: 5, task_type: "emptying",
            time_completed: "2026-04-15T15:00:00Z" }),
    ];
    const buckets = bucketByTime(logs, range);
    const apr15 = buckets.find(b => b.key === "2026-04-15")!;
    expect(apr15).toBeDefined();
    expect(Object.keys(apr15.byEmployee).sort()).toEqual(["emp1", "emp2"]);
    expect(apr15.byEmployee.emp1.units_completed).toBe(10);
    expect(apr15.byEmployee.emp2.units_completed).toBe(0); // emptying doesn't count
    expect(apr15.byEmployee.emp2.items_processed).toBe(5);
  });
});

describe("aggregate / summarizeByEmployee", () => {
  it("groups by employee_id and sorts by items_processed desc", () => {
    const logs = [
      log({ employee_id: "emp1", employee_name: "Alice", quantity_processed: 5 }),
      log({ employee_id: "emp2", employee_name: "Bob", quantity_processed: 100 }),
      log({ employee_id: "emp2", employee_name: "Bob", quantity_processed: 50 }),
    ];
    const summary = summarizeByEmployee(logs, new Map());
    expect(summary[0].employeeName).toBe("Bob");
    expect(summary[0].itemsProcessed).toBe(150);
    expect(summary[1].employeeName).toBe("Alice");
  });

  it("tasks are sorted newest-first within each employee", () => {
    const logs = [
      log({ employee_id: "emp1", time_completed: "2026-04-15T08:00:00Z" }),
      log({ employee_id: "emp1", time_completed: "2026-04-15T10:00:00Z" }),
    ];
    const summary = summarizeByEmployee(logs, new Map());
    expect(summary[0].tasks[0].time_completed).toBe("2026-04-15T10:00:00Z");
  });

  it("computes tasksPerHour when hours are provided", () => {
    const logs = [log({ employee_id: "emp1" }), log({ employee_id: "emp1" })];
    const hours = new Map([["emp1", { hours: 4, source: "homebase" as const }]]);
    expect(summarizeByEmployee(logs, hours)[0].tasksPerHour).toBe(0.5);
  });
});

describe("aggregate / summarizeBySku", () => {
  it("groups by sku_id and sorts by items_processed desc", () => {
    const logs = [
      log({ sku_id: "sku-a", sku_name: "BW20", quantity_processed: 10 }),
      log({ sku_id: "sku-b", sku_name: "NB2", quantity_processed: 100 }),
    ];
    const summary = summarizeBySku(logs);
    expect(summary[0].skuName).toBe("NB2");
    expect(summary[0].itemsProcessed).toBe(100);
  });

  it("breaks down quantities by task type", () => {
    const logs = [
      log({ sku_id: "sku-a", task_type: "emptying", quantity_processed: 10 }),
      log({ sku_id: "sku-a", task_type: "rtsing", quantity_processed: 10 }),
    ];
    const bySku = summarizeBySku(logs)[0];
    expect(bySku.byTaskType.emptying).toBe(10);
    expect(bySku.byTaskType.rtsing).toBe(10);
  });
});

describe("aggregate / COMPLETED_TASK_TYPES", () => {
  it("includes exactly RTSing and prefilled_rtsing", () => {
    expect(COMPLETED_TASK_TYPES.sort()).toEqual(["prefilled_rtsing", "rtsing"]);
  });
});
