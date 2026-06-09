/**
 * Material runway forecasting.
 *
 * Computes "days until reorder" per material, with a pipeline split:
 *   - currentRunwayDays:  on_hand_qty alone, drained at daily_consumption
 *   - pipelineRunwayDays: on_hand + everything currently in production +
 *                         raw + prefilled-raw + in-transit + on-order,
 *                         minus what'll be consumed to finish all that.
 *
 * Daily consumption is derived from real-world usage data via the
 * material_transactions audit log (Phase 6 hook) once auto-deduction
 * lands. Until then, we estimate consumption from the recipe table +
 * SKU monthly_demand: a per-day rate of how much material every active
 * fillable SKU would consume to keep up with current demand.
 */

import type { ProductSKU, InventoryLevel } from "@/types/database";
import type { Material, MaterialWithLevel } from "@/lib/hooks";

export interface MaterialRunwayResult {
  materialId: string;
  /** Days until on_hand alone hits zero (sales rate only). */
  currentRunwayDays: number | null;
  /** Days until on_hand + all pipeline inventory is exhausted. */
  pipelineRunwayDays: number | null;
  /** Daily burn rate (units of this material per day). */
  dailyConsumption: number;
  /** Total material qty needed to finish current pipeline. */
  pipelineConsumptionQty: number;
  /** True when on_hand < reorder_point_qty. */
  belowReorderPoint: boolean;
  /** Source of the daily-consumption estimate. */
  consumptionSource: "usage" | "demand_recipe" | "no_recipes" | "no_demand";
}

export interface RunwayInputs {
  materials: MaterialWithLevel[];
  /** All recipes across the catalog: SKU → (material, qty/unit). */
  allRecipes: Array<{
    sku_id: string;
    material_id: string;
    quantity_per_unit: number;
  }>;
  /** Active fillable SKUs with their inventory + demand. */
  fillableInventory: Array<{
    product: Pick<ProductSKU, "id" | "category" | "monthly_demand">;
    inventory: Pick<
      InventoryLevel,
      "warehouse_raw" | "warehouse_prefilled_raw" | "warehouse_in_production"
    >;
  }>;
  /**
   * Optional observed daily usage per material (units/day) from real
   * consumption transactions (e.g. ShipStation box decrements). When a
   * material has a positive rate here it OVERRIDES the recipe estimate —
   * observed reality beats modelled demand. This is the source for boxes,
   * which have no recipes.
   */
  usageRateByMaterial?: Map<string, number>;
}

/**
 * Compute runway for a single material from the cross-SKU inputs.
 * Per-material call so the caller can map across the catalog.
 */
