import type { TrackingProvider, TrackingUpdate } from "../types";
import { mockFetchTracking, type MockContext } from "./mock";

/**
 * FedEx tracking. Real integration:
 *   - FedEx Track API: https://developer.fedex.com/api/en-us/catalog/track/v1/docs.html
 *   - Auth: OAuth2 client_credentials against https://apis.fedex.com/oauth/token
 *   - POST /track/v1/trackingnumbers
 *
 * Mock fallback until credentials are configured.
 */
export function createFedExProvider(ctxFor: (trackingNumber: string) => MockContext): TrackingProvider {
  return {
    name: "FedEx",
    carrierType: "air",
    async fetchTracking(trackingNumber: string): Promise<TrackingUpdate> {
      // TODO: real FedEx Track API
      return mockFetchTracking(trackingNumber, ctxFor(trackingNumber));
    },
  };
}
