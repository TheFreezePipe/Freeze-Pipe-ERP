"""Rebuild the staging public schema from the repo's migration files (production's migration set).
Usage: python rebuild_staging_schema.py <scratchpad_dir> <repo_dir>
Destructive on STAGING only. Logs to rebuild_staging.log in the scratchpad.
"""
import sys, os, glob, time, json
sys.path.insert(0, sys.argv[1])
from mgmt import q, STG, lit
repo = sys.argv[2]
log = open(os.path.join(sys.argv[1], 'rebuild_staging.log'), 'a', encoding='utf-8')
def say(*a):
    s = ' '.join(str(x) for x in a); print(s); log.write(time.strftime('%H:%M:%S ') + s + '\n'); log.flush()

say('== rebuild start ==')
# 1. drop and recreate public
q("""
DROP SCHEMA public CASCADE;
CREATE SCHEMA public;
ALTER SCHEMA public OWNER TO postgres;
COMMENT ON SCHEMA public IS 'standard public schema';
GRANT ALL ON SCHEMA public TO postgres;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON SCHEMA public TO service_role;
""", STG)
say('public schema dropped and recreated')

# 2. apply migrations in order
files = sorted(glob.glob(os.path.join(repo, 'supabase', 'migrations', '*.sql')))
say('applying', len(files), 'migrations')
applied = []
for f in files:
    name = os.path.basename(f)
    sql = open(f, encoding='utf-8').read()
    t0 = time.time()
    try:
        q(sql, STG, timeout=900)
        applied.append(name)
        say(f'ok  {name} ({time.time()-t0:.1f}s)')
    except Exception as e:
        say(f'FAIL {name}: {e}')
        say('stopping; applied', len(applied))
        break

# 3. record schema_migrations for applied files
q("DELETE FROM supabase_migrations.schema_migrations", STG)
vals = []
for name in applied:
    version = name.split('_', 1)[0]
    mname = name.split('_', 1)[1].rsplit('.sql', 1)[0]
    vals.append(f"({lit(version)}, {lit(mname)})")
if vals:
    q("INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES " + ",".join(vals), STG)
say('schema_migrations recorded:', len(vals))

# 4. recreate the cross-schema trigger that the schema drop removed
try:
    q("CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();", STG)
    say('auth trigger recreated')
except Exception as e:
    say('auth trigger FAILED:', e)

# 5. verify
tables = q("select count(*) n from pg_stat_user_tables where schemaname='public'", STG)[0]['n']
funcs = q("select count(*) n from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'", STG)[0]['n']
cron = q("select jobid, jobname, schedule, active, left(command, 90) cmd from cron.job order by jobid", STG)
say('staging tables:', tables, 'functions:', funcs)
say('cron jobs:', json.dumps(cron))
say('== rebuild end ==', 'applied', len(applied), 'of', len(files))
