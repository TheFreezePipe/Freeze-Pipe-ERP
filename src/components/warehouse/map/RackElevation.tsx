import { useMemo, type ReactNode } from "react";
import { ArrowLeft, ChevronLeft, ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { WhLayout, WhLocationContent, WhLocationSummary } from "@/lib/hooks";
import { WH_ZONE_COLORS } from "@/lib/status-colors";
import { facesInWalkOrder } from "@/lib/warehouse/map-modes";
import { cn } from "@/lib/utils";

/**
 * RackElevation (design §9.3): the front view of one face, levels × bays,
 * as a picker standing in the aisle sees it (bay 01 on the left, the top
 * level on top). Each cell lists its SKUs with carton counts from
 * wh_location_summary; overflow levels are hatched. Prev / next walk the
 * faces in walk order; a cell opens the location drawer.
 */

interface RackElevationProps {
  layout: WhLayout | undefined;
  locations: WhLocationSummary[];
  face: string;
  highlightIds?: Set<string>;
  selectedCode?: string | null;
  onSelectLocation: (code: string) => void;
  onFaceChange: (face: string) => void;
  onBack: () => void;
  /** Face-level actions (print the face's labels, count it), drawn in the header. */
  actions?: (rows: WhLocationSummary[]) => ReactNode;
}

const DIR_WORDS: Record<string, string> = { N: "walks north", S: "walks south", E: "walks east", W: "walks west" };

interface SkuChip {
  sku: string;
  cartons: number;
  sealed: number;
  units: number;
  loose: number;
}

/** Contents grouped by SKU: cartons (sealed of them), units, loose units. */
function skuChips(contents: WhLocationContent[]): SkuChip[] {
  const by = new Map<string, SkuChip & { ids: Set<string>; sealedIds: Set<string> }>();
  for (const c of contents) {
    const e = by.get(c.sku) ?? { sku: c.sku, cartons: 0, sealed: 0, units: 0, loose: 0, ids: new Set<string>(), sealedIds: new Set<string>() };
    e.units += c.qty;
    if (c.container_id) {
      e.ids.add(c.container_id);
      if (c.state === "sealed") e.sealedIds.add(c.container_id);
    } else e.loose += c.qty;
    by.set(c.sku, e);
  }
  return [...by.values()]
    .map(({ ids, sealedIds, ...rest }) => ({ ...rest, cartons: ids.size, sealed: sealedIds.size }))
    .sort((a, b) => b.units - a.units || a.sku.localeCompare(b.sku));
}

export function RackElevation({
  layout,
  locations,
  face,
  highlightIds,
  selectedCode,
  onSelectLocation,
  onFaceChange,
  onBack,
  actions,
}: RackElevationProps) {
  const faces = useMemo(() => facesInWalkOrder(locations), [locations]);
  const idx = faces.findIndex((f) => f.face === face);
  const current = idx >= 0 ? faces[idx] : undefined;
  const prev = idx > 0 ? faces[idx - 1] : undefined;
  const next = idx >= 0 && idx < faces.length - 1 ? faces[idx + 1] : undefined;

  const rows = useMemo(() => current?.rows ?? [], [current]);
  const bays = useMemo(() => [...new Set(rows.map((r) => r.bay ?? 0))].sort((a, b) => a - b), [rows]);
  const levels = useMemo(() => [...new Set(rows.map((r) => r.level ?? 0))].sort((a, b) => b - a), [rows]);
  const at = (bay: number, level: number) => rows.find((r) => r.bay === bay && r.level === level);

  const faceRows = (layout?.faces ?? []).filter((f) => f.face_code === face);
  const rackCodes = faceRows
    .map((f) => layout?.racks.find((r) => r.id === f.rack_id)?.code)
    .filter(Boolean)
    .join(" + ");
  const meta = faceRows[0];
  const seqs = rows.map((r) => r.pick_sequence).filter((s): s is number => s != null);
  const lit = highlightIds && rows.some((r) => r.id && highlightIds.has(r.id));
  const units = rows.reduce((s, r) => s + (r.units ?? 0), 0);
  const cartons = rows.reduce((s, r) => s + (r.cartons ?? 0), 0);

  if (!current) {
    return (
      <Card className="flex flex-col items-center gap-3 p-10 text-center">
        <p className="text-sm text-muted-foreground">There is no face {face} on the plan.</p>
        <Button variant="outline" onClick={onBack}>
          <ArrowLeft className="mr-1.5 h-4 w-4" /> Back to the plan
        </Button>
      </Card>
    );
  }

  return (
    <Card className="flex min-w-0 flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="ghost" size="sm" onClick={onBack} className="-ml-2">
          <ArrowLeft className="mr-1.5 h-4 w-4" /> Plan
        </Button>
        <div className="min-w-0">
          <h2 className="text-lg font-semibold">
            Face {face}
            {rackCodes && <span className="font-normal text-muted-foreground"> · {rackCodes}</span>}
          </h2>
          <p className="text-xs text-muted-foreground">
            {[
              meta?.aisle ? `Aisle ${meta.aisle}` : null,
              `bays ${String(bays[0]).padStart(2, "0")}–${String(bays[bays.length - 1]).padStart(2, "0")}`,
              meta?.side ? `${meta.side} side` : null,
              meta?.walk_dir ? DIR_WORDS[meta.walk_dir] : "not routed",
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        <span className="text-xs tabular-nums text-muted-foreground">
          {units.toLocaleString()} units · {cartons} cartons
        </span>
        {lit && <Badge className="border-amber-400/40 bg-amber-400/10 text-amber-400" variant="outline">Search match</Badge>}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {actions?.(rows)}
          <Button variant="outline" size="sm" disabled={!prev} onClick={() => prev && onFaceChange(prev.face)} aria-label="Previous face">
            <ChevronLeft className="mr-1 h-4 w-4" />
            {prev ? prev.face : "—"}
          </Button>
          <Button variant="outline" size="sm" disabled={!next} onClick={() => next && onFaceChange(next.face)} aria-label="Next face">
            {next ? next.face : "—"}
            <ChevronRight className="ml-1 h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="overflow-x-auto">
        <div
          className="grid min-w-max gap-2"
          style={{ gridTemplateColumns: `76px repeat(${bays.length}, minmax(150px, 1fr))` }}
          role="grid"
          aria-label={`Face ${face} elevation`}
        >
          <div />
          {bays.map((b) => (
            <div key={b} className="px-1 text-center text-xs font-medium text-muted-foreground">
              Bay {String(b).padStart(2, "0")}
            </div>
          ))}
          {levels.map((lvl) => {
            const sample = rows.find((r) => r.level === lvl);
            const z = sample?.z_mm;
            return (
              <div key={lvl} className="contents" role="row">
                <div className="flex flex-col items-end justify-center border-r-2 border-border pr-2 text-right text-xs text-muted-foreground">
                  <span className="font-medium text-foreground/80">Level {lvl}</span>
                  <span>{lvl === 1 ? "floor" : z != null ? `${(z / 1000).toFixed(2)} m` : ""}</span>
                  {sample?.is_overflow && <span className="text-amber-400/90">overflow</span>}
                </div>
                {bays.map((b) => {
                  const loc = at(b, lvl);
                  if (!loc) {
                    return <div key={b} className="rounded-md border border-dashed border-border/40" role="gridcell" aria-label="No location" />;
                  }
                  const chips = skuChips(loc.contents);
                  const isSel = selectedCode === loc.code;
                  const isLit = !!(loc.id && highlightIds?.has(loc.id));
                  const cap = loc.capacity_cartons;
                  return (
                    <button
                      key={b}
                      type="button"
                      role="gridcell"
                      onClick={() => loc.code && onSelectLocation(loc.code)}
                      className={cn(
                        "relative flex min-h-[112px] flex-col gap-1.5 rounded-md border bg-card/60 p-2.5 text-left transition-colors hover:border-primary/60",
                        loc.is_overflow && "bg-[repeating-linear-gradient(45deg,rgba(255,255,255,0.035)_0_6px,transparent_6px_12px)]",
                        isLit && "border-amber-400 bg-amber-400/10",
                        isSel && "border-red-400 ring-1 ring-red-400",
                        !isLit && !isSel && "border-border/70",
                      )}
                    >
                      <span className="flex items-center gap-1.5">
                        <span className="text-sm font-bold tabular-nums tracking-wide">{loc.code}</span>
                        {loc.pickable && <span className="rounded-full border border-green-500/30 bg-green-500/10 px-1.5 text-[10px] font-semibold text-green-400">pick</span>}
                        {loc.is_overflow && <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-1.5 text-[10px] font-semibold text-amber-400">overflow</span>}
                        <span className={cn("ml-auto rounded-full border px-1.5 text-[10px]", WH_ZONE_COLORS[loc.zone ?? ""] ?? "")}>{loc.zone}</span>
                      </span>
                      <span className="text-[11px] tabular-nums text-muted-foreground">
                        {(loc.units ?? 0) === 0 && (loc.cartons ?? 0) === 0
                          ? "Empty"
                          : `${(loc.units ?? 0).toLocaleString()} units · ${loc.cartons ?? 0} ctn${cap ? ` of ${cap}` : ""}`}
                      </span>
                      <span className="mt-auto flex flex-wrap gap-1">
                        {chips.slice(0, 4).map((c) => (
                          <span
                            key={c.sku}
                            className="inline-flex items-center gap-1 whitespace-nowrap rounded border border-border/70 bg-background/60 px-1.5 py-0.5 text-[11px] tabular-nums"
                            title={`${c.sku}: ${c.cartons} carton${c.cartons === 1 ? "" : "s"} (${c.sealed} sealed), ${c.units} units${c.loose ? `, ${c.loose} loose` : ""}`}
                          >
                            <span className="font-semibold">{c.sku}</span>
                            <span className="text-muted-foreground">
                              {c.cartons > 0 ? `${c.cartons} ctn · ${c.units}` : `${c.loose} loose`}
                            </span>
                          </span>
                        ))}
                        {chips.length > 4 && <span className="text-[11px] text-muted-foreground">+{chips.length - 4} more</span>}
                      </span>
                      {cap ? (
                        <span className="block h-1 overflow-hidden rounded-full bg-muted" aria-hidden>
                          <span
                            className={cn("block h-full rounded-full", (loc.cartons ?? 0) > cap ? "bg-amber-400" : "bg-primary")}
                            style={{ width: `${Math.min(100, ((loc.cartons ?? 0) / cap) * 100)}%` }}
                          />
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        <span className="mr-3 inline-flex items-center gap-1">
          <span className="inline-block h-2.5 w-2.5 rounded-sm border border-green-500/40 bg-green-500/20" /> pick face
        </span>
        <span className="mr-3 inline-flex items-center gap-1">
          <span className="inline-block h-2.5 w-2.5 rounded-sm border border-border bg-[repeating-linear-gradient(45deg,rgba(255,255,255,0.25)_0_2px,transparent_2px_4px)]" /> overflow
          (sealed cartons)
        </span>
        {seqs.length > 0 && (
          <>
            Walk order through this face: {Math.min(...seqs)} → {Math.max(...seqs)}
            {meta?.walk_dir ? ` (bay ${String(bays[0]).padStart(2, "0")} first)` : ""}.
          </>
        )}{" "}
        Click a location for its drawer.
      </p>
    </Card>
  );
}
