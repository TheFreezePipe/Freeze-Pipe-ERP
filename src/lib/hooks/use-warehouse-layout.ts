import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import type { Database, Json } from "@/lib/database.types";
import type { LayoutPayload, NamedLocationUpdate } from "@/lib/warehouse/workbook-import";
import { whRpc, type WhLabelKind, type WhRequestedFrom, type WhRpcResult } from "./use-warehouse";

/**
 * Warehouse layout (design §9.4): the layout tables, the admin RPCs that
 * write them (rpc_wh_save_layout, rpc_wh_save_location,
 * rpc_wh_generate_locations, rpc_wh_resequence) and the label job pair
 * (rpc_wh_request_labels → print → rpc_wh_mark_printed). Each mutation is a
 * plain function taking an optional client (exported for tests) plus a hook
 * that invalidates the roots it changes.
 */

type Tables = Database["public"]["Tables"];
export type WhRackTemplateRow = Tables["wh_rack_templates"]["Row"];
export type WhRackRow = Tables["wh_racks"]["Row"];
export type WhRackFaceRow = Tables["wh_rack_faces"]["Row"];
export type WhFixtureRow = Tables["wh_fixtures"]["Row"];

export interface WhLayout {
  templates: WhRackTemplateRow[];
  racks: WhRackRow[];
  faces: WhRackFaceRow[];
  fixtures: WhFixtureRow[];
}

/** Templates, racks, faces and fixtures in one read. */
export function useWhLayout() {
  return useQuery({
    queryKey: ["wh-layout"],
    queryFn: async (): Promise<WhLayout> => {
      const [templates, racks, faces, fixtures] = await Promise.all([
        supabase.from("wh_rack_templates").select("*").order("code"),
        supabase.from("wh_racks").select("*").order("code"),
        supabase.from("wh_rack_faces").select("*").order("face_code").order("first_bay_no"),
        supabase.from("wh_fixtures").select("*").order("name"),
      ]);
      for (const r of [templates, racks, faces, fixtures]) if (r.error) throw r.error;
      return {
        templates: templates.data ?? [],
        racks: racks.data ?? [],
        faces: faces.data ?? [],
        fixtures: fixtures.data ?? [],
      };
    },
    staleTime: 5 * 60 * 1000,
  });
}

/** The wh_locations columns the summary view leaves out (concurrency token, footprint). */
export type WhLocationExtra = Pick<
  Tables["wh_locations"]["Row"],
  "id" | "row_version" | "width_mm" | "depth_mm" | "height_mm" | "updated_at"
>;

/** Extra columns for the Locations table, keyed by id; refreshed with the ["wh-locations"] root. */
export function useWhLocationExtras() {
  return useQuery({
    queryKey: ["wh-locations", "extras"],
    queryFn: async (): Promise<Map<string, WhLocationExtra>> => {
      const { data, error } = await supabase
        .from("wh_locations")
        .select("id, row_version, width_mm, depth_mm, height_mm, updated_at");
      if (error) throw error;
      return new Map((data ?? []).map((r) => [r.id, r]));
    },
    staleTime: 60 * 1000,
  });
}

// ---- layout writes (admin) ----------------------------------------------------

export function saveWhLayout(payload: LayoutPayload | Json, client?: unknown) {
  return whRpc("rpc_wh_save_layout", { p_payload: payload as unknown as Json }, "Couldn't save the layout", client);
}

export function useWhSaveLayout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: LayoutPayload | Json) => saveWhLayout(payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["wh-layout"] });
      qc.invalidateQueries({ queryKey: ["wh-overview"] });
    },
  });
}

/** A named location's fields, or a bay-level's editable ones (capacity, active, geometry, label stamps). */
export type WhLocationPatch = ({ id: string } | { code: string }) & {
  row_version?: number;
  name?: string | null;
  kind?: "floor" | "station" | "virtual";
  zone?: string;
  capacity_cartons?: number | null;
  active?: boolean;
} & Partial<Omit<NamedLocationUpdate, "code">>;

