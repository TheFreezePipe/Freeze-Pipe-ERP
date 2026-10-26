import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useLiveInvalidate } from "@/lib/realtime";
import type { Database, Json } from "@/lib/database.types";
import { whRpc, type WhBucket, type WhPrinterInput, type WhPrinterRecord, type WhRpcResult } from "./use-warehouse";
import { newClientEventId, printerAddressProblem, type WhLabelStock } from "./use-warehouse-tasks";
import type { WhCountKind } from "./use-warehouse-map";

/**
 * Warehouse Phase 1, slice 4F (design §5.3, §5.5, §6, §8, §9.4): cycle
 * counts on the phone and the desktop, the moves log, the latest nightly
 * reconcile, printer registration and the physical-layer switch.
 *
 * Every mutation is a plain function taking an optional client (exported
 * for the contract tests) plus a hook that invalidates the roots it changes.
 * The phone's count state (what has been scanned so far) is kept by the pure
 * helpers at the bottom, so the rules are tested without a screen. Never
 * show a counter expected quantities: rpc_wh_record_count leaves them out of
 * its answer, and the phone never reads wh_count_lines.
 */

// ---- Types ------------------------------------------------------------------------

export type WhCountStatus = "open" | "counting" | "submitted" | "approved" | "cancelled";
export type WhCountResolution = "accept" | "misplaced" | "write_off" | "recount";
export type WhLabelFlag = "needs_green" | "needs_white";

type CountTaskRow = Database["public"]["Tables"]["wh_count_tasks"]["Row"];
type CountLineRow = Database["public"]["Tables"]["wh_count_lines"]["Row"];

export interface WhCountLocationRef {
  id: string;
  code: string;
  name: string | null;
  kind: string;
  zone: string;
  face: string | null;
  pick_sequence: number | null;
  is_overflow: boolean;
  active: boolean;
}

export type WhCountTaskRow = CountTaskRow & {
  location: WhCountLocationRef | null;
  sku: { sku: string; product_name: string } | null;
  assignee: { full_name: string } | null;
  submitter: { full_name: string } | null;
  approver: { full_name: string } | null;
};

export type WhCountLine = CountLineRow & {
  sku: { sku: string; product_name: string } | null;
  container: {
    code: string;
    state: string;
    label_stock: "white" | "green";
    location_id: string | null;
    location: { code: string } | null;
  } | null;
};

/** A movement at the counted location, for the "likely cause" column. */
export interface WhCountMovement {
  id: string;
  type: string;
  sku_id: string;
  qty: number;
  from_location_id: string | null;
  to_location_id: string | null;
  from_container_id: string | null;
  to_container_id: string | null;
  created_at: string;
  note: string | null;
  sku: { sku: string } | null;
  from_container: { code: string } | null;
  to_container: { code: string } | null;
}

export interface WhCountTaskDetail {
  task: WhCountTaskRow | null;
  lines: WhCountLine[];
  /** Movements at the location from a day before the count started to now (newest first, at most 60). */
  movements: WhCountMovement[];
}

const TASK_SELECT =
  "*, location:wh_locations!wh_count_tasks_location_id_fkey(id, code, name, kind, zone, face, pick_sequence, is_overflow, active), " +
  "sku:product_skus(sku, product_name), " +
  "assignee:profiles!wh_count_tasks_assigned_to_fkey(full_name), " +
  "submitter:profiles!wh_count_tasks_submitted_by_fkey(full_name), " +
  "approver:profiles!wh_count_tasks_approved_by_fkey(full_name)";

const COUNT_TABLES = ["wh_count_tasks", "wh_count_lines"];
const COUNT_LIVE_ROOTS = [["wh-counts"], ["wh-count"], ["wh-overview"]];

function statusList(status: WhCountStatus | readonly WhCountStatus[]): WhCountStatus[] {
  return [...new Set(Array.isArray(status) ? status : [status as WhCountStatus])].sort();
}

// ---- Reads ------------------------------------------------------------------------

/**
 * Count tasks in one or more statuses with their location, trigger SKU and
 * people, oldest due first. `orderCountPath` turns them into a walk.
 * `refetchInterval` adds a polling floor (the /go pages use 60 s).
 */
