import type { TrackingProvider, TrackingUpdate } from "../types";
import { mockFetchTracking, type MockContext } from "./mock";

/**
 * Maersk tracking. Real integration would use:
 *   - Track & Trace API: https://developer.maersk.com/api-catalogue/track-and-trace
 *   - Auth: OAuth2 client credentials (consumer-key + secret)
 *   - Endpoint: GET /track/{containerOrBlNumber}
 *
 * Until credentials are configured, this falls back to the deterministic mock.
 */
export function createMaerskProvider(ctxFor: (trackingNumber: string) => MockContext): TrackingProvider {
  return {
    name: "Maersk",
    carrierType: "sea",
    async fetchTracking(trackingNumber: string): Promise<TrackingUpdate> {
      // TODO: real Maersk API call
      // const res = await fetch(`https://api.maersk.com/track/${trackingNumber}`, { headers: { ... } });
      return mockFetchTracking(trackingNumber, ctxFor(trackingNumber));
    },
  };
}
