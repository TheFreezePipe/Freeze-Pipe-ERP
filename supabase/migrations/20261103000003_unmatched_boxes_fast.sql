-- shipstation_unmatched_boxes, rewritten for speed. Same columns and
-- meaning (box sizes shipped in the trailing 90 days that no material in
-- the catalog matches, by sorted dimensions). Two changes:
--   * the scan is bounded by order_date, which is indexed, instead of a
--     COALESCE that forced a full scan of every order ever stored;
--   * the sorted-dimensions key is computed with GREATEST/LEAST arithmetic
--     instead of an unnest-and-sort subquery per row, and the JSON read is
--     materialized once per row so the join never re-reads the payload.
CREATE OR REPLACE VIEW public.shipstation_unmatched_boxes AS
WITH o AS MATERIALIZED (
  SELECT o.id, o.ship_date,
         round(((o.raw_payload -> 'dimensions') ->> 'length')::numeric)::integer AS l,
         round(((o.raw_payload -> 'dimensions') ->> 'width')::numeric)::integer AS w,
         round(((o.raw_payload -> 'dimensions') ->> 'height')::numeric)::integer AS h
  FROM shipstation_orders o
  WHERE o.order_status = 'shipped'
    AND o.order_date >= (CURRENT_DATE - 120)
    AND COALESCE(o.ship_date, o.order_date) >= (CURRENT_DATE - 90)
    AND (o.raw_payload -> 'dimensions') ->> 'length' IS NOT NULL
    AND (o.raw_payload -> 'dimensions') ->> 'width' IS NOT NULL
    AND (o.raw_payload -> 'dimensions') ->> 'height' IS NOT NULL
), k AS MATERIALIZED (
  SELECT id, ship_date,
         GREATEST(l, w, h) AS a,
         (l + w + h) - GREATEST(l, w, h) - LEAST(l, w, h) AS b,
         LEAST(l, w, h) AS c
  FROM o
), m AS (
  SELECT DISTINCT
         GREATEST(rl, rw, rh) AS a,
         (rl + rw + rh) - GREATEST(rl, rw, rh) - LEAST(rl, rw, rh) AS b,
         LEAST(rl, rw, rh) AS c
  FROM (SELECT round(dim_length_in::double precision)::integer AS rl,
               round(dim_width_in::double precision)::integer AS rw,
               round(dim_height_in::double precision)::integer AS rh
          FROM materials
         WHERE dim_length_in IS NOT NULL AND dim_width_in IS NOT NULL AND dim_height_in IS NOT NULL) x
)
SELECT (k.a::text || 'x' || k.b::text || 'x' || k.c::text) AS dims_key,
       count(*) AS shipments,
       max(k.ship_date) AS last_shipped
FROM k
LEFT JOIN m ON m.a = k.a AND m.b = k.b AND m.c = k.c
WHERE m.a IS NULL
GROUP BY 1
ORDER BY count(*) DESC;
