#!/usr/bin/env python3
"""Register (or update) a printer on STAGING, as the database owner (there is no printer RPC yet).

  python tools/print-agent/setup/staging_printer.py --code DOCK-1 --address file://C:/labels-out \
      --agent agent-dev --station ST-DOCK --stock white_4x2 --name "Dock printer (files)"

Upserts wh_printers by code with transport 'agent'. The agent whose AGENT_ID matches --agent picks it up at its
next heartbeat. The same statement can be built in Settings > Warehouse > Printers (Add printer > Copy SQL).

STAGING ONLY: mgmt.STG; the production ref is refused.
"""
import argparse
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))
sys.path.insert(0, os.path.join(REPO, "scripts", "staging"))
import mgmt  # noqa: E402

ADDRESS_RE = re.compile(r"^(tcp://[A-Za-z0-9.-]+(:\d{1,5})?/?|share://[A-Za-z0-9._-]+/[A-Za-z0-9 ._$-]+|file://.+)$", re.I)


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--code", required=True)
    ap.add_argument("--address", required=True)
    ap.add_argument("--agent", required=True)
    ap.add_argument("--name")
    ap.add_argument("--station", help="station location code, e.g. ST-DOCK (omit for a shared printer)")
    ap.add_argument("--stock", default="white_4x2", choices=["white_4x2", "green_4x2", "white_3x1"])
    ap.add_argument("--dpi", type=int, default=203, choices=[203, 300, 600])
    ap.add_argument("--inactive", action="store_true")
    args = ap.parse_args()

    ref = mgmt.STG
    if ref == mgmt.PROD or ref == "pnqujtugddxusllkikje":
        print("Refusing: staging only.")
        return 4
    if not re.fullmatch(r"[A-Z0-9]+(-[A-Z0-9]+)*", args.code):
        print("--code: capitals, digits and dashes, like DOCK-1.")
        return 2
    if not ADDRESS_RE.match(args.address.strip()):
        print("--address: tcp://host:9100, share://HOST/Share or file://<directory>.")
        return 2
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,60}", args.agent):
        print("--agent: letters, digits, dot, dash or underscore.")
        return 2

    station = "NULL"
    if args.station:
        station = (f"(SELECT id FROM public.wh_locations WHERE code = {mgmt.lit(args.station.upper())} "
                   f"AND kind = 'station' AND site_location_id = public._default_location_id())")
    sql = f"""
INSERT INTO public.wh_printers (code, name, station_location_id, transport, address, label_stock, dpi, agent_id, active)
VALUES ({mgmt.lit(args.code)}, {mgmt.lit(args.name or args.code)}, {station}, 'agent', {mgmt.lit(args.address.strip())},
        {mgmt.lit(args.stock)}, {args.dpi}, {mgmt.lit(args.agent)}, {'false' if args.inactive else 'true'})
ON CONFLICT (code) DO UPDATE
  SET name = EXCLUDED.name, station_location_id = EXCLUDED.station_location_id, transport = EXCLUDED.transport,
      address = EXCLUDED.address, label_stock = EXCLUDED.label_stock, dpi = EXCLUDED.dpi,
      agent_id = EXCLUDED.agent_id, active = EXCLUDED.active
RETURNING id, code, name, address, label_stock, dpi, agent_id, active,
          (SELECT code FROM public.wh_locations l WHERE l.id = station_location_id) AS station;
"""
    rows = mgmt.q(sql, ref)
    if args.station and rows and rows[0].get("station") is None:
        print(f"Warning: no station location {args.station}; the printer is shared.")
    for r in rows:
        print(f"{r['code']} ({r['id']}): {r['name']} | {r['address']} | {r['label_stock']} {r['dpi']} dpi | "
              f"agent {r['agent_id']} | station {r['station'] or 'shared'} | {'active' if r['active'] else 'inactive'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
