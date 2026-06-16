/**
 * Turn an unknown thrown value — especially a Supabase/PostgREST error
 * (a plain object, NOT an Error instance) — into a human-readable string.
 *
 * Why this exists: `String(postgrestError)` yields "[object Object]", and
 * `err instanceof Error` is false for them, so naive handlers showed
 * users nothing useful. This unwraps message/details/hint and adds
 * friendly text for the Postgres error codes operators actually hit.
 */
export function describeError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;

  if (error && typeof error === "object") {
    const e = error as {
      code?: string;
      message?: string;
      details?: string;
      hint?: string;
    };

    // 23505 = unique_violation. The one users hit most is a reused
    // shipment / order number — name it plainly so they can just retry.
    if (e.code === "23505") {
      const blob = `${e.message ?? ""} ${e.details ?? ""}`;
      if (blob.includes("shipment_number")) {
        return "That shipment number is already in use — pick a different one.";
      }
      return e.details
        ? `A record with these details already exists (${e.details})`
        : "A record with these details already exists.";
    }

    // 23514 = check_violation; 23503 = foreign_key_violation — surface the
    // raw detail, which usually names the offending value/constraint.
    const parts = [e.message, e.details, e.hint].filter(
      (x): x is string => typeof x === "string" && x.trim().length > 0,
    );
    if (parts.length) return parts.join(" — ");
  }

  return String(error);
}
