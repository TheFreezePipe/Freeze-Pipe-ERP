# Print agent

A small Node service that prints the warehouse's label jobs on Zebra printers (design
`docs/design/WAREHOUSE_MODULE_PHASE0_1.md` §5.5). Install it on the PC next to a printer (the dock laptop, the
manufacturing laptop) or on one central PC that drives several network printers.

What it does:

1. Signs in as the dedicated **print-agent** login (its profile carries `is_print_agent`, the only grant
   `rpc_wh_claim_print_jobs` accepts).
2. Loads the active printers whose `agent_id` equals its `AGENT_ID`, and heartbeats them every 30 s
   (`rpc_wh_agent_heartbeat`), which is the "last seen" in Settings › Warehouse › Printers.
3. Listens for new jobs over Realtime and also claims every 15 s regardless (`rpc_wh_claim_print_jobs`, up to 20
   at a time, `FOR UPDATE SKIP LOCKED` on the server, so two agents never print one job).
4. Renders each job's payload to ZPL with the web app's own `src/lib/warehouse/labels.ts`, so a label looks the
   same from the agent and from the browser, and sends it by the printer's address.
5. Marks the job printed (`rpc_wh_mark_printed`), which stamps the cartons or locations. A failed send waits
   (2 s, 4 s, 8 s…, at most a third of `printing.claim_timeout_s`) and hands the job back as failed; the server
   queues it again until `printing.max_attempts`, then it shows as failed on the page that asked for it, with
   Reprint, Print elsewhere and Print from browser.
6. Never sends a job twice: every sent job is written to `data/sent-jobs.jsonl` before it is marked printed. If
   marking fails, or the server releases a claim that timed out and the agent claims the job again, it only marks
   it printed.

Jobs reach an agent only in outbound mode **live**. In **practice** (staging) the server sends every job to the
browser with a PRACTICE band; in **blocked** nothing is queued.

## Install

Needs Node 20.6 or newer (22 LTS recommended) and a checkout of this repository: the agent imports
`src/lib/warehouse/labels.ts` from it. Only this folder needs installing; `tsconfig.json` resolves the label
module's barcode library from this folder's `node_modules`, so the web app's dependencies are not needed.

```
cd tools\print-agent
npm ci
copy .env.example .env      # then fill it in (it is git-ignored)
npm run once                # sign in, heartbeat, print what is queued, exit
npm start                   # run until stopped
```

`.env`:

| Key | Value |
|---|---|
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | the project's URL and anon (public) key, as in the web app |
| `AGENT_EMAIL`, `AGENT_PASSWORD` | the print-agent login |
| `AGENT_ID` | this installation's name, e.g. `agent-dock`; printers with this `agent_id` are its own |
| `AGENT_DATA_DIR`, `POLL_SECONDS`, `HEARTBEAT_SECONDS`, `SEND_TIMEOUT_MS` | optional, see `.env.example` |

### The print-agent login

- **Staging**: `python tools\print-agent\setup\staging_agent_user.py` creates `print-agent@freezepipe.test`, sets
  `is_print_agent` as the database owner and writes this folder's `.env` with a random password (never printed).
  `--rotate` sets a new password. Re-run it after a staging `--rebuild`, which recreates the profile without the flag.
- **Production**: in the Supabase dashboard, Authentication › Add user (email and a long random password, auto
  confirm). Then, in the SQL editor (the owner is the only one who can set the flag; a trigger refuses it from the
  app): `UPDATE public.profiles SET is_print_agent = true, full_name = 'Print agent' WHERE email = '<that email>';`
  The login keeps the default role `user`, which lets it read the printers and jobs.

## Run it as a Windows service

With [NSSM](https://nssm.cc) (run as administrator; adjust the paths):

```
nssm install FPPrintAgent "C:\Program Files\nodejs\node.exe" "--import tsx src/main.ts"
nssm set FPPrintAgent AppDirectory "C:\FreezePipe\Freeze-Pipe-ERP\tools\print-agent"
nssm set FPPrintAgent AppStdout "C:\FreezePipe\print-agent.log"
nssm set FPPrintAgent AppStderr "C:\FreezePipe\print-agent.log"
nssm set FPPrintAgent AppRotateFiles 1
nssm set FPPrintAgent AppRotateBytes 1048576
nssm set FPPrintAgent AppExit Default Restart
nssm set FPPrintAgent AppRestartDelay 10000
nssm start FPPrintAgent
```

For a `share://` printer on another PC, run the service as a Windows user that can print to that share
(`nssm set FPPrintAgent ObjectName .\<user> <password>`); the default LocalSystem account is enough for a printer
shared on the same PC (`share://localhost/...`), a network printer (`tcp://`) and `file://`.

Without NSSM, Task Scheduler works too: a task triggered **At startup**, action `node.exe` with arguments
`--import tsx src/main.ts`, **Start in** this folder, "Run whether user is logged on or not", and "If the task
fails, restart every 1 minute".

## Printer addresses

| Address | Use |
|---|---|
| `tcp://192.168.1.50:9100` | A network Zebra: raw ZPL to port 9100 (the default port). |
| `share://DOCK-PC/ZebraDock` | A USB Zebra through a Windows printer share: the ZPL goes to a temp file and `copy /B` sends it to `\\DOCK-PC\ZebraDock` unchanged. For a printer on the agent's own PC use `share://localhost/<share name>`. Install the ZDesigner driver, then Printer properties › Sharing › Share this printer. Windows only. |
| `file://C:/labels` | Writes one `.zpl` file per job (staging practice, or before a printer arrives). A relative path (`file://./out`) is taken from this folder. |

Labels are drawn for 203 dpi (`labels.ts`); a 300 dpi printer prints them smaller.

## Register a printer

Settings › Warehouse › Printers and stations (admin) › **Add printer**: code (`DOCK-1`), name, station (the
station whose workers it prints for, or shared), address, label stock (`white_4x2` for LPNs, `green_4x2` for RTS,
`white_3x1` for locations and stations), dpi, agent id (this installation's `AGENT_ID`) and active.

There is no printer RPC yet and `wh_printers` has no client write policy, so the dialog builds the SQL statement
and **Copy SQL** puts it on the clipboard; the database owner runs it in the Supabase SQL editor. The agent picks
the printer up at its next heartbeat (30 s). On staging, `python tools\print-agent\setup\staging_printer.py --code
DOCK-1 --address file://C:/labels --agent agent-dev --station ST-DOCK` does the same.

The table then shows each printer's agent, last seen (green within 90 s) and open and failed jobs; **Test** prints
a station label on that printer (live mode only).

## Check a printer without signing in

```
npm run render -- --sample location                           # print the ZPL to the console
npm run render -- --sample lpn --to tcp://192.168.1.50:9100   # one practice LPN label on that printer
npm run render -- --payload job.json --to share://localhost/ZebraDock
```

## Development

```
npm run check     # tsc
npm test          # vitest: addresses, the file and TCP transports, retries, the journal
```

## Troubleshooting

| Log line | Meaning |
|---|---|
| `... profile lacks is_print_agent` | The owner has not set the flag (see The print-agent login). |
| `No active printers have agent_id "x"` | Register a printer with that agent id, or fix `AGENT_ID`. |
| `... attempt 1 of 3: 192.168.1.50:9100: connect ECONNREFUSED` | The printer is off or the address is wrong; the job retries, then fails. |
| `copy to \\PC\Share failed` | The share name is wrong or the service account cannot reach it. |
| `Realtime channel_error; polling continues` | Jobs still print within 15 s. |