export function useWhCountTasks(
  status: WhCountStatus | readonly WhCountStatus[],
  options: { refetchInterval?: number; enabled?: boolean } = {},
) {
  const statuses = statusList(status);
  useLiveInvalidate("wh-counts", COUNT_TABLES, COUNT_LIVE_ROOTS);
  return useQuery({
    queryKey: ["wh-counts", statuses],
    enabled: options.enabled ?? true,
    refetchInterval: options.refetchInterval,
    queryFn: async (): Promise<WhCountTaskRow[]> => {
      const { data, error } = await supabase
        .from("wh_count_tasks")
        .select(TASK_SELECT)
        .in("status", statuses)
        .order("due_date", { ascending: true, nullsFirst: true })
        .order("created_at", { ascending: true })
        .limit(500);
      if (error) throw error;
      return (data ?? []) as unknown as WhCountTaskRow[];
    },
    staleTime: 30 * 1000,
  });
}

/**
 * One count with its lines (expected, counted, variance; desktop only) and
 * the movements at its location around the count, for the likely cause.
 */
export function useWhCountTask(id: string | null | undefined) {
  return useQuery({
    queryKey: ["wh-count", id],
    enabled: !!id,
    queryFn: async (): Promise<WhCountTaskDetail> => {
      const taskId = id as string;
      const [taskRes, linesRes] = await Promise.all([
        supabase.from("wh_count_tasks").select(TASK_SELECT).eq("id", taskId).maybeSingle(),
        supabase
          .from("wh_count_lines")
          .select(
            "*, sku:product_skus(sku, product_name), container:wh_containers(code, state, label_stock, location_id, location:wh_locations!wh_containers_location_id_fkey(code))",
          )
          .eq("count_task_id", taskId)
          .order("created_at", { ascending: true }),
      ]);
      if (taskRes.error) throw taskRes.error;
      if (linesRes.error) throw linesRes.error;
      const task = (taskRes.data ?? null) as unknown as WhCountTaskRow | null;
      let movements: WhCountMovement[] = [];
      if (task) {
        const anchor = task.started_at ?? task.submitted_at ?? task.created_at;
        const since = new Date(Date.parse(anchor) - 24 * 3600 * 1000).toISOString();
        const { data, error } = await supabase
          .from("wh_inventory_movements")
          .select(
            "id, type, sku_id, qty, from_location_id, to_location_id, from_container_id, to_container_id, created_at, note, sku:product_skus(sku), from_container:wh_containers!wh_inventory_movements_from_container_id_fkey(code), to_container:wh_containers!wh_inventory_movements_to_container_id_fkey(code)",
          )
          .or(`from_location_id.eq.${task.location_id},to_location_id.eq.${task.location_id}`)
          .gte("created_at", since)
          .order("created_at", { ascending: false })
          .limit(60);
        if (error) throw error;
        movements = (data ?? []) as unknown as WhCountMovement[];
      }
      return { task, lines: (linesRes.data ?? []) as unknown as WhCountLine[], movements };
    },
    staleTime: 30 * 1000,
  });
}

export type WhMoveKind = "putaway" | "replenish" | "move";
export type WhMoveStatus = "open" | "in_progress" | "done" | "cancelled";

export interface WhMovesFilter {
  status?: WhMoveStatus | "all";
  kind?: WhMoveKind | "all";
}

export type WhMoveLogRow = Database["public"]["Tables"]["wh_moves"]["Row"] & {
  container: { code: string; sku_id: string | null; qty: number; label_stock: "white" | "green"; sku: { sku: string } | null } | null;
  sku: { sku: string; product_name: string } | null;
  from: { code: string } | null;
  suggested: { code: string } | null;
  to: { code: string } | null;
  completer: { full_name: string } | null;
  creator: { full_name: string } | null;
};

