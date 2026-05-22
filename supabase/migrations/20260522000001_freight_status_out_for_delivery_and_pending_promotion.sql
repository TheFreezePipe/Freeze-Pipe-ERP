-- =============================================================
-- Migration: Add `out_for_delivery` freight status + auto-promote
--            pending → on_the_water on tracking number entry
-- =============================================================
-- Two related changes:
--
-- 1. New status value `out_for_delivery`. Sits between `tracking`
--    (carrier holding it, in motion) and `delivered` (in operator's
--    hands). Set automatically by tracking-reconcile when a carrier
--    flips its own status to "out for delivery." Gives operators the
--    "it's hitting the truck today" signal they want during morning
--    receiving prep.
--
-- 2. Auto-promote trigger: when a freight shipment gets a tracking
--    number set for the first time (NULL → non-NULL), promote its
--    status from `pending` → `on_the_water` automatically. Mirrors
--    the supplier-portal RPC's existing logic but works for any
--    update path (admin inline-edit, future scripts, etc.).
--
-- Also backfills three existing shipments that are stuck at
-- `on_the_water` without a tracking number — those should have been
-- `pending` all along. They were created via the admin "New Shipment"
-- form which hardcoded `on_the_water` regardless of whether a tracking
-- number was provided. The frontend fix lands separately.
-- =============================================================

-- 1. Extend the status CHECK constraint
ALTER TABLE public.freight_shipments
  DROP CONSTRAINT IF EXISTS freight_shipments_status_check;

ALTER TABLE public.freight_shipments
  ADD CONSTRAINT freight_shipments_status_check
  CHECK (status = ANY (ARRAY[
    'pending'::text,
    'on_the_water'::text,
    'high_risk'::text,
    'cleared_customs'::text,
    'tracking'::text,
    'out_for_delivery'::text,
    'delivered'::text
  ]));

-- 2. Auto-promote trigger
CREATE OR REPLACE FUNCTION public.auto_promote_pending_on_tracking() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Only fires when tracking_number transitions from null/empty to set,
  -- AND the current status is still `pending`. Doesn't touch anything
  -- if the operator manually set status to high_risk while pending, etc.
  IF (OLD.tracking_number IS NULL OR OLD.tracking_number = '')
     AND NEW.tracking_number IS NOT NULL
     AND NEW.tracking_number <> ''
     AND OLD.status = 'pending'
     AND NEW.status = OLD.status THEN
    NEW.status := 'on_the_water';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_auto_promote_pending_on_tracking ON public.freight_shipments;
CREATE TRIGGER trg_auto_promote_pending_on_tracking
  BEFORE UPDATE OF tracking_number ON public.freight_shipments
  FOR EACH ROW EXECUTE FUNCTION public.auto_promote_pending_on_tracking();

-- 3. Backfill: any existing shipment stuck at `on_the_water` with no
--    tracking number should be `pending`. Per the May 22 product spec,
--    shipments without tracking are not yet "on the water." Three rows
--    in prod today (418, 419, 426).
UPDATE public.freight_shipments
   SET status = 'pending'
 WHERE status = 'on_the_water'
   AND (tracking_number IS NULL OR tracking_number = '');
