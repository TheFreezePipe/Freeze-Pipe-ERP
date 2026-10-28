import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { APP_ENV } from "@/lib/env";
import type { Database, Json } from "@/lib/database.types";
import { effectiveOutboundMode, type OutboundMode } from "@/lib/warehouse/outbound";
import { baselineWindow } from "@/lib/warehouse/baseline";

/**
 * Warehouse module, Phase 0 hooks. Every call is a SECURITY DEFINER RPC
 * returning the { ok, error?, ... } envelope; ok=false throws the server's
 * human-readable error, which the UI shows verbatim.
 */

// ---- RPC contracts ----------------------------------------------------------
// database.types.ts is regenerated after the warehouse migrations land. Until
// then these RPCs are typed here and the single cast lives in whRpc().

export interface WhSettings {
  outbound?: { mode?: OutboundMode };
  [key: string]: unknown;
}

export interface WhScanMatch {
  sku_id: string;
  sku: string;
  product_name: string;
  /** Matched barcode; null when the scan matched a SKU code directly. */
  code: string | null;
  symbology: string | null;
  display_category?: string | null;
  is_active?: boolean;
}

/**
 * Server's reading of a scan. Phase 0 kinds: "gtin" (barcode shape) and
 * "sku". Phase 1 adds ERP labels: "location", "station", "container", a
 * "practice" label from staging, a ShipStation packing slip and "unknown".
 */
export type WhScanKind =
  | "gtin"
  | "sku"
  | "location"
  | "station"
  | "container"
  | "practice"
  | "shipstation_order"
  | "unknown";

export interface WhResolveScanResult {
  kind?: WhScanKind | string;
  /** A SKU match for gtin/sku scans; the location, carton or order otherwise. */
  match: WhScanMatch | null;
  candidates: string[];
  id?: string | null;
  code?: string | null;
  label?: string | null;
  message?: string;
  /** A voided white carton resolved to its green child (scanned_code is the old one). */
  superseded?: boolean;
  scanned_code?: string;
  practice?: boolean;
}

// ---- Phase 1 contracts --------------------------------------------------------

export type WhBucket = "raw" | "prefilled_raw" | "in_production" | "finished" | "other";
export type WhContainerState = "sealed" | "open" | "empty" | "void";
export type WhLabelKind = "lpn" | "lpn_rts" | "location" | "station";
export type WhRequestedFrom = "dock" | "phone" | "desktop" | "workspace";
export type WhSuggestionReason =
  | "same_sku_reserve"
  | "same_sku_face"
  | "nearest_empty"
  | "other_zone_empty"
  | "breakdown_shelf"
  | "none";

export interface WhLocationRef {
  id: string;
  code: string;
  name: string | null;
  kind: string;
  zone: string;
  pickable: boolean;
  is_overflow: boolean;
  active: boolean;
}

export interface WhContainerRef {
  id: string;
  code: string;
  sku_id: string | null;
  sku: string | null;
  product_name: string | null;
  qty: number;
  qty_initial: number;
  state: WhContainerState;
  label_stock: "white" | "green";
  location_id: string | null;
  location_code: string | null;
  parent_container_id: string | null;
  superseded_by: string | null;
  finished_by: string | null;
  finished_at: string | null;
}

export interface WhSuggestion {
  location_id: string | null;
  code: string | null;
  reason: WhSuggestionReason;
}

export interface WhStationSessionRef {
  id: string;
  station_location_id: string;
  code: string;
  name: string | null;
  started_at: string;
  device_id: string | null;
}

export interface WhPrinterRef {
  id: string;
  code: string;
  name: string;
  label_stock?: string;
  transport?: string;
  last_seen_at?: string | null;
}

export interface WhPrintJobResult {
  job_id: string;
  status: "queued" | "blocked";
  /** Where it prints: the station's agent printer, this browser, or nowhere (outbound blocked). */
  target: "printer" | "browser" | "none";
  /** "requested": the caller passed p_target 'browser'. */
  routed_by: "named" | "station" | "no_matching_printer" | "no_station" | "practice" | "requested";
  printer: { id: string; code: string; name: string } | null;
  station_location_id: string | null;
  message: string | null;
  payload?: Json;
}

/** rpc_wh_request_labels p_target: 'browser' forces the browser path; 'station' (or null) routes as usual. */
export type WhPrintTarget = "browser" | "station";

