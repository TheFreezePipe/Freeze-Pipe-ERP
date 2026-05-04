-- Persist the actual carton count entered when a shipment is created.
-- Computed in the UI as sum(carton_qty) across all carton groups in the form,
-- then written here so the dashboard doesn't have to re-derive (which would
-- only give an estimate based on each SKU's standard_quantity_per_carton and
-- couldn't account for mixed cartons).

ALTER TABLE freight_shipments
  ADD COLUMN IF NOT EXISTS total_cartons integer;

COMMENT ON COLUMN freight_shipments.total_cartons IS
  'Actual total cartons entered at shipment creation. NULL for legacy rows where the user did not provide a count.';
