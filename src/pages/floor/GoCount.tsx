import { useMemo, useRef, useState, type ReactNode } from "react";
import { format, parseISO, differenceInCalendarDays } from "date-fns";
import { AlertTriangle, Check, ChevronRight, Link2, Loader2, LogOut, PackageX, SkipForward, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { TaskActions, TaskHeader } from "@/components/layout/TaskShell";
import { BigStepper } from "@/components/shared/BigStepper";
import { LocationCode } from "@/components/warehouse/LocationCode";
import { ScanSink } from "@/components/warehouse/ScanSink";
import { useAuth } from "@/lib/auth-context";
import {
  newClientEventId,
  resolveWhScan,
  useLinkBarcode,
  useWhCreateCount,
  useWhSkuIndex,
  useWhStartStation,
  type WhResolvedScan,
} from "@/lib/hooks";
import {
  addCartonEntries,
  addLooseUnit,
  cartonKey,
  COUNT_KIND_WORDS,
  countLinesPayload,
  fetchWhCartonSkus,
  isCountDue,
  labelColourFlag,
  nextCountTask,
  orderCountPath,
  removeEntry,
  setEntryQty,
  useWhCountTasks,
  useWhRecordCount,
  type WhCountEntry,
  type WhCountTaskRow,
} from "@/lib/hooks/use-warehouse-counts";
import type { WhCountKind } from "@/lib/hooks/use-warehouse-map";
import { WH_ZONE_COLORS } from "@/lib/status-colors";
import { bayWords, stationCode } from "@/lib/warehouse/scan";
import { cn } from "@/lib/utils";
import { FloorFlash } from "./FloorFlash";
import { useFloorFlash } from "./use-floor-flash";

/**
 * Phone cycle count (design §8, wireframe PhoneCount), one route driven by
 * state so nothing remounts between locations:
 *   1. The list: open and counting tasks due today or earlier, sorted by
 *      pick_sequence so the list is the walk (later ones fold away). Tapping
 *      one opens it; scanning any location label starts its open task, or an
 *      ad hoc one (rpc_wh_create_count for managers and admins; for a user
 *      rpc_wh_record_count opens it at submit).
 *   2. Counting, blind: the screen shows only what has been scanned. A sealed
 *      carton's LPN adds it at its full quantity; an open carton's LPN asks for
 *      units on the stepper; a product barcode (UPC or SKU) adds one loose
 *      unit per scan, correctable on the stepper. An unknown barcode flashes
 *      red and offers managers "Link to SKU". A white LPN in an RTS zone or a
 *      green one in a RAW zone is taken with an amber flash and a "wrong label
 *      colour" marker.
 *   3. Done submits rpc_wh_record_count with a client event id (reused on a
 *      retry of the same lines), flashes green, says whether the count was
 *      approved or sent for review (never expected figures) and opens the
 *      next task in the path.
 * Task reasons are not shown here: a reconcile reason carries the residual.
 */

interface CountLocation {
  id: string;
  code: string;
  name: string | null;
  kind: string;
  zone: string;
  is_overflow: boolean;
}

interface ActiveCount {
  taskId: string | null;
  kind: WhCountKind | null;
  location: CountLocation;
  /** The location label was scanned here (or the counter chose to start without it). */
  confirmed: boolean;
  /** Set when the count starts at the location; movements after it flag moved_during_count. */
  startedAt: string | null;
}

type Tone = "info" | "warn" | "fail";

interface ScanMatchLoose {
  sku_id?: string;
  sku?: string;
  product_name?: string;
}

interface ScanMatchCarton {
  id: string;
  code: string;
  sku_id: string | null;
  sku: string | null;
  product_name: string | null;
  qty: number;
  state: string;
  label_stock: "white" | "green";
}

interface ScanMatchLocation {
  id: string;
  code: string;
  name: string | null;
  kind: string;
  zone: string;
  is_overflow: boolean;
  active: boolean;
}

function errorText(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

function locationOf(task: WhCountTaskRow): CountLocation | null {
  const l = task.location;
  if (!l) return null;
  return { id: l.id, code: l.code, name: l.name, kind: l.kind, zone: l.zone, is_overflow: l.is_overflow };
}

function dueWords(due: string | null, today: Date): { text: string; tone: "late" | "today" | "later" } {
  if (!due) return { text: "Due any time", tone: "today" };
  const days = differenceInCalendarDays(parseISO(due), today);
  if (days < 0) return { text: `${-days} d overdue`, tone: "late" };
  if (days === 0) return { text: "Due today", tone: "today" };
  return { text: `Due ${format(parseISO(due), "EEE MMM d")}`, tone: "later" };
}

const FLAG_WORDS = { needs_green: "Wrong label colour: needs a green label", needs_white: "Wrong label colour: needs a white label" };

export default function GoCount() {
  const { hasRole } = useAuth();
  const canManage = hasRole("admin", "manager");
  const { data: tasks = [], isLoading, error } = useWhCountTasks(["open", "counting"], { refetchInterval: 60_000 });
  const record = useWhRecordCount();
  const createCount = useWhCreateCount();
  const { mutate: startStation } = useWhStartStation();
  const { flash, show } = useFloorFlash();

  const now = new Date();
  // due_date is the database's current_date (UTC), so compare with the UTC day.
  const today = now.toISOString().slice(0, 10);
  // Counted or skipped here: off the path at once, before the refetch.
  const [doneIds, setDoneIds] = useState<ReadonlySet<string>>(() => new Set());
  const path = useMemo(() => orderCountPath(tasks.filter((t) => !doneIds.has(t.id))), [tasks, doneIds]);
  const due = useMemo(() => path.filter((t) => isCountDue(t, today)), [path, today]);
  const later = useMemo(() => path.filter((t) => !isCountDue(t, today)), [path, today]);

  const [active, setActive] = useState<ActiveCount | null>(null);
  const [entries, setEntries] = useState<WhCountEntry[]>([]);
  const [notice, setNotice] = useState<{ tone: Tone; text: string } | null>(null);
  const [lastResult, setLastResult] = useState<{ code: string; status: "approved" | "submitted" } | null>(null);
  const [unknownScan, setUnknownScan] = useState<string | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [showLater, setShowLater] = useState(false);
  const [leaveArmed, setLeaveArmed] = useState(false);
  const [counted, setCounted] = useState(0);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  // One idempotency key per submission: a retry of the same lines replays the first result.
  const eventRef = useRef<{ key: string; id: string } | null>(null);

  const pending = entries.find((e) => e.needsUnits) ?? null;

  function fail(text: string, label?: string) {
    show("fail", label ?? "Not counted");
    setNotice({ tone: "fail", text });
  }

  function begin(next: ActiveCount) {
    setActive(next);
    setEntries([]);
    setNotice(null);
    setUnknownScan(null);
    setLeaveArmed(false);
    eventRef.current = null;
  }

  function openTask(task: WhCountTaskRow, confirmed: boolean) {
    const location = locationOf(task);
    if (!location) return;
    begin({
      taskId: task.id,
      kind: task.kind as WhCountKind,
      location,
      confirmed,
      startedAt: confirmed ? new Date().toISOString() : null,
    });
  }

  function confirmHere() {
    setActive((a) => (a ? { ...a, confirmed: true, startedAt: a.startedAt ?? new Date().toISOString() } : a));
    setNotice(null);
  }

  function backToList() {
    setActive(null);
    setEntries([]);
    setNotice(null);
    setUnknownScan(null);
    setLeaveArmed(false);
    eventRef.current = null;
  }

  async function run(work: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await work();
    } catch (err) {
      fail(errorText(err, "That didn't work"));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  function startStationFrom(raw: string) {
    startStation(
      { scan: raw },
      {
        onSuccess: (r) => show("ok", r.session.name ?? r.session.code),
        onError: (err) => fail(errorText(err, "Couldn't start the station"), "Station not started"),
      },
    );
  }

  /** A location label: its open task, or a new ad hoc count there. */
  async function startAt(r: WhResolvedScan) {
    const m = r.match as unknown as ScanMatchLocation | null;
    const code = r.code ?? m?.code ?? "That location";
    if (!r.id || !m) {
      fail(`${code} is not a location.`, "Not a location");
      return;
    }
    if (m.kind === "virtual" || m.kind === "station") {
      fail(`${code} cannot be counted: it is not a place that holds stock.`, `${code} can't be counted`);
      return;
    }
    if (m.active === false) {
      fail(`${code} is inactive.`, `${code} is inactive`);
      return;
    }
    const location: CountLocation = { id: r.id, code, name: m.name, kind: m.kind, zone: m.zone, is_overflow: m.is_overflow };
    const existing = tasks.find((t) => t.location_id === r.id);
    if (existing && !doneIds.has(existing.id)) {
      openTask(existing, true);
      show("ok", `Counting ${code}`);
      return;
    }
    let taskId: string | null = null;
    if (canManage) {
      const res = await createCount.mutateAsync({ locationIds: [r.id], kind: "ad_hoc", reason: "Counted from the floor" });
      taskId = res.created[0] ?? res.existing[0] ?? null;
      if (!taskId) {
        fail(`${code} cannot be counted.`, `${code} can't be counted`);
        return;
      }
    }
    begin({ taskId, kind: "ad_hoc", location, confirmed: true, startedAt: new Date().toISOString() });
    show("ok", `Counting ${code}`);
  }

  async function addCarton(r: WhResolvedScan, raw: string, here: ActiveCount) {
    const c = r.match as unknown as ScanMatchCarton | null;
    if (!c) {
      fail(r.message ?? `${r.code ?? raw} is not a known carton.`, "Unknown carton");
      return;
    }
    if (r.superseded) {
      fail(r.message ?? `${r.scanned_code ?? raw} was relabelled; scan the green label.`, "Relabelled carton");
      return;
    }
    if (c.state === "void" || c.state === "empty") {
      fail(
        c.state === "empty"
          ? `${c.code} is booked as empty. Count what is in it by scanning each product.`
          : `${c.code} was voided; scan its replacement label.`,
        c.state === "empty" ? "Empty carton" : "Voided carton",
      );
      return;
    }
    const sealed = c.state === "sealed";
    const flag = labelColourFlag(c.label_stock, here.location.zone);
    let add: WhCountEntry[];
    if (c.sku_id) {
      add = [
        {
          key: cartonKey(c.id, c.sku_id, false),
          skuId: c.sku_id,
          sku: c.sku ?? "SKU",
          productName: c.product_name,
          containerId: c.id,
          containerCode: c.code,
          containerState: sealed ? "sealed" : "open",
          qty: sealed ? c.qty : 0,
          scanValue: raw,
          labelFlag: flag,
          needsUnits: !sealed,
        },
      ];
    } else {
      // A mixed carton is counted per SKU: sealed at the label's contents, open on the stepper.
      const skus = await fetchWhCartonSkus(c.id);
      if (skus.length === 0) {
        fail(`${c.code} holds nothing on the books. Count what is in it by scanning each product.`, "Empty carton");
        return;
      }
      add = skus.map((s) => ({
        key: cartonKey(c.id, s.sku_id, true),
        skuId: s.sku_id,
        sku: s.sku?.sku ?? "SKU",
        productName: s.sku?.product_name ?? null,
        containerId: c.id,
        containerCode: c.code,
        containerState: sealed ? "sealed" : "open",
        qty: sealed ? s.on_hand : 0,
        scanValue: raw,
        labelFlag: flag,
        needsUnits: !sealed,
      }));
    }
    // The duplicate check reads this render's lines; the update applies to the latest ones.
    const duplicate = add.some((a) => entries.some((e) => e.key === a.key));
    setEntries((prev) => addCartonEntries(prev, add).entries);
    setUnknownScan(null);
    if (duplicate) {
      show("warn", `${c.code} already counted`);
      setNotice({ tone: "info", text: `${c.code} is already on this count; correct its units on the stepper.` });
      return;
    }
    if (flag) {
      show("warn", "Wrong label colour");
      setNotice({
        tone: "warn",
        text:
          flag === "needs_green"
            ? `${c.code} has a white label in an RTS bay: counted, and flagged for a green label.`
            : `${c.code} has a green label in a RAW bay: counted, and flagged for a white label.`,
      });
      return;
    }
    setNotice(null);
    show("ok", sealed ? `${c.code} · ${c.sku ?? "mixed"}` : `${c.code} · count the units`);
  }

  function addLoose(skuId: string, sku: string, productName: string | null, raw: string) {
    const existing = entries.find((e) => e.key === `sku:${skuId}`);
    setEntries((prev) => addLooseUnit(prev, { skuId, sku, productName, scanValue: raw }));
    setUnknownScan(null);
    setNotice(null);
    show("ok", `${sku} · ${(existing?.qty ?? 0) + 1}`);
  }

  function onScan(raw: string) {
    if (busyRef.current) return;
    if (stationCode(raw)) {
      startStationFrom(raw);
      return;
    }
    void run(async () => {
      const r = await resolveWhScan(raw);
      if (r.kind === "station") {
        startStationFrom(raw);
        return;
      }
      if (r.kind === "practice" || r.kind === "shipstation_order") {
        fail(r.message ?? (r.kind === "shipstation_order" ? "That is a packing slip, not a product." : "That is a practice label."), "Not counted");
        return;
      }

      if (!active) {
        if (r.kind === "location") {
          setLastResult(null);
          await startAt(r);
          return;
        }
        fail("Scan a location label first: the count covers one whole location.", "Scan a location first");
        return;
      }

      if (r.kind === "location") {
        if (r.id === active.location.id) {
          if (!active.confirmed) {
            confirmHere();
            show("ok", `Counting ${active.location.code}`);
          } else {
            show("warn", `Already counting ${active.location.code}`);
          }
          return;
        }
        if (entries.length > 0) {
          fail(
            `You are counting ${active.location.code}. Tap Done to submit it, or Leave to drop it, before starting ${r.code ?? "another location"}.`,
            `Finish ${active.location.code} first`,
          );
          return;
        }
        setLastResult(null);
        await startAt(r);
        return;
      }

      if (!active.confirmed) {
        fail(`Scan ${active.location.code}'s label first, so the count is for the right place.`, `Scan ${active.location.code} first`);
        return;
      }

      if (r.kind === "container") {
        await addCarton(r, raw, active);
        return;
      }
      const match = r.match as unknown as ScanMatchLoose | null;
      if ((r.kind === "gtin" || r.kind === "sku") && match?.sku_id) {
        addLoose(match.sku_id, match.sku ?? r.code ?? "SKU", match.product_name ?? null, raw);
        return;
      }
      if (r.kind !== "gtin" && r.kind !== "sku") {
        // An ERP label nobody knows (a "%" code): not something to link to a SKU.
        fail(r.message ?? `${raw} is not a known label.`, "Unknown label");
        return;
      }
      setUnknownScan(raw);
      fail(
        r.message ??
          `${raw} is not a known barcode.${canManage ? " Link it to its SKU and the unit is counted." : " Ask a manager to link it to its SKU."}`,
        "Unknown barcode",
      );
    });
  }

  async function submit(emptyLocation: boolean) {
    if (!active) return;
    const here = active;
    const lines = emptyLocation ? [] : countLinesPayload(entries);
    const key = JSON.stringify({ task: here.taskId, loc: here.location.id, lines });
    if (!eventRef.current || eventRef.current.key !== key) eventRef.current = { key, id: newClientEventId() };
    const res = await record.mutateAsync({
      locationId: here.location.id,
      lines,
      countTaskId: here.taskId,
      startedAt: here.startedAt,
      clientEventId: eventRef.current.id,
    });
    eventRef.current = null;
    show("ok", `Counted ${here.location.code}`);
    setLastResult({ code: here.location.code, status: res.status });
    setCounted((n) => n + 1);
    const finished = new Set(doneIds);
    if (here.taskId) finished.add(here.taskId);
    finished.add(res.count_task_id);
    setDoneIds(finished);
    const next = nextCountTask(due, here.taskId, finished);
    if (next) openTask(next, false);
    else backToList();
  }

  function skip() {
    if (!active) return;
    const finished = new Set(doneIds);
    if (active.taskId) finished.add(active.taskId);
    setDoneIds(finished);
    setLastResult(null);
    const next = nextCountTask(due, active.taskId, finished);
    if (next) openTask(next, false);
    else backToList();
  }

  function leave() {
    if (entries.length > 0 && !leaveArmed) {
      setLeaveArmed(true);
      setNotice({ tone: "warn", text: `Tap Leave again to drop the ${entries.length} line${entries.length === 1 ? "" : "s"} scanned at ${active?.location.code}.` });
      return;
    }
    backToList();
  }

  const position = active?.taskId ? due.findIndex((t) => t.id === active.taskId) : -1;
  const upNext = active ? nextCountTask(due, active.taskId, active.taskId ? new Set([...doneIds, active.taskId]) : doneIds) : null;
  const progress = active
    ? position >= 0
      ? `${counted + position + 1} of ${counted + due.length}`
      : "Ad hoc"
    : due.length
      ? `${due.length} due`
      : "All counted";

  return (
    <div className="mx-auto max-w-lg space-y-3 md:space-y-4">
      <FloorFlash flash={flash} />
      <TaskHeader title="Count" progress={progress} right={<ScanSink onScan={onScan} />} />

      {error && <NoticeBox tone="fail" text={errorText(error, "Couldn't load the count tasks")} />}

      {lastResult && (
        <div className="flex items-start gap-2 rounded-md border border-green-500/40 bg-green-500/10 px-3 py-2 text-sm text-green-300" role="status">
          <Check className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            <span className="font-mono font-semibold tabular-nums">{lastResult.code}</span>{" "}
            {lastResult.status === "approved" ? "counted: no differences, approved." : "counted: sent to a manager for review."}
          </span>
        </div>
      )}

      {active ? (
        <>
          <Card className={cn(active.confirmed ? "border-green-500/40" : "border-primary")}>
            <CardContent className="space-y-1.5 p-4 text-center">
              <div className="flex items-center justify-center gap-2">
                <p className="text-[11px] uppercase tracking-widest text-muted-foreground">{active.confirmed ? "Counting" : "Go to"}</p>
                {active.confirmed ? (
                  <Chip className="border-green-500/35 bg-green-500/10 text-green-400">scanned</Chip>
                ) : (
                  <Chip className="border-primary/40 bg-primary/10 text-primary">scan its label</Chip>
                )}
                <Chip className="border-violet-400/35 bg-violet-400/10 text-violet-300">blind</Chip>
              </div>
              <LocationCode
                code={active.location.code}
                size="hero"
                words={bayWords(active.location.code) ? true : (active.location.name ?? null)}
                overflow={active.location.is_overflow}
                className="w-full"
              />
              <div className="flex flex-wrap items-center justify-center gap-1.5 pt-1">
                <Chip className={WH_ZONE_COLORS[active.location.zone] ?? "border-border text-muted-foreground"}>{active.location.zone}</Chip>
                {active.kind && <Chip className="border-border text-muted-foreground">{COUNT_KIND_WORDS[active.kind] ?? active.kind}</Chip>}
              </div>
            </CardContent>
          </Card>

          {active.confirmed ? (
            <>
              {pending && (
                <Card className="border-primary">
                  <CardContent className="space-y-3 p-4 text-center">
                    <p className="text-sm">
                      How many units of <span className="font-semibold">{pending.sku}</span> in{" "}
                      <span className="font-mono font-semibold tabular-nums">{pending.containerCode}</span>?
                    </p>
                    <BigStepper
                      value={pending.qty}
                      onChange={(n) => setEntries((prev) => prev.map((e) => (e.key === pending.key ? { ...e, qty: n } : e)))}
                      bigStep={10}
                      label={`Units in ${pending.containerCode}`}
                    />
                    <Button
                      className="h-14 w-full text-base font-semibold touch-manipulation"
                      onClick={() => setEntries((prev) => setEntryQty(prev, pending.key, pending.qty))}
                    >
                      <Check className="mr-2 h-5 w-5" /> {pending.qty} units in {pending.containerCode}
                    </Button>
                  </CardContent>
                </Card>
              )}

              <div className="space-y-2">
                {entries.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
                    Scan every carton label and each loose unit here. Only what you scan is shown.
                  </div>
                ) : (
                  entries.filter((e) => e.key !== pending?.key).map((e) => (
                    <EntryRow
                      key={e.key}
                      entry={e}
                      onQty={(n) => setEntries((prev) => setEntryQty(prev, e.key, n))}
                      onRemove={() => setEntries((prev) => removeEntry(prev, e.key))}
                    />
                  ))
                )}
                <div className="flex min-h-[56px] items-center gap-3 rounded-lg border border-dashed border-border px-3 py-2 text-sm text-muted-foreground">
                  <span className="flex-1">Something else here? Scan it.</span>
                  {unknownScan && canManage && (
                    <Button variant="outline" className="h-11 touch-manipulation" onClick={() => setLinkOpen(true)}>
                      <Link2 className="mr-1.5 h-4 w-4" /> Link to SKU
                    </Button>
                  )}
                </div>
              </div>

              {notice && <NoticeBox tone={notice.tone} text={notice.text} />}
              {record.isError && !notice && <NoticeBox tone="fail" text={errorText(record.error, "Couldn't record the count")} />}

              <p className="flex justify-between text-xs text-muted-foreground">
                <span>Expected totals stay hidden</span>
                {upNext?.location && <span>next {upNext.location.code}</span>}
              </p>

              <TaskActions>
                <Button
                  className="h-14 w-full text-lg font-semibold touch-manipulation"
                  disabled={busy || entries.length === 0 || !!pending}
                  onClick={() => void run(() => submit(false))}
                >
                  {busy ? <Loader2 className="mr-2 h-5 w-5 animate-spin" /> : <Check className="mr-2 h-5 w-5" />}
                  {pending
                    ? `Set the units for ${pending.containerCode} first`
                    : `Done · ${active.location.code} · ${entries.length} line${entries.length === 1 ? "" : "s"}`}
                </Button>
                <div className="flex gap-2">
                  {entries.length === 0 && (
                    <Button
                      variant="outline"
                      className="h-[52px] flex-1 touch-manipulation"
                      disabled={busy}
                      onClick={() => void run(() => submit(true))}
                    >
                      <PackageX className="mr-2 h-4 w-4" /> Location is empty
                    </Button>
                  )}
                  {active.taskId && due.some((t) => t.id === active.taskId) && (
                    <Button variant="outline" className="h-[52px] flex-1 touch-manipulation" disabled={busy} onClick={skip}>
                      <SkipForward className="mr-2 h-4 w-4" /> Skip
                    </Button>
                  )}
                  <Button variant="ghost" className="h-[52px] flex-1 touch-manipulation" disabled={busy} onClick={leave}>
                    <LogOut className="mr-2 h-4 w-4" /> {leaveArmed ? "Leave anyway" : "Leave"}
                  </Button>
                </div>
              </TaskActions>
            </>
          ) : (
            <>
              <Step>
                Walk to <span className="font-mono tabular-nums">{active.location.code}</span> and scan its location label to start
              </Step>
              {notice && <NoticeBox tone={notice.tone} text={notice.text} />}
              <TaskActions>
                <div className="flex gap-2">
                  {active.taskId && due.some((t) => t.id === active.taskId) && (
                    <Button variant="outline" className="h-[52px] flex-1 touch-manipulation" onClick={skip}>
                      <SkipForward className="mr-2 h-4 w-4" /> Skip
                    </Button>
                  )}
                  <Button variant="ghost" className="h-[52px] flex-1 touch-manipulation" onClick={backToList}>
                    Back to list
                  </Button>
                </div>
                <Button variant="ghost" className="h-[52px] w-full text-muted-foreground touch-manipulation" onClick={confirmHere}>
                  Label missing? Start counting here
                </Button>
              </TaskActions>
            </>
          )}
        </>
      ) : (
        <TaskList
          due={due}
          later={later}
          loading={isLoading}
          now={now}
          notice={notice}
          showLater={showLater}
          onToggleLater={() => setShowLater((v) => !v)}
          onPick={(t) => {
            setLastResult(null);
            openTask(t, false);
          }}
        />
      )}

      {canManage && unknownScan && (
        <LinkSheet
          open={linkOpen}
          scan={unknownScan}
          onOpenChange={setLinkOpen}
          onLinked={(sku) => {
            setLinkOpen(false);
            if (active?.confirmed) addLoose(sku.id, sku.sku, sku.product_name, unknownScan);
            else setUnknownScan(null);
          }}
        />
      )}
    </div>
  );
}

function Chip({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <span className={cn("inline-flex items-center rounded-full border px-2.5 py-0.5 text-[11px] font-semibold", className)}>
      {children}
    </span>
  );
}

function Step({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-[52px] items-center gap-2.5 rounded-lg border border-primary bg-primary/10 px-3 py-2 text-sm">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">1</span>
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  );
}

function NoticeBox({ tone, text }: { tone: Tone; text: string }) {
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-md border px-3 py-2 text-sm",
        tone === "fail" && "border-red-500/40 bg-red-500/10 text-red-300",
        tone === "warn" && "border-amber-500/40 bg-amber-500/10 text-amber-300",
        tone === "info" && "border-border text-muted-foreground",
      )}
      role={tone === "info" ? undefined : "alert"}
    >
      {tone !== "info" && <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />}
      <span>{text}</span>
    </div>
  );
}

