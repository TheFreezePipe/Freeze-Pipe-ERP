# scripts/refresh-staging

Refreshes the staging Supabase project (`sitwttqdqqkucwkcyoks`, the warehouse practice floor) from production
(`pnqujtugddxusllkikje`) with customer details scrubbed. It turns the manual runbook in
`docs/design/STAGING_REFRESH.md` and the two scripts in `scripts/staging/` into one command, and adds the three
steps proposed in `docs/design/WAREHOUSE_MODULE_PHASE0_1.md` section 3.1/3.2 (ledger rows for unshipped orders,
allowlist scrub, outbound guard). Standard library only; it reuses `scripts/staging/mgmt.py` (`q`, `PROD`, `STG`,
`lit`).

**Production is only read.** Every statement sent to it must be a plain `SELECT`/`WITH`; `refresh.py` checks this in
one place (`run()`) and refuses anything else. Everything is written to staging.

## Before you run it

1. **Python 3.9 or newer.** No packages to install.
2. **Two values in `.env.local`** (git-ignored, the path `scripts/staging/mgmt.py` reads):

   ```
   SUPABASE_ACCESS_TOKEN=sbp_...            # personal access token, see below
   STAGING_PRACTICE_PASSWORD=...            # at least 8 characters
   ```

   The practice password is the one password every mirrored staging login gets (rebuild only). The token and the
   password are never printed or logged; `refresh.py` replaces them with `***` if an error message ever contains one.
3. **How to get a personal access token (PAT).** Open https://supabase.com/dashboard/account/tokens while signed in
   as the project owner, choose *Generate new token*, name it (for example `staging-refresh`), set the shortest
   expiry that suits you, copy it once, and paste it after `SUPABASE_ACCESS_TOKEN=` in `.env.local`. A PAT is
   account-wide (it can reach production too), so **revoke it on the same page when the refresh is done**.
   The scripts talk to the Management API's `database/query` endpoint, so no database password is needed and
   firewalls that block direct Postgres do not matter.
4. Pick a quiet moment. A rebuild drops staging's `public` schema; nobody should be practising on staging.

## Run it

```
python scripts\refresh-staging\refresh.py --rebuild --dry-run     # print the plan, send nothing
python scripts\refresh-staging\refresh.py --rebuild               # full rebuild (asks you to type the staging ref)
python scripts\refresh-staging\refresh.py --data-only             # weekly data refresh on an up-to-date schema
```

Read the `--dry-run` output first: it lists the plan and the first line of every statement that would be sent
(nothing is sent, and the token is not even needed).

| Flag | Meaning |
|---|---|
| `--rebuild` | Backup, drop and recreate `public`, apply every migration, accounts, copy, fixes, ledger rows, cron cleanup, post-refresh settings, verify. Destructive on staging's `public` schema. |
| `--data-only` | Truncate the copied tables on staging (reverse FK order, plus the ledger), then start at the copy step. Keeps schema and accounts. |
| `--dry-run` | Print the plan and every statement's first line; execute nothing. Works with both modes. |
| `--yes` | Skip the typed confirmation (unattended runs). Without it, a run in a terminal asks you to type the destination ref; a run without a terminal refuses. |
| `--no-backup` | Rebuild only. Skip the JSON backup (use for a retry after a failed run). The staging logins are still captured. |
| `--backup` | Data-only only. Dump staging to `backups/` before truncating. |
| `--dest-ref REF` | Destination project (default: staging). The production ref is refused. |
| `--orders-from YYYY-MM-DD` | First order date to copy (default `2026-08-01`, as in the as-run copy). |
| `--env-file PATH` | Read the token and password from another file. |

## What `--rebuild` does

1. **Backup.** Every public table as JSON, function definitions, `schema_migrations`, cron jobs and the staging
   logins, into `backups/<timestamp>/` with a `manifest.json` of SHA-256 sums. `backups/.gitignore` ignores
   everything in it. The files hold staging data, staff emails and cron commands: keep them a week, then delete.
