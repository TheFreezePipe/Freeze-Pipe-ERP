#!/usr/bin/env python3
"""Restore the warehouse layout on STAGING from the digitizing workbook (design 9.6 steps 1-3).

  python scripts/refresh-staging/load_layout.py            # save layout + named geometry, generator dry run, compare
  python scripts/refresh-staging/load_layout.py --apply    # ... then create/update the bay-level locations
  python scripts/refresh-staging/load_layout.py --payload-only           # print the payload, send nothing
  python scripts/refresh-staging/load_layout.py --payload-only --write-fixture   # refresh the TS parity fixture

Reads `docs/research/warehouse-map/Warehouse digitizing workbook.xlsx` with openpyxl (formula cells have no
cached values, so everything is computed from the raw pixel columns and the Scale tab), then:
  1. rpc_wh_save_layout(templates, racks, faces, fixtures)   - all or nothing
  2. rpc_wh_save_location for each named location's geometry (IN-01, OUT-*, ST-S*, ST-MFG-*, ...)
  3. rpc_wh_generate_locations(NULL, true)                   - dry run, compared with the Locations tab
  4. with --apply and no conflicts: rpc_wh_generate_locations(NULL, false)

Twin of src/lib/warehouse/workbook-import.ts: the same rules, the same rounding (floor(v + 0.5)).
`--write-fixture` writes src/lib/warehouse/__fixtures__/layout-payload.json, which the TS test compares with
its own output, so a rule changed in one place and not the other fails `npm test`.

STAGING ONLY: the destination is scripts/staging/mgmt.STG; any other ref (and production above all) is
refused. Every RPC is idempotent: a re-run updates in place and the generator then creates and
deactivates nothing. The token is read by mgmt.py from .env.local and never printed.

Exit codes: 0 ok, 1 a call failed or the layout was rejected, 2 the comparison found code differences or
conflicts, 4 refused (wrong ref).
"""

import argparse
import json
import math
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..'))
sys.path.insert(0, os.path.join(REPO, 'scripts', 'staging'))

import mgmt  # noqa: E402  (scripts/staging/mgmt.py: the Management API helper)

PROD_REF = 'pnqujtugddxusllkikje'  # pinned here as well, so a bad edit of mgmt.py cannot redirect writes
DEFAULT_WORKBOOK = os.path.join(REPO, 'docs', 'research', 'warehouse-map', 'Warehouse digitizing workbook.xlsx')
FIXTURE_PATH = os.path.join(REPO, 'src', 'lib', 'warehouse', '__fixtures__', 'layout-payload.json')

ORIGIN_X, ORIGIN_Y = 180, 72
MM_PER_FT = 304.8
MM_PER_IN = 25.4
RACK_SNAP_MM = 100
WH_ZONES = ['RTS', 'RAW', 'BOX', 'WIP', 'ACC', 'MISC', 'IN', 'OUT', 'MFG', 'PACK', 'SPARE', 'VIRTUAL']

NAMED_ZONES = {
    'IN-01': 'IN', 'OUT-UPS': 'OUT', 'OUT-GAY-1': 'OUT', 'OUT-GAY-2': 'OUT',
    'ST-S1': 'PACK', 'ST-S2': 'PACK', 'ST-S3': 'PACK', 'ST-S4': 'PACK',
    'ST-MFG-1': 'MFG', 'ST-MFG-2': 'MFG', 'ST-MFG-3': 'MFG', 'ST-MFG-4': 'MFG',
    'SPARES-01': 'SPARE', 'CART-START': 'PACK', 'MFG-LINE': 'MFG',
}
STOCK_FLOOR = {'IN-01', 'OUT-UPS', 'OUT-GAY-1', 'OUT-GAY-2', 'SPARES-01', 'MFG-LINE'}
NAMED_RULES = [  # (regex, code template, primary)
    (r'^inbound staging', 'IN-01', True),
    (r'^dock door r\b', 'IN-01', False),
    (r'^ups table', 'OUT-UPS', True),
    (r'^dock door l\b', 'OUT-UPS', False),
    (r'^gaylord pallet base (\d)\b', 'OUT-GAY-{0}', True),
    (r'^av cart s(\d)\b', 'ST-S{0}', True),
    (r'^pack station s(\d) box stock', 'ST-S{0}', False),
    (r'^fill/cap desk (\d)\b', 'ST-MFG-{0}', True),
    (r'\bspares?\b', 'SPARES-01', True),
    (r'^cart start', 'CART-START', True),
    (r'^(?:uv curing rack|manufacturing line)', 'MFG-LINE', True),
]
UNPLACED_NAMED = ['ST-DOCK']
TEMPLATE_ABBR = {'pallet_rack': 'PR', 'shelving': 'SH', 'end_cap': 'EC', 'floor': 'FL'}
TEMPLATE_NAME = {'pallet_rack': 'Pallet rack', 'shelving': 'Shelving', 'end_cap': 'End cap', 'floor': 'Floor'}
SIDES = ['north', 'south', 'east', 'west', 'both']
DIRS = {'north': 'N', 'south': 'S', 'east': 'E', 'west': 'W'}
FIRST_END = {'S': 'north', 'N': 'south', 'E': 'west', 'W': 'east'}
BAY_LEVEL_RE = re.compile(r'^\d{2}-\d{2}-\d$')


