/**
 * Feature flag gate for in-development features.
 *
 * Pattern: each in-progress feature exports a `useShouldShow…` hook
 * that returns true only for a hardcoded list of user IDs. When the
 * feature is ready to release to everyone, delete the flag hook AND
 * its call sites (grep for the hook name to find them all). 5-line
 * commits.
 *
 * The current approach is intentionally crude — no DB table, no env
 * var, no remote config. Just a hardcoded UUID. Easy to find, easy to
 * remove, no infrastructure overhead for "show this only to Chase
 * while it's being built."
 */
import { useAuth } from "@/lib/auth-context";

// Chase's admin profile UUID (prod). Source of truth.
const CHASE_PROD_USER_ID = "19ecc326-693f-4167-92bf-c8d0dd19dfc7";

/**
 * Materials / consumables tracking — in-progress feature being built
 * incrementally (schema + UI + cycle count + recipes + barrel viz).
 * Visible only to Chase during development. Remove this hook and all
 * `if (!showMaterials) return` checks to release.
 */
export function useShouldShowMaterialsFeature(): boolean {
  const { user } = useAuth();
  return user?.id === CHASE_PROD_USER_ID;
}
