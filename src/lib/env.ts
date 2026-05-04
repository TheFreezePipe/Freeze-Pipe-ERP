/**
 * Centralized environment detection.
 *
 * Two public exports:
 *   - APP_ENV  — 'dev' | 'staging' | 'prod'
 *   - isDemoMode — true only when Supabase isn't configured, NEVER in prod
 *
 * Production hard-fails at module load if Supabase credentials are missing
 * or match the placeholder. This is intentional: we'd rather refuse to boot
 * than silently run on localStorage and lose real data.
 */

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

const rawEnv = import.meta.env.VITE_APP_ENV as string | undefined;
export const APP_ENV: "dev" | "staging" | "prod" =
  rawEnv === "staging" ? "staging" :
  rawEnv === "prod" ? "prod" :
  "dev";

const PLACEHOLDER_URL = "https://your-project.supabase.co";
const PLACEHOLDER_KEY = "your-anon-key-here";

function credsLookLikePlaceholders(): boolean {
  if (!url || !key) return true;
  if (url === PLACEHOLDER_URL) return true;
  if (key === PLACEHOLDER_KEY || key === "placeholder") return true;
  // Reject obviously empty or whitespace values.
  if (url.trim().length === 0 || key.trim().length === 0) return true;
  return false;
}

/**
 * Demo mode runs the app against in-memory / localStorage data instead of
 * Supabase. Useful for local dev without credentials. Forbidden in prod.
 */
export const isDemoMode: boolean = (() => {
  const missing = credsLookLikePlaceholders();

  if (APP_ENV === "prod" && missing) {
    // Hard fail. Refuse to boot so nobody logs real data into localStorage.
    const msg =
      "[CONFIG ERROR] VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY must be set " +
      "for production builds. Refusing to start in demo mode with VITE_APP_ENV=prod.";
    // Throw synchronously during module init — Vite will surface this as a build/runtime crash.
    throw new Error(msg);
  }

  if (APP_ENV === "staging" && missing) {
    // Staging shouldn't be in demo mode either. Warn loudly but don't throw
    // so developers can still preview builds locally with VITE_APP_ENV unset.
    console.error(
      "[CONFIG WARNING] Supabase credentials missing on staging. " +
      "The app will fall back to demo mode — real actions will not persist.",
    );
  }

  if (!missing && APP_ENV === "dev") {
    // Dev with real credentials — fine; log once so it's obvious in DevTools.
    console.info("[env] dev environment connected to real Supabase");
  }

  return missing;
})();

/** Whether to show the env banner (never on prod). */
export const shouldShowEnvBanner = APP_ENV !== "prod";
