import { lazy, Suspense, useImperativeHandle, useRef, useState, type ReactNode, type Ref } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, ArrowRight, Check, Loader2, Minus, PackageOpen, Plus, Printer, Tag, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { LocationCode } from "@/components/warehouse/LocationCode";
import { PrintJobStatus } from "@/components/warehouse/PrintJobStatus";
import { ScanSink } from "@/components/warehouse/ScanSink";
import {
  newClientEventId,
  resolveWhScan,
  useWarehouseSettings,
  useWhPrintJob,
  useWhStartStation,
  useWhStation,
} from "@/lib/hooks";
import {
  relabelShortfall,
  useWhCartonsWhere,
  useWhRtsRelabel,
  type WhRtsRelabelResult,
} from "@/lib/hooks/use-warehouse-mfg";
import {
  addCarton,
  canAddCarton,
  checkRtsPlan,
  clearLoose,
  looseRemainder,
  mergeCarton,
  newRtsPlan,
  reduceRtsPlan,
  rtsCartonsPayload,
  rtsRules,
  setCartonQty,
  toggleCartonState,
  type RtsPlan,
} from "@/lib/warehouse/rts-cartons";
import { cartonCode, stationCode } from "@/lib/warehouse/scan";
import { cn } from "@/lib/utils";
import { FloorFlash } from "@/pages/floor/FloorFlash";
import { useFloorFlash } from "@/pages/floor/use-floor-flash";
import type { StepScanTarget } from "./TakeToLineStep";

const LabelSheet = lazy(() => import("@/components/warehouse/LabelSheet"));

interface RtsProduct {
  id: string;
  sku: string;
  standard_quantity_per_carton: number | null;
}

interface RtsCartonStepProps {
  ref?: Ref<StepScanTarget>;
  product: RtsProduct | null;
  /** The logged quantity: the plan starts as one carton holding all of it. */
  quantity: number;
  /** SKU, task type and quantity are set (the Workspace's own guard on Log Task). */
  canSubmit: boolean;
  /** Write the RTS task log the Workspace's usual way; resolves with its id, throws the message to show. */
  onLog: () => Promise<string | null>;
  /** The task is finished: reset the Workspace (overlay: the usual "Task Logged!" with an optional note). */
  onComplete: (opts: { overlay: boolean; note?: string }) => void;
  /** The Workspace's notes field, shown above the button. */
  children?: ReactNode;
}

interface Parent {
  id: string;
  code: string;
  sku: string | null;
  qty: number;
  location_code: string | null;
}

type Phase = "plan" | "logging" | "relabelling" | "result" | "failed";

interface ScannedCarton {
  id: string;
  code: string;
  sku_id: string | null;
  sku: string | null;
  qty: number;
  state: string;
  label_stock: string;
  location_code: string | null;
}

