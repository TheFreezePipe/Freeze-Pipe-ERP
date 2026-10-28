import { lazy, Suspense, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { formatDistanceToNow, parseISO } from "date-fns";
import { AlertTriangle, Loader2, Plus, Power, Printer, Radio, ScanBarcode, ShieldAlert, ShieldCheck, ShieldOff } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import {
  AGENT_OFFLINE_MS,
  useBarcodeCoverage,
  useOutboundMode,
  useSetWarehouseSetting,
  useWarehouseSettings,
  useWhMarkPrinted,
  useWhOverview,
  useWhPrinterQueues,
  useWhPrinters,
  useWhRequestLabels,
  useWhStations,
  type WhLabelStock,
  type WhPrinterRow,
} from "@/lib/hooks";
import {
  EMPTY_PRINTER_FORM,
  printerFormFrom,
  printerFormProblems,
  printerPayload,
  readPhysicalLayer,
  useWhDeletePrinter,
  useWhSavePrinter,
  useWhSetPhysicalLayer,
  WhPrinterStaleError,
  type WhPrinterForm,
} from "@/lib/hooks/use-warehouse-counts";
import { useWhRequestBrowserLabels, useWhSampleContainer } from "@/lib/hooks/use-warehouse-labels";
import type { Json } from "@/lib/database.types";
import { APP_ENV } from "@/lib/env";
import { PrintJobStatus, type BrowserPrintJob } from "@/components/warehouse/PrintJobStatus";
import type { OutboundMode } from "@/lib/warehouse/outbound";
import { cn } from "@/lib/utils";
import LayoutImport from "@/components/warehouse/LayoutImport";
import LocationsTable from "@/components/warehouse/LocationsTable";
import { LayoutEditorSection } from "@/components/warehouse/editor/LayoutEditorSection";

const LabelSheet = lazy(() => import("@/components/warehouse/LabelSheet"));

// Same mapping the Phase 0 Warehouse overview used for its Outbound card.
const OUTBOUND_DISPLAY: Record<OutboundMode, { label: string; icon: typeof ShieldCheck; color: string }> = {
  live: { label: "Live", icon: ShieldCheck, color: "text-green-400" },
  practice: { label: "Practice", icon: ShieldAlert, color: "text-amber-400" },
  blocked: { label: "Blocked", icon: ShieldOff, color: "text-slate-400" },
};

const OUTBOUND_OPTIONS: { value: OutboundMode; hint: string }[] = [
  { value: "practice", hint: "browser prints only; nothing is sent to ShipStation or a printer service" },
  { value: "blocked", hint: "nothing prints and nothing is sent" },
  { value: "live", hint: "label printing and ShipStation writes" },
];

/** What the Warehouse tab still gains in Phase 1 (design doc, Settings section). */
const PHASE1_SETUP = ["Rack templates", "Cart definitions", "Tote classes", "Scan rules"];

const LABEL_STOCK: Record<string, string> = {
  white_4x2: "White 4×2",
  green_4x2: "Green 4×2",
  white_4x6: "White 4×6",
  green_4x6: "Green 4×6",
  white_3x1: "White 3×1",
};

function lastSeen(at: string | null): string {
  if (!at) return "never";
  return formatDistanceToNow(parseISO(at), { addSuffix: true });
}

function LayoutCount({ label, value }: { label: string; value: number | undefined }) {
  return (
    <div className="rounded-md border border-border/50 px-3 py-2">
      <p className="text-lg font-semibold tabular-nums">{value == null ? "—" : value.toLocaleString()}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}

function isOutboundMode(value: unknown): value is OutboundMode {
  return value === "live" || value === "practice" || value === "blocked";
}

/**
 * Settings › Warehouse (admin). Setup data for the Inventory module: the
 * outbound switch, barcode coverage, the physical-layer switch, the layout
 * import and the locations table, printers and stations.
 */
export default function WarehouseSettings() {
  const { toast } = useToast();
  const { data: settings, isLoading: settingsLoading } = useWarehouseSettings();
  const mode = useOutboundMode();
  const setSetting = useSetWarehouseSetting();
  const { data: coverage, isLoading: coverageLoading } = useBarcodeCoverage();
  const { data: overview } = useWhOverview();

  const effective = OUTBOUND_DISPLAY[mode];
  const EffectiveIcon = effective.icon;
  const rawServerMode = settings?.outbound?.mode;
  const serverMode = isOutboundMode(rawServerMode) ? rawServerMode : null;
  const coveragePct =
    coverage && coverage.active_total > 0 ? Math.round((coverage.with_code / coverage.active_total) * 100) : null;

  function changeMode(next: string) {
    if (!isOutboundMode(next) || next === serverMode) return;
    setSetting.mutate(
      { key: "outbound", value: { mode: next } },
      {
        onSuccess: () => toast({ title: `Outbound set to ${OUTBOUND_DISPLAY[next].label}` }),
        onError: (err) =>
          toast({
            title: "Couldn't change outbound",
            description: err instanceof Error ? err.message : "Unknown error",
            variant: "destructive",
          }),
      },
    );
  }

  return (
    <div className="grid max-w-4xl gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Outbound</CardTitle>
          <CardDescription>Whether the warehouse may print labels and write to ShipStation.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-3">
            <div className={cn("rounded-md bg-muted p-2", effective.color)}>
              <EffectiveIcon className="h-5 w-5" />
            </div>
            <div>
              <p className="text-lg font-semibold">{effective.label}</p>
              <p className="text-xs text-muted-foreground">
                In effect in this app
                {serverMode && serverMode !== mode ? ` · server setting: ${OUTBOUND_DISPLAY[serverMode].label}` : ""}
              </p>
            </div>
          </div>

          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">Server setting</p>
            <Select
              value={serverMode ?? ""}
              onValueChange={changeMode}
              disabled={settingsLoading || setSetting.isPending}
            >
              <SelectTrigger className="w-full sm:w-[220px]" aria-label="Outbound server setting">
                <SelectValue placeholder={settingsLoading ? "Loading…" : "Not set (blocked)"} />
              </SelectTrigger>
              <SelectContent>
                {OUTBOUND_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {OUTBOUND_DISPLAY[o.value].label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <ul className="space-y-0.5 text-xs text-muted-foreground">
              {OUTBOUND_OPTIONS.map((o) => (
                <li key={o.value}>
                  <span className="font-medium text-foreground/80">{OUTBOUND_DISPLAY[o.value].label}</span>: {o.hint}
                </li>
              ))}
            </ul>
          </div>

          <p className="text-xs text-muted-foreground">
            The Edge Functions check a second switch, the ERP_OUTBOUND_MODE secret, and act only when it allows
            the same mode. Staging never gets that secret, and off production this app treats Live as Blocked.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Barcodes</CardTitle>
          <CardDescription>Active SKUs a scan can find by barcode.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-3">
            <div className="rounded-md bg-muted p-2 text-primary">
              <ScanBarcode className="h-5 w-5" />
            </div>
            <div>
              <p className="text-lg font-semibold tabular-nums">
                {coverage ? `${coverage.with_code.toLocaleString()} of ${coverage.active_total.toLocaleString()}` : coverageLoading ? "Loading…" : "—"}
              </p>
              <p className="text-xs text-muted-foreground">
                {coveragePct != null ? `${coveragePct}% of active SKUs have a barcode` : "No coverage data"}
              </p>
            </div>
          </div>
          {coveragePct != null && <Progress value={coveragePct} aria-label="Barcode coverage" />}
          <p className="text-xs text-muted-foreground">
            A scan without a match falls back to SKU search. Link a code by scanning it on{" "}
            <Link to="/go/lookup" className="text-primary hover:underline">
              Look up
            </Link>
            .
          </p>
        </CardContent>
      </Card>

      <PhysicalLayerCard />

      <Card className="lg:col-span-2">
        <CardHeader className="space-y-1.5">
          <CardTitle className="text-base">Locations and layout</CardTitle>
          <CardDescription>Where stock physically sits. A location is always a bin or a site.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-3 gap-3 sm:max-w-md">
            <LayoutCount label="Racks" value={overview?.locations.racks} />
            <LayoutCount label="Rack locations" value={overview?.locations.rack_locations} />
            <LayoutCount label="Named locations" value={overview?.locations.named} />
          </div>

          <section className="space-y-2 border-t border-border/50 pt-4" aria-labelledby="wh-layout-import">
            <h3 id="wh-layout-import" className="text-sm font-medium">
              Import workbook
            </h3>
            <LayoutImport />
          </section>

          <LayoutEditorSection />

          <section className="space-y-2 border-t border-border/50 pt-4" aria-labelledby="wh-locations-table">
            <h3 id="wh-locations-table" className="text-sm font-medium">
              Locations
            </h3>
            <LocationsTable />
          </section>

          <p className="border-t border-border/50 pt-4 text-xs text-muted-foreground">
            Browse what each location holds on{" "}
            <Link to="/inventory/stock?view=location" className="text-primary hover:underline">
              Stock › By location
            </Link>
            . Still to come in Phase 1:
          </p>
          <ul className="grid gap-x-6 gap-y-1.5 text-sm text-muted-foreground sm:grid-cols-2">
            {PHASE1_SETUP.map((item) => (
              <li key={item} className="flex items-start gap-2">
                <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-muted-foreground/60" />
                {item}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <LabelsCard />

      <PrintersAndStations />
    </div>
  );
}

// ---- Physical layer ---------------------------------------------------------------

/**
 * physical_layer (§5.6, §11): enabled and mint_lpns as they stand, and the
 * moment the physical layer went live. "Set live now" stamps live_since; from
 * then the ledger mirror, ship settlement and the nightly reconcile and count
 * scheduler run. "Clear live" exists off production only, for practice resets.
 */
function PhysicalLayerCard() {
  const { toast } = useToast();
  const { data: settings, isLoading } = useWarehouseSettings();
  const setLive = useWhSetPhysicalLayer();
  const [confirm, setConfirm] = useState<"live" | "clear" | null>(null);
  const layer = readPhysicalLayer(settings?.physical_layer);
  const canClear = APP_ENV !== "prod";

  function apply(kind: "live" | "clear") {
    setLive.mutate(
      { liveSince: kind === "live" ? new Date().toISOString() : null },
      {
        onSuccess: () => {
          setConfirm(null);
          toast({ title: kind === "live" ? "Physical layer is live" : "Physical layer back to practice" });
        },
        onError: (err) =>
          toast({
            title: "Couldn't change the physical layer",
            description: err instanceof Error ? err.message : "Unknown error",
            variant: "destructive",
          }),
      },
    );
  }

  return (
    <Card className="lg:col-span-2">
      <CardHeader className="space-y-1.5">
        <CardTitle className="text-base">Physical layer</CardTitle>
        <CardDescription>
          Whether bins and cartons follow the books. Until it is live the ledger mirror, ship settlement and the nightly
          reconcile stay dormant, so practice on the floor never moves stock figures.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="flex items-center gap-3 rounded-md border border-border/50 px-3 py-2">
            <div className={cn("rounded-md bg-muted p-2", layer.live ? "text-green-400" : "text-muted-foreground")}>
              <Radio className="h-5 w-5" />
            </div>
            <div>
              <p className="text-lg font-semibold">{isLoading ? "…" : layer.live ? "Live" : "Not live"}</p>
              <p className="text-xs text-muted-foreground">
                {layer.live_since ? `since ${new Date(layer.live_since).toLocaleString()}` : "live_since is not set"}
              </p>
            </div>
          </div>
          <div className="rounded-md border border-border/50 px-3 py-2">
            <p className="text-lg font-semibold">{layer.mint_lpns ? "On" : "Off"}</p>
            <p className="text-xs text-muted-foreground">Carton labels (LPNs) minted at check-in</p>
          </div>
          <div className="rounded-md border border-border/50 px-3 py-2">
            <p className="text-lg font-semibold">{layer.enabled ? "On" : "Off"}</p>
            <p className="text-xs text-muted-foreground">physical_layer.enabled</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {!layer.live && (
            <Button size="sm" disabled={isLoading || setLive.isPending} onClick={() => setConfirm("live")}>
              <Power className="mr-1.5 h-4 w-4" /> Set live now
            </Button>
          )}
          {canClear && layer.live_since && (
            <Button size="sm" variant="outline" disabled={setLive.isPending} onClick={() => setConfirm("clear")}>
              Clear live
            </Button>
          )}
          <p className="text-xs text-muted-foreground">
            {canClear
              ? "Off production, Clear live returns the floor to practice; what the mirror already posted stays."
              : "Going live is one-way on production."}
          </p>
        </div>
      </CardContent>

      <AlertDialog open={confirm != null} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm === "clear" ? "Clear live?" : "Set the physical layer live now?"}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              {confirm === "clear" ? (
                <div className="space-y-2 text-sm text-muted-foreground">
                  <p>
                    The mirror, settlement and nightly jobs stop from now. Movements, settlements and counts they already
                    posted stay as they are; reload practice stock if you need a clean floor.
                  </p>
                </div>
              ) : (
                <div className="space-y-2 text-sm text-muted-foreground">
                  <p>From the moment you confirm:</p>
                  <ul className="list-disc space-y-1 pl-5">
                    <li>the ledger mirror gives every task log, stock count and freight delivery its physical twin in the bins;</li>
                    <li>ship settlement draws each shipped order&apos;s units from the pick faces;</li>
                    <li>the nightly reconcile (09:00 UTC) and count scheduler (09:10 UTC) run, and open counts where a SKU is off.</li>
                  </ul>
                  <p>Nothing before that moment is replayed. Set it once the opening stock is in the bins.</p>
                </div>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={setLive.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={setLive.isPending}
              onClick={(e) => {
                e.preventDefault();
                if (confirm) apply(confirm);
              }}
            >
              {setLive.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              {confirm === "clear" ? "Clear live" : "Set live now"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

// ---- Labels ----------------------------------------------------------------------

type CartonLabelSize = "4x2" | "4x6";

const CARTON_SIZE_OPTIONS: { value: CartonLabelSize; label: string; hint: string }[] = [
  {
    value: "4x2",
    label: "4 × 2, one label per carton",
    hint: "Today's label: one 4×2 label on each carton, on white and green 4×2 stock.",
  },
  {
    value: "4x6",
    label: "4 × 6 pair, two labels per carton",
    hint: "Two identical labels per carton for two adjacent faces at the aisle-side corner, on 4×6 white and green stock, with bars wide enough to scan from the aisle.",
  },
];

const LABEL_FORMAT_STOCK: Record<CartonLabelSize, string> = {
  "4x2": "Carton: white 4×2 · RTS: green 4×2 · Location and station: white 3×1",
  "4x6": "Carton: white 4×6 pair · RTS: green 4×6 pair · Location and station: white 3×1",
};

/** What wh_settings.labels holds for any key that was never saved. */
const DEFAULT_LABELS = { lpn: "4x2", location: "3x1", dpi: 203 };

function isCartonLabelSize(value: unknown): value is CartonLabelSize {
  return value === "4x2" || value === "4x6";
}

function readLabels(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

type SampleSheet = { via: "station" } | { via: "browser"; job: BrowserPrintJob };

/**
 * Labels (admin): the carton label size (wh_settings.labels.lpn, which the
 * server reads when it builds a job's payload), a read-only summary of the
 * format, and sample prints for the newest carton. The station sample goes
 * through LabelSheet as usual; the browser sample is queued with
 * p_target = 'browser' and handed to LabelSheet as an existing job, so it
 * prints here whatever the station session says.
 */
export function LabelsCard() {
  const { toast } = useToast();
  const { data: settings, isLoading: settingsLoading } = useWarehouseSettings();
  const setSetting = useSetWarehouseSetting();
  const sample = useWhSampleContainer();
  const requestBrowser = useWhRequestBrowserLabels();
  const [sheet, setSheet] = useState<SampleSheet | null>(null);

  const labels = readLabels(settings?.labels);
  const current: CartonLabelSize = isCartonLabelSize(labels.lpn) ? labels.lpn : "4x2";
  const sampleId = sample.data?.id ?? null;
  const sampleIds = useMemo(() => (sampleId ? [sampleId] : []), [sampleId]);
  const noSample = !sample.isLoading && !sampleId;
  const sampleBlocked = !sampleId || requestBrowser.isPending;

  function changeSize(next: CartonLabelSize) {
    if (next === current) return;
    const value = { ...DEFAULT_LABELS, ...labels, lpn: next } as unknown as Json;
    setSetting.mutate(
      { key: "labels", value },
      {
        onSuccess: () => toast({ title: `Carton labels set to ${next === "4x6" ? "4×6 pair" : "4×2"}` }),
        onError: (err) =>
          toast({
            title: "Couldn't change the label size",
            description: err instanceof Error ? err.message : "Unknown error",
            variant: "destructive",
          }),
      },
    );
  }

  function sampleFromBrowser() {
    if (!sampleId) return;
    requestBrowser.mutate(
      { kind: "lpn", ids: [sampleId], from: "desktop" },
      {
        onSuccess: (res) => {
          if (res.target === "none") {
            toast({ title: "Sample not printed", description: res.message ?? "Printing is blocked on this environment." });
            return;
          }
          setSheet({
            via: "browser",
            job: { id: res.job_id, payload: res.payload ?? null, kind: "lpn", itemIds: [sampleId], cancelOnClose: true },
          });
        },
        onError: (err) =>
          toast({
            title: "Couldn't queue the sample label",
            description: err instanceof Error ? err.message : "Unknown error",
            variant: "destructive",
          }),
      },
    );
  }

  return (
    <Card className="lg:col-span-2">
      <CardHeader className="space-y-1.5">
        <CardTitle className="text-base">Labels</CardTitle>
        <CardDescription>What prints on a carton label and which stock it needs.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground" id="wh-label-size-heading">
            Carton label size
          </p>
          <div role="radiogroup" aria-labelledby="wh-label-size-heading" className="grid gap-2 sm:grid-cols-2">
            {CARTON_SIZE_OPTIONS.map((o) => {
              const checked = current === o.value;
              const disabled = settingsLoading || setSetting.isPending;
              return (
                <label
                  key={o.value}
                  htmlFor={`wh-label-size-${o.value}`}
                  className={cn(
                    "flex items-start gap-3 rounded-md border px-3 py-2.5",
                    checked ? "border-primary bg-primary/5" : "border-border/60",
                    disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer",
                    !checked && !disabled && "hover:bg-muted/40",
                  )}
                >
                  <input
                    type="radio"
                    id={`wh-label-size-${o.value}`}
                    name="wh-carton-label-size"
                    value={o.value}
                    checked={checked}
                    disabled={disabled}
                    onChange={() => changeSize(o.value)}
                    aria-labelledby={`wh-label-size-${o.value}-title`}
                    aria-describedby={`wh-label-size-${o.value}-hint`}
                    className="mt-1 h-4 w-4 shrink-0 accent-primary"
                  />
                  <span className="space-y-0.5">
                    <span id={`wh-label-size-${o.value}-title`} className="block text-sm font-medium">
                      {o.label}
                    </span>
                    <span id={`wh-label-size-${o.value}-hint`} className="block text-xs text-muted-foreground">
                      {o.hint}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
        </div>

        <ul className="space-y-1 rounded-md border border-border/50 px-3 py-2 text-xs text-muted-foreground">
          <li>
            <span className="font-medium text-foreground/80">Stock</span>: {LABEL_FORMAT_STOCK[current]}
          </li>
          <li>
            <span className="font-medium text-foreground/80">Barcode</span>: Code 128, value % plus the code
          </li>
          <li>The layout and its format version come from the app&apos;s label renderer; there is no label editor.</li>
        </ul>

        <div className="space-y-2 border-t border-border/50 pt-4">
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" disabled={sampleBlocked} onClick={sampleFromBrowser}>
              {requestBrowser.isPending ? (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              ) : (
                <Printer className="mr-1.5 h-4 w-4" />
              )}
              Print sample from browser
            </Button>
            <Button size="sm" variant="outline" disabled={sampleBlocked} onClick={() => setSheet({ via: "station" })}>
              <Printer className="mr-1.5 h-4 w-4" /> Print sample on my station printer
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {noSample
              ? sample.isError
                ? "Couldn't look up a carton to sample."
                : "Check in a shipment with carton labels first."
              : sample.data
                ? `Samples use the newest carton, ${sample.data.code}; marking one printed counts as a print of that carton.`
                : "Looking for a carton to sample…"}
          </p>
        </div>
      </CardContent>

      {sheet && sampleIds.length > 0 && (
        <Suspense fallback={null}>
          <LabelSheet
            open
            onOpenChange={(o) => !o && setSheet(null)}
            kind="lpn"
            ids={sampleIds}
            from="desktop"
            title="Sample carton label"
            existingJob={sheet.via === "browser" ? sheet.job : null}
          />
        </Suspense>
      )}
    </Card>
  );
}

// ---- Printers and stations ------------------------------------------------------

const NO_STATION = "__none__";

/**
 * Printers with their agent's heartbeat and queue, a test print per printer
 * and station labels (rpc_wh_request_labels). Add and Edit save through
 * rpc_wh_save_printer (a stale row_version is caught and offered for
 * reload); Deactivate goes through rpc_wh_delete_printer, which refuses while
 * jobs wait.
 */
function PrintersAndStations() {
  const { toast } = useToast();
  const { data: stations = [] } = useWhStations();
  const { data: printers = [], isLoading, dataUpdatedAt } = useWhPrinters();
  const { data: queues = {} } = useWhPrinterQueues();
  const { mutate: requestLabels, isPending: testing } = useWhRequestLabels();
  const { mutate: markPrinted } = useWhMarkPrinted();
  const save = useWhSavePrinter();
  const remove = useWhDeletePrinter();
  const [form, setForm] = useState<WhPrinterForm | null>(null);
  const [stale, setStale] = useState<WhPrinterStaleError | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [testJob, setTestJob] = useState<{ printerId: string; jobId: string } | null>(null);
  const [stationLabels, setStationLabels] = useState(false);
  const [deactivating, setDeactivating] = useState<WhPrinterRow | null>(null);

  const problems = form ? printerFormProblems(form) : [];
  const editing = form?.id ? (printers.find((p) => p.id === form.id)?.code ?? form.code) : null;

  function openForm(next: WhPrinterForm) {
    setForm(next);
    setStale(null);
    setSaveError(null);
  }

  function testPrint(p: WhPrinterRow) {
    const stationId = p.station_location_id ?? stations[0]?.id;
    if (!stationId) {
      toast({ title: "No station to print", description: "A test prints a station label; add a station location first." });
      return;
    }
    requestLabels(
      { kind: "station", ids: [stationId], from: "desktop", printerId: p.id },
      {
        onSuccess: (res) => {
          if (res.target === "printer") {
            setTestJob({ printerId: p.id, jobId: res.job_id });
            return;
          }
          // Practice or blocked: the server sent it to the browser (or nowhere), not to the agent.
          if (res.target === "browser") markPrinted({ jobId: res.job_id, status: "cancelled" });
          toast({ title: `Test not sent to ${p.code}`, description: res.message ?? "The server did not route it to the agent." });
        },
        onError: (err) =>
          toast({
            title: "Couldn't queue the test label",
            description: err instanceof Error ? err.message : "Unknown error",
            variant: "destructive",
          }),
      },
    );
  }

  function submit() {
    if (!form || problems.length > 0) return;
    setSaveError(null);
    setStale(null);
    save.mutate(printerPayload(form), {
      onSuccess: (res) => {
        toast({ title: `${res.printer.code} ${res.created ? "added" : "saved"}` });
        setForm(null);
      },
      onError: (err) => {
        if (err instanceof WhPrinterStaleError) setStale(err);
        else setSaveError(err instanceof Error ? err.message : "Couldn't save the printer");
      },
    });
  }

  function deactivate(p: WhPrinterRow) {
    remove.mutate(p.id, {
      onSuccess: () => {
        toast({ title: `${p.code} deactivated` });
        setDeactivating(null);
      },
      onError: (err) => {
        setDeactivating(null);
        toast({ title: `Couldn't deactivate ${p.code}`, description: err instanceof Error ? err.message : "Unknown error", variant: "destructive" });
      },
    });
  }

  function reactivate(p: WhPrinterRow) {
    save.mutate(
      { id: p.id, active: true, row_version: p.row_version },
      {
        onSuccess: () => toast({ title: `${p.code} active again` }),
        onError: (err) =>
          toast({ title: `Couldn't reactivate ${p.code}`, description: err instanceof Error ? err.message : "Unknown error", variant: "destructive" }),
      },
    );
  }

  return (
    <Card className="lg:col-span-2">
      <CardHeader className="space-y-1.5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1.5">
            <CardTitle className="text-base">Printers and stations</CardTitle>
            <CardDescription>
              A label prints at the station a worker scanned into, on the printer whose label stock fits. A print agent on
              a PC (tools/print-agent) prints the jobs of the printers carrying its agent id.
            </CardDescription>
          </div>
          <Button size="sm" variant="outline" onClick={() => openForm({ ...EMPTY_PRINTER_FORM })}>
            <Plus className="mr-1.5 h-4 w-4" /> Add printer
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : printers.length === 0 ? (
          <div className="flex items-center gap-3 rounded-md border border-border/50 px-4 py-3 text-sm text-muted-foreground">
            <Printer className="h-4 w-4 shrink-0" />
            No printers registered yet. Labels print from the browser until one is added and its agent runs.
          </div>
        ) : (
          <div className="overflow-x-auto rounded-md border border-border/50">
            <table className="w-full min-w-[900px] text-sm">
              <thead className="border-b border-border/50 text-left text-xs uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-3 py-2.5 font-medium">Printer</th>
                  <th className="px-3 py-2.5 font-medium">Station</th>
                  <th className="px-3 py-2.5 font-medium">Labels</th>
                  <th className="px-3 py-2.5 font-medium">Address</th>
                  <th className="px-3 py-2.5 font-medium">Agent</th>
                  <th className="px-3 py-2.5 font-medium">Last seen</th>
                  <th className="px-3 py-2.5 font-medium">Queue</th>
                  <th className="px-3 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {printers.map((p) => {
                  const seen = p.last_seen_at ? Date.parse(p.last_seen_at) : null;
                  const online = seen != null && dataUpdatedAt - seen < AGENT_OFFLINE_MS;
                  const q = queues[p.id];
                  return (
                    <tr key={p.id} className={cn("border-b border-border/50 align-top last:border-0", !p.active && "opacity-60")}>
                      <td className="px-3 py-2">
                        <span className="font-medium">{p.code}</span>
                        <span className="text-muted-foreground"> · {p.name}</span>
                        {!p.active && (
                          <Badge variant="outline" className="ml-2 text-[10px] text-muted-foreground">
                            inactive
                          </Badge>
                        )}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">{p.station?.code ?? "shared"}</td>
                      <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                        {LABEL_STOCK[p.label_stock] ?? p.label_stock} · {p.dpi} dpi
                      </td>
                      <td className="max-w-[16rem] truncate px-3 py-2 font-mono text-xs text-muted-foreground" title={p.address ?? ""}>
                        {p.transport === "browser" ? "browser" : (p.address ?? "—")}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">{p.transport === "browser" ? "—" : (p.agent_id ?? "—")}</td>
                      <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                        <span
                          className={cn("mr-1.5 inline-block h-2 w-2 rounded-full", online ? "bg-green-400" : "bg-muted-foreground/40")}
                          aria-label={online ? "agent online" : "agent offline"}
                        />
                        {lastSeen(p.last_seen_at)}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 tabular-nums text-muted-foreground">
                        {q ? (
                          <>
                            {q.queued} queued{q.claimed > 0 ? ` · ${q.claimed} printing` : ""}
                            {q.failed > 0 && <span className="text-destructive"> · {q.failed} failed</span>}
                          </>
                        ) : (
                          "0 queued"
                        )}
                      </td>
                      <td className="whitespace-nowrap px-3 py-1.5 text-right">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-8 px-2"
                          disabled={testing || !p.active || p.transport !== "agent"}
                          onClick={() => testPrint(p)}
                        >
                          Test
                        </Button>
                        <Button size="sm" variant="ghost" className="h-8 px-2" onClick={() => openForm(printerFormFrom(p))}>
                          Edit
                        </Button>
                        {p.active ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-8 px-2 text-muted-foreground"
                            disabled={remove.isPending}
                            onClick={() => setDeactivating(p)}
                          >
                            Deactivate
                          </Button>
                        ) : (
                          <Button size="sm" variant="ghost" className="h-8 px-2" disabled={save.isPending} onClick={() => reactivate(p)}>
                            Reactivate
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {testJob && (
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">
              Test label on {printers.find((p) => p.id === testJob.printerId)?.code ?? "the printer"}
            </p>
            <PrintJobStatus jobId={testJob.jobId} from="desktop" />
          </div>
        )}

        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs font-medium text-muted-foreground">Stations</p>
            {stations.length > 0 && (
              <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setStationLabels(true)}>
                <Printer className="mr-1.5 h-3.5 w-3.5" /> Print station labels
              </Button>
            )}
          </div>
          {stations.length === 0 ? (
            <p className="text-sm text-muted-foreground">No station locations.</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {stations.map((st) => {
                const count = printers.filter((p) => p.station_location_id === st.id && p.active).length;
                return (
                  <span
                    key={st.id}
                    className="inline-flex items-center gap-1.5 rounded-full border border-border/60 px-2.5 py-0.5 text-xs"
                    title={count ? `${count} printer${count === 1 ? "" : "s"}` : "No printer: labels print from the browser"}
                  >
                    <span className="font-medium">{st.code}</span>
                    <span className="text-muted-foreground">{st.name}</span>
                    <span className={cn("tabular-nums", count ? "text-green-400" : "text-muted-foreground")}>
                      {count ? `${count} printer${count === 1 ? "" : "s"}` : "no printer"}
                    </span>
                  </span>
                );
              })}
            </div>
          )}
        </div>
      </CardContent>

      <Dialog open={!!form} onOpenChange={(o) => !o && setForm(null)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{editing ? `Edit ${editing}` : "Add printer"}</DialogTitle>
            <DialogDescription>
              The print agent whose AGENT_ID matches prints this printer&apos;s jobs; a browser printer is printed by the page
              that asked for the label.
            </DialogDescription>
          </DialogHeader>
          {form && (
            <div className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="wh-printer-code">Code</Label>
                  <Input
                    id="wh-printer-code"
                    value={form.code}
                    disabled={!!form.id}
                    placeholder="DOCK-1"
                    onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="wh-printer-name">Name</Label>
                  <Input
                    id="wh-printer-name"
                    value={form.name}
                    placeholder="Dock printer"
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                  />
                </div>
                <div className="space-y-1">
                  <Label>Transport</Label>
                  <Select
                    value={form.transport}
                    onValueChange={(v) => setForm({ ...form, transport: v === "browser" ? "browser" : "agent" })}
                  >
                    <SelectTrigger aria-label="Transport">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="agent">Print agent</SelectItem>
                      <SelectItem value="browser">Browser</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label>Station</Label>
                  <Select
                    value={form.stationLocationId ?? NO_STATION}
                    onValueChange={(v) => setForm({ ...form, stationLocationId: v === NO_STATION ? null : v })}
                  >
                    <SelectTrigger aria-label="Station">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NO_STATION}>Shared (no station)</SelectItem>
                      {stations.map((st) => (
                        <SelectItem key={st.id} value={st.id}>
                          {st.code} · {st.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label>Label stock</Label>
                  <Select value={form.labelStock} onValueChange={(v) => setForm({ ...form, labelStock: v as WhLabelStock })}>
                    <SelectTrigger aria-label="Label stock">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.entries(LABEL_STOCK).map(([value, label]) => (
                        <SelectItem key={value} value={value}>
                          {label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label>Resolution</Label>
                  <Select
                    value={String(form.dpi)}
                    onValueChange={(v) => setForm({ ...form, dpi: (Number(v) as WhPrinterForm["dpi"]) || 203 })}
                  >
                    <SelectTrigger aria-label="Resolution">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {[203, 300, 600].map((d) => (
                        <SelectItem key={d} value={String(d)}>
                          {d} dpi
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              {form.transport === "agent" && (
                <>
                  <div className="space-y-1">
                    <Label htmlFor="wh-printer-agent">Agent id</Label>
                    <Input
                      id="wh-printer-agent"
                      value={form.agentId}
                      placeholder="agent-dock"
                      onChange={(e) => setForm({ ...form, agentId: e.target.value })}
                    />
                    <p className="text-xs text-muted-foreground">The AGENT_ID in the .env of the PC that runs the print agent.</p>
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="wh-printer-address">Address</Label>
                    <Input
                      id="wh-printer-address"
                      value={form.address}
                      placeholder="tcp://192.168.1.50:9100"
                      className="font-mono"
                      onChange={(e) => setForm({ ...form, address: e.target.value })}
                    />
                    <ul className="space-y-0.5 text-xs text-muted-foreground">
                      <li>
                        <span className="font-mono text-foreground/80">tcp://192.168.1.50:9100</span>: a network printer (raw
                        port 9100 when the port is left off).
                      </li>
                      <li>
                        <span className="font-mono text-foreground/80">share://DOCK-PC/Zebra</span>: a USB printer shared from
                        the agent&apos;s PC under that share name.
                      </li>
                      <li>
                        <span className="font-mono text-foreground/80">file://C:/labels</span>: writes .zpl files to a folder
                        (practice, or no printer yet).
                      </li>
                    </ul>
                  </div>
                </>
              )}
              <div className="flex items-center justify-between rounded-md border border-border/60 px-3 py-2">
                <Label htmlFor="wh-printer-active">Active</Label>
                <Switch id="wh-printer-active" checked={form.active} onCheckedChange={(on) => setForm({ ...form, active: on })} />
              </div>
              {problems.length > 0 && (
                <ul className="space-y-0.5 text-xs text-amber-300">
                  {problems.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              )}
              {stale && (
                <div
                  className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-200"
                  role="alert"
                >
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
                  <div className="space-y-1.5">
                    <p>{stale.message} Your changes were not saved.</p>
                    {stale.printer && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7"
                        onClick={() => stale.printer && openForm(printerFormFrom(stale.printer))}
                      >
                        Load the latest
                      </Button>
                    )}
                  </div>
                </div>
              )}
              {saveError && (
                <p className="text-xs text-destructive" role="alert">
                  {saveError}
                </p>
              )}
            </div>
          )}
          <DialogFooter className="gap-2 sm:gap-2">
            <Button variant="ghost" onClick={() => setForm(null)}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={!form || problems.length > 0 || save.isPending}>
              {save.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              {form?.id ? "Save" : "Add printer"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deactivating} onOpenChange={(o) => !o && setDeactivating(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Deactivate {deactivating?.code}?</AlertDialogTitle>
            <AlertDialogDescription>
              Labels stop routing to it; its past jobs keep their printer. It is refused while jobs are queued or printing.
              Reactivate it any time.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={remove.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={remove.isPending}
              onClick={(e) => {
                e.preventDefault();
                if (deactivating) deactivate(deactivating);
              }}
            >
              {remove.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              Deactivate
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {stationLabels && (
        <Suspense fallback={null}>
          <LabelSheet
            open
            onOpenChange={(o) => !o && setStationLabels(false)}
            kind="station"
            ids={stations.map((s) => s.id)}
            from="desktop"
            title={`${stations.length} station labels`}
          />
        </Suspense>
      )}
    </Card>
  );
}
