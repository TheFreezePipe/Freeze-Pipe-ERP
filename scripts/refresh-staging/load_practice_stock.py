#!/usr/bin/env python3
"""Put PRACTICE stock on STAGING's shelves so the map, the rack elevation and the drawer have contents.

  python scripts/refresh-staging/load_practice_stock.py             # plan + rpc_wh_import_stock dry run, writes nothing
  python scripts/refresh-staging/load_practice_stock.py --apply     # ... then import it for real

Builds a placement from staging's own inventory_levels (design 9.6 step 4, the opening-balance import):
  - finished: for each active SKU with warehouse_finished > 0, one OPEN carton (1-12 units) on a pickable RTS
    bay-level, SKUs spread across the pick faces (round robin over the faces in walk order, so neighbouring SKUs
    land on different faces), A-class first, then B, C and unclassified, larger stock first; the rest as SEALED
    cartons of 12 in the same bay's level-3 overflow (no spilling to other bays);
  - raw: warehouse_raw as sealed cartons of 12 (plus one open carton for the remainder) in the RAW bays;
  - prefilled: warehouse_prefilled_raw the same way in the WIP bays (bucket prefilled_raw);
  - every bay-level is capped at capacity_cartons, or --default-capacity when it has none (all of staging today);
    whatever does not fit is reported as unplaced. In-production units are left on the line (not placed).
It then calls rpc_wh_import_stock(rows, true) and prints the summary; --apply calls it with false, which mints
C-OB-nnnn cartons with opening_balance movements. PRACTICE DATA: no inventory_transactions (ledger) rows are
written and inventory_levels is not touched, so book and shelf totals differ by whatever is unplaced.

Not idempotent: --apply refuses while any warehouse balance or carton exists (movements are append-only, so a
second load cannot be undone by this script; rebuild staging to start over).

STAGING ONLY: scripts/staging/mgmt.STG; any other ref (production above all) is refused. The token is read by
mgmt.py from .env.local and never printed.

Exit codes: 0 ok, 1 a call failed or rows were rejected, 3 refused because stock already exists, 4 refused (ref).
"""

import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..'))
sys.path.insert(0, os.path.join(REPO, 'scripts', 'staging'))

import mgmt  # noqa: E402  (scripts/staging/mgmt.py: the Management API helper)

PROD_REF = 'pnqujtugddxusllkikje'  # pinned here as well, so a bad edit of mgmt.py cannot redirect writes
UNITS_PER_CARTON = 12
ABC_RANK = {'A': 0, 'B': 1, 'C': 2}


# ---------------------------------------------------------------------------------------------
# staging calls
# ---------------------------------------------------------------------------------------------
def rpc(ref, sql):
    rows = mgmt.q(sql, ref)
    if not rows:
        raise RuntimeError('empty response for: ' + sql.splitlines()[0][:120])
    value = next(iter(rows[0].values()))
    return json.loads(value) if isinstance(value, str) else value


def jsonb(obj):
    return mgmt.lit(json.dumps(obj, separators=(',', ':'))) + '::jsonb'


def load_inputs(ref):
    skus = mgmt.q("""
        SELECT ps.id, ps.sku, ps.abc_classification AS abc, ps.category,
               greatest(COALESCE(il.warehouse_finished, 0), 0)      AS finished,
               greatest(COALESCE(il.warehouse_raw, 0), 0)           AS raw,
               greatest(COALESCE(il.warehouse_prefilled_raw, 0), 0) AS prefilled,
               greatest(COALESCE(il.warehouse_in_production, 0), 0) AS in_production
          FROM public.product_skus ps
          JOIN public.inventory_levels il ON il.sku_id = ps.id
         WHERE ps.is_active
         ORDER BY ps.sku""", ref)
    locations = mgmt.q("""
        SELECT l.code, l.zone, l.face, l.bay, l.level, l.pickable, l.is_overflow, l.pick_sequence, l.capacity_cartons
          FROM public.wh_locations l
         WHERE l.kind = 'bay_level' AND l.active
         ORDER BY l.pick_sequence NULLS LAST, l.code""", ref)
    existing = mgmt.q("""
        SELECT (SELECT count(*) FROM public.wh_inventory_balances WHERE on_hand <> 0) AS balances,
               (SELECT count(*) FROM public.wh_containers) AS containers""", ref)[0]
    return skus, locations, existing