/** The moves log (putaway, replenish, move), newest first, at most 300 rows. */
export function useWhMoves(filter: WhMovesFilter = {}) {
  useLiveInvalidate("wh-moves", ["wh_moves"], [["wh-moves"]]);
  const key = { status: filter.status ?? "all", kind: filter.kind ?? "all" };
  return useQuery({
    queryKey: ["wh-moves", key],
    queryFn: async (): Promise<WhMoveLogRow[]> => {
      let q = supabase
        .from("wh_moves")
        .select(
          "*, container:wh_containers(code, sku_id, qty, label_stock, sku:product_skus(sku)), sku:product_skus(sku, product_name), " +
            "from:wh_locations!wh_moves_from_location_id_fkey(code), suggested:wh_locations!wh_moves_suggested_location_id_fkey(code), " +
            "to:wh_locations!wh_moves_to_location_id_fkey(code), completer:profiles!wh_moves_completed_by_fkey(full_name), " +
            "creator:profiles!wh_moves_created_by_fkey(full_name)",
        );
      if (key.status !== "all") q = q.eq("status", key.status);
      if (key.kind !== "all") q = q.eq("kind", key.kind);
      const { data, error } = await q.order("created_at", { ascending: false }).limit(300);
      if (error) throw error;
      return (data ?? []) as unknown as WhMoveLogRow[];
    },
    staleTime: 30 * 1000,
  });
}

export type WhReconcileRun = Database["public"]["Tables"]["wh_reconcile_runs"]["Row"];
export type WhReconcileLine = Database["public"]["Tables"]["wh_reconcile_lines"]["Row"] & {
  sku: { sku: string; product_name: string } | null;
};

export interface WhReconcileCountRef {
  id: string;
  status: string;
  code: string | null;
}

export interface WhReconcileLatest {
  run: WhReconcileRun | null;
  /** Largest |R| first. */
  lines: WhReconcileLine[];
  /** The count tasks the lines name, by id. */
  counts: Record<string, WhReconcileCountRef>;
  /** The ten latest runs, newest first (the trend). */
  history: WhReconcileRun[];
}

/** The latest reconcile run, its lines, the counts it opened and the recent runs. */
export function useWhReconcileLatest() {
  return useQuery({
    queryKey: ["wh-reconcile"],
    queryFn: async (): Promise<WhReconcileLatest> => {
      const { data: runs, error } = await supabase
        .from("wh_reconcile_runs")
        .select("*")
        .order("run_at", { ascending: false })
        .limit(10);
      if (error) throw error;
      const history = (runs ?? []) as WhReconcileRun[];
      const run = history[0] ?? null;
      if (!run) return { run: null, lines: [], counts: {}, history };
      const { data: lineData, error: lineError } = await supabase
        .from("wh_reconcile_lines")
        .select("*, sku:product_skus(sku, product_name)")
        .eq("run_id", run.id)
        .limit(2000);
      if (lineError) throw lineError;
      const lines = sortReconcileLines((lineData ?? []) as unknown as WhReconcileLine[]);
      const ids = [...new Set(lines.flatMap((l) => l.count_task_ids ?? []))];
      const counts: Record<string, WhReconcileCountRef> = {};
      if (ids.length > 0) {
        const { data: taskData, error: taskError } = await supabase
          .from("wh_count_tasks")
          .select("id, status, location:wh_locations!wh_count_tasks_location_id_fkey(code)")
          .in("id", ids.slice(0, 300));
        if (taskError) throw taskError;
        for (const t of (taskData ?? []) as unknown as { id: string; status: string; location: { code: string } | null }[]) {
          counts[t.id] = { id: t.id, status: t.status, code: t.location?.code ?? null };
        }
      }
      return { run, lines, counts, history };
    },
    staleTime: 60 * 1000,
  });
}

/** What a carton holds now (a mixed carton's SKUs), read once when the counter scans it. */
export async function fetchWhCartonSkus(containerId: string): Promise<{ sku_id: string; on_hand: number; sku: { sku: string; product_name: string } | null }[]> {
  const { data, error } = await supabase
    .from("wh_inventory_balances")
    .select("sku_id, on_hand, sku:product_skus(sku, product_name)")
    .eq("container_id", containerId)
    .gt("on_hand", 0);
  if (error) throw error;
  return ((data ?? []) as unknown as { sku_id: string; on_hand: number; sku: { sku: string; product_name: string } | null }[]).sort(
    (a, b) => (a.sku?.sku ?? "").localeCompare(b.sku?.sku ?? ""),
  );
}

