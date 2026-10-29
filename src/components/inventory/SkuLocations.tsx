import { useId, useState } from "react";
import { format, parseISO } from "date-fns";
import { ChevronRight } from "lucide-react";
import { CartonLink } from "@/components/warehouse/CartonLink";
import { LocationCode } from "@/components/warehouse/LocationCode";
import { BUCKET_WORDS } from "@/lib/hooks/use-warehouse-counts";
import type { WhBucket } from "@/lib/hooks/use-warehouse";
import {
  useWhSkuLocations,
  VIRTUAL_LOCATION_WORDS,
  type WhSkuLocation,
  type WhSkuLocationCarton,
} from "@/lib/hooks/use-warehouse-sku-locations";
import { CONTAINER_STATE_COLORS, WH_ZONE_COLORS } from "@/lib/status-colors";
import { cn } from "@/lib/utils";

/**
 * The SKU drawer's Locations section (owner request 2026-10-29): every
 * location holding the SKU, in walk order, each a row that expands to the
 * cartons (LPNs) there plus any loose units. Carton codes link to the carton
 * passport; following one leaves the Stock page, which unmounts the drawer.
 */

interface SkuLocationsProps {
  skuId: string;
  productSku: string;
  /** False while the drawer is closed, so nothing is fetched. */
  enabled?: boolean;
}

const CHIP = "inline-flex items-center whitespace-nowrap rounded-full border px-1.5 py-px text-[10px] font-semibold leading-4";
const GREEN_CHIP = "border-green-500/40 bg-green-500/10 text-green-400";

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

function bucketWord(b: WhBucket): string {
  return BUCKET_WORDS[b] ?? b.replace(/_/g, " ");
}

/** "Oct 12" this year, "Oct 12 '25" before it. */
function shortDate(iso: string | null): string {
  if (!iso) return "—";
  const d = parseISO(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return format(d, d.getFullYear() === new Date().getFullYear() ? "MMM d" : "MMM d ''yy");
}

function LocationName({ location }: { location: WhSkuLocation["location"] }) {
  const words = location.kind === "virtual" ? VIRTUAL_LOCATION_WORDS[location.code] : undefined;
  if (words) {
    return (
      <span className="text-base font-semibold" title={location.code}>
        {words}
      </span>
    );
  }
  return <LocationCode code={location.code} size="small" />;
}

function CartonRow({ carton }: { carton: WhSkuLocationCarton }) {
  const green = carton.label_stock === "green";
  const received = carton.created_at ? parseISO(carton.created_at) : null;
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-3 px-3 py-1.5">
      <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
        <CartonLink code={carton.code} className="text-sm font-semibold" />
        <span
          className={cn(CHIP, green ? GREEN_CHIP : CONTAINER_STATE_COLORS[carton.state])}
          title={green ? `${carton.state} · green RTS label` : carton.state}
        >
          {carton.state}
          {green && <span className="sr-only"> (green label)</span>}
        </span>
        <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
          {carton.buckets.map(bucketWord).join(" + ")}
        </span>
      </span>
      <span className="text-right text-sm font-semibold tabular-nums">{carton.qty.toLocaleString()}</span>
      <span
        className="w-[4.5rem] text-right text-xs tabular-nums text-muted-foreground"
        title={received && !Number.isNaN(received.getTime()) ? `Received ${format(received, "PP")}` : undefined}
      >
        {shortDate(carton.created_at)}
      </span>
    </li>
  );
}

function LocationRow({ entry, expanded, onToggle }: { entry: WhSkuLocation; expanded: boolean; onToggle: () => void }) {
  const panelId = useId();
  const { location, units, cartons, loose } = entry;
  const virtual = location.kind === "virtual";
  const hasLoose = loose.some((l) => l.units > 0);
  const contents = [cartons.length ? plural(cartons.length, "carton") : null, hasLoose ? "loose" : null]
    .filter(Boolean)
    .join(" + ");

  return (
    <li>
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={expanded ? panelId : undefined}
        onClick={onToggle}
        className={cn(
          "flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-muted/40",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        )}
      >
        <ChevronRight
          aria-hidden
          className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", expanded && "rotate-90")}
        />
        <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
          <LocationName location={location} />
          {!virtual && location.zone && (
            <span className={cn(CHIP, WH_ZONE_COLORS[location.zone] ?? WH_ZONE_COLORS.MISC)}>{location.zone}</span>
          )}
          {location.is_overflow && <span className="text-xs font-semibold text-amber-400">overflow</span>}
        </span>
        <span className="shrink-0 text-right leading-tight">
          <span className="block text-sm font-semibold tabular-nums">{plural(units, "unit")}</span>
          {contents && <span className="block text-[11px] text-muted-foreground">{contents}</span>}
        </span>
      </button>
      {expanded && (
        <ul
          id={panelId}
          aria-label={`Cartons at ${location.code}`}
          className="divide-y divide-border/40 border-t border-border/40 bg-muted/20 pl-6"
        >
          {cartons.map((c) => (
            <CartonRow key={c.id} carton={c} />
          ))}
          {loose.map((l) => (
            <li key={l.bucket} className="px-3 py-1.5 text-xs text-muted-foreground">
              Loose · <span className="font-semibold tabular-nums text-foreground">{l.units.toLocaleString()}</span> units ·{" "}
              <span className="uppercase tracking-wide">{bucketWord(l.bucket)}</span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

export function SkuLocations({ skuId, productSku, enabled = true }: SkuLocationsProps) {
  const { data, isLoading, isError, error } = useWhSkuLocations(skuId, enabled);
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const locations = data ?? [];
  const errorMessage = (error as { message?: unknown } | null)?.message;
  const totalUnits = locations.reduce((s, l) => s + l.units, 0);

  function toggle(id: string) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <h3 className="text-sm font-medium">Locations</h3>
        {!isLoading && !isError && locations.length > 0 && (
          <span className="text-xs text-muted-foreground tabular-nums">
            {plural(totalUnits, "unit")} in {plural(locations.length, "location")}
          </span>
        )}
      </div>

      {isLoading ? (
        <div className="space-y-1.5" role="status" aria-label="Loading locations">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-10 animate-pulse rounded-md bg-muted/50" />
          ))}
        </div>
      ) : isError ? (
        <p className="rounded-md border border-dashed border-border/60 px-3 py-2 text-xs text-muted-foreground">
          Couldn't load locations{typeof errorMessage === "string" && errorMessage ? `: ${errorMessage}` : "."}
        </p>
      ) : locations.length === 0 ? (
        <p className="rounded-md border border-dashed border-border/60 px-3 py-2 text-xs text-muted-foreground">
          Not in any warehouse location yet
        </p>
      ) : (
        <ul
          aria-label={`Locations of ${productSku}`}
          className="divide-y divide-border/50 overflow-hidden rounded-md border border-border/60"
        >
          {locations.map((entry) => (
            <LocationRow
              key={entry.location.id}
              entry={entry}
              expanded={open.has(entry.location.id)}
              onToggle={() => toggle(entry.location.id)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