# ---------------------------------------------------------------------------------------------
# helpers (mirrors of workbook-import.ts)
# ---------------------------------------------------------------------------------------------
def rnd(v):
    return int(math.floor(v + 0.5))


def snap(v, step):
    return int(math.floor(v / step + 0.5)) * step


def norm(h):
    return re.sub(r'[^a-z0-9]+', '', str(h).lower())


def get(row, *keys):
    headers = list(row.keys())
    for k in keys:
        nk = norm(k)
        for h in headers:
            if norm(h) == nk:
                return row[h]
        for h in headers:
            if norm(h).startswith(nk):
                return row[h]
    return None


def text(v):
    if v is None:
        return ''
    if isinstance(v, bool):
        return 'true' if v else 'false'
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v).strip()


def num(v):
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return v if math.isfinite(v) else None
    t = text(v)
    if not t:
        return None
    try:
        n = float(t)
    except ValueError:
        return None
    if not math.isfinite(n):
        return None
    return int(n) if n.is_integer() else n


def is_dash(t):
    return t in ('', '-', '–', '—')


def mean(xs):
    s = 0
    for x in xs:
        s += x
    return s / len(xs)


def mode(xs):
    counts = {}
    for x in xs:
        counts[x] = counts.get(x, 0) + 1
    best, best_n = xs[0], 0
    for x, n in counts.items():
        if n > best_n or (n == best_n and x > best):
            best, best_n = x, n
    return best


def parse_walk_dir(v):
    words = re.findall(r'north|south|east|west', text(v).lower())
    return DIRS[words[-1]] if words else None


def parse_pickable_levels(v):
    t = text(v)
    if is_dash(t):
        return []
    out = []
    for part in re.split(r'[^0-9]+', t):
        if not part:
            continue
        n = int(part)
        if 1 <= n <= 9 and n not in out:
            out.append(n)
    return sorted(out)


# ---------------------------------------------------------------------------------------------
# workbook reading
# ---------------------------------------------------------------------------------------------
def read_workbook(path):
    import openpyxl  # imported here so --help works without it

    wb = openpyxl.load_workbook(path, data_only=False)

    def cell_value(v):
        return None if isinstance(v, str) and v.startswith('=') else v

    scale = []
    for row in wb['Scale'].iter_rows(min_row=1, max_col=2):
        label, value = row[0].value, row[1].value
        if label is None and value is None:
            continue
        formula = value if isinstance(value, str) and value.startswith('=') else None
        scale.append({'label': label, 'value': cell_value(value), 'formula': formula})

    def table(name):
        ws = wb[name]
        rows = list(ws.iter_rows(values_only=True))
        if not rows:
            return []
        header = [text(h) for h in rows[0]]
        out = []
        for r in rows[1:]:
            if all(v is None for v in r):
                continue
            out.append({h: cell_value(v) for h, v in zip(header, r) if h})
        return out

    return {
        'scale': scale,
        'racks': table('Racks'),
        'faces': table('Faces'),
        'fixtures': table('Fixtures'),
        'locations': table('Locations'),
    }


SPAN_RE = re.compile(r'\(\s*(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*\)')