/** Largest absolute residual first, then SKU, then bucket. Pure; exported for tests. */
export function sortReconcileLines<T extends { residual: number; bucket: string; sku: { sku: string } | null }>(lines: T[]): T[] {
  return [...lines].sort(
    (a, b) =>
      Math.abs(b.residual) - Math.abs(a.residual) ||
      (a.sku?.sku ?? "").localeCompare(b.sku?.sku ?? "") ||
      a.bucket.localeCompare(b.bucket),
  );
}

// ---- Count mutations ------------------------------------------------------------------

/** One counted line as rpc_wh_record_count takes it. */
export interface WhCountLineInput {
  sku_id: string;
  container_id: string | null;
  counted_qty: number;
  scan_value: string | null;
}

export interface WhRecordCountParams {
  locationId: string;
  lines: WhCountLineInput[];
  /** null: the RPC opens an ad hoc count (or uses the location's open one). */
  countTaskId?: string | null;
  /** When the counter started at the location; movements after it flag moved_during_count. */
  startedAt?: string | null;
  /** Reuse the same id when retrying the same submission, so a repeat replays the first result. */
  clientEventId?: string;
}

/** Submit a blind count (rpc_wh_record_count). The answer carries no expected figures. Exported for tests. */
export function recordWhCount(params: WhRecordCountParams, client?: unknown) {
  return whRpc(
    "rpc_wh_record_count",
    {
      p_location_id: params.locationId,
      p_lines: params.lines as unknown as Json,
      p_count_task_id: params.countTaskId ?? null,
      p_started_at: params.startedAt ?? null,
      p_client_event_id: params.clientEventId ?? newClientEventId(),
    },
    "Couldn't record the count",
    client,
  );
}

const COUNT_WRITE_ROOTS = [["wh-counts"], ["wh-count"], ["wh-locations"], ["wh-location"], ["wh-overview"]];

export function useWhRecordCount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params: WhRecordCountParams) => recordWhCount(params),
    onSettled: () => {
      for (const queryKey of COUNT_WRITE_ROOTS) void qc.invalidateQueries({ queryKey });
    },
  });
}

export interface WhVarianceDecision {
  line_id: string;
  resolution: WhCountResolution;
}

/** Resolve a submitted count (managers and admins); unlisted lines are accepted. Exported for tests. */
export function approveWhVariance(params: { countTaskId: string; decisions: WhVarianceDecision[] }, client?: unknown) {
  return whRpc(
    "rpc_wh_approve_variance",
    { p_count_task_id: params.countTaskId, p_decisions: params.decisions as unknown as Json },
    "Couldn't approve the count",
    client,
  );
}

export function useWhApproveVariance() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params: { countTaskId: string; decisions: WhVarianceDecision[] }) => approveWhVariance(params),
    onSettled: () => {
      // An approval moves bins and may post wh_count_adjust / wh_write_off ledger rows.
      for (const queryKey of [...COUNT_WRITE_ROOTS, ["wh-containers"], ["wh-reconcile"], ["inventory"], ["inventory-transactions"]]) {
        void qc.invalidateQueries({ queryKey });
      }
    },
  });
}

/** Open the day's scheduled counts by ABC cadence (admin). Exported for tests. */
export function scheduleWhCounts(client?: unknown) {
  return whRpc("rpc_wh_schedule_counts", {}, "Couldn't run the count scheduler", client);
}

export function useWhScheduleCounts() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => scheduleWhCounts(),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["wh-counts"] });
      void qc.invalidateQueries({ queryKey: ["wh-overview"] });
    },
  });
}

/**
 * Run the physical reconciliation now (admin). `createCounts: false` is the
 * dry read: it still records a run (and, once live, sweeps settlements), but
 * opens no count tasks. Exported for tests.
 */
export function runWhReconcile(params: { createCounts: boolean }, client?: unknown) {
  return whRpc("rpc_wh_reconcile_physical", { p_create_counts: params.createCounts }, "Couldn't run the reconcile", client);
}

