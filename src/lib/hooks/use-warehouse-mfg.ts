import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useLiveInvalidate } from "@/lib/realtime";
import type { RtsCartonEntry } from "@/lib/warehouse/rts-cartons";
import type {
  WhBucket,
  WhContainerState,
  WhLocationRef,
  WhPrintJobResult,
  WhRpcArgs,
  WhRpcName,
  WhRpcResult,
  WhSuggestion,
} from "./use-warehouse";
import { newClientEventId } from "./use-warehouse-tasks";

/**
 * Cartons through manufacturing (design §5.7) and the Floor Move tile
 * (§9.1 /go/move): take a carton to the line, relabel RTS output into green
 * cartons, move cartons and loose units, and the cartons waiting at the line.
 *
 * Mutations unwrap the { ok, error, message } envelope and throw a WhMfgError
 * that keeps the machine code and the envelope's extra fields, because the
 * screens branch on them: `already_at_line` is accepted silently at the
 * Workspace, `insufficient_at_line` carries { available, needed } for the
 * gap. Every write sends a client_event_id (§5.1), so a retry after a lost
 * response replays the first result instead of moving stock twice.
 *
 * Opening a carton reuses the existing rpc_wh_open_container hook from
 * use-warehouse-tasks (re-exported below, the same binding).
 */

export { openWhContainer, useWhOpenContainer, type WhOpenContainerParams } from "./use-warehouse-tasks";

/** An ok:false envelope: the human message, the machine code and every other field the RPC returned. */
export class WhMfgError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(message: string, code: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "WhMfgError";
    this.code = code;
    this.details = details;
  }
}

/** The envelope's error code, or null for transport errors and anything else. */
export function whErrorCode(err: unknown): string | null {
  return err instanceof WhMfgError ? err.code : null;
}

type RpcClient = { rpc: (fn: string, args?: object) => PromiseLike<{ data: unknown; error: unknown }> };

/**
 * Call a warehouse RPC and unwrap its envelope, keeping the error code
 * (whRpc throws the message alone). Transport errors are rethrown untouched.
 * Exported for tests.
 */
export async function mfgRpc<K extends WhRpcName>(
  name: K,
  args: WhRpcArgs<K>,
  fallbackError: string,
  client: unknown = supabase,
): Promise<WhRpcResult<K>> {
  const { data, error } = await (client as RpcClient).rpc(name, args);
  if (error) throw error;
  const env = data as ({ ok?: boolean; error?: string; message?: string } & Record<string, unknown>) | null;
  if (!env?.ok) {
    const details: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(env ?? {})) {
      if (k !== "ok" && k !== "error" && k !== "message") details[k] = v;
    }
    throw new WhMfgError(env?.message ?? env?.error ?? fallbackError, env?.error ?? "unknown", details);
  }
  return env as unknown as WhRpcResult<K>;
}

// ---- Take to the line (step 1) ----------------------------------------------------

export interface WhTakeToLineParams {
  containerId: string;
  clientEventId?: string;
}

export type WhTakeToLineResult = WhRpcResult<"rpc_wh_take_to_line">;

/** One scan: every balance of the carton moves to MFG-LINE (rpc_wh_take_to_line). Exported for tests. */
export function takeWhToLine(params: WhTakeToLineParams, client?: unknown): Promise<WhTakeToLineResult> {
  return mfgRpc(
    "rpc_wh_take_to_line",
    { p_container_id: params.containerId, p_client_event_id: params.clientEventId ?? newClientEventId() },
    "Couldn't take the carton to the line",
    client,
  );
}

/** The carton was already at MFG-LINE: the Workspace accepts it silently. */
export function isAlreadyAtLine(err: unknown): boolean {
  return whErrorCode(err) === "already_at_line";
}

// ---- RTS relabel (step 5) ------------------------------------------------------------

export interface WhRtsRelabelParams {
  skuId: string;
  cartons: RtsCartonEntry[];
  /** The white carton the batch came from; null for "No label". */
  parentContainerId?: string | null;
  /** The RTS task log that credited the finished units at the line. */
  taskLogId?: string | null;
  clientEventId?: string;
}

export interface WhRtsChild {
  id: string;
  code: string;
  qty: number;
  state: "sealed" | "open";
  suggested: WhSuggestion | null;
  move_id: string;
}

