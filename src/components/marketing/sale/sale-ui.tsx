/**
 * Sale dashboards — shared presentation atoms. No numbers are computed here;
 * every value and word arrives from SaleMetrics (sale-metrics.ts) and the
 * label maps (sale-labels.ts).
 */
import type { ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { F, NONE_TEXT } from "@/lib/marketing/sale-format";
import type { ChipDef, Mark, Tone } from "@/lib/marketing/sale-labels";
import type { Judged } from "@/lib/marketing/sale-metrics";

import { NONE, TD, TH } from "./sale-tokens";

const TONE_TEXT: Record<Tone, string> = {
  g: "text-green-400",
  r: "text-red-400",
  k: "text-muted-foreground",
  a: "text-amber-400",
  b: "text-blue-400",
  v: "text-violet-400",
};
const TONE_CHIP: Record<Tone, string> = {
  g: "border-green-500/40 text-green-400",
  r: "border-red-500/40 text-red-400",
  k: "border-border text-muted-foreground",
  a: "border-amber-500/40 text-amber-400",
  b: "border-blue-500/40 text-blue-400",
  v: "border-violet-500/40 text-violet-400",
};

export function StatusMark({ mark }: { mark: Mark }) {
  const common = { className: "h-2.5 w-2.5 shrink-0", viewBox: "0 0 10 10", "aria-hidden": true } as const;
  switch (mark) {
    case "ring":
      return <svg {...common}><circle cx="5" cy="5" r="3.6" fill="none" stroke="currentColor" strokeWidth="1.6" /></svg>;
    case "half":
      return (
        <svg {...common}>
          <circle cx="5" cy="5" r="3.6" fill="none" stroke="currentColor" strokeWidth="1.6" />
          <path d="M5 1.4A3.6 3.6 0 0 1 5 8.6z" fill="currentColor" />
        </svg>
      );
    case "disc":
      return <svg {...common}><circle cx="5" cy="5" r="4.2" fill="currentColor" /></svg>;
    case "tri":
      return <svg {...common}><path d="M5 .8 9.6 9.2H.4z" fill="currentColor" /></svg>;
    case "diamond":
      return <svg {...common}><path d="M5 .4 9.6 5 5 9.6.4 5z" fill="currentColor" /></svg>;
  }
}

export function DataTip({ tip, children, className }: { tip: ReactNode; children: ReactNode; className?: string }) {
  if (!tip) return <span className={className}>{children}</span>;
  return (
    <Tooltip delayDuration={150}>
      <TooltipTrigger asChild>
        <span className={cn("cursor-default", className)} tabIndex={0}>{children}</span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs border border-border bg-popover text-xs text-foreground">{tip}</TooltipContent>
    </Tooltip>
  );
}

export function Chip({ tone, mark, label, tip, className }: { tone: Tone; mark?: Mark | null; label: ReactNode; tip?: ReactNode; className?: string }) {
  const body = (
    <span className={cn("inline-flex h-5 items-center gap-1.5 whitespace-nowrap rounded border bg-white/[0.03] px-2 text-[11px] font-medium", TONE_CHIP[tone], className)}>
      {mark ? <StatusMark mark={mark} /> : null}
      {label}
    </span>
  );
  return tip ? <DataTip tip={tip}>{body}</DataTip> : body;
}

export function ChipFrom({ def, tip, suffix }: { def: ChipDef; tip?: ReactNode; suffix?: string }) {
  return <Chip tone={def[1]} mark={def[2]} label={def[0] + (suffix ?? "")} tip={tip} />;
}

/** A judged delta: signed, coloured only when it clears the gate; "Too small" below 20 units. */
export function Pin({ j, allowSmall, label }: { j: Judged | null | undefined; allowSmall?: boolean; label?: string }) {
  if (!j || j.delta == null) return <span className="tabular-nums text-muted-foreground">{j?.small ? "Too small" : NONE_TEXT}</span>;
  if (j.small && !allowSmall) return <span className="tabular-nums text-muted-foreground">Too small</span>;
  const tip =
    j.ref != null
      ? (label ? label + " · " : "") +
        (j.unit === "pts"
          ? "actual " + F.pct0(j.value) + "% · ref " + F.pct0(j.ref) + "%"
          : "actual " + F.int(j.value) + " · ref " + F.int(j.ref) + (j.z != null ? " · z " + j.z.toFixed(1) : ""))
      : null;
  return (
    <DataTip tip={tip}>
      <span className={cn("tabular-nums", TONE_TEXT[j.tone])}>{F.signed(j.delta, j.unit)}</span>
    </DataTip>
  );
}

/** Poisson interval bar beside a pin: ±2√(a+b)/b around the delta. */
export function LiftBar({ j }: { j: Judged | null | undefined }) {
  if (!j || j.delta == null || j.small || j.unit === "pts" || j.value == null || j.ref == null) return <span className="inline-block h-3 w-[60px]" />;
  const W = 60, H = 12;
  const half = (2 * Math.sqrt(j.value + j.ref)) / j.ref;
  const X = (v: number) => W / 2 + Math.max(-1, Math.min(1, v)) * (W / 2 - 1);
  const lo = j.delta - half, hi = j.delta + half;
  const col = j.tone === "k" ? "#9a9a9a" : j.tone === "g" ? "#4ade80" : "#f87171";
  return (
    <DataTip tip={"interval " + F.signed(lo) + " to " + F.signed(hi)}>
      <svg className="inline-block h-3 w-[60px] align-middle" viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
        <line x1={W / 2} x2={W / 2} y1="1" y2={H - 1} stroke="#6b6b6b" />
        <rect x={X(lo)} y="4.5" width={Math.max(1, X(hi) - X(lo))} height="3" fill={col} />
        <rect x={X(j.delta) - 0.75} y="2" width="1.5" height="8" fill={col} />
        {hi > 1 ? <path d={`M${W - 1} 6l-4 -3v6z`} fill={col} /> : null}
        {lo < -1 ? <path d="M1 6l4 -3v6z" fill={col} /> : null}
      </svg>
    </DataTip>
  );
}

export function PinRow({ j, allowSmall }: { j: Judged | null | undefined; allowSmall?: boolean }) {
  return (
    <span className="inline-flex items-center justify-end gap-2">
      <Pin j={j} allowSmall={allowSmall} />
      <LiftBar j={j} />
    </span>
  );
}

export function ShareBar({ share, tip }: { share: number | null; tip?: string }) {
  if (share == null) return NONE;
  return (
    <DataTip tip={tip}>
      <span className="inline-flex items-center gap-2">
        <span className="relative inline-block h-1.5 w-[60px] rounded-sm bg-muted">
          <i className="absolute left-0 top-0 h-full rounded-sm bg-foreground/80" style={{ width: Math.min(100, (share / 0.4) * 100).toFixed(0) + "%" }} />
        </span>
        <span className="tabular-nums">{F.pct0(share)}</span>
      </span>
    </DataTip>
  );
}

/** Two-token numeric cell: actual then its reference, muted. */
export function Pair({ a, b, fmt = F.cell }: { a: number | null | undefined; b?: number | null; fmt?: (n: number | null | undefined) => string }) {
  if (a == null) return NONE;
  return (
    <span className="inline-flex items-baseline gap-1.5 tabular-nums">
      <span>{fmt(a)}</span>
      {b != null ? <span className="text-[11.5px] text-muted-foreground">{fmt(b)}</span> : null}
    </span>
  );
}

export function ModuleCard({ id, title, right, children, strip }: { id: string; title: ReactNode; right?: ReactNode; children: ReactNode; strip?: ReactNode[] }) {
  return (
    <section id={"m-" + id} className="overflow-hidden rounded-lg border border-border/60 bg-card">
      <div className="flex h-9 items-center justify-between gap-3 border-b border-border/60 bg-background/40 px-3.5">
        <span className="text-[13px] font-semibold">{title}</span>
        <span className="flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap text-xs text-muted-foreground">{right}</span>
      </div>
      {children}
      {strip && strip.filter(Boolean).length ? (
        <div className="flex h-8 items-center gap-5 overflow-hidden whitespace-nowrap border-t border-border/60 px-3.5 text-xs text-muted-foreground">
          {strip.filter(Boolean).map((s, i) => <span key={i} className="[&_b]:font-semibold [&_b]:text-foreground">{s}</span>)}
        </div>
      ) : null}
    </section>
  );
}

export function Tile({ k, value, sub, extra }: { k: string; value: ReactNode; sub?: ReactNode; extra?: ReactNode }) {
  return (
    <div className="min-w-0 rounded border border-border/60 p-2.5">
      <div className="truncate text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">{k}</div>
      <div className="flex items-center justify-between gap-1.5 whitespace-nowrap text-[17px] font-bold leading-6 tabular-nums">
        <span>{value}</span>
        {extra}
      </div>
      {sub != null ? <div className="truncate text-[11.5px] text-muted-foreground">{sub}</div> : null}
    </div>
  );
}

export function Th({ children, right, tip, className }: { children: ReactNode; right?: boolean; tip?: ReactNode; className?: string }) {
  return (
    <th className={cn(TH, right && "text-right", className)}>
      {tip ? <DataTip tip={tip}>{children}</DataTip> : children}
    </th>
  );
}

export function ExpandCell({ open, onToggle, has = true, label }: { open: boolean; onToggle: () => void; has?: boolean; label?: string }) {
  return (
    <td className={cn(TD, "w-6 px-1.5")}>
      {has ? (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onToggle(); }}
          aria-expanded={open}
          aria-label={label ?? "Expand"}
          className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <svg viewBox="0 0 10 10" className="h-2.5 w-2.5">
            <path d={open ? "M2 3.5l3 3 3-3" : "M3.5 2l3 3-3 3"} fill="none" stroke="currentColor" strokeWidth="1.5" />
          </svg>
        </button>
      ) : null}
    </td>
  );
}

export function Skeleton({ h, rows = 1 }: { h: number; rows?: number }) {
  return (
    <div className="relative p-3" style={{ height: h }}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="absolute left-3 right-3 h-5 animate-pulse rounded bg-muted" style={{ top: 12 + i * 32 }} />
      ))}
    </div>
  );
}


export function HatchDefs({ id = "sale-hatch", color = "#d4d4d4" }: { id?: string; color?: string }) {
  return (
    <defs>
      <pattern id={id} width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <rect width="4" height="4" fill={color} fillOpacity=".22" />
        <rect width="1.6" height="4" fill={color} />
      </pattern>
    </defs>
  );
}