export function useWhRunReconcile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params: { createCounts: boolean }) => runWhReconcile(params),
    onSettled: () => {
      for (const queryKey of [["wh-reconcile"], ["wh-overview"], ["wh-counts"], ["wh-locations"], ["wh-location"]]) {
        void qc.invalidateQueries({ queryKey });
      }
    },
  });
}

// ---- Printers ---------------------------------------------------------------------------

/** rpc_wh_save_printer said `stale`: someone saved the printer since it was loaded. `printer` is the current row. */
export class WhPrinterStaleError extends Error {
  printer: WhPrinterRecord | null;

  constructor(message: string, printer: WhPrinterRecord | null) {
    super(message);
    this.name = "WhPrinterStaleError";
    this.printer = printer;
  }
}

type RpcClient = { rpc: (fn: string, args?: object) => PromiseLike<{ data: unknown; error: unknown }> };

/** Create or edit a printer (admin). A stale row_version throws WhPrinterStaleError with the current row. Exported for tests. */
export async function saveWhPrinter(input: WhPrinterInput, client: unknown = supabase): Promise<WhRpcResult<"rpc_wh_save_printer">> {
  const { data, error } = await (client as RpcClient).rpc("rpc_wh_save_printer", { p_printer: input });
  if (error) throw error;
  const env = data as ({ ok?: boolean; error?: string; message?: string; printer?: WhPrinterRecord } & Record<string, unknown>) | null;
  if (!env?.ok) {
    const message = env?.message ?? env?.error ?? "Couldn't save the printer";
    if (env?.error === "stale") throw new WhPrinterStaleError(message, env.printer ?? null);
    throw new Error(message);
  }
  return env as unknown as WhRpcResult<"rpc_wh_save_printer">;
}

/** Deactivate a printer (admin); refused while it has queued or printing jobs. Exported for tests. */
export function deleteWhPrinter(id: string, client?: unknown) {
  return whRpc("rpc_wh_delete_printer", { p_id: id }, "Couldn't remove the printer", client);
}

const PRINTER_ROOTS = [["wh-printers"], ["wh-printer-queues"], ["wh-overview"], ["wh-station"]];

export function useWhSavePrinter() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: WhPrinterInput) => saveWhPrinter(input),
    onSettled: () => {
      for (const queryKey of PRINTER_ROOTS) void qc.invalidateQueries({ queryKey });
    },
  });
}

export function useWhDeletePrinter() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteWhPrinter(id),
    onSettled: () => {
      for (const queryKey of PRINTER_ROOTS) void qc.invalidateQueries({ queryKey });
    },
  });
}

/** The printer dialog's fields. */
export interface WhPrinterForm {
  id: string | null;
  rowVersion: number | null;
  code: string;
  name: string;
  transport: "agent" | "browser";
  address: string;
  labelStock: WhLabelStock;
  dpi: 203 | 300 | 600;
  stationLocationId: string | null;
  agentId: string;
  active: boolean;
}

export const EMPTY_PRINTER_FORM: WhPrinterForm = {
  id: null,
  rowVersion: null,
  code: "",
  name: "",
  transport: "agent",
  address: "tcp://",
  labelStock: "white_4x2",
  dpi: 203,
  stationLocationId: null,
  agentId: "",
  active: true,
};

/** The form for an existing printer. Pure; exported for tests. */
export function printerFormFrom(p: WhPrinterRecord): WhPrinterForm {
  return {
    id: p.id,
    rowVersion: p.row_version,
    code: p.code,
    name: p.name,
    transport: p.transport === "browser" ? "browser" : "agent",
    address: p.address ?? "",
    labelStock: (["white_4x2", "green_4x2", "white_3x1"].includes(p.label_stock) ? p.label_stock : "white_4x2") as WhLabelStock,
    dpi: p.dpi === 300 || p.dpi === 600 ? p.dpi : 203,
    stationLocationId: p.station_location_id,
    agentId: p.agent_id ?? "",
    active: p.active,
  };
}

