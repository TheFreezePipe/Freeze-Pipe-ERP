import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useLiveInvalidate } from "@/lib/realtime";
import type { Database } from "@/lib/database.types";
import {
  whRpc,
  type WhBucket,
  type WhContainerState,
  type WhLabelKind,
  type WhResolveScanResult,
  type WhRpcResult,
} from "./use-warehouse";

/**
 * Warehouse Phase 1 task reads and station sessions (design §5.5, §9.4):
 * the putaway queue, one print job's status, the caller's live station and
 * the printers. Station start/end are RPCs; everything else here is a read.
 */

export type WhMoveRow = Database["public"]["Tables"]["wh_moves"]["Row"] & {
  container: {
    code: string;
    sku_id: string | null;
    qty: number;
    state: WhContainerState;
    label_stock: "white" | "green";
    /** Where the carton is now (it may have moved since the task was opened). */
    location_id?: string | null;
    location?: { code: string } | null;
    sku?: { sku: string; product_name: string } | null;
  } | null;
  sku: { sku: string; product_name: string } | null;
  suggested: { code: string; name?: string | null; is_overflow?: boolean } | null;
  from: { code: string } | null;
};

export interface WhPutawayFilter {
  origin?: "receipt" | "rts" | "manual" | "reconcile";
  fromLocationId?: string;
}

/** Open putaways, RTS cartons first (priority), then oldest first. `refetchInterval` adds a polling floor (the /go pages use 60 s). */
export function useWhPutawayQueue(filter: WhPutawayFilter = {}, options: { refetchInterval?: number } = {}) {
  useLiveInvalidate("wh-tasks", ["wh_moves"], [["wh-putaway"], ["wh-overview"]]);
  return useQuery({
    queryKey: ["wh-putaway", filter],
    refetchInterval: options.refetchInterval,
    queryFn: async (): Promise<WhMoveRow[]> => {
      let q = supabase
        .from("wh_moves")
        .select(
          "*, container:wh_containers(code, sku_id, qty, state, label_stock, location_id, location:wh_locations(code), sku:product_skus(sku, product_name)), sku:product_skus(sku, product_name), suggested:wh_locations!wh_moves_suggested_location_id_fkey(code, name, is_overflow), from:wh_locations!wh_moves_from_location_id_fkey(code)",
        )
        .eq("kind", "putaway")
        .in("status", ["open", "in_progress"]);
      if (filter.origin) q = q.eq("origin", filter.origin);
      if (filter.fromLocationId) q = q.eq("from_location_id", filter.fromLocationId);
      const { data, error } = await q
        .order("priority", { ascending: false })
        .order("created_at", { ascending: true })
        .limit(500);
      if (error) throw error;
      return (data ?? []) as unknown as WhMoveRow[];
    },
    staleTime: 30 * 1000,
  });
}

export type WhPrintJobRow = Database["public"]["Tables"]["wh_print_jobs"]["Row"] & {
  printer: { code: string; name: string } | null;
};

const PENDING_PRINT = new Set(["queued", "claimed"]);

/** One print job; refetches every 2 s while it is queued or being printed. */
export function useWhPrintJob(id: string | null | undefined) {
  return useQuery({
    queryKey: ["wh-print-job", id],
    enabled: !!id,
    queryFn: async (): Promise<WhPrintJobRow | null> => {
      const { data, error } = await supabase
        .from("wh_print_jobs")
        .select("*, printer:wh_printers(code, name)")
        .eq("id", id as string)
        .maybeSingle();
      if (error) throw error;
      return (data ?? null) as unknown as WhPrintJobRow | null;
    },
    refetchInterval: (query) => (PENDING_PRINT.has(query.state.data?.status ?? "") ? 2000 : false),
  });
}

export interface WhStationSession {
  id: string;
  station_location_id: string;
  started_at: string;
  device_id: string | null;
  station: { code: string; name: string | null } | null;
}

/** The signed-in person's live station session, or null. */
export function useWhStation() {
  return useQuery({
    queryKey: ["wh-station"],
    queryFn: async (): Promise<WhStationSession | null> => {
      const { data: auth } = await supabase.auth.getSession();
      const profileId = auth.session?.user.id;
      if (!profileId) return null;
      const { data, error } = await supabase
        .from("wh_station_sessions")
        .select("id, station_location_id, started_at, device_id, station:wh_locations(code, name)")
        .eq("profile_id", profileId)
        .is("ended_at", null)
        .maybeSingle();
      if (error) throw error;
      return (data ?? null) as unknown as WhStationSession | null;
    },
    staleTime: 60 * 1000,
  });
}

const DEVICE_KEY = "fp-wh-device-id";