function EntryRow({ entry, onQty, onRemove }: { entry: WhCountEntry; onQty: (n: number) => void; onRemove: () => void }) {
  return (
    <div
      className={cn(
        "rounded-lg border bg-card px-3 py-2.5",
        entry.labelFlag ? "border-amber-500/50" : "border-border",
      )}
    >
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-bold">
            {entry.sku}
            {entry.productName && <span className="font-normal text-muted-foreground"> · {entry.productName}</span>}
          </p>
          <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            {entry.containerCode ? (
              <>
                <span className="font-mono tabular-nums">{entry.containerCode}</span>
                <span>· {entry.containerState}</span>
              </>
            ) : (
              <span>loose units</span>
            )}
          </p>
        </div>
        <BigStepper value={entry.qty} onChange={onQty} size="md" unit={null} label={`${entry.sku} counted`} />
        <Button
          variant="ghost"
          size="icon"
          className="h-11 w-11 shrink-0 text-muted-foreground touch-manipulation"
          onClick={onRemove}
          aria-label={`Remove ${entry.containerCode ?? entry.sku}`}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
      {entry.labelFlag && (
        <p className="mt-1.5 flex items-center gap-1.5 text-xs font-semibold text-amber-400">
          <AlertTriangle className="h-3.5 w-3.5" /> {FLAG_WORDS[entry.labelFlag]}
        </p>
      )}
    </div>
  );
}

