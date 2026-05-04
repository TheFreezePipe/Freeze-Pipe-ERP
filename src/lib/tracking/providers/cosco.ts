import type { TrackingProvider, TrackingUpdate } from "../types";
import { mockFetchTracking, type MockContext } from "./mock";

/**
 * COSCO SHIPPING tracking. Real integration would use:
 *   - COSCO Bill of Lading lookup: https://elines.coscoshipping.com/ebusiness/cargoTracking
 *   - Public endpoint accepts B/L number; no auth, but rate-limited.
 *   - Alternatively use a unified tracker (Project44, AfterShip) keyed by B/L.
 *
 * Until a real integration is wired up, this falls back to the mock.
 */
export function createCoscoProvider(ctxFor: (trackingNumber: string) => MockContext): TrackingProvider {
  return {
    name: "COSCO",
    carrierType: "sea",
    async fetchTracking(trackingNumber: string): Promise<TrackingUpdate> {
      // TODO: real COSCO API / scrape
      return mockFetchTracking(trackingNumber, ctxFor(trackingNumber));
    },
  };
}
