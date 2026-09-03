/**
 * Product Development — drop tag picker. The chip on a card face (and in
 * the card sheet header) that shows which drop a card belongs to; click it
 * to pick an existing drop (type-ahead, member counts) or create one.
 * Picking a drop whose members carry a target launch date copies that date
 * onto a card that has none — siblings launch together.
 */
import { useMemo, useState, type KeyboardEvent, type MouseEvent } from "react";
import { X } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { toast } from "@/hooks/use-toast";
import { describeError } from "@/lib/supabase-error";
import { dropTagColor } from "@/lib/marketing/drop-colors";
import { usePdBoard, useUpdatePdProject, type PdProjectWithRefs } from "@/lib/hooks/use-pd";
import { dropSummaries, fmtDate } from "./pd-field-utils";

const stop = (e: MouseEvent | KeyboardEvent) => e.stopPropagation();

export function PdDropPicker({ project, size = "card" }: { project: PdProjectWithRefs; size?: "card" | "sheet" }) {
  const { data: board = [] } = usePdBoard();
  const update = useUpdatePdProject();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");

  const drops = useMemo(() => dropSummaries(board), [board]);
  const q = draft.trim().toLowerCase();
  const matches = q ? drops.filter((d) => d.tag.toLowerCase().includes(q)) : drops;
  const exact = drops.find((d) => d.tag.toLowerCase() === q) ?? null;
  const tag = project.drop_tag?.trim() || null;
  const color = tag ? dropTagColor(tag) : null;

  async function apply(next: string | null) {
    const canon = next ? (drops.find((d) => d.tag.toLowerCase() === next.toLowerCase())?.tag ?? next.trim()) : null;
    const patch: { drop_tag: string | null; target_launch_date?: string } = { drop_tag: canon };
    const drop = canon ? drops.find((d) => d.tag === canon) : null;
    const copiedDate = canon && !project.target_launch_date && drop?.launch ? drop.launch : null;
    if (copiedDate) patch.target_launch_date = copiedDate;
    setOpen(false);
    setDraft("");
    try {
      await update.mutateAsync({ id: project.id, patch });
      if (copiedDate) toast({ title: `Target launch set to ${fmtDate(copiedDate)}`, description: `from ${canon}` });
    } catch (e) {
      toast({ title: "Not saved", description: describeError(e), variant: "destructive" });
    }
  }

  const chipBase =
    size === "sheet"
      ? "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs"
      : "inline-flex items-center gap-1 rounded border px-1 text-[10px] leading-4";

  return (
    <span onClick={stop} onKeyDown={stop} className="contents">
      <Popover
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (o) setDraft(tag ?? "");
        }}
      >
        <PopoverTrigger asChild>
          <button
            type="button"
            className={cn(
              chipBase,
              "font-medium hover:bg-accent/60",
              tag ? "" : "border-dashed border-border text-muted-foreground/70 font-normal",
            )}
            style={color ? { borderColor: color, color } : undefined}
            aria-label={tag ? `Drop: ${tag}` : "Set drop"}
          >
            {tag ?? "+ drop"}
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-60 p-2" onClick={stop} onKeyDown={stop}>
          <Input
            autoFocus
            value={draft}
            placeholder="Drop name"
            maxLength={40}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && draft.trim()) void apply(draft);
              if (e.key === "Escape") setOpen(false);
            }}
            className="h-8 text-sm"
          />
          <div className="mt-1.5 max-h-56 overflow-y-auto">
            {matches.map((d) => (
              <button
                key={d.tag}
                type="button"
                onClick={() => void apply(d.tag)}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
              >
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: dropTagColor(d.tag) }} />
                <span className="min-w-0 flex-1 truncate">{d.tag}</span>
                <span className="text-[11px] tabular-nums text-muted-foreground">{d.count}</span>
              </button>
            ))}
            {q && !exact && (
              <button
                type="button"
                onClick={() => void apply(draft)}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-primary hover:bg-accent"
              >
                Create “{draft.trim()}”
              </button>
            )}
          </div>
          {exact?.launch && !project.target_launch_date && (
            <div className="px-2 pt-1 text-[11px] text-muted-foreground">Target launch → {fmtDate(exact.launch)}</div>
          )}
          {tag && (
            <button
              type="button"
              onClick={() => void apply(null)}
              className="mt-1.5 flex w-full items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <X className="h-3 w-3" /> Remove from drop
            </button>
          )}
        </PopoverContent>
      </Popover>
    </span>
  );
}
