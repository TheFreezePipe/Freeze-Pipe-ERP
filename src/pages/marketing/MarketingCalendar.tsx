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
  type MktLaunchWithMembers,
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
  salePhase,
  launchPhase,
  PHASE_COLOR,
  PHASE_LABEL,
  LAUNCH_PHASE_COLOR,
  LAUNCH_PHASE_LABEL,
  APPROVAL_COLOR,
  APPROVAL_LABEL,
  approvalTooltip,
  normalizeApproval,
  retailHolidaysForYear,
} from "@/lib/marketing-format";
import {
  saleColorMap,
  assignSaleLanes,
  indexSaleSpans,
  saleRoleOnDay,
  weekKeyOf,
  type SaleSpan,
  type SaleSpanInput,
  type SaleSpanRole,
} from "@/lib/marketing/sale-spans";
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
} from "date-fns";

type EvType = "sale" | "launch" | "broadcast";
type Ev = {
  id: string;
  type: EvType;
  label: string;
  anchorKey: string;
  originKey: string;
  past: boolean;
  /** approval_status for sales/launches; null for broadcasts (no approval track). */
  approval: string | null;
  /** Per-sale color (sales only); launches and broadcasts use their type color. */
  color?: string;
};
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const HEADER_OFFSET = 62; // sticky month + weekday header height, for scroll math
const AGENDA_WEEKS = 8;

// localStorage keys for the display preferences (per-browser, non-critical).
const HOLIDAY_LS_KEY = "fp-mkt-holiday-overlay";
const FILTERS_LS_KEY = "fp-mkt-type-filters";

function loadHolidayPref(): boolean {
  try {
    return localStorage.getItem(HOLIDAY_LS_KEY) !== "0"; // default ON
  } catch {
    return true;
  }
}

function loadTypeFilters(): Record<EvType, boolean> {
  try {
    const raw = localStorage.getItem(FILTERS_LS_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<Record<EvType, boolean>>;
      return { sale: p.sale !== false, launch: p.launch !== false, broadcast: p.broadcast !== false };
    }
  } catch {
    /* fall through to all-on */
  }
  return { sale: true, launch: true, broadcast: true };
}

