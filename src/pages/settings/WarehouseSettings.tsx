import { Link } from "react-router-dom";
import { formatDistanceToNow, parseISO } from "date-fns";
import { Printer, ScanBarcode, ShieldAlert, ShieldCheck, ShieldOff } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import {
  useBarcodeCoverage,
  useOutboundMode,
  useSetWarehouseSetting,
  useWarehouseSettings,
  useWhLocations,
  useWhOverview,
  useWhPrinters,
} from "@/lib/hooks";
import type { OutboundMode } from "@/lib/warehouse/outbound";
import { cn } from "@/lib/utils";

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
const PHASE1_SETUP = [
  "Layout import and editor, also opened from the Stock map's Edit layout button",
  "Locations table: zones, racks, bay-levels and their codes",
  "Rack templates",
  "Cart definitions",
  "Tote classes",
  "Scan rules",
  "Printer and station setup",
];

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
 * outbound switch, barcode coverage, and, in Phase 1, locations and layout.
 */
export default function WarehouseSettings() {
  const { toast } = useToast();
  const { data: settings, isLoading: settingsLoading } = useWarehouseSettings();
  const mode = useOutboundMode();
  const setSetting = useSetWarehouseSetting();
  const { data: coverage, isLoading: coverageLoading } = useBarcodeCoverage();
  const { data: overview } = useWhOverview();
  const { data: printers = [], isLoading: printersLoading } = useWhPrinters();
  const { data: locations = [] } = useWhLocations();
  const stations = locations.filter((l) => l.kind === "station" && l.active);

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
        <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
          <div className="space-y-1.5">
            <CardTitle className="text-base">Locations and layout</CardTitle>
            <CardDescription>Where stock physically sits. A location is always a bin or a site.</CardDescription>
          </div>
          <Badge variant="outline" className="shrink-0 text-[10px] text-muted-foreground">
            Phase 1
          </Badge>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-3 gap-3 sm:max-w-md">
            <LayoutCount label="Racks" value={overview?.locations.racks} />
            <LayoutCount label="Rack locations" value={overview?.locations.rack_locations} />
            <LayoutCount label="Named locations" value={overview?.locations.named} />
          </div>
          <p className="text-xs text-muted-foreground">
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

      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle className="text-base">Printers and stations</CardTitle>
          <CardDescription>
            A label prints at the station a worker scanned into, on the printer whose label stock fits.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {printersLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : printers.length === 0 ? (
            <div className="flex items-center gap-3 rounded-md border border-border/50 px-4 py-3 text-sm text-muted-foreground">
              <Printer className="h-4 w-4 shrink-0" />
              No printers registered yet. Labels print from the browser until a print agent registers one.
            </div>
          ) : (
            <div className="overflow-x-auto rounded-md border border-border/50">
              <table className="w-full min-w-[560px] text-sm">
                <thead className="border-b border-border/50 text-left text-xs uppercase tracking-wider text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2.5 font-medium">Printer</th>
                    <th className="px-4 py-2.5 font-medium">Station</th>
                    <th className="px-4 py-2.5 font-medium">Labels</th>
                    <th className="px-4 py-2.5 font-medium">Agent</th>
                    <th className="px-4 py-2.5 font-medium">Last seen</th>
                  </tr>
                </thead>
                <tbody>
                  {printers.map((p) => (
                    <tr key={p.id} className="border-b border-border/50 last:border-0">
                      <td className="px-4 py-1.5">
                        <span className="font-medium">{p.code}</span>
                        <span className="text-muted-foreground"> · {p.name}</span>
                        {!p.active && (
                          <Badge variant="outline" className="ml-2 text-[10px] text-muted-foreground">
                            inactive
                          </Badge>
                        )}
                      </td>
                      <td className="px-4 py-1.5 text-muted-foreground">{p.station?.code ?? "shared"}</td>
                      <td className="px-4 py-1.5 text-muted-foreground">{LABEL_STOCK[p.label_stock] ?? p.label_stock}</td>
                      <td className="px-4 py-1.5 text-muted-foreground">{p.transport === "browser" ? "browser" : (p.agent_id ?? "—")}</td>
                      <td className="whitespace-nowrap px-4 py-1.5 text-muted-foreground">{lastSeen(p.last_seen_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">Stations</p>
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
      </Card>
    </div>
  );
}
