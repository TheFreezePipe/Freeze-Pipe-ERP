import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useSales, useLaunches, useBroadcasts } from "@/lib/hooks";
import { EVENT_TYPE_COLOR } from "@/lib/marketing-format";
import {
  startOfMonth,
  endOfMonth,
  startOfWeek,
  endOfWeek,
  eachDayOfInterval,
  addMonths,
  subMonths,
  format,
  parseISO,
  isSameMonth,
  isSameDay,
} from "date-fns";

type Ev = { id: string; type: "sale" | "launch" | "broadcast"; label: string; to: string };
const KEY = "yyyy-MM-dd";

function safeParse(d: string | null): Date | null {
  if (!d) return null;
  try { return parseISO(d); } catch { return null; }
}

export default function MarketingCalendar() {
  const navigate = useNavigate();
  const { data: sales = [] } = useSales();
  const { data: launches = [] } = useLaunches();
  const { data: broadcasts = [] } = useBroadcasts();
  const [month, setMonth] = useState(() => startOfMonth(new Date()));
  const today = new Date();

  // Map each calendar day → its events.
  const byDay = useMemo(() => {
    const m = new Map<string, Ev[]>();
    const push = (day: string, ev: Ev) => {
      const arr = m.get(day) ?? [];
      arr.push(ev);
      m.set(day, arr);
    };

    for (const s of sales) {
      const start = safeParse(s.starts_at);
      if (!start) continue;
      const end = safeParse(s.ends_at) ?? start;
      if (end < start) continue;
      for (const d of eachDayOfInterval({ start, end })) {
        push(format(d, KEY), { id: s.id, type: "sale", label: s.name, to: `/marketing/sales/${s.id}` });
      }
    }
    for (const l of launches) {
      const d = safeParse(l.launch_date);
      if (!d) continue;
      const label = l.product?.sku || l.planned_name || "Launch";
      push(format(d, KEY), { id: l.id, type: "launch", label, to: "/marketing/launches" });
    }
    for (const b of broadcasts) {
      const d = safeParse(b.sent_at) ?? safeParse(b.scheduled_at);
      if (!d) continue;
      push(format(d, KEY), { id: b.id, type: "broadcast", label: b.name, to: "/marketing/broadcasts" });
    }
    return m;
  }, [sales, launches, broadcasts]);

  const days = useMemo(
    () =>
      eachDayOfInterval({
        start: startOfWeek(startOfMonth(month)),
        end: endOfWeek(endOfMonth(month)),
      }),
    [month],
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Marketing Calendar</h1>
          <p className="text-muted-foreground">Sales, launches &amp; broadcasts at a glance</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-4 text-xs text-muted-foreground">
            <Legend color={EVENT_TYPE_COLOR.sale} label="Sale" />
            <Legend color={EVENT_TYPE_COLOR.launch} label="Launch" />
            <Legend color={EVENT_TYPE_COLOR.broadcast} label="Broadcast" />
          </div>
        </div>
      </div>

      <Card>
        <CardContent className="p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-lg font-semibold">{format(month, "MMMM yyyy")}</h2>
            <div className="flex items-center gap-1">
              <Button variant="outline" size="sm" onClick={() => setMonth(startOfMonth(new Date()))}>Today</Button>
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setMonth((m) => subMonths(m, 1))}>
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setMonth((m) => addMonths(m, 1))}>
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>

          <div className="grid grid-cols-7 gap-px overflow-hidden rounded-md border border-border/50 bg-border/50">
            {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
              <div key={d} className="bg-muted/40 px-2 py-1.5 text-center text-[11px] font-medium text-muted-foreground">
                {d}
              </div>
            ))}
            {days.map((day) => {
              const key = format(day, KEY);
              const evs = byDay.get(key) ?? [];
              const inMonth = isSameMonth(day, month);
              const isToday = isSameDay(day, today);
              return (
                <div
                  key={key}
                  className={`min-h-[88px] bg-background p-1.5 ${inMonth ? "" : "opacity-40"}`}
                >
                  <div className={`mb-1 text-right text-[11px] tabular-nums ${isToday ? "font-bold text-primary" : "text-muted-foreground"}`}>
                    {format(day, "d")}
                  </div>
                  <div className="space-y-0.5">
                    {evs.slice(0, 3).map((ev, i) => (
                      <button
                        key={`${ev.type}-${ev.id}-${i}`}
                        type="button"
                        onClick={() => navigate(ev.to)}
                        title={ev.label}
                        className="block w-full truncate rounded px-1 py-0.5 text-left text-[10px] text-white/95 hover:opacity-90"
                        style={{ backgroundColor: EVENT_TYPE_COLOR[ev.type] }}
                      >
                        {ev.label}
                      </button>
                    ))}
                    {evs.length > 3 && (
                      <p className="px-1 text-[10px] text-muted-foreground">+{evs.length - 3} more</p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: color }} />
      {label}
    </span>
  );
}