# ---------------------------------------------------------------------------------------------
# placement (pure)
# ---------------------------------------------------------------------------------------------
def split_cartons(units, open_last=True):
    """Units -> (sealed cartons of 12, open units). Finished keeps 1-12 units in the open carton."""
    if units <= 0:
        return 0, 0
    if open_last:
        sealed = (units - 1) // UNITS_PER_CARTON
        return sealed, units - sealed * UNITS_PER_CARTON
    return units // UNITS_PER_CARTON, units % UNITS_PER_CARTON


def faces_in_walk_order(locs):
    first = {}
    for loc in locs:
        seq = loc['pick_sequence'] if loc['pick_sequence'] is not None else 10 ** 9
        first[loc['face']] = min(first.get(loc['face'], 10 ** 9), seq)
    return sorted(first, key=lambda f: (first[f], f))


def round_robin(locs):
    """Locations interleaved across faces (faces in walk order, each face's locations in walk order)."""
    by_face = {}
    for loc in sorted(locs, key=lambda x: (x['pick_sequence'] or 10 ** 9, x['code'])):
        by_face.setdefault(loc['face'], []).append(loc)
    order = faces_in_walk_order(locs)
    out = []
    for i in range(max((len(v) for v in by_face.values()), default=0)):
        for f in order:
            if i < len(by_face[f]):
                out.append(by_face[f][i])
    return out


class Shelf:
    """Carton counts per location, capped at capacity_cartons (or the default)."""

    def __init__(self, locations, default_cap):
        self.cap = {l['code']: (l['capacity_cartons'] or default_cap) for l in locations}
        self.used = {l['code']: 0 for l in locations}

    def room(self, code):
        return self.cap[code] - self.used[code]

    def take(self, code, cartons):
        n = max(0, min(cartons, self.room(code)))
        self.used[code] += n
        return n


def plan(skus, locations, default_cap):
    """The rpc_wh_import_stock rows plus a report of what did not fit."""
    shelf = Shelf(locations, default_cap)
    rows = []
    unplaced = {'finished': 0, 'raw': 0, 'prefilled_raw': 0}
    walk = sorted(locations, key=lambda x: (x['pick_sequence'] or 10 ** 9, x['code']))
    seq = {l['code']: (l['pick_sequence'] or 10 ** 9) for l in locations}

    def add(sku, code, sealed, open_units, bucket):
        if sealed or open_units:
            rows.append({'sku': sku, 'location': code, 'sealed_cartons': sealed, 'open_units': open_units,
                         'units_per_carton': UNITS_PER_CARTON, 'bucket': bucket})

    # finished: an open carton on a pick bin, sealed cartons in the overflow above it
    pick_bins = round_robin([l for l in locations if l['pickable'] and l['zone'] == 'RTS'])
    overflow = [l for l in walk if l['zone'] == 'RTS' and l['is_overflow']]
    finished = sorted((s for s in skus if s['finished'] > 0),
                      key=lambda s: (ABC_RANK.get(s['abc'] or '', 3), -s['finished'], s['sku']))
    for i, s in enumerate(finished):
        sealed, open_units = split_cartons(s['finished'])
        pick = None
        for j in range(len(pick_bins)):
            candidate = pick_bins[(i + j) % len(pick_bins)]
            if shelf.take(candidate['code'], 1):
                pick = candidate
                break
        if pick:
            add(s['sku'], pick['code'], 0, open_units, 'finished')
        else:
            unplaced['finished'] += open_units
        above = None
        if pick:
            above = max((l for l in overflow if l['face'] == pick['face'] and l['bay'] == pick['bay']),
                        key=lambda l: l['level'], default=None)
        left = sealed
        if above and left:
            n = shelf.take(above['code'], left)
            add(s['sku'], above['code'], n, 0, 'finished')
            left -= n
        unplaced['finished'] += left * UNITS_PER_CARTON

    # raw and prefilled: sealed cartons of 12 plus an open remainder, filling their zone
    for bucket, field, zone in (('raw', 'raw', 'RAW'), ('prefilled_raw', 'prefilled', 'WIP')):
        bins = round_robin([l for l in locations if l['zone'] == zone])
        for cursor, s in enumerate(sorted((s for s in skus if s[field] > 0), key=lambda s: (-s[field], s['sku']))):
            sealed, open_units = split_cartons(s[field], open_last=False)
            for k in range(len(bins)):
                if sealed == 0 and open_units == 0:
                    break
                loc = bins[(cursor + k) % len(bins)]
                room = shelf.room(loc['code'])
                if room <= 0:
                    continue
                n_sealed = min(sealed, room)
                n_open = 1 if open_units and room - n_sealed > 0 else 0
                shelf.take(loc['code'], n_sealed + n_open)
                add(s['sku'], loc['code'], n_sealed, open_units if n_open else 0, bucket)
                sealed -= n_sealed
                if n_open:
                    open_units = 0
            unplaced[bucket] += sealed * UNITS_PER_CARTON + open_units

    rows.sort(key=lambda r: (seq.get(r['location'], 10 ** 9), r['sku']))
    return rows, unplaced, shelf