/** One nightly reconciliation (design §6); also what rpc_wh_reconcile_physical returns. */
export interface WhReconcileResult {
  run_id: string;
  run_at: string;
  /** physical_layer.live_since has passed; before that no counts and no settlement sweep. */
  live: boolean;
  skus_checked: number;
  /** SKUs with a non-zero residual in any bucket. */
  mismatched_skus: number;
  /** Σ|R| over every (SKU, bucket). */
  abs_residual_units: number;
  /** Σ|on_hand| at UNLOCATED. */
  unlocated_units: number;
  /** Green cartons still at MFG-LINE more than two hours after their relabel. */
  rts_unplaced_cartons: number;
  /** wh_reconcile_lines written (non-zero R, H or S). */
  lines: number;
  counts_enabled: boolean;
  counts_created: number;
  sweep: { orders: number; units: number; shortfall: number; errors: number };
  pruned_balances: number;
}

export interface WhScheduleCountsResult {
  created: number;
  count_task_ids: string[];
  /** Locations past their ABC cadence, including those already open. */
  due: number;
  already_open: number;
  /** Due locations the daily cap pushed to a later day. */
  left_for_later: number;
  daily_cap: number;
  scheduled_today: number;
}

// ---- Next carton (FIFO) and the carton passport (§5.8) ------------------------

/** rpc_wh_take_to_line p_fifo_override: why the worker took another carton than the suggested one. */
export type WhFifoOverride = "buried" | "damaged" | "closer" | "other";

/** Which rule picked the next carton: an open carton, the oldest factory order, or (no batch known) the oldest check-in. */
export type WhNextCartonReason = "open_carton" | "oldest_batch" | "oldest_received";

/**
 * The carton FIFO suggests pulling next for a SKU (rpc_wh_next_cartons, and
 * `suggested` on a fifo_suggests refusal). qty and bucket are its raw /
 * pre-filled units. Batch fields are null when the carton's group has no
 * resolved factory order item (opening stock, ambiguous shipments).
 */
export interface WhNextCarton {
  container_id: string;
  code: string;
  state: "sealed" | "open";
  qty: number;
  bucket: "raw" | "prefilled_raw";
  /** The server only suggests located cartons; nullable per the contract ("null where unknown"). */
  location_id: string | null;
  location_code: string | null;
  factory_order_id: string | null;
  factory_order_number: string | null;
  /** YYYY-MM-DD */
  order_date: string | null;
  shipment_id: string | null;
  shipment_number: string | null;
  /** The carton's check-in (its receipt, else when the carton was created); the server always fills it. */
  received_at: string | null;
  reason: WhNextCartonReason;
}

/** rpc_wh_take_to_line's refusal when FIFO suggests another carton: { ok: false, error: 'fifo_suggests', message, suggested, scanned }. Nothing moved. */
export interface WhFifoSuggestsPayload {
  suggested: WhNextCarton;
  scanned: {
    code: string;
    factory_order_number: string | null;
    order_date: string | null;
    received_at: string | null;
    location_code: string | null;
  };
}

/** The `fifo` key of a successful take to the line. followed: no suggestion, or the scanned carton was it. */
export interface WhTakeToLineFifo {
  followed: boolean;
  /** The suggested carton's code (the scanned one when followed); null when FIFO had nothing to suggest. */
  suggested_code: string | null;
  /** The reason recorded as a deviation; null when followed. */
  override: WhFifoOverride | null;
}

export interface WhFifoCompliance {
  days: number;
  since: string;
  /** Take-to-line pulls of single-SKU raw cartons in the window. */
  pulls: number;
  followed: number;
  deviations: Record<WhFifoOverride, number>;
}

/** Short machine word for the timeline icon. */
export type WhPassportTimelineKind =
  | "ordered"
  | "factory"
  | "shipped"
  | "delivered"
  | "checked_in"
  | "putaway"
  | "pulled"
  | "moved"
  | "opened"
  | "relabel"
  | "count"
  | "labels"
  | "other";

export interface WhPassportTimelineEntry {
  at: string;
  kind: WhPassportTimelineKind;
  title: string;
  detail: string | null;
  actor_name: string | null;
}

