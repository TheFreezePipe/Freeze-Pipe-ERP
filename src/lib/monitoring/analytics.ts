/**
 * PostHog wrapper for product analytics.
 *
 * Track critical user flows so we can answer questions like:
 *   - How often is "Log Task" failing with insufficient_source_stock?
 *   - What's the Freight→Detail navigation rate (are people finding the detail page)?
 *   - Average time between carton-group add and form submit (UX bottleneck indicator)?
 *
 * SETUP (to do before go-live):
 *   1. Create a PostHog project (cloud or self-hosted) per environment.
 *   2. Install: `npm install posthog-js`
 *   3. Set VITE_POSTHOG_KEY + VITE_POSTHOG_HOST per environment.
 *   4. Uncomment the posthog.init() block and the function bodies.
 *
 * Until then, calls no-op.
 */

// import posthog from "posthog-js";  // Uncomment after install

type EventName =
  // Manufacturing
  | "task_logged"
  | "task_log_failed"
  // Freight
  | "freight_status_overridden"
  | "freight_status_override_cleared"
  | "freight_tracking_refresh_clicked"
  // Inventory
  | "sku_archived"
  | "sku_restored"
  | "cycle_count_recorded"
  | "demand_override_changed"
  // Settings
  | "user_role_changed"
  | "homebase_linked"
  | "homebase_unlinked"
  // ShipStation
  | "shipstation_unresolved_sku_resolved"
  // Navigation / engagement
  | "performance_range_changed"
  | "performance_metric_switched"
  | "performance_employee_drilled_in"
  | "performance_sku_drilled_in";

export function initAnalytics(): void {
  const key = import.meta.env.VITE_POSTHOG_KEY as string | undefined;
  const host = (import.meta.env.VITE_POSTHOG_HOST as string | undefined) ?? "https://us.i.posthog.com";
  if (!key) return;

  // posthog.init(key, {
  //   api_host: host,
  //   capture_pageview: true,
  //   capture_pageleave: true,
  //   autocapture: { element_attribute_ignorelist: ["data-sensitive"] },
  //   person_profiles: "identified_only",
  // });
  void host;
}

export function identifyUser(userId: string, props?: Record<string, unknown>): void {
  // posthog.identify(userId, props);
  void userId; void props;
}

export function track(event: EventName, props?: Record<string, unknown>): void {
  // posthog.capture(event, props);
  if (import.meta.env.DEV) {
    console.debug(`[analytics] ${event}`, props ?? {});
  }
}

export function resetUser(): void {
  // posthog.reset();
}
