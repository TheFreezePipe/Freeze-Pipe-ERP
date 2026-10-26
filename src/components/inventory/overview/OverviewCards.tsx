import type { ComponentType, ReactNode } from "react";
import { Link } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * One panel on the Inventory Overview: title, an optional "go to" link, and
 * a body that handles its own loading, error and empty states so every
 * panel renders with zero rows.
 */
export function OverviewPanel({
  title,
  count,
  linkTo,
  linkLabel,
  loading,
  error,
  empty,
  emptyText,
  className,
  children,
}: {
  title: string;
  /** Shown beside the title when > 0. */
  count?: number;
  linkTo?: string;
  linkLabel?: string;
  loading?: boolean;
  error?: boolean;
  empty: boolean;
  emptyText: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Card className={cn("min-w-0", className)}>
      <CardContent className="p-4">
        <div className="mb-2 flex items-center justify-between gap-3">
          <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            {title}
            {count != null && count > 0 && <span className="ml-1.5 tabular-nums text-foreground">{count}</span>}
          </h2>
          {linkTo && (
            <Link to={linkTo} className="shrink-0 text-xs text-primary hover:underline">
              {linkLabel ?? "Open"} →
            </Link>
          )}
        </div>
        {loading ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>
        ) : error ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Couldn't load this list.</p>
        ) : empty ? (
          <p className="py-6 text-center text-sm text-muted-foreground">{emptyText}</p>
        ) : (
          children
        )}
      </CardContent>
    </Card>
  );
}

/**
 * A work card whose data arrives in a later phase (low pick faces need
 * Phase 2 replenishment). Muted, no number, same footprint as a StatCard.
 */
export function PhaseCard({
  title,
  subtitle,
  icon: Icon,
  phase = "Phase 2",
}: {
  title: string;
  subtitle: string;
  icon: ComponentType<{ className?: string }>;
  phase?: string;
}) {
  return (
    <Card className="bg-muted/20 opacity-60" title={`Arrives with ${phase}`}>
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="space-y-1">
            <p className="text-sm text-muted-foreground">{title}</p>
            <Badge variant="outline" className="text-[10px] text-muted-foreground">
              {phase}
            </Badge>
            <p className="text-xs italic text-muted-foreground">{subtitle}</p>
          </div>
          <div className="rounded-md bg-muted p-2 text-muted-foreground/40">
            <Icon className="h-5 w-5" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
