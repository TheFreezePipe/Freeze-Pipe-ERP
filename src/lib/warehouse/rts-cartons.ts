/**
 * Cartons through manufacturing (design §5.7): the pure arithmetic behind the
 * Workspace carton steps.
 *
 * RTS relabel plan. A logged RTS batch of N finished units goes back into one
 * or more green cartons, plus an optional loose remainder sent to the SKU's
 * pick face. The plan starts as one sealed carton holding all N; "Add another
 * carton" splits it; removing a carton merges its units into a neighbour;
 * "Remainder loose to pick face" sends whatever no carton holds loose. The
 * rows must sum to N before rpc_wh_rts_relabel is called, and
 * rtsCartonsPayload() turns the plan into the RPC's p_cartons
 * ([{qty, state}] plus an optional {qty, loose: true}).
 *
 * Emptying. Cartons scanned at the start of an emptying task are taken to the
 * line; the task quantity is pre-filled from the units of the scanned cartons
 * of the task's SKU (takenUnits).
 */

export type RtsCartonState = "sealed" | "open";

export interface RtsCartonRow {
  /** Stable React key; never reused within a plan. */
  key: number;
  qty: number;
  state: RtsCartonState;
}

export interface RtsPlan {
  /** Units the plan must account for: the logged quantity, or less after a reduce. */
  total: number;
  cartons: RtsCartonRow[];
  /** Units sent loose to the SKU's pick face. */
  loose: number;
  nextKey: number;
}

/** One entry of rpc_wh_rts_relabel's p_cartons. */
export type RtsCartonEntry = { qty: number; state: RtsCartonState } | { qty: number; loose: true };

function wholeNonNegative(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
}

/** The starting plan: one sealed carton holding the whole batch (none for an empty batch). */
export function newRtsPlan(total: number): RtsPlan {
  const t = wholeNonNegative(total);
  return { total: t, cartons: t > 0 ? [{ key: 1, qty: t, state: "sealed" }] : [], loose: 0, nextKey: 2 };
}

/** Units the cartons and the loose remainder hold. */
export function assignedUnits(plan: RtsPlan): number {
  return plan.cartons.reduce((sum, c) => sum + c.qty, 0) + plan.loose;
}

/** Units no carton holds yet (negative when the rows hold more than the batch). */
export function unassignedUnits(plan: RtsPlan): number {
  return plan.total - assignedUnits(plan);
}

function splittable(plan: RtsPlan): number {
  for (let i = plan.cartons.length - 1; i >= 0; i -= 1) if (plan.cartons[i].qty >= 2) return i;
  return -1;
}

/** "Add another carton" has something to put in it: unassigned units, or a carton of 2 or more to split. */
export function canAddCarton(plan: RtsPlan): boolean {
  return unassignedUnits(plan) > 0 || splittable(plan) >= 0;
}

/**
 * "Add another carton". Unassigned units go into the new carton. Otherwise the
 * last carton holding 2 or more is split: it keeps a standard carton's worth
 * when it holds more than that (96 with a standard of 48 → 48 + 48), else half
 * rounded up (7 → 4 + 3), and the new carton takes the rest.
 */
export function addCarton(plan: RtsPlan, standardPerCarton?: number | null): RtsPlan {
  const free = unassignedUnits(plan);
  if (free > 0) {
    return { ...plan, cartons: [...plan.cartons, { key: plan.nextKey, qty: free, state: "sealed" }], nextKey: plan.nextKey + 1 };
  }
  const i = splittable(plan);
  if (i < 0) return plan;
  const row = plan.cartons[i];
  const std = standardPerCarton != null ? wholeNonNegative(standardPerCarton) : 0;
  const keep = std > 0 && std < row.qty ? std : Math.ceil(row.qty / 2);
  const cartons = plan.cartons.map((c, j) => (j === i ? { ...c, qty: keep } : c));
  cartons.splice(i + 1, 0, { key: plan.nextKey, qty: row.qty - keep, state: "sealed" });
  return { ...plan, cartons, nextKey: plan.nextKey + 1 };
}

/**
 * Remove a carton, merging its units into the carton before it (the one after
 * it when it is first). The only carton's units become unassigned.
 */
export function mergeCarton(plan: RtsPlan, key: number): RtsPlan {
  const i = plan.cartons.findIndex((c) => c.key === key);
  if (i < 0) return plan;
  const units = plan.cartons[i].qty;
  const rest = plan.cartons.filter((c) => c.key !== key);
  if (rest.length === 0) return { ...plan, cartons: rest };
  const into = i > 0 ? i - 1 : 0;
  return { ...plan, cartons: rest.map((c, j) => (j === into ? { ...c, qty: c.qty + units } : c)) };
}

/** Set one carton's units (whole, at least 0; the sum check reports any mismatch). */
export function setCartonQty(plan: RtsPlan, key: number, qty: number): RtsPlan {
  const q = wholeNonNegative(qty);
  return { ...plan, cartons: plan.cartons.map((c) => (c.key === key ? { ...c, qty: q } : c)) };
}

/** Sealed ↔ open (a partial carton goes back open). */
export function toggleCartonState(plan: RtsPlan, key: number): RtsPlan {
  return {
    ...plan,
    cartons: plan.cartons.map((c) => (c.key === key ? { ...c, state: c.state === "sealed" ? "open" : "sealed" } : c)),
  };
}

/** "Remainder loose to pick face": whatever no carton holds is sent loose. */
export function looseRemainder(plan: RtsPlan): RtsPlan {
  const free = unassignedUnits(plan);
  return free > 0 ? { ...plan, loose: plan.loose + free } : plan;
}