/** rpc_wh_carton_passport: one carton's whole life (oldest timeline entry first). */
export interface WhCartonPassport {
  carton: {
    id: string;
    code: string;
    sku_id: string | null;
    sku: string | null;
    product_name: string | null;
    state: WhContainerState;
    qty: number;
    qty_initial: number;
    /** The bucket it holds most of, else the bucket of its last movement. */
    bucket: WhBucket | null;
    label_stock: "white" | "green";
    location_id: string | null;
    location_code: string | null;
    created_at: string;
    opened_at: string | null;
    finished_at: string | null;
    finished_by_name: string | null;
    parent: { id: string; code: string; state: WhContainerState } | null;
    children: { id: string; code: string; state: WhContainerState; qty: number; location_code: string | null }[];
    superseded_by: { id: string; code: string } | null;
    carton_seq: number | null;
    /** The shipment's planned carton count ("carton n of N"); null without a shipment. */
    carton_of: number | null;
  };
  batch: {
    factory_order: {
      id: string;
      order_number: string | null;
      supplier_name: string | null;
      order_date: string | null;
      expected_completion: string | null;
      status: string;
    } | null;
    item: {
      quantity_ordered: number;
      quantity_finished: number | null;
      consolidator_confirmed_quantity: number | null;
      quantity_breakage: number;
    } | null;
    shipment: {
      id: string;
      shipment_number: string;
      ship_date: string | null;
      eta: string | null;
      actual_arrival_date: string | null;
      status: string;
    } | null;
    /** Carton counts across the batch, plus broken units (the item's breakage). */
    summary: {
      cartons_received: number;
      cartons_short: number;
      finished: number;
      raw_on_shelf: number;
      at_the_line: number;
      broken_units: number;
    };
    /** Other cartons of the same factory order item (else the same group), newest first, at most 50. */
    siblings: { id: string; code: string; state: WhContainerState; qty: number; location_code: string | null; since: string }[];
    siblings_total: number;
  };
  timeline: WhPassportTimelineEntry[];
  legs: {
    order_to_finished_days: number | null;
    finished_to_shipped_days: number | null;
    water_days: number | null;
    arrival_to_checkin_days: number | null;
    checkin_to_shelf_minutes: number | null;
    shelf_to_line_days: number | null;
    line_to_rts_days: number | null;
  };
}

export type WhPrinterRecord = Database["public"]["Tables"]["wh_printers"]["Row"];

/**
 * rpc_wh_save_printer payload: found by id, else by code; omitted fields keep
 * their value on an edit. address forms: tcp://host[:port], share://HOST/Share,
 * file://<directory> (agent printers only). row_version guards against a stale edit.
 */
export interface WhPrinterInput {
  id?: string;
  code?: string;
  name?: string;
  transport?: "agent" | "browser";
  address?: string | null;
  label_stock?: "white_4x2" | "green_4x2" | "white_4x6" | "green_4x6" | "white_3x1";
  dpi?: 203 | 300 | 600;
  station_location_id?: string | null;
  station_code?: string | null;
  agent_id?: string | null;
  active?: boolean;
  row_version?: number;
}

/** Phone RPCs replay their first result for a repeated client_event_id. */
interface WhReplayable {
  duplicate?: boolean;
}

interface WhPhoneArgs {
  p_client_event_id?: string | null;
  p_actor_id?: string | null;
}

export interface WhBarcodeCoverage {
  with_code: number;
  active_total: number;
}

export interface WhBaselineDay {
  ship_day: string;
  orders: number;
  lines: number;
  median_days_to_ship: number | null;
  same_day_share: number | null;
}

export interface WhBaselineKpis {
  days: WhBaselineDay[];
  summary: {
    median_orders_per_day: number | null;
    median_days_to_ship: number | null;
    same_day_share: number | null;
  };
}

interface WhEnvelope {
  ok: boolean;
  error?: string;
  message?: string;
}

interface WhRpc {
  rpc_wh_get_settings: { args: Record<string, never>; result: { settings: WhSettings } };
  rpc_wh_set_setting: { args: { p_key: string; p_value: Json }; result: { key: string; value: Json } };
  rpc_wh_resolve_scan: { args: { p_scan: string }; result: WhResolveScanResult };
  rpc_wh_link_barcode: { args: { p_sku_id: string; p_scan: string }; result: { code: string; symbology: string } };
  rpc_wh_barcode_coverage: { args: Record<string, never>; result: WhBarcodeCoverage };
  rpc_wh_baseline_kpis: { args: { p_from: string; p_to: string }; result: WhBaselineKpis };

