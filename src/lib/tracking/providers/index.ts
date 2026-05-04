import type { FreightShipment } from "@/types/database";
import type { TrackingProvider } from "../types";
import type { MockContext } from "./mock";
import { createMaerskProvider } from "./maersk";
import { createCoscoProvider } from "./cosco";
import { createEvergreenProvider } from "./evergreen";
import { createFedExProvider } from "./fedex";
import { createDhlProvider } from "./dhl";

/**
 * Registry of carrier-name -> provider. Keys are normalized (lowercased, trimmed).
 *
 * Each provider is constructed with a `ctxFor` closure that maps a tracking
 * number back to the shipment's baseline data. This lets the mock simulate
 * realistic drift without the UI having to hand context in at call time.
 *
 * When adding a new carrier:
 *   1. Create src/lib/tracking/providers/<carrier>.ts exporting a factory.
 *   2. Add an entry to `registry` below (normalized carrier name as key).
 */

/**
 * Build the registry given a resolver from tracking-number -> shipment.
 * Called once at the top of the tracking hook.
 */
export function buildProviderRegistry(
  shipmentLookup: (trackingNumber: string) => FreightShipment | null
): Record<string, TrackingProvider> {
  const ctxFor = (trackingNumber: string): MockContext => {
    const shipment = shipmentLookup(trackingNumber);
    return {
      // freight_type from generated types widens to string; our MockContext
      // expects the narrow "air" | "sea" union. Cast is safe because the
      // DB CHECK constraint already guarantees the value.
      carrierType: (shipment?.freight_type as "air" | "sea" | undefined) ?? "sea",
      carrierName: shipment?.carrier_name ?? "",
      baselineEta: shipment?.eta_original ?? shipment?.eta ?? null,
      shipDate: shipment?.ship_date ?? null,
    };
  };

  return {
    maersk: createMaerskProvider(ctxFor),
    cosco: createCoscoProvider(ctxFor),
    evergreen: createEvergreenProvider(ctxFor),
    fedex: createFedExProvider(ctxFor),
    dhl: createDhlProvider(ctxFor),
  };
}

export function getProvider(
  registry: Record<string, TrackingProvider>,
  carrierName: string | null | undefined
): TrackingProvider | null {
  if (!carrierName) return null;
  const key = carrierName.toLowerCase().trim();
  return registry[key] ?? null;
}

/**
 * Carriers whose tracking provider is currently a mock (returns
 * fabricated tracking data). Surface a "[mock]" indicator in the UI for
 * any shipment using one of these so operators don't trust simulated
 * data. Remove a carrier from this set when its real API integration
 * lands. Keep in sync with the providers/*.ts files.
 */
export const MOCK_CARRIERS: ReadonlySet<string> = new Set([
  "maersk",
  "cosco",
  "evergreen",
  "fedex",
  "dhl",
]);

export function isCarrierMock(carrierName: string | null | undefined): boolean {
  if (!carrierName) return false;
  return MOCK_CARRIERS.has(carrierName.toLowerCase().trim());
}
