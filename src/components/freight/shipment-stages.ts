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

// ---------------------------------------------------------------------------
// With the physical layer (design §7, migration 20261023000001) the detail
// page adds two stages around Received:
//   … Ground → Label cartons → Received → Put away
// Label cartons is the dock's check-in, each carton getting its LPN label;
// Put away is the cartons (or loose units) leaving IN-01 for a bay.
//   * Once check-in has started (an LPN or a putaway task exists) the
//     transit stages read done: the cartons are on the dock, whatever the
//     carrier feed says.
//   * Label cartons: current while any carton is labelled and the shipment
//     is not fully received or a label is still unprinted; done once
//     received with every label printed. Shown only for a carton plan.
//   * Put away: current once received with tasks still open; done when
//     every task is; before receipt it stays future but shows its count.
// ---------------------------------------------------------------------------

export const LABEL_STAGE = "Label cartons";
export const PUTAWAY_STAGE = "Put away";

/** What the physical layer knows about one shipment. */
export interface WarehouseProgress {
  /** Cartons in the carton plan (0 for a shipment received as loose units). */
  cartonsPlanned: number;
  /** Live LPNs minted so far (voided ones excluded) and how many have their label printed. */
  labelled: number;
  printed: number;
  /** Putaway tasks (cartons and loose units, cancelled excluded) and how many are done. */
  putawayTotal: number;
  putawayDone: number;
}

export interface StageView {
  label: string;
  state: StageState;
  /** "21/31" under a warehouse stage; null for the dated transit stages. */
  progress: string | null;
}

export function stagesWithWarehouse(
  shipment: StageShipment,
  wh: WarehouseProgress | null,
): { stages: StageView[]; deliveredUnconfirmed: boolean } {
  const base = stageStates(shipment);
  if (!wh) {
    return {
      stages: STAGE_LABELS.map((label, i) => ({ label, state: base.states[i], progress: null })),
      deliveredUnconfirmed: base.deliveredUnconfirmed,
    };
  }
  const received = !!shipment.receipt_confirmed_at;
  const checkInStarted = wh.labelled > 0 || wh.putawayTotal > 0;
  const stages: StageView[] = STAGE_LABELS.slice(0, 4).map((label, i) => ({
    label,
    state: checkInStarted ? "done" : base.states[i],
    progress: null,
  }));

  if (wh.cartonsPlanned > 0 || wh.labelled > 0) {
    const labelDone = received && wh.labelled > 0 && wh.printed >= wh.labelled;
    stages.push({
      label: LABEL_STAGE,
      state: labelDone ? "done" : wh.labelled > 0 ? "current" : "future",
      progress:
        received && wh.printed < wh.labelled
          ? `${wh.printed}/${wh.labelled} printed`
          : `${wh.labelled}/${Math.max(wh.cartonsPlanned, wh.labelled)}`,
    });
  }

  stages.push({ label: STAGE_LABELS[4], state: base.states[4], progress: null });

  const putawayDone = received && wh.putawayTotal > 0 && wh.putawayDone >= wh.putawayTotal;
  stages.push({
    label: PUTAWAY_STAGE,
    state: putawayDone ? "done" : received && wh.putawayTotal > 0 ? "current" : "future",
    progress: wh.putawayTotal > 0 ? `${wh.putawayDone}/${wh.putawayTotal}` : null,
  });

  return { stages, deliveredUnconfirmed: base.deliveredUnconfirmed };
}