def read_scale(rows):
    bay_px = bay_w = depth = ppf_cell = capacity = None
    beams = {}
    measured_w = measured_l = drawn_w = drawn_l = None
    for r in rows:
        label = text(r.get('label')).lower()
        if not label:
            continue
        v = num(r.get('value'))
        span = SPAN_RE.search(r['formula']) if r.get('formula') else None
        span_px = (float(span.group(1)) - float(span.group(2))) if span else None
        beam = re.search(r'level\s*(\d+)\s*beam height', label)
        if 'average bay length' in label:
            bay_px = v
        elif 'bay width' in label:
            bay_w = v
        elif 'rack depth' in label:
            depth = v
        elif beam:
            beams[int(beam.group(1)) - 1] = v
        elif 'pixels per foot' in label:
            ppf_cell = v
        elif 'capacity' in label:
            capacity = v
        elif 'inside width' in label and 'measured' in label:
            measured_w = v
        elif 'inside length' in label and 'measured' in label:
            measured_l = v
        elif 'inside width' in label:
            drawn_w = span_px
        elif 'inside length' in label:
            drawn_l = span_px
    if not bay_px or bay_px <= 0:
        raise ValueError('Scale tab: the average bay length on the drawing (px) is missing.')
    if not bay_w or bay_w <= 0:
        raise ValueError('Scale tab: the bay width (inches) is missing.')
    if not depth or depth <= 0:
        raise ValueError('Scale tab: the rack depth (inches) is missing.')
    ppf = ppf_cell if ppf_cell is not None and ppf_cell > 0 else bay_px / (bay_w / 12)
    beam_heights = []
    i = 0
    while beams.get(i) is not None:
        beam_heights.append(beams[i])
        i += 1
    building = None
    if measured_w and measured_l and measured_w > 0 and measured_l > 0:
        building = {'width_mm': rnd(measured_w * MM_PER_FT), 'depth_mm': rnd(measured_l * MM_PER_FT), 'source': 'measured'}
    elif drawn_w and drawn_l and drawn_w > 0 and drawn_l > 0:
        building = {'width_mm': rnd((drawn_w / ppf) * MM_PER_FT), 'depth_mm': rnd((drawn_l / ppf) * MM_PER_FT),
                    'source': 'drawing'}
    return {
        'bayPx': bay_px, 'bayWidthIn': bay_w, 'rackDepthIn': depth, 'beamHeightsIn': beam_heights, 'pxPerFt': ppf,
        'capacityPerLevel': int(math.floor(capacity)) if capacity is not None and capacity > 0 else None,
        'building': building,
    }


def rack_kind(description, notes, face_codes):
    if not face_codes or re.search(r'not a stock location', notes, re.I):
        return 'fixture'
    if re.search(r'end\s*-?\s*caps?\b', description, re.I):
        return 'end_cap'
    if re.search(r'shel(f|v)', description, re.I):
        return 'shelving'
    if re.search(r'\bfloor\b', description, re.I):
        return 'floor'
    return 'pallet_rack'


def read_racks(rows, warnings):
    out = []
    for row in rows:
        code = text(get(row, 'Rack')).upper()
        if not re.match(r'^[A-Z0-9][A-Z0-9-]{0,15}$', code):
            continue
        x1, y1, x2, y2 = (num(get(row, k)) for k in ('x1 px', 'y1 px', 'x2 px', 'y2 px'))
        if None in (x1, y1, x2, y2):
            warnings.append(f'Racks: {code} has no pixel extents; skipped.')
            continue
        orientation = text(get(row, 'Orientation')).lower()
        if orientation.startswith('vert'):
            vertical = True
        elif orientation.startswith('hor'):
            vertical = False
        else:
            vertical = abs(y2 - y1) >= abs(x2 - x1)
            warnings.append(f"Racks: {code} has no orientation; read as {'vertical' if vertical else 'horizontal'} from its shape.")
        bays, levels = num(get(row, 'Bays')), num(get(row, 'Levels'))
        if bays is None or bays < 1 or levels is None or levels < 1:
            warnings.append(f'Racks: {code} needs bays and levels; skipped.')
            continue
        face_codes = [p.zfill(2) for p in re.split(r'[^0-9]+', text(get(row, 'Face codes'))) if p != '']
        description, notes = text(get(row, 'Description')), text(get(row, 'Notes'))
        out.append({
            'code': code, 'description': description, 'notes': notes, 'zoneText': text(get(row, 'Zone by bay')),
            'x1': min(x1, x2), 'y1': min(y1, y2), 'x2': max(x1, x2), 'y2': max(y1, y2), 'vertical': vertical,
            'bays': int(math.floor(bays)), 'levels': int(math.floor(levels)), 'faceCodes': face_codes,
            'kind': rack_kind(description, notes, face_codes),
        })
    return out


