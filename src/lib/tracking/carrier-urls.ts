/**
 * Public tracking-page URL builders for each carrier we support in the
 * carrier_name field on freight_shipments. Used to make the tracking
 * number on the Freight Dashboard + detail page a clickable link that
 * pops out to the carrier's own tracking site.
 *
 * Coverage is independent of our server-side tracking-reconcile coverage:
 * Maersk, COSCO, and Evergreen don't have working API integrations yet,
 * but their public tracking pages still take a B/L number in a URL param,
 * so a click-through link works regardless.
 *
 * For carriers not in this map, the call returns null and the caller
 * should render the tracking number as plain text.
 */

type UrlBuilder = (trackingNumber: string) => string;

// Lower-cased carrier name → URL builder. Matching is case-insensitive
// and trims whitespace because operator-entered carrier names sometimes
// drift (e.g. "FedEx " with a trailing space).
const BUILDERS: Record<string, UrlBuilder> = {
  fedex: (t) => `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(t)}`,
  ups:   (t) => `https://www.ups.com/track?loc=en_US&tracknum=${encodeURIComponent(t)}`,
  dhl:   (t) =>
    `https://www.dhl.com/us-en/home/tracking/tracking-express.html?submit=1&tracking-id=${encodeURIComponent(t)}`,
  // Sea carriers — public tracking pages take a bill-of-lading number
  // as a URL param. None of these have a working OAuth API integration
  // on our side, but the link-out still works.
  maersk: (t) => `https://www.maersk.com/tracking/${encodeURIComponent(t)}`,
  cosco: (t) =>
    `https://elines.coscoshipping.com/ebusiness/cargoTracking?trackingType=BILLOFLADING&number=${encodeURIComponent(t)}`,
  evergreen: (t) =>
    `https://ss.shipmentlink.com/servlet/TUF1_CargoTracking.do?Action=cargoTracking&BillOfLading=${encodeURIComponent(t)}`,
  usps: (t) => `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encodeURIComponent(t)}`,
};

/**
 * Return the carrier's public tracking page URL for a given tracking
 * number, or null if we don't have a URL pattern for that carrier.
 *
 * Both carrier_name and tracking_number can be null/empty on a freshly-
 * created shipment; the caller is expected to short-circuit on those.
 */
export function getCarrierTrackingUrl(
  carrierName: string | null | undefined,
  trackingNumber: string | null | undefined,
): string | null {
  if (!carrierName || !trackingNumber) return null;
  const key = carrierName.toLowerCase().trim();
  const builder = BUILDERS[key];
  return builder ? builder(trackingNumber.trim()) : null;
}
