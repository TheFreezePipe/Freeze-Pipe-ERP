import { useMemo, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, ArrowRightLeft, Check, Factory, Loader2, Minus, PackageOpen, Plus, RefreshCw, Undo2, Warehouse } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { TaskActions, TaskHeader } from "@/components/layout/TaskShell";
import { LocationCode } from "@/components/warehouse/LocationCode";
import { ScanSink } from "@/components/warehouse/ScanSink";
import {
  resolveWhScan,
  useWarehouseSettings,
  useWhLocations,
  useWhStartStation,
  useWhSuggestPutaway,
  type WhBucket,
  type WhLocationSummary,
  type WhResolvedScan,
  type WhSuggestion,
} from "@/lib/hooks";
import {
  isAlreadyAtLine,
  useWhLooseBalances,
  useWhMoveStock,
  useWhOpenContainer,
  useWhPutawayContainerMove,
  useWhTakeToLine,
  type WhLooseBalance,
} from "@/lib/hooks/use-warehouse-mfg";
import { confirmByScan as confirmByScanSetting } from "@/lib/warehouse/rts-cartons";
import { bayWords, cartonCode, stationCode } from "@/lib/warehouse/scan";
import { cn } from "@/lib/utils";
import { FloorFlash } from "./FloorFlash";
import { useFloorFlash } from "./use-floor-flash";

/**
 * Floor Move (design §5.7, §9.1 /go/move), one route driven by state:
 *   1. Scan a carton (its LPN) or a product (loose units). For a product, pick
 *      the place the loose units are, by tapping a row or scanning that bin,
 *      and set how many on the stepper.
 *   2. Choose: Take to line (rpc_wh_take_to_line for a carton, or the units to
 *      MFG-LINE through rpc_wh_move_stock), Move to a bay, Park on WIP rack,
 *      or Open to pick face (a carton only, rpc_wh_open_container).
 *   3. For a bay, the WIP rack or a face: scan the location. A whole carton
 *      goes with rpc_wh_putaway_container (closing its open putaway task),
 *      loose units with rpc_wh_move_stock in their source bucket. Green when
 *      it lands where suggested, amber when it lands elsewhere or with a
 *      warning, red when nothing changed. With scan_rules.confirm_putaway_location
 *      off, tapping a suggested location confirms it without the scan.
 * A station label (%ST-…) starts a station session at any point. Every write
 * sends a fresh client_event_id.
 */

type Action = "line" | "bay" | "wip" | "face";

interface CartonSubject {
  kind: "carton";
  id: string;
  code: string;
  sku_id: string | null;
  sku: string | null;
  product_name: string | null;
  qty: number;
  state: string;
  label_stock: string;
  location_id: string | null;
  location_code: string | null;
}

interface LooseSubject {
  kind: "loose";
  sku_id: string;
  sku: string;
  product_name: string | null;
  source: { location_id: string; location_code: string; bucket: WhBucket; on_hand: number } | null;
  qty: number;
}

type Subject = CartonSubject | LooseSubject;

interface Target {
  id: string;
  code: string;
  zone?: string | null;
}

interface Option {
  id: string;
  code: string;
  note: string;
  name?: string | null;
}

const ACTION_WORDS: Record<Action, string> = {
  line: "Take to line",
  bay: "Move to a bay",
  wip: "Park on WIP rack",
  face: "Open to pick face",
};

const REASON_WORDS: Record<string, string> = {
  same_sku_reserve: "Same SKU in reserve",
  same_sku_face: "This SKU's pick face",
  nearest_empty: "Nearest empty bay",
  other_zone_empty: "Empty bay in another zone",
  breakdown_shelf: "Break-down shelf (mixed carton)",
  none: "No suggestion: any storable bay",
};

