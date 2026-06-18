import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Plus, Tag, Rocket, Megaphone, Lock } from "lucide-react";
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

export default function MarketingCalendar() {
  const { data: sales = [] } = useSales();
  const { data: launches = [] } = useLaunches();
  const { data: broadcasts = [] } = useBroadcasts();
  const updateSale = useUpdateSale();
  const updateLaunch = useUpdateLaunch();
  const updateBroadcast = useUpdateBroadcast();
  const { isAdmin, isManager } = useAuth();
  const canEdit = isAdmin || isManager;

  const [month, setMonth] = useState(() => startOfMonth(new Date()));
  const todayKey = format(new Date(), "yyyy-MM-dd");

  // Add / edit dialog state
  const [addDay, setAddDay] = useState<string | null>(null);
  const [create, setCreate] = useState<{ type: EvType; date: string } | null>(null);
  const [editSale, setEditSale] = useState<MktSale | null>(null);
  const [editLaunch, setEditLaunch] = useState<MktLaunchWithProduct | null>(null);
  const [editBroadcast, setEditBroadcast] = useState<MktBroadcastWithLinks | null>(null);

  const saleById = useMemo(() => new Map(sales.map((s) => [s.id, s])), [sales]);
  const launchById = useMemo(() => new Map(launches.map((l) => [l.id, l])), [launches]);
  const broadcastById = useMemo(() => new Map(broadcasts.map((b) => [b.id, b])), [broadcasts]);

  // Map each calendar day → its events (keys derived from the stored date
  // string directly, so no timezone day-shift).
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

  const days = useMemo(
    () =>
      eachDayOfInterval({
        start: startOfWeek(startOfMonth(month)),
        end: endOfWeek(endOfMonth(month)),
      }),
    [month],
  );

  function openEdit(ev: Ev) {
    if (ev.type === "sale") setEditSale(saleById.get(ev.id) ?? null);
    else if (ev.type === "launch") setEditLaunch(launchById.get(ev.id) ?? null);
    else setEditBroadcast(broadcastById.get(ev.id) ?? null);
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
        if (isPastKey(newStart, todayKey)) {
          toast({ title: "Can't move into the past", variant: "destructive" });
          return;
        }
        const newEnd = s.ends_at ? shiftDayKey(dayKeyOf(s.ends_at)!, delta) : null;
        await updateSale.mutateAsync({ id: s.id, updates: { starts_at: newStart, ends_at: newEnd } });
      } else if (p.type === "launch") {
        const l = launchById.get(p.id);
        const startK = dayKeyOf(l?.launch_date ?? null);
        if (!l || !startK) return;
        const newDate = shiftDayKey(startK, delta);
        if (isPastKey(newDate, todayKey)) {
          toast({ title: "Can't move into the past", variant: "destructive" });
          return;
        }
        const newReady = l.inventory_ready_by ? shiftDayKey(dayKeyOf(l.inventory_ready_by)!, delta) : null;
        await updateLaunch.mutateAsync({ id: l.id, updates: { launch_date: newDate, inventory_ready_by: newReady } });
      } else {
        const b = broadcastById.get(p.id);
        const startK = dayKeyOf(b?.scheduled_at ?? null);
        if (!b || !startK) return;
        const newDate = shiftDayKey(startK, delta);
        if (isPastKey(newDate, todayKey)) {
          toast({ title: "Can't move into the past", variant: "destructive" });
          return;
        }
        await updateBroadcast.mutateAsync({ id: b.id, updates: { scheduled_at: newDate } });
      }
      toast({ title: "Rescheduled" });
    } catch (err) {
      toast({ title: "Couldn't move", description: describeError(err), variant: "destructive" });
    }
  }

  return (
    <div className="space-y-6">
      {/* Create dialogs (date prefilled from the clicked day) */}
      <SaleFormDialog open={create?.type === "sale"} onOpenChange={(o) => !o && setCreate(null)} defaultDate={create?.date} />
      <LaunchFormDialog open={create?.type === "launch"} onOpenChange={(o) => !o && setCreate(null)} defaultDate={create?.date} />
      <BroadcastFormDialog open={create?.type === "broadcast"} onOpenChange={(o) => !o && setCreate(null)} defaultDate={create?.date} />
      {/* Edit dialogs (dates locked when the event is already in the past) */}
      <SaleFormDialog
        open={!!editSale}
        onOpenChange={(o) => !o && setEditSale(null)}
        sale={editSale}
        datesLocked={!!editSale && isPastKey(dayKeyOf(editSale.starts_at), todayKey)}
      />
      <LaunchFormDialog
        open={!!editLaunch}
        onOpenChange={(o) => !o && setEditLaunch(null)}
        launch={editLaunch}
        datesLocked={!!editLaunch && isPastKey(dayKeyOf(editLaunch.launch_date), todayKey)}
      />
      <BroadcastFormDialog
        open={!!editBroadcast}
        onOpenChange={(o) => !o && setEditBroadcast(null)}
        broadcast={editBroadcast}
        datesLocked={!!editBroadcast && isPastKey(dayKeyOf(editBroadcast.sent_at) ?? dayKeyOf(editBroadcast.scheduled_at), todayKey)}
      />

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
        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          <Legend color={EVENT_TYPE_COLOR.sale} label="Sale" />
          <Legend color={EVENT_TYPE_COLOR.launch} label="Launch" />
          <Legend color={EVENT_TYPE_COLOR.broadcast} label="Broadcast" />
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
              const key = format(day, "yyyy-MM-dd");
              const evs = byDay.get(key) ?? [];
              const inMonth = isSameMonth(day, month);
              const isToday = key === todayKey;
              const isPast = isPastKey(key, todayKey);
              return (
                <div
                  key={key}
                  onDragOver={(e) => { if (canEdit && !isPast) e.preventDefault(); }}
                  onDrop={(e) => handleDrop(e, key)}
                  className={`group relative min-h-[92px] p-1.5 ${inMonth ? "bg-background" : "bg-background/60 opacity-50"} ${isPast ? "bg-muted/10" : ""}`}
                >
                  <div className="mb-1 flex items-center justify-between">
                    {canEdit && !isPast ? (
                      <button
                        type="button"
                        onClick={() => setAddDay(key)}
                        title="Add to this day"
                        className="text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
                      >
                        <Plus className="h-3.5 w-3.5" />
                      </button>
                    ) : (
                      <span />
                    )}
                    <span className={`text-[11px] tabular-nums ${isToday ? "font-bold text-primary" : "text-muted-foreground"}`}>
                      {format(day, "d")}
                    </span>
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
                        onClick={() => openEdit(ev)}
                        title={ev.past ? `${ev.label} — locked (past)` : ev.label}
                        className={`block w-full truncate rounded px-1 py-0.5 text-left text-[10px] text-white/95 hover:opacity-90 ${
                          ev.past ? "cursor-pointer opacity-60" : canEdit ? "cursor-grab active:cursor-grabbing" : "cursor-pointer"
                        }`}
                        style={{ backgroundColor: EVENT_TYPE_COLOR[ev.type] }}
                      >
                        {ev.past && "🔒 "}{ev.label}
                      </button>
                    ))}
                    {evs.length > 3 && <p className="px-1 text-[10px] text-muted-foreground">+{evs.length - 3} more</p>}
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