def zones_for(rack, side, direction, fallback, ctx, warnings):
    generic = specific = None
    for seg in [s.strip() for s in rack['zoneText'].split(';') if s.strip()]:
        m = re.match(r'^(north|south|east|west)\b[\s:]*(.*)$', seg, re.I)
        if m:
            if side and m.group(1).lower() == side:
                specific = m.group(2)
        elif generic is None:
            generic = seg
    chosen = specific if specific is not None else generic
    zones = []
    if chosen:
        for raw in [s.strip() for s in chosen.split(',') if s.strip()]:
            rep = re.match(r'^([A-Za-z]+)\s*[x×]\s*(\d+)$', raw)
            zone = (rep.group(1) if rep else raw).upper()
            times = int(rep.group(2)) if rep else 1
            ok = zone in WH_ZONES
            if not ok:
                warnings.append(f'{ctx}: zone "{raw}" is not a warehouse zone; using {fallback}.')
            zones.extend([zone if ok else fallback] * times)
    if not zones:
        zones.append(fallback)
    if len(zones) > rack['bays']:
        warnings.append(f"{ctx}: {len(zones)} zones for {rack['bays']} bays; the extra zones are ignored.")
        zones = zones[:rack['bays']]
    while len(zones) < rack['bays']:
        zones.append(zones[-1])
    against_run = (direction == 'N') if rack['vertical'] else (direction == 'W')
    return list(reversed(zones)) if against_run else zones


def named_for(name):
    for pattern, template, primary in NAMED_RULES:
        m = re.search(pattern, name, re.I)
        if m:
            return {'code': template.format(*m.groups()), 'primary': primary}
    return None


def fixture_kind(name, ftype, link):
    t = ftype.lower()
    if t == 'door' or re.search(r'\bdoor\b', name, re.I):
        return 'door'
    if re.search(r'\bdesk\b', name, re.I):
        return 'desk'
    if re.match(r'^(pack station|av cart|bubble wrap station)', name, re.I):
        return 'pack_station'
    if (link and link['primary'] and link['code'] in STOCK_FLOOR) or t in ('in', 'out', 'spare'):
        return 'staging'
    if t == 'fixture' or re.search(r'machine|barrel|\bac unit\b', name, re.I):
        return 'obstacle'
    return 'other'