/** The loose remainder: moved to the SKU's pick face, or left at the line with a loose putaway task. */
export type WhRtsRemainder =
  | { qty: number; left_at_line: false; to: WhLocationRef | null; container: { id: string; code: string } | null }
  | { qty: number; left_at_line: true; move_id: string; suggested: WhSuggestion | null };

/** What the Workspace shows after a relabel; `dormant` before physical_layer.live_since. */
export interface WhRtsRelabelResult {
  dormant: boolean;
  duplicate: boolean;
  containers: WhRtsChild[];
  parent: { id: string; code: string; state: WhContainerState } | null;
  remainder: WhRtsRemainder | null;
  printJobId: string | null;
  print: Omit<WhPrintJobResult, "payload"> | null;
  putawayTasks: string[];
}

/** The gap of an insufficient_at_line refusal: what the line holds and what the cartons need. */
export function relabelShortfall(err: unknown): { available: number; needed: number; short: number } | null {
  if (whErrorCode(err) !== "insufficient_at_line") return null;
  const d = (err as WhMfgError).details;
  const available = Number(d.available);
  const needed = Number(d.needed);
  if (!Number.isFinite(available) || !Number.isFinite(needed)) return null;
  return { available, needed, short: Math.max(0, needed - available) };
}

/**
 * Green child cartons for an RTS batch (rpc_wh_rts_relabel). Call it after
 * the RTS task log has landed: the mirror credits loose finished units at
 * MFG-LINE and the relabel boxes them. Exported for tests.
 */
export async function rtsRelabelWh(params: WhRtsRelabelParams, client?: unknown): Promise<WhRtsRelabelResult> {
  const res = await mfgRpc(
    "rpc_wh_rts_relabel",
    {
      p_sku_id: params.skuId,
      p_cartons: params.cartons,
      p_parent_container_id: params.parentContainerId ?? null,
      p_task_log_id: params.taskLogId ?? null,
      p_client_event_id: params.clientEventId ?? newClientEventId(),
    },
    "Couldn't print the carton labels",
    client,
  );
  const parent = res.parent ?? null;
  return {
    dormant: res.dormant === true,
    duplicate: res.duplicate === true,
    containers: (res.containers ?? []).map((c) => ({ ...c, suggested: c.suggested ?? null })),
    parent: parent ? { id: parent.id, code: parent.code, state: parent.state } : null,
    remainder: (res.remainder ?? null) as WhRtsRemainder | null,
    printJobId: res.print_job_id ?? null,
    print: res.print ?? null,
    putawayTasks: res.putaway_tasks ?? [],
  };
}

// ---- Moves (Floor Move) ----------------------------------------------------------------

export interface WhMoveStockParams {
  skuId: string;
  qty: number;
  fromLocationId: string;
  toLocationId: string;
  fromContainerId?: string | null;
  toContainerId?: string | null;
  /** May be left out when the source holds one bucket of the SKU. */
  bucket?: WhBucket | null;
  moveId?: string | null;
  clientEventId?: string;
}

export type WhMoveStockResult = WhRpcResult<"rpc_wh_move_stock">;

/** Loose or part-carton units from one place to another (rpc_wh_move_stock). Exported for tests. */
export function moveWhStock(params: WhMoveStockParams, client?: unknown): Promise<WhMoveStockResult> {
  return mfgRpc(
    "rpc_wh_move_stock",
    {
      p_sku_id: params.skuId,
      p_qty: params.qty,
      p_from_location_id: params.fromLocationId,
      p_to_location_id: params.toLocationId,
      p_from_container_id: params.fromContainerId ?? null,
      p_to_container_id: params.toContainerId ?? null,
      p_bucket: params.bucket ?? null,
      p_move_id: params.moveId ?? null,
      p_client_event_id: params.clientEventId ?? newClientEventId(),
    },
    "Couldn't move the units",
    client,
  );
}

export interface WhPutawayContainerMoveParams {
  containerId: string;
  locationId: string;
  /** The carton's open putaway task; the RPC finds it when left out. */
  moveId?: string | null;
  clientEventId?: string;
}

export type WhPutawayContainerMoveResult = WhRpcResult<"rpc_wh_putaway_container">;

