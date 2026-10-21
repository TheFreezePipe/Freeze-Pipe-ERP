#!/usr/bin/env python3
"""Refresh the staging Supabase project from production, with customer details scrubbed.

Design: docs/design/WAREHOUSE_MODULE_PHASE0_1.md section 3.2. As-run record:
docs/design/STAGING_REFRESH.md. Building blocks: scripts/staging/mgmt.py (q, PROD, STG, lit).

  python scripts/refresh-staging/refresh.py --rebuild   --dry-run   # print the plan, run nothing
  python scripts/refresh-staging/refresh.py --rebuild              # drop public, migrate, accounts, copy, verify
  python scripts/refresh-staging/refresh.py --data-only            # truncate the copied tables, copy, verify

Production is only ever read: every statement sent to it must be a plain SELECT/WITH (checked in
run()). The token (SUPABASE_ACCESS_TOKEN) and the practice password (STAGING_PRACTICE_PASSWORD) come
from .env.local and are never printed; the log and the console only show the first line of each
statement. Standard library only. Logs to scripts/refresh-staging/refresh.log.

Exit codes: 0 ok, 1 a step failed, 2 verification failed, 3 PII check failed, 4 a safety rule refused
the run, 130 interrupted.
"""

import argparse
import ast
import glob
import hashlib
import json
import os
import re
import sys
import textwrap
import time

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..'))
sys.path.insert(0, os.path.join(REPO, 'scripts', 'staging'))

import mgmt  # noqa: E402  (scripts/staging/mgmt.py: the Management API helper)
from mgmt import q, PROD, STG, lit  # noqa: E402

# --------------------------------------------------------------------------------------------
# Constants
# --------------------------------------------------------------------------------------------
PROD_REF = 'pnqujtugddxusllkikje'  # pinned here as well, so a bad edit of mgmt.py cannot redirect writes
SYSTEM_ACTOR = '00000000-0000-0000-0000-000000000001'

LOG_PATH = os.path.join(HERE, 'refresh.log')
REPORT_PATH = os.path.join(HERE, 'last-report.txt')
BACKUP_ROOT = os.path.join(HERE, 'backups')
MIGRATIONS_DIR = os.path.join(REPO, 'supabase', 'migrations')
COPY_SCRIPT = os.path.join(REPO, 'scripts', 'staging', 'copy_to_staging.py')
DEFAULT_ENV = os.path.join(REPO, '.env.local')

DEFAULT_ORDERS_FROM = '2026-08-01'

# Mirrors TABLES in scripts/staging/copy_to_staging.py (drift is reported at start-up).
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
ORDER_CHILDREN = ('shipstation_order_items', 'shipstation_order_discounts')
SEED_REPLACE = ('materials', 'mkt_promo_history')  # seeded by migrations with random ids, no dependents
CHUNK = {'shipstation_orders': 300}
DEFAULT_CHUNK = 1500
LEDGER_PAGE = 1000

# Design 3.1 allowlist: raw_payload keeps only these keys, so a key ShipStation adds later cannot carry
# personal data. ERP SQL reads only dimensions, items and advancedOptions.
ALLOW_TOP = ['orderId', 'orderNumber', 'orderKey', 'orderDate', 'modifyDate', 'orderStatus', 'shipDate',
             'advancedOptions', 'items', 'dimensions', 'weight', 'carrierCode', 'serviceCode']
ALLOW_ADV = ['storeId', 'parentId', 'mergedOrSplit', 'mergedIds']

RESET_PUBLIC_SQL = """DROP SCHEMA public CASCADE;
CREATE SCHEMA public;
ALTER SCHEMA public OWNER TO postgres;
COMMENT ON SCHEMA public IS 'standard public schema';
GRANT ALL ON SCHEMA public TO postgres;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON SCHEMA public TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO postgres, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO postgres, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres, anon, authenticated, service_role;
"""

FK_SQL = ("select c.conrelid::regclass::text child, c.confrelid::regclass::text parent from pg_constraint c "
          "where c.contype = 'f' and c.connamespace = 'public'::regnamespace and c.conrelid <> c.confrelid")
PK_SQL = ("select c.relname as t, array_agg(a.attname::text order by array_position(i.indkey::int2[], a.attnum)) as cols "
          "from pg_index i join pg_class c on c.oid = i.indrelid join pg_namespace n on n.oid = c.relnamespace "
          "join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any (i.indkey) "
          "where i.indisprimary and n.nspname = 'public' group by c.relname")
SNAPSHOT_SQL = ("select p.id, p.email, p.full_name, p.role, p.is_active, p.supplier_id, s.code as supplier_code "
                "from public.profiles p left join public.suppliers s on s.id = p.supplier_id order by p.created_at, p.id")
SNAPSHOT_SQL_PLAIN = ("select id, email, full_name, role, is_active, supplier_id, null::text as supplier_code "
                      "from public.profiles order by created_at, id")
CATALOG_DUMPS = [
    ('functions.json',
     "select p.oid::regprocedure::text as signature, pg_get_functiondef(p.oid) as definition from pg_proc p "
     "join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prokind in ('f', 'p') "
     "and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e') order by 1"),
    ('schema_migrations.json', 'select version, name from supabase_migrations.schema_migrations order by version'),
    ('cron_jobs.json', 'select jobid, jobname, schedule, active, command from cron.job order by jobid'),
]

REQUIRED_SECTIONS = {
    'accounts.sql': ['auth_trigger', 'accounts', 'guard_restore'],
    'ledger_open_orders.sql': ['stg_order_ids', 'prod_rows', 'stg_insert'],
    'post_refresh.sql': ['realtime', 'outbound'],
    'auth_probe.sql': ['probe'],
    'verify.sql': ['migrations', 'schema_parity', 'rls_grants', 'cron', 'copied_pks', 'pii', 'smoke',
                   'outbound_table', 'outbound_mode'],
}

_WRITE_WORDS = re.compile(
    r'\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|call|do|vacuum|reindex|cluster|'
    r'refresh|comment|lock|listen|notify|nextval|setval|set_config|pg_terminate_backend|pg_cancel_backend|'
    r'pg_reload_conf|lo_import|lo_export)\b|\bcron\s*\.\s*(un)?schedule\b', re.I)
_PLACEHOLDER = re.compile(r'\{\{([A-Z_]+)\}\}')
_SECTION = re.compile(r'^--\s*@@\s+(\w+)(?:\s+(prod|stg|both))?\s*$', re.M)


# --------------------------------------------------------------------------------------------
# Errors and run-wide state
# --------------------------------------------------------------------------------------------
class Refuse(Exception):
    """A safety rule stopped the run (exit 4)."""


class StepError(Exception):
    """A statement or step failed (exit 1)."""


class VerifyFailed(Exception):
    """A verification check failed (exit 2)."""


class PiiFailure(Exception):
    """The PII check failed (exit 3)."""


class State:
    def __init__(self):
        self.reset()

    def reset(self):
        self.dry = False
        self.yes = False
        self.mode = ''
        self.dest = STG
        self.orders_from = DEFAULT_ORDERS_FROM
        self.no_backup = False
        self.backup_requested = False
        self.secrets = []
        self.tables = list(TABLES)
        self.cutoff = None
        self.created_tables = set()
        self.pk = {}
        self.pk_loaded = False
        self.cols = {}
        self.order = None
        self.disabled = set()
        self.snapshot = []
        self.backup_dir = None
        self.files = []
        self.applied = []
        self.failed = None
        self.outbound_written = False
        self.schema_touched = False
        self.notes = []
        self.pk_results = []
        self.step_no = 0
        self.step_total = 0
        self.sections = {}