  // Phase 1: layout (admin)
  rpc_wh_generate_locations: {
    args: { p_rack_id?: string | null; p_dry_run?: boolean };
    result: {
      dry_run: boolean;
      create: string[];
      update: string[];
      conflicts: { code: string; existing_code: string | null; reason: string }[];
      deactivate: string[];
      codes: { code: string; face: string; bay: number; level: number; zone: string; pickable: boolean; is_overflow: boolean; pick_sequence: number }[];
      created?: number;
      updated?: number;
      deactivated?: number;
    };
  };
  rpc_wh_save_layout: { args: { p_payload: Json }; result: Record<string, { created: number; updated: number; deleted?: number }> };
  rpc_wh_save_location: { args: { p_location: Json }; result: { created: boolean; location: Json } };
  rpc_wh_resequence: { args: { p_rows: Json }; result: { updated: number } };

  // Phase 1: stock and tasks
  rpc_wh_suggest_putaway: {
    args: { p_container_id: string; p_exclude?: string[] };
    result: { container: WhContainerRef; suggestion: WhSuggestion; move_id: string | null };
  };
  rpc_wh_putaway_container: {
    args: WhPhoneArgs & { p_container_id: string; p_location_id: string; p_move_id?: string | null };
    result: WhReplayable & {
      container: WhContainerRef;
      from: WhLocationRef | null;
      to: WhLocationRef;
      units: number;
      followed_suggestion: boolean | null;
      move_id: string | null;
      movement_group_id: string;
      next: { move_id: string; container_id: string; code: string; origin: string; suggested: WhLocationRef | null } | null;
      warning?: "over_capacity";
      message?: string;
    };
  };
  rpc_wh_move_stock: {
    args: WhPhoneArgs & {
      p_sku_id: string;
      p_qty: number;
      p_from_location_id: string;
      p_to_location_id: string;
      p_from_container_id?: string | null;
      p_to_container_id?: string | null;
      p_bucket?: WhBucket | null;
      p_move_id?: string | null;
    };
    result: WhReplayable & {
      sku_id: string;
      sku: string;
      qty: number;
      bucket: WhBucket;
      to_bucket: WhBucket;
      from: WhLocationRef;
      to: WhLocationRef;
      available_after: number;
      movement_group_id: string;
    };
  };
  rpc_wh_open_container: {
    args: WhPhoneArgs & { p_container_id: string; p_to_location_id?: string | null; p_unpack?: boolean };
    result: WhReplayable & {
      container: WhContainerRef;
      from: WhLocationRef | null;
      to: WhLocationRef | null;
      units_moved: number;
      unpacked: boolean;
      already_open: boolean;
      warning?: "not_pickable";
      message?: string;
    };
  };
  rpc_wh_take_to_line: {
    /** Without p_fifo_override, a carton other than the FIFO suggestion is refused with fifo_suggests (WhFifoSuggestsPayload). */
    args: WhPhoneArgs & { p_container_id: string; p_fifo_override?: WhFifoOverride | null };
    result: WhReplayable & {
      container: WhContainerRef;
      from: WhLocationRef | null;
      units: number;
      movement_group_id: string;
      fifo: WhTakeToLineFifo;
    };
  };
  rpc_wh_next_cartons: {
    /** Up to 200 SKU ids; every id comes back as a key, null when nothing is suggested. */
    args: { p_sku_ids: string[] };
    result: { next: Record<string, WhNextCarton | null> };
  };
  rpc_wh_fifo_compliance: { args: { p_days?: number }; result: WhFifoCompliance };
  rpc_wh_carton_passport: { args: { p_code: string }; result: WhCartonPassport };
  rpc_wh_rts_relabel: {
    args: WhPhoneArgs & {
      p_sku_id: string;
      p_cartons: Json;
      p_parent_container_id?: string | null;
      p_task_log_id?: string | null;
    };
    result: WhReplayable & {
      dormant?: boolean;
      containers?: { id: string; code: string; qty: number; state: "sealed" | "open"; suggested: WhSuggestion; move_id: string }[];
      parent?: WhContainerRef | null;
      remainder?: Json | null;
      print_job_id?: string | null;
      print?: WhPrintJobResult | null;
      putaway_tasks?: string[];
    };
  };
  rpc_wh_record_count: {
    args: WhPhoneArgs & {
      p_location_id: string;
      p_lines: Json;
      p_count_task_id?: string | null;
      p_started_at?: string | null;
    };
    result: WhReplayable & {
      count_task_id: string;
      status: "submitted" | "approved";
      location: WhLocationRef;
      lines: { id: string; sku_id: string; container_id: string | null; bucket: WhBucket; counted_qty: number; label_flag: string | null }[];
    };
  };
  rpc_wh_approve_variance: {
    args: { p_count_task_id: string; p_decisions?: Json; p_actor_id?: string | null };
    result: { count_task_id: string; lines: number; adjusted_units: number; levels_delta: number; recounts: string[] };
  };
  rpc_wh_create_count: {
    args: { p_location_ids: string[]; p_kind?: string; p_reason?: string | null };
    result: { created: string[]; existing: string[]; missing: string[] };
  };
  rpc_wh_write_off: {
    args: {
      p_sku_id: string;
      p_location_id: string;
      p_container_id: string | null;
      p_qty: number;
      p_reason: string;
      p_client_event_id?: string | null;
    };
    result: WhReplayable & { sku: string; qty: number; bucket: WhBucket; ledger_tx_id: string | null; levels_delta: number };
  };
  rpc_wh_import_stock: {
    args: { p_rows: Json; p_dry_run?: boolean };
    result: {
      dry_run: boolean;
      rows: number;
      cartons: number;
      units: number;
      rejected?: { row: number; error: string; sku?: string; location?: string }[];
      first_code?: string | null;
      last_code?: string | null;
    };
  };
  rpc_wh_overview: {
    args: Record<string, never>;
    result: {
      physical_layer_live: boolean;
      putaways_open: number;
      putaways_over_24h: number;
      rts_unplaced: number;
      counts_due: number;
      variances: number;
      unlocated_units: number;
      mfg_line_units: number;
      mfg_line_negative_units: number;
      cartons: number;
      locations: { racks: number; rack_locations: number; named: number; labels_verified: number };
      print: { queued: number; failed: number; printers: number };
      last_reconcile: Json | null;
    };
  };