export function computeMaterialRunway(
  material: Material,
  inputs: RunwayInputs,
): MaterialRunwayResult {
  const onHand = (inputs.materials.find((m) => m.id === material.id))
    ?.inventory?.on_hand_qty ?? 0;
  const belowReorderPoint =
    material.reorder_point_qty != null && onHand < material.reorder_point_qty;

  // Observed trailing usage (e.g. boxes decremented from ShipStation
  // shipments). Preferred over the recipe estimate when present.
  const usageDaily = inputs.usageRateByMaterial?.get(material.id) ?? 0;

  // Recipe-based estimate: Σ over fillable SKUs of (daily_demand × recipe_qty),
  // plus the material qty needed to finish all upstream (raw/prefilled/WIP)
  // stock. Zero for materials with no recipes (boxes).
  const recipeBySku = new Map<string, number>();
  for (const r of inputs.allRecipes) {
    if (r.material_id === material.id) recipeBySku.set(r.sku_id, r.quantity_per_unit);
  }
  let recipeDaily = 0;
  let pipelineUnits = 0;
  for (const { product, inventory } of inputs.fillableInventory) {
    const recipeQty = recipeBySku.get(product.id);
    if (!recipeQty) continue;
    recipeDaily += ((product.monthly_demand ?? 0) / 30) * recipeQty;
    const upstream = (inventory.warehouse_raw ?? 0)
      + (inventory.warehouse_prefilled_raw ?? 0)
      + (inventory.warehouse_in_production ?? 0);
    pipelineUnits += upstream * recipeQty;
  }

  // Source precedence: observed usage > recipe estimate > none.
  let dailyConsumption: number;
  let consumptionSource: MaterialRunwayResult["consumptionSource"];
  if (usageDaily > 0) {
    dailyConsumption = usageDaily;
    consumptionSource = "usage";
  } else if (recipeDaily > 0) {
    dailyConsumption = recipeDaily;
    consumptionSource = "demand_recipe";
  } else {
    return {
      materialId: material.id,
      currentRunwayDays: null,
      pipelineRunwayDays: null,
      dailyConsumption: 0,
      pipelineConsumptionQty: pipelineUnits,
      belowReorderPoint,
      // No recipes AND no observed usage → nothing to go on yet.
      consumptionSource: recipeBySku.size === 0 ? "no_recipes" : "no_demand",
    };
  }

  // Usage-driven materials (boxes) have pipelineUnits = 0, so pipeline
  // runway collapses to current runway — there's no upstream pipeline.
  const currentRunwayDays = onHand / dailyConsumption;
  // Pipeline runway: how long until the on-hand stock is depleted
  // assuming we use it to finish the entire current pipeline.
  //
  //   total_supply  = on_hand
  //   total_demand  = pipeline_consumption + ongoing_daily_consumption × days
  //   Solve for days when total_supply = total_demand.
  //
  //   days = (on_hand - pipeline_consumption) / daily_consumption
  //
  // If pipeline_consumption > on_hand, runway is already negative —
  // meaning you don't have enough material to finish what's in the
  // building. Clamp at 0 for display.
  const pipelineRunwayDays = Math.max(
    0,
    (onHand - pipelineUnits) / dailyConsumption,
  );

  return {
    materialId: material.id,
    currentRunwayDays: Math.round(currentRunwayDays * 10) / 10,
    pipelineRunwayDays: Math.round(pipelineRunwayDays * 10) / 10,
    dailyConsumption: Math.round(dailyConsumption * 1000) / 1000,
    pipelineConsumptionQty: Math.round(pipelineUnits * 100) / 100,
    belowReorderPoint,
    consumptionSource,
  };
}

/**
 * Hook-friendly wrapper: compute runway for every material in the
 * catalog in one pass, returning a Map keyed by material_id.
 */
export function computeAllMaterialRunways(
  inputs: RunwayInputs,
): Map<string, MaterialRunwayResult> {
  const out = new Map<string, MaterialRunwayResult>();
  for (const m of inputs.materials) {
    out.set(m.id, computeMaterialRunway(m, inputs));
  }
  return out;
}

// ===== Reorder helper =====

/** Safety margin (days) before lead-time runs out that still triggers a reorder. */
const REORDER_SAFETY_DAYS = 14;
/** Target days of cover (beyond lead time) the suggested order should reach. */
const REORDER_TARGET_COVER_DAYS = 60;

export interface ReorderSuggestion {
  shouldReorder: boolean;
  reason: "below_reorder_point" | "within_lead_time" | "ok" | "no_estimate";
  /** Suggested order quantity to reach target cover (null when no estimate). */
  suggestedOrderQty: number | null;
  /** Days from now by which to place the order to avoid stockout. <=0 = now/overdue. */
  orderByDays: number | null;
  targetCoverDays: number;
  leadTimeDays: number;
}

/**
 * Suggest whether/how much to reorder a material.
 *
 *   orderByDays   = current runway − lead time   (place by then or you stock
 *                   out before the replenishment lands)
 *   suggestedQty  = enough to reach (lead time + target cover) days of demand
 *
 * When there's no consumption estimate (no recipe or no demand), only the
 * manual reorder point can signal — we flag below-ROP but can't size an order.
 */