2. **Schema.** `DROP SCHEMA public CASCADE`, recreate it with Supabase's grants (schema grants as in the as-run script,
   plus default privileges for the API roles, which the drop removes).
3. **Migrations, first pass.** Every `supabase/migrations/*.sql` in filename order, stopping at the first failure,
   then `schema_migrations` is rewritten from the files that applied. On 2026-10-20 this stopped at
   `20260921000001_shipstation_apply_once.sql`, which needs the system actor profile.
4. **Accounts** (`accounts.sql`). Copy `suppliers`; recreate `on_auth_user_created`; create an auth user with the
   production UUID for every production profile and for the system actor (`…0001`, no password, cannot sign in);
   give them the practice password; mirror role, name, active flag and supplier link with the `block_direct_role_update`
   trigger disabled around the one `UPDATE`. Staging-only logins (your own staging login, the pilot supplier accounts)
   keep their auth rows and passwords and get their profiles back from the snapshot taken before the drop. A staging
   login whose email equals a production profile's email but whose UUID differs is **replaced** by the production UUID
   and gets the practice password, because the foreign keys need the production UUID.
5. **Migrations, second pass.** The failing migration and everything after it; stops again on failure.
6. **Copy.** The `TABLES` list of `scripts/staging/copy_to_staging.py` (33 tables, plus `suppliers`) in foreign-key
   order, chunked, user triggers paused per table, resumable (a table that already holds production's row count is
   skipped). `shipstation_orders` is scrubbed inside the production-side `SELECT`: email `user-<hex>@example.com`,
   name `Customer <hex>`, and `raw_payload` rebuilt from an allowlist (`orderId`, `orderNumber`, `orderKey`,
   `orderDate`, `modifyDate`, `orderStatus`, `shipDate`, `advancedOptions` limited to `storeId`/`parentId`/
   `mergedOrSplit`/`mergedIds`, `items`, `dimensions`, `weight`, `carrierCode`, `serviceCode`).
   The copy is a snapshot: rows created in production after the run started (the *cutoff*, production's clock) are left
   out, so the checks at the end compare like with like.
7. **PII gate.** Right after the copy: no email outside `@example.com`, names scrubbed, payload keys inside the
   allowlist, no `@` in any payload. A failure stops the run (exit 3) before anything else is added.
8. **Seeded-table fix.** Compares primary-key sets for every copied table. Staging-only rows in `materials` and
   `mkt_promo_history` (seeded by migrations with random ids) are deleted and production's rows copied in; for those two
   it happens just before their dependents are copied. Any other mismatch is reported in the last report, not repaired.
9. **Ledger rows** (`ledger_open_orders.sql`). The `inventory_transactions` rows with `reference_type = 'shipstation_order'`
   of the copied orders whose status is not `shipped` (awaiting, on hold, cancelled), in `seq` order, so the nightly
   warehouse identity has its open-order term. `seq`, hashes, IP and user agent are not copied; the hash-chain trigger
   re-chains the rows on insert.
10. **Cron cleanup.** Unschedules every `cron.job` whose command contains the production ref.
11. **`post_refresh.sql`.** Adds the `wh_*` tables that exist to `supabase_realtime`, then writes
    `wh_settings.outbound = {"mode":"blocked"}` if `wh_settings` exists. This is the last write of the run (the safety net
    below repeats it if a run is cut short after the schema was touched).
12. **Verify** (`verify.sql` on both projects) and write `last-report.txt`.

## What `--data-only` does

Same as steps 6 to 12. First it truncates the copied tables in reverse foreign-key order in one `TRUNCATE`, together
with `inventory_transactions` (the ledger rows of the previous refresh and any practice entries go; this is a hash
chain, so it is all or nothing). A copied table that something **outside** the copy set references (for example
`product_skus` once `sku_barcodes` exists, or `locations` once `wh_locations` exists) is not truncated, and neither are
the tables it depends on; those rows are upserted and the primary-key check reports stale ones. Practice stock
movements are reset along with `inventory_levels`.

## Safety rules

- Refuses to run when the destination is the production ref (compared with a copy pinned in `refresh.py` as well as
  `mgmt.PROD`), when the destination is not a 20-letter ref, or when stdin is not a terminal and `--yes` is missing.
- Only plain `SELECT`/`WITH` statements reach production.
- The PII check runs twice, after the copy and in the final verification; a failure exits with code 3 and the report
  says which figure is wrong. Outbound is already blocked at that point.
- `outbound = blocked` is the last write of every run, and also written by the safety net after an error once the
  schema has been touched. User triggers paused for a copy are re-enabled in a `finally` and again by the safety net.
- The token and password are read from `.env.local`, held in memory, and replaced by `***` in anything printed or logged.
  `--dry-run` prints only the first line of each statement.

## The checklist (design 3.1) and `last-report.txt`

`verify.sql` runs on staging and production (read-only on both); `refresh.py` compares and writes
`last-report.txt`. Overall FAIL if any row is FAIL; WARN and SKIP do not fail the run.

| # | Check | How it is done here | Result when it is not clean |
|---|---|---|---|
| 1 | Migration history | `schema_migrations` against `supabase/migrations/*.sql` | FAIL |
| 2 | Schema parity | md5 of columns, function bodies, policies, triggers (with enabled state) and CHECKs, both projects | FAIL; column order differing alone is WARN |
| 3 | RLS and grants | tables without RLS equal to production; `USAGE` on schema `public` for `anon`, `authenticated`, `service_role`; table and function grant digests | FAIL; grant digests alone are WARN |
| 4 | Auth trigger | `auth_probe.sql`: inserts a throwaway `auth.users` row, reads the profile the trigger made (must be role `user`), then raises so everything rolls back | FAIL |
| 5 | Cron | no `cron.job` command contains the production ref | FAIL |
| 6 | Copied data | count and md5 of the primary-key set of every copied table under the copy's own filter | FAIL |
| 7 | PII | emails, names, payload keys, `@` in payloads | FAIL (exit 3) |
| 8 | Smoke | `rpc_daily_report()` returns an object | FAIL |
| 9 | App | **manual**: log in on staging, Stock Levels, Shipments and Sales load, amber banner shows | SKIP |
| 10 | Outbound | `wh_settings.outbound` is `blocked`; SKIP until `wh_settings` exists. The `ERP_OUTBOUND_MODE` edge secret cannot be read from SQL: **check by hand that it is not `live`** | FAIL |

Exit codes: 0 ok, 1 a step failed, 2 verification failed, 3 PII check failed, 4 a safety rule refused the run,
130 interrupted. The console output is also appended to `refresh.log` (git-ignored by the root `*.log` rule).

## After a refresh: restore the warehouse layout

A `--rebuild` drops `public`, so the warehouse layout (rack templates, racks, faces, fixtures, the named locations'
floor positions and the bay-level locations) is gone afterwards; the migrations only re-seed the 17 named locations
with no geometry. `load_layout.py` puts it back from the owner's digitizing workbook. Run it after every `--rebuild`
(a `--data-only` refresh leaves the `wh_*` tables alone, but re-running is harmless):

```
pip install openpyxl                                              # once; the only dependency
python scripts\refresh-staging\load_layout.py                    # save layout + named geometry, dry run, compare
python scripts\refresh-staging\load_layout.py --apply            # ... and create the bay-level locations
python scripts\refresh-staging\load_layout.py --payload-only     # print the payload, send nothing
```

What it does, in order, all on staging (`mgmt.STG`; any other `--ref`, production above all, is refused):

1. Reads `docs/research/warehouse-map/Warehouse digitizing workbook.xlsx`. Its formula cells have no cached values, so
   feet and millimetres are computed from the raw pixel columns and the Scale tab (origin at pixel 180, 72; px/ft =
   bay px ÷ bay ft; ft × 304.8, in × 25.4). Rack corners snap to the editor's 100 mm grid.
2. `rpc_wh_save_layout` with the templates, racks, faces and fixtures (all or nothing).
3. `rpc_wh_save_location` for each named location's centre and footprint (IN-01, OUT-UPS, OUT-GAY-1/2, ST-S1..4,
   ST-MFG-1..4, SPARES-01, CART-START, MFG-LINE). ST-DOCK is not on the drawing and keeps no geometry.
