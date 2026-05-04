/**
 * Shared zod schemas for form validation.
 *
 * Goal: every user-supplied payload is validated at the client boundary
 * with a zod schema, then (eventually) re-validated at the RPC / DB boundary.
 * Client validation gives fast, localized error messages; server validation
 * is the actual guarantee.
 *
 * Convention: one schema per user-facing form/action, exported with a clear
 * name. Use `z.infer<typeof SCHEMA>` to get the TypeScript type.
 */

import { z } from "zod";

// -----------------------------------------------------------------------------
// Primitives
// -----------------------------------------------------------------------------

/** YYYY-MM-DD date string. */
export const ymdDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD");

/** Non-empty trimmed string. */
export const nonEmptyString = z
  .string()
  .trim()
  .min(1, "Required");

/** Integer >= 0. */
export const nonNegativeInt = z
  .number()
  .int()
  .min(0, "Must be zero or positive");

/** Integer > 0. */
export const positiveInt = z
  .number()
  .int()
  .min(1, "Must be at least 1");

/** Non-negative dollar amount (up to 2 decimal places). */
export const money = z
  .number()
  .min(0, "Cannot be negative")
  .multipleOf(0.01, "At most 2 decimal places");

// -----------------------------------------------------------------------------
// Manufacturing: log a task
// -----------------------------------------------------------------------------
export const taskCompletionSchema = z.object({
  skuId: nonEmptyString,
  taskType: z.enum(["emptying", "filling_capping", "rtsing", "prefilled_rtsing", "breakage"]),
  quantity: positiveInt,
  notes: z.string().trim().max(500, "Keep notes under 500 characters").optional(),
});
export type TaskCompletionInput = z.infer<typeof taskCompletionSchema>;

// -----------------------------------------------------------------------------
// Inventory: SKU demand override
// -----------------------------------------------------------------------------
export const demandOverrideSchema = z.object({
  skuId: nonEmptyString,
  // null = clear override
  monthlyDemand: z.union([nonNegativeInt, z.null()]),
  reason: z.string().trim().max(200).optional(),
});
export type DemandOverrideInput = z.infer<typeof demandOverrideSchema>;

// -----------------------------------------------------------------------------
// Inventory: cycle count
// -----------------------------------------------------------------------------
export const cycleCountSchema = z.object({
  skuId: nonEmptyString,
  field: z.enum(["warehouse_raw", "warehouse_in_production", "warehouse_finished", "warehouse_other"]),
  delta: z.number().int().refine(v => v !== 0, "Delta cannot be zero"),
  reason: z.enum(["breakage", "mispick", "theft", "receiving_error", "other"]),
  notes: z.string().trim().max(500).optional(),
});
export type CycleCountInput = z.infer<typeof cycleCountSchema>;

// -----------------------------------------------------------------------------
// Freight: new shipment
// -----------------------------------------------------------------------------
const cartonSkuSchema = z.object({
  skuId: nonEmptyString,
  quantity: positiveInt,
  preFilled: z.boolean().optional(),
});

const cartonGroupSchema = z.object({
  cartonQty: positiveInt,
  skus: z.array(cartonSkuSchema).min(1, "At least one SKU per carton group"),
  notes: z.string().trim().max(500).optional(),
});

export const freightShipmentSchema = z
  .object({
    shipmentNumber: nonEmptyString.max(50, "Keep shipment numbers under 50 chars"),
    freightType: z.enum(["air", "sea"]),
    carrierName: z.string().trim().max(100).optional(),
    forwarderCode: z.string().trim().max(50).optional(),
    trackingNumber: z.string().trim().max(100).optional(),
    shipDate: ymdDateSchema.optional(),
    eta: ymdDateSchema.optional(),
    freightCost: money.optional(),
    notes: z.string().trim().max(1000).optional(),
    cartonGroups: z.array(cartonGroupSchema).min(1, "Add at least one carton group"),
  })
  .refine(
    (v) => !v.shipDate || !v.eta || v.eta >= v.shipDate,
    { message: "ETA must be on or after ship date", path: ["eta"] },
  );
export type FreightShipmentInput = z.infer<typeof freightShipmentSchema>;

// -----------------------------------------------------------------------------
// Freight: manual status override
// -----------------------------------------------------------------------------
export const freightStatusOverrideSchema = z.object({
  shipmentId: nonEmptyString,
  newStatus: z.enum(["on_the_water", "high_risk", "cleared_customs", "tracking", "delivered"]),
  reason: z.string().trim().max(200).optional(),
});
export type FreightStatusOverrideInput = z.infer<typeof freightStatusOverrideSchema>;

// -----------------------------------------------------------------------------
// Settings: change user role
// -----------------------------------------------------------------------------
export const userRoleChangeSchema = z.object({
  targetUserId: nonEmptyString,
  newRole: z.enum(["admin", "manager", "user"]),
});
export type UserRoleChangeInput = z.infer<typeof userRoleChangeSchema>;

// -----------------------------------------------------------------------------
// Settings: link user to Homebase
// -----------------------------------------------------------------------------
export const homebaseLinkSchema = z.object({
  userId: nonEmptyString,
  homebaseEmployeeId: nonEmptyString,
});
export type HomebaseLinkInput = z.infer<typeof homebaseLinkSchema>;

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------
/**
 * Flatten a ZodError into a `{ [path]: message }` map for easy form rendering.
 */
export function flattenZodErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const path = issue.path.join(".") || "_root";
    if (!out[path]) out[path] = issue.message;
  }
  return out;
}

/**
 * Parse-or-errors helper: returns `{ ok: true, value }` or `{ ok: false, errors }`.
 * Avoids throwing from happy paths.
 */
export function safeValidate<T>(
  schema: z.ZodType<T>,
  input: unknown,
): { ok: true; value: T } | { ok: false; errors: Record<string, string> } {
  const result = schema.safeParse(input);
  if (result.success) return { ok: true, value: result.data };
  return { ok: false, errors: flattenZodErrors(result.error) };
}
