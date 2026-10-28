import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { whRpc, type WhLabelKind, type WhRequestedFrom } from "./use-warehouse";

/**
 * Settings › Warehouse › Labels: the carton a sample label is printed for,
 * and a label request that is pinned to this browser. Reads only; the label
 * size itself lives in wh_settings.labels (useWarehouseSettings).
 */

export interface WhSampleContainer {
  id: string;
  code: string;
}

/** The newest carton that is not void, or null when none exists yet. Exported for tests. */
export async function fetchWhSampleContainer(client: unknown = supabase): Promise<WhSampleContainer | null> {
  const { data, error } = await (client as typeof supabase)
    .from("wh_containers")
    .select("id, code, created_at")
    .neq("state", "void")
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw error;
  const row = data?.[0];
  return row ? { id: row.id, code: row.code } : null;
}

/** A real carton to print a sample label for (the newest live one). */
export function useWhSampleContainer() {
  return useQuery({
    queryKey: ["wh-sample-container"],
    queryFn: () => fetchWhSampleContainer(),
    staleTime: 60 * 1000,
  });
}

export interface WhBrowserLabelRequest {
  kind: WhLabelKind;
  ids: string[];
  from: WhRequestedFrom;
}

/**
 * Queue a label job that prints from this browser whatever the caller's
 * station session says (rpc_wh_request_labels p_target = 'browser'). The job
 * comes back with its payload, ready for LabelSheet's `existingJob`. While
 * outbound is blocked the server answers target 'none' instead.
 */
export function requestWhBrowserLabels(req: WhBrowserLabelRequest, client?: unknown) {
  return whRpc(
    "rpc_wh_request_labels",
    { p_kind: req.kind, p_ids: req.ids, p_from: req.from, p_printer_id: null, p_target: "browser" },
    "Couldn't queue the labels",
    client,
  );
}

export function useWhRequestBrowserLabels() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: WhBrowserLabelRequest) => requestWhBrowserLabels(req),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["wh-print-job", data.job_id] });
    },
  });
}