export function computeReorderSuggestion(
  material: Material,
  onHand: number,
  runway: MaterialRunwayResult,
): ReorderSuggestion {
  const lead = material.lead_time_days ?? 0;
  const belowROP =
    material.reorder_point_qty != null && onHand < material.reorder_point_qty;
  const daily = runway.dailyConsumption;

  if (daily <= 0) {
    return {
      shouldReorder: belowROP,
      reason: belowROP ? "below_reorder_point" : "no_estimate",
      suggestedOrderQty: null,
      orderByDays: null,
      targetCoverDays: REORDER_TARGET_COVER_DAYS,
      leadTimeDays: lead,
    };
  }

  const runwayDays = onHand / daily;
  const orderByDays = runwayDays - lead;
  const within = orderByDays <= REORDER_SAFETY_DAYS;
  const shouldReorder = belowROP || within;
  const targetLevel = daily * (lead + REORDER_TARGET_COVER_DAYS);
  const suggestedOrderQty = Math.max(0, Math.ceil(targetLevel - onHand));

  return {
    shouldReorder,
    reason: belowROP ? "below_reorder_point" : within ? "within_lead_time" : "ok",
    suggestedOrderQty,
    orderByDays: Math.round(orderByDays * 10) / 10,
    targetCoverDays: REORDER_TARGET_COVER_DAYS,
    leadTimeDays: lead,
  };
}

// ===== Glycerin barrel visual helpers =====

const BARREL_LITERS = 208; // 55 US gallons in liters, rounded for display
const BARRELS_PER_TYPICAL_ORDER = 4;

export interface BarrelVisualState {
  totalLiters: number;
  /** How many barrels' worth of glycerin is on hand. */
  totalBarrels: number;
  /** One entry per rendered barrel; fillFraction in [0, 1]. */
  barrels: Array<{ index: number; fillFraction: number }>;
  /** Days until first barrel empties (informational). */
  daysUntilNextBarrelEmpty: number | null;
}

/**
 * Sequential-drain barrel visualization for glycerin.
 *
 * Renders N barrels left-to-right where N = ceil(on_hand / BARREL_LITERS),
 * floor-min 4 (matches the typical 4-barrel reorder cadence). Drain
 * pattern: rightmost barrel empties first, then second-from-right, etc.
 *
 * E.g., 624L on hand → 3 barrels: barrel 1 = 100%, barrel 2 = 100%,
 * barrel 3 = 100%, no fourth barrel rendered. 540L → barrel 1 = 100%,
 * barrel 2 = 100%, barrel 3 = 58%. 0L → all 4 barrels shown empty.
 */
export function computeBarrelVisual(
  onHandLiters: number,
  dailyConsumptionLiters: number | null,
): BarrelVisualState {
  const totalLiters = Math.max(0, onHandLiters);
  const fullBarrels = totalLiters / BARREL_LITERS;
  const barrelCount = Math.max(
    BARRELS_PER_TYPICAL_ORDER,
    Math.ceil(fullBarrels) || BARRELS_PER_TYPICAL_ORDER,
  );

  const barrels: Array<{ index: number; fillFraction: number }> = [];
  let remaining = totalLiters;
  // Left-to-right: barrel index 0 (leftmost) drains LAST per sequential
  // pattern. So we fill barrels left-to-right with up-to-100% each,
  // running out at the right end. Rightmost barrel(s) show empty when
  // on_hand can't cover them.
  for (let i = 0; i < barrelCount; i++) {
    const thisFill = Math.min(BARREL_LITERS, Math.max(0, remaining));
    barrels.push({
      index: i,
      fillFraction: thisFill / BARREL_LITERS,
    });
    remaining -= thisFill;
  }

  // "Days until the next barrel-boundary is crossed" — i.e., how many
  // days until the current partially-full barrel is empty and we move
  // to draining the next one back.
  let daysUntilNextBarrelEmpty: number | null = null;
  if (dailyConsumptionLiters && dailyConsumptionLiters > 0) {
    // Find the current "active" barrel (the rightmost non-empty one).
    let activeFill: number | null = null;
    for (let i = barrels.length - 1; i >= 0; i--) {
      if (barrels[i].fillFraction > 0) {
        activeFill = barrels[i].fillFraction * BARREL_LITERS;
        break;
      }
    }
    if (activeFill !== null) {
      daysUntilNextBarrelEmpty = Math.round((activeFill / dailyConsumptionLiters) * 10) / 10;
    }
  }

  return {
    totalLiters,
    totalBarrels: fullBarrels,
    barrels,
    daysUntilNextBarrelEmpty,
  };
}

export { BARREL_LITERS, BARRELS_PER_TYPICAL_ORDER };
