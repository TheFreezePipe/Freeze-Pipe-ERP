/**
 * Work-back schedule from a target launch date — the one place the ERP
 * computes "when must we order / ship / arrive" so the PD board, the
 * marketing calendar, and the Launches page can never disagree.
 *
 * Owner-supplied timings (2026-08-19): manufacturing ~30d, sea transit ~35d,
 * air ~15d, arrival 10–14d before launch (default 12). These replace the
 * single combined LEAD_DAYS=75 that Launches.tsx carried.
 */

export const WORKBACK = {
  manufacturingDays: 30,
  seaTransitDays: 35,
  airTransitDays: 15,
  arrivalBufferDays: 12,
} as const;

export interface WorkbackOptions {
  manufacturingDays?: number;
  seaTransitDays?: number;
  airTransitDays?: number;
  arrivalBufferDays?: number;
  /** Extra days to back off order-by for the sample loop (PD cards only). */
  sampleLoopDays?: number;
}

export interface WorkbackChain {
  launch: string;
  arriveBy: string;
  shipBy: string;
  /** Latest PO date if the shipment goes by sea. */
  orderBy: string;
  /** Latest PO date if the shipment goes by air instead. */
  orderByAir: string;
  /** Only when sampleLoopDays is supplied. */
  specBy: string | null;
}

const DAY_MS = 86_400_000;

export function addDaysIso(iso: string, days: number): string {
  return new Date(Date.parse(iso + "T00:00:00Z") + days * DAY_MS).toISOString().slice(0, 10);
}

export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(toIso + "T00:00:00Z") - Date.parse(fromIso + "T00:00:00Z")) / DAY_MS);
}

/** Backward from a launch date: arrive → ship → order (sea / air) → spec. */
export function workback(launchIso: string, opts: WorkbackOptions = {}): WorkbackChain {
  const mfg = opts.manufacturingDays ?? WORKBACK.manufacturingDays;
  const sea = opts.seaTransitDays ?? WORKBACK.seaTransitDays;
  const air = opts.airTransitDays ?? WORKBACK.airTransitDays;
  const buf = opts.arrivalBufferDays ?? WORKBACK.arrivalBufferDays;
  const arriveBy = addDaysIso(launchIso, -buf);
  const shipBy = addDaysIso(arriveBy, -sea);
  const orderBy = addDaysIso(shipBy, -mfg);
  const orderByAir = addDaysIso(addDaysIso(arriveBy, -air), -mfg);
  const specBy = opts.sampleLoopDays != null ? addDaysIso(orderBy, -opts.sampleLoopDays) : null;
  return { launch: launchIso, arriveBy, shipBy, orderBy, orderByAir, specBy };
}

/**
 * Order-by for an existing Launch row, from its inventory_ready_by date:
 * ready-by IS the arrival target, so order-by = ready-by − transit − make.
 * (Launches.tsx used ready-by − 75; same intent, now split.)
 */
export function orderByFromReadyBy(readyByIso: string, opts: WorkbackOptions = {}): string {
  const mfg = opts.manufacturingDays ?? WORKBACK.manufacturingDays;
  const sea = opts.seaTransitDays ?? WORKBACK.seaTransitDays;
  return addDaysIso(readyByIso, -(sea + mfg));
}

export type DeadlineState = "ok" | "tight" | "late";

/** Risk reading for a single deadline relative to today. */
export function deadlineState(deadlineIso: string, todayIso: string, tightDays = 14): DeadlineState {
  const d = daysBetween(todayIso, deadlineIso);
  if (d < 0) return "late";
  if (d < tightDays) return "tight";
  return "ok";
}