4. `rpc_wh_generate_locations(NULL, true)` and a comparison with the workbook's Locations tab: every bay-level code
   must match; `pick_sequence` differs only where the design's §5.3 rule interleaves facing faces walked on one pass
   (01+02, 05+06) and where unrouted faces (08, 09) are numbered `99000 + rank × 10 + level`. Each difference is listed.
5. With `--apply` and no conflicts, `rpc_wh_generate_locations(NULL, false)`.

Every step is idempotent: a second run updates in place and the generator creates and deactivates nothing. Exit codes:
0 ok, 1 a call failed or the layout was rejected, 2 code differences or conflicts, 4 refused.

The refresh leaves `wh_settings.outbound` at `blocked` (its last write), which refuses label jobs. To print practice
labels from the browser (`%Z` barcodes, PRACTICE band), switch it to Practice in Settings › Warehouse › Outbound, or
run `SELECT rpc_wh_set_setting('outbound', '{"mode":"practice"}')` on staging.

The same rules live in `src/lib/warehouse/workbook-import.ts` (Settings › Warehouse › Import workbook). Change both
together, then run `python scripts\refresh-staging\load_layout.py --payload-only --write-fixture` and `npm test`:
`workbook-import.test.ts` compares the TypeScript output with the fixture the script writes.

