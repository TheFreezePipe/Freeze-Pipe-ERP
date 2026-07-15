import { useState, useMemo } from "react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend } from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Layers } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ChartMetric, TimeBucket } from "@/lib/performance/aggregate";

interface Props {
  data: TimeBucket[];
  rangeLabel: string;
  /** Card heading override — e.g. "My Performance Over Time" in personal scope. */
  title?: string;
  /** Personal scope: hide the stack-by-employee control (meaningless for one person). */
  hideStackToggle?: boolean;
}

const METRICS: { key: ChartMetric; label: string; color: string }[] = [
  { key: "units_completed", label: "Units Completed", color: "hsl(142,71%,45%)" },
  { key: "total_tasks", label: "Total Tasks", color: "hsl(205,94%,56%)" },
  { key: "items_processed", label: "Items Processed", color: "hsl(31,97%,56%)" },
];

/** Distinct, high-contrast palette for stacked employee segments. Sorted
 *  employee names are assigned in order for stable per-employee colors within
 *  a single render. */
const EMPLOYEE_PALETTE = [
  "hsl(205,94%,56%)", // blue
  "hsl(142,71%,45%)", // green
  "hsl(31,97%,56%)",  // orange
  "hsl(270,67%,56%)", // purple
  "hsl(335,80%,60%)", // pink
  "hsl(180,65%,50%)", // teal
  "hsl(50,95%,55%)",  // yellow
  "hsl(0,75%,60%)",   // red
];

export function TeamPerformanceChart({ data, rangeLabel, title, hideStackToggle }: Props) {
  // Default to Items Processed — the number the whole crew recognizes
  // (owner request 2026-07-15); Units Completed is one click away.
  const [metric, setMetric] = useState<ChartMetric>("items_processed");
  const [stackByEmployee, setStackByEmployee] = useState(false);
  // Effective stacking: a leader can toggle stack on in Team view then flip
  // to a personal scope — the hidden control must also neutralize the state.
  const stacking = stackByEmployee && !hideStackToggle;
  const active = METRICS.find(m => m.key === metric)!;

  const hasData = data.some(b => b[metric] > 0);

  /** List of employees present in the range, alphabetized for stable color order. */
  const employees = useMemo(() => {
    const seen = new Map<string, string>(); // id -> name
    for (const bucket of data) {
      for (const emp of Object.values(bucket.byEmployee)) {
        if (!seen.has(emp.employeeId)) seen.set(emp.employeeId, emp.employeeName);
      }
    }
    return Array.from(seen.entries())
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [data]);

  /** When stacked: flatten per-employee values into top-level keys on each row
   *  so recharts can use them as dataKey on individual <Bar> components. */
  const chartData = useMemo(() => {
    if (!stacking) return data;
    return data.map(b => {
      const row: Record<string, number | string> = { key: b.key, label: b.label };
      for (const emp of employees) {
        row[emp.id] = b.byEmployee[emp.id]?.[metric] ?? 0;
      }
      return row;
    });
  }, [data, stacking, employees, metric]);

  const stackDisabled = employees.length < 2;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div>
            <CardTitle className="text-base">{title ?? "Team Performance Over Time"}</CardTitle>
            <p className="text-xs text-muted-foreground mt-0.5">{rangeLabel}</p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {/* Metric switcher */}
            <div className="flex items-center gap-1 rounded-md border border-border bg-muted/30 p-0.5">
              {METRICS.map(m => (
                <button
                  key={m.key}
                  type="button"
                  onClick={() => setMetric(m.key)}
                  className={cn(
                    "px-2.5 py-1 text-xs font-medium rounded transition-colors",
                    metric === m.key
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  {m.label}
                </button>
              ))}
            </div>

            {/* Stack-by-employee toggle — hidden entirely in personal scope */}
            {!hideStackToggle && (
            <button
              type="button"
              disabled={stackDisabled}
              onClick={() => setStackByEmployee(v => !v)}
              title={stackDisabled ? "Stacking requires at least 2 employees in range" : undefined}
              className={cn(
                "flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors",
                stackByEmployee
                  ? "border-primary/60 bg-primary/10 text-primary"
                  : "border-border bg-muted/30 text-muted-foreground hover:text-foreground hover:bg-muted/60",
                stackDisabled && "opacity-50 cursor-not-allowed"
              )}
            >
              <Layers className="h-3 w-3" />
              Stack by employee
            </button>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {hasData ? (
          <ResponsiveContainer width="100%" height={stacking ? 320 : 280}>
            <BarChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid stroke="hsl(0,0%,16%)" strokeDasharray="3 3" vertical={false} />
              <XAxis
                dataKey="label"
                tick={{ fontSize: 11, fill: "hsl(0,0%,55%)" }}
                interval="preserveStartEnd"
              />
              <YAxis
                tick={{ fontSize: 11, fill: "hsl(0,0%,55%)" }}
                width={36}
                allowDecimals={false}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: "hsl(0,0%,10%)",
                  border: "1px solid hsl(0,0%,18%)",
                  borderRadius: 8,
                  color: "hsl(0,0%,95%)",
                  fontSize: 12,
                }}
                labelFormatter={(l) => l}
                // In stacked mode, recharts already shows each series; in aggregate mode, label the single bar.
                formatter={stacking
                  ? (value: number, key: string) => {
                      const emp = employees.find(e => e.id === key);
                      return [value.toLocaleString(), emp?.name ?? key];
                    }
                  : (value: number) => [value.toLocaleString(), active.label]
                }
              />
              {stacking && (
                <Legend
                  wrapperStyle={{ fontSize: 11, paddingTop: 8 }}
                  iconSize={10}
                  formatter={(value: string) => {
                    const emp = employees.find(e => e.id === value);
                    return emp?.name ?? value;
                  }}
                />
              )}
              {stacking
                ? employees.map((emp, i) => (
                    <Bar
                      key={emp.id}
                      dataKey={emp.id}
                      stackId="employees"
                      fill={EMPLOYEE_PALETTE[i % EMPLOYEE_PALETTE.length]}
                      radius={i === employees.length - 1 ? [3, 3, 0, 0] : 0}
                    />
                  ))
                : <Bar dataKey={metric} fill={active.color} radius={[3, 3, 0, 0]} />
              }
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <div className="flex h-[280px] items-center justify-center text-sm text-muted-foreground">
            No {active.label.toLowerCase()} recorded in this range
          </div>
        )}
      </CardContent>
    </Card>
  );
}
