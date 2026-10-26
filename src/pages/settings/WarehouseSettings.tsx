import { lazy, Suspense, useState } from "react";
import { Link } from "react-router-dom";
import { formatDistanceToNow, parseISO } from "date-fns";
import { AlertTriangle, Copy, Plus, Printer, ScanBarcode, ShieldAlert, ShieldCheck, ShieldOff } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import {
  AGENT_OFFLINE_MS,
  printerDraftProblems,
  printerUpsertSql,
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
  type WhPrinterDraft,
  type WhPrinterRow,
} from "@/lib/hooks";
import { PrintJobStatus } from "@/components/warehouse/PrintJobStatus";
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
const PHASE1_SETUP = ["Rack templates", "Cart definitions", "Tote classes", "Scan rules", "Printer and station setup"];

const LABEL_STOCK: Record<string, string> = {
  white_4x2: "White 4×2",
  green_4x2: "Green 4×2",
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
 * outbound switch, barcode coverage, the layout import and the locations
 * table, printers and stations.
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

      <PrintersAndStations />
    </div>
  );
}

// ---- Printers and stations ------------------------------------------------------

const EMPTY_PRINTER: WhPrinterDraft = {
  code: "",
  name: "",
  stationLocationId: null,
  address: "tcp://",
  labelStock: "white_4x2",
  dpi: 203,
  active: true,
  agentId: "",
};

const NO_STATION = "__none__";

function draftFrom(p: WhPrinterRow): WhPrinterDraft {
  return {
    code: p.code,
    name: p.name,
    stationLocationId: p.station_location_id,
    address: p.address ?? "",
    labelStock: (p.label_stock as WhLabelStock) ?? "white_4x2",
    dpi: p.dpi === 300 || p.dpi === 600 ? p.dpi : 203,
    active: p.active,
    agentId: p.agent_id ?? "",
  };
}

/**
 * Printers with their agent's heartbeat and queue, a test print per printer
 * and station labels (all through rpc_wh_request_labels). Registering or
 * editing a printer has no RPC yet and wh_printers has no client write
 * policy, so the dialog builds the SQL for the database owner (labelled as
 * a workaround in the card).
 */
