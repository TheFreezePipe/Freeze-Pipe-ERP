import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { Maximize2, Minus, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { WhLayout, WhLocationExtra, WhLocationSummary } from "@/lib/hooks";
import { WH_ZONE_FILLS } from "@/lib/status-colors";
import {
  bayCells,
  buildingRect,
  centeredRect,
  clampViewBox,
  fitViewBox,
  fixtureRect,
  matchAspect,
  panViewBox,
  pxToMm,
  rackRect,
  snapMm,
  templateFor,
  unionRect,
  walkPath,
  zoomViewBox,
  type BayCell,
  type Point,
  type Rect,
  type ViewBox,
} from "@/lib/warehouse/map-geometry";
import {
  COUNT_BUCKETS,
  countBucket,
  heatColor,
  indexByBay,
  oldestCountDays,
  rowsForLevel,
  stockFill,
  stockRatio,
  type HeatResult,
  type MapLevel,
  type MapMode,
} from "@/lib/warehouse/map-modes";
import { cn } from "@/lib/utils";

/**
 * FloorPlan (design §9.3): the warehouse in plan, drawn in millimetres as
 * one SVG. Building outline, racks with one cell per bay (the chosen level's
 * contents, or every level), fixtures by kind (blocked ones hatched), named
 * floor locations, rack and face codes, the walk path when asked. Modes
 * paint the cells (map-modes.ts). Wheel or pinch zooms about the pointer,
 * dragging pans, a tap selects; Fit returns to the whole plan.
 *
 * With `edit`, racks and fixtures select and drag on a 100 mm snap instead
 * (the layout editor's canvas), and palette items can be dropped on it.
 */

export type EditTarget = { type: "rack" | "fixture"; id: string };

export interface FloorPlanEdit {
  selected: EditTarget | null;
  onSelect: (target: EditTarget | null) => void;
  /** A drag is about to move the target (the editor records undo here). */
  onDragStart: (target: EditTarget) => void;
  /** The target's new top-left corner, snapped to 100 mm. */
  onDrag: (target: EditTarget, xMm: number, yMm: number) => void;
  /** HTML5 drag data dropped from the palette, and where. */
  onDrop?: (data: string, at: Point) => void;
}

export const PALETTE_MIME = "application/x-wh-palette";

interface FloorPlanProps {
  layout: WhLayout;
  locations: WhLocationSummary[];
  /** Footprints of named locations (the summary view has only their centre). */
  extras?: Map<string, WhLocationExtra>;
  mode?: MapMode;
  level?: MapLevel;
  /** Location ids lit by the search. */
  highlightIds?: Set<string>;
  selectedCode?: string | null;
  selectedFixtureId?: string | null;
  showWalk?: boolean;
  heat?: HeatResult | null;
  onSelectLocation?: (code: string) => void;
  onSelectFixture?: (fixtureId: string) => void;
  edit?: FloorPlanEdit;
  className?: string;
  /** Drawn over the plan's top-left corner (legends, notes). */
  overlay?: ReactNode;
}

type Hit =
  | { kind: "cell"; key: string }
  | { kind: "loc"; code: string }
  | { kind: "fx"; id: string }
  | { kind: "rack"; id: string };

function parseHit(target: EventTarget | null): Hit | null {
  const el = target instanceof Element ? target.closest("[data-hit]") : null;
  const raw = el?.getAttribute("data-hit");
  if (!raw) return null;
  const i = raw.indexOf(":");
  const kind = raw.slice(0, i);
  const value = raw.slice(i + 1);
  if (kind === "cell") return { kind, key: value };
  if (kind === "loc") return { kind, code: value };
  if (kind === "fx") return { kind, id: value };
  if (kind === "rack") return { kind, id: value };
  return null;
}

const sameHit = (a: Hit | null, b: Hit | null) => JSON.stringify(a) === JSON.stringify(b);

interface Gesture {
  pointers: Map<number, Point>;
  startPx: Point;
  startVb: ViewBox;
  moved: boolean;
  hit: Hit | null;
  drag: { target: EditTarget; originX: number; originY: number; startMm: Point; started: boolean } | null;
  pinch: { startDist: number; startVb: ViewBox; mid: Point } | null;
}

const COLORS = {
  floor: "#161616",
  wall: "#5a5a5a",
  rack: "#222222",
  rackStroke: "#3a3a3a",
  cellStroke: "#333333",
  label: "#9a9a9a",
  labelStrong: "#d4d4d4",
  highlight: "#fbbf24",
  selected: "#f87171",
  editSelected: "#2f97f2",
  walk: "#5cb0f6",
  empty: "#525252",
  stock: "#2f97f2",
  over: "#f59e0b",
};

const FIXTURE_STYLE: Record<string, { fill: string; opacity: number; stroke: string; dash?: string }> = {
  door: { fill: "#2f97f2", opacity: 0.35, stroke: "#5cb0f6" },
  pack_station: { fill: "#14b8a6", opacity: 0.22, stroke: "#2dd4bf" },
  desk: { fill: "#fb7185", opacity: 0.16, stroke: "#fb7185" },
  staging: { fill: "#a3a3a3", opacity: 0.06, stroke: "#8a8a8a", dash: "6 4" },
  obstacle: { fill: "#52525b", opacity: 0.55, stroke: "#71717a" },
  other: { fill: "#a3a3a3", opacity: 0.08, stroke: "#6b6b6b" },
};

const ARROW: Record<string, string> = { N: "↑", S: "↓", E: "→", W: "←" };

interface Paint {
  fill: string;
  opacity: number;
  stroke: string;
  dash?: string;
  hatch?: boolean;
  /** Short text drawn in the cell when it is big enough. */
  value?: string;
}

/** Zoom limits: 1.5 m wide at the closest, 2.5 plans at the farthest. */
const clampOpts = (b: Rect) => ({ minW: 1500, maxW: Math.max(b.w, b.h) * 2.5 });

/** Live values the gesture handlers read (kept current by an effect). */
interface Live {
  vb: ViewBox;
  size: { width: number; height: number };
  bounds: Rect;
}

export function FloorPlan({
  layout,
  locations,
  extras,
  mode = "browse",
  level = "all",
  highlightIds,
  selectedCode,
  selectedFixtureId,
  showWalk,
  heat,
  onSelectLocation,
  onSelectFixture,
  edit,
  className,
  overlay,
}: FloorPlanProps) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [userVb, setUserVb] = useState<ViewBox | null>(null);
  const [hover, setHover] = useState<Hit | null>(null);
  const [now] = useState(() => Date.now());
  const gesture = useRef<Gesture | null>(null);

  // ---- geometry -------------------------------------------------------------
  const cells = useMemo(() => bayCells(layout), [layout]);
  const byBay = useMemo(() => indexByBay(locations), [locations]);
  const named = useMemo(
    () =>
      locations
        .filter((l) => l.kind !== "bay_level" && l.active !== false && l.code)
        .map((l) => {
          const ex = l.id ? extras?.get(l.id) : undefined;
          return { row: l, rect: centeredRect(l.x_mm, l.y_mm, ex?.width_mm, ex?.depth_mm) };
        })
        .filter((n): n is { row: WhLocationSummary; rect: Rect } => n.rect != null),
    [locations, extras],
  );
  const locationById = useMemo(() => new Map(locations.filter((l) => l.id).map((l) => [l.id as string, l])), [locations]);
  const building = useMemo(() => buildingRect(layout, named.map((n) => n.rect)), [layout, named]);
  const bounds = useMemo(
    () => unionRect([building, ...layout.fixtures.map(fixtureRect)]) ?? building,
    [building, layout.fixtures],
  );
  const aspect = size.width > 0 && size.height > 0 ? size.width / size.height : 0.6;
  const fitted = useMemo(() => fitViewBox(bounds, aspect), [bounds, aspect]);
  const vb = userVb ? matchAspect(userVb, aspect) : fitted;
  const mmPerPx = size.width > 0 ? vb.w / size.width : 40;
  const fs = (px: number) => px * mmPerPx;

  const live = useRef<Live>({ vb, size, bounds });
  useEffect(() => {
    live.current = { vb, size, bounds };
  });

  // ---- viewport -------------------------------------------------------------
  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r) setSize({ width: r.width, height: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const { vb: v, size: s, bounds: b } = live.current;
      const r = el.getBoundingClientRect();
      const p = pxToMm(v, s, { x: e.clientX - r.left, y: e.clientY - r.top });
      const factor = Math.exp(-e.deltaY * 0.0015);
      setUserVb(clampViewBox(zoomViewBox(v, factor, p), b, clampOpts(b)));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  function zoomBy(factor: number) {
    setUserVb(clampViewBox(zoomViewBox(vb, factor), bounds, clampOpts(bounds)));
  }

  // ---- data per cell --------------------------------------------------------
  const maxCartons = useMemo(() => {
    let m = 0;
    for (const rows of byBay.values()) m = Math.max(m, stockFill(rowsForLevel(rows, level)).cartons);
    return m;
  }, [byBay, level]);

  const searching = !!highlightIds && highlightIds.size > 0;

  function cellPaint(cell: BayCell): Paint {
    // The editor paints the draft's zones; saved locations may lag the draft.
    if (edit) return { fill: WH_ZONE_FILLS[cell.zone] ?? WH_ZONE_FILLS.MISC, opacity: 0.45, stroke: COLORS.cellStroke };
    const rows = byBay.get(cell.key);
    const shown = rowsForLevel(rows, level);
    if (shown.length === 0) return { fill: "#1b1b1b", opacity: 1, stroke: "#2a2a2a", dash: "3 3" };
    const overflowOnly = shown.every((r) => r.is_overflow);
    switch (mode) {
      case "stock": {
        const f = stockFill(shown);
        if (f.empty) return { fill: COLORS.floor, opacity: 1, stroke: COLORS.empty, dash: "4 3", hatch: overflowOnly, value: "" };
        const ratio = stockRatio(f, maxCartons);
        return {
          fill: f.over ? COLORS.over : COLORS.stock,
          opacity: 0.2 + 0.75 * ratio,
          stroke: COLORS.cellStroke,
          hatch: overflowOnly,
          value: f.cartons > 0 ? `${f.cartons}${f.capacity != null ? `/${f.capacity}` : ""}` : `${f.units}u`,
        };
      }
      case "counted": {
        const days = oldestCountDays(shown, new Date(now));
        const b = COUNT_BUCKETS.find((x) => x.bucket === countBucket(days)) ?? COUNT_BUCKETS[4];
        return { fill: b.fill, opacity: days == null ? 0.35 : 0.7, stroke: COLORS.cellStroke, hatch: days == null, value: days == null ? "—" : `${days}d` };
      }
      case "heat": {
        let v = 0;
        for (const r of shown) v += (r.id && heat?.byLocation.get(r.id)) || 0;
        const max = heat?.max ?? 0;
        if (v <= 0 || max <= 0) return { fill: "#1e293b", opacity: 0.6, stroke: COLORS.cellStroke, hatch: overflowOnly, value: "" };
        return { fill: heatColor(v / max), opacity: 0.9, stroke: COLORS.cellStroke, value: String(Math.round(v)) };
      }
      default: {
        const pickable = shown.some((r) => r.pickable);
        return {
          fill: WH_ZONE_FILLS[cell.zone] ?? WH_ZONE_FILLS.MISC,
          opacity: pickable ? 0.6 : overflowOnly ? 0.3 : 0.42,
          stroke: COLORS.cellStroke,
          hatch: overflowOnly,
          value: String(cell.bay).padStart(2, "0"),
        };
      }
    }
  }

  function namedPaint(row: WhLocationSummary): Paint {
    const zone = WH_ZONE_FILLS[row.zone ?? ""] ?? WH_ZONE_FILLS.MISC;
    if (mode === "stock") {
      const f = stockFill([row]);
      if (!f.empty) return { fill: COLORS.stock, opacity: 0.2 + 0.75 * stockRatio(f, maxCartons), stroke: COLORS.stock };
    }
    if (mode === "heat" && row.id && (heat?.byLocation.get(row.id) ?? 0) > 0 && (heat?.max ?? 0) > 0) {
      return { fill: heatColor((heat!.byLocation.get(row.id) ?? 0) / heat!.max), opacity: 0.8, stroke: zone };
    }
    return { fill: zone, opacity: 0.05, stroke: zone, dash: "5 4" };
  }

  /** The location a tap on a bay opens: the chosen level, else the first stocked level, else level 1. */
  function codeForCell(key: string): string | null {
    const rows = byBay.get(key) ?? [];
    if (rows.length === 0) return null;
    if (level !== "all") return rows.find((r) => String(r.level) === level)?.code ?? null;
    return (rows.find((r) => (r.units ?? 0) !== 0 || (r.cartons ?? 0) > 0) ?? rows[0]).code ?? null;
  }

  // ---- gestures -------------------------------------------------------------
  const localPx = (e: { clientX: number; clientY: number }): Point => {
    const r = containerRef.current?.getBoundingClientRect();
    return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
  };

  function itemOrigin(t: EditTarget): { x: number; y: number } | null {
    if (t.type === "rack") {
      const r = layout.racks.find((x) => x.id === t.id);
      return r ? { x: r.x_mm, y: r.y_mm } : null;
    }
    const f = layout.fixtures.find((x) => x.id === t.id);
    return f ? { x: f.x_mm, y: f.y_mm } : null;
  }

  function editTargetOf(hit: Hit | null): EditTarget | null {
    if (!hit) return null;
    if (hit.kind === "rack") return { type: "rack", id: hit.id };
    if (hit.kind === "cell") {
      const c = cells.find((x) => x.key === hit.key);
      return c ? { type: "rack", id: c.rackId } : null;
    }
    if (hit.kind === "fx") return { type: "fixture", id: hit.id };
    return null;
  }

  function onPointerDown(e: ReactPointerEvent<SVGSVGElement>) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const px = localPx(e);
    const g = gesture.current;
    if (!g) {
      const hit = parseHit(e.target);
      const target = edit ? editTargetOf(hit) : null;
      const origin = target ? itemOrigin(target) : null;
      gesture.current = {
        pointers: new Map([[e.pointerId, px]]),
        startPx: px,
        startVb: vb,
        moved: false,
        hit,
        drag: target && origin ? { target, originX: origin.x, originY: origin.y, startMm: pxToMm(vb, size, px), started: false } : null,
        pinch: null,
      };
      return;
    }
    g.pointers.set(e.pointerId, px);
    if (g.pointers.size === 2) {
      const [a, b] = [...g.pointers.values()];
      g.pinch = {
        startDist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
        startVb: vb,
        mid: pxToMm(vb, size, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }),
      };
      g.moved = true;
      g.drag = null;
    }
  }

  function onPointerMove(e: ReactPointerEvent<SVGSVGElement>) {
    const g = gesture.current;
    if (!g) {
      if (e.pointerType === "mouse") {
        const hit = parseHit(e.target);
        if (!sameHit(hit, hover)) setHover(hit);
      }
      return;
    }
    if (!g.pointers.has(e.pointerId)) return;
    const px = localPx(e);
    g.pointers.set(e.pointerId, px);
    if (g.pinch && g.pointers.size >= 2) {
      const [a, b] = [...g.pointers.values()];
      const dist = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
      setUserVb(clampViewBox(zoomViewBox(g.pinch.startVb, dist / g.pinch.startDist, g.pinch.mid), bounds, clampOpts(bounds)));
      return;
    }
    const dx = px.x - g.startPx.x;
    const dy = px.y - g.startPx.y;
    if (!g.moved && Math.hypot(dx, dy) > 4) {
      g.moved = true;
      if (hover) setHover(null);
    }
    if (!g.moved) return;
    if (g.drag && edit) {
      if (!g.drag.started) {
        g.drag.started = true;
        // pin the view: a fitted view would refit as the item moves the plan's bounds
        if (!userVb) setUserVb(g.startVb);
        edit.onDragStart(g.drag.target);
        edit.onSelect(g.drag.target);
      }
      const at = pxToMm(g.startVb, size, px);
      edit.onDrag(g.drag.target, snapMm(g.drag.originX + at.x - g.drag.startMm.x), snapMm(g.drag.originY + at.y - g.drag.startMm.y));
      return;
    }
    const sx = size.width > 0 ? g.startVb.w / size.width : 1;
    const sy = size.height > 0 ? g.startVb.h / size.height : 1;
    setUserVb(clampViewBox(panViewBox(g.startVb, -dx * sx, -dy * sy), bounds, clampOpts(bounds)));
  }

  function finishTap(hit: Hit | null) {
    if (edit) {
      edit.onSelect(editTargetOf(hit));
      return;
    }
    if (!hit) return;
    if (hit.kind === "cell") {
      const code = codeForCell(hit.key);
      if (code) onSelectLocation?.(code);
    } else if (hit.kind === "loc") {
      onSelectLocation?.(hit.code);
    } else if (hit.kind === "fx") {
      const fx = layout.fixtures.find((f) => f.id === hit.id);
      const loc = fx?.location_id ? locationById.get(fx.location_id) : undefined;
      if (loc?.code) onSelectLocation?.(loc.code);
      else onSelectFixture?.(hit.id);
    }
  }

  function onPointerUp(e: ReactPointerEvent<SVGSVGElement>) {
    const g = gesture.current;
    if (!g) return;
    g.pointers.delete(e.pointerId);
    if (g.pointers.size === 1) {
      // pinch ended: carry on panning from where the remaining finger is
      const [rest] = [...g.pointers.values()];
      g.pinch = null;
      g.startPx = rest;
      g.startVb = vb;
      return;
    }
    if (g.pointers.size > 0) return;
    gesture.current = null;
    if (!g.moved) finishTap(g.hit);
  }

  function onPointerCancel() {
    gesture.current = null;
  }

  function onKeyActivate(e: KeyboardEvent<SVGGElement>, hit: Hit) {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    finishTap(hit);
  }

  // ---- drawing helpers ------------------------------------------------------
  const nonScaling = { vectorEffect: "non-scaling-stroke" as const };
  const hatchId = `wh-hatch-${uid}`;
  const blockedId = `wh-blocked-${uid}`;
  const arrowId = `wh-arrow-${uid}`;
  const gridId = `wh-grid-${uid}`;
  const labelFs = fs(11);
  const smallFs = fs(9.5);
  const cellPx = (r: Rect) => Math.min(r.w, r.h) / mmPerPx;

  const faceLabels = useMemo(() => {
    const groups = new Map<string, BayCell[]>();
    for (const c of cells) {
      const k = `${c.faceId}`;
      const list = groups.get(k) ?? [];
      list.push(c);
      groups.set(k, list);
    }
    return [...groups.values()].map((list) => {
      const box = unionRect(list.map((c) => c.rect)) as Rect;
      return { face: list[0].face, edge: list[0].edge, walkDir: list[0].walkDir, box, key: list[0].faceId };
    });
  }, [cells]);

  const walk = useMemo(() => {
    if (!showWalk) return [];
    return walkPath(locations.filter((l) => l.kind === "bay_level" && l.active !== false));
  }, [showWalk, locations]);

  const selectedRow = selectedCode ? locations.find((l) => l.code === selectedCode) : undefined;

  // ---- hover tooltip --------------------------------------------------------
  const toPx = (p: Point): Point => ({ x: (p.x - vb.x) / mmPerPx, y: (p.y - vb.y) / mmPerPx });
  let tooltip: { at: Point; body: ReactNode } | null = null;
  if (hover && !edit) {
    if (hover.kind === "cell") {
      const cell = cells.find((c) => c.key === hover.key);
      if (cell) {
        const rows = byBay.get(cell.key) ?? [];
        const shown = rowsForLevel(rows, level);
        tooltip = {
          at: toPx({ x: cell.rect.x + cell.rect.w / 2, y: cell.rect.y }),
          body: (
            <>
              <p className="font-semibold">
                Bay {cell.key} · {cell.rackCode} · {cell.zone}
              </p>
              {shown.length === 0 && <p className="text-muted-foreground">No level {level} here</p>}
              {shown.map((r) => {
                const skus = [...new Set(r.contents.map((c) => c.sku))];
                return (
                  <p key={r.id} className="tabular-nums">
                    <span className="font-medium">{r.code}</span>
                    {r.is_overflow ? " · overflow" : r.pickable ? " · pick" : ""} · {r.cartons ?? 0} ctn · {r.units ?? 0} u
                    {skus.length > 0 && <span className="text-muted-foreground"> · {skus.slice(0, 3).join(", ")}{skus.length > 3 ? "…" : ""}</span>}
                  </p>
                );
              })}
            </>
          ),
        };
      }
    } else if (hover.kind === "fx") {
      const fx = layout.fixtures.find((f) => f.id === hover.id);
      if (fx) {
        const r = fixtureRect(fx);
        const loc = fx.location_id ? locationById.get(fx.location_id) : undefined;
        tooltip = {
          at: toPx({ x: r.x + r.w / 2, y: r.y }),
          body: (
            <>
              <p className="font-semibold">{fx.name}</p>
              <p className="text-muted-foreground">
                {fx.kind.replace("_", " ")}
                {fx.zone ? ` · ${fx.zone}` : ""}
                {loc?.code ? ` · ${loc.code}` : ""}
                {fx.blocked ? " · blocked" : ""}
              </p>
            </>
          ),
        };
      }
    } else if (hover.kind === "loc") {
      const n = named.find((x) => x.row.code === hover.code);
      if (n) {
        tooltip = {
          at: toPx({ x: n.rect.x + n.rect.w / 2, y: n.rect.y }),
          body: (
            <>
              <p className="font-semibold">
                {n.row.code}
                {n.row.name ? ` · ${n.row.name}` : ""}
              </p>
              <p className="text-muted-foreground tabular-nums">
                {n.row.cartons ?? 0} ctn · {n.row.units ?? 0} u
              </p>
            </>
          ),
        };
      }
    }
  }

  const grid = 1000;

  return (
    <div
      ref={containerRef}
      className={cn("relative h-full w-full select-none overflow-hidden rounded-md border border-border/60 bg-[#121212]", className)}
      style={{ touchAction: "none" }}
      onDragOver={(e) => {
        if (edit?.onDrop && e.dataTransfer.types.includes(PALETTE_MIME)) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        }
      }}
      onDrop={(e) => {
        if (!edit?.onDrop) return;
        const data = e.dataTransfer.getData(PALETTE_MIME);
        if (!data) return;
        e.preventDefault();
        edit.onDrop(data, pxToMm(vb, size, localPx(e)));
      }}
    >
      <svg
        className="block h-full w-full"
        viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={edit ? "Layout editor canvas" : "Warehouse floor plan"}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onPointerLeave={() => {
          if (!gesture.current && hover) setHover(null);
        }}
        style={{ cursor: edit ? "default" : "grab" }}
      >
        <defs>
          <pattern id={hatchId} width={fs(6)} height={fs(6)} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2={fs(6)} stroke="rgba(255,255,255,0.28)" strokeWidth={fs(1.5)} />
          </pattern>
          <pattern id={blockedId} width={fs(7)} height={fs(7)} patternUnits="userSpaceOnUse" patternTransform="rotate(-45)">
            <line x1="0" y1="0" x2="0" y2={fs(7)} stroke="rgba(248,113,113,0.75)" strokeWidth={fs(2)} />
          </pattern>
          <pattern id={gridId} width={grid} height={grid} patternUnits="userSpaceOnUse">
            <path d={`M ${grid} 0 L 0 0 0 ${grid}`} fill="none" stroke="rgba(255,255,255,0.045)" strokeWidth={fs(1)} />
          </pattern>
          <marker id={arrowId} viewBox="0 0 10 10" refX="5" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill={COLORS.walk} />
          </marker>
        </defs>

        {/* building */}
        <rect x={building.x} y={building.y} width={building.w} height={building.h} fill={COLORS.floor} />
        <rect x={building.x} y={building.y} width={building.w} height={building.h} fill={`url(#${gridId})`} />
        <rect
          x={building.x}
          y={building.y}
          width={building.w}
          height={building.h}
          fill="none"
          stroke={COLORS.wall}
          strokeWidth={3}
          {...nonScaling}
        />

        {/* fixtures */}
        {layout.fixtures.map((fx) => {
          const r = fixtureRect(fx);
          const st = FIXTURE_STYLE[fx.kind] ?? FIXTURE_STYLE.other;
          const selected = edit?.selected?.type === "fixture" && edit.selected.id === fx.id;
          const picked = !edit && selectedFixtureId === fx.id;
          const showName = r.w / mmPerPx >= 64 && r.h / mmPerPx >= 14;
          return (
            <g key={fx.id} data-hit={`fx:${fx.id}`} style={{ cursor: edit ? "move" : "pointer" }}>
              <rect
                x={r.x}
                y={r.y}
                width={r.w}
                height={r.h}
                fill={st.fill}
                fillOpacity={st.opacity}
                stroke={fx.blocked ? COLORS.selected : st.stroke}
                strokeDasharray={st.dash}
                strokeWidth={1}
                {...nonScaling}
              />
              {fx.kind === "obstacle" && !fx.blocked && <rect x={r.x} y={r.y} width={r.w} height={r.h} fill={`url(#${hatchId})`} opacity={0.5} />}
              {fx.blocked && <rect x={r.x} y={r.y} width={r.w} height={r.h} fill={`url(#${blockedId})`} />}
              {(selected || picked) && (
                <rect
                  x={r.x}
                  y={r.y}
                  width={r.w}
                  height={r.h}
                  fill="none"
                  stroke={selected ? COLORS.editSelected : COLORS.selected}
                  strokeWidth={2.5}
                  {...nonScaling}
                />
              )}
              {showName && (
                <text
                  x={r.x + r.w / 2}
                  y={r.y + r.h / 2}
                  fontSize={smallFs}
                  fill={COLORS.label}
                  textAnchor="middle"
                  dominantBaseline="central"
                  pointerEvents="none"
                >
                  {fx.name.length > 26 ? `${fx.name.slice(0, 25)}…` : fx.name}
                </text>
              )}
            </g>
          );
        })}

        {/* named floor locations and stations */}
        {!edit &&
          named.map(({ row, rect }) => {
            const p = namedPaint(row);
            const isSel = selectedCode != null && row.code === selectedCode;
            const lit = row.id ? highlightIds?.has(row.id) : false;
            return (
              <g
                key={row.id ?? row.code}
                data-hit={`loc:${row.code}`}
                style={{ cursor: "pointer" }}
                role="button"
                tabIndex={0}
                aria-label={`${row.code}${row.name ? `, ${row.name}` : ""}`}
                onKeyDown={(e) => onKeyActivate(e, { kind: "loc", code: row.code as string })}
                opacity={searching && !lit ? 0.45 : 1}
              >
                <rect
                  x={rect.x}
                  y={rect.y}
                  width={rect.w}
                  height={rect.h}
                  fill={p.fill}
                  fillOpacity={p.opacity}
                  stroke={isSel ? COLORS.selected : lit ? COLORS.highlight : p.stroke}
                  strokeDasharray={isSel || lit ? undefined : p.dash}
                  strokeWidth={isSel || lit ? 2.5 : 1}
                  {...nonScaling}
                />
                <text
                  x={rect.x + rect.w / 2}
                  y={rect.y + rect.h / 2}
                  fontSize={smallFs}
                  fontWeight={600}
                  fill={COLORS.labelStrong}
                  textAnchor="middle"
                  dominantBaseline="central"
                  pointerEvents="none"
                >
                  {row.code}
                </text>
              </g>
            );
          })}

        {/* racks */}
        {layout.racks
          .filter((rack) => rack.active !== false)
          .map((rack) => {
            const r = rackRect(rack, templateFor(rack, layout.templates));
            const selected = edit?.selected?.type === "rack" && edit.selected.id === rack.id;
            return (
              <g key={rack.id} data-hit={`rack:${rack.id}`} style={{ cursor: edit ? "move" : undefined }}>
                <rect x={r.x} y={r.y} width={r.w} height={r.h} fill={COLORS.rack} stroke={COLORS.rackStroke} strokeWidth={1} {...nonScaling} />
                {selected && (
                  <rect
                    x={r.x - fs(4)}
                    y={r.y - fs(4)}
                    width={r.w + fs(8)}
                    height={r.h + fs(8)}
                    fill="none"
                    stroke={COLORS.editSelected}
                    strokeWidth={2}
                    {...nonScaling}
                  />
                )}
                <text x={r.x} y={r.y - fs(4)} fontSize={labelFs} fontWeight={700} fill={COLORS.labelStrong} pointerEvents="none">
                  {rack.code}
                </text>
              </g>
            );
          })}

        {/* bay cells */}
        {cells.map((cell) => {
          const p = cellPaint(cell);
          const rows = byBay.get(cell.key) ?? [];
          const shownRows = rowsForLevel(rows, level);
          const litShown = !!highlightIds && shownRows.some((r) => r.id && highlightIds.has(r.id));
          const litOther = !litShown && !!highlightIds && rows.some((r) => r.id && highlightIds.has(r.id));
          const isSel = !!selectedRow && selectedRow.kind === "bay_level" && rows.some((r) => r.code === selectedRow.code);
          const big = cellPx(cell.rect) >= 16;
          const { x, y, w, h } = cell.rect;
          const inset = Math.min(w, h) * 0.06;
          return (
            <g
              key={`${cell.faceId}-${cell.bay}`}
              data-hit={`cell:${cell.key}`}
              style={{ cursor: edit ? "move" : "pointer" }}
              role={edit ? undefined : "button"}
              tabIndex={edit ? undefined : 0}
              aria-label={edit ? undefined : `Bay ${cell.key}, ${cell.zone}`}
              onKeyDown={edit ? undefined : (e) => onKeyActivate(e, { kind: "cell", key: cell.key })}
              opacity={searching && !litShown && !litOther && !isSel ? 0.4 : 1}
            >
              <rect
                x={x + inset}
                y={y + inset}
                width={w - 2 * inset}
                height={h - 2 * inset}
                rx={fs(1.5)}
                fill={p.fill}
                fillOpacity={p.opacity}
                stroke={p.stroke}
                strokeDasharray={p.dash}
                strokeWidth={1}
                {...nonScaling}
              />
              {p.hatch && <rect x={x + inset} y={y + inset} width={w - 2 * inset} height={h - 2 * inset} fill={`url(#${hatchId})`} pointerEvents="none" />}
              {(litShown || litOther) && (
                <rect
                  x={x + inset}
                  y={y + inset}
                  width={w - 2 * inset}
                  height={h - 2 * inset}
                  fill={litShown ? COLORS.highlight : "none"}
                  fillOpacity={0.18}
                  stroke={COLORS.highlight}
                  strokeWidth={litShown ? 2.5 : 1.5}
                  strokeDasharray={litShown ? undefined : "4 3"}
                  pointerEvents="none"
                  {...nonScaling}
                />
              )}
              {isSel && (
                <rect
                  x={x + inset}
                  y={y + inset}
                  width={w - 2 * inset}
                  height={h - 2 * inset}
                  fill="none"
                  stroke={COLORS.selected}
                  strokeWidth={3}
                  pointerEvents="none"
                  {...nonScaling}
                />
              )}
              {big && !edit && p.value ? (
                <text
                  x={x + w / 2}
                  y={y + h / 2}
                  fontSize={smallFs}
                  fill={COLORS.labelStrong}
                  textAnchor="middle"
                  dominantBaseline="central"
                  pointerEvents="none"
                  className="tabular-nums"
                >
                  {p.value}
                </text>
              ) : null}
            </g>
          );
        })}

        {/* face codes, outside the face's edge, with the walk direction */}
        {faceLabels.map(({ key, face, edge, walkDir, box }) => {
          const off = fs(9);
          let x = box.x + box.w / 2;
          let y = box.y + box.h / 2;
          let anchor: "start" | "middle" | "end" = "middle";
          if (edge === "east") {
            x = box.x + box.w + fs(3);
            anchor = "start";
          } else if (edge === "west") {
            x = box.x - fs(3);
            anchor = "end";
          } else if (edge === "north") y = box.y - off;
          else if (edge === "south") y = box.y + box.h + off;
          return (
            <text
              key={key}
              x={x}
              y={y}
              fontSize={labelFs}
              fontWeight={600}
              fill={COLORS.walk}
              textAnchor={anchor}
              dominantBaseline="central"
              pointerEvents="none"
            >
              {face}
              {walkDir ? ` ${ARROW[walkDir] ?? ""}` : ""}
            </text>
          );
        })}

        {/* walk path */}
        {walk.length > 1 && (
          <g pointerEvents="none">
            <polyline
              points={walk.map((w) => `${w.point.x},${w.point.y}`).join(" ")}
              fill="none"
              stroke={COLORS.walk}
              strokeWidth={2}
              strokeOpacity={0.85}
              strokeLinejoin="round"
              markerMid={`url(#${arrowId})`}
              markerEnd={`url(#${arrowId})`}
              {...nonScaling}
            />
            <circle cx={walk[0].point.x} cy={walk[0].point.y} r={fs(5)} fill={COLORS.walk} />
            {walk.map((w, i) =>
              i === 0 || Math.floor(w.seq / 1000) !== Math.floor(walk[i - 1].seq / 1000) ? (
                <text
                  key={w.seq}
                  x={w.point.x + fs(6)}
                  y={w.point.y - fs(6)}
                  fontSize={smallFs}
                  fontWeight={700}
                  fill={COLORS.walk}
                >
                  {w.seq}
                </text>
              ) : null,
            )}
          </g>
        )}
      </svg>

      {overlay && <div className="pointer-events-none absolute left-2 top-2 max-w-[70%] [&>*]:pointer-events-auto">{overlay}</div>}

      <div className="absolute bottom-2 right-2 flex flex-col gap-1">
        <Button type="button" size="icon" variant="secondary" className="h-9 w-9" aria-label="Zoom in" onClick={() => zoomBy(1.4)}>
          <Plus className="h-4 w-4" />
        </Button>
        <Button type="button" size="icon" variant="secondary" className="h-9 w-9" aria-label="Zoom out" onClick={() => zoomBy(1 / 1.4)}>
          <Minus className="h-4 w-4" />
        </Button>
        <Button type="button" size="icon" variant="secondary" className="h-9 w-9" aria-label="Fit the plan" title="Fit" onClick={() => setUserVb(null)}>
          <Maximize2 className="h-4 w-4" />
        </Button>
      </div>
      <p className="pointer-events-none absolute bottom-2 left-2 text-[10px] text-muted-foreground">↑ N · grid 1 m</p>

      {tooltip && (
        <div
          className="pointer-events-none absolute z-10 max-w-[260px] -translate-x-1/2 -translate-y-full rounded-md border border-border bg-popover px-2.5 py-1.5 text-[11px] leading-snug text-popover-foreground shadow-md"
          style={{ left: Math.min(Math.max(tooltip.at.x, 130), Math.max(130, size.width - 130)), top: Math.max(tooltip.at.y - 6, 60) }}
        >
          {tooltip.body}
        </div>
      )}
    </div>
  );
}