/** A whole carton to a scanned bay (rpc_wh_putaway_container); closes its open putaway task. Exported for tests. */
export function putawayWhContainerMove(
  params: WhPutawayContainerMoveParams,
  client?: unknown,
): Promise<WhPutawayContainerMoveResult> {
  return mfgRpc(
    "rpc_wh_putaway_container",
    {
      p_container_id: params.containerId,
      p_location_id: params.locationId,
      p_move_id: params.moveId ?? null,
      p_client_event_id: params.clientEventId ?? newClientEventId(),
    },
    "Couldn't move the carton",
    client,
  );
}

// ---- Mutation hooks --------------------------------------------------------------------

/** Query roots every carton or stock write refreshes (the line cartons live under wh-containers). */
export const MFG_INVALIDATE_ROOTS: string[][] = [
  ["wh-containers"],
  ["wh-putaway"],
  ["wh-locations"],
  ["wh-location"],
  ["wh-overview"],
  ["wh-container-contents"],
  ["wh-balances"],
];

function useMfgMutation<P, R>(mutationFn: (params: P) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn,
    onSettled: () => {
      for (const queryKey of MFG_INVALIDATE_ROOTS) void qc.invalidateQueries({ queryKey });
    },
  });
}

export function useWhTakeToLine() {
  return useMfgMutation((params: WhTakeToLineParams) => takeWhToLine(params));
}

export function useWhRtsRelabel() {
  return useMfgMutation((params: WhRtsRelabelParams) => rtsRelabelWh(params));
}

export function useWhMoveStock() {
  return useMfgMutation((params: WhMoveStockParams) => moveWhStock(params));
}

export function useWhPutawayContainerMove() {
  return useMfgMutation((params: WhPutawayContainerMoveParams) => putawayWhContainerMove(params));
}

// ---- Cartons at the line -----------------------------------------------------------------

/** One carton at MFG-LINE with its open putaway task, if any. */
export interface WhLineCarton {
  id: string;
  code: string;
  sku_id: string | null;
  sku: { sku: string; product_name: string } | null;
  qty: number;
  state: WhContainerState;
  label_stock: "white" | "green";
  finished_by: string | null;
  finished_at: string | null;
  created_at: string;
  parent_container_id: string | null;
  putaway: { id: string; origin: string; created_by: string | null; created_at: string; suggested_code: string | null } | null;
}

export interface WhLineCartons {
  /** Green cartons relabelled at RTS and waiting for a bay: the worker's own first, then oldest first. */
  waiting: WhLineCarton[];
  /** White (raw) cartons pulled to the line, by code. */
  raw: WhLineCarton[];
}

/** The row PostgREST returns for the line query. */
export interface WhLineCartonRow extends Omit<WhLineCarton, "putaway"> {
  moves:
    | {
        id: string;
        kind: string;
        status: string;
        origin: string;
        created_by: string | null;
        created_at: string;
        suggested: { code: string } | null;
      }[]
    | null;
}

function mine(c: WhLineCarton, me: string | null): boolean {
  return !!me && (c.putaway?.created_by === me || c.finished_by === me);
}

/**
 * Split the cartons at the line: green ones with an open putaway task wait for
 * a bay (the worker's own first, oldest first); white ones are raw cartons
 * pulled to the line. Pure; exported for tests.
 */
export function splitLineCartons(rows: WhLineCartonRow[], me: string | null): WhLineCartons {
  const cartons: WhLineCarton[] = rows.map(({ moves, ...c }) => {
    const open = (moves ?? [])
      .filter((m) => m.kind === "putaway" && (m.status === "open" || m.status === "in_progress"))
      .sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
    return {
      ...c,
      putaway: open
        ? { id: open.id, origin: open.origin, created_by: open.created_by, created_at: open.created_at, suggested_code: open.suggested?.code ?? null }
        : null,
    };
  });
  const since = (c: WhLineCarton) => c.finished_at ?? c.putaway?.created_at ?? c.created_at;
  const waiting = cartons
    .filter((c) => c.label_stock === "green" && c.putaway)
    .sort(
      (a, b) =>
        Number(mine(b, me)) - Number(mine(a, me)) || since(a).localeCompare(since(b)) || a.code.localeCompare(b.code),
    );
  const raw = cartons.filter((c) => c.label_stock !== "green").sort((a, b) => a.code.localeCompare(b.code));
  return { waiting, raw };
}

