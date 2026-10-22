import { useMemo, useState, type ChangeEvent } from "react";
import { AlertTriangle, CheckCircle2, FileSpreadsheet, Loader2, Play, Save, SearchCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth-context";
import {
  useWhGenerateLocations,
  useWhSaveLayout,
  useWhSaveLocation,
  type WhGenerateResult,
} from "@/lib/hooks";
import {
  compareWithLocationsTab,
  importWorkbook,
  MM_PER_FT,
  type Cell,
  type ScaleRow,
  type SheetRow,
  type WorkbookImport,
  type WorkbookTabs,
} from "@/lib/warehouse/workbook-import";
import { cn } from "@/lib/utils";

/**
 * Settings › Warehouse › Import workbook (design §9.6 steps 1-3). Reads the
 * digitizing workbook (.xlsx, SheetJS loaded only here, on demand), shows
 * what it will save, saves the layout (rpc_wh_save_layout) and the named
 * locations' geometry (rpc_wh_save_location), runs the generator dry run and
 * compares it with the workbook's Locations tab, then applies it. A changed
 * code is a conflict and blocks applying. Admin only.
 */

interface Loaded {
  fileName: string;
  result: WorkbookImport;
  locations: SheetRow[];
}

/** Parse the .xlsx into the tabs workbook-import.ts reads (formula text kept for the Scale rows). */
async function readWorkbookFile(file: File): Promise<{ tabs: WorkbookTabs; locations: SheetRow[] }> {
  const XLSX = await import("xlsx");
  const wb = XLSX.read(await file.arrayBuffer(), { type: "array", cellFormula: true });
  const sheet = (name: string) => {
    const ws = wb.Sheets[name];
    if (!ws) throw new Error(`The workbook has no "${name}" tab.`);
    return ws;
  };
  const rows = (name: string): SheetRow[] => {
    const aoa = XLSX.utils.sheet_to_json<Cell[]>(sheet(name), { header: 1, raw: true, defval: null, blankrows: false });
    const [header, ...body] = aoa;
    if (!header) return [];
    const keys = header.map((h) => (h == null ? "" : String(h).trim()));
    return body.map((r) => {
      const obj: SheetRow = {};
      keys.forEach((k, i) => {
        if (k) obj[k] = r[i] ?? null;
      });
      return obj;
    });
  };
  const ws = sheet("Scale");
  const range = XLSX.utils.decode_range(ws["!ref"] ?? "A1:B1");
  const scale: ScaleRow[] = [];
  for (let r = range.s.r; r <= range.e.r; r++) {
    const a = ws[XLSX.utils.encode_cell({ r, c: 0 })];
    const b = ws[XLSX.utils.encode_cell({ r, c: 1 })];
    if (!a && !b) continue;
    scale.push({ label: (a?.v as Cell) ?? null, value: (b?.v as Cell) ?? null, formula: b?.f ?? null });
  }
  return {
    tabs: { scale, racks: rows("Racks"), faces: rows("Faces"), fixtures: rows("Fixtures") },
    locations: wb.Sheets["Locations"] ? rows("Locations") : [],
  };
}

function Stat({ label, value, tone }: { label: string; value: number | string; tone?: "warn" | "bad" }) {
  return (
    <div className="rounded-md border border-border/50 px-3 py-2">
      <p
        className={cn(
          "text-lg font-semibold tabular-nums",
          tone === "warn" && "text-amber-400",
          tone === "bad" && "text-destructive",
        )}
      >
        {value}
      </p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}

const ft = (mm: number) => (mm / MM_PER_FT).toFixed(1);

export default function LayoutImport() {
  const { isAdmin } = useAuth();
  const { toast } = useToast();
  const saveLayout = useWhSaveLayout();
  const saveLocation = useWhSaveLocation();
  const generate = useWhGenerateLocations();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [parsing, setParsing] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveNote, setSaveNote] = useState<string | null>(null);
  const [dry, setDry] = useState<WhGenerateResult | null>(null);
  const [applied, setApplied] = useState<WhGenerateResult | null>(null);

  const comparison = useMemo(
    () => (dry && loaded && loaded.locations.length > 0 ? compareWithLocationsTab(dry.codes, loaded.locations) : null),
    [dry, loaded],
  );

  if (!isAdmin) {
    return <p className="text-sm text-muted-foreground">Only an admin can import the layout.</p>;
  }

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setParsing(true);
    setParseError(null);
    setLoaded(null);
    setSaveNote(null);
    setApplied(null);
    try {
      const { tabs, locations } = await readWorkbookFile(file);
      setLoaded({ fileName: file.name, result: importWorkbook(tabs), locations });
    } catch (err) {
      setParseError(err instanceof Error ? err.message : "Couldn't read the workbook");
    } finally {
      setParsing(false);
    }
  }

  async function runDry() {
    try {
      setDry(await generate.mutateAsync({ dryRun: true }));
    } catch (err) {
      toast({ title: "Couldn't check the locations", description: err instanceof Error ? err.message : undefined, variant: "destructive" });
    }
  }

  async function save() {
    if (!loaded) return;
    setSaving(true);
    setSaveNote(null);
    setApplied(null);
    try {
      const res = await saveLayout.mutateAsync(loaded.result.payload);
      const failed: string[] = [];
      for (const n of loaded.result.named) {
        try {
          await saveLocation.mutateAsync(n);
        } catch (err) {
          failed.push(`${n.code}: ${err instanceof Error ? err.message : "failed"}`);
        }
      }
      const parts = (["templates", "racks", "faces", "fixtures"] as const).map(
        (k) => `${k} ${res[k]?.created ?? 0} new / ${res[k]?.updated ?? 0} updated`,
      );
      setSaveNote(
        `Saved: ${parts.join(", ")}; ${loaded.result.named.length - failed.length} of ${loaded.result.named.length} named locations placed.` +
          (failed.length ? ` Not placed: ${failed.join("; ")}` : ""),
      );
      await runDry();
    } catch (err) {
      toast({ title: "Layout not saved", description: err instanceof Error ? err.message : undefined, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  async function apply() {
    try {
      const res = await generate.mutateAsync({ dryRun: false });
      setApplied(res);
      setDry(null);
      toast({ title: `Locations generated: ${res.created ?? 0} created, ${res.updated ?? 0} updated, ${res.deactivated ?? 0} deactivated` });
    } catch (err) {
      toast({ title: "Couldn't generate the locations", description: err instanceof Error ? err.message : undefined, variant: "destructive" });
    }
  }

  const r = loaded?.result;
  const busy = parsing || saving || generate.isPending;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <label className="inline-flex">
          <Input type="file" accept=".xlsx" className="sr-only" onChange={onFile} disabled={busy} aria-label="Workbook file" />
          <span
            className={cn(
              "inline-flex h-8 cursor-pointer items-center gap-2 rounded-md border border-input bg-background px-3 text-xs font-medium shadow-sm hover:bg-accent",
              busy && "pointer-events-none opacity-50",
            )}
          >
            {parsing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileSpreadsheet className="h-3.5 w-3.5" />}
            Import workbook
          </span>
        </label>
        <Button size="sm" onClick={save} disabled={!loaded || busy}>
          {saving ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <Save className="mr-2 h-3.5 w-3.5" />}
          Save layout
        </Button>
        <Button size="sm" variant="outline" onClick={runDry} disabled={busy}>
          <SearchCheck className="mr-2 h-3.5 w-3.5" /> Check locations
        </Button>
        <Button size="sm" variant="outline" onClick={apply} disabled={!dry || dry.conflicts.length > 0 || busy}>
          <Play className="mr-2 h-3.5 w-3.5" /> Generate locations
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        The digitizing workbook (.xlsx): Scale, Racks, Faces and Fixtures become racks, faces and fixtures; the named
        locations get their place on the floor; the generator then makes one location per bay and level.
      </p>

      {parseError && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/40 px-3 py-2 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {parseError}
        </div>
      )}

      {loaded && r && (
        <div className="space-y-3 rounded-md border border-border/50 p-3">
          <p className="text-sm">
            <span className="font-medium">{loaded.fileName}</span>
            <span className="text-muted-foreground">
              {" "}
              · {r.scale.pxPerFt.toFixed(2)} px/ft
              {r.scale.building ? ` · building ${ft(r.scale.building.width_mm)} × ${ft(r.scale.building.depth_mm)} ft (${r.scale.building.source})` : ""}
            </span>
          </p>
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
            <Stat label="Templates" value={r.payload.templates.length} />
            <Stat label="Racks" value={r.payload.racks.length} />
            <Stat label="Faces" value={new Set(r.payload.faces.map((f) => f.face_code)).size} />
            <Stat label="Fixtures" value={r.payload.fixtures.length} />
            <Stat label="Named locations" value={r.named.length} />
            <Stat label="Warnings" value={r.warnings.length} tone={r.warnings.length ? "warn" : undefined} />
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-xs">
              <thead className="text-left text-muted-foreground">
                <tr>
                  <th className="py-1 pr-3 font-medium">Rack</th>
                  <th className="py-1 pr-3 font-medium">Template</th>
                  <th className="py-1 pr-3 font-medium">X, Y ft</th>
                  <th className="py-1 pr-3 font-medium">Turn</th>
                  <th className="py-1 pr-3 font-medium">Bays × levels</th>
                  <th className="py-1 font-medium">Faces (pass, walk, zones)</th>
                </tr>
              </thead>
              <tbody>
                {r.payload.racks.map((rack) => (
                  <tr key={rack.code} className="border-t border-border/40">
                    <td className="py-1 pr-3 font-medium">{rack.code}</td>
                    <td className="py-1 pr-3 text-muted-foreground">{rack.template_code}</td>
                    <td className="py-1 pr-3 tabular-nums">
                      {ft(rack.x_mm)}, {ft(rack.y_mm)}
                    </td>
                    <td className="py-1 pr-3 tabular-nums">{rack.rot_deg}°</td>
                    <td className="py-1 pr-3 tabular-nums">
                      {rack.bays} × {rack.levels}
                    </td>
                    <td className="py-1 text-muted-foreground">
                      {r.payload.faces
                        .filter((f) => f.rack_code === rack.code)
                        .map((f) => `${f.face_code} (${f.walk_pass}, ${f.walk_dir ?? "–"}, ${f.zone_by_bay.join("/")})`)
                        .join(" · ")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {r.warnings.length > 0 && (
            <ul className="space-y-0.5 text-xs text-amber-400/90">
              {r.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {saveNote && <p className="text-xs text-muted-foreground">{saveNote}</p>}

      {dry && (
        <div className="space-y-3 rounded-md border border-border/50 p-3">
          <p className="text-sm font-medium">Generator dry run</p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label="Create" value={dry.create.length} />
            <Stat label="Update" value={dry.update.length} />
            <Stat label="Conflicts" value={dry.conflicts.length} tone={dry.conflicts.length ? "bad" : undefined} />
            <Stat label="Deactivate" value={dry.deactivate.length} tone={dry.deactivate.length ? "warn" : undefined} />
          </div>
          {dry.conflicts.length > 0 && (
            <div className="space-y-1 text-xs text-destructive">
              <p className="font-medium">Conflicts block generating. A bay-level never changes its code silently:</p>
              <ul className="space-y-0.5">
                {dry.conflicts.map((c) => (
                  <li key={`${c.code}-${c.reason}`}>
                    {c.code}
                    {c.existing_code && c.existing_code !== c.code ? ` (now ${c.existing_code})` : ""}: {c.reason.replace(/_/g, " ")}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {dry.deactivate.length > 0 && (
            <p className="text-xs text-amber-400">Deactivated (empty, no longer in the layout): {dry.deactivate.join(", ")}</p>
          )}
          {comparison && (
            <div className="space-y-1 text-xs">
              <p className={cn(comparison.onlyInWorkbook.length || comparison.onlyInGenerator.length ? "text-destructive" : "text-muted-foreground")}>
                Against the workbook's Locations tab: {comparison.matched.length} codes match
                {comparison.onlyInWorkbook.length ? `; only in the workbook: ${comparison.onlyInWorkbook.join(", ")}` : ""}
                {comparison.onlyInGenerator.length ? `; only generated: ${comparison.onlyInGenerator.join(", ")}` : ""}
                {comparison.flagDiffs.length ? `; ${comparison.flagDiffs.length} zone or pick-flag differences` : ""}.
              </p>
              {comparison.sequenceDiffs.length > 0 && (
                <details>
                  <summary className="cursor-pointer text-muted-foreground">
                    {comparison.sequenceDiffs.length} pick_sequence differences: facing faces walked on one pass are
                    interleaved by position, and unrouted faces are numbered 99xxx
                  </summary>
                  <p className="mt-1 font-mono text-[11px] leading-5 text-muted-foreground">
                    {comparison.sequenceDiffs.map((d) => `${d.code} ${d.workbook ?? "–"}→${d.generator ?? "–"}`).join(" · ")}
                  </p>
                </details>
              )}
            </div>
          )}
          <details>
            <summary className="cursor-pointer text-xs text-muted-foreground">{dry.codes.length} codes in walk order</summary>
            <p className="mt-1 font-mono text-[11px] leading-5 text-muted-foreground">
              {dry.codes.map((c) => `${c.code}·${c.pick_sequence}`).join("  ")}
            </p>
          </details>
        </div>
      )}

      {applied && (
        <p className="flex items-center gap-2 text-sm text-green-400">
          <CheckCircle2 className="h-4 w-4" /> Generated: {applied.created ?? 0} created, {applied.updated ?? 0} updated,{" "}
          {applied.deactivated ?? 0} deactivated.
        </p>
      )}
    </div>
  );
}