/** A random id per browser, kept in localStorage, so a fixed laptop can be told apart. */
export function getWhDeviceId(): string | null {
  try {
    const existing = window.localStorage.getItem(DEVICE_KEY);
    if (existing) return existing;
    const fresh = crypto.randomUUID();
    window.localStorage.setItem(DEVICE_KEY, fresh);
    return fresh;
  } catch {
    return null;
  }
}

/** Scan a station label: ends the caller's previous session and opens one there. Exported for tests. */
export function startWhStation(
  params: { scan: string; deviceId?: string | null },
  client?: unknown,
): Promise<WhRpcResult<"rpc_wh_start_station">> {
  return whRpc(
    "rpc_wh_start_station",
    { p_scan_value: params.scan, p_device_id: params.deviceId ?? null },
    "Couldn't start the station",
    client,
  );
}

/** End the caller's live station session. Exported for tests. */
export function endWhStation(client?: unknown): Promise<WhRpcResult<"rpc_wh_end_station">> {
  return whRpc("rpc_wh_end_station", {}, "Couldn't end the station", client);
}

export function useWhStartStation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params: { scan: string; deviceId?: string | null }) =>
      startWhStation({ scan: params.scan, deviceId: params.deviceId === undefined ? getWhDeviceId() : params.deviceId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["wh-station"] });
    },
  });
}

export function useWhEndStation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => endWhStation(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["wh-station"] });
    },
  });
}

export type WhPrinterRow = Database["public"]["Tables"]["wh_printers"]["Row"] & {
  station: { code: string; name: string | null } | null;
};

/** Every printer with its station and the agent's last heartbeat. */
export function useWhPrinters() {
  useLiveInvalidate("wh-printers", ["wh_printers"], [["wh-printers"]]);
  return useQuery({
    queryKey: ["wh-printers"],
    queryFn: async (): Promise<WhPrinterRow[]> => {
      const { data, error } = await supabase
        .from("wh_printers")
        .select("*, station:wh_locations(code, name)")
        .order("code");
      if (error) throw error;
      return (data ?? []) as unknown as WhPrinterRow[];
    },
    staleTime: 60 * 1000,
  });
}


// ---- Phone putaway (design §7) ------------------------------------------------

/** A fresh idempotency key for one phone action (§5.1): a repeat returns the first result. */
export function newClientEventId(): string {
  return crypto.randomUUID();
}

type QueueRow = Pick<WhMoveRow, "id" | "origin" | "created_by" | "created_at" | "container" | "from">;

/** 0: the worker's own RTS cartons; 1: cartons waiting at IN-01; 2: everything else. */
export function putawayRank(row: QueueRow, me: string | null): number {
  if (row.origin === "rts" && me && row.created_by === me) return 0;
  const at = row.container ? (row.container.location?.code ?? null) : (row.from?.code ?? null);
  return at === "IN-01" ? 1 : 2;
}

/** The phone queue order (§7 step 1): own RTS cartons, then IN-01, then the rest; oldest first within each. */
export function orderPutawayQueue<T extends QueueRow>(rows: T[], me: string | null): T[] {
  return rows
    .map((row) => ({ row, rank: putawayRank(row, me) }))
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        a.row.created_at.localeCompare(b.row.created_at) ||
        a.row.id.localeCompare(b.row.id),
    )
    .map((x) => x.row);
}

const PUTAWAY_ROOTS = [["wh-putaway"], ["wh-overview"], ["wh-locations"], ["wh-location"], ["wh-containers"], ["wh-container-contents"]];

export interface WhPutawayParams {
  containerId: string;
  locationId: string;
  moveId?: string | null;
  clientEventId?: string;
}

/** Put a carton away (rpc_wh_putaway_container). Exported for tests. */
export function putawayWhContainer(params: WhPutawayParams, client?: unknown) {
  return whRpc(
    "rpc_wh_putaway_container",
    {
      p_container_id: params.containerId,
      p_location_id: params.locationId,
      p_move_id: params.moveId ?? null,
      p_client_event_id: params.clientEventId ?? newClientEventId(),
    },
    "Couldn't put the carton away",
    client,
  );
}

export function useWhPutaway() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params: WhPutawayParams) => putawayWhContainer(params),
    onSettled: () => {
      for (const queryKey of PUTAWAY_ROOTS) void qc.invalidateQueries({ queryKey });
    },
  });
}

export interface WhLoosePutawayParams {
  skuId: string;
  qty: number;
  fromLocationId: string;
  toLocationId: string;
  bucket: WhBucket | null;
  moveId: string;
  clientEventId?: string;
}

