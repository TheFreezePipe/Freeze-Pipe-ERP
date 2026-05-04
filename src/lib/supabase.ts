import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { isDemoMode } from "@/lib/env";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

/**
 * Create a Supabase client.
 *
 * - If real credentials are present (any environment), build a real client.
 *   `env.ts` already hard-fails on prod when creds are missing, so reaching
 *   this branch in prod implies valid creds.
 *
 * - If we're in demo mode (dev/staging without creds), return a Proxy that
 *   throws on any property access. The previous fallback created a real
 *   client pointed at `https://placeholder.supabase.co`, which silently
 *   issued 4xx requests every time *any* hook ran — masking demo-mode
 *   wiring bugs. The Proxy makes the failure mode explicit: if a hook
 *   reaches into `supabase` while in demo mode, it crashes loudly with
 *   a message that points at the missing demo-data branch.
 */
function buildClient(): SupabaseClient<Database> {
  if (supabaseUrl && supabaseAnonKey) {
    return createClient<Database>(supabaseUrl, supabaseAnonKey);
  }

  if (!isDemoMode) {
    // Should be unreachable — env.ts throws on prod-with-missing-creds.
    // Defensive: refuse to construct a misconfigured client.
    throw new Error(
      "[supabase.ts] VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY are missing " +
      "and isDemoMode is false. This combination should not occur — check env.ts.",
    );
  }

  // Demo mode. Return a stub that throws on use. Hooks branching on
  // isDemoMode should never touch this; the throw catches any that do.
  const stubMessage =
    "[supabase.ts] Supabase client invoked in demo mode. " +
    "The calling hook should branch on `isDemoMode` and use demo data instead. " +
    "If you see this in dev, the hook is missing its demo-mode path.";
  return new Proxy({} as SupabaseClient<Database>, {
    get() {
      throw new Error(stubMessage);
    },
    apply() {
      throw new Error(stubMessage);
    },
  });
}

export const supabase = buildClient();
