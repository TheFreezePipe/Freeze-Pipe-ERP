import { lazy, Suspense, useCallback, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ClipboardCheck, Loader2, MapPin, Pencil, Printer, Route, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth-context";
import { getEffectiveDemand } from "@/lib/demand";
import {
  useForecastDemandMap,
  useWhCreateCount,
  useWhContainers,
  useWhLayout,
  useWhLocationExtras,
  useWhLocations,
  useWhSkuIndex,
  type WhLocationSummary,
} from "@/lib/hooks";
import {
  MAP_LEVELS,
  MAP_MODE_LABELS,
  MAP_MODES,
  facesInWalkOrder,
  heatByLocation,
  parseMapLevel,
  parseMapMode,
  searchLocations,
  type MapLevel,
  type MapMode,
} from "@/lib/warehouse/map-modes";
import { LocationDrawer } from "@/components/warehouse/LocationDrawer";
import { WhFind } from "@/components/warehouse/WhFind";
import { FloorPlan, MapLegend } from "./FloorPlan";
import { RackElevation } from "./RackElevation";

/**
 * Stock › Map (design §9.1, §9.3). Everything lives in the URL:
 *   view=map, mode=browse|stock|counted|heat, level=1|2|3|all, q=<search>,
 *   loc=<location code> (the drawer), fx=<fixture id> (a fixture with no
 *   location, e.g. the gaylord spot), walk=1 (the pick_sequence path),
 *   rack=<R07> or face=<03> (the elevation instead of the plan).
 */

const MODE_NOTES: Record<MapMode, string> = {
  browse: "Zones by colour; pick faces brighter, overflow hatched.",
  stock: "Cartons against each bin's capacity; empty bins outlined.",
  counted: "Days since each bin was last counted.",
  heat: "Units of 30-day demand per SKU, split across the pick bins holding it (all its bins when it has no pick bin).",
};

const LabelSheet = lazy(() => import("@/components/warehouse/LabelSheet"));

/** The elevation's face actions: print every label of the face, count the whole face. */
function FaceActions({ rows }: { rows: WhLocationSummary[] }) {
  const { toast } = useToast();
  const { hasRole } = useAuth();
  const createCount = useWhCreateCount();
  const [printing, setPrinting] = useState(false);
  const ids = rows.map((r) => r.id).filter((id): id is string => !!id);
  const face = rows[0]?.face ?? "";
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setPrinting(true)} disabled={ids.length === 0}>
        <Printer className="mr-1.5 h-4 w-4" /> Print {ids.length} labels
      </Button>
      {hasRole("admin", "manager") && (
        <Button
          variant="outline"
          size="sm"
          disabled={ids.length === 0 || createCount.isPending}
          onClick={() =>
            createCount.mutate(
              { locationIds: ids, kind: "ad_hoc", reason: `Count face ${face} from the map` },
              {
                onSuccess: (res) =>
                  toast({
                    title: `${res.created.length} count task${res.created.length === 1 ? "" : "s"} created for face ${face}`,
                    description: res.existing.length ? `${res.existing.length} already had an open count.` : undefined,
                  }),
                onError: (err) =>
                  toast({ title: "Couldn't create the counts", description: err instanceof Error ? err.message : "Unknown error", variant: "destructive" }),
              },
            )
          }
        >
          <ClipboardCheck className="mr-1.5 h-4 w-4" /> Count this face
        </Button>
      )}
      {printing && (
        <Suspense fallback={null}>
          <LabelSheet
            open
            onOpenChange={(o) => {
              if (!o) setPrinting(false);
            }}
            kind="location"
            ids={ids}
            title={`${ids.length} location labels, face ${face}`}
          />
        </Suspense>
      )}
    </>
  );
}

function useMapParams() {
  const [params, setParams] = useSearchParams();
  const set = useCallback(
    (patch: Record<string, string | null>) =>
      setParams(
        (prev) => {
          const sp = new URLSearchParams(prev);
          for (const [k, v] of Object.entries(patch)) {
            if (v == null || v === "") sp.delete(k);
            else sp.set(k, v);
          }
          return sp;
        },
        { replace: true },
      ),
    [setParams],
  );
  return [params, set] as const;
}

