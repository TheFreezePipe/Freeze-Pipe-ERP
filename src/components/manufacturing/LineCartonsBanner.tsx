import { useState } from "react";
import { Link } from "react-router-dom";
import { ChevronDown, ChevronRight, Package } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { LocationCode } from "@/components/warehouse/LocationCode";
import { useWhLineCartons, type WhLineCarton } from "@/lib/hooks/use-warehouse-mfg";
import { cn } from "@/lib/utils";

const SHOWN = 4;

/**
 * Top of the Workspace once the physical layer is live (design §5.7): "N
 * cartons waiting for a bay" lists the green cartons relabelled at RTS that
 * are still at MFG-LINE with an open putaway (the worker's own first), each
 * linking to /go/putaway?lpn=; "N raw cartons at the line" shows what was
 * pulled to the line. Live through Realtime plus a 60 s refetch; renders
 * nothing when the line is clear.
 */
export function LineCartonsBanner({ me }: { me: string | null }) {
  const { data } = useWhLineCartons(me);
  const [showAll, setShowAll] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const waiting = data?.waiting ?? [];
  const raw = data?.raw ?? [];
  if (waiting.length === 0 && raw.length === 0) return null;

  const shown = showAll ? waiting : waiting.slice(0, SHOWN);

  return (
    <Card className={cn(waiting.length > 0 && "border-amber-500/40")}>
      <CardContent className="space-y-2 p-3">
        {waiting.length > 0 && (
          <>
            <p className="flex items-center gap-2 text-sm font-semibold">
              <span className="h-3 w-3 rounded-sm bg-green-400" aria-hidden />
              {waiting.length} carton{waiting.length === 1 ? "" : "s"} waiting for a bay
            </p>
            <div className="space-y-1.5">
              {shown.map((c) => (
                <WaitingRow key={c.id} carton={c} mine={!!me && (c.finished_by === me || c.putaway?.created_by === me)} />
              ))}
            </div>
            {waiting.length > SHOWN && (
              <button
                type="button"
                className="text-xs text-muted-foreground underline-offset-2 hover:underline"
                onClick={() => setShowAll((v) => !v)}
              >
                {showAll ? "Show fewer" : `Show all ${waiting.length}`}
              </button>
            )}
          </>
        )}

        {raw.length > 0 && (
          <div className={cn(waiting.length > 0 && "border-t border-border pt-2")}>
            <button
              type="button"
              className="flex w-full items-center gap-2 text-left text-sm text-muted-foreground touch-manipulation"
              onClick={() => setShowRaw((v) => !v)}
              aria-expanded={showRaw}
            >
              <Package className="h-4 w-4" />
              <span className="flex-1">
                {raw.length} raw carton{raw.length === 1 ? "" : "s"} at the line
              </span>
              {showRaw ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            </button>
            {showRaw && (
              <ul className="mt-1.5 space-y-1 text-xs">
                {raw.map((c) => (
                  <li key={c.id} className="flex items-center gap-2">
                    <span className="h-2.5 w-2.5 shrink-0 rounded-sm border border-slate-400 bg-slate-200" aria-label="white label" />
                    <span className="font-mono font-semibold tabular-nums">{c.code}</span>
                    <span className="truncate text-muted-foreground">
                      {c.sku?.sku ?? "MIXED"} · {c.qty} units · {c.state}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function WaitingRow({ carton, mine }: { carton: WhLineCarton; mine: boolean }) {
  return (
    <Link
      to={`/go/putaway?lpn=${encodeURIComponent(carton.code)}`}
      className="flex min-h-[48px] items-center gap-3 rounded-lg border border-border px-3 py-1.5 transition-colors touch-manipulation hover:bg-muted/40"
    >
      <span className="min-w-0 flex-1">
        <span className="block font-mono text-sm font-semibold tabular-nums">
          {carton.code}
          {mine && <span className="ml-2 font-sans text-[11px] font-normal text-green-400">yours</span>}
        </span>
        <span className="block truncate text-xs text-muted-foreground">
          {carton.sku?.sku ?? "MIXED"} · {carton.qty} units
        </span>
      </span>
      {carton.putaway?.suggested_code ? (
        <LocationCode code={carton.putaway.suggested_code} size="small" />
      ) : (
        <span className="text-xs text-muted-foreground">any bay</span>
      )}
      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
    </Link>
  );
}
