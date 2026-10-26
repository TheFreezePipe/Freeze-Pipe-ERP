import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** A small rounded chip, the warehouse screens' status and zone pill. */
export function Chip({ className, children, title }: { className?: string; children: ReactNode; title?: string }) {
  return (
    <span
      className={cn("inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-semibold", className)}
      title={title}
    >
      {children}
    </span>
  );
}

/** One number in the Counts header band. */
export function Tile({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: string; tone?: "warn" | "ok" | "muted" }) {
  return (
    <div className="rounded-lg border border-border/60 px-3 py-2.5">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p
        className={cn(
          "text-xl font-bold tabular-nums",
          tone === "warn" && "text-amber-400",
          tone === "ok" && "text-green-400",
          tone === "muted" && "text-muted-foreground",
        )}
      >
        {value}
      </p>
      {sub && <p className="truncate text-[11px] text-muted-foreground">{sub}</p>}
    </div>
  );
}

/** A table shell matching the Settings and Stock tables. */
export function TableShell({ minWidth, children }: { minWidth: number; children: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-md border border-border/50">
      <table className="w-full text-sm" style={{ minWidth }}>
        {children}
      </table>
    </div>
  );
}
