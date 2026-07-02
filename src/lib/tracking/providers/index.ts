/**
 * Carriers whose SERVER-SIDE tracking fetcher (in
 * supabase/functions/tracking-reconcile/index.ts) is still a stub
 * returning placeholder data. The UI shows a "mock data" warning on
 * the EtaCell for these so operators don't trust the displayed ETA.
 *
 * The old client-side polling providers that used to live in this
 * directory (mock/maersk/cosco/evergreen/fedex/dhl) were removed
 * 2026-07-02 (audit) — that per-browser polling pattern was retired
 * when the server-side reconciler (pg_cron every 6h + manual "Refresh
 * tracking") took over. Restore from git history if ever needed.
 *
 * Remove a carrier here when its server-side fetcher in
 * tracking-reconcile/index.ts gets a real implementation. Currently:
 *   * fedex, ups, dhl — REAL (live carrier APIs)
 *   * maersk, cosco, evergreen — ocean carriers, no implementation plans
 */
export const MOCK_CARRIERS: ReadonlySet<string> = new Set([
  "maersk",
  "cosco",
  "evergreen",
]);

export function isCarrierMock(carrierName: string | null | undefined): boolean {
  if (!carrierName) return false;
  return MOCK_CARRIERS.has(carrierName.toLowerCase().trim());
}