const LINE_SELECT =
  "id, code, sku_id, qty, state, label_stock, finished_by, finished_at, created_at, parent_container_id, " +
  "sku:product_skus(sku, product_name), at:wh_locations!inner(code), " +
  "moves:wh_moves(id, kind, status, origin, created_by, created_at, suggested:wh_locations!wh_moves_suggested_location_id_fkey(code))";

/** Read the cartons at MFG-LINE (live states) with their putaway tasks. Exported for tests. */
export async function fetchWhLineCartons(client: unknown = supabase): Promise<WhLineCartonRow[]> {
  const { data, error } = await (client as typeof supabase)
    .from("wh_containers")
    .select(LINE_SELECT)
    .eq("at.code", "MFG-LINE")
    .in("state", ["sealed", "open"])
    .eq("moves.kind", "putaway")
    .in("moves.status", ["open", "in_progress"])
    .order("code")
    .limit(500);
  if (error) throw error;
  return ((data ?? []) as unknown as (WhLineCartonRow & { at?: unknown })[]).map(({ at: _at, ...row }) => {
    void _at;
    return row;
  });
}

/**
 * Cartons at MFG-LINE, split into green ones waiting for a bay and raw ones
 * pulled to the line. Live through Realtime on wh_containers and wh_moves
 * plus a 60 s refetch (a change invalidates the whole wh-containers root, so
 * the RTS step's "placed" status follows too). The key sits under
 * wh-containers so every carton write refreshes it.
 */
export function useWhLineCartons(me: string | null, options: { enabled?: boolean } = {}) {
  const enabled = options.enabled ?? true;
  useLiveInvalidate("wh-line-cartons", enabled ? ["wh_containers", "wh_moves"] : [], [["wh-containers"]]);
  return useQuery({
    queryKey: ["wh-containers", "mfg-line", me],
    enabled,
    queryFn: async (): Promise<WhLineCartons> => splitLineCartons(await fetchWhLineCartons(), me),
    refetchInterval: enabled ? 60_000 : false,
    staleTime: 15 * 1000,
  });
}

// ---- Where cartons are now, and loose stock of a SKU --------------------------------------

export interface WhCartonWhereabouts {
  id: string;
  code: string;
  state: WhContainerState;
  qty: number;
  location: { code: string } | null;
}

/** Where some cartons are now (the RTS step's "placed" status). */
export function useWhCartonsWhere(ids: string[]) {
  const key = [...ids].sort();
  return useQuery({
    queryKey: ["wh-containers", "where", key],
    enabled: key.length > 0,
    queryFn: async (): Promise<WhCartonWhereabouts[]> => {
      const { data, error } = await supabase
        .from("wh_containers")
        .select("id, code, state, qty, location:wh_locations(code)")
        .in("id", key);
      if (error) throw error;
      return (data ?? []) as unknown as WhCartonWhereabouts[];
    },
    staleTime: 10 * 1000,
  });
}

export interface WhLooseBalance {
  id: string;
  sku_id: string;
  bucket: WhBucket;
  on_hand: number;
  location_id: string;
  location: { id: string; code: string; kind: string; zone: string; active: boolean; pickable: boolean } | null;
}

/** Loose (no carton) units of a SKU by location and bucket, for the Move tile's source list. */
export function useWhLooseBalances(skuId: string | null | undefined) {
  return useQuery({
    queryKey: ["wh-balances", skuId, "loose"],
    enabled: !!skuId,
    queryFn: async (): Promise<WhLooseBalance[]> => {
      const { data, error } = await supabase
        .from("wh_inventory_balances")
        .select("id, sku_id, bucket, on_hand, location_id, location:wh_locations(id, code, kind, zone, active, pickable)")
        .eq("sku_id", skuId as string)
        .is("container_id", null)
        .gt("on_hand", 0)
        .limit(200);
      if (error) throw error;
      return ((data ?? []) as unknown as WhLooseBalance[])
        .filter((b) => b.location && b.location.kind !== "virtual")
        .sort((a, b) => (a.location?.code ?? "").localeCompare(b.location?.code ?? "") || a.bucket.localeCompare(b.bucket));
    },
    staleTime: 15 * 1000,
  });
}