/** Put loose units away against their task (rpc_wh_move_stock with p_move_id). Exported for tests. */
export function putawayWhLoose(params: WhLoosePutawayParams, client?: unknown) {
  return whRpc(
    "rpc_wh_move_stock",
    {
      p_sku_id: params.skuId,
      p_qty: params.qty,
      p_from_location_id: params.fromLocationId,
      p_to_location_id: params.toLocationId,
      p_bucket: params.bucket,
      p_move_id: params.moveId,
      p_client_event_id: params.clientEventId ?? newClientEventId(),
    },
    "Couldn't put the units away",
    client,
  );
}

export function useWhPutawayLoose() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params: WhLoosePutawayParams) => putawayWhLoose(params),
    onSettled: () => {
      for (const queryKey of PUTAWAY_ROOTS) void qc.invalidateQueries({ queryKey });
    },
  });
}

/** Ask for another suggestion, excluding the ones already shown (rpc_wh_suggest_putaway). Exported for tests. */
export function suggestWhPutaway(params: { containerId: string; exclude: string[] }, client?: unknown) {
  return whRpc(
    "rpc_wh_suggest_putaway",
    { p_container_id: params.containerId, p_exclude: params.exclude },
    "Couldn't suggest a location",
    client,
  );
}

export function useWhSuggestPutaway() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params: { containerId: string; exclude: string[] }) => suggestWhPutaway(params),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["wh-putaway"] });
    },
  });
}

export interface WhOpenContainerParams {
  containerId: string;
  toLocationId?: string | null;
  unpack?: boolean;
  clientEventId?: string;
}

/** Open a carton, optionally moving it to a pick face first (rpc_wh_open_container). Exported for tests. */
export function openWhContainer(params: WhOpenContainerParams, client?: unknown) {
  return whRpc(
    "rpc_wh_open_container",
    {
      p_container_id: params.containerId,
      p_to_location_id: params.toLocationId ?? null,
      p_unpack: params.unpack ?? false,
      p_client_event_id: params.clientEventId ?? newClientEventId(),
    },
    "Couldn't open the carton",
    client,
  );
}

export function useWhOpenContainer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params: WhOpenContainerParams) => openWhContainer(params),
    onSettled: () => {
      for (const queryKey of PUTAWAY_ROOTS) void qc.invalidateQueries({ queryKey });
    },
  });
}

/** The location or carton a resolved scan names (rpc_wh_resolve_scan's `match` for ERP labels). */
export interface WhScanTarget {
  id?: string;
  code?: string;
  kind?: string;
  active?: boolean;
  pickable?: boolean;
  is_overflow?: boolean;
  location_id?: string | null;
  location_code?: string | null;
  state?: string;
}

export type WhResolvedScan = Omit<WhResolveScanResult, "match"> & { match: WhScanTarget | null };

/** What a scan is, with the location or carton it names (the full rpc_wh_resolve_scan answer). Exported for tests. */
export async function resolveWhScan(scan: string, client?: unknown): Promise<WhResolvedScan> {
  const result = await whRpc("rpc_wh_resolve_scan", { p_scan: scan }, "Couldn't look up that code", client);
  return { ...result, match: (result.match ?? null) as WhScanTarget | null, candidates: result.candidates ?? [] };
}

export interface WhContainerContent {
  sku_id: string;
  bucket: WhBucket;
  on_hand: number;
  sku: { sku: string; product_name: string } | null;
}

/** What one carton holds (a mixed carton's SKUs). */
export function useWhContainerContents(containerId: string | null | undefined) {
  return useQuery({
    queryKey: ["wh-container-contents", containerId],
    enabled: !!containerId,
    queryFn: async (): Promise<WhContainerContent[]> => {
      const { data, error } = await supabase
        .from("wh_inventory_balances")
        .select("sku_id, bucket, on_hand, sku:product_skus(sku, product_name)")
        .eq("container_id", containerId as string)
        .gt("on_hand", 0);
      if (error) throw error;
      return ((data ?? []) as unknown as WhContainerContent[]).sort((a, b) => (a.sku?.sku ?? "").localeCompare(b.sku?.sku ?? ""));
    },
    staleTime: 30 * 1000,
  });
}

// ---- Stations ------------------------------------------------------------------

export interface WhStationLocation {
  id: string;
  code: string;
  name: string | null;
  zone: string;
}

