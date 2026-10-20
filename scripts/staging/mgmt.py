"""Supabase Management API helper: read-only or write SQL against a project using the PAT in .env.local. Never prints the token."""
import re, json, urllib.request, urllib.error, sys, time

ENV = r"C:\Dev\Freeze-Pipe-ERP\.env.local"
PROD = "pnqujtugddxusllkikje"
STG = "sitwttqdqqkucwkcyoks"

def _token():
    env = dict(re.findall(r'^([A-Z_]+)=(.*)$', open(ENV, encoding="utf-8").read(), re.M))
    return env["SUPABASE_ACCESS_TOKEN"].strip()

def q(sql, ref, timeout=600, retries=2):
    body = json.dumps({"query": sql}).encode()
    last = None
    for attempt in range(retries + 1):
        req = urllib.request.Request(
            f"https://api.supabase.com/v1/projects/{ref}/database/query", data=body,
            headers={"Authorization": "Bearer " + _token(), "Content-Type": "application/json"}, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read().decode())
        except urllib.error.HTTPError as e:
            msg = e.read().decode(errors="replace")
            last = RuntimeError(f"HTTP {e.code}: {msg[:2000]}")
            if e.code in (429, 502, 503, 504) and attempt < retries:
                time.sleep(3 * (attempt + 1)); continue
            raise last
    raise last

def lit(s):
    """SQL string literal with quotes escaped."""
    return "'" + s.replace("'", "''") + "'"
