import { useMemo, useState } from "react";
import { format, parseISO } from "date-fns";
import { Check, ChevronDown, ChevronUp } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { FreightShipment } from "@/types/database";

// ---------------------------------------------------------------------------
// ShipmentStepper — horizontal Created → Shipped → Customs → Ground → Received
// stepper for the freight detail page (replaces the old status timeline card).
//
// Status → active stage mapping (owner-approved prototype):
//   pending                    → Created done, Shipped still pending
//   on_the_water / high_risk   → Shipped active (high_risk adds the red
//                                customs-inspection note below)
//   cleared_customs            → Customs active
//   tracking / out_for_delivery→ Ground active
//   delivered                  → Received when receipt_confirmed_at is set,
//                                else Ground active + "awaiting dock
//                                check-in" note
//
// Done = green dot with check, current = accent dot with halo, future =
// hollow dot. Beneath the stepper a right-aligned "Scan history (N events)"
// collapsible (collapsed by default — owner decision) lists every dated
// milestone we know about. The app doesn't persist raw carrier scan events,
// so the list is derived from the shipment's own timestamps (created,
// shipped, tracking checks, carrier piece scans, delivery, receipt).
// ---------------------------------------------------------------------------

interface Props {
  shipment: FreightShipment;
}

type StageState = "done" | "current" | "future";

interface Stage {
  label: string;
  state: StageState;
  /** ISO date/timestamp shown under the label (null = no knowledge yet). */
  date: string | null;
}

interface ScanEvent {
  /** ISO timestamp (or date-only string) used for ordering + display. */
  at: string;
  /** True when `at` is a date-only value (no meaningful time of day). */
  dateOnly: boolean;
  label: string;
  detail?: string | null;
}

function stageStates(shipment: FreightShipment): { states: StageState[]; deliveredUnconfirmed: boolean } {
  const confirmed = !!shipment.receipt_confirmed_at;
  // Index of the CURRENT stage; everything before it is done.
  // null = nothing active (pending: Created is done, Shipped not started;
  // fully received: everything done).
  let current: number | null;
  let doneThrough: number; // stages with index < doneThrough render as done
  let deliveredUnconfirmed = false;

  switch (shipment.status) {
    case "pending":
      current = null;
      doneThrough = 1; // Created
      break;
    case "on_the_water":
    case "high_risk":
      current = 1;
      doneThrough = 1;
      break;
    case "cleared_customs":
      current = 2;
      doneThrough = 2;
      break;
    case "tracking":
    case "out_for_delivery":
      current = 3;
      doneThrough = 3;
      break;
    case "delivered":
      if (confirmed) {
        current = null;
        doneThrough = 5; // everything done
      } else {
        // Carrier says delivered but the dock hasn't confirmed receipt —
        // stay on Ground with a note rather than showing Received.
        current = 3;
        doneThrough = 3;
        deliveredUnconfirmed = true;
      }
      break;
    default:
      current = null;
      doneThrough = 1;
      break;
  }

  const states: StageState[] = [0, 1, 2, 3, 4].map((i) => {
    if (i < doneThrough) return "done";
    if (current !== null && i === current) return "current";
    return "future";
  });
  return { states, deliveredUnconfirmed };
}