function TaskList({
  due,
  later,
  loading,
  now,
  notice,
  showLater,
  onToggleLater,
  onPick,
}: {
  due: WhCountTaskRow[];
  later: WhCountTaskRow[];
  loading: boolean;
  now: Date;
  notice: { tone: Tone; text: string } | null;
  showLater: boolean;
  onToggleLater: () => void;
  onPick: (t: WhCountTaskRow) => void;
}) {
  if (loading) {
    return (
      <div className="space-y-2">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-16 animate-pulse rounded-lg border border-border/60 bg-muted/30" />
        ))}
      </div>
    );
  }
  return (
    <div className="space-y-3">
      {notice && <NoticeBox tone={notice.tone} text={notice.text} />}
      <p className="text-sm text-muted-foreground">
        Scan any location label to count it, or tap the next one on the path.
      </p>
      {due.length === 0 ? (
        <Card>
          <CardContent className="space-y-1 py-10 text-center">
            <p className="text-base font-semibold">No counts due</p>
            <p className="text-sm text-muted-foreground">Scan a location label to count it anyway.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-1.5">
          {due.map((t, i) => (
            <TaskRow key={t.id} task={t} now={now} first={i === 0} onPick={onPick} />
          ))}
        </div>
      )}
      {later.length > 0 && (
        <div className="space-y-1.5">
          <Button variant="ghost" className="h-11 w-full justify-start px-1 text-muted-foreground touch-manipulation" onClick={onToggleLater}>
            {showLater ? "Hide" : "Show"} {later.length} due later
          </Button>
          {showLater && later.map((t) => <TaskRow key={t.id} task={t} now={now} first={false} onPick={onPick} />)}
        </div>
      )}
    </div>
  );
}

