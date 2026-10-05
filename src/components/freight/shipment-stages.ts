import type { FreightShipment } from "@/types/database";

// ---------------------------------------------------------------------------
// shipment-stages — where a freight shipment stands on the five stages
// Created → Shipped → Customs → Ground → Received: which are done, which is
// current, which lie ahead. Pure, so the freight detail stepper and the
// launch supply ledger's mini stepper draw the same answer at two sizes.
//
// Status → active stage (owner-approved prototype):
//   pending                    → Created done, Shipped still pending
//   on_the_water / high_risk   → Shipped active (the detail page adds the red
//                                customs-inspection note for high_risk)
//   cleared_customs            → Customs active
//   tracking / out_for_delivery→ Ground active
//   delivered                  → Received when receipt_confirmed_at is set,
//                                else Ground active with deliveredUnconfirmed
//                                raised (the dock hasn't checked it in yet)
// ---------------------------------------------------------------------------

export type StageState = "done" | "current" | "future";

/** Stage names in order; stageStates returns one state per entry. */
export const STAGE_LABELS = ["Created", "Shipped", "Customs", "Ground", "Received"] as const;

/** The two columns the mapping reads — a full row or the launch ledger's narrow shipment select. */
export type StageShipment = Pick<FreightShipment, "status" | "receipt_confirmed_at">;

export function stageStates(shipment: StageShipment): { states: StageState[]; deliveredUnconfirmed: boolean } {
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

  const states = STAGE_LABELS.map((_, i): StageState => {
    if (i < doneThrough) return "done";
    if (current !== null && i === current) return "current";
    return "future";
  });
  return { states, deliveredUnconfirmed };
}
