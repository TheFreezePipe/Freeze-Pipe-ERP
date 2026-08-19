/**
 * Product Development board — the card face. Exactly: drop band, name +
 * owner initials, next action, chip row (factory · target+risk dot · aging ·
 * first flag). Nothing else lives on the face; everything else is in the sheet.
 */
import type { DragEvent } from "react";
import { format, parseISO } from "date-fns";
import { aging, cardFlags, riskDot, type PdCardLike } from "@/lib/marketing/pd";
import { dropTagColor } from "@/lib/marketing/drop-colors";
import type { PdProject, PdProjectWithRefs } from "@/lib/hooks/use-pd";
import { cn } from "@/lib/utils";

/** DB rows type `stage`/`category` as plain strings; the pure helpers want the unions. */
const asPdCard = (p: PdProject): PdCardLike => p as unknown as PdCardLike;

function ownerInitials(fullName: string | null | undefined): string {
  if (!fullName) return "?";
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  return parts.slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?";
}

const DOT_CLASS = { g: "bg-green-500", a: "bg-amber-500", r: "bg-red-500" } as const;

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
  const card = asPdCard(project);
  const age = aging(card, todayIso);
  const dot = project.target_launch_date ? riskDot(card, todayIso) : null;
  const flags = cardFlags(card, todayIso);
  const factory = project.supplier?.code ?? null;

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
      style={project.drop_tag ? { borderLeftWidth: 3, borderLeftColor: dropTagColor(project.drop_tag) } : undefined}
      className={cn(
        "group cursor-pointer rounded-md border border-border bg-card px-2.5 py-2 text-left shadow-sm transition-colors hover:border-foreground/30",
        selected && "border-primary ring-1 ring-primary",
        dragging && "opacity-40",
      )}
    >
      <div className="flex items-start gap-2">
        <p className="min-w-0 flex-1 truncate text-sm font-medium leading-5" title={project.name}>
          {project.name}
        </p>
        {project.owner && (
          <span
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-medium text-muted-foreground"
            title={project.owner.full_name ?? undefined}
          >
            {ownerInitials(project.owner.full_name)}
          </span>
        )}
      </div>

      {project.next_action && (
        <p className="mt-0.5 truncate text-xs text-muted-foreground" title={project.next_action}>
          {project.next_action}
        </p>
      )}

      {(factory || project.target_launch_date || age.expected != null || flags.length > 0) && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1 text-[10px] leading-4">
          {factory && <span className="rounded border border-border px-1 text-muted-foreground">{factory}</span>}
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
      )}
    </div>
  );
}
