import { Plus } from "lucide-react";
import { PALETTE_MIME } from "@/components/warehouse/map/FloorPlan";
import { FIXTURE_KINDS, FIXTURE_LABELS, FIXTURE_SIZES, type DraftLayout } from "@/lib/warehouse/layout-draft";
import { cn } from "@/lib/utils";

/**
 * Palette: rack templates and fixture kinds. Drag one onto the canvas, or
 * tap it to drop it in the middle of the plan (touch). Templates are
 * read-only here; their setup is a later Settings item.
 */

const KIND_SWATCH: Record<string, string> = {
  door: "bg-sky-500/40",
  pack_station: "bg-teal-500/35",
  desk: "bg-rose-400/30",
  staging: "border border-dashed border-neutral-500",
  obstacle: "bg-zinc-600",
  other: "border border-neutral-600",
};

const KIND_HINT: Record<string, string> = {
  door: "dock or office door",
  pack_station: "bench, AV cart",
  desk: "fill/cap, RTS desk",
  staging: "gaylord, inbound area",
  obstacle: "machine, AC unit, column",
  other: "totes, cart start",
};

interface PaletteProps {
  draft: DraftLayout;
  /** "tpl:<template id>" or "fx:<kind>". */
  onAdd: (item: string) => void;
}

function Item({ data, onAdd, children, title }: { data: string; onAdd: (item: string) => void; children: React.ReactNode; title: string }) {
  return (
    <button
      type="button"
      draggable
      title={title}
      onDragStart={(e) => {
        e.dataTransfer.setData(PALETTE_MIME, data);
        e.dataTransfer.effectAllowed = "copy";
      }}
      onClick={() => onAdd(data)}
      className="group flex w-full cursor-grab items-center gap-2.5 rounded-md border border-border/70 bg-card/60 p-2 text-left text-sm transition-colors hover:border-primary/50 active:cursor-grabbing"
    >
      {children}
      <Plus className="ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100" aria-hidden />
    </button>
  );
}

export function Palette({ draft, onAdd }: PaletteProps) {
  return (
    <div className="flex flex-col gap-4 p-3">
      <section className="space-y-2">
        <h3 className="text-[11px] uppercase tracking-wider text-muted-foreground">Rack templates</h3>
        {draft.templates.length === 0 && <p className="text-xs text-muted-foreground">No templates yet (the workbook import creates them).</p>}
        {draft.templates.map((t) => (
          <Item key={t.id} data={`tpl:${t.id}`} onAdd={onAdd} title={`Drag ${t.name} onto the plan`}>
            <span className="flex h-7 w-11 shrink-0 gap-0.5 rounded-sm border border-neutral-600 bg-neutral-800 p-0.5" aria-hidden>
              {Array.from({ length: Math.min(t.bays, 6) }, (_, i) => (
                <i key={i} className="flex-1 rounded-[1px] bg-neutral-600" />
              ))}
            </span>
            <span className="min-w-0">
              <span className="block truncate font-medium">
                {t.name} <span className="text-muted-foreground">{t.code}</span>
              </span>
              <span className="block text-[11px] text-muted-foreground">
                {t.bays} bays · {t.levels} level{t.levels === 1 ? "" : "s"} · {(t.bay_width_mm / 1000).toFixed(2)} × {(t.depth_mm / 1000).toFixed(2)} m
                {t.overflow_top_level ? " · top overflow" : ""}
              </span>
            </span>
          </Item>
        ))}
      </section>

      <section className="space-y-2">
        <h3 className="text-[11px] uppercase tracking-wider text-muted-foreground">Fixtures</h3>
        {FIXTURE_KINDS.map((k) => (
          <Item key={k} data={`fx:${k}`} onAdd={onAdd} title={`Drag a ${FIXTURE_LABELS[k].toLowerCase()} onto the plan`}>
            <span className={cn("h-5 w-7 shrink-0 rounded-sm", KIND_SWATCH[k])} aria-hidden />
            <span className="min-w-0">
              <span className="block font-medium">{FIXTURE_LABELS[k]}</span>
              <span className="block truncate text-[11px] text-muted-foreground">
                {KIND_HINT[k]} · {(FIXTURE_SIZES[k].w / 1000).toFixed(1)} × {(FIXTURE_SIZES[k].d / 1000).toFixed(1)} m
              </span>
            </span>
          </Item>
        ))}
      </section>

      <p className="text-[11px] leading-relaxed text-muted-foreground">
        Drag onto the plan or tap to add in the middle. Snap 100 mm. Keys: R rotate, Ctrl+D duplicate, Delete remove, arrows nudge (Shift ×10),
        Ctrl+Z undo.
      </p>
    </div>
  );
}