/** Everything wrong with the printer form, as sentences (the server's rules); empty when it can be saved. */
export function printerFormProblems(f: WhPrinterForm): string[] {
  const out: string[] = [];
  if (!/^[A-Z0-9][A-Z0-9_-]{0,39}$/.test(f.code.trim().toUpperCase())) out.push("Code: 1-40 capitals, digits, - or _, like DOCK-1.");
  if (f.name.trim().length > 100) out.push("Name: at most 100 characters.");
  if (f.transport === "agent") {
    const address = printerAddressProblem(f.address);
    if (address) out.push(address);
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(f.agentId.trim())) {
      out.push("Agent id: the AGENT_ID in that PC's print-agent .env, like agent-dock.");
    }
  }
  return out;
}

/** rpc_wh_save_printer payload for the form (browser printers send no address). Pure; exported for tests. */
export function printerPayload(f: WhPrinterForm): WhPrinterInput {
  const code = f.code.trim().toUpperCase();
  const payload: WhPrinterInput = {
    code,
    name: f.name.trim() || code,
    transport: f.transport,
    address: f.transport === "agent" ? f.address.trim() : null,
    label_stock: f.labelStock,
    dpi: f.dpi,
    station_location_id: f.stationLocationId,
    agent_id: f.agentId.trim() || null,
    active: f.active,
  };
  if (f.id) {
    payload.id = f.id;
    if (f.rowVersion != null) payload.row_version = f.rowVersion;
  }
  return payload;
}

// ---- Physical layer switch ----------------------------------------------------------------

export interface WhPhysicalLayer {
  enabled: boolean;
  mint_lpns: boolean;
  live_since: string | null;
}

/** The physical_layer setting read defensively; `live` once live_since has passed. Pure; exported for tests. */
export function readPhysicalLayer(value: unknown, now: number = Date.now()): WhPhysicalLayer & { live: boolean } {
  const v = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const since = typeof v.live_since === "string" && v.live_since ? v.live_since : null;
  const at = since ? Date.parse(since) : NaN;
  return {
    enabled: v.enabled === true,
    mint_lpns: v.mint_lpns === true,
    live_since: since,
    live: !Number.isNaN(at) && at <= now,
  };
}

/**
 * Set or clear physical_layer.live_since (admin). rpc_wh_set_setting replaces
 * the whole value, so this reads the current one first and changes only
 * live_since: enabled, mint_lpns and any other key keep their values.
 * Exported for tests.
 */
export async function setWhPhysicalLayerLive(params: { liveSince: string | null }, client?: unknown) {
  const current = await whRpc("rpc_wh_get_settings", {}, "Couldn't load warehouse settings", client);
  const raw = current.settings?.physical_layer;
  const base = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const value = { ...base, live_since: params.liveSince };
  return whRpc("rpc_wh_set_setting", { p_key: "physical_layer", p_value: value as unknown as Json }, "Couldn't change the physical layer", client);
}

export function useWhSetPhysicalLayer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params: { liveSince: string | null }) => setWhPhysicalLayerLive(params),
    onSettled: () => {
      for (const queryKey of [["wh-settings"], ["wh-overview"], ["wh-reconcile"]]) void qc.invalidateQueries({ queryKey });
    },
  });
}

// ---- Count path and the phone's scanned lines (pure) -------------------------------------------

type PathTask = Pick<WhCountTaskRow, "id" | "due_date" | "created_at"> & {
  location: Pick<WhCountLocationRef, "code" | "pick_sequence"> | null;
};

/** The count path (§8): by pick_sequence (unsequenced last), then code. Pure; exported for tests. */
export function orderCountPath<T extends PathTask>(tasks: T[]): T[] {
  return [...tasks].sort((a, b) => {
    const sa = a.location?.pick_sequence ?? Number.MAX_SAFE_INTEGER;
    const sb = b.location?.pick_sequence ?? Number.MAX_SAFE_INTEGER;
    return sa - sb || (a.location?.code ?? "").localeCompare(b.location?.code ?? "") || a.created_at.localeCompare(b.created_at);
  });
}

/** Due today or earlier (or undated), in the ET-agnostic local calendar. Pure; exported for tests. */
export function isCountDue(task: { due_date: string | null }, today: string): boolean {
  return !task.due_date || task.due_date <= today;
}

