-- =============================================================
-- Migration 022: Add supplier pre-departure statuses to freight_shipments
-- =============================================================
-- Follow-up to 020 + 021. The supplier insert RLS policy
-- (supplier_insert_own_shipments) and rpc_supplier_create_freight_shipment
-- both set the new shipment's status to 'pending', which isn't allowed by
-- the existing CHECK constraint from migration 012:
--
--   CHECK (status IN ('on_the_water', 'high_risk', 'cleared_customs',
--                     'tracking', 'delivered'))
--
-- This means suppliers currently can't create shipments at all — the CHECK
-- rejects the insert before RLS has a chance to matter. We add two
-- pre-departure states:
--
--   pending — supplier has declared the shipment but hasn't booked a carrier.
--             Nothing physical has happened yet; editable by the supplier.
--
--   booked  — supplier has confirmed booking with the carrier. Tracking
--             number + ETA are now set. Awaiting departure.
--
-- Transition path (reality):
--   pending (supplier creates) → booked (supplier books) → on_the_water
--   (freight departs; set by internal receive / ShipStation webhook) →
--   high_risk | cleared_customs | tracking → delivered
--
-- No existing rows are affected; both new statuses are additive. The
-- regression-prevention trigger (migration 013) only blocks
-- delivered → anything, so adding earlier-stage states is safe.

ALTER TABLE freight_shipments DROP CONSTRAINT IF EXISTS freight_shipments_status_check;
ALTER TABLE freight_shipments
  ADD CONSTRAINT freight_shipments_status_check
  CHECK (status IN (
    'pending',
    'booked',
    'on_the_water',
    'high_risk',
    'cleared_customs',
    'tracking',
    'delivered'
  ));

COMMENT ON COLUMN freight_shipments.status IS
  'Lifecycle: pending (supplier drafted) -> booked (carrier confirmed) -> on_the_water (departed; internal takes over) -> high_risk | cleared_customs | tracking -> delivered.';
