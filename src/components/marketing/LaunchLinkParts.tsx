/**
 * Small pieces the launch-link dialogs and lists share: a date that shifts
 * (old struck through -> new), the PD stage chip, the risk dot, the supply
 * verdict's shape and the own-date chip. Same chip vocabulary as the PD board.
 */
import { cn } from "@/lib/utils";
import type { RiskDot } from "@/lib/marketing/pd";
import type { Tone } from "@/lib/marketing/launch-supply";
import { fmtDay } from "./launch-format";

/** Old -> new, old struck through; just the date when it does not change. */
export function DateShift({ from, to }: { from: string | null | undefined; to: string | null | undefined }) {
  const a = from ? from.slice(0, 10) : null;
  const b = to ? to.slice(0, 10) : null;
  if (a === b) return <span className="whitespace-nowrap tabular-nums">{fmtDay(b)}</span>;
  return (
    <span className="whitespace-nowrap tabular-nums">
      {a && (
        <>
          <span className="text-muted-foreground/60 line-through">{fmtDay(a)}</span>
          <span className="mx-1 text-muted-foreground">→</span>
        </>
      )}
      {fmtDay(b)}
    </span>
  );
}

/** Chip tone: the PD stage look, green for an arrived product, dimmed for a skipped (halted) card. */
export type StageChipTone = "default" | "ok" | "muted";

const STAGE_CHIP_TONE: Record<StageChipTone, string> = {
  default: "border-border text-muted-foreground",
  ok: "border-green-500/50 bg-green-500/10 text-green-400",
  muted: "border-border/60 text-muted-foreground/50",
};

export function StageChip({ label, tone = "default" }: { label: string; tone?: StageChipTone }) {
  return (
    <span className={cn("inline-flex h-5 items-center whitespace-nowrap rounded border px-1.5 text-[11px]", STAGE_CHIP_TONE[tone])}>
      {label}
    </span>
  );
}

const DOT_CLASS: Record<Exclude<RiskDot, null>, string> = {
  g: "bg-green-500",
  a: "bg-amber-500",
  r: "bg-red-500",
};

/** The board's risk dot; grey when there is nothing to rate. */
export function RiskDotMark({ dot, className }: { dot: RiskDot; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("inline-block h-1.5 w-1.5 shrink-0 rounded-full", dot ? DOT_CLASS[dot] : "bg-muted-foreground/40", className)}
    />
  );
}

/** The supply verdict's shape beside its word — a filled circle (green), a triangle (amber), a diamond (red) — so colour never carries the state alone. */
export function VerdictMark({ tone, className }: { tone: Tone; className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 10 10" fill="currentColor" className={cn("inline-block h-[9px] w-[9px] shrink-0", className)}>
      {tone === "g" ? <circle cx={5} cy={5} r={4} /> : tone === "a" ? <path d="M5 0.5 9.5 9.5H0.5z" /> : <path d="M5 0.3 9.7 5 5 9.7 0.3 5z" />}
    </svg>
  );
}

/** Amber "Own date · Jan 15" chip for a card attached to a launch but on its own date. */
export function OwnDateChip({ date }: { date: string | null | undefined }) {
  return (
    <span className="inline-flex h-5 items-center whitespace-nowrap rounded-full border border-amber-500/60 px-2 text-[11px] text-amber-400">
      Own date{date ? ` · ${fmtDay(date)}` : ""}
    </span>
  );
}