/** The task after `currentId` in the path that has not been done or skipped, wrapping to the start. */
export function nextCountTask<T extends { id: string }>(path: T[], currentId: string | null, done: ReadonlySet<string>): T | null {
  const open = path.filter((t) => !done.has(t.id) && t.id !== currentId);
  if (open.length === 0) return null;
  const at = currentId ? path.findIndex((t) => t.id === currentId) : -1;
  if (at < 0) return open[0];
  return path.slice(at + 1).find((t) => !done.has(t.id)) ?? open[0];
}

/**
 * §5.7: a white LPN in an RTS zone needs a green label; a green LPN in a RAW
 * zone needs a white one. The server sets the same flag on the line.
 */
export function labelColourFlag(labelStock: string | null | undefined, zone: string | null | undefined): WhLabelFlag | null {
  if (labelStock === "white" && zone === "RTS") return "needs_green";
  if (labelStock === "green" && zone === "RAW") return "needs_white";
  return null;
}

/** One thing the counter has scanned at this location. */
export interface WhCountEntry {
  /** container id (plus ":" sku id in a mixed carton), or "sku:" + sku id for loose units. */
  key: string;
  skuId: string;
  sku: string;
  productName: string | null;
  containerId: string | null;
  containerCode: string | null;
  containerState: "sealed" | "open" | null;
  qty: number;
  scanValue: string | null;
  labelFlag: WhLabelFlag | null;
  /** An open carton waiting for its units on the stepper. */
  needsUnits: boolean;
}

export function looseKey(skuId: string): string {
  return `sku:${skuId}`;
}

export function cartonKey(containerId: string, skuId: string, mixed: boolean): string {
  return mixed ? `${containerId}:${skuId}` : containerId;
}

/** One more loose unit of a SKU (a product barcode scan): +1 on its line, or a new line at 1. Newest line first. */
export function addLooseUnit(
  entries: WhCountEntry[],
  unit: { skuId: string; sku: string; productName: string | null; scanValue: string | null },
): WhCountEntry[] {
  const key = looseKey(unit.skuId);
  const existing = entries.find((e) => e.key === key);
  if (existing) return [{ ...existing, qty: existing.qty + 1 }, ...entries.filter((e) => e.key !== key)];
  return [
    {
      key,
      skuId: unit.skuId,
      sku: unit.sku,
      productName: unit.productName,
      containerId: null,
      containerCode: null,
      containerState: null,
      qty: 1,
      scanValue: unit.scanValue,
      labelFlag: null,
      needsUnits: false,
    },
    ...entries,
  ];
}

/**
 * A carton scan: new lines go first; a carton already scanned is not counted
 * twice (`duplicate`), it just moves to the top.
 */
export function addCartonEntries(entries: WhCountEntry[], add: WhCountEntry[]): { entries: WhCountEntry[]; duplicate: boolean } {
  const keys = new Set(add.map((e) => e.key));
  const already = entries.filter((e) => keys.has(e.key));
  if (already.length > 0) return { entries: [...already, ...entries.filter((e) => !keys.has(e.key))], duplicate: true };
  return { entries: [...add, ...entries], duplicate: false };
}

/** Set one line's units (the stepper); it no longer needs units. */
export function setEntryQty(entries: WhCountEntry[], key: string, qty: number): WhCountEntry[] {
  const safe = Math.max(0, Math.min(9_999_999, Math.round(Number.isFinite(qty) ? qty : 0)));
  return entries.map((e) => (e.key === key ? { ...e, qty: safe, needsUnits: false } : e));
}

export function removeEntry(entries: WhCountEntry[], key: string): WhCountEntry[] {
  return entries.filter((e) => e.key !== key);
}

/**
 * The p_lines rpc_wh_record_count takes. Loose lines at zero are dropped
 * (unscanned is zero anyway); a carton at zero stays, since "this carton is
 * here and empty" is a finding. Pure; exported for tests.
 */
export function countLinesPayload(entries: WhCountEntry[]): WhCountLineInput[] {
  return entries
    .filter((e) => e.containerId != null || e.qty > 0)
    .map((e) => ({ sku_id: e.skuId, container_id: e.containerId, counted_qty: e.qty, scan_value: e.scanValue }));
}

