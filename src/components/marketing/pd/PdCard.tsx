/**
 * Product Development board — the card face. Exactly: drop band, name +
 * next action, chip row (factory · target+risk dot · aging ·
 * first flag). Nothing else lives on the face; everything else is in the sheet.
 */
import type { DragEvent } from "react";
import { format, parseISO } from "date-fns";
import { Star } from "lucide-react";
import { aging, cardFlags, riskDot } from "@/lib/marketing/pd";
import { dropColorFor } from "@/lib/marketing/drop-colors";
import type { PdProjectWithRefs } from "@/lib/hooks/use-pd";
import { cn } from "@/lib/utils";
import { coverPhotoPath, toCardLike, useDropColors } from "./pd-field-utils";
import { usePdPhotoUrl } from "./pd-photo-context";
import { PdDropPicker } from "./PdDropPicker";

const DOT_CLASS = {
  g: "bg-green-500",
  a: "bg-amber-500",
  r: "bg-red-500",
} as const;

function fmtShort(iso: string): string {
  try {
    return format(parseISO(iso), "MMM d");
  } catch {
    return iso;
  }
}

export interface PdCardProps {
  project: PdProjectWithRefs;
  todayIso: string;
  selected: boolean;
  dragging: boolean;
  onOpen: () => void;
  onDragStart: (e: DragEvent<HTMLDivElement>) => void;
  onDragEnd: () => void;
  onDragOver: (e: DragEvent<HTMLDivElement>) => void;
  onDrop: (e: DragEvent<HTMLDivElement>) => void;
}

export function PdCard({ project, todayIso, selected, dragging, onOpen, onDragStart, onDragEnd, onDragOver, onDrop }: PdCardProps) {
  const card = toCardLike(project);
  const age = aging(card, todayIso);
  const dot = project.target_launch_date ? riskDot(card, todayIso) : null;
  const flags = cardFlags(card, todayIso);
  const factory = project.supplier?.code ?? null;
  const newest = project.samples[0] ?? null;
  const golden = project.samples.some((s) => s.is_golden);
  const coverUrl = usePdPhotoUrl(coverPhotoPath(project));
  const dropColors = useDropColors();

  return (
    <div
      role="button"
      tabIndex={0}
      draggable
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDrop={onDrop}
      style={
        project.drop_tag
          ? {
              borderLeftWidth: 3,
              borderLeftColor: dropColorFor(dropColors, project.drop_tag),
            }
          : undefined
      }
      className={cn(
        "group cursor-pointer rounded-md border border-border bg-card px-2.5 py-2 text-left shadow-sm transition-colors hover:border-foreground/30",
        selected && "border-primary ring-1 ring-primary",
        dragging && "opacity-40",
      )}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="min-w-0 truncate text-sm font-medium leading-5" title={project.name}>
            {project.name}
          </p>
          {project.next_action && (
            <p className="mt-0.5 truncate text-xs text-muted-foreground" title={project.next_action}>
              {project.next_action}
            </p>
          )}
        </div>
        {coverUrl && <img src={coverUrl} alt="" loading="lazy" className="h-10 w-10 shrink-0 rounded object-cover" draggable={false} />}
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-1 text-[10px] leading-4">
          <PdDropPicker project={project} />
          {factory && <span className="rounded border border-border px-1 text-muted-foreground">{factory}</span>}
          {newest && (
            <span
              className={cn(
                "inline-flex items-center gap-0.5 rounded border px-1 tabular-nums",
                golden ? "border-amber-500/40 text-amber-400" : "border-border text-muted-foreground",
              )}
            >
              {golden && <Star className="h-2.5 w-2.5 fill-current" />}R{newest.round_no}
            </span>
          )}
          {project.target_launch_date && (
            <span className="inline-flex items-center gap-1 rounded border border-border px-1 tabular-nums text-muted-foreground">
              {dot && <span className={cn("h-1.5 w-1.5 rounded-full", DOT_CLASS[dot])} />}
              {fmtShort(project.target_launch_date)}
            </span>
          )}
          {age.expected != null && (
            <span
              className={cn(
                "rounded border px-1 font-mono tabular-nums",
                age.tone === "red"
                  ? "border-red-500/40 bg-red-500/10 text-red-400"
                  : age.tone === "amber"
                    ? "border-amber-500/40 bg-amber-500/10 text-amber-400"
                    : "border-border text-muted-foreground",
              )}
            >
              {age.days}d / {age.expected}d
            </span>
          )}
          {flags.length > 0 && (
            <span className="truncate rounded border border-red-500/40 bg-red-500/10 px-1 text-red-400" title={flags.join(" · ")}>
              ⚑ {flags[0]}
            </span>
          )}
      </div>
    </div>
  );
}
