-- Lets a human pin a freight status manually. Tracking polls continue to refresh
-- ETA + last-checked, but the reconciler skips status updates while this is set.
--
-- Set when: a user picks a status from the UI dropdown and confirms the override.
-- Cleared when: the user clicks the "Manual" badge to resume tracking-driven updates.

ALTER TABLE freight_shipments
  ADD COLUMN IF NOT EXISTS status_overridden_at timestamptz;

COMMENT ON COLUMN freight_shipments.status_overridden_at IS
  'When non-null, indicates the status was manually set by a user. Carrier tracking still updates ETA but skips status changes until this is cleared.';