function monthsDiff(a: Date, b: Date): number {
  return (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
}

/**
 * Approval styling for a sale/launch chip: unconfirmed (draft/proposed) chips
 * render dashed + slightly muted with an explanatory tooltip. Broadcasts pass
 * approval = null and are untouched. Past-lock opacity wins over approval.
 */
function chipDecoration(approval: string | null, past: boolean): { cls: string; tip: string | null } {
  const unconfirmed = approval != null && normalizeApproval(approval) !== "confirmed";
  const tip = unconfirmed ? approvalTooltip(approval) : null;
  const cls = [
    unconfirmed ? "border border-dashed border-white/60" : "",
    past ? "opacity-60" : unconfirmed ? "opacity-75" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return { cls, tip };
}

/** A single agenda row (sale span, launch day, or broadcast day). */
type AgendaRow = {
  type: EvType;
  id: string;
  anchor: string; // the day-key that places the row in a week group
  startKey: string;
  endKey: string | null; // set only for multi-day sales
  name: string;
  channel: string | null; // broadcasts only
  phaseLabel: string | null;
  phaseCls: string | null;
  approval: string | null;
  past: boolean;
};

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
  const [view, setView] = useState<"scroll" | "agenda" | "year">("scroll");
  const [monthsBack, setMonthsBack] = useState(1);
  const [monthsForward, setMonthsForward] = useState(12);
  const [year, setYear] = useState(today.getFullYear());
  const [stickyMonth, setStickyMonth] = useState(() => format(today, "MMMM yyyy"));
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const monthAnchors = useRef<Record<string, HTMLDivElement | null>>({});
  const [pendingScroll, setPendingScroll] = useState<string | null>(todayMonthKey);

  // Display preferences (persisted per browser)
  const [showHolidays, setShowHolidays] = useState<boolean>(loadHolidayPref);
  const [typeFilters, setTypeFilters] = useState<Record<EvType, boolean>>(loadTypeFilters);

  // Add / edit dialog state
  const [addDay, setAddDay] = useState<string | null>(null);
  const [dayDialogKey, setDayDialogKey] = useState<string | null>(null); // "+N more" day popover
  const [create, setCreate] = useState<{ type: EvType; date: string } | null>(null);
  const [editSale, setEditSale] = useState<MktSale | null>(null);
  const [editLaunch, setEditLaunch] = useState<MktLaunchWithMembers | null>(null);
  const [editBroadcast, setEditBroadcast] = useState<MktBroadcastWithLinks | null>(null);

  const saleById = useMemo(() => new Map(sales.map((s) => [s.id, s])), [sales]);
  const launchById = useMemo(() => new Map(launches.map((l) => [l.id, l])), [launches]);
  const broadcastById = useMemo(() => new Map(broadcasts.map((b) => [b.id, b])), [broadcasts]);

  function toggleHolidays() {
    setShowHolidays((v) => {
      const next = !v;
      try {
        localStorage.setItem(HOLIDAY_LS_KEY, next ? "1" : "0");
      } catch {
        /* ignore storage failures */
      }
      return next;
    });
  }

  function toggleTypeFilter(t: EvType) {
    setTypeFilters((f) => {
      const next = { ...f, [t]: !f[t] };
      try {
        localStorage.setItem(FILTERS_LS_KEY, JSON.stringify(next));
      } catch {
        /* ignore storage failures */
      }
      return next;
    });
  }

  // Map each calendar day → its events (keys sliced from the stored date, tz-safe).
  // Type filters apply here so month cells, the day popover, and "+N more"
  // counts all agree on what's visible.
  const byDay = useMemo(() => {
    const m = new Map<string, Ev[]>();
    const push = (day: string, ev: Ev) => {
      const arr = m.get(day) ?? [];
      arr.push(ev);
      m.set(day, arr);
    };
    // Sales are drawn as spans (see saleSpans below), not per-day chips.
    if (typeFilters.launch) {
      for (const l of launches) {
        const k = dayKeyOf(l.launch_date);
        if (!k) continue;
        const lea = dayKeyOf(l.early_access_date);
        if (lea && lea < k) {
          push(lea, { id: l.id, type: "launch", label: `EA · ${l.name}`, anchorKey: k, originKey: lea, past: isPastKey(lea, todayKey), approval: l.approval_status });
        }
        push(k, { id: l.id, type: "launch", label: l.name, anchorKey: k, originKey: k, past: isPastKey(k, todayKey), approval: l.approval_status });
      }
    }
    if (typeFilters.broadcast) {
      for (const b of broadcasts) {
        const k = dayKeyOf(b.sent_at) ?? dayKeyOf(b.scheduled_at);
        if (!k) continue;
        push(k, { id: b.id, type: "broadcast", label: b.name, anchorKey: k, originKey: k, past: isPastKey(k, todayKey), approval: null });
      }
    }
    return m;
  }, [launches, broadcasts, todayKey, typeFilters]);

  // Sales as spans: one color per sale, a lane per overlapping sale, and an
  // index of every drawn day (early access through close) per week row so
  // lane positions line up across the row's cells.
  const saleColors = useMemo(() => saleColorMap(sales), [sales]);
  const saleSpans = useMemo(() => {
    if (!typeFilters.sale) return [] as SaleSpan[];
    const inputs: SaleSpanInput[] = [];
    for (const s of sales) {
      const start = dayKeyOf(s.starts_at);
      if (!start) continue;
      const end = dayKeyOf(s.ends_at) ?? start;
      if (end < start) continue;
      const ea = dayKeyOf(s.early_access_starts_at);
      inputs.push({
        id: s.id,
        name: s.name,
        color: saleColors.get(s.id) ?? EVENT_TYPE_COLOR.sale,
        eaStart: ea && ea < start ? ea : null,
        start,
        end,
        past: isPastKey(start, todayKey),
        approval: s.approval_status,
      });
    }
    return assignSaleLanes(inputs);
  }, [sales, saleColors, todayKey, typeFilters.sale]);
  const spanIndex = useMemo(() => indexSaleSpans(saleSpans), [saleSpans]);

  const months = useMemo(() => {
    const start = subMonths(startOfMonth(today), monthsBack);
    const n = monthsBack + monthsForward + 1;
    return Array.from({ length: n }, (_, i) => addMonths(start, i));
  }, [today, monthsBack, monthsForward]);

  // Retail-holiday overlay: dayKey → label, covering every year the calendar
  // can show (scroll range ± the edge weeks, the year view, and the agenda).
  const holidayByDay = useMemo(() => {
    const years = new Set<number>([today.getFullYear(), today.getFullYear() + 1, year]);
    for (const mo of months) years.add(mo.getFullYear());
    if (months.length > 0) {
      years.add(months[0].getFullYear() - 1); // grid edge weeks can dip into the prior year
      years.add(months[months.length - 1].getFullYear() + 1);
    }
    const m = new Map<string, string>();
    for (const y of years) for (const h of retailHolidaysForYear(y)) m.set(h.dayKey, h.label);
    return m;
  }, [months, year, today]);

  // One continuous run of days (each date appears exactly once — no per-month
  // grids, so a mid-week month boundary is never shown twice).
  const allDays = useMemo(() => {
    if (months.length === 0) return [] as Date[];
    return eachDayOfInterval({
      start: startOfWeek(startOfMonth(months[0])),
      end: endOfWeek(endOfMonth(months[months.length - 1])),
    });
  }, [months]);

  // Agenda: the next 8 weeks grouped by week (Monday start — the weekly-sync
  // reading view). A sale that started before this week but is still running
  // is anchored to today so it stays visible in the current week.
  const agendaWeeks = useMemo(() => {
    const week0 = format(startOfWeek(today, { weekStartsOn: 1 }), "yyyy-MM-dd");
    const rangeEnd = shiftDayKey(week0, AGENDA_WEEKS * 7 - 1);
    const rows: AgendaRow[] = [];
    if (typeFilters.sale) {
      for (const s of sales) {
        const st = dayKeyOf(s.starts_at);
        if (!st) continue;
        const en = dayKeyOf(s.ends_at) ?? st;
        if (en < st) continue;
        let anchor: string | null = null;
        if (st >= week0 && st <= rangeEnd) anchor = st;
        else if (st < week0 && en >= todayKey) anchor = todayKey; // ongoing → current week
        if (!anchor) continue;
        const p = salePhase(st, en, todayKey, s.early_access_starts_at);
        rows.push({
          type: "sale", id: s.id, anchor, startKey: st, endKey: en !== st ? en : null, name: s.name, channel: null,
          phaseLabel: p ? PHASE_LABEL[p] : null, phaseCls: p ? PHASE_COLOR[p] : null,
          approval: s.approval_status, past: isPastKey(st, todayKey),
        });
      }
    }
    if (typeFilters.launch) {
      for (const l of launches) {
        const k = dayKeyOf(l.launch_date);
        if (!k || k < week0 || k > rangeEnd) continue;
        // No live inventory on this page → sold-out isn't derived here (shows Upcoming/Launched).
        const p = launchPhase(k, todayKey, false, l.early_access_date);
        rows.push({
          type: "launch", id: l.id, anchor: k, startKey: k, endKey: null, name: l.name, channel: null,
          phaseLabel: p ? LAUNCH_PHASE_LABEL[p] : null, phaseCls: p ? LAUNCH_PHASE_COLOR[p] : null,
          approval: l.approval_status, past: isPastKey(k, todayKey),
        });
      }
    }
    if (typeFilters.broadcast) {
      for (const b of broadcasts) {
        const k = dayKeyOf(b.sent_at) ?? dayKeyOf(b.scheduled_at);
        if (!k || k < week0 || k > rangeEnd) continue;
        rows.push({
          type: "broadcast", id: b.id, anchor: k, startKey: k, endKey: null, name: b.name, channel: b.channel,
          phaseLabel: null, phaseCls: null, approval: null, past: isPastKey(k, todayKey),
        });
      }
    }
    return Array.from({ length: AGENDA_WEEKS }, (_, i) => {
      const wk = shiftDayKey(week0, i * 7);
      const wkEnd = shiftDayKey(wk, 6);
      const weekRows = rows
        .filter((r) => r.anchor >= wk && r.anchor <= wkEnd)
        .sort((a, b) => (a.anchor < b.anchor ? -1 : a.anchor > b.anchor ? 1 : a.name.localeCompare(b.name)));
      const holidays = [...holidayByDay.entries()]
        .filter(([k]) => k >= wk && k <= wkEnd)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([dayKey, label]) => ({ dayKey, label }));
      return { weekKey: wk, rows: weekRows, holidays };
    });
  }, [sales, launches, broadcasts, todayKey, today, typeFilters, holidayByDay]);

  function scrollToMonth(ym: string) {
    const cont = scrollRef.current;
    const anchor = monthAnchors.current[ym];
    if (!cont || !anchor) return;
    const top = anchor.getBoundingClientRect().top - cont.getBoundingClientRect().top + cont.scrollTop - HEADER_OFFSET;
    cont.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
  }

  // Update the sticky month label to whatever month sits at the top of the view.
  function updateStickyMonth() {
    const cont = scrollRef.current;
    if (!cont) return;
    const line = cont.getBoundingClientRect().top + HEADER_OFFSET + 4;
    let label: string | null = null;
    for (const m of months) {
      const a = monthAnchors.current[format(m, "yyyy-MM")];
      if (!a) continue;
      if (a.getBoundingClientRect().top <= line) label = format(m, "MMMM yyyy");
      else break;
    }
    if (label) setStickyMonth(label);
  }

  useEffect(() => {
    if (view !== "scroll" || !pendingScroll) return;
    // Let the grid paint, then scroll the requested month into view.
    const id = requestAnimationFrame(() => {
      scrollToMonth(pendingScroll);
      updateStickyMonth();
      setPendingScroll(null);
    });
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, pendingScroll, allDays]);

  function openEdit(ev: { type: EvType; id: string }) {
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
        // Early access travels with the sale (it must stay <= the start date).
        const newEa = s.early_access_starts_at ? shiftDayKey(dayKeyOf(s.early_access_starts_at)!, delta) : null;
        await updateSale.mutateAsync({ id: s.id, updates: { starts_at: newStart, ends_at: newEnd, early_access_starts_at: newEa } });
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

  // One day cell in the continuous grid.
  function renderDayCell(day: Date, idx: number) {
    const key = format(day, "yyyy-MM-dd");
    const ym = format(day, "yyyy-MM");
    const evs = byDay.get(key) ?? [];
    const isToday = key === todayKey;
    const isPast = isPastKey(key, todayKey);
    const isMonthStart = day.getDate() === 1;
    const showMonth = isMonthStart || idx === 0;
    const clickable = canEdit && !isPast;
    const holiday = showHolidays ? holidayByDay.get(key) : undefined;
    const spansToday = spanIndex.byDay.get(key) ?? [];
    const laneCount = spanIndex.lanesByWeek.get(weekKeyOf(key)) ?? 0;
    const dow = day.getDay();
    return (
      <div
        key={key}
        ref={isMonthStart ? (el) => { monthAnchors.current[ym] = el; } : undefined}
        onClick={() => clickable && setAddDay(key)}
        onDragOver={(e) => { if (canEdit && !isPast) e.preventDefault(); }}
        onDrop={(e) => handleDrop(e, key)}
        title={clickable ? "Click to add an event" : undefined}
        className={`min-h-[92px] bg-background p-1.5 ${isPast ? "bg-muted/10" : ""} ${clickable ? "cursor-pointer hover:bg-muted/25" : ""} ${isMonthStart ? "border-t-2 border-primary/50" : ""}`}
      >
        <div className="mb-1 flex items-center justify-between">
          {showMonth ? (
            <span className="text-[10px] font-semibold uppercase tracking-wide text-primary">{format(day, "MMM")}</span>
          ) : (
            <span />
          )}
          <span className={`text-[11px] tabular-nums ${isToday ? "rounded bg-primary px-1.5 font-bold text-primary-foreground" : "text-muted-foreground"}`}>
            {format(day, "d")}
          </span>
        </div>
        {holiday && (
          <p className="pointer-events-none mb-0.5 truncate text-[9px] font-medium leading-tight text-cyan-300/70" title={holiday}>
            {holiday}
          </p>
        )}
        {laneCount > 0 && (
          <div className="mb-0.5 space-y-0.5">
            {Array.from({ length: laneCount }, (_, lane) => {
              const sp = spansToday.find((s) => s.lane === lane);
              const role = sp ? saleRoleOnDay(sp, key) : null;
              if (!sp || !role) return <div key={lane} className="h-[18px]" />;
              return (
                <SaleSegment
                  key={sp.id}
                  span={sp}
                  role={role}
                  dayKey={key}
                  dow={dow}
                  canEdit={canEdit}
                  onOpen={() => openEdit({ type: "sale", id: sp.id })}
                />
              );
            })}
          </div>
        )}
        <div className="space-y-0.5">
          {evs.slice(0, 3).map((ev, i) => {
            const deco = chipDecoration(ev.approval, ev.past);
            const baseTitle = ev.past ? `${ev.label} — locked (past)` : ev.label;
            return (
              <button
                key={`${ev.type}-${ev.id}-${i}`}
                type="button"
                draggable={canEdit && !ev.past}
                onDragStart={(e) => {
                  e.dataTransfer.setData("text/plain", JSON.stringify({ type: ev.type, id: ev.id, originKey: ev.originKey }));
                  e.dataTransfer.effectAllowed = "move";
                }}
                onClick={(e) => { e.stopPropagation(); openEdit(ev); }}
                title={deco.tip ? `${baseTitle} · ${deco.tip}` : baseTitle}
                className={`block w-full truncate rounded px-1 py-0.5 text-left text-[10px] text-white/95 hover:opacity-90 ${
                  ev.past ? "cursor-pointer" : canEdit ? "cursor-grab active:cursor-grabbing" : "cursor-pointer"
                } ${deco.cls}`}
                style={{ backgroundColor: EVENT_TYPE_COLOR[ev.type] }}
              >
                {ev.past && "🔒 "}{ev.label}
              </button>
            );
          })}
          {evs.length > 3 && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); setDayDialogKey(key); }}
              className="block w-full px-1 text-left text-[10px] text-muted-foreground hover:text-foreground"
              title="Show all events on this day"
            >
              +{evs.length - 3} more
            </button>
          )}
        </div>
      </div>
    );
  }

  // One compact month panel (year view) — sales + launches only.
  function renderMiniMonth(monthDate: Date) {
    const ym = format(monthDate, "yyyy-MM");
    const monthStart = `${ym}-01`;
    const monthEnd = format(endOfMonth(monthDate), "yyyy-MM-dd");
    const monthSales = typeFilters.sale
      ? sales.filter((s) => {
          const st = dayKeyOf(s.starts_at);
          if (!st) return false;
          const en = dayKeyOf(s.ends_at) ?? st;
          return st <= monthEnd && en >= monthStart;
        })
      : [];
    const monthLaunches = typeFilters.launch
      ? launches.filter((l) => (dayKeyOf(l.launch_date) ?? "").startsWith(ym))
      : [];
    const items = [
      ...monthSales.map((s) => ({ id: `s-${s.id}`, label: s.name, color: saleColors.get(s.id) ?? EVENT_TYPE_COLOR.sale })),
      ...monthLaunches.map((l) => ({ id: `l-${l.id}`, label: l.name, color: EVENT_TYPE_COLOR.launch })),
    ];
    const monthHolidays = showHolidays
      ? [...holidayByDay.entries()]
          .filter(([k]) => k.startsWith(ym))
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([, label]) => label)
      : [];
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
              <span className="inline-block h-2 w-2 shrink-0 rounded-sm" style={{ backgroundColor: it.color }} />
              <span className="truncate">{it.label}</span>
            </div>
          ))}
          {items.length > 6 && <p className="text-[11px] text-muted-foreground">+{items.length - 6} more</p>}
          {items.length === 0 && <p className="text-[11px] text-muted-foreground/50">—</p>}
        </div>
        {monthHolidays.length > 0 && (
          <p className="mt-auto w-full truncate pt-1.5 text-[10px] text-cyan-300/60" title={monthHolidays.join(" · ")}>
            {monthHolidays.join(" · ")}
          </p>
        )}
      </button>
    );
  }

  // The day popover lists sales active on the day (from the spans) ahead of
  // the day's launches and broadcasts.
  const dayDialogEvents: Ev[] = dayDialogKey
    ? [
        ...(spanIndex.byDay.get(dayDialogKey) ?? []).map((sp): Ev => ({
          id: sp.id,
          type: "sale",
          label: dayDialogKey < sp.start ? `EA · ${sp.name}` : sp.name,
          anchorKey: sp.start,
          originKey: dayDialogKey,
          past: sp.past,
          approval: sp.approval,
          color: sp.color,
        })),
        ...(byDay.get(dayDialogKey) ?? []),
      ]
    : [];
  const dayDialogHoliday = dayDialogKey ? holidayByDay.get(dayDialogKey) : undefined;

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

      {/* "+N more" day popover — every event on the day, same edit behavior as chips */}
      <Dialog open={!!dayDialogKey} onOpenChange={(o) => !o && setDayDialogKey(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>
              {dayDialogKey ? format(new Date(`${dayDialogKey}T00:00:00`), "EEEE, MMMM d, yyyy") : ""}
            </DialogTitle>
            <DialogDescription>
              {dayDialogHoliday && <span className="text-cyan-300/80">{dayDialogHoliday} · </span>}
              {dayDialogEvents.length} event{dayDialogEvents.length === 1 ? "" : "s"} scheduled
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[50vh] space-y-1 overflow-y-auto">
            {dayDialogEvents.map((ev, i) => {
              const deco = chipDecoration(ev.approval, ev.past);
              const baseTitle = ev.past ? `${ev.label} — locked (past)` : ev.label;
              return (
                <button
                  key={`${ev.type}-${ev.id}-${i}`}
                  type="button"
                  onClick={() => { setDayDialogKey(null); openEdit(ev); }}
                  title={deco.tip ? `${baseTitle} · ${deco.tip}` : baseTitle}
                  className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-white/95 hover:opacity-90 ${deco.cls}`}
                  style={{ backgroundColor: ev.color ?? EVENT_TYPE_COLOR[ev.type] }}
                >
                  {ev.past && <Lock className="h-3 w-3 shrink-0" />}
                  <span className="truncate">{ev.label}</span>
                  <span className="ml-auto shrink-0 text-[10px] uppercase tracking-wide text-white/70">{ev.type}</span>
                </button>
              );
            })}
            {dayDialogEvents.length === 0 && (
              <p className="py-2 text-center text-xs text-muted-foreground">No visible events (check the type filters).</p>
            )}
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
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <FilterChip color={EVENT_TYPE_COLOR.sale} label="Sale" active={typeFilters.sale} onToggle={() => toggleTypeFilter("sale")} />
            <FilterChip color={EVENT_TYPE_COLOR.launch} label="Launch" active={typeFilters.launch} onToggle={() => toggleTypeFilter("launch")} />
            <FilterChip color={EVENT_TYPE_COLOR.broadcast} label="Broadcast" active={typeFilters.broadcast} onToggle={() => toggleTypeFilter("broadcast")} />
          </div>
          <Button
            size="sm"
            variant={showHolidays ? "secondary" : "outline"}
            className={`h-7 px-3 text-xs ${showHolidays ? "" : "text-muted-foreground opacity-60"}`}
            onClick={toggleHolidays}
            title={showHolidays ? "Hide the retail-holiday overlay" : "Show the retail-holiday overlay"}
          >
            Holidays
          </Button>
          <div className="flex rounded-md border border-border/60 p-0.5">
            <Button size="sm" variant={view === "scroll" ? "default" : "ghost"} className="h-7 px-3 text-xs" onClick={() => setView("scroll")}>Calendar</Button>
            <Button size="sm" variant={view === "agenda" ? "default" : "ghost"} className="h-7 px-3 text-xs" onClick={() => setView("agenda")}>Agenda</Button>
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
            <div ref={scrollRef} onScroll={() => requestAnimationFrame(updateStickyMonth)} className="max-h-[72vh] overflow-y-auto">
              {/* Sticky month label + weekday header */}
              <div className="sticky top-0 z-20 bg-card/95 backdrop-blur">
                <div className="px-4 py-2 text-sm font-semibold">{stickyMonth}</div>
                <div className="grid grid-cols-7 gap-px border-y border-border/50 bg-border/50">
                  {WEEKDAYS.map((d) => (
                    <div key={d} className="bg-card px-2 py-1 text-center text-[10px] font-medium text-muted-foreground">{d}</div>
                  ))}
                </div>
              </div>

              <div className="p-2 text-center">
                <Button variant="ghost" size="sm" className="text-xs text-muted-foreground" onClick={() => setMonthsBack((b) => b + 6)}>
                  ↑ Earlier months
                </Button>
              </div>

              <div className="grid grid-cols-7 gap-px bg-border/50">
                {allDays.map((day, idx) => renderDayCell(day, idx))}
              </div>

              <div className="p-2 text-center">
                <Button variant="ghost" size="sm" className="text-xs text-muted-foreground" onClick={() => setMonthsForward((f) => f + 6)}>
                  ↓ More months
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      ) : view === "agenda" ? (
        <Card>
          <CardContent className="p-4">
            <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-lg font-semibold">Next {AGENDA_WEEKS} weeks</h2>
              <p className="text-xs text-muted-foreground">Grouped by week · click an event to open it.</p>
            </div>
            <div className="space-y-5">
              {agendaWeeks.map((w, wi) => (
                <div key={w.weekKey}>
                  <div className="mb-1.5 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-b border-border/50 pb-1">
                    <h3 className="text-sm font-semibold">Week of {format(new Date(`${w.weekKey}T00:00:00`), "MMM d")}</h3>
                    {wi === 0 && <span className="text-[10px] font-medium uppercase tracking-wide text-primary">This week</span>}
                    {showHolidays && w.holidays.map((h) => (
                      <span key={h.dayKey} className="text-[10px] text-cyan-300/70">
                        {format(new Date(`${h.dayKey}T00:00:00`), "EEE M/d")} {h.label}
                      </span>
                    ))}
                  </div>
                  {w.rows.length === 0 ? (
                    <p className="px-2 py-1 text-xs text-muted-foreground/50">Nothing scheduled</p>
                  ) : (
                    <div className="space-y-0.5">
                      {w.rows.map((r) => {
                        const deco = chipDecoration(r.approval, r.past);
                        const ap = r.approval != null ? normalizeApproval(r.approval) : null;
                        return (
                          <button
                            key={`${r.type}-${r.id}-${r.anchor}`}
                            type="button"
                            onClick={() => openEdit({ type: r.type, id: r.id })}
                            className="flex w-full flex-wrap items-center gap-x-2 gap-y-1 rounded px-2 py-1.5 text-left hover:bg-muted/25"
                          >
                            <span className="w-28 shrink-0 text-[11px] tabular-nums text-muted-foreground">
                              {r.endKey
                                ? `${format(new Date(`${r.startKey}T00:00:00`), "MMM d")} – ${format(new Date(`${r.endKey}T00:00:00`), "MMM d")}`
                                : format(new Date(`${r.startKey}T00:00:00`), "EEE, MMM d")}
                            </span>
                            <span
                              className={`max-w-[45%] truncate rounded px-1.5 py-0.5 text-xs text-white/95 sm:max-w-xs ${deco.cls}`}
                              style={{ backgroundColor: r.type === "sale" ? saleColors.get(r.id) ?? EVENT_TYPE_COLOR.sale : EVENT_TYPE_COLOR[r.type] }}
                              title={deco.tip ?? undefined}
                            >
                              {r.name}
                            </span>
                            {r.past && <Lock className="h-3 w-3 shrink-0 text-muted-foreground" />}
                            {r.channel && <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{r.channel}</span>}
                            {r.phaseLabel && <span className={`rounded px-1.5 py-0.5 text-[10px] ${r.phaseCls ?? ""}`}>{r.phaseLabel}</span>}
                            {ap && (
                              <span
                                className={`rounded px-1.5 py-0.5 text-[10px] ${APPROVAL_COLOR[ap]}`}
                                title={approvalTooltip(r.approval) ?? "Ops-confirmed"}
                              >
                                {APPROVAL_LABEL[ap]}
                              </span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              ))}
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

/**
 * One day's slice of a sale span. Markers (open / close / one-day) are 18px
 * pills carrying the name; the days between draw a 6px line at the same lane
 * height. Early-access pieces are black with the sale's color as an outline.
 * Pieces bleed 7px into the grid gap on their open side(s) so the run reads
 * as one continuous bar across cells; a row's first/last cell stays flush.
 */
function SaleSegment({
  span,
  role,
  dayKey,
  dow,
  canEdit,
  onOpen,
}: {
  span: SaleSpan;
  role: SaleSpanRole;
  dayKey: string;
  dow: number;
  canEdit: boolean;
  onOpen: () => void;
}) {
  const ea = role === "ea_start" || role === "ea_line";
  const isLine = role === "line" || role === "ea_line";
  const extendL = (role === "line" || role === "end" || role === "ea_line") && dow !== 0;
  const extendR = (role === "line" || role === "start" || role === "ea_line" || role === "ea_start") && dow !== 6;
  const unconfirmed = span.approval != null && normalizeApproval(span.approval) !== "confirmed";
  const fmtDay = (k: string) => format(new Date(`${k}T00:00:00`), "MMM d");
  const range = span.start === span.end ? fmtDay(span.start) : `${fmtDay(span.start)} – ${fmtDay(span.end)}`;
  const title = [
    span.name,
    ea ? `early access ${fmtDay(span.eaStart ?? span.start)}` : null,
    range,
    span.past ? "locked (past)" : null,
    unconfirmed ? approvalTooltip(span.approval) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const draggable = canEdit && !span.past;
  const cursor = span.past ? "cursor-pointer" : canEdit ? "cursor-grab active:cursor-grabbing" : "cursor-pointer";
  const margins = `${extendL ? "-ml-[7px]" : ""} ${extendR ? "-mr-[7px]" : ""}`;
  const opacity = span.past ? "opacity-60" : unconfirmed ? "opacity-75" : "";
  const fill = ea ? "#000" : span.color;
  const outline = ea ? `1.5px ${unconfirmed ? "dashed" : "solid"} ${span.color}` : undefined;

  const dragProps = {
    draggable,
    onDragStart: (e: React.DragEvent) => {
      e.dataTransfer.setData("text/plain", JSON.stringify({ type: "sale", id: span.id, originKey: dayKey }));
      e.dataTransfer.effectAllowed = "move";
    },
    onClick: (e: React.MouseEvent) => {
      e.stopPropagation();
      onOpen();
    },
    title,
  };

  if (isLine) {
    return (
      <div className={`flex h-[18px] items-center ${margins} ${cursor} ${opacity}`} {...dragProps}>
        <div className="h-[6px] w-full" style={{ backgroundColor: fill, border: outline }} />
      </div>
    );
  }

  const radius = role === "single" ? "rounded" : role === "end" ? "rounded-r" : "rounded-l";
  const dashed = !ea && unconfirmed ? "border border-dashed border-white/60" : "";
  const label = role === "ea_start" ? `EA · ${span.name}` : span.name;
  return (
    <div className={`h-[18px] ${margins}`}>
      <button
        type="button"
        {...dragProps}
        className={`block h-full w-full truncate ${radius} px-1 text-left text-[10px] leading-[16px] text-white/95 hover:opacity-90 ${dashed} ${cursor} ${opacity}`}
        style={{ backgroundColor: fill, border: outline }}
      >
        {span.past && "🔒 "}{label}
      </button>
    </div>
  );
}

function FilterChip({ color, label, active, onToggle }: { color: string; label: string; active: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      title={active ? `Hide ${label.toLowerCase()} events` : `Show ${label.toLowerCase()} events`}
      className={`flex items-center gap-1.5 rounded-md border border-border/60 px-2 py-0.5 transition-opacity hover:bg-muted/30 ${active ? "" : "opacity-40"}`}
    >
      <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: color }} />
      {label}
    </button>
  );
}