S = State()


# --------------------------------------------------------------------------------------------
# Logging
# --------------------------------------------------------------------------------------------
def redact(text):
    for secret in S.secrets:
        if secret:
            text = text.replace(secret, '***')
    return text


def say(*parts):
    line = redact(' '.join(str(p) for p in parts))
    print(line, flush=True)
    try:
        with open(LOG_PATH, 'a', encoding='utf-8') as f:
            f.write(time.strftime('%Y-%m-%d %H:%M:%S ') + line + '\n')
    except OSError:
        pass


def result(*parts):
    """An outcome line; in a dry run nothing has happened yet, so nothing is reported."""
    if not S.dry:
        say(*parts)


def note(text):
    """Something the operator should read in the report (not recorded in a dry run)."""
    if S.dry:
        return
    S.notes.append(text)
    say('note:', text)


def step(title):
    S.step_no += 1
    say(f'== [{S.step_no}/{S.step_total}] {title} ==')


# --------------------------------------------------------------------------------------------
# SQL plumbing: one choke point for every statement
# --------------------------------------------------------------------------------------------
def strip_comments(sql):
    sql = re.sub(r'/\*.*?\*/', '', sql, flags=re.S)
    return '\n'.join(line for line in sql.splitlines() if not line.strip().startswith('--'))


def first_line(sql):
    for line in strip_comments(sql).splitlines():
        if line.strip():
            return line.strip()
    return '(empty)'


def clip(text, n=110):
    text = str(text)
    return text if len(text) <= n else text[:n - 3] + '...'


def is_read_only(sql):
    body = strip_comments(sql)
    body = re.sub(r"'(?:[^']|'')*'", "''", body)  # string literals cannot hide or trigger a keyword
    return bool(re.match(r'\s*(select|with)\b', body, re.I)) and not _WRITE_WORDS.search(body)


def alias(ref):
    return 'prod' if ref == PROD else 'stg '


def run(sql, ref, label, canned=None, timeout=600, retries=2):
    """Send one statement. Production gets plain reads only. In a dry run print the first line instead.
    retries is mgmt.q's retry count for 429/5xx answers; migrations pass 0 so a timeout cannot apply one twice."""
    if ref == PROD:
        if not is_read_only(sql):
            raise Refuse(f'refusing a statement that is not a plain read against production ({label})')
    elif ref != S.dest:
        raise Refuse(f'unknown project ref for {label}')
    if S.dry:
        say(f'  [dry-run] {alias(ref)} {label}: {clip(first_line(sql))}')
        return [] if canned is None else canned
    try:
        return q(sql, ref, timeout=timeout, retries=retries)
    except Exception as e:  # noqa: BLE001 - HTTP, network and timeout errors are all "this step failed"
        raise StepError(f'{label}: {clip(redact(str(e)), 700)}') from None


def scalar(rows, key='n'):
    return int(rows[0][key]) if rows else 0


def sql_array(items):
    return 'ARRAY[' + ', '.join(lit(i) for i in items) + ']::text[]'


def render(body, values):
    def sub(m):
        if m.group(1) not in values:
            raise StepError('SQL placeholder {{' + m.group(1) + '}} has no value')
        return values[m.group(1)]
    return _PLACEHOLDER.sub(sub, body)


def load_sections(filename):
    if filename not in S.sections:
        with open(os.path.join(HERE, filename), encoding='utf-8') as f:
            text = f.read()
        marks = list(_SECTION.finditer(text))
        if not marks:
            raise StepError(filename + ': no "-- @@ name" sections')
        out = {}
        for i, m in enumerate(marks):
            end = marks[i + 1].start() if i + 1 < len(marks) else len(text)
            out[m.group(1)] = {'target': m.group(2) or 'stg', 'sql': text[m.end():end].strip() + '\n'}
        S.sections[filename] = out
    return S.sections[filename]


def run_section(filename, name, values, ref=None, canned=None, timeout=600):
    sec = load_sections(filename)[name]
    if ref is None:
        ref = PROD if sec['target'] == 'prod' else S.dest
    return run(render(sec['sql'], values), ref, f'{filename}:{name}', canned=canned, timeout=timeout)


def file_hashes():
    out = []
    for name in ('accounts.sql', 'ledger_open_orders.sql', 'post_refresh.sql', 'verify.sql', 'auth_probe.sql'):
        with open(os.path.join(HERE, name), 'rb') as f:
            out.append(f'{name} {hashlib.sha256(f.read()).hexdigest()[:12]}')
    return out


# --------------------------------------------------------------------------------------------
# Environment and safety rules
# --------------------------------------------------------------------------------------------
def env_value(key):
    try:
        with open(mgmt.ENV, encoding='utf-8') as f:
            text = f.read()
    except OSError:
        return None
    value = dict(re.findall(r'^([A-Za-z0-9_]+)=(.*)$', text, re.M)).get(key, '').strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in '"\'':
        value = value[1:-1]
    return value or None


def load_secrets():
    token, password = env_value('SUPABASE_ACCESS_TOKEN'), env_value('STAGING_PRACTICE_PASSWORD')
    S.secrets.extend(v for v in (token, password) if v)
    return token, password


def practice_password():
    if S.dry:
        return '<practice-password>'
    return env_value('STAGING_PRACTICE_PASSWORD')


def check_refs():
    if mgmt.PROD != PROD_REF:
        raise Refuse('scripts/staging/mgmt.py PROD differs from the production ref pinned in refresh.py')
    dest = S.dest.strip().lower()
    if dest in (PROD_REF, mgmt.PROD.strip().lower()):
        raise Refuse('the destination is the production project; this tool only ever writes to staging')
    if not re.fullmatch(r'[a-z]{20}', dest):
        raise Refuse('the destination must be a 20-letter project ref')
    S.dest = dest


def confirm_run(mode):
    if S.dry or S.yes:
        return
    if not sys.stdin.isatty():
        raise Refuse('no terminal to confirm on: re-run with --yes to run unattended')
    what = ('DROP SCHEMA public CASCADE and rebuild' if mode == 'rebuild'
            else 'TRUNCATE the copied tables and reload them')
    say(f'About to {what} on project {S.dest} (production {PROD_REF} is only read).')
    if input('Type the destination ref to continue: ').strip() != S.dest:
        raise Refuse('the typed ref did not match; nothing was changed')


def warn_if_table_list_drifted():
    try:
        with open(COPY_SCRIPT, encoding='utf-8') as f:
            tree = ast.parse(f.read())
        for node in tree.body:
            if isinstance(node, ast.Assign) and any(getattr(t, 'id', '') == 'TABLES' for t in node.targets):
                other = ast.literal_eval(node.value)
                if list(other) != TABLES:
                    say('WARNING: TABLES here differs from scripts/staging/copy_to_staging.py; refresh.py uses its own list')
                return
    except (OSError, SyntaxError, ValueError):
        return


def migration_files():
    files = sorted(glob.glob(os.path.join(MIGRATIONS_DIR, '*.sql')))
    names = [os.path.basename(f) for f in files]
    bad = [n for n in names if not re.fullmatch(r'\d{14}_[\w.-]+\.sql', n)]
    if bad:
        raise StepError('migration file names must be YYYYMMDDHHmmss_name.sql: ' + ', '.join(bad[:3]))
    versions = [n.split('_', 1)[0] for n in names]
    if len(set(versions)) != len(versions):
        raise StepError('two migration files share a version')
    return files


