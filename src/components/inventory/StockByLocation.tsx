import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { format, parseISO } from "date-fns";
import { MapPin, Search } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useWhLocations, type WhLocationContent, type WhLocationSummary } from "@/lib/hooks";
import { cn } from "@/lib/utils";

/** Named locations always listed under "Other"; other floor spots appear once they hold stock. */
const OTHER_ALWAYS = ["IN-01", "SPARES-01", "UNLOCATED", "MFG-LINE"];

interface FaceGroup {
  face: string;
  label: string;
  locations: WhLocationSummary[];
  units: number;
  cartons: number;
  firstSequence: number;
}

type Selection = { type: "face"; face: string } | { type: "location"; id: string };

const ZONE_SUFFIX: Record<string, string> = {
  RAW: "raw",
  BOX: "boxes",
  WIP: "WIP",
  ACC: "accessories",
  MISC: "misc",
};

function dominantZone(rows: WhLocationSummary[]): string {
  const tally = new Map<string, number>();
  for (const r of rows) tally.set(r.zone ?? "", (tally.get(r.zone ?? "") ?? 0) + 1);
  return [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
}

/** Rack faces in walk order (the lowest pick_sequence on the face), with their totals. */
function groupFaces(rows: WhLocationSummary[]): FaceGroup[] {
  const byFace = new Map<string, WhLocationSummary[]>();
  for (const r of rows) {
    if (r.kind !== "bay_level" || !r.active || !r.face) continue;
    const list = byFace.get(r.face) ?? [];
    list.push(r);
    byFace.set(r.face, list);
  }
  return [...byFace.entries()]
    .map(([face, locations]) => {
      const racks = [...new Set(locations.map((l) => l.rack_code).filter(Boolean))].join("/");
      const zone = dominantZone(locations);
      const suffix = ZONE_SUFFIX[zone];
      locations.sort(
        (a, b) => (a.bay ?? 0) - (b.bay ?? 0) || (a.level ?? 0) - (b.level ?? 0) || (a.code ?? "").localeCompare(b.code ?? ""),
      );
      return {
        face,
        label: [face, racks, suffix].filter(Boolean).join(" · "),
        locations,
        units: locations.reduce((s, l) => s + (l.units ?? 0), 0),
        cartons: locations.reduce((s, l) => s + (l.cartons ?? 0), 0),
        firstSequence: Math.min(...locations.map((l) => l.pick_sequence ?? Number.MAX_SAFE_INTEGER)),
      };
    })
    .sort((a, b) => a.firstSequence - b.firstSequence || a.face.localeCompare(b.face));
}

/** Named floor and virtual locations for the "Other" heading. */
function otherLocations(rows: WhLocationSummary[]): WhLocationSummary[] {
  return rows
    .filter(
      (r) =>
        (r.kind === "floor" || r.kind === "virtual") &&
        r.active &&
        (OTHER_ALWAYS.includes(r.code ?? "") || (r.units ?? 0) !== 0 || (r.cartons ?? 0) > 0),
    )
    .sort((a, b) => {
      const ia = OTHER_ALWAYS.indexOf(a.code ?? "");
      const ib = OTHER_ALWAYS.indexOf(b.code ?? "");
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || (a.code ?? "").localeCompare(b.code ?? "");
    });
}

function levelLabel(row: WhLocationSummary): string {
  if (row.kind !== "bay_level") return row.kind === "virtual" ? "virtual" : (row.name ?? "floor");
  const base = row.level === 1 ? "floor" : String(row.level ?? "");
  return row.is_overflow ? `${base} · overflow` : base;
}

function cartonStates(contents: WhLocationContent[]): string {
  const seen = new Map<string, string>();
  for (const c of contents) if (c.container_id && c.state) seen.set(c.container_id, c.state);
  const open = [...seen.values()].filter((s) => s === "open").length;
  const sealed = [...seen.values()].filter((s) => s === "sealed").length;
  const parts = [open ? `${open} open` : "", sealed ? `${sealed} sealed` : ""].filter(Boolean);
  return parts.length ? parts.join(" · ") : "—";
}

function ContentChip({ item }: { item: WhLocationContent }) {
  const negative = item.qty < 0;
  const loose = !item.container_id;
  const tone = negative
    ? "border-amber-400/35 bg-amber-400/10 text-amber-400"
    : item.label_stock === "green"
      ? "border-green-500/35 bg-green-500/10 text-green-400"
      : item.state === "sealed"
        ? "border-cyan-400/35 bg-cyan-400/10 text-cyan-400"
        : "border-slate-400/30 bg-slate-400/10 text-slate-300";
  const text =
    item.state === "sealed" && item.code
      ? `${item.code} · ${item.sku} · ${item.qty}`
      : `${item.sku} · ${item.qty}${loose ? " loose" : ""}`;
  return (
    <span
      className={cn(
        "inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-semibold tabular-nums",
        loose && !negative && "border-dashed",
        tone,
      )}
      title={[item.code, item.bucket, item.state, item.label_stock === "green" ? "green RTS label" : null].filter(Boolean).join(" · ")}
    >
      {text}
    </span>
  );
}

function FillBar({ cartons, capacity }: { cartons: number; capacity: number | null }) {
  if (!capacity) return <span className="text-xs text-muted-foreground">—</span>;
  const pct = Math.min(100, Math.round((cartons / capacity) * 100));
  return (
    <span className="inline-flex items-center gap-2" title={`${cartons} of ${capacity} cartons`}>
      <span className="inline-block h-1 w-16 overflow-hidden rounded-full bg-muted">
        <span
          className={cn("block h-full rounded-full", pct >= 100 ? "bg-amber-400" : "bg-primary")}
          style={{ width: `${pct}%` }}
        />
      </span>
    </span>
  );
}

function matches(row: WhLocationSummary, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  if ((row.code ?? "").toLowerCase().includes(needle) || (row.name ?? "").toLowerCase().includes(needle)) return true;
  return row.contents.some(
    (c) => c.sku.toLowerCase().includes(needle) || (c.code ?? "").toLowerCase().includes(needle),
  );
}

function ListButton({
  active,
  onClick,
  children,
  trailing,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  trailing: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-2 text-left text-sm transition-colors",
        active ? "bg-primary/10 text-primary" : "text-foreground/85 hover:bg-muted",
      )}
    >
      <span className="truncate">{children}</span>
      <span className="shrink-0 text-xs tabular-nums">{trailing}</span>
    </button>
  );
}

