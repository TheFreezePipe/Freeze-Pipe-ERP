/**
 * Product Development board — six working lanes between two rails (Purgatory
 * left, Halted right). Drag never commits a stage change by itself: a drop
 * opens the Move sheet (the one exception is Purgatory → Good Ideas). Card
 * open state lives in `?card=` so a deep link lands on the sheet.
 */
import { useEffect, useMemo, useState, type DragEvent, type FormEvent, type ReactNode } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { PdCardSheet, PdMoveSheet } from "@/components/marketing/pd";
import { PdCard } from "@/components/marketing/pd/PdCard";
import {
  usePdBoard,
  useCreatePdProject,
  useMovePdProject,
  useReorderPdProject,
  type PdProject,
  type PdProjectWithRefs,
} from "@/lib/hooks/use-pd";
import { PD_LANES, PD_STAGES, PD_STAGE_LABEL, needsReview, riskDot, type PdCardLike, type PdStage } from "@/lib/marketing/pd";
import { useAuth } from "@/lib/auth-context";
import { useUrlFilter } from "@/lib/use-url-filter";
import { useToast } from "@/hooks/use-toast";
import { describeError } from "@/lib/supabase-error";
import { cn } from "@/lib/utils";

type MoveMode = "advance" | "recycle" | "kill" | "archive";
type MoveReq = { id: string; to: PdStage; mode: MoveMode };
type DragInfo = { id: string; stage: PdStage };

const IN_FLIGHT: PdStage[] = ["good_ideas", "ready_to_begin", "china_working", "prototype_sent", "ready_for_confirmation"];
const FACTORY_COUNT_LANES: PdStage[] = ["china_working", "prototype_sent"];

// ── Filters (persisted per browser; search text is not) ─────────────────────
const FILTERS_LS_KEY = "fp-pd-filters";

interface Filters {
  owners: string[];
  factories: string[];
  categories: string[];
  mine: boolean;
  review: boolean;
}
const EMPTY_FILTERS: Filters = { owners: [], factories: [], categories: [], mine: false, review: false };

function loadFilters(): Filters {
  try {
    const raw = localStorage.getItem(FILTERS_LS_KEY);
    if (!raw) return EMPTY_FILTERS;
    const p = JSON.parse(raw) as Partial<Filters>;
    const arr = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
    return { owners: arr(p.owners), factories: arr(p.factories), categories: arr(p.categories), mine: !!p.mine, review: !!p.review };
  } catch {
    return EMPTY_FILTERS;
  }
}

function saveFilters(f: Filters) {
  try {
    localStorage.setItem(FILTERS_LS_KEY, JSON.stringify(f));
  } catch {
    /* ignore storage failures */
  }
}

function toggleIn(list: string[], v: string): string[] {
  return list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
}

function stageOf(p: PdProjectWithRefs): PdStage {
  return p.stage as PdStage;
}

/** DB rows type `stage`/`category` as plain strings; the pure helpers want the unions. */
const asPdCard = (p: PdProject): PdCardLike & PdProject => p as unknown as PdCardLike & PdProject;

// ── Small presentational pieces ─────────────────────────────────────────────
function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-full border px-2 py-0.5 text-xs transition-colors",
        active ? "border-primary bg-primary/15 text-foreground" : "border-border text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

interface LaneProps {
  stage: PdStage;
  cards: PdProjectWithRefs[];
  todayIso: string;
  selectedId: string | null;
  drag: DragInfo | null;
  over: boolean;
  collapsedBody: boolean;
  showFactoryCounts: boolean;
  /** Rails pass this so the header click collapses the lane back to a strip. */
  onHeaderClick?: () => void;
  onOpen: (id: string) => void;
  onDragStart: (info: DragInfo) => void;
  onDragEnd: () => void;
  onDragOverLane: (stage: PdStage) => void;
  onDrop: (stage: PdStage, index: number | null) => void;
}

