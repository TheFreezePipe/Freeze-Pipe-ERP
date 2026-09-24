import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
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
  SALE_FALLBACK_COLOR,
  EARLY_ACCESS_LABEL,
  saleColorMap,
  saleTextColor,
  hexToRgba,
  assignSaleLanes,
  indexSaleSpans,
  saleSegmentOnDay,
  formatDayKeyShort,
  formatSpanRange,
  weekKeyOf,
  type SaleSpan,
  type SaleSpanInput,
  type SaleSegmentDraw,
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
type View = "scroll" | "agenda" | "year";
type Ev = {
  id: string;
  type: EvType;
  /** Plain name (no prefixes); `ea` marks an early-access-day entry. */
  label: string;
  ea: boolean;
  originKey: string;
  past: boolean;
  /** approval_status for sales/launches; null for broadcasts (no approval track). */
  approval: string | null;
  /** Per-sale hue (sales only); launches and broadcasts use their type hue. */
  color?: string;
};
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const AGENDA_WEEKS = 8;
/** Visible 20px slots per cell (sale lanes + point rows) before "+N more". */
const CELL_SLOTS = 4;

// Type hues (reserved: never used by the sale palette) and their text steps.
const LAUNCH_HUE = "#a78bfa";
const BROADCAST_HUE = "#22d3ee";
const TYPE_TEXT: Record<"launch" | "broadcast", string> = { launch: "#c4b5fd", broadcast: "#67e8f9" };
const TYPE_LABEL: Record<EvType, string> = { sale: "Sale", launch: "Launch", broadcast: "Broadcast" };
const VIEW_LABEL: Record<View, string> = { scroll: "Month", agenda: "Agenda", year: "Year" };
const CHANNEL_LABEL: Record<string, string> = { email: "Email", sms: "SMS" };

// Shared class recipes (kept as literals so Tailwind can see every class).
const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
// Outline-based ring (paints above every descendant, so the hollow outline
// element inside a sale piece can never cover it).
const FOCUS_OUTLINE =
  "focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring";
const CHROME_BG = "bg-[#202020]";
const TOOLBAR_BTN = `inline-flex h-7 items-center whitespace-nowrap rounded-md border border-border px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-white/[.06] ${FOCUS_RING}`;
const TOOLBAR_ICON_BTN = `grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-white/[.06] hover:text-foreground ${FOCUS_RING}`;
const GHOST_ROW = `flex h-8 w-full items-center justify-center text-xs text-muted-foreground transition-colors hover:bg-white/[.04] ${FOCUS_RING} focus-visible:ring-inset`;
const CHIP_BASE = `inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-md border px-2.5 text-xs font-medium transition-colors hover:bg-white/[.06] ${FOCUS_RING}`;
// The launch/broadcast tints are LAUNCH_HUE / BROADCAST_HUE at 16% alpha,
// spelled out because Tailwind only sees literal classes; their text steps
// come from TYPE_TEXT (applied inline by FilterChip).
const CHIP_ON: Record<EvType | "holiday", string> = {
  sale: "border-transparent bg-white/[.08] text-foreground",
  launch: "border-transparent bg-[rgba(167,139,250,0.16)]",
  broadcast: "border-transparent bg-[rgba(34,211,238,0.16)]",
  holiday: "border-transparent bg-white/[.08] text-foreground",
};
const CHIP_OFF = "border-border text-muted-foreground";
const LOZENGE = "inline-flex h-4 items-center whitespace-nowrap rounded px-1.5 text-[11px] font-medium leading-none";

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

function isUnconfirmed(approval: string | null): boolean {
  return approval != null && normalizeApproval(approval) !== "confirmed";
}

/** 45° hatch of the hue (2px on / 4px off at 40%) over an 8% base: the draft treatment. */
function draftStripes(hue: string): string {
  return `repeating-linear-gradient(45deg, ${hexToRgba(hue, 0.4)} 0 2px, transparent 2px 6px), ${hexToRgba(hue, 0.08)}`;
}

