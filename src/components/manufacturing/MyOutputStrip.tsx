import { useMemo } from "react";
import { Link } from "react-router-dom";
import { TrendingUp, ChevronRight } from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { useTaskLogs } from "@/lib/hooks";

const ymdLocal = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/**
 * Compact personal-output banner for the Workspace: today + this week
 * (Monday-start, local time — matches how the crew thinks about shifts).
 * Same task_logs data the Performance page aggregates, filtered to the
 * signed-in employee; clicking through lands on the full Performance page
 * (staff default to the "Just me" scope there).
 */
export function MyOutputStrip() {
  const { profile } = useAuth();
  const { data: logs = [] } = useTaskLogs();

  const stats = useMemo(() => {
    if (!profile?.id) return null;
    const now = new Date();
    const todayKey = ymdLocal(now);
    const monday = new Date(now);
    monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
    monday.setHours(0, 0, 0, 0);
    let today = 0;
    let week = 0;
    let weekTasks = 0;
    for (const l of logs) {
      if (l.employee_id !== profile.id) continue;
      const doneIso = l.time_completed ?? l.created_at;
      if (!doneIso) continue;
      const done = new Date(doneIso);
      const qty = l.quantity_processed ?? 0;
      if (done >= monday) {
        week += qty;
        weekTasks += 1;
      }
      if (ymdLocal(done) === todayKey) today += qty;
    }
    return { today, week, weekTasks };
  }, [logs, profile?.id]);

  if (!stats) return null;

  return (
    <Link
      to="/manufacturing/performance"
      className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 transition-colors hover:border-primary/40 hover:bg-muted/40"
    >
      <TrendingUp className="h-4 w-4 shrink-0 text-green-400" />
      <div className="flex flex-1 flex-wrap items-baseline gap-x-4 gap-y-0.5 text-sm">
        <span className="font-medium">My output</span>
        <span className="text-muted-foreground">
          Today <span className="font-semibold tabular-nums text-foreground">{stats.today.toLocaleString()}</span> items
        </span>
        <span className="text-muted-foreground">
          This week{" "}
          <span className="font-semibold tabular-nums text-foreground">{stats.week.toLocaleString()}</span> items ·{" "}
          <span className="tabular-nums">{stats.weekTasks}</span> tasks
        </span>
      </div>
      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
    </Link>
  );
}