def migration_versions():
    return [os.path.basename(f).split('_', 1)[0] for f in migration_files()]


def preflight(mode):
    check_refs()
    warn_if_table_list_drifted()
    token, password = load_secrets()
    problems = []
    if not token:
        problems.append('SUPABASE_ACCESS_TOKEN is missing from ' + mgmt.ENV)
    if mode == 'rebuild' and not password:
        problems.append('STAGING_PRACTICE_PASSWORD is missing from ' + mgmt.ENV)
    if password and len(password) < 8:
        problems.append('STAGING_PRACTICE_PASSWORD must be at least 8 characters')
    for name, wanted in REQUIRED_SECTIONS.items():
        absent = [s for s in wanted if s not in load_sections(name)]
        if absent:
            raise StepError(f'{name} lacks section(s): {", ".join(absent)}')
    say(f'preflight: token {"present" if token else "MISSING"}, practice password '
        f'{"present" if password else "MISSING"}, {len(migration_files())} migration files')
    if problems:
        if S.dry:
            for p in problems:
                say('  [dry-run] would stop: ' + p)
        else:
            raise Refuse('; '.join(problems))
    if not re.fullmatch(r'\d{4}-\d{2}-\d{2}', S.orders_from):
        raise Refuse('--orders-from must look like 2026-08-01')


# --------------------------------------------------------------------------------------------
# Catalog helpers (production is the source of truth for keys and filters)
# --------------------------------------------------------------------------------------------
def load_pk_map():
    if not S.pk_loaded:
        rows = run(PK_SQL, PROD, 'primary keys', canned=[])
        S.pk = {r['t']: list(r['cols']) for r in rows}
        S.pk_loaded = True


def pk_columns(t):
    load_pk_map()
    if t not in S.pk and S.dry:
        return ['id']
    return S.pk.get(t, [])


def pk_expr(t, alias_name='o'):
    cols = pk_columns(t)
    if not cols:
        return None
    pre = alias_name + '.' if alias_name else ''
    return "concat_ws('|', " + ', '.join(f'{pre}"{c}"::text' for c in cols) + ')'


def order_by(t):
    cols = pk_columns(t)
    return ', '.join(f'o."{c}"' for c in cols) if cols else 'o.ctid'


def begin_window():
    """Fix the copy cutoff (production clock) once: rows created later are left out of copy and checks."""
    if S.cutoff:
        return
    rows = run('select now()::text as ts', PROD, 'production clock (copy cutoff)', canned=[{'ts': '<cutoff>'}])
    S.cutoff = rows[0]['ts']
    load_pk_map()
    rows = run("select table_name from information_schema.columns where table_schema = 'public' "
               "and column_name = 'created_at'", PROD, 'tables with created_at', canned=[])
    S.created_tables = {r['table_name'] for r in rows}
    say('copy cutoff (production clock):', S.cutoff)


def parent_cond(a, stable):
    cond = f"{a}.order_date >= {lit(S.orders_from)} and {a}.created_at <= {lit(S.cutoff)}::timestamptz"
    if stable:
        cond += f" and {a}.updated_at <= {lit(S.cutoff)}::timestamptz"
    return cond


def table_where(t, stable):
    """Row filter for a copied table. stable=True is for comparisons: order lines count only for orders
    not touched since the cutoff, because ShipStation re-ingest rewrites lines with new ids."""
    parts = []
    if t == 'shipstation_orders':
        parts.append(parent_cond('o', False))
    elif t in ORDER_CHILDREN:
        parts.append('o.shipstation_order_id in (select p.id from public.shipstation_orders p where '
                     + parent_cond('p', stable) + ')')
    elif t in S.created_tables:
        parts.append(f"o.created_at <= {lit(S.cutoff)}::timestamptz")
    return ('where ' + ' and '.join(parts)) if parts else ''


def with_where(sql, where):
    return sql + (' ' + where if where else '')


def count_rows(ref, t, where='', canned=1):
    sql = with_where(f'select count(*) n from public."{t}" o', where)
    return scalar(run(sql, ref, f'count {t}', canned=[{'n': canned}]))


def staging_columns(t):
    if t not in S.cols:
        rows = run("select column_name from information_schema.columns where table_schema = 'public' and table_name = "
                   f"{lit(t)} and is_generated <> 'ALWAYS' order by ordinal_position", S.dest, f'columns of {t}',
                   canned=[{'column_name': '<columns>'}])
        S.cols[t] = [r['column_name'] for r in rows]
        if not S.cols[t]:
            raise StepError(f'{t}: table not found on staging')
    return S.cols[t]


def fk_edges(ref):
    return run(FK_SQL, ref, 'foreign keys', canned=[])


def copy_order():
    """Foreign-key order from production's graph, restricted to the copied tables."""
    if S.order:
        return S.order
    deps = {t: set() for t in S.tables}
    for e in fk_edges(PROD):
        if e['child'] in deps and e['parent'] in deps:
            deps[e['child']].add(e['parent'])
    order = []
    while deps:
        ready = [t for t, d in deps.items() if not d]
        if not ready:
            raise StepError('foreign-key cycle among ' + ', '.join(sorted(deps)))
        for t in sorted(ready, key=S.tables.index):
            order.append(t)
            del deps[t]
            for d in deps.values():
                d.discard(t)
    S.order = order
    return order


