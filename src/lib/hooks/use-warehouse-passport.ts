import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import type { WhCartonPassport } from "./use-warehouse";
import { mfgRpc, whErrorCode } from "./use-warehouse-mfg";

/**
 * The carton passport (owner decision 2026-10-28): one carton's whole life,
 * from its factory order to where it is now, read by rpc_wh_carton_passport.
 * The page lives at /inventory/cartons/:code and is reached by clicking a
 * carton code anywhere in the app (<CartonLink>), never from the navigation.
 *
 * A code the server does not know is an answer, not a failure: it comes back
 * as `{ found: false }` so the page can say so, while transport and
 * permission errors still throw.
 */

export type WhCartonPassportLookup = { found: true; passport: WhCartonPassport } | { found: false; code: string };

/** Read one carton's passport by its code. Exported for tests. */
export async function fetchWhCartonPassport(code: string, client: unknown = supabase): Promise<WhCartonPassportLookup> {
  const trimmed = code.trim();
  try {
    const passport = await mfgRpc("rpc_wh_carton_passport", { p_code: trimmed }, "Couldn't load the carton passport", client);
    return { found: true, passport };
  } catch (err) {
    if (whErrorCode(err) === "carton_not_found") return { found: false, code: trimmed };
    throw err;
  }
}

export function useWhCartonPassport(code: string | null | undefined) {
  const key = code?.trim() ?? "";
  return useQuery({
    queryKey: ["wh-carton-passport", key],
    enabled: key.length > 0,
    queryFn: () => fetchWhCartonPassport(key),
    staleTime: 30 * 1000,
  });
}