export function saveWhLocation(location: WhLocationPatch, client?: unknown) {
  return whRpc("rpc_wh_save_location", { p_location: location as unknown as Json }, "Couldn't save the location", client);
}

export function useWhSaveLocation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (location: WhLocationPatch) => saveWhLocation(location),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["wh-locations"] });
      qc.invalidateQueries({ queryKey: ["wh-location"] });
      qc.invalidateQueries({ queryKey: ["wh-overview"] });
    },
  });
}

export type WhGenerateResult = WhRpcResult<"rpc_wh_generate_locations">;

/** The generator: a dry run returns {create, update, conflicts, deactivate, codes}; applying writes. */
export function generateWhLocations(params: { rackId?: string | null; dryRun: boolean }, client?: unknown) {
  return whRpc(
    "rpc_wh_generate_locations",
    { p_rack_id: params.rackId ?? null, p_dry_run: params.dryRun },
    params.dryRun ? "Couldn't check the locations" : "Couldn't generate the locations",
    client,
  );
}

export function useWhGenerateLocations() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params: { rackId?: string | null; dryRun: boolean }) => generateWhLocations(params),
    onSuccess: (_data, params) => {
      if (params.dryRun) return;
      qc.invalidateQueries({ queryKey: ["wh-locations"] });
      qc.invalidateQueries({ queryKey: ["wh-location"] });
      qc.invalidateQueries({ queryKey: ["wh-overview"] });
    },
  });
}

/** One pick_sequence fix, by location id or code. */
export type WhResequenceRow = ({ location_id: string } | { code: string }) & { pick_sequence: number | null };

/** pick_sequence fixes (the editor's Verify walk). Applying the generator recomputes them all. */
export function resequenceWh(rows: WhResequenceRow[], client?: unknown) {
  return whRpc("rpc_wh_resequence", { p_rows: rows as unknown as Json }, "Couldn't change the pick sequence", client);
}

export function useWhResequence() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (rows: WhResequenceRow[]) => resequenceWh(rows),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["wh-locations"] });
    },
  });
}

// ---- labels --------------------------------------------------------------------

export interface WhLabelRequest {
  kind: WhLabelKind;
  ids: string[];
  from: WhRequestedFrom;
  printerId?: string | null;
}

/** Queue a label job; the result says where it prints (station printer, this browser, or nowhere). */
export function requestWhLabels(req: WhLabelRequest, client?: unknown) {
  return whRpc(
    "rpc_wh_request_labels",
    { p_kind: req.kind, p_ids: req.ids, p_from: req.from, p_printer_id: req.printerId ?? null },
    "Couldn't queue the labels",
    client,
  );
}

export function useWhRequestLabels() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: WhLabelRequest) => requestWhLabels(req),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["wh-print-job", data.job_id] });
    },
  });
}

export interface WhMarkPrinted {
  jobId: string;
  status: "printed" | "failed" | "cancelled";
  error?: string | null;
}

/** Close a job: printed stamps label_printed_at (locations) or printed_at/print_count (cartons). */
export function markWhPrinted(params: WhMarkPrinted, client?: unknown) {
  return whRpc(
    "rpc_wh_mark_printed",
    { p_job_id: params.jobId, p_status: params.status, p_error: params.error ?? null },
    "Couldn't update the print job",
    client,
  );
}

export function useWhMarkPrinted() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params: WhMarkPrinted) => markWhPrinted(params),
    onSuccess: (_data, params) => {
      qc.invalidateQueries({ queryKey: ["wh-print-job", params.jobId] });
      if (params.status === "printed") {
        qc.invalidateQueries({ queryKey: ["wh-locations"] });
        qc.invalidateQueries({ queryKey: ["wh-containers"] });
      }
    },
  });
}