function PrintersAndStations() {
  const { toast } = useToast();
  const { data: stations = [] } = useWhStations();
  const { data: printers = [], isLoading, dataUpdatedAt } = useWhPrinters();
  const { data: queues = {} } = useWhPrinterQueues();
  const { mutate: requestLabels, isPending: testing } = useWhRequestLabels();
  const { mutate: markPrinted } = useWhMarkPrinted();
  const [draft, setDraft] = useState<WhPrinterDraft | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [testJob, setTestJob] = useState<{ printerId: string; jobId: string } | null>(null);
  const [stationLabels, setStationLabels] = useState(false);

  const problems = draft ? printerDraftProblems(draft) : [];
  const sql = draft && problems.length === 0 ? printerUpsertSql(draft) : "";

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

  async function copySql() {
    try {
      await navigator.clipboard.writeText(sql);
      toast({ title: "SQL copied", description: "Run it in the Supabase SQL editor, then wait for the agent's next heartbeat." });
    } catch {
      toast({ title: "Couldn't copy", description: "Select the text and copy it by hand.", variant: "destructive" });
    }
  }

  return (
    <Card className="lg:col-span-2">
      <CardHeader className="space-y-1.5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1.5">
            <CardTitle className="text-base">Printers and stations</CardTitle>
            <CardDescription>
              A label prints at the station a worker scanned into, on the printer whose label stock fits. A print agent on
              a PC (tools/print-agent) prints the jobs for its printers.
            </CardDescription>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setEditing(null);
              setDraft({ ...EMPTY_PRINTER });
            }}
          >
            <Plus className="mr-1.5 h-4 w-4" /> Add printer
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
          <p>
            <span className="font-semibold">Workaround:</span> the app cannot save printers yet (wh_printers has no client
            write policy and there is no printer RPC), so Add printer and Edit build the SQL statement for the database owner
            to run in the Supabase SQL editor. Test print, the queue and station labels work from here.
          </p>
        </div>

        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : printers.length === 0 ? (
          <div className="flex items-center gap-3 rounded-md border border-border/50 px-4 py-3 text-sm text-muted-foreground">
            <Printer className="h-4 w-4 shrink-0" />
            No printers registered yet. Labels print from the browser until one is registered and its agent runs.
          </div>
        ) : (
          <div className="overflow-x-auto rounded-md border border-border/50">
            <table className="w-full min-w-[820px] text-sm">
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
                    <tr key={p.id} className="border-b border-border/50 align-top last:border-0">
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
                            {q.queued + q.claimed} open
                            {q.failed > 0 && <span className="text-destructive"> · {q.failed} failed</span>}
                          </>
                        ) : (
                          "0 open"
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
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-8 px-2"
                          onClick={() => {
                            setEditing(p.code);
                            setDraft(draftFrom(p));
                          }}
                        >
                          Edit
                        </Button>
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

      <Dialog open={!!draft} onOpenChange={(o) => !o && setDraft(null)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{editing ? `Edit ${editing}` : "Add printer"}</DialogTitle>
            <DialogDescription>
              Builds the statement for the database owner (no printer RPC yet). Saving by code updates the printer if it
              exists.
            </DialogDescription>
          </DialogHeader>
          {draft && (
            <div className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="wh-printer-code">Code</Label>
                  <Input
                    id="wh-printer-code"
                    value={draft.code}
                    disabled={!!editing}
                    placeholder="DOCK-1"
                    onChange={(e) => setDraft({ ...draft, code: e.target.value.toUpperCase() })}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="wh-printer-name">Name</Label>
                  <Input
                    id="wh-printer-name"
                    value={draft.name}
                    placeholder="Dock printer"
                    onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  />
                </div>
                <div className="space-y-1">
                  <Label>Station</Label>
                  <Select
                    value={draft.stationLocationId ?? NO_STATION}
                    onValueChange={(v) => setDraft({ ...draft, stationLocationId: v === NO_STATION ? null : v })}
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
                  <Label htmlFor="wh-printer-agent">Agent id</Label>
                  <Input
                    id="wh-printer-agent"
                    value={draft.agentId}
                    placeholder="agent-dock"
                    onChange={(e) => setDraft({ ...draft, agentId: e.target.value })}
                  />
                </div>
                <div className="space-y-1">
                  <Label>Label stock</Label>
                  <Select value={draft.labelStock} onValueChange={(v) => setDraft({ ...draft, labelStock: v as WhLabelStock })}>
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
                    value={String(draft.dpi)}
                    onValueChange={(v) => setDraft({ ...draft, dpi: (Number(v) as WhPrinterDraft["dpi"]) || 203 })}
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
              <div className="space-y-1">
                <Label htmlFor="wh-printer-address">Address</Label>
                <Input
                  id="wh-printer-address"
                  value={draft.address}
                  placeholder="tcp://192.168.1.50:9100"
                  className="font-mono"
                  onChange={(e) => setDraft({ ...draft, address: e.target.value })}
                />
                <p className="text-xs text-muted-foreground">
                  tcp://ip:9100 for a network printer; share://PC-NAME/ShareName for a USB printer shared on the agent&apos;s
                  PC; file://C:/labels to write .zpl files (practice, or no printer yet). Labels render at 203 dpi.
                </p>
              </div>
              <div className="flex items-center justify-between rounded-md border border-border/60 px-3 py-2">
                <Label htmlFor="wh-printer-active">Active</Label>
                <Switch
                  id="wh-printer-active"
                  checked={draft.active}
                  onCheckedChange={(on) => setDraft({ ...draft, active: on })}
                />
              </div>
              {problems.length > 0 ? (
                <ul className="space-y-0.5 text-xs text-amber-300">
                  {problems.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              ) : (
                <Textarea readOnly value={sql} rows={8} className="font-mono text-xs" aria-label="SQL for the database owner" />
              )}
            </div>
          )}
          <DialogFooter className="gap-2 sm:gap-2">
            <Button variant="ghost" onClick={() => setDraft(null)}>
              Close
            </Button>
            <Button onClick={copySql} disabled={!sql}>
              <Copy className="mr-1.5 h-4 w-4" /> Copy SQL
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