function errorText(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

function holdsSku(loc: WhLocationSummary, skuId: string | null): boolean {
  return !!skuId && loc.contents.some((c) => c.sku_id === skuId);
}

function subjectLine(s: Subject): string {
  if (s.kind === "carton") return `${s.sku ?? "MIXED"}${s.product_name ? ` · ${s.product_name}` : ""} · ${s.qty} units`;
  return `${s.sku}${s.product_name ? ` · ${s.product_name}` : ""} loose`;
}

export default function GoMove() {
  const { data: settings } = useWarehouseSettings();
  const confirmByScan = confirmByScanSetting(settings);
  const { data: locations = [] } = useWhLocations();
  const takeToLine = useWhTakeToLine();
  const moveStock = useWhMoveStock();
  const putaway = useWhPutawayContainerMove();
  const openContainer = useWhOpenContainer();
  const suggest = useWhSuggestPutaway();
  const { mutate: startStation } = useWhStartStation();
  const { flash, show } = useFloorFlash();

  const [subject, setSubject] = useState<Subject | null>(null);
  const [action, setAction] = useState<Action | null>(null);
  const [suggestion, setSuggestion] = useState<{ value: WhSuggestion; exclude: string[] } | null>(null);
  const [notice, setNotice] = useState<{ tone: "info" | "warn" | "fail"; text: string } | null>(null);
  const [last, setLast] = useState<string | null>(null);
  const [done, setDone] = useState(0);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  const looseSku = subject?.kind === "loose" ? subject.sku_id : null;
  const { data: looseRows = [], isLoading: looseLoading } = useWhLooseBalances(looseSku);

  const mfgLine = useMemo(() => locations.find((l) => l.code === "MFG-LINE") ?? null, [locations]);
  const skuId = subject ? subject.sku_id : null;
  const here = subject?.kind === "carton" ? subject.location_id : subject?.source?.location_id ?? null;
  const ready = !!subject && (subject.kind === "carton" || (!!subject.source && subject.qty > 0));

  /** Where the chosen action points: the server's suggestion, the WIP bays, or the SKU's faces. */
  const options = useMemo((): Option[] => {
    if (!subject || !action || action === "line") return [];
    const storable = (l: WhLocationSummary) => l.active !== false && l.kind !== "virtual" && l.kind !== "station" && l.id !== here;
    if (action === "wip") {
      return locations
        .filter((l) => storable(l) && l.zone === "WIP" && l.id && l.code)
        .sort((a, b) => (a.cartons ?? 0) - (b.cartons ?? 0) || (a.pick_sequence ?? 1e9) - (b.pick_sequence ?? 1e9))
        .slice(0, 6)
        .map((l) => ({
          id: l.id as string,
          code: l.code as string,
          name: l.name,
          note: `${l.cartons ?? 0}${l.capacity_cartons ? ` of ${l.capacity_cartons}` : ""} cartons`,
        }));
    }
    if (action === "face" || (action === "bay" && subject.kind === "loose")) {
      return locations
        .filter((l) => storable(l) && l.pickable && holdsSku(l, skuId) && l.id && l.code)
        .sort((a, b) => (a.pick_sequence ?? 1e9) - (b.pick_sequence ?? 1e9))
        .slice(0, 4)
        .map((l) => ({ id: l.id as string, code: l.code as string, name: l.name, note: "This SKU's pick face" }));
    }
    const s = suggestion?.value;
    return s?.location_id && s.code ? [{ id: s.location_id, code: s.code, note: REASON_WORDS[s.reason] ?? s.reason }] : [];
  }, [subject, action, locations, here, skuId, suggestion]);

  function reset(nextNotice: { tone: "info" | "warn" | "fail"; text: string } | null = null) {
    setSubject(null);
    setAction(null);
    setSuggestion(null);
    setNotice(nextNotice);
  }

  function fail(text: string, label: string) {
    show("fail", label);
    setNotice({ tone: "fail", text });
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

  async function run(work: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await work();
    } catch (err) {
      fail(errorText(err, "That didn't work"), "Nothing moved");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  function landed(tone: "ok" | "warn", label: string, text: string | null) {
    show(tone, label);
    setDone((n) => n + 1);
    setLast(label);
    reset(text ? { tone: "warn", text } : null);
  }

  // ---- step 1: what is moving ------------------------------------------------------

  async function pickSubject(raw: string) {
    const code = cartonCode(raw);
    const r = await resolveWhScan(code ? `%${code}` : raw);
    if (r.kind === "station") {
      startStationFrom(raw);
      return;
    }
    if (!applySubject(r)) {
      if (r.kind === "location") {
        fail("Scan the carton or the product first, then the location.", "Scan a carton first");
        return;
      }
      fail(r.message ?? `${raw} is not a carton or a product this warehouse knows.`, "Not recognised");
    }
  }

  /** A resolved carton or product becomes what is moving; false for anything else. */
  function applySubject(r: WhResolvedScan): boolean {
    if (r.kind === "container" && r.id && r.match) {
      const m = r.match as unknown as Omit<CartonSubject, "kind">;
      if (m.state === "void" || m.state === "empty") {
        fail(`${r.code ?? m.code} is ${m.state}; there is nothing to move.`, `${r.code ?? m.code} is ${m.state}`);
        return true;
      }
      setSubject({ ...m, kind: "carton", id: r.id, code: r.code ?? m.code });
      setAction(null);
      setSuggestion(null);
      if (r.superseded) {
        show("warn", `Use ${r.code}`);
        setNotice({ tone: "warn", text: r.message ?? `${r.scanned_code} was relabelled as ${r.code}.` });
      } else {
        show("ok", r.code ?? m.code);
        setNotice(null);
      }
      return true;
    }
    if ((r.kind === "gtin" || r.kind === "sku") && r.match) {
      const m = r.match as unknown as { sku_id: string; sku: string; product_name: string | null };
      setSubject({ kind: "loose", sku_id: m.sku_id, sku: m.sku, product_name: m.product_name, source: null, qty: 0 });
      setAction(null);
      setSuggestion(null);
      setNotice({ tone: "info", text: `Where are the loose ${m.sku}? Tap the place, or scan its label.` });
      show("ok", m.sku);
      return true;
    }
    return false;
  }

  function chooseSource(row: WhLooseBalance) {
    if (!subject || subject.kind !== "loose" || !row.location) return;
    setSubject({
      ...subject,
      source: { location_id: row.location_id, location_code: row.location.code, bucket: row.bucket, on_hand: row.on_hand },
      qty: row.on_hand,
    });
    setNotice(null);
  }

  // ---- step 2: the action -------------------------------------------------------------

  function choose(next: Action) {
    if (!subject) return;
    setNotice(null);
    if (next === "line") {
      void run(takeSubjectToLine);
      return;
    }
    setAction(next);
    setSuggestion(null);
    if (next === "bay" && subject.kind === "carton") askSuggestion(subject.id, []);
  }

  function askSuggestion(containerId: string, exclude: string[]) {
    suggest.mutate(
      { containerId, exclude },
      {
        onSuccess: (res) => setSuggestion({ value: res.suggestion, exclude }),
        onError: (err) => setNotice({ tone: "fail", text: errorText(err, "Couldn't suggest a bay") }),
      },
    );
  }

  async function takeSubjectToLine() {
    if (!subject) return;
    if (subject.kind === "carton") {
      try {
        const res = await takeToLine.mutateAsync({ containerId: subject.id });
        landed("ok", `${subject.code} to the line`, null);
        setLast(`${subject.code} · ${res.units} units from ${res.from?.code ?? "?"} to MFG-LINE`);
      } catch (err) {
        if (isAlreadyAtLine(err)) {
          landed("warn", `${subject.code} already at the line`, errorText(err, `${subject.code} is already at the line.`));
          return;
        }
        throw err;
      }
      return;
    }
    if (!subject.source) return;
    if (!mfgLine?.id) throw new Error("The MFG-LINE location is missing; ask an admin to restore it.");
    await moveStock.mutateAsync({
      skuId: subject.sku_id,
      qty: subject.qty,
      fromLocationId: subject.source.location_id,
      toLocationId: mfgLine.id,
      bucket: subject.source.bucket,
    });
    landed("ok", `${subject.qty} ${subject.sku} to the line`, null);
  }

  // ---- step 3: the destination ----------------------------------------------------------

  async function place(to: Target, act: Exclude<Action, "line">) {
    if (!subject) return;
    const suggested = act === action && options.some((o) => o.id === to.id);
    const asked = act === "bay" && action === "bay" && subject.kind === "carton" ? (suggestion?.value.location_id ?? null) : null;
    let tone: "ok" | "warn" = "ok";
    let text: string | null = null;
    const what = subject.kind === "carton" ? subject.code : `${subject.qty} ${subject.sku}`;

    if (act === "face" && subject.kind === "carton") {
      const res = await openContainer.mutateAsync({ containerId: subject.id, toLocationId: to.id });
      if (res.warning) {
        tone = "warn";
        text = res.message ?? `${to.code} is not a pick face.`;
      }
      landed(tone, `Opened at ${to.code}`, text);
      return;
    }

    if (subject.kind === "carton") {
      const res = await putaway.mutateAsync({ containerId: subject.id, locationId: to.id });
      if (res.warning === "over_capacity") {
        tone = "warn";
        text = res.message ?? `${to.code} is over capacity.`;
      }
    } else {
      if (!subject.source) return;
      await moveStock.mutateAsync({
        skuId: subject.sku_id,
        qty: subject.qty,
        fromLocationId: subject.source.location_id,
        toLocationId: to.id,
        bucket: subject.source.bucket,
      });
    }

    if (!text && act === "wip" && to.zone && to.zone !== "WIP") {
      tone = "warn";
      text = `${what} is in ${to.code}, which is not on the WIP rack.`;
    } else if (!text && asked && asked !== to.id) {
      tone = "warn";
      text = `${what} is in ${to.code}, not the suggested ${suggestion?.value.code}: recorded as not followed.`;
    } else if (!text && act === "bay" && action === "bay" && subject.kind === "loose" && options.length > 0 && !suggested) {
      tone = "warn";
      text = `${what} is in ${to.code}, not this SKU's pick face.`;
    }
    landed(tone, tone === "warn" ? `In ${to.code} · check` : `In ${to.code}`, text);
  }

  async function placeAtScan(raw: string, act: Exclude<Action, "line">) {
    const r = await resolveWhScan(raw);
    if (r.kind === "station") {
      startStationFrom(raw);
      return;
    }
    if (r.kind !== "location" && applySubject(r)) return;
    if (r.kind !== "location" || !r.id || !r.match) {
      fail(r.message ?? `${raw} is not a location label.`, "Not a location");
      return;
    }
    const code = r.code ?? r.match.code ?? raw;
    if (r.match.kind === "virtual") {
      fail(`${code} is not a shelf: nothing can be put there. Nothing moved.`, `${code} can't hold stock`);
      return;
    }
    if (r.match.active === false) {
      fail(`${code} is inactive. Nothing moved.`, `${code} is inactive`);
      return;
    }
    if (r.id === here) {
      fail(`${subject?.kind === "carton" ? subject.code : "The units"} ${subject?.kind === "carton" ? "is" : "are"} already in ${code}.`, "Already there");
      return;
    }
    const zone = locations.find((l) => l.id === r.id)?.zone ?? null;
    await place({ id: r.id, code, zone }, act);
  }

  async function sourceAtScan(raw: string) {
    if (!subject || subject.kind !== "loose") return;
    const r = await resolveWhScan(raw);
    if (r.kind === "station") {
      startStationFrom(raw);
      return;
    }
    if (r.kind !== "location" || !r.id) {
      fail(r.message ?? `Scan the label of the place the loose ${subject.sku} are.`, "Not a location");
      return;
    }
    const rows = looseRows.filter((b) => b.location_id === r.id);
    if (rows.length === 0) {
      fail(`${r.code} holds no loose ${subject.sku}.`, `No ${subject.sku} there`);
      return;
    }
    if (rows.length > 1) {
      setNotice({ tone: "info", text: `${r.code} holds ${subject.sku} in ${rows.length} buckets: tap the one you are moving.` });
      return;
    }
    chooseSource(rows[0]);
    show("ok", r.code ?? "Found");
  }

  function onScan(raw: string) {
    if (busyRef.current) return;
    if (stationCode(raw)) {
      startStationFrom(raw);
      return;
    }
    // A carton label always starts over with that carton.
    if (cartonCode(raw) || !subject) {
      void run(() => pickSubject(raw));
      return;
    }
    if (subject.kind === "loose" && !subject.source) {
      void run(() => sourceAtScan(raw));
      return;
    }
    // A location scanned before an action is chosen is "Move to a bay" there.
    const act: Exclude<Action, "line"> = action && action !== "line" ? action : "bay";
    void run(() => placeAtScan(raw, act));
  }

  // ---- render ---------------------------------------------------------------------------------

  const stepNow = !subject ? 1 : subject.kind === "loose" && !subject.source ? 1 : !action ? 2 : 3;
  const progress = done > 0 ? `${done} moved` : undefined;

  return (
    <div className="mx-auto max-w-lg space-y-3 md:space-y-4">
      <FloorFlash flash={flash} />
      <TaskHeader title="Move" progress={progress} right={<ScanSink onScan={onScan} />} />

      {!subject ? (
        <Card>
          <CardContent className="space-y-2 py-8 text-center">
            <ArrowRightLeft className="mx-auto h-8 w-8 text-muted-foreground" />
            <p className="text-base font-semibold">Scan a carton, or a product for loose units</p>
            <p className="text-sm text-muted-foreground">
              Then take it to the line, move it to a bay, park it on the WIP rack or open it at a pick face.
            </p>
            {last && <p className="pt-2 text-xs text-muted-foreground">Last: {last}</p>}
          </CardContent>
        </Card>
      ) : (
        <SubjectCard subject={subject} />
      )}

      {notice && <NoticeBox tone={notice.tone} text={notice.text} />}

      {subject?.kind === "loose" && !subject.source && (
        <LooseSources rows={looseRows} loading={looseLoading} sku={subject.sku} onPick={chooseSource} />
      )}

      {subject?.kind === "loose" && subject.source && !action && (
        <LooseQty subject={subject} onQty={(qty) => setSubject({ ...subject, qty })} />
      )}

      {subject && action && action !== "line" && (
        <Card className="border-primary/50">
          <CardContent className="space-y-3 p-4">
            <p className="text-center text-[11px] uppercase tracking-widest text-muted-foreground">{ACTION_WORDS[action]}</p>
            {options.length > 0 ? (
              <div className="space-y-1.5">
                {options.map((o) => (
                  <OptionRow
                    key={o.id}
                    option={o}
                    tappable={!confirmByScan}
                    busy={busy}
                    onTap={() => {
                      const zone = locations.find((l) => l.id === o.id)?.zone ?? null;
                      void run(() => place({ id: o.id, code: o.code, zone }, action));
                    }}
                  />
                ))}
              </div>
            ) : action === "bay" && subject.kind === "carton" && suggest.isPending ? (
              <p className="flex items-center justify-center gap-2 py-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Finding a bay…
              </p>
            ) : (
              <p className="py-2 text-center text-sm text-muted-foreground">
                {action === "face" ? "No pick face holds this SKU yet: scan the face to open it at." : "No suggestion: scan any storable location."}
              </p>
            )}
            <Step n={3}>
              {confirmByScan || options.length === 0 ? (
                <>Scan the {action === "face" ? "pick face" : action === "wip" ? "WIP bay" : "bay"} label to confirm</>
              ) : (
                <>Tap a location above, or scan another</>
              )}
            </Step>
          </CardContent>
        </Card>
      )}

      {subject && (
        <TaskActions>
          {ready && !action && (
            <div className="grid grid-cols-2 gap-2">
              {(subject.kind === "carton" ? subject.location_code !== "MFG-LINE" : subject.source?.location_code !== "MFG-LINE") && (
                <ActionButton icon={<Factory className="h-5 w-5" />} label="Take to line" busy={busy} onClick={() => choose("line")} />
              )}
              <ActionButton icon={<Warehouse className="h-5 w-5" />} label="Move to a bay" busy={busy} onClick={() => choose("bay")} />
              <ActionButton icon={<ArrowRightLeft className="h-5 w-5" />} label="Park on WIP rack" busy={busy} onClick={() => choose("wip")} />
              {subject.kind === "carton" && (
                <ActionButton icon={<PackageOpen className="h-5 w-5" />} label="Open to pick face" busy={busy} onClick={() => choose("face")} />
              )}
            </div>
          )}
          <div className="flex gap-2">
            {action === "bay" && subject.kind === "carton" && (
              <Button
                variant="outline"
                className="h-[52px] flex-1 touch-manipulation"
                disabled={busy || suggest.isPending}
                onClick={() => {
                  const cur = suggestion?.value.location_id;
                  askSuggestion(subject.id, [...(suggestion?.exclude ?? []), ...(cur ? [cur] : [])]);
                }}
              >
                {suggest.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
                Suggest another
              </Button>
            )}
            {action && (
              <Button
                variant="outline"
                className="h-[52px] flex-1 touch-manipulation"
                disabled={busy}
                onClick={() => {
                  setAction(null);
                  setSuggestion(null);
                  setNotice(null);
                }}
              >
                Other action
              </Button>
            )}
            <Button variant="ghost" className="h-[52px] flex-1 touch-manipulation" disabled={busy} onClick={() => reset()}>
              <Undo2 className="mr-2 h-4 w-4" /> Start over
            </Button>
          </div>
          {stepNow === 2 && ready && <p className="text-center text-xs text-muted-foreground">Choose what happens to it.</p>}
        </TaskActions>
      )}
    </div>
  );
}

function LooseQty({ subject, onQty }: { subject: LooseSubject; onQty: (qty: number) => void }) {
  const max = subject.source?.on_hand ?? 0;
  return (
    <Card>
      <CardContent className="space-y-2 p-4">
        <p className="text-center text-xs uppercase tracking-widest text-muted-foreground">How many</p>
        <div className="flex items-center justify-center gap-4">
          <Button
            variant="outline"
            size="icon"
            className="h-14 w-14 rounded-full touch-manipulation"
            disabled={subject.qty <= 1}
            onClick={() => onQty(Math.max(1, subject.qty - 1))}
            aria-label="One fewer"
          >
            <Minus className="h-6 w-6" />
          </Button>
          <div className="min-w-[80px] text-center">
            <p className="text-4xl font-bold tabular-nums">{subject.qty}</p>
            <p className="text-xs text-muted-foreground">
              of {max} {subject.source?.bucket ?? ""}
            </p>
          </div>
          <Button
            variant="outline"
            size="icon"
            className="h-14 w-14 rounded-full touch-manipulation"
            disabled={subject.qty >= max}
            onClick={() => onQty(Math.min(max, subject.qty + 1))}
            aria-label="One more"
          >
            <Plus className="h-6 w-6" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function SubjectCard({ subject }: { subject: Subject }) {
  const at = subject.kind === "carton" ? subject.location_code : subject.source?.location_code ?? null;
  return (
    <Card>
      <CardContent className="space-y-1 p-3.5">
        <div className="flex flex-wrap items-center gap-2">
          {subject.kind === "carton" ? (
            <>
              <span
                className={cn(
                  "h-3 w-3 shrink-0 rounded-sm",
                  subject.label_stock === "green" ? "bg-green-400" : "border border-slate-400 bg-slate-200",
                )}
                aria-label={subject.label_stock === "green" ? "green RTS label" : "white label"}
              />
              <span className="font-mono text-lg font-bold tabular-nums">{subject.code}</span>
              <span className="rounded-full border border-cyan-500/35 bg-cyan-500/10 px-2 py-0.5 text-[11px] font-semibold text-cyan-400">
                {subject.state}
              </span>
            </>
          ) : (
            <>
              <span className="font-mono text-lg font-bold">{subject.sku}</span>
              <span className="rounded-full border border-border px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">loose</span>
            </>
          )}
        </div>
        <p className="text-[15px]">{subjectLine(subject)}</p>
        {at && (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            at <LocationCode code={at} size="small" className="text-xs" />
            {bayWords(at) ? <span>· {bayWords(at)}</span> : null}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function LooseSources({
  rows,
  loading,
  sku,
  onPick,
}: {
  rows: WhLooseBalance[];
  loading: boolean;
  sku: string;
  onPick: (row: WhLooseBalance) => void;
}) {
  if (loading) {
    return (
      <div className="space-y-2">
        {[0, 1].map((i) => (
          <div key={i} className="h-14 animate-pulse rounded-lg border border-border/60 bg-muted/30" />
        ))}
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <Card>
        <CardContent className="py-6 text-center text-sm text-muted-foreground">
          No loose {sku} anywhere: scan the carton instead.
        </CardContent>
      </Card>
    );
  }
  return (
    <div className="space-y-1.5">
      {rows.map((row) => (
        <button
          key={row.id}
          type="button"
          onClick={() => onPick(row)}
          className="flex min-h-[56px] w-full items-center gap-3 rounded-lg border border-border px-3 py-2 text-left transition-all touch-manipulation hover:bg-muted/40 active:scale-[0.99]"
        >
          <LocationCode code={row.location?.code} size="small" className="text-lg" />
          <span className="min-w-0 flex-1 text-sm text-muted-foreground">
            {row.on_hand} loose · {row.bucket}
          </span>
        </button>
      ))}
    </div>
  );
}

function OptionRow({ option, tappable, busy, onTap }: { option: Option; tappable: boolean; busy: boolean; onTap: () => void }) {
  const body = (
    <>
      <LocationCode code={option.code} size="large" words={bayWords(option.code) ? true : (option.name ?? null)} className="flex-1" />
      <span className="rounded-full border border-border px-2.5 py-0.5 text-xs text-muted-foreground">{option.note}</span>
    </>
  );
  if (!tappable) {
    return <div className="flex min-h-[56px] items-center gap-3 rounded-lg border border-border px-3 py-2">{body}</div>;
  }
  return (
    <button
      type="button"
      disabled={busy}
      onClick={onTap}
      className="flex min-h-[56px] w-full items-center gap-3 rounded-lg border border-primary bg-primary/10 px-3 py-2 text-left transition-all touch-manipulation active:scale-[0.99] disabled:opacity-60"
    >
      {body}
      <Check className="h-5 w-5 shrink-0 text-primary" />
    </button>
  );
}

function ActionButton({ icon, label, busy, onClick }: { icon: ReactNode; label: string; busy: boolean; onClick: () => void }) {
  return (
    <Button variant="outline" className="h-14 justify-start gap-2 text-[15px] font-semibold touch-manipulation" disabled={busy} onClick={onClick}>
      {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : icon}
      {label}
    </Button>
  );
}

function Step({ n, children }: { n: number; children: ReactNode }) {
  return (
    <div className="flex min-h-[52px] items-center gap-2.5 rounded-lg border border-primary bg-primary/10 px-3 py-2 text-sm">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">
        {n}
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
