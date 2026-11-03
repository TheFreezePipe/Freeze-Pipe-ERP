-- shipstation_unmatched_boxes: scan the trailing 90 days instead of everything
-- since 2026-06-09. The fixed start date made the view grow with every shipped
-- order (16k rows, mean 1.4 s, worst 8 s = the authenticated statement timeout,
-- so the Materials page's box panel failed under load). Ninety days is enough
-- to catch a box size the team has started using. Grants are unchanged.
CREATE OR REPLACE VIEW public.shipstation_unmatched_boxes AS
SELECT k.dims_key,
    count(*) AS shipments,
    max(s.ship_date) AS last_shipped
   FROM ( SELECT o.id,
            o.ship_date,
            round(((o.raw_payload -> 'dimensions'::text) ->> 'length'::text)::numeric)::integer AS l,
            round(((o.raw_payload -> 'dimensions'::text) ->> 'width'::text)::numeric)::integer AS w,
            round(((o.raw_payload -> 'dimensions'::text) ->> 'height'::text)::numeric)::integer AS h
           FROM shipstation_orders o
          WHERE o.order_status = 'shipped'::text AND ((o.raw_payload -> 'dimensions'::text) ->> 'length'::text) IS NOT NULL AND ((o.raw_payload -> 'dimensions'::text) ->> 'width'::text) IS NOT NULL AND ((o.raw_payload -> 'dimensions'::text) ->> 'height'::text) IS NOT NULL AND COALESCE(o.ship_date, o.order_date) >= (CURRENT_DATE - 90) AND NOT (EXISTS ( SELECT 1
                   FROM materials m
                  WHERE m.dim_length_in IS NOT NULL AND m.dim_width_in IS NOT NULL AND m.dim_height_in IS NOT NULL AND (ARRAY( SELECT d.d
                           FROM unnest(ARRAY[round(m.dim_length_in::double precision)::integer, round(m.dim_width_in::double precision)::integer, round(m.dim_height_in::double precision)::integer]) d(d)
                          ORDER BY d.d DESC)) = (ARRAY( SELECT d.d
                           FROM unnest(ARRAY[round(((o.raw_payload -> 'dimensions'::text) ->> 'length'::text)::numeric)::integer, round(((o.raw_payload -> 'dimensions'::text) ->> 'width'::text)::numeric)::integer, round(((o.raw_payload -> 'dimensions'::text) ->> 'height'::text)::numeric)::integer]) d(d)
                          ORDER BY d.d DESC))))) s
     CROSS JOIN LATERAL ( SELECT array_to_string(ARRAY( SELECT d.d
                   FROM unnest(ARRAY[s.l, s.w, s.h]) d(d)
                  ORDER BY d.d DESC), 'x'::text) AS dims_key) k
  GROUP BY k.dims_key
  ORDER BY (count(*)) DESC;