  // Phase 1: labels, stations and the print agent
  rpc_wh_request_labels: {
    args: {
      p_kind: WhLabelKind;
      p_ids: string[];
      p_from: WhRequestedFrom;
      p_printer_id?: string | null;
      p_target?: WhPrintTarget | null;
      /** Identical labels per item, 1-5; null lets the server choose (2 for a 4x6 carton label, else 1). */
      p_copies?: number | null;
    };
    result: WhPrintJobResult;
  };
  rpc_wh_save_printer: {
    args: { p_printer: WhPrinterInput };
    result: { created: boolean; printer: WhPrinterRecord };
  };
  rpc_wh_delete_printer: {
    args: { p_id: string };
    result: { printer: WhPrinterRecord; deactivated: true; already_inactive: boolean };
  };

  // Phase 1: nightly reconcile and count scheduling (admin or service)
  rpc_wh_reconcile_physical: { args: { p_create_counts?: boolean }; result: WhReconcileResult };
  rpc_wh_schedule_counts: { args: Record<string, never>; result: WhScheduleCountsResult };
  rpc_wh_mark_printed: {
    args: { p_job_id: string; p_status: "printed" | "failed" | "cancelled"; p_error?: string | null };
    result: { job_id: string; status: string; unchanged?: boolean };
  };
  rpc_wh_start_station: {
    args: { p_scan_value: string; p_device_id?: string | null };
    result: { unchanged: boolean; ended_previous: string | null; session: WhStationSessionRef; printers: WhPrinterRef[] };
  };
  rpc_wh_end_station: { args: Record<string, never>; result: { ended: string | null } };
  rpc_wh_claim_print_jobs: {
    args: { p_printer_ids: string[]; p_agent_id: string };
    result: { jobs: { id: string; kind: WhLabelKind; printer_id: string; payload: Json; item_ids: string[]; attempts: number }[]; released: number };
  };
  rpc_wh_agent_heartbeat: {
    args: { p_agent_id: string; p_printer_ids: string[] };
    result: { printers: number; queued: number; at: string };
  };
}