// ---- Variances: the likely cause (pure) ----------------------------------------------------------

const MOVE_WORDS: Record<string, string> = {
  receive: "received",
  putaway: "put away",
  move: "moved",
  open_container: "carton opened",
  count_adjust: "count adjustment",
  write_off: "written off",
  bucket_convert: "converted at the line",
  mfg_mirror: "manufacturing mirror",
  ledger_mirror: "ledger mirror",
  ship_settle: "ship settlement",
  opening_balance: "opening balance",
  relabel: "relabelled",
  void_receipt: "receipt voided",
};

function shortWhen(iso: string, now: number): string {
  const d = new Date(iso);
  const sameDay = new Date(now).toDateString() === d.toDateString();
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return sameDay ? `today ${time}` : `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })} ${time}`;
}

type CauseTask = Pick<CountTaskRow, "location_id" | "started_at" | "submitted_at" | "moved_during_count">;
type CauseLine = Pick<CountLineRow, "sku_id" | "container_id" | "expected_qty" | "counted_qty" | "found_container_elsewhere"> & {
  variance?: number | null;
  container?: { code: string; location?: { code: string } | null } | null;
};

/**
 * One sentence on why a line differs, from the movements at the location
 * (§8: a settlement that morning, a carton opened without a move). The
 * newest relevant movement wins; with none, the shape of the variance.
 * Pure; `now` in ms; exported for tests.
 */
export function likelyCause(task: CauseTask, line: CauseLine, movements: WhCountMovement[], now: number = Date.now()): string {
  const variance = line.variance ?? line.counted_qty - line.expected_qty;
  if (variance === 0 && !line.found_container_elsewhere) return "Matches";
  if (line.found_container_elsewhere) {
    const at = line.container?.location?.code;
    return `${line.container?.code ?? "Carton"} was booked ${at ? `at ${at}` : "elsewhere"}; found here`;
  }
  const started = task.started_at ? Date.parse(task.started_at) : null;
  const submitted = task.submitted_at ? Date.parse(task.submitted_at) : null;
  const mine = movements.filter((m) => m.sku_id === line.sku_id);
  if (task.moved_during_count && started != null) {
    const during = mine.find((m) => {
      const t = Date.parse(m.created_at);
      return t > started && (submitted == null || t <= submitted);
    });
    if (during) return `Stock moved during the count: ${MOVE_WORDS[during.type] ?? during.type} ${during.qty} at ${shortWhen(during.created_at, now)}`;
    return "Stock moved at this location during the count";
  }
  const before = mine.filter((m) => submitted == null || Date.parse(m.created_at) <= submitted);
  const settle = before.find((m) => m.type === "ship_settle");
  if (settle) return `Ship settlement drew ${settle.qty} here ${shortWhen(settle.created_at, now)}: picked from another bin?`;
  const opened = before.find((m) => m.type === "open_container");
  if (opened) {
    const code = opened.from_container?.code ?? opened.to_container?.code ?? "a carton";
    return `${code} opened ${shortWhen(opened.created_at, now)} without a move`;
  }
  const last = before[0];
  if (last) {
    const dir = last.to_location_id === task.location_id ? "in" : "out";
    return `Last: ${MOVE_WORDS[last.type] ?? last.type} ${last.qty} ${dir}, ${shortWhen(last.created_at, now)}`;
  }
  if (line.expected_qty === 0) return "Not booked here: misplaced from another bin?";
  if (line.counted_qty === 0) return "Nothing found: moved without a scan?";
  return variance > 0 ? "More than booked; no recent movement" : "Fewer than booked; no recent movement";
}

/** Count kinds as words. */
export const COUNT_KIND_WORDS: Record<WhCountKind, string> = {
  scheduled: "Scheduled",
  pick_triggered: "Pick found 0",
  reconcile: "Reconcile",
  variance_recount: "Recount",
  ad_hoc: "Ad hoc",
};

/** The bucket word on a count line. */
export const BUCKET_WORDS: Record<WhBucket, string> = {
  raw: "raw",
  prefilled_raw: "pre-filled",
  in_production: "in production",
  finished: "finished",
  other: "other",
};