function errorText(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

const LOOSE_NOTE = "No carton labels: the finished units wait loose at the line.";

/**
 * The RTS relabel (design §5.7 step 5) for RTS and pre-filled RTS tasks,
 * shown after the quantity and before the submit, once the physical layer is
 * live. The task is not complete until it is done:
 *   (a) scan the carton's old label (the parent LPN) or "No label";
 *   (b) carton rows, starting with one sealed carton holding the whole batch;
 *       "Add another carton" splits it, "Remainder loose to pick face" sends
 *       the rest loose, and the rows must sum to the logged quantity;
 *   (c) "Log task and print labels": the task log is written first (the
 *       mirror credits the finished units at MFG-LINE), then
 *       rpc_wh_rts_relabel boxes them. insufficient_at_line shows the gap with
 *       Try again and Reduce; dormant says labels start at go-live and
 *       completes the task as before;
 *   (d) the green cartons with their codes, units and suggested bays, the
 *       print job (station printer, or this browser through LabelSheet) and a
 *       place status per carton;
 *   (e) "Place it" opens /go/putaway?lpn=<code>; "Done" carries on.
 * With rts.require_relabel on and a station session open, at least one carton
 * is required; with no station session (a backfill on a desktop) the labels
 * may be skipped and the units stay loose at the line.
 */
export function RtsCartonStep({ ref, product, quantity, canSubmit, onLog, onComplete, children }: RtsCartonStepProps) {
  const { data: settings } = useWarehouseSettings();
  const rules = rtsRules(settings);
  const { data: session } = useWhStation();
  const relabel = useWhRtsRelabel();
  const { mutate: startStation } = useWhStartStation();
  const { flash, show } = useFloorFlash();

  // The plan follows the quantity until the task is logged (the Workspace locks it then).
  const [stored, setStored] = useState<{ forQty: number; plan: RtsPlan } | null>(null);
  const plan = stored && stored.forQty === quantity ? stored.plan : newRtsPlan(quantity);
  const [parent, setParent] = useState<Parent | "none" | null>(null);
  const [skip, setSkip] = useState(false);
  const [phase, setPhase] = useState<Phase>("plan");
  const [run, setRun] = useState<{ logId: string | null; eventId: string } | null>(null);
  const [result, setResult] = useState<WhRtsRelabelResult | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const busyRef = useRef(false);

  const requireCarton = rules.requireRelabel && !!session;
  const canSkip = !requireCarton;
  const skipping = skip && canSkip;
  const check = checkRtsPlan(plan, { requireCarton });
  const parentDecided = parent !== null;
  const ready = canSubmit && !!product && (skipping || (parentDecided && check.ok));
  const planning = phase === "plan";

  function edit(next: RtsPlan) {
    setStored({ forQty: quantity, plan: next });
  }

  function fail(text: string, label: string) {
    show("fail", label);
    setNotice(text);
  }

  function startStationFrom(raw: string) {
    startStation(
      { scan: raw },
      {
        onSuccess: (s) => show("ok", s.session.name ?? s.session.code),
        onError: (err) => fail(errorText(err, "Couldn't start the station"), "Station not started"),
      },
    );
  }

  async function scanParent(raw: string) {
    const code = cartonCode(raw);
    const r = await resolveWhScan(code ? `%${code}` : raw);
    if (r.kind === "station") {
      startStationFrom(raw);
      return;
    }
    if (r.kind !== "container" || !r.id || !r.match) {
      fail(r.message ?? `${code ?? raw} is not a carton label. Scan the carton's old C- label, or tap No label.`, "Not a carton");
      return;
    }
    if (r.superseded) {
      fail(r.message ?? `${r.scanned_code ?? code} was already relabelled.`, "Already relabelled");
      return;
    }
    const c = { ...(r.match as unknown as ScannedCarton), id: r.id, code: r.code ?? (r.match as unknown as ScannedCarton).code };
    if (c.state === "void") {
      fail(`${c.code} was voided; scan its current label.`, `${c.code} is void`);
      return;
    }
    if (product && c.sku_id && c.sku_id !== product.id) {
      fail(`${c.code} held ${c.sku ?? "another SKU"}, not ${product.sku}.`, "Wrong SKU");
      return;
    }
    setParent({ id: c.id, code: c.code, sku: c.sku, qty: c.qty, location_code: c.location_code });
    setNotice(null);
    show("ok", `From ${c.code}`);
  }

  function scan(raw: string) {
    if (busyRef.current) return;
    if (stationCode(raw)) {
      startStationFrom(raw);
      return;
    }
    if (!planning) return;
    busyRef.current = true;
    scanParent(raw)
      .catch((err: unknown) => fail(errorText(err, "Couldn't read that label"), "Not read"))
      .finally(() => {
        busyRef.current = false;
      });
  }

  useImperativeHandle(ref, () => ({ scan }));

  async function relabelNow(logId: string | null, eventId: string, p: RtsPlan) {
    if (!product) return;
    setPhase("relabelling");
    setError(null);
    try {
      const res = await relabel.mutateAsync({
        skuId: product.id,
        cartons: rtsCartonsPayload(p),
        parentContainerId: parent && parent !== "none" ? parent.id : null,
        taskLogId: logId,
        clientEventId: eventId,
      });
      if (res.dormant) {
        onComplete({ overlay: true, note: "Carton labels start when the physical layer goes live." });
        return;
      }
      setResult(res);
      setPhase("result");
      const n = res.containers.length;
      show("ok", n > 0 ? `${n} green label${n === 1 ? "" : "s"}` : "Remainder sent loose");
    } catch (err) {
      setError(err);
      setPhase("failed");
      show("fail", relabelShortfall(err) ? "Not enough at the line" : "Labels not made");
    }
  }

  async function submit() {
    if (!ready || !planning) return;
    setPhase("logging");
    setError(null);
    setNotice(null);
    let logId: string | null;
    try {
      logId = await onLog();
    } catch (err) {
      setError(err);
      setPhase("plan");
      return;
    }
    if (skipping) {
      onComplete({ overlay: true, note: LOOSE_NOTE });
      return;
    }
    // One idempotency key per logged batch: a retry after a lost response replays the first relabel.
    const eventId = newClientEventId();
    setRun({ logId, eventId });
    await relabelNow(logId, eventId, plan);
  }

  function retry() {
    if (run) void relabelNow(run.logId, run.eventId, plan);
  }

  function reduceTo(available: number) {
    if (!run) return;
    const next = reduceRtsPlan(plan, available);
    edit(next);
    void relabelNow(run.logId, run.eventId, next);
  }

  if (phase === "result" && result) {
    return (
      <>
        <FloorFlash flash={flash} />
        <RtsResult result={result} onDone={() => onComplete({ overlay: false })} />
      </>
    );
  }

  const shortfall = relabelShortfall(error);

  return (
    <Card className="border-green-500/40">
      <FloorFlash flash={flash} />
      <CardHeader className="pb-3">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1 space-y-1">
            <CardTitle className="flex items-center gap-2 text-base">
              <Tag className="h-4 w-4 text-green-400" /> Green carton labels
            </CardTitle>
            <CardDescription>
              {session
                ? `Labels print at ${session.station?.name ?? session.station?.code ?? "your station"}.`
                : "No station: labels print from this browser. Scan your desk's station label to use its printer."}
            </CardDescription>
          </div>
          <ScanSink onScan={scan} disabled={!planning && phase !== "failed"} />
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {canSkip && planning && (
          <label className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2 text-sm">
            <span>
              Log without carton labels
              <span className="block text-xs text-muted-foreground">The units wait loose at the line for a putaway.</span>
            </span>
            <Switch checked={skip} onCheckedChange={setSkip} aria-label="Log without carton labels" />
          </label>
        )}

        {!skipping && (
          <>
            {/* (a) the parent carton */}
            <section className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">1 · The carton&apos;s old label</p>
              {parent === null ? (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm text-muted-foreground">Scan the white label the batch came from</span>
                  {rules.allowNoParent && (
                    <Button type="button" variant="outline" className="h-10 rounded-full px-3 touch-manipulation" onClick={() => setParent("none")}>
                      No label
                    </Button>
                  )}
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <span className="inline-flex min-h-[40px] items-center gap-2 rounded-lg border border-green-500/40 px-3 py-1.5 text-sm">
                    <Check className="h-4 w-4 text-green-400" />
                    {parent === "none" ? (
                      "No label: the cartons get new C-MFG codes"
                    ) : (
                      <span>
                        From <span className="font-mono font-semibold tabular-nums">{parent.code}</span>
                        <span className="text-muted-foreground">
                          {" "}
                          · {parent.sku ?? "MIXED"} · {parent.qty} left · {parent.location_code ?? "?"}
                        </span>
                      </span>
                    )}
                  </span>
                  {planning && (
                    <Button type="button" variant="ghost" size="icon" className="h-9 w-9" aria-label="Change the old label" onClick={() => setParent(null)}>
                      <X className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              )}
              {notice && <Notice tone="fail" text={notice} />}
            </section>

            {/* (b) the cartons */}
            <section className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">2 · Cartons</p>
              {plan.cartons.map((c, i) => (
                <div key={c.key} className="flex min-h-[52px] items-center gap-2 rounded-lg border border-border px-2 py-1.5">
                  <span className="w-16 shrink-0 pl-1 text-sm font-semibold">Carton {i + 1}</span>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="h-10 w-10 shrink-0 rounded-full touch-manipulation"
                    aria-label={`Carton ${i + 1}: one fewer`}
                    disabled={!planning || c.qty <= 0}
                    onClick={() => edit(setCartonQty(plan, c.key, c.qty - 1))}
                  >
                    <Minus className="h-4 w-4" />
                  </Button>
                  <span className="min-w-[3ch] text-center text-xl font-bold tabular-nums">{c.qty}</span>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="h-10 w-10 shrink-0 rounded-full touch-manipulation"
                    aria-label={`Carton ${i + 1}: one more`}
                    disabled={!planning}
                    onClick={() => edit(setCartonQty(plan, c.key, c.qty + 1))}
                  >
                    <Plus className="h-4 w-4" />
                  </Button>
                  <button
                    type="button"
                    disabled={!planning}
                    onClick={() => edit(toggleCartonState(plan, c.key))}
                    className={cn(
                      "ml-auto h-9 rounded-full border px-3 text-xs font-semibold touch-manipulation",
                      c.state === "sealed" ? "border-border text-muted-foreground" : "border-amber-500/50 text-amber-300",
                    )}
                    aria-label={`Carton ${i + 1} is ${c.state}; tap to change`}
                  >
                    {c.state === "sealed" ? "Sealed" : "Open (partial)"}
                  </button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-9 w-9 shrink-0"
                    aria-label={`Remove carton ${i + 1}`}
                    disabled={!planning}
                    onClick={() => edit(mergeCarton(plan, c.key))}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              ))}
              {plan.loose > 0 && (
                <div className="flex min-h-[48px] items-center gap-2 rounded-lg border border-dashed border-border px-3 py-1.5 text-sm">
                  <PackageOpen className="h-4 w-4 text-muted-foreground" />
                  <span className="flex-1">
                    <span className="font-semibold tabular-nums">{plan.loose}</span> loose to the pick face
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-9 w-9"
                    aria-label="Take the loose remainder back"
                    disabled={!planning}
                    onClick={() => edit(clearLoose(plan))}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              )}
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  className="h-11 touch-manipulation"
                  disabled={!planning || !canAddCarton(plan)}
                  onClick={() => edit(addCarton(plan, product?.standard_quantity_per_carton))}
                >
                  <Plus className="mr-1.5 h-4 w-4" /> Add another carton
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="h-11 touch-manipulation"
                  disabled={!planning || check.unassigned <= 0}
                  onClick={() => edit(looseRemainder(plan))}
                >
                  <PackageOpen className="mr-1.5 h-4 w-4" />
                  Remainder loose to pick face{check.unassigned > 0 ? ` (${check.unassigned})` : ""}
                </Button>
              </div>
              {check.ok ? (
                <p className="flex items-center gap-1.5 text-xs text-green-400">
                  <Check className="h-3.5 w-3.5" />
                  {plan.cartons.length} carton{plan.cartons.length === 1 ? "" : "s"}
                  {plan.loose > 0 ? ` + ${plan.loose} loose` : ""} = {plan.total} units
                </p>
              ) : (
                plan.total > 0 && <Notice tone="warn" text={check.problems.join(" ")} />
              )}
            </section>
          </>
        )}

        {children}

        {phase === "failed" && shortfall ? (
          <div className="space-y-2 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-300" role="alert">
            <p className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                The task is logged, but the line holds {shortfall.available} loose finished {product?.sku ?? ""} and the cartons need{" "}
                {shortfall.needed}: {shortfall.short} short.
              </span>
            </p>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" className="h-11 touch-manipulation" onClick={retry}>
                Try again
              </Button>
              {shortfall.available > 0 && (
                <Button type="button" variant="outline" className="h-11 touch-manipulation" onClick={() => reduceTo(shortfall.available)}>
                  Reduce to {shortfall.available}
                </Button>
              )}
              <Button type="button" variant="ghost" className="h-11 touch-manipulation" onClick={() => onComplete({ overlay: true, note: LOOSE_NOTE })}>
                Finish without labels
              </Button>
            </div>
          </div>
        ) : phase === "failed" ? (
          <div className="space-y-2 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-300" role="alert">
            <p className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>The task is logged, but the labels were not made: {errorText(error, "unknown error")}</span>
            </p>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" className="h-11 touch-manipulation" onClick={retry}>
                Try again
              </Button>
              <Button type="button" variant="ghost" className="h-11 touch-manipulation" onClick={() => onComplete({ overlay: true, note: LOOSE_NOTE })}>
                Finish without labels
              </Button>
            </div>
          </div>
        ) : (
          error != null && <Notice tone="fail" text={errorText(error, "Failed to log task")} />
        )}

        {(planning || phase === "logging" || phase === "relabelling") && (
          <Button
            type="button"
            className="h-14 w-full text-lg font-semibold touch-manipulation"
            disabled={!ready || !planning}
            onClick={() => void submit()}
          >
            {phase === "logging" ? (
              <>
                <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Saving…
              </>
            ) : phase === "relabelling" ? (
              <>
                <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Making labels…
              </>
            ) : skipping ? (
              "Log Task"
            ) : (
              <>
                <Printer className="mr-2 h-5 w-5" /> Log task and print labels
              </>
            )}
          </Button>
        )}
        {planning && !skipping && canSubmit && !parentDecided && (
          <p className="text-center text-xs text-muted-foreground">
            Scan the carton&apos;s old label{rules.allowNoParent ? " or tap No label" : ""} first.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function Notice({ tone, text }: { tone: "warn" | "fail"; text: string }) {
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-md border px-3 py-2 text-sm",
        tone === "fail" ? "border-red-500/40 bg-red-500/10 text-red-300" : "border-amber-500/40 bg-amber-500/10 text-amber-300",
      )}
      role="alert"
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{text}</span>
    </div>
  );
}

/** (d) and (e): the green cartons, their print job and where each one is now. */
function RtsResult({ result, onDone }: { result: WhRtsRelabelResult; onDone: () => void }) {
  const ids = result.containers.map((c) => c.id);
  const { data: where = [] } = useWhCartonsWhere(ids);
  const { data: job } = useWhPrintJob(result.printJobId);
  const [sheet, setSheet] = useState<"job" | "new" | null>(null);
  const printed = job?.status === "printed";
  const target = result.print?.target ?? null;
  const n = result.containers.length;
  const rem = result.remainder;

  return (
    <Card className="border-green-500/50">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Check className="h-5 w-5 text-green-400" />
          {n > 0 ? `${n} green carton${n === 1 ? "" : "s"}` : "Task logged"}
        </CardTitle>
        <CardDescription>
          {n > 0 ? "Put each one in a bay: scan the bay label on Put away." : "No carton was labelled."}
          {result.duplicate ? " (already recorded)" : ""}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {result.printJobId && target === "printer" && (
          <PrintJobStatus jobId={result.printJobId} from="workspace" size="touch" />
        )}
        {result.printJobId && target === "browser" && (
          <div className="space-y-2 rounded-md border border-border px-3 py-2 text-sm">
            <p className="text-muted-foreground">
              {result.print?.message ?? "No station printer: these labels print from this browser."}
            </p>
            <Button
              type="button"
              variant="outline"
              className="h-[52px] w-full touch-manipulation"
              disabled={!job}
              onClick={() => setSheet(job && job.status === "queued" ? "job" : "new")}
            >
              <Printer className="mr-2 h-4 w-4" />
              {job && job.status === "queued" ? `Print ${n} label${n === 1 ? "" : "s"} here` : "Print again"}
            </Button>
          </div>
        )}
        {target === "none" && <Notice tone="warn" text={result.print?.message ?? "Printing is blocked on this environment."} />}

        {result.containers.map((c) => {
          const now = where.find((w) => w.id === c.id);
          const at = now?.location?.code ?? null;
          const placed = !!at && at !== "MFG-LINE";
          return (
            <div key={c.id} className="space-y-2 rounded-lg border border-green-500/40 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="h-3 w-3 shrink-0 rounded-sm bg-green-400" aria-label="green label" />
                <span className="font-mono text-lg font-bold tabular-nums">{c.code}</span>
                <span className="text-sm text-muted-foreground">
                  {c.qty} units{c.state === "open" ? " · open" : ""}
                </span>
                <span
                  className={cn(
                    "ml-auto rounded-full border px-2.5 py-0.5 text-xs font-semibold",
                    placed ? "border-green-500/40 text-green-400" : "border-amber-500/40 text-amber-300",
                  )}
                >
                  {placed ? `Placed in ${at}` : `${printed ? "Printed" : "Label queued"}, not placed`}
                </span>
              </div>
              {!placed && (
                <div className="flex items-center gap-3">
                  <span className="text-xs text-muted-foreground">Bay</span>
                  {c.suggested?.code ? (
                    <LocationCode code={c.suggested.code} size="small" className="text-lg" />
                  ) : (
                    <span className="text-sm text-muted-foreground">any storable bay</span>
                  )}
                  <Button asChild variant="outline" className="ml-auto h-11 touch-manipulation">
                    <Link to={`/go/putaway?lpn=${encodeURIComponent(c.code)}`}>
                      Place it <ArrowRight className="ml-1.5 h-4 w-4" />
                    </Link>
                  </Button>
                </div>
              )}
            </div>
          );
        })}

        {rem && (
          <p className="text-sm text-muted-foreground">
            {rem.qty} loose{" "}
            {rem.left_at_line
              ? `left at the line for a putaway${rem.suggested?.code ? ` to ${rem.suggested.code}` : ""}.`
              : `moved to ${rem.to?.code ?? "the pick face"}${rem.container ? ` (${rem.container.code})` : ""}.`}
          </p>
        )}
        {result.parent && (
          <p className="text-xs text-muted-foreground">
            {result.parent.state === "void"
              ? `${result.parent.code} is voided; its white label no longer scans.`
              : `${result.parent.code} still holds units and stays open at the line.`}
          </p>
        )}

        <Button type="button" className="h-14 w-full text-lg font-semibold touch-manipulation" onClick={onDone}>
          Done · next task
        </Button>
      </CardContent>

      {sheet && (
        <Suspense fallback={null}>
          <LabelSheet
            open
            onOpenChange={(o) => {
              if (!o) setSheet(null);
            }}
            kind="lpn_rts"
            ids={ids}
            from="workspace"
            title={`${n} green label${n === 1 ? "" : "s"}`}
            existingJob={
              sheet === "job" && job
                ? { id: job.id, payload: job.payload, kind: "lpn_rts", itemIds: job.item_ids, cancelOnClose: true }
                : null
            }
          />
        </Suspense>
      )}
    </Card>
  );
}
