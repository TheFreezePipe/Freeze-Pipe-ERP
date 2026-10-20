"""Copy master data and scrubbed transactional data from production to staging.
Usage: python copy_to_staging.py <scratchpad_dir>
Reads production through the Management API; PII is replaced inside the production-side SELECT so it never leaves.
"""
import sys, os, json, time
sys.path.insert(0, sys.argv[1])
from mgmt import q, PROD, STG, lit
log = open(os.path.join(sys.argv[1], 'copy_to_staging.log'), 'a', encoding='utf-8')
def say(*a):
    s = ' '.join(str(x) for x in a); print(s); log.write(time.strftime('%H:%M:%S ') + s + '\n'); log.flush()

ORDER_FROM = '2026-08-01'
TABLES = [
    'locations', 'product_skus', 'product_boms', 'sku_supplier_costs', 'sku_economics', 'sku_forecasts',
    'inventory_levels', 'materials', 'material_inventory_levels', 'sku_material_consumption',
    'shipstation_sku_handling', 'audit_chain_config', 'demand_overrides', 'inventory_retail_value_daily',
    'mkt_sales', 'mkt_sale_stores', 'mkt_sale_baseline', 'mkt_sale_sku_lift', 'mkt_offers', 'mkt_offer_skus',
    'mkt_discount_codes', 'mkt_promo_history',
    'factory_orders', 'factory_order_items', 'freight_shipments', 'freight_line_items', 'freight_carton_groups',
    'freight_carton_group_skus', 'freight_receipts', 'task_logs',
    'shipstation_orders', 'shipstation_order_items', 'shipstation_order_discounts',
]
FILTERS = {
    'shipstation_orders': f"where order_date >= '{ORDER_FROM}'",
    'shipstation_order_items': f"where shipstation_order_id in (select id from shipstation_orders where order_date >= '{ORDER_FROM}')",
    'shipstation_order_discounts': f"where shipstation_order_id in (select id from shipstation_orders where order_date >= '{ORDER_FROM}')",
}
# scrubbed projection for orders: all columns, PII replaced, raw_payload reduced
SCRUB_ORDERS = """
to_jsonb(o)
 || jsonb_build_object(
      'customer_email', 'user-' || left(md5(coalesce(o.customer_email, o.customer_name, o.order_number)), 8) || '@example.com',
      'customer_name',  'Customer ' || upper(left(md5(coalesce(o.customer_email, o.customer_name, o.order_number)), 6)),
      'raw_payload', CASE WHEN o.raw_payload IS NULL THEN NULL ELSE
          (o.raw_payload - 'billTo' - 'customerEmail' - 'customerUsername' - 'customerNotes' - 'internalNotes' - 'giftMessage' - 'customerId')
          || jsonb_build_object('shipTo', jsonb_build_object(
               'state', o.raw_payload->'shipTo'->>'state',
               'country', o.raw_payload->'shipTo'->>'country',
               'postalCode', left(o.raw_payload->'shipTo'->>'postalCode', 3)))
          END)
"""

# topo order from production FK graph restricted to TABLES
edges = q("select c.conrelid::regclass::text child, c.confrelid::regclass::text parent from pg_constraint c where c.contype='f' and c.connamespace='public'::regnamespace and c.conrelid<>c.confrelid", PROD)
deps = {t: set() for t in TABLES}
for e in edges:
    if e['child'] in deps and e['parent'] in deps: deps[e['child']].add(e['parent'])
order = []
while deps:
    ready = [t for t, d in deps.items() if not d]
    if not ready: raise SystemExit('cycle among ' + str(deps))
    for t in sorted(ready, key=TABLES.index):
        order.append(t); del deps[t]
        for d in deps.values(): d.discard(t)
say('copy order:', order)

cols_by_table = {}
for t in order:
    cols = q(f"select column_name from information_schema.columns where table_schema='public' and table_name='{t}' and is_generated<>'ALWAYS' order by ordinal_position", STG)
    cols_by_table[t] = [c['column_name'] for c in cols]

for t in order:
    cols = cols_by_table[t]
    collist = ', '.join(f'"{c}"' for c in cols)
    where = FILTERS.get(t, '')
    total = q(f"select count(*) n from {t} o {where}", PROD)[0]['n']
    proj = SCRUB_ORDERS if t == 'shipstation_orders' else 'to_jsonb(o)'
    chunk = 300 if t == 'shipstation_orders' else 1500
    have = q(f'select count(*) n from "{t}"', STG)[0]['n']
    if have >= total and total > 0:
        say(f'{t}: already {have} rows, skipped'); continue
    copied = 0; offset = 0
    q(f'ALTER TABLE "{t}" DISABLE TRIGGER USER', STG)
    try:
        # order by primary key columns for stable paging
        pk = q(f"select a.attname from pg_index i join pg_attribute a on a.attrelid=i.indrelid and a.attnum = any(i.indkey) where i.indrelid='public.{t}'::regclass and i.indisprimary", PROD)
        orderby = ', '.join('o."' + p['attname'] + '"' for p in pk) or 'o.ctid'
        while offset < total:
            rows = q(f"select {proj} r from {t} o {where} order by {orderby} limit {chunk} offset {offset}", PROD)
            if not rows: break
            payload = json.dumps([r['r'] for r in rows])
            q(f'INSERT INTO "{t}" ({collist}) SELECT {collist} FROM json_populate_recordset(null::"{t}", {lit(payload)}) ON CONFLICT DO NOTHING', STG, timeout=600)
            copied += len(rows); offset += chunk
    finally:
        q(f'ALTER TABLE "{t}" ENABLE TRIGGER USER', STG)
    got = q(f'select count(*) n from "{t}"', STG)[0]['n']
    say(f'{t}: prod {total} -> staging {got}')
say('== copy done ==')