/** Take the loose remainder back (its units become unassigned). */
export function clearLoose(plan: RtsPlan): RtsPlan {
  return plan.loose > 0 ? { ...plan, loose: 0 } : plan;
}

/**
 * Shrink the plan to `newTotal` (the line holds less than was logged): the cut
 * comes off unassigned units first, then the loose remainder, then the last
 * cartons, dropping any that reach zero.
 */
export function reduceRtsPlan(plan: RtsPlan, newTotal: number): RtsPlan {
  const target = wholeNonNegative(newTotal);
  if (target >= plan.total) return plan;
  let cut = assignedUnits(plan) - target;
  let loose = plan.loose;
  const fromLoose = Math.min(Math.max(cut, 0), loose);
  loose -= fromLoose;
  cut -= fromLoose;
  const cartons = plan.cartons.map((c) => ({ ...c }));
  for (let i = cartons.length - 1; i >= 0 && cut > 0; i -= 1) {
    const take = Math.min(cut, cartons[i].qty);
    cartons[i].qty -= take;
    cut -= take;
  }
  return { ...plan, total: target, loose, cartons: cartons.filter((c) => c.qty > 0) };
}

export interface RtsPlanCheck {
  ok: boolean;
  problems: string[];
  assigned: number;
  unassigned: number;
}

/**
 * Whether the plan can be sent: every carton holds at least one unit, the rows
 * sum to the batch, and (with rts.require_relabel at a station) at least one
 * carton gets a green label.
 */
export function checkRtsPlan(plan: RtsPlan, opts: { requireCarton?: boolean } = {}): RtsPlanCheck {
  const problems: string[] = [];
  const assigned = assignedUnits(plan);
  const unassigned = plan.total - assigned;
  if (plan.total <= 0) problems.push("Set the quantity first.");
  plan.cartons.forEach((c, i) => {
    if (c.qty <= 0) problems.push(`Carton ${i + 1} is empty: give it units or remove it.`);
  });
  if (plan.total > 0 && unassigned > 0) {
    problems.push(`${unassigned} unit${unassigned === 1 ? " is" : "s are"} in no carton: add a carton or send the remainder loose.`);
  }
  if (unassigned < 0) problems.push(`The cartons hold ${-unassigned} more than the ${plan.total} logged.`);
  if (opts.requireCarton && plan.cartons.length === 0 && plan.total > 0) {
    problems.push("At least one carton needs a green label at this station.");
  }
  return { ok: problems.length === 0, problems, assigned, unassigned };
}

/** rpc_wh_rts_relabel's p_cartons: one entry per carton, then the loose remainder. */
export function rtsCartonsPayload(plan: RtsPlan): RtsCartonEntry[] {
  const out: RtsCartonEntry[] = plan.cartons.filter((c) => c.qty > 0).map((c) => ({ qty: c.qty, state: c.state }));
  if (plan.loose > 0) out.push({ qty: plan.loose, loose: true });
  return out;
}

// ---- Settings -----------------------------------------------------------------

type SettingsLike = Record<string, unknown> | null | undefined;

function settingObject(settings: SettingsLike, key: string): Record<string, unknown> {
  const v = settings?.[key];
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/**
 * The physical layer is live (design §11): physical_layer.live_since is set
 * and has passed at `nowMs`. Until then the Workspace carton steps stay
 * hidden and rpc_wh_rts_relabel answers dormant.
 */
export function physicalLayerLive(settings: SettingsLike, nowMs: number): boolean {
  const since = settingObject(settings, "physical_layer").live_since;
  if (typeof since !== "string" || !since.trim()) return false;
  const t = Date.parse(since);
  return !Number.isNaN(t) && t <= nowMs;
}

/** rts.require_relabel and rts.allow_no_parent, both true unless set false. */
export function rtsRules(settings: SettingsLike): { requireRelabel: boolean; allowNoParent: boolean } {
  const rts = settingObject(settings, "rts");
  return { requireRelabel: rts.require_relabel !== false, allowNoParent: rts.allow_no_parent !== false };
}

/** scan_rules.confirm_putaway_location: a destination is confirmed by scanning it unless this is off. */
export function confirmByScan(settings: SettingsLike): boolean {
  return settingObject(settings, "scan_rules").confirm_putaway_location !== false;
}

// ---- Emptying ------------------------------------------------------------------

/** Why an emptying task has no carton scanned: the reason chip, appended to the task notes. */
export const NO_CARTON_REASONS = ["loose units", "already at the line"] as const;
export type NoCartonReason = (typeof NO_CARTON_REASONS)[number];

/** The note an emptying task log carries when no carton was scanned. */
export function noCartonNote(reason: NoCartonReason): string {
  return `No carton scanned: ${reason}`;
}

/** A carton scanned at the start of an emptying task. */
export interface TakenCarton {
  id: string;
  code: string;
  sku_id: string | null;
  sku: string | null;
  units: number;
  /** The bin it came from; null when it was already at the line. */
  from_code: string | null;
  already_at_line: boolean;
}

/** The units the task quantity is pre-filled with: the scanned cartons of the task's SKU (mixed cartons excluded). */
export function takenUnits(taken: TakenCarton[], skuId: string | null | undefined): number {
  if (!skuId) return 0;
  return taken.reduce((sum, c) => (c.sku_id === skuId ? sum + Math.max(0, c.units) : sum), 0);
}
