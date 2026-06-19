import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Tag, Rocket, Megaphone, Lock } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  useSales,
  useLaunches,
  useBroadcasts,
  useUpdateSale,
  useUpdateLaunch,
  useUpdateBroadcast,
  type MktSale,
  type MktLaunchWithProduct,
  type MktBroadcastWithLinks,
} from "@/lib/hooks";
import { useAuth } from "@/lib/auth-context";
import { toast } from "@/hooks/use-toast";
import { describeError } from "@/lib/supabase-error";
import {
  EVENT_TYPE_COLOR,
  dayKeyOf,
  shiftDayKey,
  daysBetweenKeys,
  isPastKey,
} from "@/lib/marketing-format";
import { SaleFormDialog } from "@/components/marketing/SaleFormDialog";
import { LaunchFormDialog } from "@/components/marketing/LaunchFormDialog";
import { BroadcastFormDialog } from "@/components/marketing/BroadcastFormDialog";
import {
  startOfMonth,
  endOfMonth,
  startOfWeek,
  endOfWeek,
  eachDayOfInterval,
  addMonths,
  subMonths,
  format,
  isSameMonth,
} from "date-fns";

type EvType = "sale" | "launch" | "broadcast";
type Ev = { id: string; type: EvType; label: string; anchorKey: string; originKey: string; past: boolean };
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function monthsDiff(a: Date, b: Date): number {
  return (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
}

export default function MarketingCalendar() {
  const { data: sales = [] } = useSales();
  const { data: launches = [] } = useLaunches();
  const { data: broadcasts = [] } = useBroadcasts();
  const updateSale = useUpdateSale();
  const updateLaunch = useUpdateLaunch();
  const updateBroadcast = useUpdateBroadcast();
  const { isAdmin, isManager } = useAuth();
  const canEdit = isAdmin || isManager;

  const todayKey = format(new Date(), "yyyy-MM-dd");
  const today = useMemo(() => new Date(`${todayKey}T00:00:00`), [todayKey]);
  const todayMonthKey = format(today, "yyyy-MM");

  // View + navigation
  const [view, setView] = useState<"scroll" | "year">("scroll");
  const [monthsBack, setMonthsBack] = useState(1);
  const [monthsForward, setMonthsForward] = useState(12);
  const [year, setYear] = useState(today.getFullYear());
  const monthRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [pendingScroll, setPendingScroll] = useState<string | null>(todayMonthKey);

  // Add / edit dialog state
  const [addDay, setAddDay] = useState<string | null>(null);
  const [create, setCreate] = useState<{ type: EvType; date: string } | null>(null);
  const [editSale, setEditSale] = useState<MktSale | null>(null);
  const [editLaunch, setEditLaunch] = useState<MktLaunchWithProduct | null>(null);
  const [editBroadcast, setEditBroadcast] = useState<MktBroadcastWithLinks | null>(null);

  const saleById = useMemo(() => new Map(sales.map((s) => [s.id, s])), [sales]);
  const launchById = useMemo(() => new Map(launches.map((l) => [l.id, l])), [launches]);
  const broadcastById = useMemo(() => new Map(broadcasts.map((b) => [b.id, b])), [broadcasts]);

  // Map each calendar day → its events (keys sliced from the stored date, tz-safe).
  const byDay = useMemo(() => {
    const m = new Map<string, Ev[]>();
    const push = (day: string, ev: Ev) => {
      const arr = m.get(day) ?? [];
      arr.push(ev);
      m.set(day, arr);
    };
    for (const s of sales) {
      const start = dayKeyOf(s.starts_at);
      if (!start) continue;
      const end = dayKeyOf(s.ends_at) ?? start;
      if (end < start) continue;
      const past = isPastKey(start, todayKey);
      let k = start;
      let guard = 0;
      while (k <= end && guard++ < 400) {
        push(k, { id: s.id, type: "sale", label: s.name, anchorKey: start, originKey: k, past });
        k = shiftDayKey(k, 1);
      }
    }
    for (const l of launches) {
      const k = dayKeyOf(l.launch_date);
      if (!k) continue;
      const label = l.product?.sku || l.planned_name || "Launch";
      push(k, { id: l.id, type: "launch", label, anchorKey: k, originKey: k, past: isPastKey(k, todayKey) });
    }
    for (const b of broadcasts) {
      const k = dayKeyOf(b.sent_at) ?? dayKeyOf(b.scheduled_at);
      if (!k) continue;
      push(k, { id: b.id, type: "broadcast", label: b.name, anchorKey: k, originKey: k, past: isPastKey(k, todayKey) });
    }
    return m;
  }, [sales, launches, broadcasts, todayKey]);

  // The stacked month list for the scroll view.
  const months = useMemo(() => {
    const start = subMonths(startOfMonth(today), monthsBack);
    const n = monthsBack + monthsForward + 1;
    return Array.from({ length: n }, (_, i) => addMonths(start, i));
  }, [today, monthsBack, monthsForward]);

  // Scroll a requested month into view (from "Today" or a year-view click).
  useEffect(() => {
    if (view !== "scroll" || !pendingScroll) return;
    const el = monthRefs.current[pendingScroll];
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      setPendingScroll(null);
    }
  }, [view, pendingScroll, months]);

  function openEdit(ev: Ev) {
    if (ev.type === "sale") setEditSale(saleById.get(ev.id) ?? null);
    else if (ev.type === "launch") setEditLaunch(launchById.get(ev.id) ?? null);
    else setEditBroadcast(broadcastById.get(ev.id) ?? null);
  }

  function goToMonth(monthDate: Date) {
    const diff = monthsDiff(startOfMonth(today), startOfMonth(monthDate));
    if (diff < -monthsBack) setMonthsBack(-diff);
    if (diff > monthsForward) setMonthsForward(diff);
    setView("scroll");
    setPendingScroll(format(monthDate, "yyyy-MM"));
  }

  async function handleDrop(e: React.DragEvent, dropKey: string) {
    e.preventDefault();
    if (!canEdit) return;
    const raw = e.dataTransfer.getData("text/plain");
    if (!raw) return;
    let p: { type: EvType; id: string; originKey: string };
    try { p = JSON.parse(raw); } catch { return; }
    if (isPastKey(dropKey, todayKey)) {
      toast({ title: "Can't move into the past", description: "Past days are locked.", variant: "destructive" });
      return;
    }
    const delta = daysBetweenKeys(p.originKey, dropKey);
    if (delta === 0) return;
    try {
      if (p.type === "sale") {
        const s = saleById.get(p.id);
        const startK = dayKeyOf(s?.starts_at ?? null);
        if (!s || !startK) return;
        const newStart = shiftDayKey(startK, delta);
        if (isPastKey(newStart, todayKey)) { toast({ title: "Can't move into the past", variant: "destructive" }); return; }
        const newEnd = s.ends_at ? shiftDayKey(dayKeyOf(s.ends_at)!, delta) : null;
        await updateSale.mutateAsync({ id: s.id, updates: { starts_at: newStart, ends_at: newEnd } });
      } else if (p.type === "launch") {
        const l = launchById.get(p.id);
        const startK = dayKeyOf(l?.launch_date ?? null);
        if (!l || !startK) return;
        const newDate = shiftDayKey(startK, delta);
        if (isPastKey(newDate, todayKey)) { toast({ title: "Can't move into the past", variant: "destructive" }); return; }
        const newReady = l.inventory_ready_by ? shiftDayKey(dayKeyOf(l.inventory_ready_by)!, delta) : null;
        await updateLaunch.mutateAsync({ id: l.id, updates: { launch_date: newDate, inventory_ready_by: newReady } });
      } else {
        const b = broadcastById.get(p.id);
        const startK = dayKeyOf(b?.scheduled_at ?? null);
        if (!b || !startK) return;
        const newDate = shiftDayKey(startK, delta);
        if (isPastKey(newDate, todayKey)) { toast({ title: "Can't move into the past", variant: "destructive" }); return; }
        await updateBroadcast.mutateAsync({ id: b.id, updates: { scheduled_at: newDate } });
      }
      toast({ title: "Rescheduled" });
    } catch (err) {
      toast({ title: "Couldn't move", description: describeError(err), variant: "destructive" });
    }
  }

  // One full month grid (used in the scroll view).
  function renderMonth(monthDate: Date) {
    const days = eachDayOfInterval({
      start: startOfWeek(startOfMonth(monthDate)),
      end: endOfWeek(endOfMonth(monthDate)),
    });
    return (
      <div className="grid grid-cols-7 gap-px overflow-hidden rounded-md border border-border/50 bg-border/50">
        {WEEKDAYS.map((d) => (
          <div key={d} className="bg-muted/40 px-2 py-1 text-center text-[10px] font-medium text-muted-foreground">{d}</div>
        ))}
        {days.map((day) => {
          const key = format(day, "yyyy-MM-dd");
          const evs = byDay.get(key) ?? [];
          const inMonth = isSameMonth(day, monthDate);
          const isToday = key === todayKey;
          const isPast = isPastKey(key, todayKey);
          const clickable = canEdit && !isPast;
          return (
            <div
              key={key}
              onClick={() => clickable && setAddDay(key)}
              onDragOver={(e) => { if (canEdit && !isPast) e.preventDefault(); }}
              onDrop={(e) => handleDrop(e, key)}
              title={clickable ? "Click to add an event" : undefined}
              className={`min-h-[88px] p-1.5 ${inMonth ? "bg-background" : "bg-background/60 opacity-50"} ${isPast ? "bg-muted/10" : ""} ${clickable ? "cursor-pointer hover:bg-muted/25" : ""}`}
            >
              <div className={`mb-1 text-right text-[11px] tabular-nums ${isToday ? "font-bold text-primary" : "text-muted-foreground"}`}>
                {format(day, "d")}
              </div>
              <div className="space-y-0.5">
                {evs.slice(0, 3).map((ev, i) => (
                  <button
                    key={`${ev.type}-${ev.id}-${i}`}
                    type="button"
                    draggable={canEdit && !ev.past}
                    onDragStart={(e) => {
                      e.dataTransfer.setData("text/plain", JSON.stringify({ type: ev.type, id: ev.id, originKey: ev.originKey }));
                      e.dataTransfer.effectAllowed = "move";
                    }}
                    onClick={(e) => { e.stopPropagation(); openEdit(ev); }}
                    title={ev.past ? `${ev.label} — locked (past)` : ev.label}
                    className={`block w-full truncate rounded px-1 py-0.5 text-left text-[10px] text-white/95 hover:opacity-90 ${
                      ev.past ? "cursor-pointer opacity-60" : canEdit ? "cursor-grab active:cursor-grabbing" : "cursor-pointer"
                    }`}
                    style={{ backgroundColor: EVENT_TYPE_COLOR[ev.type] }}
                  >
                    {ev.past && "🔒 "}{ev.label}
                  </button>
                ))}
                {evs.length > 3 && (
                  <p className="px-1 text-[10px] text-muted-foreground" onClick={(e) => e.stopPropagation()}>
                    +{evs.length - 3} more
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  // One compact month panel (used in the year view) — sales + launches only.
  function renderMiniMonth(monthDate: Date) {
    const ym = format(monthDate, "yyyy-MM");
    const monthStart = `${ym}-01`;
    const monthEnd = format(endOfMonth(monthDate), "yyyy-MM-dd");
    const monthSales = sales.filter((s) => {
      const st = dayKeyOf(s.starts_at);
      if (!st) return false;
      const en = dayKeyOf(s.ends_at) ?? st;
      return st <= monthEnd && en >= monthStart;
    });
    const monthLaunches = launches.filter((l) => (dayKeyOf(l.launch_date) ?? "").startsWith(ym));
    const items = [
      ...monthSales.map((s) => ({ id: `s-${s.id}`, type: "sale" as const, label: s.name })),
      ...monthLaunches.map((l) => ({ id: `l-${l.id}`, type: "launch" as const, label: l.product?.sku || l.planned_name || "Launch" })),
    ];
    const isThisMonth = ym === todayMonthKey;
    return (
      <button
        key={ym}
        type="button"
        onClick={() => goToMonth(monthDate)}
        className={`flex min-h-[120px] flex-col rounded-lg border p-3 text-left transition-colors hover:bg-muted/20 ${isThisMonth ? "border-primary/60" : "border-border/50"}`}
      >
        <p className={`mb-2 text-sm font-semibold ${isThisMonth ? "text-primary" : ""}`}>{format(monthDate, "MMMM")}</p>
        <div className="space-y-1">
          {items.slice(0, 6).map((it) => (
            <div key={it.id} className="flex items-center gap-1.5 text-[11px]">
              <span className="inline-block h-2 w-2 shrink-0 rounded-sm" style={{ backgroundColor: EVENT_TYPE_COLOR[it.type] }} />
              <span className="truncate">{it.label}</span>
            </div>
          ))}
          {items.length > 6 && <p className="text-[11px] text-muted-foreground">+{items.length - 6} more</p>}
          {items.length === 0 && <p className="text-[11px] text-muted-foreground/50">—</p>}
        </div>
      </button>
    );
  }

  return (
    <div className="space-y-6">
      {/* Create dialogs (date prefilled from the clicked day) */}
      <SaleFormDialog open={create?.type === "sale"} onOpenChange={(o) => !o && setCreate(null)} defaultDate={create?.date} />
      <LaunchFormDialog open={create?.type === "launch"} onOpenChange={(o) => !o && setCreate(null)} defaultDate={create?.date} />
      <BroadcastFormDialog open={create?.type === "broadcast"} onOpenChange={(o) => !o && setCreate(null)} defaultDate={create?.date} />
      {/* Edit dialogs (dates locked when the event is already in the past) */}
      <SaleFormDialog open={!!editSale} onOpenChange={(o) => !o && setEditSale(null)} sale={editSale}
        datesLocked={!!editSale && isPastKey(dayKeyOf(editSale.starts_at), todayKey)} />
      <LaunchFormDialog open={!!editLaunch} onOpenChange={(o) => !o && setEditLaunch(null)} launch={editLaunch}
        datesLocked={!!editLaunch && isPastKey(dayKeyOf(editLaunch.launch_date), todayKey)} />
      <BroadcastFormDialog open={!!editBroadcast} onOpenChange={(o) => !o && setEditBroadcast(null)} broadcast={editBroadcast}
        datesLocked={!!editBroadcast && isPastKey(dayKeyOf(editBroadcast.sent_at) ?? dayKeyOf(editBroadcast.scheduled_at), todayKey)} />

      {/* "Add to day" type picker */}
      <Dialog open={!!addDay} onOpenChange={(o) => !o && setAddDay(null)}>
        <DialogContent className="max-w-xs">
          <DialogHeader>
            <DialogTitle>Add to {addDay ? format(new Date(`${addDay}T00:00:00`), "MMM d, yyyy") : ""}</DialogTitle>
            <DialogDescription>What would you like to schedule?</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Button variant="outline" className="justify-start" onClick={() => { if (addDay) setCreate({ type: "sale", date: addDay }); setAddDay(null); }}>
              <Tag className="mr-2 h-4 w-4" style={{ color: EVENT_TYPE_COLOR.sale }} /> Sale
            </Button>
            <Button variant="outline" className="justify-start" onClick={() => { if (addDay) setCreate({ type: "launch", date: addDay }); setAddDay(null); }}>
              <Rocket className="mr-2 h-4 w-4" style={{ color: EVENT_TYPE_COLOR.launch }} /> Launch / drop
            </Button>
            <Button variant="outline" className="justify-start" onClick={() => { if (addDay) setCreate({ type: "broadcast", date: addDay }); setAddDay(null); }}>
              <Megaphone className="mr-2 h-4 w-4" style={{ color: EVENT_TYPE_COLOR.broadcast }} /> Broadcast
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Marketing Calendar</h1>
          <p className="text-muted-foreground">
            {canEdit ? "Click a day to add · click an event to edit · drag to reschedule · " : ""}
            <span className="inline-flex items-center gap-1"><Lock className="h-3 w-3" /> past events are locked</span>
          </p>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <Legend color={EVENT_TYPE_COLOR.sale} label="Sale" />
            <Legend color={EVENT_TYPE_COLOR.launch} label="Launch" />
            <Legend color={EVENT_TYPE_COLOR.broadcast} label="Broadcast" />
          </div>
          {/* View toggle */}
          <div className="flex rounded-md border border-border/60 p-0.5">
            <Button size="sm" variant={view === "scroll" ? "default" : "ghost"} className="h-7 px-3 text-xs" onClick={() => setView("scroll")}>Calendar</Button>
            <Button size="sm" variant={view === "year" ? "default" : "ghost"} className="h-7 px-3 text-xs" onClick={() => setView("year")}>Year</Button>
          </div>
        </div>
      </div>

      {view === "scroll" ? (
        <Card>
          <CardContent className="p-0">
            <div className="flex items-center justify-end border-b border-border/50 px-4 py-2">
              <Button variant="outline" size="sm" onClick={() => goToMonth(today)}>Jump to today</Button>
            </div>
            <div className="max-h-[72vh] overflow-y-auto">
              <div className="p-2 text-center">
                <Button variant="ghost" size="sm" className="text-xs text-muted-foreground" onClick={() => setMonthsBack((b) => b + 6)}>
                  <ChevronLeft className="mr-1 h-3 w-3 rotate-90" /> Earlier months
                </Button>
              </div>
              {months.map((m) => {
                const ym = format(m, "yyyy-MM");
                return (
                  <div key={ym} ref={(el) => { monthRefs.current[ym] = el; }} className="px-4 pb-6">
                    <h3 className="sticky top-0 z-10 -mx-4 mb-2 bg-card/95 px-4 py-2 text-sm font-semibold backdrop-blur">
                      {format(m, "MMMM yyyy")}
                    </h3>
                    {renderMonth(m)}
                  </div>
                );
              })}
              <div className="p-2 text-center">
                <Button variant="ghost" size="sm" className="text-xs text-muted-foreground" onClick={() => setMonthsForward((f) => f + 6)}>
                  More months <ChevronRight className="ml-1 h-3 w-3 rotate-90" />
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-4">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-semibold">{year}</h2>
              <div className="flex items-center gap-1">
                <Button variant="outline" size="sm" onClick={() => setYear(today.getFullYear())}>This year</Button>
                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setYear((y) => y - 1)}><ChevronLeft className="h-4 w-4" /></Button>
                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setYear((y) => y + 1)}><ChevronRight className="h-4 w-4" /></Button>
              </div>
            </div>
            <p className="mb-3 text-xs text-muted-foreground">Sales &amp; launches by month — click a month to open it.</p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {Array.from({ length: 12 }, (_, m) => new Date(year, m, 1)).map(renderMiniMonth)}
            </div>
          </CardContent>
        </Card>
      )}
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
