import { useMemo } from "react";
import { Copy, RotateCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { WhLocationSummary } from "@/lib/hooks";
import type { Point } from "@/lib/warehouse/map-geometry";
import type { DraftLayout, DraftTarget } from "@/lib/warehouse/layout-draft";
import { FloorPlan } from "@/components/warehouse/map/FloorPlan";

/**
 * Canvas: FloorPlan in edit mode over the draft (inactive racks and removed
 * fixtures hidden). Select, drag on a 100 mm snap, drop palette items; the
 * selection bar rotates, duplicates or removes. With Verify walk on, the
 * saved pick_sequence path is drawn over it.
 */

interface CanvasProps {
  draft: DraftLayout;
  locations: WhLocationSummary[];
  selected: DraftTarget | null;
  showWalk: boolean;
  onSelect: (t: DraftTarget | null) => void;
  onDragStart: (t: DraftTarget) => void;
  onDrag: (t: DraftTarget, x: number, y: number) => void;
  onDrop: (item: string, at: Point) => void;
  onRotate: () => void;
  onDuplicate: () => void;
  onRemove: () => void;
}

export function Canvas({ draft, locations, selected, showWalk, onSelect, onDragStart, onDrag, onDrop, onRotate, onDuplicate, onRemove }: CanvasProps) {
  const layout = useMemo(
    () => ({
      templates: draft.templates,
      racks: draft.racks.filter((r) => r.active),
      faces: draft.faces,
      fixtures: draft.fixtures.filter((f) => !f._deleted),
    }),
    [draft],
  );
  const label =
    selected?.type === "rack"
      ? layout.racks.find((r) => r.id === selected.id)?.code
      : selected?.type === "fixture"
        ? layout.fixtures.find((f) => f.id === selected.id)?.name
        : undefined;

  return (
    <FloorPlan
      layout={layout}
      locations={locations}
      showWalk={showWalk}
      className="rounded-none border-0"
      edit={{ selected, onSelect, onDragStart, onDrag, onDrop }}
      overlay={
        label ? (
          <div className="flex items-center gap-1 rounded-md border border-border bg-popover/95 p-1 shadow-sm">
            <span className="max-w-[160px] truncate px-1.5 text-xs font-semibold">{label}</span>
            <Button type="button" size="sm" variant="ghost" className="h-7 px-2" onClick={onRotate} title="Rotate 90° (R)">
              <RotateCw className="h-3.5 w-3.5" />
            </Button>
            <Button type="button" size="sm" variant="ghost" className="h-7 px-2" onClick={onDuplicate} title="Duplicate (Ctrl+D)">
              <Copy className="h-3.5 w-3.5" />
            </Button>
            <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-red-400" onClick={onRemove} title="Remove (Delete)">
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        ) : showWalk ? (
          <p className="rounded-md border border-border bg-popover/95 px-2.5 py-1.5 text-xs text-muted-foreground">
            The path is the saved pick sequence, not this draft.
          </p>
        ) : undefined
      }
    />
  );
}