def import_workbook(tabs):
    warnings = []
    scale = read_scale(tabs['scale'])
    ppf = scale['pxPerFt']

    def mm_x(px):
        return ((px - ORIGIN_X) / ppf) * MM_PER_FT

    def mm_y(px):
        return ((px - ORIGIN_Y) / ppf) * MM_PER_FT

    def mm_len(px):
        return (px / ppf) * MM_PER_FT

    rack_rows = read_racks(tabs['racks'], warnings)
    stock = [r for r in rack_rows if r['kind'] != 'fixture']
    templates, template_of = [], {}
    for r in stock:
        kind, key = r['kind'], f"{r['kind']}:{r['levels']}"
        if key in template_of:
            continue
        group = [x for x in stock if x['kind'] == kind and x['levels'] == r['levels']]
        heights = []
        for lvl in range(1, r['levels'] + 1):
            if lvl - 1 >= len(scale['beamHeightsIn']):
                raise ValueError(f"Scale tab: level {lvl} beam height is missing (needed by {', '.join(g['code'] for g in group)}).")
            heights.append(rnd(scale['beamHeightsIn'][lvl - 1] * MM_PER_IN))
        pallet = kind == 'pallet_rack'

        def along(x):
            return mm_len(x['y2'] - x['y1'] if x['vertical'] else x['x2'] - x['x1'])

        def across(x):
            return mm_len(x['x2'] - x['x1'] if x['vertical'] else x['y2'] - x['y1'])

        tpl = {
            'code': f"{TEMPLATE_ABBR[kind]}-{r['levels']}L",
            'name': f"{TEMPLATE_NAME[kind]}, {r['levels']} level{'' if r['levels'] == 1 else 's'}",
            'kind': kind,
            'bays': mode([g['bays'] for g in group]),
            'levels': r['levels'],
            'bay_width_mm': rnd(scale['bayWidthIn'] * MM_PER_IN) if pallet else rnd(mean([along(g) / g['bays'] for g in group])),
            'depth_mm': rnd(scale['rackDepthIn'] * MM_PER_IN) if pallet else rnd(mean([across(g) for g in group])),
            'level_heights_mm': heights,
            'overflow_top_level': pallet and r['levels'] >= 3,
            'capacity_cartons_per_level': scale['capacityPerLevel'],
        }
        template_of[key] = tpl
        templates.append(tpl)

    racks = []
    for r in stock:
        tpl = template_of[f"{r['kind']}:{r['levels']}"]
        along_px = r['y2'] - r['y1'] if r['vertical'] else r['x2'] - r['x1']
        across_px = r['x2'] - r['x1'] if r['vertical'] else r['y2'] - r['y1']
        racks.append({
            'code': r['code'],
            'description': r['description'] or None,
            'template_code': tpl['code'],
            'x_mm': snap(mm_x(r['x1']), RACK_SNAP_MM),
            'y_mm': snap(mm_y(r['y1']), RACK_SNAP_MM),
            'rot_deg': 90 if r['vertical'] else 0,
            'bays': r['bays'],
            'levels': r['levels'],
            'width_mm': r['bays'] * tpl['bay_width_mm'] if tpl['kind'] == 'pallet_rack' else rnd(mm_len(along_px)),
            'depth_mm': rnd(mm_len(across_px)),
        })
    rack_by_code = {r['code']: r for r in stock}

    face_rows = []
    for row in tabs['faces']:
        raw = text(get(row, 'Face'))
        if not re.match(r'^\d{1,2}$', raw):
            continue
        face = raw.zfill(2)
        side_text = text(get(row, 'Side')).lower()
        side = side_text if side_text in SIDES else None
        if side is None and not is_dash(side_text):
            warnings.append(f'Faces: face {face} side "{side_text}" is not north, south, east, west or both.')
        aisle_text = text(get(row, 'Aisle'))
        zone_default = text(get(row, 'Zone default')).upper()
        order_num = num(get(row, 'Walk order'))
        face_rows.append({
            'face': face,
            'rackCodes': [p for p in re.split(r'[^A-Z0-9-]+', text(get(row, 'Rack')).upper()) if p],
            'side': side,
            'aisle': None if is_dash(aisle_text) else aisle_text,
            'dir': parse_walk_dir(get(row, 'Walk direction')),
            'bays': num(get(row, 'Bays')),
            'firstAt': text(get(row, 'First bay at')).lower(),
            'zoneDefault': zone_default if zone_default in WH_ZONES else 'MISC',
            'pickable': parse_pickable_levels(get(row, 'Pickable levels')),
            'order': 99 if order_num is None or order_num >= 99 else max(0, int(math.floor(order_num))),
            'pass': 99,
        })

    prev = None
    for f in sorted([f for f in face_rows if f['order'] < 99], key=lambda f: (f['order'], f['face'])):
        same = (prev is not None and f['aisle'] is not None and f['aisle'] == prev['aisle']
                and f['dir'] is not None and f['dir'] == prev['dir'])
        f['pass'] = prev['pass'] if same else f['order']
        prev = f

    faces = []
    for f in face_rows:
        ctx = f"Face {f['face']}"
        members = []
        for code in f['rackCodes']:
            if code in rack_by_code:
                members.append(rack_by_code[code])
            else:
                warnings.append(f'{ctx}: rack {code} is not a stock rack on the Racks tab; skipped.')
        if not members:
            continue

        def key(r, d=f['dir']):
            return {'E': r['x1'], 'W': -r['x2'], 'S': r['y1'], 'N': -r['y2']}.get(d, 0)

        members = sorted(members, key=key)
        total = sum(r['bays'] for r in members)
        if f['bays'] is not None and f['bays'] != total:
            warnings.append(f"{ctx}: the Faces tab says {f['bays']} bays, its racks have {total}.")
        if f['dir'] and not is_dash(f['firstAt']) and not f['firstAt'].startswith(FIRST_END[f['dir']]):
            warnings.append(f"{ctx}: walks {f['dir']} but bay 01 is said to be at the {f['firstAt']}; the walk direction wins.")
        first = 1
        for rack in members:
            if rack['faceCodes'] and f['face'] not in rack['faceCodes']:
                warnings.append(f"{ctx}: the Racks tab does not list face {f['face']} on {rack['code']}.")
            faces.append({
                'rack_code': rack['code'],
                'face_code': f['face'],
                'side': f['side'],
                'aisle': f['aisle'],
                'walk_pass': f['pass'],
                'walk_dir': f['dir'],
                'first_bay_no': first,
                'zone_by_bay': zones_for(rack, f['side'], f['dir'], f['zoneDefault'], f"{ctx} on {rack['code']}", warnings),
                'pickable_levels': f['pickable'],
            })
            first += rack['bays']
    for r in stock:
        for fc in r['faceCodes']:
            if not any(f['rack_code'] == r['code'] and f['face_code'] == fc for f in faces):
                warnings.append(f"Racks: {r['code']} lists face {fc}, which has no row on the Faces tab.")

    fixture_rows = []
    for r in [x for x in rack_rows if x['kind'] == 'fixture']:
        name = re.sub(r'\s*\([^)]*\)\s*$', '', r['description']) or r['code']
        zone = re.split(r'[;,]', r['zoneText'])[0].strip().upper()  # first zone of a multi-bay list
        fixture_rows.append({'name': name, 'type': zone if zone in WH_ZONES else 'fixture',
                             'x1': r['x1'], 'y1': r['y1'], 'x2': r['x2'], 'y2': r['y2']})
        warnings.append(f"Racks: {r['code']} ({name}) is not a stock location; imported as a fixture.")
    for row in tabs['fixtures']:
        name = text(get(row, 'Fixture'))
        if not name:
            continue
        x1, y1, x2, y2 = (num(get(row, k)) for k in ('x1 px', 'y1 px', 'x2 px', 'y2 px'))
        if None in (x1, y1, x2, y2):
            continue
        fixture_rows.append({'name': name, 'type': text(get(row, 'Type')),
                             'x1': min(x1, x2), 'y1': min(y1, y2), 'x2': max(x1, x2), 'y2': max(y1, y2)})

    fixtures, seen, geometry = [], set(), {}
    for fx in fixture_rows:
        name, n = fx['name'], 2
        while name.lower() in seen:
            name = f"{fx['name']} ({n})"
            n += 1
        if name != fx['name']:
            warnings.append(f'Fixtures: a second "{fx["name"]}" was renamed "{name}".')
        seen.add(name.lower())
        link = named_for(fx['name'])
        if link:
            had = geometry.get(link['code'])
            if had is None or (link['primary'] and not had['primary']):
                geometry[link['code']] = {'row': fx, 'primary': link['primary']}
            elif link['primary'] and had['primary']:
                warnings.append(f"Fixtures: {link['code']} is placed twice; using {had['row']['name']}.")
        ftype = fx['type'].upper()
        fixtures.append({
            'name': name,
            'kind': fixture_kind(fx['name'], fx['type'], link),
            'x_mm': rnd(mm_x(fx['x1'])),
            'y_mm': rnd(mm_y(fx['y1'])),
            'width_mm': rnd(mm_len(fx['x2'] - fx['x1'])),
            'depth_mm': rnd(mm_len(fx['y2'] - fx['y1'])),
            'rot_deg': 0,
            'zone': ftype if ftype in WH_ZONES else (NAMED_ZONES.get(link['code']) if link else None),
            'blocked': False,  # peak-season toggle, set in the editor, never by the import
            'location_code': link['code'] if link else None,
        })

    named = []
    for code in NAMED_ZONES:
        g = geometry.get(code)
        if g is None:
            warnings.append(f'Named location {code}: no fixture on the workbook places it; its geometry is left as it is.')
            continue
        x1, y1, x2, y2 = g['row']['x1'], g['row']['y1'], g['row']['x2'], g['row']['y2']
        named.append({
            'code': code,
            'x_mm': rnd(mm_x((x1 + x2) / 2)),
            'y_mm': rnd(mm_y((y1 + y2) / 2)),
            'z_mm': 0,
            'width_mm': rnd(mm_len(x2 - x1)),
            'depth_mm': rnd(mm_len(y2 - y1)),
        })
    for code in UNPLACED_NAMED:
        warnings.append(f'Named location {code}: not on the drawing; place it when the dock printer is set up.')

    return {'payload': {'templates': templates, 'racks': racks, 'faces': faces, 'fixtures': fixtures},
            'named': named, 'warnings': warnings, 'scale': scale}


