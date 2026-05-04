-- Adds a new 'tracking' status to freight_shipments, representing the phase
-- between Cleared Customs and Delivered when the carrier has confirmed receipt
-- and is actively moving the package.
--
-- Auto-transition to 'tracking' happens in the application layer (tracking hook
-- + reconcileEta) when a carrier API returns status=in_transit or
-- out_for_delivery. high_risk is preserved (human-set hold).

ALTER TABLE freight_shipments
  DROP CONSTRAINT IF EXISTS freight_shipments_status_check;

ALTER TABLE freight_shipments
  ADD CONSTRAINT freight_shipments_status_check
  CHECK (status IN ('on_the_water', 'high_risk', 'cleared_customs', 'tracking', 'delivered'));
