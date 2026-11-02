-- ShipStation shipments: one row per label, with the carrier cost actually
-- paid. Fed by the shipstation-shipments-sync edge function. This is the
-- source for "as sold" outbound shipping cost per SKU (allocated from real
-- orders) and for the standalone cost of single-item orders.
CREATE TABLE public.shipstation_shipments (
  shipment_id     bigint PRIMARY KEY,
  order_id        bigint,
  order_key       text,
  order_number    text,
  ship_date       date,
  shipment_cost   numeric(10,2),
  insurance_cost  numeric(10,2),
  carrier_code    text,
  service_code    text,
  package_code    text,
  weight_oz       numeric(10,2),
  length_in       numeric(8,2),
  width_in        numeric(8,2),
  height_in       numeric(8,2),
  voided          boolean NOT NULL DEFAULT false,
  ship_to_country text,
  ship_to_state   text,
  ship_to_zip3    text,
  -- [{sku, quantity}] as ShipStation reports the label's contents
  items           jsonb NOT NULL DEFAULT '[]'::jsonb,
  synced_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX shipstation_shipments_order_id_idx ON public.shipstation_shipments (order_id);
CREATE INDEX shipstation_shipments_ship_date_idx ON public.shipstation_shipments (ship_date);

ALTER TABLE public.shipstation_shipments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated can read shipstation shipments"
  ON public.shipstation_shipments FOR SELECT TO authenticated USING (true);
