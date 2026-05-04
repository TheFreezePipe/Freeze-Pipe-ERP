/**
 * Observability bootstrap — Sentry + (optional) PostHog.
 *
 * Loaded once at app start from main.tsx. Both providers are gated by
 * `APP_ENV === 'prod'` AND a non-empty DSN — that means dev/staging
 * environments stay quiet (no spurious events, no perf overhead) and
 * prod stays quiet too if the DSN env var is missing (safer than
 * crashing the boot on a config gap).
 *
 * Sentry-browser is dynamically imported so its bundle (~80kb gzipped)
 * doesn't end up in the dev/staging build at all. The dynamic import
 * also means the rest of the app never blocks on Sentry — `initObservability`
 * returns immediately and the import resolves in the background.
 *
 * To activate in prod: set VITE_SENTRY_DSN in Vercel env vars and redeploy.
 */

import { APP_ENV } from "@/lib/env";

const SENTRY_DSN = import.meta.env.VITE_SENTRY_DSN as string | undefined;

let initialized = false;

export function initObservability(): void {
  if (initialized) return;
  initialized = true;

  if (APP_ENV !== "prod") return;
  if (!SENTRY_DSN || SENTRY_DSN.trim().length === 0) {
    // No DSN configured — quietly skip. Logging here would be noise on
    // every prod boot until ops gets around to setting the env var.
    return;
  }

  // Dynamic import keeps the Sentry bundle out of dev/staging builds.
  // We don't await this — the rest of the app proceeds while Sentry
  // attaches its hooks asynchronously. The trade-off is a sub-second
  // window early in the session where errors aren't captured; that's
  // an acceptable cost to keep startup snappy.
  void import("@sentry/react").then((Sentry) => {
    Sentry.init({
      dsn: SENTRY_DSN,
      environment: APP_ENV,
      // Don't sample performance traces — error events alone are what
      // we need at this scale, and free-tier quotas are tight.
      tracesSampleRate: 0,
      // Replay is too heavy for a free-tier ERP with no privacy review
      // — skip it. Errors only.
      replaysSessionSampleRate: 0,
      replaysOnErrorSampleRate: 0,
      // Release tag — populated by Vercel at build time. Unset locally,
      // which Sentry handles fine (events show as "unknown release").
      release: import.meta.env.VITE_VERCEL_GIT_COMMIT_SHA as string | undefined,
      ignoreErrors: [
        // Browsers fire this on pinch-zoom in iframes; not actionable.
        "ResizeObserver loop limit exceeded",
        "ResizeObserver loop completed with undelivered notifications",
        // Network blips during navigation don't need a Sentry event.
        "NetworkError when attempting to fetch resource",
      ],
    });
  }).catch((err) => {
    // If the dynamic import itself fails (which would be very unusual
    // — the chunk is generated at build), log to console and move on.
    // Don't crash the app over an observability layer.
    console.warn("[observability] Sentry init failed:", err);
  });
}

/**
 * Capture an exception manually. No-op when observability isn't
 * initialized (dev/staging, or prod without DSN). Use sparingly — the
 * Sentry React error boundary catches most things automatically.
 */
export async function captureException(err: unknown, context?: Record<string, unknown>): Promise<void> {
  if (APP_ENV !== "prod" || !SENTRY_DSN) return;
  try {
    const Sentry = await import("@sentry/react");
    Sentry.captureException(err, context ? { extra: context } : undefined);
  } catch {
    // Swallow — observability must never throw.
  }
}
