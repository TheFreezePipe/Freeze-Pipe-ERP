import type { TrackingProvider, TrackingUpdate } from "../types";
import { mockFetchTracking, type MockContext } from "./mock";

/**
 * Evergreen Marine tracking. Real integration:
 *   - Shipment Link API: https://www.evergreen-shipping.us/ESLInternet/esl_cargo.jsp
 *   - Web scraping (no public JSON API) OR a unified aggregator.
 *
 * Mock fallback until a real integration is wired up.
 */
export function createEvergreenProvider(ctxFor: (trackingNumber: string) => MockContext): TrackingProvider {
  return {
    name: "Evergreen",
    carrierType: "sea",
    async fetchTracking(trackingNumber: string): Promise<TrackingUpdate> {
      // TODO: real Evergreen tracking
      return mockFetchTracking(trackingNumber, ctxFor(trackingNumber));
    },
  };
}