function TaskRow({ task, now, first, onPick }: { task: WhCountTaskRow; now: Date; first: boolean; onPick: (t: WhCountTaskRow) => void }) {
  const dueText = dueWords(task.due_date, now);
  const zone = task.location?.zone ?? "";
  return (
    <button
      type="button"
      onClick={() => onPick(task)}
      className={cn(
        "flex min-h-[60px] w-full items-center gap-3 rounded-lg border px-3 py-2 text-left transition-all touch-manipulation active:scale-[0.99]",
        first ? "border-primary bg-primary/10" : "border-border hover:bg-muted/40",
      )}
    >
      <LocationCode code={task.location?.code ?? "?"} size="small" className="text-lg" />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-1.5">
          {zone && <Chip className={WH_ZONE_COLORS[zone] ?? "border-border text-muted-foreground"}>{zone}</Chip>}
          <span className="text-xs text-muted-foreground">{COUNT_KIND_WORDS[task.kind as WhCountKind] ?? task.kind}</span>
          {task.status === "counting" && <Chip className="border-cyan-500/35 bg-cyan-500/10 text-cyan-400">counting</Chip>}
        </span>
        <span
          className={cn(
            "block text-xs",
            dueText.tone === "late" ? "font-semibold text-amber-400" : "text-muted-foreground",
          )}
        >
          {dueText.text}
        </span>
      </span>
      <ChevronRight className="h-5 w-5 shrink-0 text-muted-foreground" />
    </button>
  );
}