## After the layout: practice stock on the shelves

Practice data so Stock › Map, the rack elevation and the location drawer have something to show. Run it after
`load_layout.py --apply`, on an empty warehouse (it refuses `--apply` while any balance or carton exists, because
movements are append-only; rebuild staging to start over):

```
python scripts\refresh-staging\load_practice_stock.py            # plan + rpc_wh_import_stock dry run, writes nothing
python scripts\refresh-staging\load_practice_stock.py --apply    # ... and import it
```

It places staging's own `inventory_levels`: for each active SKU with `warehouse_finished > 0`, one open carton (1 to 12
units) on a pickable RTS bay-level, SKUs spread round robin over the pick faces in walk order, A-class first, and the
rest as sealed cartons of 12 in that bay's level-3 overflow; `warehouse_raw` as sealed cartons of 12 (plus an open
remainder) in the RAW bays; `warehouse_prefilled_raw` likewise in the WIP bays. Each bay-level is capped at its
`capacity_cartons`, or `--default-capacity` (24) where none is set (all of staging today); what does not fit is
reported as unplaced, and in-production units stay on the line. The import mints `C-OB-nnnn` cartons with
`opening_balance` movements. **No ledger rows**: `inventory_transactions` and `inventory_levels` are untouched, so
the books and the shelves differ by the unplaced units, as they would before a go-live count.

As loaded on 2026-10-22: 445 cartons (337 sealed, 108 open) holding 4,739 units in 47 locations (finished 4,087 of
45,523; raw 628 of 628; prefilled 24 of 24). Exit codes: 0 ok, 1 a call failed or rows were rejected, 3 stock already
exists, 4 refused (not staging).

## The print agent on staging

`tools/print-agent` prints label jobs on Zebra printers (its README covers install, the Windows service and the
address forms). On staging it is set up with two owner-side scripts, both refusing any project but staging:

```
python tools\print-agent\setup\staging_agent_user.py           # the print-agent login + tools/print-agent/.env
python tools\print-agent\setup\staging_printer.py --code DOCK-1 --address file://C:/labels-out --agent agent-dev --station ST-DOCK
cd tools\print-agent && npm ci && npm run once
```

- `staging_agent_user.py` creates `print-agent@freezepipe.test` (role `user`, `is_print_agent` set as the owner) and
  writes `tools/print-agent/.env` (git-ignored) with a random password that is never printed; `--rotate` replaces
  it. A `--rebuild` keeps the login (a staging-only login) but recreates its profile without `is_print_agent`, and
  drops `wh_printers`: run both scripts again afterwards.