function Lane({
  stage,
  cards,
  todayIso,
  selectedId,
  drag,
  over,
  collapsedBody,
  showFactoryCounts,
  onHeaderClick,
  onOpen,
  onDragStart,
  onDragEnd,
  onDragOverLane,
  onDrop,
}: LaneProps) {
  const factoryCounts = useMemo(() => {
    if (!showFactoryCounts) return [];
    const m = new Map<string, number>();
    for (const c of cards) if (c.supplier?.code) m.set(c.supplier.code, (m.get(c.supplier.code) ?? 0) + 1);
    return [...m.entries()];
  }, [cards, showFactoryCounts]);

  const allowDrop = (e: DragEvent<HTMLDivElement>) => {
    if (!drag) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    onDragOverLane(stage);
  };

  return (
    <div
      className={cn(
        "flex flex-col rounded-lg border border-border bg-muted/20 transition-colors",
        !collapsedBody && "min-h-[120px]",
        over && drag && drag.stage !== stage && "border-primary/60 bg-primary/5",
        over && drag && drag.stage === stage && "border-foreground/30",
      )}
      onDragOver={allowDrop}
      onDrop={(e) => {
        e.preventDefault();
        onDrop(stage, cards.length);
      }}
    >
      <div
        className={cn("flex items-baseline justify-between gap-2 px-2.5 pb-1.5 pt-2", onHeaderClick && "cursor-pointer select-none")}
        onClick={onHeaderClick}
      >
        <div className="min-w-0">
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{PD_STAGE_LABEL[stage]}</span>
          {factoryCounts.length > 0 && (
            <span className="ml-2 text-[10px] text-muted-foreground/70">
              {factoryCounts.map(([code, n], i) => (
                <span key={code}>
                  {i > 0 && " · "}
                  {code} {n}
                </span>
              ))}
            </span>
          )}
        </div>
        <span className="text-xs tabular-nums text-muted-foreground">{cards.length}</span>
      </div>
      {!collapsedBody && (
        <div className="flex flex-1 flex-col gap-1.5 px-1.5 pb-1.5">
          {cards.map((c, idx) => (
            <PdCard
              key={c.id}
              project={c}
              todayIso={todayIso}
              selected={c.id === selectedId}
              dragging={drag?.id === c.id}
              onOpen={() => onOpen(c.id)}
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", c.id);
                onDragStart({ id: c.id, stage });
              }}
              onDragEnd={onDragEnd}
              onDragOver={(e) => {
                if (!drag) return;
                e.preventDefault();
                e.stopPropagation();
                e.dataTransfer.dropEffect = "move";
                onDragOverLane(stage);
              }}
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onDrop(stage, idx);
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function Rail({
  stage,
  count,
  drag,
  over,
  onClick,
  onDragOverLane,
  onDrop,
}: {
  stage: PdStage;
  count: number;
  drag: DragInfo | null;
  over: boolean;
  onClick: () => void;
  onDragOverLane: (stage: PdStage) => void;
  onDrop: (stage: PdStage, index: number | null) => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      onDragOver={(e) => {
        if (!drag || drag.stage === stage) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        onDragOverLane(stage);
      }}
      onDrop={(e) => {
        e.preventDefault();
        onDrop(stage, null);
      }}
      className={cn(
        "flex min-h-[120px] items-start justify-center rounded-lg border border-border bg-muted/20 py-2 transition-colors hover:bg-muted/40",
        over && drag && drag.stage !== stage && "border-primary/60 bg-primary/5",
      )}
      title={PD_STAGE_LABEL[stage]}
    >
      <span
        className="whitespace-nowrap text-xs font-semibold uppercase tracking-wider text-muted-foreground"
        style={{ writingMode: "vertical-rl" }}
      >
        {PD_STAGE_LABEL[stage]} {count}
      </span>
    </button>
  );
}

// ── Page ────────────────────────────────────────────────────────────────────
export default function ProductDevelopment() {
  const [todayIso] = useState(() => new Date().toISOString().slice(0, 10));
  const { user, profile } = useAuth();
  const uid = user?.id ?? profile?.id ?? null;
  const { toast } = useToast();
  const { data: board = [], isLoading } = usePdBoard();
  const createProject = useCreatePdProject();
  const moveProject = useMovePdProject();
  const reorderProject = useReorderPdProject();

  // Open card = URL (deep-linkable); the Move sheet stacks on top.
  const [cardParam, setCardParam] = useUrlFilter<string>("card", "");
  const selected = useMemo(() => board.find((p) => p.id === cardParam) ?? null, [board, cardParam]);
  const [move, setMove] = useState<MoveReq | null>(null);
  const moveTarget = useMemo(() => (move ? board.find((p) => p.id === move.id) ?? null : null), [board, move]);

  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<Filters>(loadFilters);
  const [rails, setRails] = useState<{ purgatory: boolean; halted: boolean }>({ purgatory: false, halted: false });
  const [newOpen, setNewOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [drag, setDrag] = useState<DragInfo | null>(null);
  const [overStage, setOverStage] = useState<PdStage | null>(null);

  function updateFilters(patch: Partial<Filters>) {
    const next = { ...filters, ...patch };
    setFilters(next);
    saveFilters(next);
  }

  // Esc closes the card sheet (Radix handles the focused case; this covers focus elsewhere).
  useEffect(() => {
    if (!selected || move || newOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setCardParam("");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, move, newOpen, setCardParam]);

  // Filter option sources (whole board, unfiltered).
  const owners = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of board) if (p.owner) m.set(p.owner.id, p.owner.full_name ?? "—");
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [board]);
  const factories = useMemo(() => [...new Set(board.map((p) => p.supplier?.code).filter((c): c is string => !!c))].sort(), [board]);
  const categories = useMemo(
    () => [...new Set(board.map((p) => p.display_category).filter((c): c is string => !!c))].sort(),
    [board],
  );

  const q = query.trim().toLowerCase();
  const visible = useMemo(
    () =>
      board.filter((p) => {
        if (q && !p.name.toLowerCase().includes(q)) return false;
        if (filters.owners.length && (!p.owner_id || !filters.owners.includes(p.owner_id))) return false;
        if (filters.factories.length && (!p.supplier?.code || !filters.factories.includes(p.supplier.code))) return false;
        if (filters.categories.length && (!p.display_category || !filters.categories.includes(p.display_category))) return false;
        if (filters.mine && (!uid || p.owner_id !== uid)) return false;
        if (filters.review && !needsReview(asPdCard(p), todayIso)) return false;
        return true;
      }),
    [board, q, filters, uid, todayIso],
  );

  const byStage = useMemo(() => {
    const m = new Map<PdStage, PdProjectWithRefs[]>();
    for (const s of PD_STAGES) m.set(s, []);
    for (const p of visible) m.get(stageOf(p))?.push(p);
    return m;
  }, [visible]);

  // Header / toolbar counts come from the whole board, not the filtered view.
  const counts = useMemo(() => {
    let inFlight = 0;
    let parked = 0;
    let g = 0;
    let a = 0;
    let r = 0;
    for (const p of board) {
      const s = stageOf(p);
      if (s === "purgatory") parked++;
      if (!IN_FLIGHT.includes(s)) continue;
      inFlight++;
      const dot = p.target_launch_date ? riskDot(asPdCard(p), todayIso) : null;
      if (dot === "g") g++;
      else if (dot === "a") a++;
      else if (dot === "r") r++;
    }
    return { inFlight, parked, g, a, r };
  }, [board, todayIso]);

  // ── Actions ──
  function openCard(id: string) {
    setCardParam(id);
  }

  function submitNewIdea(e: FormEvent) {
    e.preventDefault();
    const name = newName.trim();
    if (!name || createProject.isPending) return;
    createProject.mutate(
      { name, ownerId: uid },
      {
        onSuccess: ({ id }) => {
          setNewOpen(false);
          setNewName("");
          setCardParam(id);
        },
        onError: (err) => toast({ title: "Couldn't create idea", description: describeError(err), variant: "destructive" }),
      },
    );
  }

  function handleDrop(target: PdStage, index: number | null) {
    if (!drag) return;
    const { id, stage } = drag;
    setDrag(null);
    setOverStage(null);
    if (stage === target) {
      if (index != null) reorderProject.mutate({ id, sortIndex: index }, {
        onError: (err) => toast({ title: "Couldn't reorder", description: describeError(err), variant: "destructive" }),
      });
      return;
    }
    if (target === "halted") {
      setMove({ id, to: "halted", mode: "kill" });
      return;
    }
    if (target === "purgatory") {
      setMove({ id, to: "purgatory", mode: "recycle" });
      return;
    }
    if (stage === "purgatory" && target === "good_ideas") {
      moveProject.mutate({ id, to: "good_ideas" }, {
        onError: (err) => toast({ title: "Couldn't move", description: describeError(err), variant: "destructive" }),
      });
      return;
    }
    const mode: MoveMode = PD_STAGES.indexOf(target) > PD_STAGES.indexOf(stage) ? "advance" : "recycle";
    setMove({ id, to: target, mode });
  }

  const gridTemplateColumns = [
    rails.purgatory ? "minmax(160px,1fr)" : "34px",
    "repeat(6, minmax(160px,1fr))",
    rails.halted ? "minmax(160px,1fr)" : "34px",
  ].join(" ");

  const laneProps = {
    todayIso,
    selectedId: selected?.id ?? null,
    drag,
    onOpen: openCard,
    onDragStart: setDrag,
    onDragEnd: () => {
      setDrag(null);
      setOverStage(null);
    },
    onDragOverLane: setOverStage,
    onDrop: handleDrop,
  };

  const purgatoryCards = byStage.get("purgatory") ?? [];
  const haltedCards = byStage.get("halted") ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-baseline gap-3">
          <h1 className="text-2xl font-bold">Product Development</h1>
          <span className="rounded-full border border-border px-2.5 py-0.5 text-xs tabular-nums text-muted-foreground">
            {counts.inFlight} in flight · {counts.parked} ideas parked
          </span>
        </div>
        <Button onClick={() => setNewOpen(true)}>
          <Plus className="mr-2 h-4 w-4" /> New idea
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search"
          className="h-8 w-48"
        />
        {owners.length > 0 && (
          <div className="flex flex-wrap items-center gap-1">
            {owners.map(([id, name]) => (
              <Chip key={id} active={filters.owners.includes(id)} onClick={() => updateFilters({ owners: toggleIn(filters.owners, id) })}>
                {name}
              </Chip>
            ))}
          </div>
        )}
        {factories.length > 0 && (
          <div className="flex flex-wrap items-center gap-1 border-l border-border pl-2">
            {factories.map((code) => (
              <Chip key={code} active={filters.factories.includes(code)} onClick={() => updateFilters({ factories: toggleIn(filters.factories, code) })}>
                {code}
              </Chip>
            ))}
          </div>
        )}
        {categories.length > 0 && (
          <div className="flex flex-wrap items-center gap-1 border-l border-border pl-2">
            {categories.map((c) => (
              <Chip key={c} active={filters.categories.includes(c)} onClick={() => updateFilters({ categories: toggleIn(filters.categories, c) })}>
                {c}
              </Chip>
            ))}
          </div>
        )}
        <div className="flex items-center gap-1 border-l border-border pl-2">
          <Chip active={filters.mine} onClick={() => updateFilters({ mine: !filters.mine })}>
            Mine
          </Chip>
          <Chip active={filters.review} onClick={() => updateFilters({ review: !filters.review })}>
            Review
          </Chip>
        </div>
        <div className="ml-auto flex items-center gap-3 text-xs tabular-nums text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
            {counts.g} on track
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
            {counts.a} tight
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-red-500" />
            {counts.r} late
          </span>
        </div>
      </div>

      {isLoading ? (
        <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">Loading…</div>
      ) : (
        <div className="overflow-x-auto pb-2">
          <div className="grid min-w-[1100px] items-start gap-2" style={{ gridTemplateColumns }}>
            {rails.purgatory ? (
              <Lane
                {...laneProps}
                stage="purgatory"
                cards={purgatoryCards}
                over={overStage === "purgatory"}
                collapsedBody={false}
                showFactoryCounts={false}
                onHeaderClick={() => setRails((r) => ({ ...r, purgatory: false }))}
              />
            ) : (
              <Rail
                stage="purgatory"
                count={purgatoryCards.length}
                drag={drag}
                over={overStage === "purgatory"}
                onClick={() => setRails((r) => ({ ...r, purgatory: true }))}
                onDragOverLane={setOverStage}
                onDrop={handleDrop}
              />
            )}

            {PD_LANES.map((stage) => {
              const cards = byStage.get(stage) ?? [];
              return (
                <Lane
                  key={stage}
                  {...laneProps}
                  stage={stage}
                  cards={cards}
                  over={overStage === stage}
                  collapsedBody={!!q && cards.length === 0}
                  showFactoryCounts={FACTORY_COUNT_LANES.includes(stage)}
                />
              );
            })}

            {rails.halted ? (
              <Lane
                {...laneProps}
                stage="halted"
                cards={haltedCards}
                over={overStage === "halted"}
                collapsedBody={false}
                showFactoryCounts={false}
                onHeaderClick={() => setRails((r) => ({ ...r, halted: false }))}
              />
            ) : (
              <Rail
                stage="halted"
                count={haltedCards.length}
                drag={drag}
                over={overStage === "halted"}
                onClick={() => setRails((r) => ({ ...r, halted: true }))}
                onDragOverLane={setOverStage}
                onDrop={handleDrop}
              />
            )}
          </div>
        </div>
      )}

      <Dialog
        open={newOpen}
        onOpenChange={(o) => {
          setNewOpen(o);
          if (!o) setNewName("");
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <form onSubmit={submitNewIdea} className="space-y-4">
            <DialogHeader>
              <DialogTitle>New idea</DialogTitle>
            </DialogHeader>
            <Input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Name"
              maxLength={120}
            />
            <DialogFooter>
              <Button type="submit" disabled={!newName.trim() || createProject.isPending}>
                Create
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <PdCardSheet
        project={selected}
        open={!!selected}
        onOpenChange={(o) => {
          if (!o) setCardParam("");
        }}
        onRequestMove={(to, mode) => selected && setMove({ id: selected.id, to, mode })}
        onRequestKill={() => selected && setMove({ id: selected.id, to: "halted", mode: "kill" })}
        onRequestArchive={() => selected && setMove({ id: selected.id, to: "purgatory", mode: "archive" })}
        todayIso={todayIso}
      />

      {move && moveTarget && (
        <PdMoveSheet
          project={moveTarget}
          to={move.to}
          mode={move.mode}
          open
          onOpenChange={(o) => {
            if (!o) setMove(null);
          }}
          todayIso={todayIso}
        />
      )}
    </div>
  );
}
