// Outbound guard for Edge Functions (Warehouse module, Phase 0).
// Design: docs/design/WAREHOUSE_MODULE_PHASE0_1.md §3.3
//
// Two independent switches must both say "live" before an Edge Function
// may write to ShipStation, call PrintNode, or do anything else that leaves
// the ERP:
//   1. the Edge secret ERP_OUTBOUND_MODE (set per project; never on staging)
//   2. the database setting wh_settings.outbound.mode (admin-controlled)
// A staging refresh writes `blocked` to the database last, and staging never
// receives the secret, so a copied production database can never act on the
// outside world from staging.
//
// Usage:
//   import { assertOutbound } from "../_shared/outbound-guard.ts";
//   await assertOutbound(supabaseAdmin, "shipstation_write");
//   // ...then perform the write
//
// kinds: "shipstation_write" | "printnode" | "browser_print"

export type OutboundKind = "shipstation_write" | "printnode" | "browser_print";
export type OutboundMode = "live" | "practice" | "blocked";

export class OutboundBlockedError extends Error {
  readonly kind: OutboundKind;
  readonly reason: string;
  constructor(kind: OutboundKind, reason: string) {
    super(`outbound ${kind} blocked: ${reason}`);
    this.name = "OutboundBlockedError";
    this.kind = kind;
    this.reason = reason;
  }
}

/** The mode this deployment's secret allows. Anything but "live" blocks. */
export function secretMode(): OutboundMode {
  const raw = (Deno.env.get("ERP_OUTBOUND_MODE") ?? "").trim().toLowerCase();
  if (raw === "live" || raw === "practice") return raw;
  return "blocked";
}

/** Minimal client shape so this file does not depend on a specific supabase-js import path. */
export interface RpcClient {
  rpc(fn: string, args?: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }>;
}

/** Reads wh_settings.outbound.mode through fn_outbound_allowed (service role). */
export async function databaseAllows(client: RpcClient, kind: OutboundKind): Promise<boolean> {
  const { data, error } = await client.rpc("fn_outbound_allowed", { p_kind: kind });
  if (error) throw new Error(`fn_outbound_allowed failed: ${error.message}`);
  return data === true;
}

/**
 * Throws OutboundBlockedError unless BOTH the secret and the database allow `kind`.
 * Callers catch it and return a 409 with the reason so the caller can see why.
 */
export async function assertOutbound(client: RpcClient, kind: OutboundKind): Promise<void> {
  const mode = secretMode();
  const secretOk = mode === "live" || (mode === "practice" && kind === "browser_print");
  if (!secretOk) {
    throw new OutboundBlockedError(kind, `ERP_OUTBOUND_MODE is ${mode}`);
  }
  if (!(await databaseAllows(client, kind))) {
    throw new OutboundBlockedError(kind, "wh_settings.outbound does not allow it");
  }
}