def summarise(rows, skus):
    by_bucket = {}
    for r in rows:
        b = by_bucket.setdefault(r['bucket'], {'rows': 0, 'sealed': 0, 'open': 0, 'units': 0, 'locations': set()})
        b['rows'] += 1
        b['sealed'] += r['sealed_cartons']
        b['open'] += 1 if r['open_units'] else 0
        b['units'] += r['sealed_cartons'] * UNITS_PER_CARTON + r['open_units']
        b['locations'].add(r['location'])
    books = {'finished': sum(s['finished'] for s in skus), 'raw': sum(s['raw'] for s in skus),
             'prefilled_raw': sum(s['prefilled'] for s in skus)}
    return by_bucket, books


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--apply', action='store_true', help='import for real after the dry run')
    ap.add_argument('--default-capacity', type=int, default=24,
                    help='cartons per bay-level when capacity_cartons is not set (default 24)')
    ap.add_argument('--ref', default=mgmt.STG, help='destination project (staging only; anything else is refused)')
    args = ap.parse_args()

    if args.ref in (PROD_REF, mgmt.PROD) or args.ref != mgmt.STG:
        print(f'Refusing: load_practice_stock.py writes to staging ({mgmt.STG}) only, not {args.ref}.', file=sys.stderr)
        return 4
    ref = mgmt.STG

    skus, locations, existing = load_inputs(ref)
    if not locations:
        print('No active bay-level locations on staging: run load_layout.py --apply first.', file=sys.stderr)
        return 1
    rows, unplaced, shelf = plan(skus, locations, args.default_capacity)
    by_bucket, books = summarise(rows, skus)

    print(f'Staging: {len(skus)} active SKUs with inventory_levels, {len(locations)} active bay-levels; '
          f'capacity {args.default_capacity} cartons per bay-level where none is set.')
    for bucket in ('finished', 'raw', 'prefilled_raw'):
        b = by_bucket.get(bucket)
        placed = b['units'] if b else 0
        print(f"  {bucket:<13} books {books[bucket]:>7,}  placed {placed:>7,} units"
              + (f" ({b['sealed']} sealed + {b['open']} open cartons in {len(b['locations'])} locations)" if b else '')
              + (f"  unplaced {unplaced[bucket]:,}" if unplaced[bucket] else ''))
    in_prod = sum(s['in_production'] for s in skus)
    if in_prod:
        print(f'  in_production {in_prod:,} units stay on the line (not placed)')
    full = sorted(c for c in shelf.used if shelf.used[c] >= shelf.cap[c])
    if full:
        print(f'  full bay-levels ({len(full)}): ' + ', '.join(full))

    dry = rpc(ref, f'SELECT public.rpc_wh_import_stock({jsonb(rows)}, true)')
    if not dry.get('ok'):
        print('Dry run failed: ' + str(dry.get('message') or dry.get('error')), file=sys.stderr)
        return 1
    rejected = dry.get('rejected') or []
    print(f"Dry run: {dry['rows']} rows, {dry['accepted']} accepted, {dry['cartons']} cartons, {dry['units']:,} units"
          + (f', {len(rejected)} rejected' if rejected else ''))
    for r in rejected[:20]:
        print(f"  rejected row {r.get('row')}: {r.get('sku')} @ {r.get('location')}: {r.get('error')}")
    if rejected:
        return 1

    if not args.apply:
        print('Dry run only. Re-run with --apply to import it.')
        return 0
    if int(existing['balances']) or int(existing['containers']):
        print(f"Refusing --apply: staging already has {existing['balances']} non-zero balances and "
              f"{existing['containers']} cartons. Movements are append-only; rebuild staging to start over.", file=sys.stderr)
        return 3

    done = rpc(ref, f'SELECT public.rpc_wh_import_stock({jsonb(rows)}, false)')
    if not done.get('ok'):
        print('Import failed: ' + str(done.get('message') or done.get('error')), file=sys.stderr)
        return 1
    print(f"Imported: {done['cartons']} cartons ({done.get('first_code')} .. {done.get('last_code')}), {done['units']:,} units, "
          f"movement group {done.get('movement_group_id')}.")
    return 0


if __name__ == '__main__':
    sys.exit(main())