/** A single agenda row (sale span, launch day, or broadcast day). */
type AgendaRow = {
  type: EvType;
  id: string;
  anchor: string; // the day-key that places the row in a week group
  startKey: string;
  endKey: string | null; // set only for multi-day sales
  eaKey: string | null; // early-access day when it precedes the start (sales + launches)
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
  const [view, setView] = useState<View>("scroll");
  const [monthsBack, setMonthsBack] = useState(1);
  const [monthsForward, setMonthsForward] = useState(12);
  const [year, setYear] = useState(today.getFullYear());
  const [stickyYm, setStickyYm] = useState(todayMonthKey); // month at the top of the scroll view
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const agendaRef = useRef<HTMLDivElement | null>(null);
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

  // Map each calendar day → its point events (keys sliced from the stored
  // date, tz-safe). Type filters apply here so month cells, the day popover,
  // and "+N more" counts all agree on what's visible.
  const byDay = useMemo(() => {
    const m = new Map<string, Ev[]>();
    const push = (day: string, ev: Ev) => {
      const arr = m.get(day) ?? [];
      arr.push(ev);
      m.set(day, arr);
    };
    // Sales are drawn as spans (see saleSpans below), not per-day rows.
    if (typeFilters.launch) {
      for (const l of launches) {
        const k = dayKeyOf(l.launch_date);
        if (!k) continue;
        const lea = dayKeyOf(l.early_access_date);
        if (lea && lea < k) {
          push(lea, { id: l.id, type: "launch", label: l.name, ea: true, originKey: lea, past: isPastKey(lea, todayKey), approval: l.approval_status });
        }
        push(k, { id: l.id, type: "launch", label: l.name, ea: false, originKey: k, past: isPastKey(k, todayKey), approval: l.approval_status });
      }
    }
    if (typeFilters.broadcast) {
      for (const b of broadcasts) {
        const k = dayKeyOf(b.sent_at) ?? dayKeyOf(b.scheduled_at);
        if (!k) continue;
        push(k, { id: b.id, type: "broadcast", label: b.name, ea: false, originKey: k, past: isPastKey(k, todayKey), approval: null });
      }
    }
    return m;
  }, [launches, broadcasts, todayKey, typeFilters]);

  // Sales as spans: one hue per sale, a lane per overlapping sale, and an
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
        color: saleColors.get(s.id) ?? SALE_FALLBACK_COLOR,
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
        const ea = dayKeyOf(s.early_access_starts_at);
        rows.push({
          type: "sale", id: s.id, anchor, startKey: st, endKey: en !== st ? en : null, eaKey: ea && ea < st ? ea : null,
          name: s.name, channel: null,
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
        const ea = dayKeyOf(l.early_access_date);
        rows.push({
          type: "launch", id: l.id, anchor: k, startKey: k, endKey: null, eaKey: ea && ea < k ? ea : null,
          name: l.name, channel: null,
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
          type: "broadcast", id: b.id, anchor: k, startKey: k, endKey: null, eaKey: null, name: b.name, channel: b.channel,
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
    const top = anchor.getBoundingClientRect().top - cont.getBoundingClientRect().top + cont.scrollTop;
    cont.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
  }

  // Update the toolbar month label to whatever month sits at the top of the view.
  function updateStickyMonth() {
    const cont = scrollRef.current;
    if (!cont) return;
    const line = cont.getBoundingClientRect().top + 4;
    let ym: string | null = null;
    for (const m of months) {
      const key = format(m, "yyyy-MM");
      const a = monthAnchors.current[key];
      if (!a) continue;
      if (a.getBoundingClientRect().top <= line) ym = key;
      else break;
    }
    if (ym) setStickyYm(ym);
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

  /** ‹ › in the month view step from the month currently at the top of the grid. */
  function stepMonth(delta: number) {
    goToMonth(addMonths(new Date(`${stickyYm}-01T00:00:00`), delta));
  }

  function onTodayClick() {
    if (view === "year") setYear(today.getFullYear());
    else if (view === "agenda") agendaRef.current?.scrollTo({ top: 0, behavior: "smooth" });
    else goToMonth(today);
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
    const dayN = day.getDate();
    const isMonthStart = dayN === 1;
    const clickable = canEdit && !isPast;
    const holiday = showHolidays ? holidayByDay.get(key) : undefined;
    const spansToday = spanIndex.byDay.get(key) ?? [];
    const laneCount = spanIndex.lanesByWeek.get(weekKeyOf(key)) ?? 0;
    const dow = day.getDay();
    // Month boundary: a stepped rule along the top of the 1st's row from the
    // 1st to the row's end, down the 1st's left edge, then along the top of
    // the next row's cells left of the 1st's column.
    const row = Math.floor(idx / 7);
    const firstIdx = idx - (dayN - 1);
    const firstRow = Math.floor(firstIdx / 7);
    const firstDow = ((firstIdx % 7) + 7) % 7;
    const ruleTop = firstIdx >= 0 && ((row === firstRow && idx >= firstIdx) || (row === firstRow + 1 && dow < firstDow));
    const ruleLeft = isMonthStart && dow !== 0;
    // Point rows share the cell's slots with the sale lanes; the last slot
    // becomes "+N more" when they don't fit.
    const pointSlots = Math.max(evs.length > 0 ? 1 : 0, CELL_SLOTS - laneCount);
    const overflow = evs.length > pointSlots;
    const shown = overflow ? evs.slice(0, Math.max(0, pointSlots - 1)) : evs;
    return (
      <div
        key={key}
        ref={isMonthStart ? (el) => { monthAnchors.current[ym] = el; } : undefined}
        onClick={() => clickable && setAddDay(key)}
        onDragOver={(e) => { if (canEdit && !isPast) e.preventDefault(); }}
        onDrop={(e) => handleDrop(e, key)}
        title={clickable ? "Click to add an event" : undefined}
        className={`relative flex min-h-[124px] flex-col border-b border-r border-border [&:nth-child(7n)]:border-r-0 ${
          isPast ? "bg-background" : "bg-card"
        } ${clickable ? "cursor-pointer hover:bg-[#202020]" : ""} ${ruleTop ? "shadow-[inset_0_1px_0_#3d3d3d]" : ""} ${
          ruleLeft ? "-ml-px border-l border-l-[#3d3d3d]" : ""
        }`}
      >
        <div className="flex h-7 shrink-0 items-center justify-between gap-2 px-1.5">
          {isToday ? (
            <span className="grid h-[22px] w-[22px] shrink-0 place-items-center rounded-full bg-primary text-xs font-semibold tabular-nums text-background">
              {dayN}
            </span>
          ) : isMonthStart ? (
            <span className="whitespace-nowrap text-xs font-semibold tabular-nums text-foreground">{format(day, "MMM d")}</span>
          ) : (
            <span className={`text-xs tabular-nums ${isPast ? "text-[#676767]" : "text-muted-foreground"}`}>{dayN}</span>
          )}
          {holiday && (
            <span
              className="max-w-[65%] truncate text-[11px] font-medium uppercase tracking-[0.04em] text-muted-foreground"
              title={holiday}
            >
              {holiday}
            </span>
          )}
        </div>
        <div className="flex flex-col gap-0.5 px-1.5 pb-2.5">
          {Array.from({ length: laneCount }, (_, lane) => {
            const sp = spansToday.find((s) => s.lane === lane);
            const draw = sp ? saleSegmentOnDay(sp, key, dow) : null;
            if (!sp || !draw) return <div key={`lane-${lane}`} className="h-5" />;
            return (
              <SaleBarPiece
                key={sp.id}
                span={sp}
                draw={draw}
                dayKey={key}
                canEdit={canEdit}
                onOpen={() => openEdit({ type: "sale", id: sp.id })}
              />
            );
          })}
          {shown.map((ev, i) => (
            <PointRow key={`${ev.type}-${ev.id}-${i}`} ev={ev} canEdit={canEdit} onOpen={() => openEdit(ev)} />
          ))}
          {overflow && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); setDayDialogKey(key); }}
              className={`flex h-5 w-full items-center rounded pl-0.5 text-left text-xs font-medium text-muted-foreground hover:text-foreground ${FOCUS_RING} focus-visible:ring-inset`}
              title="Show all events on this day"
            >
              +{evs.length - shown.length} more
            </button>
          )}
        </div>
      </div>
    );
  }

  // One month card (year view) — sales + launches, in date order.
  function renderMiniMonth(monthDate: Date) {
    const ym = format(monthDate, "yyyy-MM");
    const monthStart = `${ym}-01`;
    const monthEnd = format(endOfMonth(monthDate), "yyyy-MM-dd");
    type YearItem = { id: string; type: EvType; sort: string; label: string; color: string; date: string; past: boolean };
    const items: YearItem[] = [];
    if (typeFilters.sale) {
      for (const s of sales) {
        const st = dayKeyOf(s.starts_at);
        if (!st) continue;
        const en = dayKeyOf(s.ends_at) ?? st;
        if (st > monthEnd || en < monthStart) continue;
        items.push({
          id: `s-${s.id}`, type: "sale", sort: st, label: s.name,
          color: saleColors.get(s.id) ?? SALE_FALLBACK_COLOR,
          date: formatSpanRange({ start: st, end: en }), past: isPastKey(en, todayKey),
        });
      }
    }
    if (typeFilters.launch) {
      for (const l of launches) {
        const k = dayKeyOf(l.launch_date);
        if (!k || !k.startsWith(ym)) continue;
        items.push({ id: `l-${l.id}`, type: "launch", sort: k, label: l.name, color: LAUNCH_HUE, date: formatDayKeyShort(k), past: isPastKey(k, todayKey) });
      }
    }
    items.sort((a, b) => (a.sort < b.sort ? -1 : a.sort > b.sort ? 1 : a.label.localeCompare(b.label)));
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
        className={`flex min-h-[120px] flex-col rounded-lg border border-border bg-card p-3 text-left transition-colors hover:bg-[#202020] ${FOCUS_RING} ${
          isThisMonth ? "shadow-[inset_0_2px_0_hsl(var(--primary))]" : ""
        }`}
      >
        <span className={`mb-1.5 block text-[13px] font-semibold ${isThisMonth ? "text-foreground" : "text-muted-foreground"}`}>{format(monthDate, "MMMM")}</span>
        <span className="flex flex-col">
          {items.slice(0, 6).map((it) => (
            <span key={it.id} className={`flex h-5 items-center gap-1.5 text-xs font-medium text-foreground/90 ${it.past ? "opacity-60" : ""}`}>
              <span className="grid w-3.5 shrink-0 place-items-center"><TypeGlyph type={it.type} color={it.color} /></span>
              <span className="truncate">{it.label}</span>
              <span className="ml-auto shrink-0 pl-2 text-[11px] font-normal tabular-nums text-muted-foreground">{it.date}</span>
            </span>
          ))}
          {items.length > 6 && <span className="flex h-5 items-center text-xs font-medium text-muted-foreground">+{items.length - 6} more</span>}
        </span>
        {monthHolidays.length > 0 && (
          <span className="mt-auto block w-full truncate pt-1.5 text-[11px] text-muted-foreground" title={monthHolidays.join(" · ")}>
            {monthHolidays.join(" · ")}
          </span>
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
          label: sp.name,
          ea: dayDialogKey < sp.start,
          originKey: dayDialogKey,
          past: sp.past,
          approval: sp.approval,
          color: sp.color,
        })),
        ...(byDay.get(dayDialogKey) ?? []),
      ]
    : [];
  const dayDialogHoliday = dayDialogKey ? holidayByDay.get(dayDialogKey) : undefined;

  const toolbarLabel =
    view === "year"
      ? String(year)
      : view === "agenda"
        ? `Next ${AGENDA_WEEKS} weeks`
        : format(new Date(`${stickyYm}-01T00:00:00`), "MMMM yyyy");

  return (
    <div className="flex h-full min-h-[520px] flex-col gap-2">
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
        <DialogContent className="max-w-xs" aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle className="text-sm font-semibold">Add to {addDay ? format(new Date(`${addDay}T00:00:00`), "MMM d, yyyy") : ""}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-2">
            {(["sale", "launch", "broadcast"] as const).map((t) => (
              <Button
                key={t}
                variant="outline"
                className="h-9 justify-start gap-2.5 text-[13px] font-medium"
                onClick={() => { if (addDay) setCreate({ type: t, date: addDay }); setAddDay(null); }}
              >
                <span className="grid w-3.5 shrink-0 place-items-center"><TypeGlyph type={t} /></span>
                {TYPE_LABEL[t]}
              </Button>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      {/* "+N more" day popover — every event on the day, same edit behavior as the cell rows */}
      <Dialog open={!!dayDialogKey} onOpenChange={(o) => !o && setDayDialogKey(null)}>
        <DialogContent className="max-w-sm" {...(dayDialogHoliday ? {} : { "aria-describedby": undefined })}>
          <DialogHeader>
            <DialogTitle className="text-sm font-semibold">
              {dayDialogKey ? format(new Date(`${dayDialogKey}T00:00:00`), "EEEE, MMMM d, yyyy") : ""}
            </DialogTitle>
            {dayDialogHoliday && (
              <DialogDescription className="text-[11px] font-medium uppercase tracking-[0.04em] text-muted-foreground">
                {dayDialogHoliday}
              </DialogDescription>
            )}
          </DialogHeader>
          <div className="max-h-[50vh] overflow-y-auto">
            {dayDialogEvents.map((ev, i) => {
              const unconfirmed = isUnconfirmed(ev.approval);
              const label = ev.ea ? `EA · ${ev.label}` : ev.label;
              const title = [label, ev.past ? "locked (past)" : null, unconfirmed ? approvalTooltip(ev.approval) : null]
                .filter(Boolean)
                .join(" · ");
              return (
                <button
                  key={`${ev.type}-${ev.id}-${i}`}
                  type="button"
                  onClick={() => { setDayDialogKey(null); openEdit(ev); }}
                  title={title}
                  className={`flex h-9 w-full items-center gap-2.5 rounded px-2 text-left transition-colors hover:bg-white/[.06] ${FOCUS_RING} focus-visible:ring-inset ${
                    ev.past ? "opacity-60" : ""
                  }`}
                >
                  <span className="grid w-3.5 shrink-0 place-items-center">
                    <TypeGlyph type={ev.type} color={ev.color} hollow={ev.ea} striped={unconfirmed} />
                  </span>
                  <span className="truncate text-[13px] font-medium text-foreground">{label}</span>
                  <span className={`${LOZENGE} ml-auto shrink-0 bg-white/[.08] text-muted-foreground`}>{TYPE_LABEL[ev.type]}</span>
                </button>
              );
            })}
            {dayDialogEvents.length === 0 && <p className="py-2 text-xs text-[#676767]">Nothing scheduled</p>}
          </div>
        </DialogContent>
      </Dialog>

      {/* Page header: title + view switcher */}
      <div className="flex min-h-10 shrink-0 items-center justify-between gap-3">
        <h1 className="min-w-0 text-xl font-semibold leading-7 tracking-[-0.01em]">Marketing calendar</h1>
        <div role="group" aria-label="View" className="grid grid-flow-col auto-cols-fr overflow-hidden rounded-md border border-border">
          {(["scroll", "agenda", "year"] as const).map((v, i) => (
            <button
              key={v}
              type="button"
              aria-pressed={view === v}
              onClick={() => setView(v)}
              className={`h-7 whitespace-nowrap px-3 text-xs font-medium transition-colors ${FOCUS_RING} focus-visible:ring-inset ${
                i > 0 ? "border-l border-border" : ""
              } ${view === v ? "bg-white/10 text-foreground" : "text-muted-foreground hover:bg-white/[.06]"}`}
            >
              {VIEW_LABEL[v]}
            </button>
          ))}
        </div>
      </div>

      {/* The panel: one toolbar, one scroll region */}
      <div className="flex min-h-0 flex-1 flex-col overflow-x-auto rounded-lg border border-border bg-background">
        <div
          className={`flex h-10 shrink-0 items-center gap-2 border-b border-border px-4 ${CHROME_BG} ${view === "scroll" ? "min-w-[880px]" : "min-w-max"}`}
        >
          <button type="button" className={TOOLBAR_BTN} onClick={onTodayClick}>
            {view === "year" ? "This year" : "Today"}
          </button>
          <button
            type="button"
            aria-label={view === "year" ? "Previous year" : "Previous month"}
            className={`${TOOLBAR_ICON_BTN} ${view === "agenda" ? "invisible" : ""}`}
            onClick={() => (view === "year" ? setYear((y) => y - 1) : stepMonth(-1))}
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            type="button"
            aria-label={view === "year" ? "Next year" : "Next month"}
            className={`${TOOLBAR_ICON_BTN} ${view === "agenda" ? "invisible" : ""}`}
            onClick={() => (view === "year" ? setYear((y) => y + 1) : stepMonth(1))}
          >
            <ChevronRight className="h-4 w-4" />
          </button>
          <span className="ml-2 min-w-[130px] whitespace-nowrap text-sm font-semibold text-foreground">{toolbarLabel}</span>
          <div className="ml-auto flex items-center gap-1.5">
            <FilterChip type="sale" active={typeFilters.sale} onToggle={() => toggleTypeFilter("sale")} />
            <FilterChip type="launch" active={typeFilters.launch} onToggle={() => toggleTypeFilter("launch")} />
            <FilterChip type="broadcast" active={typeFilters.broadcast} onToggle={() => toggleTypeFilter("broadcast")} />
            <span aria-hidden className="mx-1 h-4 w-px bg-border" />
            <FilterChip type="holiday" active={showHolidays} onToggle={toggleHolidays} />
          </div>
        </div>

        {view === "scroll" ? (
          <>
            <div className={`grid h-7 min-w-[880px] shrink-0 grid-cols-7 border-b border-border ${CHROME_BG}`}>
              {WEEKDAYS.map((d, i) => (
                <div
                  key={d}
                  className={`flex items-center pl-1.5 text-xs font-medium uppercase tracking-[0.025em] text-muted-foreground ${i > 0 ? "border-l border-border" : ""}`}
                >
                  {d}
                </div>
              ))}
            </div>
            <div ref={scrollRef} onScroll={() => requestAnimationFrame(updateStickyMonth)} className="min-h-0 min-w-[880px] flex-1 overflow-y-auto">
              <button type="button" className={GHOST_ROW} onClick={() => setMonthsBack((b) => b + 6)}>
                Earlier months
              </button>
              <div className="grid grid-cols-7">
                {allDays.map((day, idx) => renderDayCell(day, idx))}
              </div>
              <button type="button" className={GHOST_ROW} onClick={() => setMonthsForward((f) => f + 6)}>
                More months
              </button>
            </div>
          </>
        ) : view === "agenda" ? (
          <div ref={agendaRef} className="min-h-0 flex-1 overflow-y-auto px-4 pb-6">
            {agendaWeeks.map((w, wi) => {
              return (
                <div key={w.weekKey}>
                  <div className="flex items-center gap-2.5 border-b border-border pb-1.5 pt-3.5 text-xs font-semibold uppercase tracking-[0.04em] text-muted-foreground">
                    <span>Week of {format(new Date(`${w.weekKey}T00:00:00`), "MMM d")}</span>
                    {wi === 0 && <span className={`${LOZENGE} bg-primary/10 normal-case tracking-normal text-primary`}>This week</span>}
                  </div>
                  {showHolidays && w.holidays.map((h) => (
                    <p key={h.dayKey} className="pt-1.5 text-xs text-muted-foreground">
                      {format(new Date(`${h.dayKey}T00:00:00`), "EEE MMM d")}
                      <span className="ml-2">{h.label}</span>
                    </p>
                  ))}
                  {w.rows.length === 0 ? (
                    <p className="py-2 text-xs text-[#676767]">Nothing scheduled</p>
                  ) : (
                    w.rows.map((r, ri) => {
                      // Day gutter once per day group (rows are sorted by anchor).
                      const showGutter = ri === 0 || w.rows[ri - 1].anchor !== r.anchor;
                      const unconfirmed = isUnconfirmed(r.approval);
                      const ap = r.approval != null ? normalizeApproval(r.approval) : null;
                      const anchorDate = new Date(`${r.anchor}T00:00:00`);
                      const meta =
                        r.type === "sale"
                          ? formatSpanRange({ start: r.startKey, end: r.endKey ?? r.startKey })
                          : r.type === "launch"
                            ? r.eaKey ? `early access ${formatDayKeyShort(r.eaKey)}` : ""
                            : r.channel ? CHANNEL_LABEL[r.channel] ?? r.channel.toUpperCase() : "";
                      const title = [r.name, r.past ? "locked (past)" : null, unconfirmed ? approvalTooltip(r.approval) : null]
                        .filter(Boolean)
                        .join(" · ");
                      return (
                        <button
                          key={`${r.type}-${r.id}-${r.anchor}`}
                          type="button"
                          onClick={() => openEdit({ type: r.type, id: r.id })}
                          title={title}
                          className={`flex h-10 w-full items-center gap-3 border-b border-border pr-1.5 text-left transition-colors hover:bg-white/[.04] ${FOCUS_RING} focus-visible:ring-inset`}
                        >
                          <span className="flex w-14 shrink-0 flex-col leading-[1.1]">
                            {showGutter && (
                              <>
                                <span className="text-[11px] font-medium uppercase text-muted-foreground">{format(anchorDate, "EEE")}</span>
                                {r.anchor === todayKey ? (
                                  <span className="grid h-[22px] w-[22px] place-items-center rounded-full bg-primary text-xs font-semibold tabular-nums text-background">
                                    {format(anchorDate, "d")}
                                  </span>
                                ) : (
                                  <span className="text-base font-medium tabular-nums text-foreground">{format(anchorDate, "d")}</span>
                                )}
                              </>
                            )}
                          </span>
                          {/* Past dimming stays off the day gutter (today's marker must read at full strength). */}
                          <span className={`flex min-w-0 flex-1 items-center gap-3 ${r.past ? "opacity-60" : ""}`}>
                            <span className="grid w-3.5 shrink-0 place-items-center">
                              <TypeGlyph type={r.type} color={r.type === "sale" ? saleColors.get(r.id) ?? SALE_FALLBACK_COLOR : undefined} striped={unconfirmed} />
                            </span>
                            <span className="truncate text-[13px] font-medium text-foreground">{r.name}</span>
                            <span className="ml-auto flex shrink-0 items-center gap-2 text-xs tabular-nums text-muted-foreground">
                              {meta && <span className="whitespace-nowrap">{meta}</span>}
                              {r.phaseLabel && <span className={`${LOZENGE} ${r.phaseCls ?? ""}`}>{r.phaseLabel}</span>}
                              {ap && (
                                <span className={`${LOZENGE} ${APPROVAL_COLOR[ap]}`} title={approvalTooltip(r.approval) ?? "Ops-confirmed"}>
                                  {APPROVAL_LABEL[ap]}
                                </span>
                              )}
                            </span>
                          </span>
                        </button>
                      );
                    })
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {Array.from({ length: 12 }, (_, m) => new Date(year, m, 1)).map(renderMiniMonth)}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The type glyph used everywhere an item is listed: sale = 14×6 bar in the
 * sale's hue, launch = 8px violet circle (ring on an early-access day),
 * broadcast = 8px cyan square. `striped` wraps it in the draft hatch.
 */
function TypeGlyph({ type, color, hollow, striped }: { type: EvType; color?: string; hollow?: boolean; striped?: boolean }) {
  const hue = color ?? (type === "launch" ? LAUNCH_HUE : type === "broadcast" ? BROADCAST_HUE : SALE_FALLBACK_COLOR);
  let glyph: React.ReactNode;
  if (type === "sale") {
    glyph = hollow
      ? <span className="block h-1.5 w-3.5 rounded-[3px] border-[1.5px]" style={{ borderColor: hue }} />
      : <span className="block h-1.5 w-3.5 rounded-[3px]" style={{ backgroundColor: hue }} />;
  } else if (type === "launch") {
    glyph = hollow
      ? <span className="block h-2 w-2 rounded-full border-[1.5px]" style={{ borderColor: hue }} />
      : <span className="block h-2 w-2 rounded-full" style={{ backgroundColor: hue }} />;
  } else {
    glyph = <span className="block h-2 w-2 rounded-[1.5px]" style={{ backgroundColor: hue }} />;
  }
  if (!striped) return <>{glyph}</>;
  // 12×12 swatch (mockup) for the 8px point glyphs; the 14px sale bar needs the wider box.
  return (
    <span className={`grid h-3 place-items-center rounded-[2px] ${type === "sale" ? "w-4" : "w-3"}`} style={{ background: draftStripes(hue) }}>
      {glyph}
    </span>
  );
}

/**
 * One day's piece of a sale bar. Pieces bleed 7px into the grid gap on their
 * continuing sides so the run reads as one bar across cells; at a row edge a
 * continuing piece runs square to the cell edge. The public open day carries
 * the 3px cap; early-access days are hollow (faint tint + inset outline in
 * the hue); unconfirmed sales are hatched. The name is hosted once per
 * week-row segment (that piece is the keyboard-reachable button).
 */
function SaleBarPiece({
  span,
  draw,
  dayKey,
  canEdit,
  onOpen,
}: {
  span: SaleSpan;
  draw: SaleSegmentDraw;
  dayKey: string;
  canEdit: boolean;
  onOpen: () => void;
}) {
  const unconfirmed = isUnconfirmed(span.approval);
  const title = [...draw.tooltipParts, unconfirmed ? approvalTooltip(span.approval) : null].filter(Boolean).join(" · ");
  const draggable = canEdit && !span.past;
  const cursor = span.past ? "cursor-pointer" : canEdit ? "cursor-grab active:cursor-grabbing" : "cursor-pointer";
  const hue = span.color;
  const marginLeft = draw.bleedL ? -7 : draw.edgeL ? -6 : 0;
  const marginRight = draw.bleedR ? -7 : draw.edgeR ? -6 : 0;
  const background = unconfirmed
    ? draftStripes(hue)
    : draw.hollow
      ? hexToRgba(hue, 0.06)
      : hexToRgba(hue, 0.18);
  // The focus ring is an outline (not a box-shadow) so the hollow-outline
  // element below can never paint over it.
  const className = `relative flex h-5 items-center overflow-hidden text-left transition-[filter] hover:brightness-110 ${
    draw.roundL ? "rounded-l" : ""
  } ${draw.roundR ? "rounded-r" : ""} ${span.past ? "opacity-60" : ""} ${cursor} ${FOCUS_OUTLINE}`;
  const style: React.CSSProperties = { marginLeft, marginRight, background };
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
  const cap = draw.cap ? <span aria-hidden className="absolute inset-y-0 left-0 w-[3px]" style={{ backgroundColor: hue }} /> : null;
  // Hollow outline: top + bottom always, left only at the true first day; the
  // right edge is either the cap (public open) or a square wrap, never a line.
  const outline = draw.hollow ? (
    <span
      aria-hidden
      className={`pointer-events-none absolute inset-0 border-y-[1.5px] ${draw.roundL ? "rounded-l border-l-[1.5px]" : ""}`}
      style={{ borderColor: hue }}
    />
  ) : null;

  if (draw.showLabel) {
    return (
      <button type="button" className={className} style={style} {...dragProps}>
        {outline}
        {cap}
        <span className={`truncate text-xs font-medium leading-5 ${draw.cap ? "pl-[11px]" : "pl-2"}`} style={{ color: saleTextColor(hue) }}>
          {draw.label === "early_access" ? EARLY_ACCESS_LABEL : span.name}
        </span>
      </button>
    );
  }
  return (
    <div className={className} style={style} {...dragProps}>
      {outline}
      {cap}
    </div>
  );
}

/** A launch or broadcast row in a day cell: type glyph + plain name. */
function PointRow({ ev, canEdit, onOpen }: { ev: Ev; canEdit: boolean; onOpen: () => void }) {
  const unconfirmed = isUnconfirmed(ev.approval);
  const title = [ev.label, ev.ea ? "early access" : null, ev.past ? "locked (past)" : null, unconfirmed ? approvalTooltip(ev.approval) : null]
    .filter(Boolean)
    .join(" · ");
  const draggable = canEdit && !ev.past;
  const cursor = ev.past ? "cursor-pointer" : canEdit ? "cursor-grab active:cursor-grabbing" : "cursor-pointer";
  return (
    <button
      type="button"
      draggable={draggable}
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", JSON.stringify({ type: ev.type, id: ev.id, originKey: ev.originKey }));
        e.dataTransfer.effectAllowed = "move";
      }}
      onClick={(e) => { e.stopPropagation(); onOpen(); }}
      title={title}
      className={`flex h-5 w-full items-center gap-1.5 overflow-hidden whitespace-nowrap rounded pl-0.5 pr-1 text-left text-xs text-foreground/90 transition-colors hover:bg-white/[.06] ${FOCUS_RING} focus-visible:ring-inset ${
        ev.past ? "opacity-60" : ""
      } ${cursor}`}
    >
      <span className="grid w-4 shrink-0 place-items-center">
        <TypeGlyph type={ev.type} hollow={ev.ea} striped={unconfirmed} />
      </span>
      <span className="truncate">{ev.label}</span>
    </button>
  );
}

/** Toolbar legend chip: glyph + word, tinted when on, outlined + muted when off. */
function FilterChip({ type, active, onToggle }: { type: EvType | "holiday"; active: boolean; onToggle: () => void }) {
  const label = type === "holiday" ? "Holidays" : TYPE_LABEL[type];
  const title =
    type === "holiday"
      ? active ? "Hide the retail-holiday overlay" : "Show the retail-holiday overlay"
      : active ? `Hide ${label.toLowerCase()} events` : `Show ${label.toLowerCase()} events`;
  const glyphColor = !active
    ? "hsl(var(--muted-foreground))"
    : type === "sale"
      ? "hsl(var(--foreground))"
      : undefined;
  const textColor = active && (type === "launch" || type === "broadcast") ? TYPE_TEXT[type] : undefined;
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onToggle}
      title={title}
      className={`${CHIP_BASE} ${active ? CHIP_ON[type] : CHIP_OFF}`}
      style={{ color: textColor }}
    >
      {type !== "holiday" && <TypeGlyph type={type} color={glyphColor} />}
      {label}
    </button>
  );
}