# --------------------------------------------------------------------------------------------
# Step: backup
# --------------------------------------------------------------------------------------------
def save_json(root, rel, obj, manifest=None):
    if S.dry:
        return
    path = os.path.join(root, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    data = json.dumps(obj, indent=1, default=str).encode('utf-8')
    with open(path, 'wb') as f:
        f.write(data)
    if manifest is not None:
        manifest['files'][rel.replace('\\', '/')] = hashlib.sha256(data).hexdigest()


def live_accounts():
    rows = run("select to_regclass('public.profiles') is not null as ok", S.dest, 'does public.profiles exist',
               canned=[{'ok': True}])
    if not rows or not rows[0].get('ok'):
        return []
    try:
        return run(SNAPSHOT_SQL, S.dest, 'snapshot staging logins', canned=[])
    except StepError:
        return run(SNAPSHOT_SQL_PLAIN, S.dest, 'snapshot staging logins (without suppliers)', canned=[])


def account_snapshot():
    """Staging logins before the schema is dropped; falls back to the newest earlier backup."""
    rows = live_accounts()
    if rows:
        return [dict(r) for r in rows], 'live staging'
    pattern = os.path.join(BACKUP_ROOT, '*', 'staging_accounts.json')
    for path in sorted(glob.glob(pattern), reverse=True):
        try:
            with open(path, encoding='utf-8') as f:
                earlier = json.load(f)
        except (OSError, ValueError):
            continue
        if earlier:
            return earlier, os.path.relpath(path, REPO)
    return [], 'nothing found'


def dump_table(t, root, manifest):
    n = scalar(run(f'select count(*) n from public."{t}"', S.dest, f'backup count {t}', canned=[{'n': 1}]))
    rows, offset, chunk = [], 0, CHUNK.get(t, DEFAULT_CHUNK)
    while offset < n:
        page = run(f'select to_jsonb(t) r from public."{t}" t order by t.ctid limit {chunk} offset {offset}',
                   S.dest, f'backup {t}', canned=[{'r': {}}])
        if not page:
            break
        rows.extend(r['r'] for r in page)
        offset += chunk
    save_json(root, f'tables/{t}.json', rows, manifest)
    return len(rows)


def dump_catalog(root, manifest):
    for filename, sql in CATALOG_DUMPS:
        try:
            rows = run(sql, S.dest, 'backup ' + filename, canned=[])
        except StepError as e:
            say(f'WARNING: could not back up {filename}: {e}')
            continue
        save_json(root, filename, rows, manifest)


def backup_staging():
    stamp = time.strftime('%Y%m%d-%H%M%S')
    root = os.path.join(BACKUP_ROOT, stamp)
    S.backup_dir = root
    say('backup folder:', os.path.relpath(root, REPO))
    manifest = {'created': stamp, 'destination': S.dest, 'tables': {}, 'files': {}}
    tables = run("select tablename as t from pg_tables where schemaname = 'public' order by tablename", S.dest,
                 'list public tables', canned=[{'t': '<table>'}])
    for r in tables:
        manifest['tables'][r['t']] = dump_table(r['t'], root, manifest)
    dump_catalog(root, manifest)
    save_json(root, 'staging_accounts.json', S.snapshot, manifest)
    save_json(root, 'manifest.json', manifest)
    result(f'backup done: {len(manifest["tables"])} tables, {sum(manifest["tables"].values())} rows')


def backup_step():
    S.snapshot, source = account_snapshot()
    say(f'staging logins captured for the accounts step: {len(S.snapshot)} (from {source})')
    if S.no_backup:
        say('backup skipped (--no-backup); the login snapshot above is all that is kept')
        return
    backup_staging()


def backup_optional():
    if S.backup_requested:
        backup_staging()
    else:
        say('backup skipped (data-only keeps accounts; pass --backup to dump staging first)')


# --------------------------------------------------------------------------------------------
# Steps: schema and migrations
# --------------------------------------------------------------------------------------------
def reset_public_schema():
    S.schema_touched = True
    run(RESET_PUBLIC_SQL, S.dest, 'drop and recreate public (with Supabase grants and default privileges)')
    S.cols.clear()
    S.order = None
    result('public schema dropped and recreated')


def apply_migrations(files, start):
    applied = []
    for path in files[start:]:
        name = os.path.basename(path)
        with open(path, encoding='utf-8') as f:
            sql = f.read()
        began = time.time()
        try:
            run(sql, S.dest, 'migration ' + name, timeout=900, retries=0)
        except StepError as e:
            say(f'FAIL {name}: {e}')
            return applied, name
        applied.append(name)
        if not S.dry:
            say(f'ok   {name} ({time.time() - began:.1f}s)')
    return applied, None


def record_versions(names):
    rows = ', '.join('({}, {})'.format(lit(n.split('_', 1)[0]), lit(n.split('_', 1)[1].rsplit('.sql', 1)[0]))
                     for n in names)
    sql = 'DELETE FROM supabase_migrations.schema_migrations;\n'
    if rows:
        sql += 'INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ' + rows + ';'
    run(sql, S.dest, 'record schema_migrations')
    result(f'schema_migrations records {len(names)} versions')


def migrate_first_pass():
    S.files = migration_files()
    say(f'{len(S.files)} migration files; stop on the first failure')
    S.applied, S.failed = apply_migrations(S.files, 0)
    if S.failed and not S.applied:
        raise StepError(f'the first migration ({S.failed}) failed; nothing to continue from')
    record_versions(S.applied)
    if S.failed:
        say(f'stopped at {S.failed} after {len(S.applied)} migrations; the accounts step runs next, then the rest resumes')


def migrate_second_pass():
    if not S.failed:
        say('no migrations left to apply' + (' (a dry run assumes the first pass completes)' if S.dry else ''))
        return
    more, failed = apply_migrations(S.files, len(S.applied))
    S.applied += more
    record_versions(S.applied)
    if failed:
        raise StepError(f'{failed} failed again after the accounts step; stopped with {len(S.applied)} of '
                        f'{len(S.files)} migrations applied')


# --------------------------------------------------------------------------------------------
# Step: accounts
# --------------------------------------------------------------------------------------------
def prod_profiles():
    rows = run('select id, email, full_name, role, is_active, supplier_id from public.profiles order by created_at, id',
               PROD, 'production profiles', canned=[])
    return [dict(r) for r in rows]


def staging_suppliers():
    rows = run('select id, code from public.suppliers', S.dest, 'staging suppliers', canned=[])
    return {r['code']: r['id'] for r in rows}


def keep_accounts(prod, suppliers):
    """Staging-only logins to keep (not in production by id or email, not the system actor)."""
    ids = {r['id'] for r in prod}
    emails = {(r['email'] or '').lower() for r in prod}
    keep = []
    for r in S.snapshot:
        email = (r.get('email') or '').lower()
        if r['id'] in ids or r['id'] == SYSTEM_ACTOR or email in emails:
            continue
        supplier_id = suppliers.get(r.get('supplier_code')) if r.get('supplier_code') else None
        role = r['role']
        if role == 'supplier' and not supplier_id:
            role = 'user'
            note(f'a staging-only supplier login lost its supplier link (no supplier code {r.get("supplier_code")}); '
                 'it is restored as role user')
        keep.append({'id': r['id'], 'email': r['email'], 'full_name': r['full_name'], 'role': role,
                     'is_active': r.get('is_active', True),
                     'supplier_id': supplier_id if role == 'supplier' else None})
    return keep


def verify_accounts(prod):
    if S.dry:
        return
    ids = sorted({r['id'] for r in prod} | {SYSTEM_ACTOR})
    got = scalar(run('select count(*) n from public.profiles where id = any (array[' + ', '.join(lit(i) for i in ids)
                     + ']::uuid[])', S.dest, 'count mirrored profiles'))
    if got != len(ids):
        raise StepError(f'accounts: expected {len(ids)} mirrored profiles on staging, found {got}')
    result(f'accounts: {got} production profiles (including the system actor) mirrored with their uuids')


def accounts_step():
    begin_window()
    ok = run("select to_regclass('public.profiles') is not null as ok", S.dest, 'does public.profiles exist',
             canned=[{'ok': True}])
    if not ok or not ok[0].get('ok'):
        raise StepError('public.profiles does not exist; the baseline migration did not apply')
    copy_table('suppliers', force=True, upsert=True)
    prod = prod_profiles()
    suppliers = staging_suppliers()
    missing = [r['id'] for r in prod if r.get('supplier_id') and r['supplier_id'] not in suppliers.values()]
    if missing and not S.dry:
        raise StepError(f'{len(missing)} production profiles reference suppliers that are not on staging')
    keep = keep_accounts(prod, suppliers)
    result(f'accounts: {len(prod)} production profiles, {len(keep)} staging-only logins kept')
    values = {'PRACTICE_PASSWORD': lit(practice_password() or ''), 'SYSTEM_ACTOR_ID': lit(SYSTEM_ACTOR),
              'PROD_PROFILES': lit(json.dumps(prod, default=str)), 'KEEP_ACCOUNTS': lit(json.dumps(keep, default=str))}
    run_section('accounts.sql', 'auth_trigger', values)
    body = render(load_sections('accounts.sql')['accounts']['sql'], values)
    if body.count('$accounts$') != 2:
        raise StepError('accounts.sql: profile data or the password contains the dollar-quote tag $accounts$')
    try:
        run(body, S.dest, 'accounts.sql:accounts')
    finally:
        try:
            run_section('accounts.sql', 'guard_restore', values)
        except StepError as e:
            say('WARNING: could not re-enable the role guard trigger:', e)
    verify_accounts(prod)


# --------------------------------------------------------------------------------------------
# Step: copy data (scrubbed in the production-side SELECT)
# --------------------------------------------------------------------------------------------
def scrub_projection():
    top, adv = sql_array(ALLOW_TOP), sql_array(ALLOW_ADV)
    return f"""to_jsonb(o) || jsonb_build_object(
  'customer_email', 'user-' || left(md5(coalesce(o.customer_email, o.customer_name, o.order_number)), 8) || '@example.com',
  'customer_name', 'Customer ' || upper(left(md5(coalesce(o.customer_email, o.customer_name, o.order_number)), 6)),
  'raw_payload', CASE WHEN o.raw_payload IS NULL OR jsonb_typeof(o.raw_payload) <> 'object' THEN NULL ELSE
    (SELECT coalesce(jsonb_object_agg(e.key, e.value), '{{}}'::jsonb) FROM jsonb_each(o.raw_payload) AS e
      WHERE e.key = ANY ({top}) AND e.key <> 'advancedOptions')
    || CASE WHEN jsonb_typeof(o.raw_payload->'advancedOptions') = 'object' THEN
         jsonb_build_object('advancedOptions',
           (SELECT coalesce(jsonb_object_agg(a.key, a.value), '{{}}'::jsonb)
              FROM jsonb_each(o.raw_payload->'advancedOptions') AS a WHERE a.key = ANY ({adv})))
       ELSE '{{}}'::jsonb END
  END)"""


def quote_list(cols):
    return ', '.join(f'"{c}"' for c in cols)


def insert_sql(t, cols, payload, upsert):
    collist = quote_list(cols)
    conflict = 'ON CONFLICT DO NOTHING'
    if upsert:
        pk = pk_columns(t)
        sets = ', '.join(f'"{c}" = EXCLUDED."{c}"' for c in cols if c not in pk)
        if pk and sets:
            conflict = f'ON CONFLICT ({quote_list(pk)}) DO UPDATE SET {sets}'
    return (f'INSERT INTO public."{t}" ({collist}) SELECT {collist} FROM '
            f'json_populate_recordset(null::public."{t}", {lit(payload)}) {conflict}')


def set_triggers(t, enabled):
    verb = 'ENABLE' if enabled else 'DISABLE'
    if not enabled:
        S.disabled.add(t)
    run(f'ALTER TABLE public."{t}" {verb} TRIGGER USER', S.dest, f'{verb.lower()} user triggers on {t}')
    if enabled:
        S.disabled.discard(t)


def copy_table(t, force=False, upsert=False):
    cols = staging_columns(t)
    where = table_where(t, False)
    total = count_rows(PROD, t, where, 1)
    have = count_rows(S.dest, t, '', 0)
    if total == 0:
        say(f'{t}: nothing to copy')
        return
    if have >= total and not force:
        say(f'{t}: already {have} rows, skipped')
        return
    proj = scrub_projection() if t == 'shipstation_orders' else 'to_jsonb(o)'
    chunk, offset = CHUNK.get(t, DEFAULT_CHUNK), 0
    set_triggers(t, False)
    try:
        while offset < total:
            page_sql = with_where(f'select {proj} r from public."{t}" o', where)
            page_sql += f' order by {order_by(t)} limit {chunk} offset {offset}'
            rows = run(page_sql, PROD, f'read {t}', canned=[{'r': {}}])
            if not rows:
                break
            run(insert_sql(t, cols, json.dumps([r['r'] for r in rows]), upsert), S.dest, f'write {t}')
            offset += chunk
            if total > 3 * chunk:
                say(f'  {t}: {min(offset, total)}/{total}')
    finally:
        set_triggers(t, True)
    got = count_rows(S.dest, t, '', total)
    result(f'{t}: prod {total} -> staging {got}')


def copy_all():
    begin_window()
    S.cols.clear()
    copy_table('suppliers', force=True, upsert=True)
    for t in copy_order():
        if t in SEED_REPLACE:
            reconcile_pk_sets(t, replace=True)  # seeded rows go before dependents arrive
        copy_table(t)
    say('copy done')


def truncate_plan():
    """Reverse FK order; a table that something outside the list references stays (and is upserted instead)."""
    chain = list(reversed(copy_order())) + ['inventory_transactions']
    keep, listed = set(), set(chain)
    edges = fk_edges(S.dest)
    changed = True
    while changed:
        changed = False
        for e in edges:
            child, parent = e['child'], e['parent']
            if parent in listed and child not in listed and child != parent:
                listed.discard(parent)
                keep.add(parent)
                changed = True
    return [t for t in chain if t in listed], sorted(keep)


def truncate_copied():
    S.schema_touched = True
    tables, kept = truncate_plan()
    if kept:
        note('not truncated, because tables outside the copy set reference them (rows are upserted instead): '
             + ', '.join(kept))
    run('TRUNCATE TABLE ' + ', '.join(f'public."{t}"' for t in tables), S.dest,
        f'truncate {len(tables)} copied tables (reverse FK order, plus the ledger)')
    S.cols.clear()
    result(f'truncated {len(tables)} tables')


# --------------------------------------------------------------------------------------------
# Step: PII gate
# --------------------------------------------------------------------------------------------
def pii_values():
    return {'ALLOW_TOP': sql_array(ALLOW_TOP), 'ALLOW_ADV': sql_array(ALLOW_ADV)}


def pii_problems(r):
    if not r:
        return ['the PII query returned nothing']
    out = []
    if r.get('non_example_emails'):
        out.append(f"{r['non_example_emails']} orders have an email outside @example.com")
    if r.get('non_scrubbed_names'):
        out.append(f"{r['non_scrubbed_names']} orders have a customer name that is not 'Customer ...'")
    if r.get('keys_outside_allowlist'):
        out.append('raw_payload keys outside the allowlist: ' + ', '.join(r['keys_outside_allowlist'][:10]))
    if r.get('advanced_keys_outside'):
        out.append('advancedOptions keys outside the allowlist: ' + ', '.join(r['advanced_keys_outside'][:10]))
    if r.get('at_sign_payloads'):
        out.append(f"{r['at_sign_payloads']} payloads contain an @ sign (orders {', '.join(map(str, r.get('at_sign_samples', [])))})")
    return out


def pii_gate():
    rows = run_section('verify.sql', 'pii', pii_values(), S.dest, canned=[{'v': {}}])
    if S.dry:
        return
    answer = rows[0]['v'] if rows else {}
    problems = pii_problems(answer)
    if problems:
        raise PiiFailure('; '.join(problems))
    say(f"PII gate passed ({answer.get('orders', 0)} orders checked)")


# --------------------------------------------------------------------------------------------
# Step: seeded-table fix (primary-key sets)
# --------------------------------------------------------------------------------------------
def fingerprint(ref, t):
    expr = pk_expr(t)
    where = table_where(t, True)
    digest = f"md5(coalesce(string_agg({expr}, ',' order by {expr}), ''))" if expr else "md5('')"
    rows = run(with_where(f'select count(*) n, {digest} h from public."{t}" o', where), ref,
               f'pk fingerprint {t}', canned=[{'n': 0, 'h': ''}])
    return int(rows[0]['n']), rows[0]['h']


def compare_pk_sets(t):
    prod, stg = fingerprint(PROD, t), fingerprint(S.dest, t)
    res = {'table': t, 'prod': prod[0], 'stg': stg[0], 'equal': prod == stg, 'missing': [], 'extra': [], 'note': ''}
    if res['equal']:
        return res
    expr = pk_expr(t)
    if not expr:
        res['note'] = 'no primary key, counts only'
        return res
    where = table_where(t, True)
    sql = with_where(f'select {expr} k from public."{t}" o', where)
    prod_ids = {r['k'] for r in run(sql, PROD, f'pk list {t}')}
    stg_ids = {r['k'] for r in run(sql, S.dest, f'pk list {t}')}
    res['missing'], res['extra'] = sorted(prod_ids - stg_ids), sorted(stg_ids - prod_ids)
    return res


def delete_staging_only(t, ids):
    expr = pk_expr(t)
    set_triggers(t, False)
    try:
        for i in range(0, len(ids), 500):
            batch = ', '.join(lit(x) for x in ids[i:i + 500])
            run(f'DELETE FROM public."{t}" o WHERE {expr} = ANY (ARRAY[{batch}]::text[])', S.dest,
                f'delete staging-only rows of {t}')
    finally:
        set_triggers(t, True)


def reconcile_pk_sets(t, replace):
    """Compare primary-key sets. With replace: delete staging-only rows (seeded by migrations) and refill."""
    res = compare_pk_sets(t)
    if res['equal'] or not replace:
        return res
    if res['extra']:
        try:
            delete_staging_only(t, res['extra'])
        except StepError as e:
            res['note'] = 'staging-only rows have dependents, left in place: ' + clip(e, 160)
            return res
    copy_table(t, force=True)
    final = compare_pk_sets(t)
    final['note'] = f"replaced {len(res['extra'])} staging-only rows, refilled {len(res['missing'])}"
    return final


def describe_pk(res):
    t = res['table']
    if res['equal']:
        return f"{t}: primary keys match ({res['prod']} rows)"
    text = (f"{t}: MISMATCH prod {res['prod']} / staging {res['stg']}; missing {len(res['missing'])}, "
            f"staging-only {len(res['extra'])}")
    return text + (f" ({res['note']})" if res['note'] else '')


def seeded_table_fix():
    S.pk_results = []
    for t in ['suppliers'] + copy_order():
        res = reconcile_pk_sets(t, replace=t in SEED_REPLACE)
        S.pk_results.append(res)
        if not res['equal'] or res['note']:
            say(describe_pk(res))
    off = [r for r in S.pk_results if not r['equal']]
    result(f'primary-key sets: {len(S.pk_results) - len(off)} of {len(S.pk_results)} tables match'
           + (' (mismatches are reported, not repaired, except the seeded tables)' if off else ''))
    for r in off:
        note(describe_pk(r))


# --------------------------------------------------------------------------------------------
# Step: ledger rows for unshipped orders
# --------------------------------------------------------------------------------------------
def copy_ledger_rows():
    rows = run_section('ledger_open_orders.sql', 'stg_order_ids', {}, canned=[{'v': ['<order-id>']}])
    order_ids = rows[0]['v'] if rows else []
    if not order_ids:
        say('ledger: no unshipped orders on staging, nothing to copy')
        return
    ids_literal = lit(json.dumps(order_ids))
    read, offset = 0, 0
    while True:
        page = run_section('ledger_open_orders.sql', 'prod_rows',
                           {'ORDER_IDS': ids_literal, 'LIMIT': str(LEDGER_PAGE), 'OFFSET': str(offset)},
                           canned=[{'r': {}}])
        if not page:
            break
        payload = [dict(r['r'], ord=read + i) for i, r in enumerate(page)]
        run_section('ledger_open_orders.sql', 'stg_insert',
                    {'ROWS_JSON': lit(json.dumps(payload)), 'SYSTEM_ACTOR_ID': lit(SYSTEM_ACTOR)})
        read += len(page)
        offset += LEDGER_PAGE
        if len(page) < LEDGER_PAGE:
            break
    have = scalar(run("select count(*) n from public.inventory_transactions where reference_type = 'shipstation_order'",
                      S.dest, 'count copied ledger rows', canned=[{'n': read}]))
    result(f'ledger: {len(order_ids)} unshipped orders, {read} rows read from production, staging holds {have}')
    if have < read:
        note(f'ledger: staging holds fewer shipstation_order rows ({have}) than were read ({read})')


# --------------------------------------------------------------------------------------------
# Steps: cron cleanup and post_refresh
# --------------------------------------------------------------------------------------------
def cron_cleanup():
    where = 'where command ilike ' + lit('%' + PROD_REF + '%')
    jobs = run(f'select jobid, jobname from cron.job {where} order by jobid', S.dest, 'cron jobs pointing at production',
               canned=[{'jobid': 0, 'jobname': '<job>'}])
    for j in jobs:
        result('unscheduling', j['jobname'] or j['jobid'])
    if jobs:
        run(f'select cron.unschedule(jobid) from cron.job {where}', S.dest, 'unschedule jobs pointing at production')
    else:
        say('cron: no job points at production')


def block_outbound():
    run_section('post_refresh.sql', 'outbound', {'SYSTEM_ACTOR_ID': lit(SYSTEM_ACTOR)})
    S.outbound_written = True


def post_refresh():
    run_section('post_refresh.sql', 'realtime', {'SYSTEM_ACTOR_ID': lit(SYSTEM_ACTOR)})
    block_outbound()  # always the last write of a refresh
    result('post_refresh done: realtime entries added where the tables exist; outbound = blocked where wh_settings exists')


# --------------------------------------------------------------------------------------------
# Step: verify (verify.sql on both projects) and the report
# --------------------------------------------------------------------------------------------
def pk_rows_sql():
    parts = []
    for t in ['suppliers'] + S.tables:
        expr = pk_expr(t)
        digest = f"md5(coalesce(string_agg({expr}, ',' order by {expr}), ''))" if expr else "md5('')"
        parts.append(with_where(f"select {lit(t)}::text as t, count(*) as n, {digest} as h from public.\"{t}\" o",
                                table_where(t, True)))
    return '\n    union all '.join(parts)


def verify_values():
    vals = {'PROD_REF': lit(PROD_REF), 'PK_ROWS': pk_rows_sql()}
    vals.update(pii_values())
    return vals


def collect(name, ref, values):
    try:
        rows = run_section('verify.sql', name, values, ref)
    except StepError as e:
        return {'v': None, 'err': str(e)}
    if S.dry:
        return {'v': None, 'err': None}
    return {'v': rows[0]['v'] if rows else None, 'err': None if rows else 'no rows'}


def auth_probe():
    sql = load_sections('auth_probe.sql')['probe']['sql']
    if S.dry:
        run(sql, S.dest, 'auth_probe.sql:probe')
        return {'v': None, 'err': None}
    try:
        run(sql, S.dest, 'auth trigger probe (always rolls back)')
    except StepError as e:
        m = re.search(r'REFRESH_PROBE profile_role=(\w+)', str(e))
        return {'v': m.group(1), 'err': None} if m else {'v': None, 'err': str(e)}
    return {'v': None, 'err': 'the probe did not raise, which should be impossible'}


def verify_all():
    values = verify_values()
    out = {}
    for name, sec in load_sections('verify.sql').items():
        sides = {'both': [('stg', S.dest), ('prod', PROD)], 'stg': [('stg', S.dest)], 'prod': [('prod', PROD)]}[sec['target']]
        for side, ref in sides:
            if name == 'outbound_mode':
                table = out.get(('outbound_table', 'stg'), {}).get('v') or {}
                if not table.get('table') and not S.dry:
                    continue
            out[(name, side)] = collect(name, ref, values)
    out[('auth_probe', 'stg')] = auth_probe()
    return out


def row(n, name, status, detail):
    return {'n': n, 'name': name, 'status': status, 'detail': detail}


def pair(out, name):
    stg, prod = out.get((name, 'stg'), {}), out.get((name, 'prod'), {})
    return stg.get('v'), prod.get('v'), (stg.get('err') or prod.get('err'))


def ev_migrations(out):
    stg, prod, err = pair(out, 'migrations')
    if stg is None:
        return row(1, 'Migration history', 'FAIL', 'could not read schema_migrations: ' + clip(err, 160))
    want, got = set(migration_versions()), set(stg['versions'])
    detail = f'{len(got)} recorded on staging, {len(want)} files'
    if prod:
        detail += f', production records {prod["count"]}'
    missing, extra = sorted(want - got), sorted(got - want)
    if missing:
        detail += f'; missing on staging: {", ".join(missing[:3])}'
    if extra:
        detail += f'; recorded but no file: {", ".join(extra[:3])}'
    return row(1, 'Migration history', 'FAIL' if missing or extra else 'PASS', detail)


def ev_parity(out):
    stg, prod, err = pair(out, 'schema_parity')
    if stg is None or prod is None:
        return row(2, 'Schema parity', 'FAIL', 'could not compare: ' + clip(err, 160))
    hard = [c for c in ('columns', 'functions', 'policies', 'triggers', 'checks') if stg[c]['md5'] != prod[c]['md5']]
    sizes = ', '.join(f'{c} {stg[c]["n"]}/{prod[c]["n"]}' for c in ('columns', 'functions', 'policies', 'triggers', 'checks'))
    if hard:
        return row(2, 'Schema parity', 'FAIL', f'differs: {", ".join(hard)} (staging/production counts: {sizes})')
    if stg['column_order']['md5'] != prod['column_order']['md5']:
        return row(2, 'Schema parity', 'WARN', f'identical except column order (staging/production counts: {sizes})')
    return row(2, 'Schema parity', 'PASS', f'5 components identical (staging/production counts: {sizes})')


def ev_rls(out):
    stg, prod, err = pair(out, 'rls_grants')
    if stg is None or prod is None:
        return row(3, 'RLS and grants', 'FAIL', 'could not compare: ' + clip(err, 160))
    problems, warns = [], []
    if stg['rls_off'] != prod['rls_off']:
        problems.append(f'tables without RLS differ (staging only: {sorted(set(stg["rls_off"]) - set(prod["rls_off"]))[:5]}, '
                        f'production only: {sorted(set(prod["rls_off"]) - set(stg["rls_off"]))[:5]})')
    closed = [r for r, ok in stg['schema_usage'].items() if not ok]
    if closed:
        problems.append('no USAGE on schema public for ' + ', '.join(closed))
    for key in ('table_grants', 'function_grants'):
        if stg[key]['md5'] != prod[key]['md5']:
            warns.append(f'{key} differ ({stg[key]["n"]} vs {prod[key]["n"]} entries)')
    if problems:
        return row(3, 'RLS and grants', 'FAIL', '; '.join(problems + warns))
    if warns:
        return row(3, 'RLS and grants', 'WARN', '; '.join(warns))
    return row(3, 'RLS and grants', 'PASS', f'{len(stg["rls_off"])} tables without RLS (same as production), API roles have USAGE')


def ev_auth(out):
    res = out.get(('auth_probe', 'stg'), {})
    if res.get('err') or res.get('v') is None:
        return row(4, 'Auth trigger', 'FAIL', 'probe failed: ' + clip(res.get('err'), 200))
    if res['v'] == 'user':
        return row(4, 'Auth trigger', 'PASS', 'a throwaway auth user got a profile with role user (rolled back)')
    return row(4, 'Auth trigger', 'FAIL', f'the throwaway auth user got profile_role={res["v"]}')


def ev_cron(out):
    stg, prod, err = pair(out, 'cron')
    if stg is None:
        return row(5, 'Cron', 'FAIL', 'could not read cron.job: ' + clip(err, 160))
    names = sorted(j['name'] or '?' for j in stg['jobs'])
    if stg['prod_ref_jobs']:
        return row(5, 'Cron', 'FAIL', f'{stg["prod_ref_jobs"]} job(s) still point at production')
    return row(5, 'Cron', 'PASS', f'{len(names)} jobs, none points at production ({", ".join(names[:6])}{"..." if len(names) > 6 else ""})')


def ev_pks(out):
    stg, prod, err = pair(out, 'copied_pks')
    if stg is None or prod is None:
        return row(6, 'Copied data', 'FAIL', 'could not compare: ' + clip(err, 160))
    s = {r['t']: (r['n'], r['h']) for r in stg}
    p = {r['t']: (r['n'], r['h']) for r in prod}
    bad = [f'{t} (production {p[t][0]}, staging {s.get(t, (0,))[0]})' for t in p if s.get(t) != p[t]]
    if bad:
        return row(6, 'Copied data', 'FAIL', f'{len(bad)} of {len(p)} tables differ: ' + '; '.join(bad[:8]))
    rows_total = sum(n for n, _ in p.values())
    return row(6, 'Copied data', 'PASS', f'{len(p)} tables, {rows_total} rows, primary-key sets equal under the same filter')


def ev_pii(out):
    stg, _, err = pair(out, 'pii')
    if stg is None:
        return row(7, 'PII', 'FAIL', 'could not run the PII query: ' + clip(err, 160))
    problems = pii_problems(stg)
    if problems:
        return row(7, 'PII', 'FAIL', '; '.join(problems))
    return row(7, 'PII', 'PASS', f'{stg["orders"]} orders: all emails @example.com, names scrubbed, payload keys inside the allowlist, no @ in payloads')


def ev_smoke(out):
    stg, _, err = pair(out, 'smoke')
    if stg is None:
        return row(8, 'Smoke', 'FAIL', 'rpc_daily_report() failed: ' + clip(err, 160))
    if stg['type'] != 'object' or not stg['keys']:
        return row(8, 'Smoke', 'FAIL', f'rpc_daily_report() returned {stg["type"]} with {stg["keys"]} keys')
    return row(8, 'Smoke', 'PASS', f'rpc_daily_report() returned an object with {stg["keys"]} keys (rpc_apply_shipstation_sale not called)')


def ev_outbound(out):
    table, _, err = pair(out, 'outbound_table')
    if table is None:
        return row(10, 'Outbound', 'FAIL', 'could not check wh_settings: ' + clip(err, 160))
    if not table.get('table'):
        return row(10, 'Outbound', 'SKIP', 'wh_settings does not exist yet (the warehouse migrations are not applied); '
                   'check the ERP_OUTBOUND_MODE edge secret by hand')
    mode, _, err = pair(out, 'outbound_mode')
    if mode is None:
        return row(10, 'Outbound', 'FAIL', 'could not read wh_settings: ' + clip(err, 160))
    if mode.get('mode') == 'blocked':
        return row(10, 'Outbound', 'PASS', "wh_settings.outbound = blocked (the ERP_OUTBOUND_MODE edge secret is not checked by this script)")
    return row(10, 'Outbound', 'FAIL', f'wh_settings.outbound mode is {mode.get("mode")!r}, expected blocked')


def build_rows(out):
    rows = [ev_migrations(out), ev_parity(out), ev_rls(out), ev_auth(out), ev_cron(out), ev_pks(out), ev_pii(out),
            ev_smoke(out),
            row(9, 'App', 'SKIP', 'not automated: log in on staging; Stock Levels, Shipments and Sales load, amber banner shows'),
            ev_outbound(out)]
    return sorted(rows, key=lambda r: r['n'])


def write_report(rows):
    lines = ['Staging refresh verification',
             'run: ' + time.strftime('%Y-%m-%d %H:%M:%S'),
             f'mode: {S.mode}',
             f'destination (written): {S.dest}',
             f'production (read only): {PROD_REF}',
             f'copy cutoff (production clock): {S.cutoff}',
             f'orders from: {S.orders_from}',
             f'migration files: {len(migration_versions())}',
             'sql files: ' + ', '.join(file_hashes()), '']
    for r in rows:
        head = f'{r["n"]:>2}  {r["name"]:<18} {r["status"]:<5} '
        body = textwrap.wrap(r['detail'], 100) or ['']
        lines.append(head + body[0])
        lines.extend(' ' * len(head) + b for b in body[1:])
    failed = [r for r in rows if r['status'] == 'FAIL']
    lines += ['', 'Overall: ' + ('FAIL (' + ', '.join(f'{r["n"]} {r["name"]}' for r in failed) + ')' if failed else 'PASS')]
    if S.notes:
        lines += ['', 'Notes:'] + ['- ' + n for n in S.notes]
    text = '\n'.join(lines) + '\n'
    with open(REPORT_PATH, 'w', encoding='utf-8') as f:
        f.write(text)
    say('')
    for line in lines:
        say(line)
    say('report written to', os.path.relpath(REPORT_PATH, REPO))


def verify_step():
    out = verify_all()
    if S.dry:
        say('  [dry-run] the report is built from these answers and written to last-report.txt')
        return
    rows = build_rows(out)
    write_report(rows)
    failed = [r for r in rows if r['status'] == 'FAIL']
    if any(r['n'] == 7 for r in failed):
        raise PiiFailure(next(r['detail'] for r in failed if r['n'] == 7))
    if failed:
        raise VerifyFailed(f'{len(failed)} check(s) failed: ' + ', '.join(f'{r["n"]} {r["name"]}' for r in failed))


# --------------------------------------------------------------------------------------------
# Orchestration
# --------------------------------------------------------------------------------------------
REBUILD_STEPS = [
    ('Capture staging logins and back up staging (backups/ is git-ignored)', backup_step),
    ('Drop and recreate the public schema', reset_public_schema),
    ('Apply supabase/migrations/*.sql in order, stop on the first failure, record versions', migrate_first_pass),
    ('Accounts: copy suppliers, auth users with production uuids, mirror roles (accounts.sql)', accounts_step),
    ('Apply the remaining migrations and record versions', migrate_second_pass),
    ('Copy data from production, scrubbed in the production-side SELECT', copy_all),
    ('PII gate right after the copy (verify.sql:pii)', pii_gate),
    ('Seeded-table fix: compare primary-key sets, replace staging-only seeded rows, report the rest', seeded_table_fix),
    ('Ledger rows for unshipped orders (ledger_open_orders.sql)', copy_ledger_rows),
    ('Cron cleanup: unschedule jobs that mention the production ref', cron_cleanup),
    ('post_refresh.sql: realtime entries, then outbound = blocked as the last write', post_refresh),
    ('Verify on both projects (verify.sql), write last-report.txt', verify_step),
]
DATA_ONLY_STEPS = [
    ('Back up staging first (only with --backup)', backup_optional),
    ('Truncate the copied tables on staging in reverse FK order, plus the ledger', truncate_copied),
] + REBUILD_STEPS[5:]


def print_plan(steps):
    say(f'PLAN ({S.mode}): destination {S.dest} is written; production {PROD_REF} is only read')
    for i, (title, _) in enumerate(steps, 1):
        say(f'  {i:>2}. {title}')
    if S.dry:
        say('DRY RUN: nothing is sent. Below, the first line of every statement that would be sent, in order.')


def safety_net():
    """Runs whatever happened: re-enable paused triggers, and keep outbound blocked after any schema change."""
    if S.dry:
        return
    for t in sorted(S.disabled):
        try:
            set_triggers(t, True)
            say('safety net: user triggers re-enabled on', t)
        except Exception as e:  # noqa: BLE001
            say('WARNING: could not re-enable triggers on', t, '-', redact(str(e)))
    if S.schema_touched and not S.outbound_written:
        try:
            block_outbound()
            say('safety net: outbound = blocked written')
        except Exception as e:  # noqa: BLE001
            say('WARNING: could not write outbound = blocked:', redact(str(e)))


def parse_args(argv):
    p = argparse.ArgumentParser(description='Refresh staging from production (scrubbed).')
    mode = p.add_mutually_exclusive_group(required=True)
    mode.add_argument('--rebuild', action='store_true',
                      help='back up, drop and recreate public, migrate, accounts, copy, fix, ledger, cron, post_refresh, verify')
    mode.add_argument('--data-only', action='store_true', help='truncate the copied tables, then start at the copy step')
    p.add_argument('--dry-run', action='store_true', help='print the plan and the first line of every statement; send nothing')
    p.add_argument('--yes', action='store_true', help='skip the typed confirmation (for unattended runs)')
    p.add_argument('--no-backup', action='store_true', help='rebuild only: skip the JSON backup (use for a retry)')
    p.add_argument('--backup', action='store_true', help='data-only only: dump staging before truncating')
    p.add_argument('--dest-ref', default=STG, help='destination project ref (default: staging; production is refused)')
    p.add_argument('--orders-from', default=DEFAULT_ORDERS_FROM, help='first order date to copy (default %(default)s)')
    p.add_argument('--env-file', help='path to .env.local (default: the path in scripts/staging/mgmt.py)')
    args = p.parse_args(argv)
    if args.backup and not args.data_only:
        p.error('--backup is for --data-only; --rebuild always backs up unless --no-backup')
    if args.no_backup and not args.rebuild:
        p.error('--no-backup is for --rebuild')
    return args


def main(argv=None):
    args = parse_args(argv)
    S.reset()
    S.dry, S.yes, S.dest, S.orders_from = args.dry_run, args.yes, args.dest_ref, args.orders_from
    S.no_backup, S.backup_requested = args.no_backup, args.backup
    S.mode = 'rebuild' if args.rebuild else 'data-only'
    if args.env_file:
        mgmt.ENV = args.env_file
    elif not os.path.exists(mgmt.ENV) and os.path.exists(DEFAULT_ENV):
        mgmt.ENV = DEFAULT_ENV
    steps = REBUILD_STEPS if args.rebuild else DATA_ONLY_STEPS
    S.step_total = len(steps)
    started, code = time.time(), 0
    say(f'==== refresh.py {S.mode}{" (dry run)" if S.dry else ""} started ====')
    try:
        preflight(S.mode)
        print_plan(steps)
        confirm_run(S.mode)
        for title, fn in steps:
            step(title)
            fn()
        say(f'==== refresh.py {S.mode} finished in {time.time() - started:.0f}s ====')
    except Refuse as e:
        say('REFUSED:', e)
        code = 4
    except PiiFailure as e:
        say('PII CHECK FAILED:', e)
        say('Staging holds data that is not scrubbed. Outbound is blocked; do not hand staging to staff. '
            'Fix the scrub and run --data-only again.')
        code = 3
    except VerifyFailed as e:
        say('VERIFICATION FAILED:', e)
        code = 2
    except StepError as e:
        say('FAILED:', e)
        code = 1
    except KeyboardInterrupt:
        say('interrupted')
        code = 130
    finally:
        safety_net()
    return code


if __name__ == '__main__':
    sys.exit(main())