/** Every active station location (ST-S1…, ST-DOCK, ST-MFG-1…), for the StationChip picker. */
export function useWhStations(enabled = true) {
  return useQuery({
    queryKey: ["wh-stations"],
    enabled,
    queryFn: async (): Promise<WhStationLocation[]> => {
      const { data, error } = await supabase
        .from("wh_locations")
        .select("id, code, name, zone")
        .eq("kind", "station")
        .eq("active", true)
        .order("code");
      if (error) throw error;
      return (data ?? []) as WhStationLocation[];
    },
    staleTime: 10 * 60 * 1000,
  });
}

/** A fixed laptop pins its station here; the StationChip re-confirms it at sign-in (§5.5). */
export const PINNED_STATION_KEY = "wh.pinnedStation";

export function readPinnedStation(): string | null {
  try {
    const value = window.localStorage.getItem(PINNED_STATION_KEY);
    return value && /^ST-[A-Z0-9]+(-[A-Z0-9]+)*$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

export function writePinnedStation(code: string | null): void {
  try {
    if (code) window.localStorage.setItem(PINNED_STATION_KEY, code);
    else window.localStorage.removeItem(PINNED_STATION_KEY);
  } catch {
    // private mode or blocked storage: the pin simply does not stick
  }
}

// ---- Print jobs -----------------------------------------------------------------

/** The label stock a kind prints on (the server's routing rule in _wh_queue_print_job). */
export function labelStockFor(kind: WhLabelKind | string): WhLabelStock {
  return kind === "lpn" ? "white_4x2" : kind === "lpn_rts" ? "green_4x2" : "white_3x1";
}

/** A queued job nobody has printed after this long is stale: offer Reprint, Print elsewhere, Print from browser. */
export const PRINT_STALE_MS = 30 * 1000;
/** An agent that has not heartbeated for this long is treated as offline (it beats every 30 s). */
export const AGENT_OFFLINE_MS = 90 * 1000;

export type PrintJobPhase = "queued" | "printing" | "printed" | "failed" | "stale" | "blocked" | "cancelled" | "browser";

export interface PrintJobView {
  phase: PrintJobPhase;
  text: string;
  /** Show Reprint / Print elsewhere / Print from browser. */
  needsAction: boolean;
}

type JobLike = Pick<WhPrintJobRow, "status" | "created_at" | "claimed_at" | "error" | "printer_id" | "attempts">;
/** last_seen_at: null = never seen (offline); undefined = not known here (not judged). */
type PrinterLike = { name: string; code: string; last_seen_at?: string | null } | null | undefined;

function toMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/** One line for a print job: "Printing at Dock printer…", "Failed: paper out", stale after 30 s. Pure; `now` in ms. */
export function describePrintJob(job: JobLike, printer: PrinterLike, now: number): PrintJobView {
  const where = printer ? printer.name || printer.code : null;
  const seen = toMs(printer?.last_seen_at);
  const agentOffline = printer != null && printer.last_seen_at !== undefined && (seen == null || now - seen > AGENT_OFFLINE_MS);
  switch (job.status) {
    case "printed":
      return { phase: "printed", text: where ? `Printed at ${where}` : "Printed", needsAction: false };
    case "failed":
      return { phase: "failed", text: `Failed: ${job.error ?? "unknown error"}`, needsAction: true };
    case "blocked":
      return { phase: "blocked", text: "Printing is blocked on this environment", needsAction: false };
    case "cancelled":
      return { phase: "cancelled", text: "Cancelled", needsAction: false };
    case "claimed": {
      const claimed = toMs(job.claimed_at);
      return claimed != null && now - claimed > PRINT_STALE_MS * 2
        ? { phase: "stale", text: `Stuck printing at ${where ?? "the printer"}`, needsAction: true }
        : { phase: "printing", text: `Printing at ${where ?? "the printer"}…`, needsAction: false };
    }
    default: {
      if (!job.printer_id) return { phase: "browser", text: "Waiting for a browser to print it", needsAction: false };
      const created = toMs(job.created_at) ?? now;
      const retrying = job.attempts > 0 && job.error ? ` (retrying after: ${job.error})` : "";
      if (now - created > PRINT_STALE_MS || (agentOffline && now - created > 5000)) {
        return {
          phase: "stale",
          text: agentOffline
            ? `Queued for ${where ?? "the printer"}, but its print agent is offline`
            : `Still queued for ${where ?? "the printer"}${retrying}`,
          needsAction: true,
        };
      }
      return { phase: "queued", text: `Queued for ${where ?? "the printer"}${retrying}`, needsAction: false };
    }
  }
}

export interface WhPrinterQueue {
  queued: number;
  claimed: number;
  /** Failed in the last 7 days. */
  failed: number;
}

/** Open and recently failed jobs per printer, for Settings › Warehouse › Printers. */
export function useWhPrinterQueues() {
  useLiveInvalidate("wh-print-queues", ["wh_print_jobs"], [["wh-printer-queues"]]);
  return useQuery({
    queryKey: ["wh-printer-queues"],
    queryFn: async (): Promise<Record<string, WhPrinterQueue>> => {
      const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
      const { data, error } = await supabase
        .from("wh_print_jobs")
        .select("printer_id, status")
        .not("printer_id", "is", null)
        .or(`status.in.(queued,claimed),and(status.eq.failed,created_at.gte.${since})`)
        .limit(2000);
      if (error) throw error;
      const out: Record<string, WhPrinterQueue> = {};
      for (const row of (data ?? []) as { printer_id: string; status: string }[]) {
        const q = (out[row.printer_id] ??= { queued: 0, claimed: 0, failed: 0 });
        if (row.status === "queued") q.queued += 1;
        else if (row.status === "claimed") q.claimed += 1;
        else if (row.status === "failed") q.failed += 1;
      }
      return out;
    },
    staleTime: 15 * 1000,
  });
}

// ---- Printer registration (workaround: no printer RPC yet) -------------------------

export type WhLabelStock = "white_4x2" | "green_4x2" | "white_3x1";

export interface WhPrinterDraft {
  code: string;
  name: string;
  stationLocationId: string | null;
  address: string;
  labelStock: WhLabelStock;
  dpi: 203 | 300 | 600;
  active: boolean;
  agentId: string;
}

/**
 * Why a print-agent address will not work, or null. The agent understands
 * tcp://host:9100 (raw socket), share://HOST/ShareName (Windows raw spool
 * through a shared printer) and file://<directory> (writes .zpl files).
 */
export function printerAddressProblem(address: string): string | null {
  const a = address.trim();
  if (!a) return "Give the printer an address.";
  if (/^tcp:\/\//i.test(a)) {
    return /^tcp:\/\/[A-Za-z0-9.-]+(:\d{1,5})?\/?$/i.test(a) ? null : "Use tcp://<ip or host>:9100.";
  }
  if (/^share:\/\//i.test(a)) {
    return /^share:\/\/[A-Za-z0-9._-]+\/[A-Za-z0-9 ._$-]+$/i.test(a) ? null : "Use share://<PC name>/<printer share name>.";
  }
  if (/^file:\/\//i.test(a)) {
    return a.length > "file://".length ? null : "Use file://<directory> (for example file://C:/labels).";
  }
  return "The address must start with tcp://, share:// or file://.";
}

/** Everything wrong with a printer form, as sentences (empty when it is fine). */
export function printerDraftProblems(d: WhPrinterDraft): string[] {
  const out: string[] = [];
  if (!/^[A-Z0-9]+(-[A-Z0-9]+)*$/.test(d.code.trim())) out.push("Code: capitals, digits and dashes, like DOCK-1.");
  if (!d.name.trim()) out.push("Name the printer.");
  const address = printerAddressProblem(d.address);
  if (address) out.push(address);
  if (!/^[A-Za-z0-9._-]{1,60}$/.test(d.agentId.trim())) {
    out.push("Agent id: the AGENT_ID in that PC's print-agent .env, like agent-dock.");
  }
  return out;
}

function sqlText(value: string): string {
  return "'" + value.replace(/'/g, "''") + "'";
}

/**
 * The statement a database owner runs to add or update a printer (by code).
 * wh_printers has no client write policy and slice 1 has no printer RPC,
 * so Settings builds this for the Supabase SQL editor.
 */
export function printerUpsertSql(d: WhPrinterDraft): string {
  const station =
    d.stationLocationId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(d.stationLocationId)
      ? `${sqlText(d.stationLocationId)}::uuid`
      : "NULL";
  const dpi = d.dpi === 300 || d.dpi === 600 ? d.dpi : 203;
  return [
    "INSERT INTO public.wh_printers (code, name, station_location_id, transport, address, label_stock, dpi, agent_id, active)",
    `VALUES (${sqlText(d.code.trim())}, ${sqlText(d.name.trim())}, ${station}, 'agent', ${sqlText(d.address.trim())},`,
    `        ${sqlText(d.labelStock)}, ${dpi}, ${sqlText(d.agentId.trim())}, ${d.active ? "true" : "false"})`,
    "ON CONFLICT (code) DO UPDATE",
    "  SET name = EXCLUDED.name, station_location_id = EXCLUDED.station_location_id, transport = EXCLUDED.transport,",
    "      address = EXCLUDED.address, label_stock = EXCLUDED.label_stock, dpi = EXCLUDED.dpi,",
    "      agent_id = EXCLUDED.agent_id, active = EXCLUDED.active;",
  ].join("\n");
}
