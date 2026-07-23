-- ============================================================================
-- Phase 2 receiving: carrier piece-level delivery counts
-- ============================================================================
-- tracking-reconcile already receives per-piece data for multi-piece
-- shipments (FedEx trackResults[], UPS package[]) and discarded it. These
-- columns store the counts so the receiving panel can say "N cartons on
-- your dock awaiting check-in" and the daily report can flag stalled
-- pieces. Purely informational: piece counts NEVER credit inventory —
-- only tapped cartons do (Phase 1 invariant).

ALTER TABLE public.freight_shipments
  ADD COLUMN IF NOT EXISTS carrier_pieces_total integer,
  ADD COLUMN IF NOT EXISTS carrier_pieces_delivered integer,
  ADD COLUMN IF NOT EXISTS carrier_pieces_on_vehicle integer,
  ADD COLUMN IF NOT EXISTS carrier_pieces_updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS carrier_last_piece_event_at timestamptz;

COMMENT ON COLUMN public.freight_shipments.carrier_pieces_total IS
  'Multi-piece shipment: piece count reported by the carrier API (null = carrier did not enumerate pieces).';
COMMENT ON COLUMN public.freight_shipments.carrier_pieces_delivered IS
  'Pieces the carrier reports as delivered. Informational only — never credits inventory.';
