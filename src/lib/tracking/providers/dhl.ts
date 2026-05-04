import type { TrackingProvider, TrackingUpdate } from "../types";
import { mockFetchTracking, type MockContext } from "./mock";

/**
 * DHL Express tracking. Real integration:
 *   - DHL Shipment Tracking - Unified API:
 *     https://developer.dhl.com/api-reference/shipment-tracking
 *   - Auth: DHL-API-Key header
 *   - GET /track/shipments?trackingNumber={awb}
 *
 * Mock fallback until an API key is configured.
 */
export function createDhlProvider(ctxFor: (trackingNumber: string) => MockContext): TrackingProvider {
  return {
    name: "DHL",
    carrierType: "air",
    async fetchTracking(trackingNumber: string): Promise<TrackingUpdate> {
      // TODO: real DHL API
      return mockFetchTracking(trackingNumber, ctxFor(trackingNumber));
    },
  };
}