export function ShipmentStepper({ shipment }: Props) {
  const [historyOpen, setHistoryOpen] = useState(false);

  const { states, deliveredUnconfirmed } = stageStates(shipment);
  const isHighRisk = shipment.status === "high_risk";

  // Ground-phase knowledge: prefer an actual carrier piece scan, then the
  // piece-count refresh, then the carrier-reported arrival date.
  const groundDate =
    shipment.carrier_last_piece_event_at ??
    shipment.carrier_pieces_updated_at ??
    shipment.actual_arrival_date;

  const stages: Stage[] = [
    { label: "Created", state: states[0], date: shipment.created_at },
    { label: "Shipped", state: states[1], date: shipment.ship_date },
    // No dedicated customs-cleared timestamp exists on the shipment row;
    // the stage renders dateless until one is persisted.
    { label: "Customs", state: states[2], date: null },
    { label: "Ground", state: states[3], date: groundDate },
    { label: "Received", state: states[4], date: shipment.receipt_confirmed_at },
  ];

  const events = useMemo<ScanEvent[]>(() => {
    const list: ScanEvent[] = [];
    list.push({ at: shipment.created_at, dateOnly: false, label: "Shipment created" });
    if (shipment.ship_date) {
      list.push({ at: shipment.ship_date, dateOnly: true, label: "Shipped by supplier" });
    }
    if (shipment.status_overridden_at) {
      list.push({
        at: shipment.status_overridden_at,
        dateOnly: false,
        label: "Status manually overridden",
      });
    }
    if (shipment.eta_last_checked_at) {
      list.push({
        at: shipment.eta_last_checked_at,
        dateOnly: false,
        label: "Carrier tracking checked",
        detail: shipment.eta ? `ETA ${format(parseISO(shipment.eta), "MMM d")}` : null,
      });
    }
    const pieceScanAt = shipment.carrier_last_piece_event_at ?? shipment.carrier_pieces_updated_at;
    if (pieceScanAt) {
      const bits: string[] = [];
      if (shipment.carrier_pieces_delivered != null) {
        bits.push(
          shipment.carrier_pieces_total != null
            ? `${shipment.carrier_pieces_delivered.toLocaleString()} of ${shipment.carrier_pieces_total.toLocaleString()} pieces delivered`
            : `${shipment.carrier_pieces_delivered.toLocaleString()} pieces delivered`,
        );
      }
      if (shipment.carrier_pieces_on_vehicle != null && shipment.carrier_pieces_on_vehicle > 0) {
        bits.push(`${shipment.carrier_pieces_on_vehicle.toLocaleString()} on a truck`);
      }
      list.push({
        at: pieceScanAt,
        dateOnly: false,
        label: "Carrier piece scan",
        detail: bits.length > 0 ? bits.join(" · ") : null,
      });
    }
    if (shipment.actual_arrival_date) {
      list.push({
        at: shipment.actual_arrival_date,
        dateOnly: true,
        label: "Carrier reported delivered",
      });
    }
    if (shipment.receipt_confirmed_at) {
      list.push({
        at: shipment.receipt_confirmed_at,
        dateOnly: false,
        label: "Receipt confirmed — inventory credited",
      });
    }
    if (shipment.closed_short_at) {
      list.push({
        at: shipment.closed_short_at,
        dateOnly: false,
        label: "Closed short",
        detail: shipment.closed_short_reason,
      });
    }
    // Newest first.
    return list.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  }, [shipment]);

  return (
    <Card>
      <CardContent className="pt-6">
        {/* Horizontal stepper */}
        <div className="flex items-start">
          {stages.map((stage, i) => {
            const prevDone = i > 0 && stages[i - 1].state === "done";
            const thisReached = stage.state !== "future";
            return (
              <div key={stage.label} className="flex flex-col items-center flex-1 min-w-0">
                <div className="flex items-center w-full">
                  {i > 0 && (
                    <div className={cn("h-0.5 flex-1", prevDone && thisReached ? "bg-green-500/60" : "bg-muted")} />
                  )}
                  {stage.state === "done" ? (
                    <div className="h-7 w-7 rounded-full bg-green-500/90 text-background flex items-center justify-center shrink-0">
                      <Check className="h-3.5 w-3.5" strokeWidth={3} />
                    </div>
                  ) : stage.state === "current" ? (
                    <div className="h-7 w-7 rounded-full bg-primary ring-4 ring-primary/20 flex items-center justify-center shrink-0">
                      <div className="h-2 w-2 rounded-full bg-primary-foreground" />
                    </div>
                  ) : (
                    <div className="h-7 w-7 rounded-full border-2 border-border bg-transparent shrink-0" />
                  )}
                  {i < stages.length - 1 && (
                    <div className={cn("h-0.5 flex-1", stage.state === "done" ? "bg-green-500/60" : "bg-muted")} />
                  )}
                </div>
                <p
                  className={cn(
                    "text-xs mt-2 font-medium truncate max-w-full",
                    stage.state === "current" && "text-primary",
                    stage.state === "done" && "text-foreground",
                    stage.state === "future" && "text-muted-foreground",
                  )}
                >
                  {stage.label}
                </p>
                <p className="text-[10px] text-muted-foreground tabular-nums">
                  {stage.date ? format(parseISO(stage.date), "MMM d") : "—"}
                </p>
              </div>
            );
          })}
        </div>

        {isHighRisk && (
          <div className="mt-4 rounded-lg bg-red-500/10 border border-red-500/20 p-3 text-sm text-red-400">
            This shipment is under customs inspection (High Risk). Timeline is paused until cleared.
          </div>
        )}
        {deliveredUnconfirmed && (
          <div className="mt-4 rounded-lg bg-amber-500/10 border border-amber-500/20 p-3 text-sm text-amber-400">
            Carrier reports delivered — awaiting dock check-in before this counts as received.
          </div>
        )}

        {/* Scan history — collapsed by default (owner decision) */}
        <div className="mt-3 flex justify-end">
          <button
            type="button"
            onClick={() => setHistoryOpen((o) => !o)}
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            Scan history ({events.length} event{events.length === 1 ? "" : "s"})
            {historyOpen ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          </button>
        </div>
        {historyOpen && (
          <div className="mt-2 border-t border-border/50 pt-3 space-y-2.5">
            {events.map((ev, i) => (
              <div key={`${ev.at}-${ev.label}-${i}`} className="flex items-start gap-2.5">
                <div className="h-1.5 w-1.5 rounded-full bg-primary/70 mt-1.5 shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="text-xs">
                    {ev.label}
                    {ev.detail && <span className="text-muted-foreground"> — {ev.detail}</span>}
                  </p>
                </div>
                <p className="text-[11px] text-muted-foreground tabular-nums shrink-0">
                  {format(parseISO(ev.at), ev.dateOnly ? "MMM d, yyyy" : "MMM d, h:mm a")}
                </p>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
