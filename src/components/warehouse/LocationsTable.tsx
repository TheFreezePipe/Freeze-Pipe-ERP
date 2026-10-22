import { lazy, Suspense, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { format, parseISO } from "date-fns";
import { ArrowDown, ArrowUp, Check, Download, Printer, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import {
  useWhLocationExtras,
  useWhLocations,
  useWhSaveLocation,
  type WhLabelKind,
  type WhLocationSummary,
} from "@/lib/hooks";
import { toCsv } from "@/lib/warehouse/csv";
import { MM_PER_FT } from "@/lib/warehouse/workbook-import";
import { cn } from "@/lib/utils";

/**
 * Settings › Warehouse › Locations (design §9.1 Locations page): every
 * wh_locations row, dense, with face/zone filters, search and sort; inline
 * edit of capacity and active through rpc_wh_save_location; CSV export; and
 * row or bulk label printing through LabelSheet. Reads wh_location_summary
 * (useWhLocations) plus row_version from wh_locations for safe edits.
 */

// Loaded on first print, so bwip-js (Code 128) stays out of the main bundle.
const LabelSheet = lazy(() => import("./LabelSheet"));

type Row = WhLocationSummary & { id: string; code: string };

type SortKey =
  | "code"
  | "kind"
  | "face"
  | "bay"
  | "level"
  | "zone"
  | "pickable"
  | "is_overflow"
  | "pick_sequence"
  | "capacity_cartons"
  | "x_mm"
  | "y_mm"
  | "z_mm"
  | "last_counted_at"
  | "label_printed_at"
  | "label_verified_at"
  | "active";

const NAMED = "__named";
const ALL = "all";

const ft = (mm: number | null | undefined) => (mm == null ? "" : (mm / MM_PER_FT).toFixed(1));
const day = (iso: string | null | undefined) => (iso ? format(parseISO(iso), "MMM d") : "");

function compare(a: unknown, b: unknown): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1; // nulls last in both directions (handled by the caller)
  if (b == null) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(b) - Number(a);
  return String(a).localeCompare(String(b), undefined, { numeric: true });
}

const COLUMNS: { key: SortKey; label: string; className?: string; title?: string }[] = [
  { key: "code", label: "Code" },
  { key: "kind", label: "Kind" },
  { key: "face", label: "Face" },
  { key: "bay", label: "Bay", className: "text-right" },
  { key: "level", label: "Lvl", className: "text-right", title: "Level" },
  { key: "zone", label: "Zone" },
  { key: "pickable", label: "Pick", title: "Pickable (levels 1-2 of RTS and ACC)" },
  { key: "is_overflow", label: "OF", title: "Overflow (top level, never picked)" },
  { key: "pick_sequence", label: "Seq", className: "text-right", title: "Pick sequence" },
  { key: "capacity_cartons", label: "Cap", className: "text-right", title: "Capacity, cartons (click to edit)" },
  { key: "x_mm", label: "X ft", className: "text-right" },
  { key: "y_mm", label: "Y ft", className: "text-right" },
  { key: "z_mm", label: "Z ft", className: "text-right" },
  { key: "last_counted_at", label: "Counted" },
  { key: "label_printed_at", label: "Printed", title: "Label printed" },
  { key: "label_verified_at", label: "Verified", title: "Label verified on the label walk" },
  { key: "active", label: "Active" },
];

function Tick({ on }: { on: boolean | null | undefined }) {
  return on ? <Check className="h-3.5 w-3.5 text-green-400" /> : <span className="text-muted-foreground/50">·</span>;
}

export default function LocationsTable() {
  const { toast } = useToast();
  const { data: all = [], isLoading } = useWhLocations();
  const { data: extras } = useWhLocationExtras();
  const save = useWhSaveLocation();
  const [face, setFace] = useState(ALL);
  const [zone, setZone] = useState(ALL);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "pick_sequence", dir: 1 });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null);
  const cancelEdit = useRef(false);
  const [labels, setLabels] = useState<{ kind: WhLabelKind; ids: string[]; title: string } | null>(null);

  const rows = useMemo(() => all.filter((r): r is Row => !!r.id && !!r.code), [all]);
  const faces = useMemo(() => [...new Set(rows.map((r) => r.face).filter((f): f is string => !!f))].sort(), [rows]);
  const zones = useMemo(() => [...new Set(rows.map((r) => r.zone).filter((z): z is string => !!z))].sort(), [rows]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = rows.filter(
      (r) =>
        (face === ALL || (face === NAMED ? r.kind !== "bay_level" : r.face === face)) &&
        (zone === ALL || r.zone === zone) &&
        (!q || r.code.toLowerCase().includes(q) || (r.name ?? "").toLowerCase().includes(q)),
    );
    return filtered.sort((a, b) => {
      const av = a[sort.key];
      const bv = b[sort.key];
      if (av == null || bv == null) return compare(av, bv);
      return compare(av, bv) * sort.dir || a.code.localeCompare(b.code);
    });
  }, [rows, face, zone, query, sort]);

  const visibleIds = visible.map((r) => r.id);
  const selectedVisible = visibleIds.filter((id) => selected.has(id));
  const allChecked = visible.length > 0 && selectedVisible.length === visible.length;

  function toggleSort(key: SortKey) {
    setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: 1 }));
  }

  function toggle(id: string, on: boolean) {
    setSelected((s) => {
      const next = new Set(s);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function toggleAll(on: boolean) {
    setSelected((s) => {
      const next = new Set(s);
      for (const id of visibleIds) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }

  function patch(row: Row, fields: { capacity_cartons?: number | null; active?: boolean }, done?: () => void) {
    const version = extras?.get(row.id)?.row_version;
    save.mutate(
      { id: row.id, ...(version != null ? { row_version: version } : {}), ...fields },
      {
        onSuccess: () => done?.(),
        onError: (err) =>
          toast({ title: `Couldn't change ${row.code}`, description: err instanceof Error ? err.message : undefined, variant: "destructive" }),
      },
    );
  }

  function commitCapacity(row: Row) {
    if (cancelEdit.current) {
      cancelEdit.current = false;
      return;
    }
    if (!editing || editing.id !== row.id) return;
    const text = editing.value.trim();
    const value = text === "" ? null : Number(text);
    if (value !== null && (!Number.isInteger(value) || value <= 0)) {
      toast({ title: "Capacity is a whole number of cartons above 0, or empty", variant: "destructive" });
      return;
    }
    if (value === (row.capacity_cartons ?? null)) {
      setEditing(null);
      return;
    }
    patch(row, { capacity_cartons: value }, () => setEditing(null));
  }

  // Enter commits through blur, so a save runs once whichever way the field is left.
  function onCapacityKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") e.currentTarget.blur();
    if (e.key === "Escape") {
      cancelEdit.current = true;
      setEditing(null);
    }
  }

  function printLabels(ids: string[]) {
    const picked = rows.filter((r) => ids.includes(r.id));
    const kind: WhLabelKind = picked.length > 0 && picked.every((r) => r.kind === "station") ? "station" : "location";
    const ordered = visible.filter((r) => ids.includes(r.id)).map((r) => r.id);
    const title = ordered.length === 1 ? `label ${picked[0]?.code ?? ""}` : `${ordered.length} location labels`;
    setLabels({ kind, ids: ordered.length ? ordered : ids, title });
  }

  function exportCsv() {
    const header = ["code", "name", "kind", "face", "bay", "level", "zone", "pickable", "overflow", "pick_sequence",
      "capacity_cartons", "x_ft", "y_ft", "z_ft", "last_counted_at", "label_printed_at", "label_verified_at", "active"];
    const body = visible.map((r) => [
      r.code, r.name, r.kind, r.face, r.bay, r.level, r.zone, r.pickable, r.is_overflow, r.pick_sequence,
      r.capacity_cartons, ft(r.x_mm), ft(r.y_mm), ft(r.z_mm), r.last_counted_at, r.label_printed_at, r.label_verified_at, r.active,
    ]);
    const blob = new Blob([toCsv([header, ...body])], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `wh-locations-${format(new Date(), "yyyy-MM-dd")}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search code or name"
            className="h-8 w-[180px] pl-8 text-xs"
            aria-label="Search locations"
          />
        </div>
        <Select value={face} onValueChange={setFace}>
          <SelectTrigger className="h-8 w-[130px] text-xs" aria-label="Face">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All faces</SelectItem>
            {faces.map((f) => (
              <SelectItem key={f} value={f}>
                Face {f}
              </SelectItem>
            ))}
            <SelectItem value={NAMED}>Named</SelectItem>
          </SelectContent>
        </Select>
        <Select value={zone} onValueChange={setZone}>
          <SelectTrigger className="h-8 w-[120px] text-xs" aria-label="Zone">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All zones</SelectItem>
            {zones.map((z) => (
              <SelectItem key={z} value={z}>
                {z}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="text-xs text-muted-foreground tabular-nums">
          {visible.length} of {rows.length}
        </span>
        <div className="ml-auto flex gap-2">
          <Button size="sm" variant="outline" onClick={() => printLabels(selectedVisible)} disabled={selectedVisible.length === 0}>
            <Printer className="mr-2 h-3.5 w-3.5" /> Print labels{selectedVisible.length ? ` (${selectedVisible.length})` : ""}
          </Button>
          <Button size="sm" variant="outline" onClick={exportCsv} disabled={visible.length === 0}>
            <Download className="mr-2 h-3.5 w-3.5" /> CSV
          </Button>
        </div>
      </div>

      <div className="max-h-[560px] overflow-auto rounded-md border border-border/50">
        <table className="w-full min-w-[1160px] text-xs">
          <thead className="sticky top-0 z-10 border-b border-border/50 bg-card text-left uppercase tracking-wider text-muted-foreground">
            <tr>
              <th className="w-8 px-2 py-2">
                <Checkbox checked={allChecked} onCheckedChange={(v) => toggleAll(v === true)} aria-label="Select all shown" />
              </th>
              {COLUMNS.map((c) => (
                <th key={c.key} className={cn("whitespace-nowrap px-2 py-2 font-medium", c.className)} title={c.title}>
                  <button type="button" className="inline-flex items-center gap-0.5 uppercase hover:text-foreground" onClick={() => toggleSort(c.key)}>
                    {c.label}
                    {sort.key === c.key && (sort.dir === 1 ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}
                  </button>
                </th>
              ))}
              <th className="px-2 py-2" />
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td colSpan={COLUMNS.length + 2} className="px-3 py-6 text-center text-muted-foreground">
                  Loading…
                </td>
              </tr>
            ) : visible.length === 0 ? (
              <tr>
                <td colSpan={COLUMNS.length + 2} className="px-3 py-6 text-center text-muted-foreground">
                  {rows.length === 0 ? "No locations yet. Import the workbook and generate them." : "Nothing matches."}
                </td>
              </tr>
            ) : (
              visible.map((r) => (
                <tr key={r.id} className={cn("border-b border-border/40 last:border-0 hover:bg-muted/30", !r.active && "text-muted-foreground")}>
                  <td className="px-2 py-1">
                    <Checkbox checked={selected.has(r.id)} onCheckedChange={(v) => toggle(r.id, v === true)} aria-label={`Select ${r.code}`} />
                  </td>
                  <td className="whitespace-nowrap px-2 py-1 font-mono font-medium" title={r.name ?? undefined}>
                    {r.code}
                  </td>
                  <td className="px-2 py-1 text-muted-foreground">{r.kind === "bay_level" ? "bay" : r.kind}</td>
                  <td className="px-2 py-1 tabular-nums">{r.face ?? ""}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{r.bay ?? ""}</td>
                  <td className="px-2 py-1 text-right tabular-nums">
                    {r.level ?? ""}
                  </td>
                  <td className="px-2 py-1">{r.zone}</td>
                  <td className="px-2 py-1">
                    <Tick on={r.pickable} />
                  </td>
                  <td className="px-2 py-1">
                    {r.is_overflow ? <span className="text-amber-400">OF</span> : <Tick on={false} />}
                  </td>
                  <td className="px-2 py-1 text-right tabular-nums">{r.pick_sequence ?? ""}</td>
                  <td className="px-2 py-1 text-right tabular-nums">
                    {editing?.id === r.id ? (
                      <Input
                        autoFocus
                        inputMode="numeric"
                        value={editing.value}
                        onChange={(e) => setEditing({ id: r.id, value: e.target.value })}
                        onKeyDown={onCapacityKey}
                        onBlur={() => commitCapacity(r)}
                        className="ml-auto h-6 w-14 px-1 text-right text-xs"
                        aria-label={`Capacity of ${r.code}`}
                      />
                    ) : (
                      <button
                        type="button"
                        className="min-w-[2rem] rounded px-1 text-right hover:bg-muted"
                        onClick={() => {
                          cancelEdit.current = false;
                          setEditing({ id: r.id, value: r.capacity_cartons?.toString() ?? "" });
                        }}
                        title="Edit capacity (cartons)"
                      >
                        {r.capacity_cartons ?? <span className="text-muted-foreground/50">—</span>}
                      </button>
                    )}
                  </td>
                  <td className="px-2 py-1 text-right tabular-nums">{ft(r.x_mm)}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{ft(r.y_mm)}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{ft(r.z_mm)}</td>
                  <td className="whitespace-nowrap px-2 py-1 text-muted-foreground">{day(r.last_counted_at)}</td>
                  <td className="whitespace-nowrap px-2 py-1 text-muted-foreground">
                    {r.label_printed_at ? day(r.label_printed_at) : <Tick on={false} />}
                  </td>
                  <td className="px-2 py-1">
                    <Tick on={!!r.label_verified_at} />
                  </td>
                  <td className="px-2 py-1">
                    <Switch
                      checked={!!r.active}
                      onCheckedChange={(on) => patch(r, { active: on })}
                      disabled={save.isPending || r.code === "UNLOCATED" || r.code === "MFG-LINE"}
                      aria-label={`${r.code} active`}
                      className="scale-75"
                    />
                  </td>
                  <td className="px-2 py-1">
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-6 w-6"
                      onClick={() => printLabels([r.id])}
                      title={`Print the ${r.code} label`}
                      aria-label={`Print the ${r.code} label`}
                    >
                      <Printer className="h-3.5 w-3.5" />
                    </Button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {labels && (
        <Suspense fallback={null}>
          <LabelSheet
            open
            onOpenChange={(open) => {
              if (!open) setLabels(null);
            }}
            kind={labels.kind}
            ids={labels.ids}
            title={labels.title}
            onPrinted={() => setSelected(new Set())}
          />
        </Suspense>
      )}
    </div>
  );
}
