/**
 * Legacy monitoring facade — now forwards to src/lib/observability.ts.
 *
 * History: this module began as a no-op stub ("uncomment when Sentry is
 * wired"). The real Sentry bootstrap later landed in
 * `src/lib/observability.ts` (dynamic import, prod + DSN gated, called
 * from main.tsx), but callers of THIS module — notably the route-level
 * ErrorBoundary — were still hitting the stub, so render crashes never
 * reached Sentry even with a DSN configured. These wrappers now delegate
 * to the live layer; the richer options (level/tags) are folded into the
 * event's extra context.
 *
 * New code should import from "@/lib/observability" directly. This file
 * stays only so existing call sites keep working.
 */

import { captureException as obsCaptureException } from "@/lib/observability";

interface CaptureOptions {
  /** Severity. Default 'error'. */
  level?: "fatal" | "error" | "warning" | "info" | "debug";
  /** Extra context — free-form. Useful for "why did this fail" notes. */
  extra?: Record<string, unknown>;
  /** Category tags for filtering in Sentry UI. */
  tags?: Record<string, string>;
}

/** @deprecated Sentry init happens in observability.ts (called from main.tsx). */
export function initMonitoring(): void {
  // Intentionally empty — initObservability() in main.tsx owns startup.
}

export function captureException(error: unknown, options: CaptureOptions = {}): void {
  void obsCaptureException(error, {
    ...(options.extra ?? {}),
    ...(options.tags ? { tags: options.tags } : {}),
    ...(options.level ? { level: options.level } : {}),
  });
  if (import.meta.env.DEV) {
    console.error("[captureException]", error, options);
  }
}

export function captureMessage(message: string, options: CaptureOptions = {}): void {
  void obsCaptureException(new Error(message), {
    ...(options.extra ?? {}),
    ...(options.tags ? { tags: options.tags } : {}),
    level: options.level ?? "info",
  });
  if (import.meta.env.DEV) {
    console.log("[captureMessage]", message, options);
  }
}

export function setUserContext(user: { id: string; email?: string; role?: string } | null): void {
  // User context enrichment can be added to observability.ts if needed.
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