/**
 * Stock › By location: rack faces in walk order on the left, the selected
 * face's bay-levels on the right with what each holds, carton by carton.
 * Named floor locations sit under "Other".
 */
export function StockByLocation() {
  const { data: rows = [], isLoading, error } = useWhLocations();
  const [selection, setSelection] = useState<Selection | null>(null);
  const [query, setQuery] = useState("");
  const [zone, setZone] = useState("all");

  const faces = useMemo(() => groupFaces(rows), [rows]);
  const others = useMemo(() => otherLocations(rows), [rows]);
  const hasRacks = faces.length > 0;

  const active: Selection | null = selection ?? (faces[0] ? { type: "face", face: faces[0].face } : null);
  const activeFace = active?.type === "face" ? faces.find((f) => f.face === active.face) ?? null : null;
  const activeOther = active?.type === "location" ? others.find((o) => o.id === active.id) ?? null : null;

  const zones = useMemo(
    () => [...new Set(rows.filter((r) => r.kind === "bay_level").map((r) => r.zone ?? ""))].filter(Boolean).sort(),
    [rows],
  );

  const q = query.trim();
  const tableRows = useMemo(() => {
    let list: WhLocationSummary[];
    if (q) {
      list = [...faces.flatMap((f) => f.locations), ...others].filter((r) => matches(r, q));
    } else if (activeFace) {
      list = activeFace.locations;
    } else if (activeOther) {
      list = [activeOther];
    } else {
      list = [];
    }
    return zone === "all" ? list : list.filter((r) => r.zone === zone);
  }, [q, faces, others, activeFace, activeOther, zone]);

  const units = tableRows.reduce((s, r) => s + (r.units ?? 0), 0);
  const cartons = tableRows.reduce((s, r) => s + (r.cartons ?? 0), 0);
  const heading = q
    ? `${tableRows.length} match${tableRows.length === 1 ? "" : "es"}`
    : activeFace
      ? `Face ${activeFace.face}`
      : activeOther
        ? (activeOther.code ?? "")
        : "";

  return (
    <div className="flex min-w-0 flex-col gap-4 md:flex-row md:items-stretch">
      <Card className="flex w-full shrink-0 flex-col gap-0.5 p-2.5 md:w-60" aria-label="Locations">
        <p className="px-2.5 pb-1.5 pt-1.5 text-[11px] uppercase tracking-wider text-muted-foreground">Rack faces · walk order</p>
        {isLoading ? (
          <p className="px-2.5 py-2 text-sm text-muted-foreground">Loading…</p>
        ) : hasRacks ? (
          faces.map((f) => (
            <ListButton
              key={f.face}
              active={!q && active?.type === "face" && active.face === f.face}
              onClick={() => {
                setQuery("");
                setSelection({ type: "face", face: f.face });
              }}
              trailing={f.units ? f.units.toLocaleString() : "—"}
            >
              {f.label}
            </ListButton>
          ))
        ) : (
          <p className="px-2.5 py-2 text-sm text-muted-foreground">No rack faces yet</p>
        )}
        <p className="px-2.5 pb-1.5 pt-3 text-[11px] uppercase tracking-wider text-muted-foreground">Other</p>
        {others.map((o) => (
          <ListButton
            key={o.id}
            active={!q && active?.type === "location" && active.id === o.id}
            onClick={() => {
              setQuery("");
              setSelection({ type: "location", id: o.id ?? "" });
            }}
            trailing={
              (o.cartons ?? 0) > 0 ? (
                <span className="text-amber-400">{o.cartons} ctns</span>
              ) : (o.units ?? 0) !== 0 ? (
                <span className={cn((o.units ?? 0) < 0 && "text-amber-400")}>{(o.units ?? 0).toLocaleString()}</span>
              ) : (
                "—"
              )
            }
          >
            {o.code}
          </ListButton>
        ))}
      </Card>

      <Card className="flex min-w-0 flex-1 flex-col overflow-hidden p-0">
        <div className="flex flex-wrap items-center gap-2.5 border-b border-border/50 px-4 py-3">
          <div className="relative w-full sm:w-[240px]">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="SKU, location or carton"
              aria-label="Search locations"
              className="h-9 pl-8"
            />
          </div>
          <Select value={zone} onValueChange={setZone}>
            <SelectTrigger className="h-9 w-[140px]" aria-label="Zone">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All zones</SelectItem>
              {zones.map((z) => (
                <SelectItem key={z} value={z}>
                  {z}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {heading && (
            <span className="ml-auto text-xs text-muted-foreground tabular-nums">
              {heading} · {tableRows.length} location{tableRows.length === 1 ? "" : "s"} · {units.toLocaleString()} units ·{" "}
              {cartons.toLocaleString()} cartons
            </span>
          )}
        </div>

        {error ? (
          <p className="px-4 py-10 text-center text-sm text-muted-foreground">
            Couldn't load locations: {error instanceof Error ? error.message : "unknown error"}
          </p>
        ) : !isLoading && !hasRacks && !activeOther && !q ? (
          <div className="flex flex-col items-center gap-2 px-4 py-14 text-center">
            <MapPin className="h-6 w-6 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              No rack locations yet. Import the layout in{" "}
              <Link to="/settings?tab=warehouse" className="text-primary hover:underline">
                Settings › Warehouse
              </Link>
              .
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="border-b border-border/50 text-left text-xs uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Location</th>
                  <th className="px-4 py-2.5 font-medium">Level</th>
                  <th className="px-4 py-2.5 font-medium">What is here</th>
                  <th className="px-4 py-2.5 text-right font-medium">Units</th>
                  <th className="px-4 py-2.5 font-medium">Cartons</th>
                  <th className="px-4 py-2.5 font-medium">Fill</th>
                  <th className="px-4 py-2.5 font-medium">Last count</th>
                </tr>
              </thead>
              <tbody>
                {isLoading ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">
                      Loading…
                    </td>
                  </tr>
                ) : tableRows.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">
                      {q ? "Nothing matches that search." : "No locations here."}
                    </td>
                  </tr>
                ) : (
                  tableRows.map((r) => (
                    <tr key={r.id} className="border-b border-border/50 align-middle last:border-0">
                      <td className="whitespace-nowrap px-4 py-2 font-semibold tabular-nums">
                        {r.code && r.kind !== "virtual" ? (
                          <Link
                            to={`/inventory/stock?${new URLSearchParams({ view: "map", loc: r.code }).toString()}`}
                            className="hover:text-primary hover:underline"
                            title="Show on the map"
                          >
                            {r.code}
                          </Link>
                        ) : (
                          r.code
                        )}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2 text-muted-foreground">{levelLabel(r)}</td>
                      <td className="px-4 py-2">
                        {r.contents.length === 0 ? (
                          <span className="text-xs text-muted-foreground">Empty</span>
                        ) : (
                          <div className="flex flex-wrap gap-1.5">
                            {r.contents.map((c, i) => (
                              <ContentChip key={`${c.container_id ?? "loose"}-${c.sku_id}-${c.bucket}-${i}`} item={c} />
                            ))}
                          </div>
                        )}
                      </td>
                      <td className={cn("px-4 py-2 text-right tabular-nums", (r.units ?? 0) < 0 && "text-amber-400")}>
                        {(r.units ?? 0).toLocaleString()}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2 tabular-nums text-muted-foreground">{cartonStates(r.contents)}</td>
                      <td className="px-4 py-2">
                        <FillBar cartons={r.cartons ?? 0} capacity={r.capacity_cartons} />
                      </td>
                      <td className="whitespace-nowrap px-4 py-2 text-xs text-muted-foreground">
                        {r.last_counted_at ? format(parseISO(r.last_counted_at), "MMM d") : "—"}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