/** The legend for a map mode. */
export function MapLegend({ mode, heatMax, capacityKnown }: { mode: MapMode; heatMax?: number; capacityKnown?: boolean }) {
  const swatch = (fill: string, opacity = 0.7, dashed = false) => (
    <span
      className={cn("inline-block h-3 w-4 rounded-sm border", dashed ? "border-dashed border-neutral-500" : "border-transparent")}
      style={{ background: dashed ? "transparent" : fill, opacity: dashed ? 1 : opacity }}
    />
  );
  const item = (key: string, el: ReactNode, label: string) => (
    <span key={key} className="inline-flex items-center gap-1.5">
      {el}
      {label}
    </span>
  );
  let items: ReactNode[] = [];
  if (mode === "browse") {
    items = (["RTS", "RAW", "BOX", "WIP", "ACC", "MISC"] as const).map((z) => item(z, swatch(WH_ZONE_FILLS[z], 0.6), z));
    items.push(item("ovf", <span className="inline-block h-3 w-4 rounded-sm border border-neutral-600 bg-[repeating-linear-gradient(45deg,#3a3a3a_0_2px,transparent_2px_5px)]" />, "overflow"));
  } else if (mode === "stock") {
    items = [
      item("empty", swatch("", 1, true), "empty"),
      item("low", swatch(COLORS.stock, 0.3), "some"),
      item("full", swatch(COLORS.stock, 0.95), capacityKnown ? "at capacity" : "fullest bin"),
      item("over", swatch(COLORS.over, 0.9), "over capacity"),
    ];
  } else if (mode === "counted") {
    items = COUNT_BUCKETS.map((b) => item(b.bucket, swatch(b.fill, b.bucket === "never" ? 0.35 : 0.7), b.label));
  } else {
    items = [
      item("cold", swatch(heatColor(0), 0.8), "0"),
      item("mid", swatch(heatColor(0.5), 0.9), heatMax ? `${Math.round(heatMax / 2)}` : "mid"),
      item("hot", swatch(heatColor(1), 0.9), heatMax ? `${Math.round(heatMax)} units / 30 d` : "most"),
    ];
  }
  return <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">{items}</div>;
}