def compare_with_locations_tab(generator_codes, locations_tab):
    """Same result as compareWithLocationsTab() in workbook-import.ts, plus zone/pickable checks."""
    workbook, wb_rows, named = {}, {}, []
    for row in locations_tab:
        code = text(get(row, 'Code')).upper()
        if not re.match(r'^[A-Z0-9][A-Z0-9-]*$', code):
            continue
        if BAY_LEVEL_RE.match(code):
            workbook[code] = num(get(row, 'Pick seq'))
            wb_rows[code] = row
        else:
            named.append(code)
    generator = {g['code'].upper(): g for g in generator_codes}
    matched, only_wb, seq_diffs, flag_diffs = [], [], [], []
    for code, seq in workbook.items():
        if code not in generator:
            only_wb.append(code)
            continue
        matched.append(code)
        g = generator[code]
        if g.get('pick_sequence') != seq:
            seq_diffs.append({'code': code, 'workbook': seq, 'generator': g.get('pick_sequence')})
        wb_zone = text(get(wb_rows[code], 'Zone')).upper()
        if wb_zone and g.get('zone') != wb_zone:
            flag_diffs.append({'code': code, 'field': 'zone', 'workbook': wb_zone, 'generator': g.get('zone')})
        wb_pick = text(get(wb_rows[code], 'Pickable')).lower()
        if wb_pick and (wb_pick == 'yes') != bool(g.get('pickable')):
            flag_diffs.append({'code': code, 'field': 'pickable', 'workbook': wb_pick, 'generator': g.get('pickable')})
        if wb_pick == 'overflow' and not g.get('is_overflow'):
            flag_diffs.append({'code': code, 'field': 'is_overflow', 'workbook': wb_pick, 'generator': g.get('is_overflow')})
    only_gen = sorted(c for c in generator if c not in workbook)
    seq_diffs.sort(key=lambda d: (d['generator'] if d['generator'] is not None else float('inf'), d['code']))
    return {'matched': sorted(matched), 'onlyInWorkbook': sorted(only_wb), 'onlyInGenerator': only_gen,
            'sequenceDiffs': seq_diffs, 'flagDiffs': flag_diffs, 'named': named}


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