export function StockMap() {
  const [params, set] = useMapParams();
  const mode = parseMapMode(params.get("mode"));
  const level = parseMapLevel(params.get("level"));
  const q = params.get("q") ?? "";
  const loc = params.get("loc");
  const fx = params.get("fx");
  const walk = params.get("walk") === "1";
  const rackParam = params.get("rack");
  const faceParam = params.get("face");
  const { hasRole } = useAuth();

  const { data: layout, isLoading: layoutLoading, error: layoutError } = useWhLayout();
  const { data: locations = [], isLoading: locLoading, error: locError } = useWhLocations();
  const { data: extras } = useWhLocationExtras();
  const { data: containers = [] } = useWhContainers();
  const { data: skus = [] } = useWhSkuIndex();
  const forecastMap = useForecastDemandMap();

  const search = useMemo(() => searchLocations(locations, containers, q), [locations, containers, q]);

  const heat = useMemo(() => {
    if (mode !== "heat") return null;
    const demand = new Map<string, number>();
    for (const s of skus) demand.set(s.id, getEffectiveDemand(s.id, s.monthly_demand, forecastMap));
    return heatByLocation(locations, demand);
  }, [mode, skus, forecastMap, locations]);

  // rack=R07 opens that rack's first face in walk order; face= wins.
  const elevationFace = useMemo(() => {
    if (faceParam) return faceParam;
    if (!rackParam || !layout) return null;
    const rack = layout.racks.find((r) => r.code.toUpperCase() === rackParam.toUpperCase());
    if (!rack) return null;
    const codes = new Set(layout.faces.filter((f) => f.rack_id === rack.id).map((f) => f.face_code));
    return facesInWalkOrder(locations).find((f) => codes.has(f.face))?.face ?? [...codes][0] ?? null;
  }, [faceParam, rackParam, layout, locations]);

  const capacityKnown = locations.some((l) => l.kind === "bay_level" && l.capacity_cartons != null);
  const hasRacks = (layout?.racks.length ?? 0) > 0;
  const loading = layoutLoading || locLoading;
  const error = layoutError ?? locError;

  const selectLocation = (code: string) => set({ loc: code, fx: null });

  let notice: string | null = null;
  if (mode === "heat" && heat && heat.stockedBins === 0) notice = "No bin holds stock yet, so there is no demand to place on the plan.";
  else if (mode === "heat" && heat && heat.byLocation.size === 0) notice = "None of the SKUs on the shelves has 30-day demand.";
  else if (mode === "stock" && !locations.some((l) => (l.cartons ?? 0) > 0 || (l.units ?? 0) !== 0)) notice = "Every bin is empty.";

  return (
    <div className="space-y-3">
      <Card className="flex flex-wrap items-center gap-2 p-2.5">
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={mode}
          onValueChange={(v) => v && set({ mode: v === "browse" ? null : v })}
          aria-label="Map mode"
        >
          {MAP_MODES.map((m) => (
            <ToggleGroupItem key={m} value={m} className="px-3 data-[state=on]:bg-primary/15 data-[state=on]:text-primary">
              {MAP_MODE_LABELS[m]}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={level}
          onValueChange={(v) => v && set({ level: v === "all" ? null : (v as MapLevel) })}
          aria-label="Level"
        >
          {MAP_LEVELS.map((l) => (
            <ToggleGroupItem key={l} value={l} className="min-w-9 data-[state=on]:bg-primary/15 data-[state=on]:text-primary" aria-label={l === "all" ? "All levels" : `Level ${l}`}>
              {l === "all" ? "All" : l}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={elevationFace ? "elevation" : "plan"}
          onValueChange={(v) => {
            if (v === "plan") set({ face: null, rack: null });
            else if (v === "elevation") {
              const fromLoc = loc ? locations.find((l) => l.code === loc && l.kind === "bay_level")?.face : null;
              set({ face: fromLoc ?? facesInWalkOrder(locations)[0]?.face ?? null, rack: null });
            }
          }}
          aria-label="Plan or elevation"
        >
          <ToggleGroupItem value="plan" className="px-3 data-[state=on]:bg-primary/15 data-[state=on]:text-primary">
            Plan
          </ToggleGroupItem>
          <ToggleGroupItem value="elevation" className="px-3 data-[state=on]:bg-primary/15 data-[state=on]:text-primary">
            Elevation
          </ToggleGroupItem>
        </ToggleGroup>
        <Button
          type="button"
          size="sm"
          variant={walk ? "secondary" : "outline"}
          onClick={() => set({ walk: walk ? null : "1" })}
          aria-pressed={walk}
          title="Draw the pick walk (pick_sequence)"
        >
          <Route className="mr-1.5 h-4 w-4" /> Walk
        </Button>
        {/* Find (Ctrl K) is the one way to highlight: the typed box it duplicated was removed 2026-10-29. The active query stays as a chip. */}
        <WhFind onJump={(j) => set({ q: j.q, loc: j.loc, fx: null })} />
        {q && (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/40 py-0.5 pl-2.5 pr-1 text-xs text-muted-foreground">
            <span className="font-mono font-medium text-foreground">{q}</span>
            <span className="tabular-nums">
              {search.ids.size === 0
                ? "no match"
                : `${search.ids.size} bin${search.ids.size === 1 ? "" : "s"} · ${search.units.toLocaleString()} units · ${search.cartons} carton${search.cartons === 1 ? "" : "s"}${search.match === "partial" ? " · partial match" : ""}`}
            </span>
            <button
              type="button"
              className="rounded p-0.5 hover:text-foreground"
              onClick={() => set({ q: null })}
              aria-label="Clear the highlight"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        )}
        {hasRole("admin") && (
          <Button asChild size="sm" variant="ghost" className="ml-auto">
            <Link to="/settings?tab=warehouse&edit=layout">
              <Pencil className="mr-1.5 h-4 w-4" /> Edit layout
            </Link>
          </Button>
        )}
      </Card>

      {error ? (
        <Card className="p-10 text-center text-sm text-muted-foreground">
          Couldn't load the layout: {error instanceof Error ? error.message : "unknown error"}
        </Card>
      ) : loading ? (
        <Card className="flex items-center justify-center gap-2 p-16 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading the plan…
        </Card>
      ) : !hasRacks ? (
        <Card className="flex flex-col items-center gap-2 p-14 text-center">
          <MapPin className="h-6 w-6 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            No layout yet. Import it in{" "}
            <Link to="/settings?tab=warehouse" className="text-primary hover:underline">
              Settings › Warehouse
            </Link>
            .
          </p>
        </Card>
      ) : elevationFace ? (
        <RackElevation
          layout={layout}
          locations={locations}
          face={elevationFace}
          highlightIds={search.ids}
          selectedCode={loc}
          onSelectLocation={selectLocation}
          onFaceChange={(face) => set({ face, rack: null })}
          onBack={() => set({ face: null, rack: null })}
          actions={(rows) => <FaceActions rows={rows} />}
        />
      ) : (
        <>
          <div className="h-[calc(100dvh-270px)] min-h-[460px]">
            {layout && (
              <FloorPlan
                layout={layout}
                locations={locations}
                extras={extras}
                mode={mode}
                level={level}
                highlightIds={search.ids}
                selectedCode={loc}
                selectedFixtureId={fx}
                showWalk={walk}
                heat={heat}
                onSelectLocation={selectLocation}
                onSelectFixture={(id) => set({ fx: id, loc: null })}
                overlay={
                  notice ? (
                    <p className="rounded-md border border-border bg-popover/95 px-2.5 py-1.5 text-xs text-muted-foreground">{notice}</p>
                  ) : undefined
                }
              />
            )}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <MapLegend mode={mode} heatMax={heat?.max} capacityKnown={capacityKnown} />
            <p className="text-[11px] text-muted-foreground">
              {MODE_NOTES[mode]} {level === "all" ? "All levels per bay." : `Level ${level} only.`} Tap a bay for its drawer; scroll or pinch to zoom.
            </p>
          </div>
        </>
      )}

      <LocationDrawer
        code={loc}
        fixtureId={fx}
        locations={locations}
        layout={layout}
        onClose={() => set({ loc: null, fx: null })}
        onSelectLocation={selectLocation}
        onRackView={(face) => set({ face, rack: null })}
      />
    </div>
  );
}
