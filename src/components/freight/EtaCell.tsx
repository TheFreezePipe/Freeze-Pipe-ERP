import { format, parseISO, formatDistanceToNow } from "date-fns";
import { TrendingUp, TrendingDown, Check, Clock, FlaskConical } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { FreightShipment } from "@/types/database";
import { etaDriftDays } from "@/lib/tracking/reconcile";
import { isCarrierMock } from "@/lib/tracking/providers";

interface EtaCellProps {
  shipment: FreightShipment;
  /** Compact for table rows; "full" for detail pages. */
  variant?: "compact" | "full";
}

/**
 * Renders a shipment's ETA with a drift indicator when it differs from the
 * original ETA, plus a freshness hint ("Checked 2h ago") when available.
 */
export function EtaCell({ shipment, variant = "compact" }: EtaCellProps) {
  if (!shipment.eta) {
    return <span className="text-muted-foreground">-</span>;
  }

  const drift = etaDriftDays(shipment);
  const isLate = drift > 0;
  const isEarly = drift < 0;
  const hasDrift = drift !== 0;

  const lastChecked = shipment.eta_last_checked_at;
  const freshness = lastChecked
    ? formatDistanceToNow(parseISO(lastChecked), { addSuffix: true })
    : null;
  // Whether this shipment's carrier is one of the providers currently
  // returning mock data. Surfaced in the tooltip + as a small flask
  // icon next to the ETA so operators don't read mock progressions as
  // real-world updates.
  const usingMock = isCarrierMock(shipment.carrier_name);

  const etaFormat = variant === "full" ? "MMM d, yyyy" : "MMM d";
  const etaLabel = format(parseISO(shipment.eta), etaFormat);
  const originalLabel = shipment.eta_original
    ? format(parseISO(shipment.eta_original), etaFormat)
    : null;

  const tooltipBody = (
    <div className="space-y-1 text-xs">
      {hasDrift && originalLabel && (
        <div>
          <span className="text-muted-foreground">Originally: </span>
          <span className="line-through">{originalLabel}</span>
        </div>
      )}
      {hasDrift && (
        <div>
          <span className={cn(isLate ? "text-red-400" : "text-green-400", "font-medium")}>
            {isLate ? `${drift} day${drift === 1 ? "" : "s"} later` : `${Math.abs(drift)} day${drift === -1 ? "" : "s"} earlier`}
          </span>
        </div>
      )}
      {freshness && (
        <div className="text-muted-foreground">Checked {freshness}</div>
      )}
      {!freshness && (
        <div className="text-muted-foreground">Not yet checked</div>
      )}
      {usingMock && (
        <div className="text-amber-300/80 inline-flex items-center gap-1 pt-1 mt-1 border-t border-border/40">
          <FlaskConical className="h-3 w-3" />
          Mock tracking data — real {shipment.carrier_name} API not yet connected
        </div>
      )}
    </div>
  );

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex items-center gap-1 cursor-help">
            <span
              className={cn(
                "tabular-nums",
                isLate && "text-red-400 font-medium",
                isEarly && "text-green-400 font-medium"
              )}
            >
              {etaLabel}
            </span>
            {isLate && <TrendingUp className="h-3 w-3 text-red-400" aria-label="ETA pushed out" />}
            {isEarly && <TrendingDown className="h-3 w-3 text-green-400" aria-label="ETA pulled in" />}
            {!hasDrift && freshness && (
              <Check className="h-3 w-3 text-muted-foreground/60" aria-label="ETA confirmed" />
            )}
            {!freshness && (
              <Clock className="h-3 w-3 text-muted-foreground/40" aria-label="Not yet checked" />
            )}
            {usingMock && (
              <FlaskConical
                className="h-3 w-3 text-amber-400/70"
                aria-label="Mock tracking data"
              />
            )}
          </span>
        </TooltipTrigger>
        <TooltipContent>{tooltipBody}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
