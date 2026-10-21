import { Link } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { stockView } from "@/lib/inventory-routes";
import { cn } from "@/lib/utils";

/** Units by stage, plus the two pipeline buckets, summed across SKUs. */
export interface StockStages {
  raw: number;
  prefilled: number;
  inProduction: number;
  finished: number;
  other: number;
  inTransit: number;
  onOrder: number;
}

interface Segment {
  key: keyof StockStages;
  label: string;
  /** Bar fill (also the legend swatch). */
  fill: string;
  /** Label colour on the bar. */
  text: string;
}

// Stages first (what is in the building), then what is coming.
const SEGMENTS: Segment[] = [
  { key: "raw", label: "Raw", fill: "bg-slate-400", text: "text-slate-950" },
  { key: "prefilled", label: "Pre-filled", fill: "bg-purple-400", text: "text-purple-950" },
  { key: "inProduction", label: "In production", fill: "bg-orange-400", text: "text-orange-950" },
  { key: "finished", label: "Finished", fill: "bg-green-400", text: "text-green-950" },
  { key: "other", label: "Other", fill: "bg-zinc-500", text: "text-zinc-950" },
  { key: "inTransit", label: "In transit", fill: "bg-blue-400", text: "text-blue-950" },
  {
    key: "onOrder",
    label: "On order",
    fill: "bg-muted border border-dashed border-muted-foreground/60",
    text: "text-foreground",
  },
];

/** Below this share of the bar a segment drops its inline label (the legend has it). */
const MIN_LABEL_SHARE = 0.12;

/**
 * "Where the stock is": one stacked bar of units by stage, in transit and on
 * order. Same buckets and math as the Stock page's KPI band.
 */
export function StockStrip({
  stages,
  activeSkus,
  loading,
}: {
  stages: StockStages;
  activeSkus: number;
  loading?: boolean;
}) {
  const total = SEGMENTS.reduce((sum, s) => sum + stages[s.key], 0);
  // "Other" is a rare bucket; keep it out of the bar and legend when empty.
  const shown = SEGMENTS.filter((s) => s.key !== "other" || stages.other > 0);

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Where the stock is
            {!loading && activeSkus > 0 && <span> · {activeSkus.toLocaleString()} active SKUs</span>}
          </h2>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Link to={stockView("sku")} className="text-primary hover:underline">
              By SKU
            </Link>
            <span>·</span>
            <Link to={stockView("location")} className="text-primary hover:underline">
              By location
            </Link>
            <span>·</span>
            <Link to={stockView("map")} className="text-primary hover:underline">
              Map
            </Link>
          </div>
        </div>

        {loading ? (
          <div className="h-6 animate-pulse rounded-md bg-muted" />
        ) : total === 0 ? (
          <div className="flex h-6 items-center justify-center rounded-md bg-muted text-xs text-muted-foreground">
            No units on record
          </div>
        ) : (
          <div
            className="flex h-6 overflow-hidden rounded-md bg-muted text-[11px] font-semibold"
            role="img"
            aria-label="Units by stage, in transit and on order"
          >
            {shown.map((s) => {
              const share = stages[s.key] / total;
              if (share <= 0) return null;
              return (
                <div
                  key={s.key}
                  className={cn("flex items-center justify-center overflow-hidden whitespace-nowrap", s.fill, s.text)}
                  style={{ width: `${share * 100}%` }}
                  title={`${s.label}: ${stages[s.key].toLocaleString()}`}
                >
                  {share >= MIN_LABEL_SHARE && `${s.label} ${stages[s.key].toLocaleString()}`}
                </div>
              );
            })}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-xs text-muted-foreground">
          {shown.map((s) => (
            <span key={s.key} className="inline-flex items-center gap-1.5">
              <span className={cn("inline-block h-2.5 w-2.5 rounded-sm", s.fill)} />
              {s.label}
              <span className="tabular-nums text-foreground">{loading ? "—" : stages[s.key].toLocaleString()}</span>
            </span>
          ))}
          <span className="sm:ml-auto">
            Total{" "}
            <span className="font-semibold tabular-nums text-foreground">{loading ? "—" : total.toLocaleString()}</span>{" "}
            units
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