- `staging_printer.py` upserts a printer by code. `file://` writes one `.zpl` file per job, which is how staging
  practises without a printer.
- Staging runs in outbound **practice**, where `rpc_wh_request_labels` sends every job to the browser, so the agent
  never sees one by itself. To exercise it, queue a job and point it at the printer by hand as the owner (keep
  outbound off `live` on staging):

  ```sql
  SELECT rpc_wh_request_labels('location', ARRAY[(SELECT id FROM wh_locations WHERE code = 'IN-01')], 'desktop',
                               (SELECT id FROM wh_printers WHERE code = 'DOCK-1'));
  UPDATE wh_print_jobs SET printer_id = (SELECT id FROM wh_printers WHERE code = 'DOCK-1')
   WHERE id = '<job_id from above>' AND status = 'queued' AND printer_id IS NULL;
  ```

  A running agent prints it within a second or two over Realtime (15 s at most by polling) and marks it printed.

As left on 2026-10-23: the login above; `DOCK-1` (agent `agent-dev`, station `ST-DOCK`, `white_4x2`, `file://`
pointing at a temporary folder on the developer's PC, so re-point it with `staging_printer.py` before use); two
practice jobs printed through it.

## When something goes wrong

- **A migration fails twice** (before and after the accounts step): fix it, then `--rebuild --no-backup`.
- **The run is killed during a copy**: re-run `--data-only`; the copy step re-enables the table's triggers. Check 2
  also fails while a user trigger is left disabled, because the digest includes the enabled state.
- **PII check failed**: staging holds unscrubbed data. Do not use it. Fix the scrub (`scrub_projection()` in
  `refresh.py`), then `--data-only`.
- **Check 6 or 2 differs**: the report lists the tables or components; compare with production before trusting staging.
- **Roll back to the previous staging**: the JSON in `backups/<timestamp>/tables/` is a row dump, not a restore script;
  keep it for reference, as the runbook did.

## Files

| File | Purpose |
|---|---|
| `refresh.py` | The tool. Small functions, one per step; every statement goes through `run()`. |
| `accounts.sql` | Sections `auth_trigger`, `accounts`, `guard_restore`. Placeholders: practice password, system actor, production profiles, staging-only logins. |
| `ledger_open_orders.sql` | Sections `stg_order_ids`, `prod_rows` (production, read-only), `stg_insert`. |
| `post_refresh.sql` | Sections `realtime`, `outbound`. Both are no-ops until the `wh_*` tables exist. |
| `verify.sql` | One read-only query per check, each returning one `jsonb`. |
| `auth_probe.sql` | Check 4, staging only, always rolls back. |
| `load_layout.py` | Post-refresh step: the warehouse layout from the digitizing workbook (needs `openpyxl`). |
| `load_practice_stock.py` | Post-refresh step after the layout: practice cartons on the shelves from `inventory_levels` (no ledger rows). |
| `backups/` | Timestamped dumps; everything in it is git-ignored. |
| `refresh.log`, `last-report.txt` | Written by every run (the report only by a real run). |

SQL files are split into sections by lines like `-- @@ name stg`; `{{NAME}}` placeholders inside a section are replaced
by `refresh.py` with ready-made SQL literals (a leftover or unknown placeholder stops the run).

## Things to know

- Every mirrored production login, including admins and supplier users, signs in to staging with the same practice
  password. Staging is a practice floor, not a place for secrets; revoke the PAT and keep the password out of chat.
- Only customer details in `shipstation_orders` are scrubbed, as in the as-run copy. Staff emails (profiles), supplier
  contact details and free-text notes on factory orders, freight and task logs are copied as they are.
- The refresh does not touch Edge Function secrets. Staging has no ShipStation secrets, and `ERP_OUTBOUND_MODE` must stay
  unset or not `live` there.
- Migrations still hard-code production's project URL in cron jobs (design 3.2 proposes reading it from Vault);
  until then the cron cleanup step is what keeps staging from calling production.
