import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, ArrowLeft, Loader2, Redo2, Route, Save, ScanSearch, Undo2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import type { Json } from "@/lib/database.types";
import {
  WhLayoutRejectedError,
  useWhGenerateLocations,
  useWhLayout,
  useWhLocations,
  useWhSaveLayoutChecked,
  useWhSaveLocation,
  type WhGenerateResult,
  type WhLayout,
  type WhLayoutProblem,
} from "@/lib/hooks";
import { buildingRect, rectCenter, type Point } from "@/lib/warehouse/map-geometry";
import {
  buildLayoutPayload,
  duplicateItem,
  fixtureOfKind,
  isNewId,
  linkedGeometryUpdates,
  moveItem,
  rackFromTemplate,
  rackStock,
  removeItem,
  rotateItem,
  validateDraft,
  FIXTURE_KINDS,
  type DraftLayout,
  type DraftTarget,
  type FixtureKind,
} from "@/lib/warehouse/layout-draft";
import { cn } from "@/lib/utils";
import { Canvas } from "./Canvas";
import { GeneratorPreview } from "./GeneratorPreview";
import { Palette } from "./Palette";
import { Properties } from "./Properties";
import { VerifyWalk } from "./VerifyWalk";

/**
 * Layout editor (design §9.3), full screen over Settings › Warehouse:
 * Palette | Canvas | Properties. Edits stay local (undo / redo history)
 * until Save layout sends one rpc_wh_save_layout payload with row_versions;
 * a refusal lists every problem and nothing is saved. After a save,
 * Preview locations runs the generator dry run and Apply runs it for real.
 * Verify walk draws the saved pick_sequence and edits walk passes, with
 * per-location fixes through rpc_wh_resequence. Leaving with unsaved
 * changes asks first (close, browser back, reload).
 */

interface LayoutEditorProps {
  onClose: () => void;
}

const HISTORY_LIMIT = 100;
/** Marks the history entry the editor pushes, so Back closes the editor. */
const HISTORY_MARK = "whLayoutEditor";

function toDraft(layout: WhLayout): DraftLayout {
  return { templates: layout.templates, racks: layout.racks, faces: layout.faces, fixtures: layout.fixtures };
}

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

export function LayoutEditor({ onClose }: LayoutEditorProps) {
  const { data, isLoading, error } = useWhLayout();
  // A portal on <body>, so no page container can clip or restack it.
  return createPortal(
    <div className="fixed inset-0 z-40 flex flex-col bg-background" role="dialog" aria-modal="true" aria-label="Layout editor">
      {data ? (
        <EditorSession initial={data} onClose={onClose} />
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
          {isLoading ? (
            <>
              <Loader2 className="h-5 w-5 animate-spin" /> Loading the layout…
            </>
          ) : (
            <>Couldn't load the layout{error instanceof Error ? `: ${error.message}` : ""}.</>
          )}
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </div>
      )}
    </div>,
    document.body,
  );
}