function LinkSheet({
  open,
  scan,
  onOpenChange,
  onLinked,
}: {
  open: boolean;
  scan: string;
  onOpenChange: (open: boolean) => void;
  onLinked: (sku: { id: string; sku: string; product_name: string }) => void;
}) {
  const { data: skus = [] } = useWhSkuIndex();
  const link = useLinkBarcode();
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const q = query.trim().toLowerCase();
  const options = skus
    .filter((s) => s.is_active !== false)
    .filter((s) => !q || s.sku.toLowerCase().includes(q) || s.product_name.toLowerCase().includes(q))
    .slice(0, 8);
  const selected = skus.find((s) => s.id === selectedId) ?? null;

  async function submit() {
    if (!selected) return;
    setError(null);
    try {
      await link.mutateAsync({ skuId: selected.id, scan });
      onLinked({ id: selected.id, sku: selected.sku, product_name: selected.product_name });
    } catch (err) {
      setError(errorText(err, "Couldn't link the barcode"));
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="max-h-[85dvh] space-y-3 overflow-y-auto pb-[max(1rem,env(safe-area-inset-bottom))]">
        <SheetHeader>
          <SheetTitle>Link to SKU</SheetTitle>
          <SheetDescription>
            <span className="font-mono">{scan}</span> becomes this SKU's barcode; the unit is counted once linked.
          </SheetDescription>
        </SheetHeader>
        <Input placeholder="Search SKU" value={query} onChange={(e) => setQuery(e.target.value)} className="h-12 text-base" />
        <div className="grid grid-cols-2 gap-2">
          {options.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setSelectedId(s.id)}
              className={cn(
                "flex min-h-[56px] flex-col items-start rounded-lg border p-3 text-left transition-all active:scale-[0.97] touch-manipulation",
                selectedId === s.id ? "border-primary bg-primary/10 ring-1 ring-primary" : "border-border hover:bg-muted/50",
              )}
            >
              <span className="text-sm font-bold">{s.sku}</span>
              <span className="line-clamp-1 text-xs text-muted-foreground">{s.product_name}</span>
            </button>
          ))}
        </div>
        {error && <NoticeBox tone="fail" text={error} />}
        <Button className="h-14 w-full text-lg font-semibold touch-manipulation" disabled={!selected || link.isPending} onClick={() => void submit()}>
          {link.isPending ? "Linking…" : selected ? `Link to ${selected.sku}` : "Pick a SKU"}
        </Button>
      </SheetContent>
    </Sheet>
  );
}
