import { lazy, Suspense, useMemo, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { AlertTriangle, Check, ChevronRight, Loader2, PackageOpen, Printer, RefreshCw, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { TaskActions, TaskHeader } from "@/components/layout/TaskShell";
import { CartonLink } from "@/components/warehouse/CartonLink";
import { LocationCode } from "@/components/warehouse/LocationCode";
import { PrintJobStatus, type BrowserPrintJob } from "@/components/warehouse/PrintJobStatus";
import { ScanSink } from "@/components/warehouse/ScanSink";
import { useAuth } from "@/lib/auth-context";
import { useLiveInvalidate } from "@/lib/realtime";
import {
  orderPutawayQueue,
  putawayRank,
  resolveWhScan,
  useWarehouseSettings,
  useWhContainerContents,
  useWhOpenContainer,
  useWhPutaway,
  useWhPutawayLoose,
  useWhPutawayQueue,
  useWhRequestLabels,
  useWhStartStation,
  useWhSuggestPutaway,
  type WhBucket,
  type WhLabelKind,
  type WhMoveRow,
  type WhPrintJobResult,
  type WhSuggestion,
  type WhSuggestionReason,
} from "@/lib/hooks";
import { playFeedback } from "@/lib/warehouse/feedback";
import { bayWords, cartonCode, stationCode } from "@/lib/warehouse/scan";
import { cn } from "@/lib/utils";
import { FloorFlash } from "./FloorFlash";
import { useFloorFlash } from "./use-floor-flash";

const LabelSheet = lazy(() => import("@/components/warehouse/LabelSheet"));

/**
 * Phone putaway (design §7, wireframe PhonePutaway), one route driven by
 * state so nothing remounts between cartons:
 *   1. Waiting: the ScanSink is live; the queue lists the worker's own RTS
 *      cartons, then cartons at IN-01, then the rest, oldest first. Tapping a
 *      row or scanning its LPN selects it.
 *   2. Carton selected: "Put it in 02-01-3" with the face/bay/level words,
 *      SKU or MIXED, units, the reason, the next carton; Suggest another,
 *      Open to pick face (when the suggestion is the SKU's face), Reprint.
 *   3. A location scan: the suggested one flashes green, any other storable
 *      one amber (recorded as not followed), a virtual or inactive one red
 *      and nothing changes. With scan_rules.confirm_putaway_location off,
 *      "Put here" confirms without the scan.
 *   4. Back to waiting with the next carton preselected (the RPC's `next`).
 * Every write sends a fresh client_event_id. `?lpn=C-466-007` preselects.
 */

const REASON_WORDS: Record<WhSuggestionReason, string> = {
  same_sku_reserve: "Same SKU in reserve",
  same_sku_face: "This SKU's pick face",
  nearest_empty: "Nearest empty bay",
  other_zone_empty: "Empty bay in another zone",
  breakdown_shelf: "Break-down shelf (mixed carton)",
  none: "No suggestion",
};

const GROUP_WORDS = ["Your RTS cartons", "At IN-01", "Elsewhere"];

interface Shown {
  location_id: string | null;
  code: string | null;
  reason: WhSuggestionReason | null;
  name?: string | null;
  overflow?: boolean;
}

interface Target {
  id: string;
  code: string;
}

function errorText(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

function cartonOf(row: WhMoveRow): string {
  return row.container?.code ?? `${row.sku?.sku ?? "Loose units"}`;
}

/**
 * The carton's code as a link to its passport, or the SKU for loose units.
 * `raised` lifts the link above a row's stretched pick button.
 */
function CartonName({ row, className, raised = false }: { row: WhMoveRow; className?: string; raised?: boolean }) {
  return row.container?.code ? (
    <CartonLink code={row.container.code} className={cn(raised && "relative z-10", className)} />
  ) : (
    <span className={cn("font-mono tabular-nums", className)}>{cartonOf(row)}</span>
  );
}

/**
 * A tap-to-pick row: the button's ::after covers the whole row, and the
 * carton code (relative z-10) sits above it as its own link, so the code
 * opens the passport and anywhere else picks the carton. Sibling controls,
 * never a link inside a button.
 */
const PICK_BUTTON =
  "shrink-0 rounded-lg text-muted-foreground after:absolute after:inset-0 after:rounded-lg focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-ring";

/** "BW20 · Bowl 20" / "MIXED" / "BW20 × 6 loose". */
function whatLine(row: WhMoveRow): string {
  if (row.container) {
    const sku = row.container.sku;
    return sku ? `${sku.sku} · ${sku.product_name}` : "MIXED";
  }
  return `${row.sku?.sku ?? "SKU"} loose`;
}

function unitsOf(row: WhMoveRow): number {
  return row.container ? row.container.qty : (row.qty ?? 0);
}

function shownFor(row: WhMoveRow, override: WhSuggestion | undefined): Shown {
  if (override) return { location_id: override.location_id, code: override.code, reason: override.reason };
  return {
    location_id: row.suggested_location_id,
    code: row.suggested?.code ?? null,
    reason: (row.suggestion_reason as WhSuggestionReason | null) ?? null,
    name: row.suggested?.name ?? null,
    overflow: row.suggested?.is_overflow ?? false,
  };
}

export default function GoPutaway() {
  const { user } = useAuth();
  const [searchParams] = useSearchParams();
  useLiveInvalidate("go-putaway", ["wh_moves", "wh_containers"], [["wh-putaway"], ["wh-container-contents"]]);
  const { data: rows = [], isLoading, error } = useWhPutawayQueue({}, { refetchInterval: 60_000 });
  const { data: settings } = useWarehouseSettings();
  const scanRules = settings?.scan_rules as { confirm_putaway_location?: boolean } | undefined;
  const confirmByScan = scanRules?.confirm_putaway_location !== false;

  const putaway = useWhPutaway();
  const putawayLoose = useWhPutawayLoose();
  const openContainer = useWhOpenContainer();
  const suggest = useWhSuggestPutaway();
  const { mutate: requestLabels, isPending: requesting } = useWhRequestLabels();
  const { mutate: startStation } = useWhStartStation();
  const { flash, show } = useFloorFlash();

  // Rows finished here disappear at once, before the refetch brings the new queue.
  const [doneIds, setDoneIds] = useState<ReadonlySet<string>>(() => new Set());
  const queue = useMemo(
    () => orderPutawayQueue(rows, user?.id ?? null).filter((r) => !doneIds.has(r.id)),
    [rows, user?.id, doneIds],
  );

  // ?lpn= preselects that carton until the worker picks another or goes back to the list.
  const [wanted, setWanted] = useState<string | null>(() => {
    const v = searchParams.get("lpn");
    return v ? (cartonCode(v) ?? v.trim().toUpperCase()) : null;
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedBy, setSelectedBy] = useState<"scan" | "tap">("tap");
  const [nextId, setNextId] = useState<string | null>(null);
  const [overrides, setOverrides] = useState<Record<string, { suggestion: WhSuggestion; exclude: string[] }>>({});
  const [openFor, setOpenFor] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ moveId: string | null; tone: "info" | "warn" | "fail"; text: string } | null>(null);
  const [reprint, setReprint] = useState<{ moveId: string; kind: WhLabelKind; containerId: string; res: WhPrintJobResult } | null>(null);
  const [browserJob, setBrowserJob] = useState<BrowserPrintJob | null>(null);
  const [done, setDone] = useState(0);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  const wantedRow = wanted ? (queue.find((r) => r.container?.code.toUpperCase() === wanted) ?? null) : null;
  const selected = selectedId ? (queue.find((r) => r.id === selectedId) ?? null) : wantedRow;
  const override = selected ? overrides[selected.id]?.suggestion : undefined;
  const shown = selected ? shownFor(selected, override) : null;
  const openMode = !!selected && openFor === selected.id;
  const rest = selected ? queue.filter((r) => r.id !== selected.id) : queue;
  const nextRow = selected ? (rest[0] ?? null) : (queue.find((r) => r.id === nextId) ?? null);
  const { data: contents = [] } = useWhContainerContents(selected?.container && !selected.container.sku_id ? selected.container_id : null);

  function select(row: WhMoveRow, by: "scan" | "tap") {
    setSelectedId(row.id);
    setSelectedBy(by);
    setWanted(null);
    setNotice(null);
    if (by === "scan") playFeedback("ok");
  }

  function backToList() {
    setSelectedId(null);
    setWanted(null);
    setNotice(null);
  }

  function fail(text: string, label?: string, moveId: string | null = selected?.id ?? null) {
    show("fail", label ?? "Not placed");
    setNotice({ moveId, tone: "fail", text });
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

  async function selectByCarton(code: string) {
    const row = queue.find((r) => r.container?.code.toUpperCase() === code);
    if (row) {
      select(row, "scan");
      return;
    }
    // Not in the queue: say why (put away already, voided, unknown).
    try {
      const r = await resolveWhScan(`%${code}`);
      const where = r.match?.location_code;
      fail(
        r.message ??
          (r.kind === "container"
            ? `${r.code ?? code} has no open putaway${where ? `; it is in ${where}` : ""}.`
            : `${code} is not a known carton.`),
        "No putaway",
        null,
      );
    } catch (err) {
      fail(errorText(err, `${code} is not waiting for putaway.`), "No putaway", null);
    }
  }

  async function place(row: WhMoveRow, to: Target, opts: { open?: boolean } = {}) {
    const rowShown = shownFor(row, overrides[row.id]?.suggestion);
    const suggestedHere = rowShown.location_id != null && rowShown.location_id === to.id;
    let tone: "ok" | "warn" = "ok";
    let label = `In ${to.code}`;
    let text: string | null = null;
    let next: string | null = null;

    if (opts.open && row.container_id) {
      const res = await openContainer.mutateAsync({ containerId: row.container_id, toLocationId: to.id });
      label = `Opened at ${to.code}`;
      if (res.warning) {
        tone = "warn";
        text = res.message ?? `${to.code} is not a pick face.`;
      }
    } else if (row.container_id) {
      const res = await putaway.mutateAsync({ containerId: row.container_id, locationId: to.id, moveId: row.id });
      next = res.next?.move_id ?? null;
      if (res.followed_suggestion === false) {
        tone = "warn";
        text = `${res.container.code} is in ${to.code}${rowShown.code ? `, not the suggested ${rowShown.code}` : ""}: recorded as not followed.`;
      }
      if (res.warning === "over_capacity") {
        tone = "warn";
        text = res.message ?? `${to.code} is over capacity.`;
      }
    } else {
      if (!row.sku_id || !row.from_location_id || !row.qty) throw new Error("That loose putaway is missing its SKU, quantity or source.");
      await putawayLoose.mutateAsync({
        skuId: row.sku_id,
        qty: row.qty,
        fromLocationId: row.from_location_id,
        toLocationId: to.id,
        bucket: (row.bucket as WhBucket | null) ?? null,
        moveId: row.id,
      });
      if (rowShown.location_id && !suggestedHere) {
        tone = "warn";
        text = `Put in ${to.code}, not the suggested ${rowShown.code}: recorded as not followed.`;
      }
    }

    show(tone, tone === "warn" && !opts.open ? `${label} · not suggested` : label);
    setDone((n) => n + 1);
    setDoneIds((prev) => new Set(prev).add(row.id));
    setSelectedId(null);
    setWanted(null);
    setOpenFor(null);
    const fallbackNext = queue.find((r) => r.id !== row.id)?.id ?? null;
    setNextId(next && queue.some((r) => r.id === next) ? next : fallbackNext);
    setNotice(text ? { moveId: null, tone: "warn", text } : null);
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

  function onScan(raw: string) {
    if (busyRef.current) return;
    if (stationCode(raw)) {
      startStationFrom(raw);
      return;
    }
    const carton = cartonCode(raw);
    if (carton) {
      void run(() => selectByCarton(carton));
      return;
    }
    const row = selected;
    if (!row) {
      fail("Scan the carton's label first, then the location.", "Scan a carton first", null);
      return;
    }
    void run(async () => {
      const r = await resolveWhScan(raw);
      if (r.kind === "station") {
        startStationFrom(raw);
        return;
      }
      if (r.kind === "container" && r.code) {
        await selectByCarton(r.code.toUpperCase());
        return;
      }
      if (r.kind !== "location" || !r.id || !r.match) {
        fail(r.message ?? `${raw} is not a location label.`, "Not a location");
        return;
      }
      const code = r.code ?? r.match.code ?? raw;
      if (r.match.kind === "virtual") {
        fail(`${code} is not a shelf: nothing can be put away there. Nothing changed.`, `${code} can't hold stock`);
        return;
      }
      if (r.match.active === false) {
        fail(`${code} is inactive. Nothing changed.`, `${code} is inactive`);
        return;
      }
      if (row.container?.location_id && row.container.location_id === r.id) {
        fail(`${row.container.code} is already in ${code}.`, "Already there");
        return;
      }
      await place(row, { id: r.id, code }, { open: openMode });
    });
  }

  function suggestAnother(row: WhMoveRow) {
    if (!row.container_id) return;
    const current = shownFor(row, overrides[row.id]?.suggestion);
    const exclude = [...(overrides[row.id]?.exclude ?? []), ...(current.location_id ? [current.location_id] : [])];
    suggest.mutate(
      { containerId: row.container_id, exclude },
      {
        onSuccess: (res) => {
          setOverrides((prev) => ({ ...prev, [row.id]: { suggestion: res.suggestion, exclude } }));
          setOpenFor(null);
          setNotice(
            res.suggestion.reason === "none"
              ? { moveId: row.id, tone: "info", text: "No other location to suggest: scan any storable location." }
              : null,
          );
        },
        onError: (err) => setNotice({ moveId: row.id, tone: "fail", text: errorText(err, "Couldn't suggest a location") }),
      },
    );
  }

  function openToFace(row: WhMoveRow) {
    if (!shown?.location_id || !shown.code) return;
    if (confirmByScan) {
      setOpenFor(row.id);
      setNotice({ moveId: row.id, tone: "info", text: `Take it to ${shown.code} and scan the location: the carton opens there.` });
      return;
    }
    const to = { id: shown.location_id, code: shown.code };
    void run(() => place(row, to, { open: true }));
  }

  function reprintLabel(row: WhMoveRow) {
    if (!row.container_id || !row.container) return;
    const kind: WhLabelKind = row.container.label_stock === "green" ? "lpn_rts" : "lpn";
    const containerId = row.container_id;
    requestLabels(
      { kind, ids: [containerId], from: "phone" },
      {
        onSuccess: (res) => setReprint({ moveId: row.id, kind, containerId, res }),
        onError: (err) => setNotice({ moveId: row.id, tone: "fail", text: errorText(err, "Couldn't queue the label") }),
      },
    );
  }

  const progress = selected ? `${done + 1} of ${done + queue.length}` : queue.length ? `${queue.length} open` : "All done";
  const rowNotice = notice && (notice.moveId === null || notice.moveId === selected?.id) ? notice : null;
  const rowReprint = reprint && selected && reprint.moveId === selected.id ? reprint : null;

  return (
    <div className="mx-auto max-w-lg space-y-3 md:space-y-4">
      <FloorFlash flash={flash} />
      <TaskHeader title="Put away" progress={progress} right={<ScanSink onScan={onScan} />} />

      {error && <NoticeBox tone="fail" text={errorText(error, "Couldn't load the putaway queue")} />}

      {selected && shown ? (
        <>
          <CartonCard row={selected} contents={contents} />

          <Card className={cn(openMode && "border-blue-500/50")}>
            <CardContent className="space-y-1.5 p-4 text-center">
              <p className="text-[11px] uppercase tracking-widest text-muted-foreground">{openMode ? "Open it at" : "Put it in"}</p>
              {shown.code ? (
                <LocationCode
                  code={shown.code}
                  size="hero"
                  words={bayWords(shown.code) ? true : (shown.name ?? null)}
                  overflow={shown.overflow}
                  className="w-full"
                />
              ) : (
                <p className="py-2 text-2xl font-bold text-muted-foreground">Any storable location</p>
              )}
              <div className="flex justify-center pt-1">
                <span className="rounded-full border border-border px-2.5 py-0.5 text-xs text-muted-foreground">
                  {shown.reason ? REASON_WORDS[shown.reason] : "No suggestion"}
                </span>
              </div>
            </CardContent>
          </Card>

          <div className="space-y-1.5">
            <Step state="ok">
              Carton <CartonName row={selected} /> {selectedBy === "scan" ? "scanned" : "selected"}
            </Step>
            <Step state="now" n={2}>
              {confirmByScan || !shown.location_id ? (
                <>
                  Scan {shown.code ? <span className="font-mono tabular-nums">{shown.code}</span> : "any storable location"} to{" "}
                  {openMode ? "open it there" : "confirm"}
                </>
              ) : (
                <>Tap Put here, or scan another location</>
              )}
            </Step>
          </div>

          {rowNotice && <NoticeBox tone={rowNotice.tone} text={rowNotice.text} />}

          {rowReprint && (
            <ReprintStatus
              res={rowReprint.res}
              onBrowser={() =>
                setBrowserJob({
                  id: rowReprint.res.job_id,
                  payload: rowReprint.res.payload ?? null,
                  kind: rowReprint.kind,
                  itemIds: [rowReprint.containerId],
                  cancelOnClose: true,
                })
              }
              onPrintFromBrowser={setBrowserJob}
            />
          )}

          {nextRow && (
            <p className="truncate text-xs text-muted-foreground">
              Next: <CartonName row={nextRow} /> · {whatLine(nextRow)}
              {nextRow.suggested?.code ? ` · ${nextRow.suggested.code}` : ""}
            </p>
          )}

          <TaskActions>
            {!confirmByScan && shown.location_id && shown.code && (
              <Button
                className="h-14 w-full text-lg font-semibold touch-manipulation"
                disabled={busy}
                onClick={() => {
                  const to = { id: shown.location_id as string, code: shown.code as string };
                  void run(() => place(selected, to, { open: openMode }));
                }}
              >
                {busy ? <Loader2 className="mr-2 h-5 w-5 animate-spin" /> : <Check className="mr-2 h-5 w-5" />}
                {openMode ? `Open at ${shown.code}` : `Put here · ${shown.code}`}
              </Button>
            )}
            {selected.container_id && (
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  className="h-[52px] flex-1 touch-manipulation"
                  disabled={busy || suggest.isPending}
                  onClick={() => suggestAnother(selected)}
                >
                  {suggest.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
                  Suggest another
                </Button>
                {openMode ? (
                  <Button variant="outline" className="h-[52px] flex-1 touch-manipulation" onClick={() => setOpenFor(null)}>
                    Put away instead
                  </Button>
                ) : (
                  shown.reason === "same_sku_face" &&
                  shown.location_id && (
                    <Button
                      variant="outline"
                      className="h-[52px] flex-1 touch-manipulation"
                      disabled={busy}
                      onClick={() => openToFace(selected)}
                    >
                      <PackageOpen className="mr-2 h-4 w-4" /> Open to pick face
                    </Button>
                  )
                )}
              </div>
            )}
            <div className="flex gap-2">
              {selected.container_id && (
                <Button
                  variant="outline"
                  className="h-[52px] flex-1 touch-manipulation"
                  disabled={requesting}
                  onClick={() => reprintLabel(selected)}
                >
                  {requesting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Printer className="mr-2 h-4 w-4" />}
                  Reprint label
                </Button>
              )}
              <Button variant="ghost" className="h-[52px] flex-1 touch-manipulation" onClick={backToList}>
                <Undo2 className="mr-2 h-4 w-4" /> Back to list
              </Button>
            </div>
          </TaskActions>
        </>
      ) : (
        <Waiting
          queue={queue}
          me={user?.id ?? null}
          nextRow={nextRow}
          loading={isLoading}
          wanted={wanted}
          notice={rowNotice}
          onPick={(row) => select(row, "tap")}
        />
      )}

      {browserJob && (
        <Suspense fallback={null}>
          <LabelSheet
            open
            onOpenChange={(o) => {
              if (!o) setBrowserJob(null);
            }}
            kind={browserJob.kind}
            ids={browserJob.itemIds}
            from="phone"
            existingJob={browserJob}
          />
        </Suspense>
      )}
    </div>
  );
}

function Step({ state, n, children }: { state: "ok" | "now"; n?: number; children: ReactNode }) {
  return (
    <div
      className={cn(
        "flex min-h-[52px] items-center gap-2.5 rounded-lg border px-3 py-2 text-sm",
        state === "ok" ? "border-green-500/45" : "border-primary bg-primary/10",
      )}
    >
      <span
        className={cn(
          "flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold",
          state === "ok" ? "bg-green-500 text-green-950" : "bg-primary text-primary-foreground",
        )}
      >
        {state === "ok" ? <Check className="h-4 w-4" /> : n}
      </span>
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  );
}

function NoticeBox({ tone, text }: { tone: "info" | "warn" | "fail"; text: string }) {
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

function CartonCard({ row, contents }: { row: WhMoveRow; contents: { sku: { sku: string } | null; on_hand: number }[] }) {
  const c = row.container;
  const mixed = c && !c.sku_id;
  return (
    <Card>
      <CardContent className="space-y-1 p-3.5">
        <div className="flex flex-wrap items-center gap-2">
          <CartonName row={row} className="text-lg font-bold" />
          {c && (
            <span className="rounded-full border border-cyan-500/35 bg-cyan-500/10 px-2 py-0.5 text-[11px] font-semibold text-cyan-400">
              {c.state}
            </span>
          )}
          {c?.label_stock === "green" && (
            <span className="rounded-full border border-green-500/35 bg-green-500/10 px-2 py-0.5 text-[11px] font-semibold text-green-400">
              RTS
            </span>
          )}
          {!c && (
            <span className="rounded-full border border-border px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">loose</span>
          )}
        </div>
        <p className="text-[15px]">
          <span className="font-semibold">{whatLine(row)}</span> · {unitsOf(row)} units
        </p>
        {mixed && contents.length > 0 && (
          <p className="text-xs text-muted-foreground">
            {contents.map((x) => `${x.sku?.sku ?? "?"} × ${x.on_hand}`).join(" + ")}
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          at {c?.location?.code ?? row.from?.code ?? "?"} · {row.origin === "rts" ? "relabelled at RTS" : row.origin === "receipt" ? "checked in" : row.origin}
        </p>
      </CardContent>
    </Card>
  );
}

function ReprintStatus({
  res,
  onBrowser,
  onPrintFromBrowser,
}: {
  res: WhPrintJobResult;
  onBrowser: () => void;
  onPrintFromBrowser: (job: BrowserPrintJob) => void;
}) {
  if (res.target === "printer") {
    return <PrintJobStatus jobId={res.job_id} from="phone" size="touch" onPrintFromBrowser={onPrintFromBrowser} />;
  }
  if (res.target === "browser") {
    return (
      <div className="space-y-2 rounded-md border border-border px-3 py-2 text-sm">
        <p className="text-muted-foreground">{res.message ?? "No station printer: this label prints from a browser."}</p>
        <Button variant="outline" className="h-[52px] w-full touch-manipulation" onClick={onBrowser}>
          <Printer className="mr-2 h-4 w-4" /> Print from this device
        </Button>
      </div>
    );
  }
  return <NoticeBox tone="warn" text={res.message ?? "Printing is blocked on this environment."} />;
}

function Waiting({
  queue,
  me,
  nextRow,
  loading,
  wanted,
  notice,
  onPick,
}: {
  queue: WhMoveRow[];
  me: string | null;
  nextRow: WhMoveRow | null;
  loading: boolean;
  wanted: string | null;
  notice: { tone: "info" | "warn" | "fail"; text: string } | null;
  onPick: (row: WhMoveRow) => void;
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

  const first = nextRow ?? queue[0] ?? null;
  const others = queue.filter((r) => r.id !== first?.id);

  return (
    <div className="space-y-3">
      {notice && <NoticeBox tone={notice.tone} text={notice.text} />}
      {wanted && !queue.some((r) => r.container?.code.toUpperCase() === wanted) && (
        <NoticeBox tone="info" text={`${wanted} is not waiting for putaway.`} />
      )}

      {queue.length === 0 ? (
        <Card>
          <CardContent className="space-y-1 py-10 text-center">
            <p className="text-base font-semibold">Nothing to put away</p>
            <p className="text-sm text-muted-foreground">
              Cartons appear here when they are checked in at the dock or relabelled at RTS.
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">Scan a carton&apos;s label, or tap it, to start.</p>
          {first && (
            <div className="relative w-full rounded-lg border border-primary bg-primary/10 p-3.5 text-left transition-all touch-manipulation active:scale-[0.99]">
              <p className="text-[11px] uppercase tracking-widest text-primary">Next up</p>
              <div className="mt-1 flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-lg font-bold">
                    <CartonName row={first} raised />
                  </p>
                  <p className="truncate text-sm text-muted-foreground">
                    {whatLine(first)} · {unitsOf(first)} units
                  </p>
                </div>
                {first.suggested?.code ? (
                  <LocationCode code={first.suggested.code} size="small" className="text-lg" />
                ) : (
                  <span className="text-xs text-muted-foreground">any</span>
                )}
                <button type="button" onClick={() => onPick(first)} aria-label={`Put away ${cartonOf(first)}`} className={PICK_BUTTON}>
                  <ChevronRight className="h-5 w-5" />
                </button>
              </div>
            </div>
          )}
          <QueueList rows={others} me={me} onPick={onPick} />
        </>
      )}
    </div>
  );
}

function QueueList({ rows, me, onPick }: { rows: WhMoveRow[]; me: string | null; onPick: (row: WhMoveRow) => void }) {
  if (rows.length === 0) return null;
  return (
    <div className="space-y-1.5">
      {rows.map((row, i) => {
        const rank = putawayRank(row, me);
        const header = i === 0 || putawayRank(rows[i - 1], me) !== rank ? GROUP_WORDS[rank] : null;
        return (
          <div key={row.id}>
            {header && <p className="px-1 pb-1 pt-2 text-[11px] uppercase tracking-widest text-muted-foreground">{header}</p>}
            <div className="relative flex min-h-[56px] w-full items-center gap-3 rounded-lg border border-border px-3 py-2 text-left transition-all touch-manipulation hover:bg-muted/40 active:scale-[0.99]">
              <span
                className={cn(
                  "h-2.5 w-2.5 shrink-0 rounded-full",
                  row.container?.label_stock === "green" ? "bg-green-400" : row.container ? "bg-slate-200" : "bg-muted-foreground/50",
                )}
                aria-label={row.container?.label_stock === "green" ? "green RTS label" : row.container ? "white label" : "loose units"}
              />
              <span className="min-w-0 flex-1">
                <span className="block text-[15px] font-semibold">
                  <CartonName row={row} raised />
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {whatLine(row)} · {unitsOf(row)} units
                </span>
              </span>
              {row.suggested?.code && <LocationCode code={row.suggested.code} size="small" />}
              <button type="button" onClick={() => onPick(row)} aria-label={`Put away ${cartonOf(row)}`} className={PICK_BUTTON}>
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
