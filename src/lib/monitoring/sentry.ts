/**
 * Sentry wrapper. Sentry captures exceptions from the frontend + Edge Functions
 * with full stack traces, breadcrumbs, and user context.
 *
 * This module is a thin wrapper so the rest of the app stays decoupled from
 * the vendor. Replace the import with any other provider (Honeybadger, Rollbar,
 * Datadog) by editing this file only.
 *
 * SETUP (to do before go-live):
 *   1. Create a Sentry project per environment (dev/staging/prod). Get each DSN.
 *   2. Install: `npm install @sentry/react`
 *   3. Set VITE_SENTRY_DSN per environment.
 *   4. Uncomment the Sentry.init() block below.
 *   5. Wrap <App /> in <Sentry.ErrorBoundary fallback={...}> in main.tsx.
 *   6. Upload source maps as part of the CI build so stack traces resolve.
 *
 * Until then, calls no-op (safe default — better to swallow than crash on missing
 * observability).
 */

// import * as Sentry from "@sentry/react";  // Uncomment after install

interface CaptureOptions {
  /** Severity. Default 'error'. */
  level?: "fatal" | "error" | "warning" | "info" | "debug";
  /** Extra context — free-form. Useful for "why did this fail" notes. */
  extra?: Record<string, unknown>;
  /** Category tags for filtering in Sentry UI. */
  tags?: Record<string, string>;
}

export function initMonitoring(): void {
  const dsn = import.meta.env.VITE_SENTRY_DSN as string | undefined;
  const env = (import.meta.env.VITE_APP_ENV as string | undefined) ?? "dev";
  if (!dsn) {
    if (env === "prod") {
      // In prod, missing DSN is a config error worth shouting about.
      console.warn("[monitoring] VITE_SENTRY_DSN not set — errors will not be reported");
    }
    return;
  }

  // Sentry.init({
  //   dsn,
  //   environment: env,
  //   integrations: [Sentry.browserTracingIntegration(), Sentry.replayIntegration()],
  //   tracesSampleRate: env === "prod" ? 0.1 : 1.0,
  //   replaysSessionSampleRate: env === "prod" ? 0.01 : 0.1,
  //   replaysOnErrorSampleRate: 1.0,
  //   // Drop known-noisy errors
  //   ignoreErrors: [
  //     /ResizeObserver loop/,
  //     /Non-Error promise rejection captured/,
  //   ],
  // });
}

export function captureException(error: unknown, options: CaptureOptions = {}): void {
  // Sentry.captureException(error, {
  //   level: options.level ?? "error",
  //   extra: options.extra,
  //   tags: options.tags,
  // });
  if (import.meta.env.DEV) {
    console.error("[captureException]", error, options);
  }
}

export function captureMessage(message: string, options: CaptureOptions = {}): void {
  // Sentry.captureMessage(message, { level: options.level ?? "info", extra: options.extra, tags: options.tags });
  if (import.meta.env.DEV) {
    console.log("[captureMessage]", message, options);
  }
}

export function setUserContext(user: { id: string; email?: string; role?: string } | null): void {
  // Sentry.setUser(user ? { id: user.id, email: user.email, segment: user.role } : null);
  void user;
}

/**
 * Wrap an async function with error capture. The returned function re-throws
 * after capturing so the caller can still react to failure.
 */
export function withErrorCapture<TArgs extends unknown[], TResult>(
  fn: (...args: TArgs) => Promise<TResult>,
  tag: string,
): (...args: TArgs) => Promise<TResult> {
  return async (...args: TArgs) => {
    try {
      return await fn(...args);
    } catch (err) {
      captureException(err, { tags: { op: tag } });
      throw err;
    }
  };
}