def explain_sequences(comparison, codes, faces):
    """Group pick_sequence differences by walk pass, naming the faces that share the pass."""
    by_code = {c['code']: c for c in codes}
    pass_faces = {}
    for f in faces:
        pass_faces.setdefault(f['walk_pass'], set()).add(f['face_code'])
    groups = {}
    for d in comparison['sequenceDiffs']:
        g = by_code[d['code']]
        groups.setdefault(g['pick_sequence'] // 1000 if g['pick_sequence'] is not None else None, []).append(d)
    lines = []
    for p in sorted(groups, key=lambda x: (x is None, x)):
        members = sorted(pass_faces.get(p, []))
        why = ('not routed: generator numbers pass 99 as 99000 + rank x 10 + level' if p == 99
               else f"faces {' + '.join(members)} share pass {p} and are interleaved by position" if len(members) > 1
               else f'pass {p}')
        lines.append(f'  pass {p}: {len(groups[p])} codes ({why})')
        for d in groups[p]:
            lines.append(f"    {d['code']:<9} workbook {d['workbook']!s:>6}  generator {d['generator']!s:>6}")
    return lines


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--apply', action='store_true', help='run the generator for real after the dry run')
    ap.add_argument('--workbook', default=DEFAULT_WORKBOOK)
    ap.add_argument('--ref', default=mgmt.STG, help='destination project (staging only; anything else is refused)')
    ap.add_argument('--payload-only', action='store_true', help='print the payload as JSON and send nothing')
    ap.add_argument('--write-fixture', action='store_true', help='with --payload-only: write the TS parity fixture')
    args = ap.parse_args()

    if args.ref in (PROD_REF, mgmt.PROD) or args.ref != mgmt.STG:
        print(f'Refusing: load_layout.py writes to staging ({mgmt.STG}) only, not {args.ref}.', file=sys.stderr)
        return 4

    tabs = read_workbook(args.workbook)
    result = import_workbook(tabs)
    payload, named, warnings = result['payload'], result['named'], result['warnings']

    if args.payload_only:
        doc = {'payload': payload, 'named': named}
        if args.write_fixture:
            with open(FIXTURE_PATH, 'w', encoding='utf-8', newline='\n') as fh:
                json.dump(doc, fh, indent=2)
                fh.write('\n')
            print(f'wrote {os.path.relpath(FIXTURE_PATH, REPO)}')
        else:
            print(json.dumps(doc, indent=2))
        return 0

    ref = mgmt.STG
    print(f'Workbook: {os.path.relpath(args.workbook, REPO)}')
    print(f"Scale: {result['scale']['pxPerFt']:.4f} px/ft; templates {len(payload['templates'])}, racks {len(payload['racks'])}, "
          f"faces {len(payload['faces'])}, fixtures {len(payload['fixtures'])}, named {len(named)}")
    for w in warnings:
        print('  note: ' + w)

    saved = rpc(ref, f'SELECT public.rpc_wh_save_layout({jsonb(payload)})')
    if not saved.get('ok'):
        print('Layout rejected: ' + str(saved.get('message')), file=sys.stderr)
        for p in saved.get('problems', []):
            print('  ' + str(p.get('message')), file=sys.stderr)
        return 1
    print('Layout saved: ' + ', '.join(
        f"{k} " + '/'.join(f'{n} {v}' for n, v in saved[k].items()) for k in ('templates', 'racks', 'faces', 'fixtures')))

    failed = 0
    for n in named:
        res = rpc(ref, f'SELECT public.rpc_wh_save_location({jsonb(n)})')
        if not res.get('ok'):
            failed += 1
            print(f"  {n['code']}: {res.get('message') or res.get('error')}", file=sys.stderr)
    print(f'Named locations placed: {len(named) - failed} of {len(named)}')
    if failed:
        return 1

    dry = rpc(ref, 'SELECT public.rpc_wh_generate_locations(NULL, true)')
    if not dry.get('ok'):
        print('Generator dry run failed: ' + str(dry.get('message')), file=sys.stderr)
        return 1
    codes = dry['codes']
    print(f"Generator dry run: create {len(dry['create'])}, update {len(dry['update'])}, "
          f"conflicts {len(dry['conflicts'])}, deactivate {len(dry['deactivate'])}, codes {len(codes)}")
    for c in dry['conflicts']:
        print(f"  conflict {c['code']}: {c['reason']} (existing {c['existing_code']})")

    cmp = compare_with_locations_tab(codes, tabs['locations'])
    print(f"Against the Locations tab: {len(cmp['matched'])} bay-level codes match; "
          f"only in workbook {cmp['onlyInWorkbook'] or 'none'}; only in generator {cmp['onlyInGenerator'] or 'none'}; "
          f"named on the tab {len(cmp['named'])}")
    for d in cmp['flagDiffs']:
        print(f"  {d['code']} {d['field']}: workbook {d['workbook']}, generator {d['generator']}")
    print(f"pick_sequence differences: {len(cmp['sequenceDiffs'])}")
    for line in explain_sequences(cmp, codes, payload['faces']):
        print(line)

    code_problem = bool(cmp['onlyInWorkbook'] or cmp['onlyInGenerator'] or dry['conflicts'])
    if args.apply:
        if dry['conflicts']:
            print('Not applying: resolve the conflicts first.', file=sys.stderr)
            return 2
        done = rpc(ref, 'SELECT public.rpc_wh_generate_locations(NULL, false)')
        if not done.get('ok'):
            print('Generator failed: ' + str(done.get('message')), file=sys.stderr)
            return 1
        print(f"Applied: created {done['created']}, updated {done['updated']}, deactivated {done['deactivated']}")
    else:
        print('Dry run only; re-run with --apply to create the locations.')
    return 2 if code_problem else 0


if __name__ == '__main__':
    sys.exit(main())