type UntypedRpcClient = {
  rpc: (fn: string, args?: object) => PromiseLike<{ data: unknown; error: unknown }>;
};

export type WhRpcName = keyof WhRpc;
export type WhRpcArgs<K extends WhRpcName> = WhRpc[K]["args"];
export type WhRpcResult<K extends WhRpcName> = WhRpc[K]["result"];

/**
 * Call a warehouse RPC and unwrap its envelope. Phase 1 envelopes carry a
 * machine `error` code plus a human `message` naming the carton or
 * location, so the message wins; Phase 0 RPCs put the sentence in `error`.
 * Exported for tests.
 */
export async function whRpc<K extends keyof WhRpc>(
  name: K,
  args: WhRpc[K]["args"],
  fallbackError: string,
  client: unknown = supabase,
): Promise<WhRpc[K]["result"]> {
  const { data, error } = await (client as UntypedRpcClient).rpc(name, args);
  if (error) throw error;
  const env = data as (WhEnvelope & WhRpc[K]["result"]) | null;
  if (!env?.ok) throw new Error(env?.message ?? env?.error ?? fallbackError);
  return env;
}

// ---- Settings + outbound guard ---------------------------------------------

export function useWarehouseSettings() {
  return useQuery({
    queryKey: ["wh-settings"],
    queryFn: async (): Promise<WhSettings> => {
      const result = await whRpc("rpc_wh_get_settings", {}, "Couldn't load warehouse settings");
      return result.settings ?? {};
    },
    staleTime: 5 * 60 * 1000,
  });
}

/** Effective outbound mode: never "live" off production; "blocked" until known. */
export function useOutboundMode(): OutboundMode {
  const { data } = useWarehouseSettings();
  return effectiveOutboundMode(data?.outbound?.mode, APP_ENV);
}

export function useSetWarehouseSetting() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (params: { key: string; value: Json }) =>
      whRpc("rpc_wh_set_setting", { p_key: params.key, p_value: params.value }, "Couldn't save the setting"),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["wh-settings"] });
    },
  });
}

// ---- Barcodes ---------------------------------------------------------------

export function useResolveScan() {
  return useMutation({
    mutationFn: async (scan: string): Promise<WhResolveScanResult> => {
      const result = await whRpc("rpc_wh_resolve_scan", { p_scan: scan }, "Couldn't look up that code");
      return { kind: result.kind, match: result.match ?? null, candidates: result.candidates ?? [] };
    },
  });
}

export function useLinkBarcode() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (params: { skuId: string; scan: string }) =>
      whRpc("rpc_wh_link_barcode", { p_sku_id: params.skuId, p_scan: params.scan }, "Couldn't link the barcode"),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["wh-barcode-coverage"] });
      qc.invalidateQueries({ queryKey: ["sku-barcodes"] });
      // product_skus.upc_code carries the primary GTIN for display.
      qc.invalidateQueries({ queryKey: ["products"] });
    },
  });
}

export function useBarcodeCoverage() {
  return useQuery({
    queryKey: ["wh-barcode-coverage"],
    queryFn: async (): Promise<WhBarcodeCoverage> => {
      const result = await whRpc("rpc_wh_barcode_coverage", {}, "Couldn't load barcode coverage");
      return { with_code: result.with_code ?? 0, active_total: result.active_total ?? 0 };
    },
    staleTime: 5 * 60 * 1000,
  });
}

// ---- Baseline KPIs ----------------------------------------------------------

/** Ship-day KPIs over the last `days` complete days (ET), ending yesterday. */
export function useBaselineKpis(days = 14) {
  return useQuery({
    queryKey: ["wh-baseline-kpis", days],
    queryFn: async (): Promise<WhBaselineKpis> => {
      const { from, to } = baselineWindow(days);
      const result = await whRpc("rpc_wh_baseline_kpis", { p_from: from, p_to: to }, "Couldn't load baseline KPIs");
      return {
        days: result.days ?? [],
        summary: result.summary ?? {
          median_orders_per_day: null,
          median_days_to_ship: null,
          same_day_share: null,
        },
      };
    },
    staleTime: 10 * 60 * 1000,
  });
}