function EditorSession({ initial, onClose }: { initial: WhLayout; onClose: () => void }) {
  const { toast } = useToast();
  const { refetch } = useWhLayout();
  const { data: locations = [] } = useWhLocations();
  const saveLayout = useWhSaveLayoutChecked();
  const saveLocation = useWhSaveLocation();
  const generate = useWhGenerateLocations();

  const [base, setBase] = useState<DraftLayout>(() => toDraft(initial));
  const [draft, setDraft] = useState<DraftLayout>(() => toDraft(initial));
  const [past, setPast] = useState<DraftLayout[]>([]);
  const [future, setFuture] = useState<DraftLayout[]>([]);
  const [selected, setSelected] = useState<DraftTarget | null>(null);
  const [verify, setVerify] = useState(false);
  const [rejected, setRejected] = useState<{ message: string; problems: WhLayoutProblem[] } | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  const [preview, setPreview] = useState<{ open: boolean; result: WhGenerateResult | null; applied: boolean }>({
    open: false,
    result: null,
    applied: false,
  });

  const diff = useMemo(() => buildLayoutPayload(base, draft), [base, draft]);
  const issues = useMemo(() => validateDraft(draft), [draft]);
  const dirty = diff.count > 0;
  const saving = saveLayout.isPending || saveLocation.isPending;

  // ---- history ------------------------------------------------------------------
  function commit(next: DraftLayout) {
    if (next === draft) return;
    setPast((p) => [...p.slice(-HISTORY_LIMIT + 1), draft]);
    setFuture([]);
    setDraft(next);
    setJustSaved(false);
  }
  function undo() {
    if (past.length === 0) return;
    setFuture((f) => [draft, ...f]);
    setDraft(past[past.length - 1]);
    setPast((p) => p.slice(0, -1));
  }
  function redo() {
    if (future.length === 0) return;
    setPast((p) => [...p, draft]);
    setDraft(future[0]);
    setFuture((f) => f.slice(1));
  }

  // ---- item actions ---------------------------------------------------------------
  function centerOfPlan(): Point {
    return rectCenter(buildingRect({ ...draft, racks: draft.racks.filter((r) => r.active), fixtures: draft.fixtures.filter((f) => !f._deleted) }));
  }

  function addItem(item: string, at: Point = centerOfPlan()) {
    if (item.startsWith("tpl:")) {
      const tpl = draft.templates.find((t) => t.id === item.slice(4));
      if (!tpl) return;
      const { rack, face } = rackFromTemplate(tpl, at, draft);
      commit({ ...draft, racks: [...draft.racks, rack], faces: [...draft.faces, face] });
      setSelected({ type: "rack", id: rack.id });
    } else if (item.startsWith("fx:")) {
      const kind = item.slice(3) as FixtureKind;
      if (!FIXTURE_KINDS.includes(kind)) return;
      const fx = fixtureOfKind(kind, at, draft);
      commit({ ...draft, fixtures: [...draft.fixtures, fx] });
      setSelected({ type: "fixture", id: fx.id });
    }
  }

  function rotate() {
    if (selected) commit(rotateItem(draft, selected));
  }
  function duplicate() {
    if (!selected) return;
    const { draft: next, target } = duplicateItem(draft, selected);
    commit(next);
    setSelected(target);
  }
  function remove() {
    if (!selected) return;
    if (selected.type === "rack" && !isNewId(selected.id)) {
      const stock = rackStock(locations, selected.id);
      if (stock.locations > 0) {
        const code = draft.racks.find((r) => r.id === selected.id)?.code ?? "This rack";
        toast({
          title: `${code} still holds stock`,
          description: `${stock.units.toLocaleString()} units in ${stock.locations} location${stock.locations === 1 ? "" : "s"}. Empty it before removing the rack.`,
          variant: "destructive",
        });
        return;
      }
    }
    commit(removeItem(draft, selected));
    setSelected(null);
  }
  function nudge(dx: number, dy: number) {
    if (!selected) return;
    const item = selected.type === "rack" ? draft.racks.find((r) => r.id === selected.id) : draft.fixtures.find((f) => f.id === selected.id);
    if (item) commit(moveItem(draft, selected, item.x_mm + dx, item.y_mm + dy));
  }

  // ---- save, generate -----------------------------------------------------------
  async function save() {
    if (!dirty || issues.length > 0 || saving) return;
    setRejected(null);
    const follow = linkedGeometryUpdates(base, draft, locations);
    const keep = selected
      ? selected.type === "rack"
        ? { type: "rack" as const, key: draft.racks.find((r) => r.id === selected.id)?.code }
        : { type: "fixture" as const, key: draft.fixtures.find((f) => f.id === selected.id)?.name }
      : null;
    try {
      const result = await saveLayout.mutateAsync(diff.payload as unknown as Json);
      let moved = 0;
      for (const m of follow) {
        try {
          await saveLocation.mutateAsync({ id: m.location_id, x_mm: m.x_mm, y_mm: m.y_mm, width_mm: m.width_mm, depth_mm: m.depth_mm });
          moved++;
        } catch (err) {
          toast({ title: "A named location did not follow its fixture", description: err instanceof Error ? err.message : String(err), variant: "destructive" });
        }
      }
      const fresh = await refetch();
      if (fresh.data) {
        const next = toDraft(fresh.data);
        setBase(next);
        setDraft(next);
        setPast([]);
        setFuture([]);
        if (keep?.key) {
          const id =
            keep.type === "rack" ? next.racks.find((r) => r.code === keep.key)?.id : next.fixtures.find((f) => f.name === keep.key)?.id;
          setSelected(id ? { type: keep.type, id } : null);
        }
      }
      setJustSaved(true);
      const parts = Object.entries(result)
        .filter(([k, v]) => k !== "ok" && v && typeof v === "object")
        .map(([k, v]) => {
          const c = v as { created: number; updated: number; deleted?: number };
          const n = c.created + c.updated + (c.deleted ?? 0);
          return n ? `${k} ${n}` : null;
        })
        .filter(Boolean);
      toast({
        title: "Layout saved",
        description: `${parts.join(", ") || "no rows"}${moved ? ` · ${moved} named location${moved === 1 ? "" : "s"} moved with their fixture` : ""}. Preview the locations next.`,
      });
    } catch (err) {
      if (err instanceof WhLayoutRejectedError) setRejected({ message: err.message, problems: err.problems });
      else toast({ title: "Couldn't save the layout", description: err instanceof Error ? err.message : String(err), variant: "destructive" });
    }
  }

  async function reload() {
    if (dirty && !window.confirm("Reload the saved layout and drop your unsaved changes?")) return;
    const fresh = await refetch();
    if (fresh.data) {
      const next = toDraft(fresh.data);
      setBase(next);
      setDraft(next);
      setPast([]);
      setFuture([]);
      setSelected(null);
      setRejected(null);
    }
  }

  function runPreview() {
    setPreview({ open: true, result: null, applied: false });
    generate.mutate(
      { dryRun: true },
      {
        onSuccess: (result) => setPreview({ open: true, result, applied: false }),
        onError: (err) => {
          setPreview({ open: false, result: null, applied: false });
          toast({ title: "Couldn't check the locations", description: err instanceof Error ? err.message : String(err), variant: "destructive" });
        },
      },
    );
  }

  function apply() {
    generate.mutate(
      { dryRun: false },
      {
        onSuccess: (result) => {
          setPreview({ open: true, result, applied: true });
          setJustSaved(false);
          toast({
            title: "Locations generated",
            description: `${result.created ?? 0} created, ${result.updated ?? 0} updated, ${result.deactivated ?? 0} deactivated${
              result.conflicts.length ? `, ${result.conflicts.length} conflicts left as they were` : ""
            }.`,
          });
        },
        onError: (err) => toast({ title: "Couldn't generate the locations", description: err instanceof Error ? err.message : String(err), variant: "destructive" }),
      },
    );
  }

  // ---- leaving --------------------------------------------------------------------
  const closing = useRef(false);
  function close() {
    if (dirty && !window.confirm("Leave the layout editor and drop your unsaved changes?")) return;
    if (window.history.state?.[HISTORY_MARK]) {
      // consume the entry the editor pushed; the popstate below closes it
      closing.current = true;
      window.history.back();
    } else onClose();
  }

  const live = useRef({ dirty, onClose });
  useEffect(() => {
    live.current = { dirty, onClose };
  });

  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  // Browser back: the editor pushes one history entry, so Back closes it
  // (asking first when there are unsaved changes) instead of leaving Settings.
  useEffect(() => {
    const mark = () => window.history.pushState({ ...(window.history.state ?? {}), [HISTORY_MARK]: true }, "");
    if (!window.history.state?.[HISTORY_MARK]) mark();
    const onPop = () => {
      if (closing.current) {
        closing.current = false;
        live.current.onClose();
        return;
      }
      if (live.current.dirty && !window.confirm("Leave the layout editor and drop your unsaved changes?")) {
        mark();
        return;
      }
      live.current.onClose();
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // ---- keyboard -------------------------------------------------------------------
  const keys = useRef<(e: KeyboardEvent) => void>(() => {});
  useEffect(() => {
    keys.current = (e: KeyboardEvent) => {
      if (isTyping(e.target) || preview.open) return;
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      const step = e.shiftKey ? 1000 : 100;
      let action: (() => void) | null = null;
      if (mod) {
        if (k === "z" && !e.shiftKey) action = undo;
        else if (k === "y" || (k === "z" && e.shiftKey)) action = redo;
        else if (k === "s") action = () => void save();
        else if (k === "d") action = duplicate;
      } else if (!e.altKey) {
        if (k === "r") action = rotate;
        else if (k === "delete" || k === "backspace") action = remove;
        else if (k === "escape") action = () => setSelected(null);
        else if (k === "arrowleft") action = () => nudge(-step, 0);
        else if (k === "arrowright") action = () => nudge(step, 0);
        else if (k === "arrowup") action = () => nudge(0, -step);
        else if (k === "arrowdown") action = () => nudge(0, step);
      }
      if (!action) return;
      e.preventDefault();
      action();
    };
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keys.current(e);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const stale = rejected?.problems.some((p) => p.error === "stale");

  return (
    <>
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <Button variant="ghost" size="sm" onClick={close}>
          <ArrowLeft className="mr-1.5 h-4 w-4" /> Settings · Warehouse
        </Button>
        <span className="text-muted-foreground">/</span>
        <h2 className="text-base font-semibold">Edit layout</h2>
        <Badge
          variant="outline"
          className={cn("ml-1", dirty ? "border-amber-400/40 bg-amber-400/10 text-amber-400" : "text-muted-foreground")}
        >
          {dirty ? `Unsaved · ${diff.count} change${diff.count === 1 ? "" : "s"}` : "Saved"}
        </Badge>
        <span className="hidden text-xs text-muted-foreground md:inline">Snap 100 mm · grid 1 m</span>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <Button variant="ghost" size="sm" onClick={undo} disabled={past.length === 0} title="Undo (Ctrl+Z)">
            <Undo2 className="mr-1 h-4 w-4" /> Undo
          </Button>
          <Button variant="ghost" size="sm" onClick={redo} disabled={future.length === 0} title="Redo (Ctrl+Shift+Z)">
            <Redo2 className="h-4 w-4" />
          </Button>
          <Button variant={verify ? "secondary" : "outline"} size="sm" onClick={() => setVerify((v) => !v)} aria-pressed={verify}>
            <Route className="mr-1.5 h-4 w-4" /> Verify walk
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={runPreview}
            disabled={dirty || generate.isPending}
            title={dirty ? "Save the layout first: the generator reads the saved layout" : "Dry run of the location generator"}
          >
            <ScanSearch className="mr-1.5 h-4 w-4" /> Preview locations
          </Button>
          <Button size="sm" onClick={save} disabled={!dirty || issues.length > 0 || saving} title="Save layout (Ctrl+S)">
            {saving ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Save className="mr-1.5 h-4 w-4" />}
            Save layout
          </Button>
        </div>
      </header>

      {issues.length > 0 && (
        <div className="border-b border-amber-400/30 bg-amber-400/5 px-4 py-2 text-xs text-amber-400">
          <p className="font-medium">Fix before saving:</p>
          <ul className="list-inside list-disc">
            {issues.slice(0, 6).map((m) => (
              <li key={m}>{m}</li>
            ))}
            {issues.length > 6 && <li>+{issues.length - 6} more</li>}
          </ul>
        </div>
      )}
      {rejected && (
        <div className="flex flex-wrap items-start gap-3 border-b border-red-500/30 bg-red-500/5 px-4 py-2 text-xs text-red-400">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="font-medium">Nothing was saved. The layout RPC refused {rejected.problems.length || 1} row{rejected.problems.length === 1 ? "" : "s"}:</p>
            <ul className="list-inside list-disc">
              {(rejected.problems.length ? rejected.problems.map((p) => p.message) : [rejected.message]).map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
            {stale && <p className="mt-1 text-muted-foreground">Someone saved those rows after you opened the editor. Reload to see their version (your changes are dropped).</p>}
          </div>
          <div className="flex gap-1.5">
            {stale && (
              <Button size="sm" variant="outline" onClick={reload}>
                Reload layout
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => setRejected(null)}>
              Dismiss
            </Button>
          </div>
        </div>
      )}
      {justSaved && !dirty && (
        <div className="flex flex-wrap items-center gap-3 border-b border-primary/30 bg-primary/5 px-4 py-2 text-xs">
          <span>Saved. The bay-level locations keep their old geometry until the generator runs.</span>
          <Button size="sm" onClick={runPreview} disabled={generate.isPending}>
            <ScanSearch className="mr-1.5 h-4 w-4" /> Preview locations
          </Button>
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto lg:grid lg:grid-cols-[230px_minmax(0,1fr)_340px] lg:overflow-hidden">
        <aside className="border-b border-border lg:overflow-y-auto lg:border-b-0 lg:border-r" aria-label="Palette">
          <Palette draft={draft} onAdd={(item) => addItem(item)} />
        </aside>
        <main className="h-[60vh] min-h-[360px] lg:h-auto" aria-label="Canvas">
          <Canvas
            draft={draft}
            locations={locations}
            selected={selected}
            showWalk={verify}
            onSelect={setSelected}
            onDragStart={() => {
              setPast((p) => [...p.slice(-HISTORY_LIMIT + 1), draft]);
              setFuture([]);
              setJustSaved(false);
            }}
            onDrag={(t, x, y) => setDraft((d) => moveItem(d, t, x, y))}
            onDrop={(item, at) => addItem(item, at)}
            onRotate={rotate}
            onDuplicate={duplicate}
            onRemove={remove}
          />
        </main>
        <aside className="border-t border-border lg:overflow-y-auto lg:border-l lg:border-t-0" aria-label={verify ? "Verify walk" : "Properties"}>
          {verify ? (
            <VerifyWalk draft={draft} locations={locations} onChange={commit} />
          ) : (
            <Properties
              draft={draft}
              selected={selected}
              locations={locations}
              onChange={commit}
              onRotate={rotate}
              onDuplicate={duplicate}
              onRemove={remove}
            />
          )}
        </aside>
      </div>

      <GeneratorPreview
        open={preview.open}
        onOpenChange={(open) => setPreview((p) => ({ ...p, open }))}
        result={preview.result}
        applied={preview.applied}
        applying={generate.isPending}
        onApply={apply}
      />
    </>
  );
}
