import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { whRpc, type WhNextCarton } from "./use-warehouse";

/**
 * FIFO next carton (owner decisions 2026-10-28): for each SKU, the raw carton
 * to pull next. An open carton first, then the oldest factory order, the
 * shipment that landed first, check-in, and walk order. The suggestion never
 * blocks: the Manufacturing Overview keeps its demand order and only names
 * the carton, and the take-to-line step lets a worker take another carton
 * with a reason (rpc_wh_take_to_line p_fifo_override).
 */

/** rpc_wh_next_cartons takes at most this many SKU ids per call. */
export const WH_NEXT_CARTONS_CHUNK = 200;

/** The next carton per SKU id; null when nothing raw is on the shelf (or the id is unknown). */
export type WhNextCartonsBySku = Record<string, WhNextCarton | null>;

/**
 * The next carton for each SKU (rpc_wh_next_cartons). Ids are de-duplicated
 * and sent in chunks of 200; every id asked for has a key in the answer,
 * null when the server named no carton. Exported for tests.
 */
export async function fetchWhNextCartons(skuIds: string[], client?: unknown): Promise<WhNextCartonsBySku> {
  const ids = [...new Set(skuIds.filter(Boolean))].sort();
  const out: WhNextCartonsBySku = {};
  for (let i = 0; i < ids.length; i += WH_NEXT_CARTONS_CHUNK) {
    const chunk = ids.slice(i, i + WH_NEXT_CARTONS_CHUNK);
    const res = await whRpc("rpc_wh_next_cartons", { p_sku_ids: chunk }, "Couldn't load the next cartons", client ?? supabase);
    const next = (res.next ?? {}) as Record<string, WhNextCarton | null | undefined>;
    for (const id of chunk) out[id] = next[id] ?? null;
  }
  return out;
}

/**
 * The carton to pull next for each of these SKUs. Disabled while the list is
 * empty; 30 s fresh and refreshed when the window regains focus (a take to
 * the line invalidates it through MFG_INVALIDATE_ROOTS).
 */
export function useWhNextCartons(skuIds: string[]) {
  const sortedIds = [...new Set(skuIds.filter(Boolean))].sort();
  return useQuery({
    queryKey: ["wh-next-cartons", sortedIds],
    enabled: sortedIds.length > 0,
    queryFn: () => fetchWhNextCartons(sortedIds),
    staleTime: 30 * 1000,
    refetchOnWindowFocus: true,
  });
}

// ---- Words -----------------------------------------------------------------------

/** The reason word for each rule that picked the carton. */
export const NEXT_CARTON_REASON_WORDS: Record<WhNextCarton["reason"], string> = {
  open_carton: "open carton",
  oldest_batch: "oldest batch",
  oldest_received: "oldest on the shelf",
};

/** "Oct 20" (with the year when it is not this year). Date-only strings read as calendar days. */
function shortDay(iso: string | null | undefined, now: Date = new Date()): string | null {
  if (!iso) return null;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(iso);
  const d = new Date(dateOnly ? `${iso}T00:00:00Z` : iso);
  if (Number.isNaN(d.getTime())) return null;
  const timeZone = dateOnly ? "UTC" : undefined;
  const year = dateOnly ? d.getUTCFullYear() : d.getFullYear();
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(year !== now.getFullYear() ? { year: "numeric" } : {}),
    ...(timeZone ? { timeZone } : {}),
  });
}

export interface NextCartonDescription {
  code: string;
  location: string | null;
  /** The factory order number (the batch), when known. */
  batch: string | null;
  /** "received Oct 20", when the check-in date is known. */
  received: string | null;
  /** "open carton", "oldest batch" or "oldest on the shelf". */
  reason: string;
  /** Location, batch and received, joined with " · " (missing parts dropped). */
  detail: string;
  /** "C-466-004 · 05-02-1 · FO-2026-118 · received Oct 20". */
  line: string;
}

/** The pieces of one next-carton line. Pure; exported for tests. */
export function describeNextCarton(next: WhNextCarton, now: Date = new Date()): NextCartonDescription {
  const day = shortDay(next.received_at, now);
  const received = day ? `received ${day}` : null;
  const location = next.location_code ?? null;
  const batch = next.factory_order_number ?? null;
  const detail = [location, batch, received].filter(Boolean).join(" · ");
  return {
    code: next.code,
    location,
    batch,
    received,
    reason: NEXT_CARTON_REASON_WORDS[next.reason] ?? "oldest on the shelf",
    detail,
    line: detail ? `${next.code} · ${detail}` : next.code,
  };
}

/** The take-to-line step's suggestion: "Pull C-466-004 from 05-02-1 (oldest batch, FO-2026-118)". */
export function nextCartonPullLine(next: WhNextCarton): string {
  const d = describeNextCarton(next);
  const why = [d.reason, d.batch].filter(Boolean).join(", ");
  return `Pull ${d.code}${d.location ? ` from ${d.location}` : ""} (${why})`;
}

/** A piece of a FIFO sentence: plain words, or a carton code the screen draws as a link. */
export type FifoTextPart = { text: string } | { code: string };

/**
 * The prompt when a worker scans another carton than the suggestion, in
 * pieces so the screen can link both carton codes:
 * "C-472-003 is newer. C-466-004 in 05-02-1 is older (FO-2026-118, received Oct 20)."
 * An open carton is named as open rather than older. Pure; exported for tests.
 */
export function fifoSuggestsParts(scannedCode: string, suggested: WhNextCarton, now: Date = new Date()): FifoTextPart[] {
  const d = describeNextCarton(suggested, now);
  const where = d.location ? ` in ${d.location}` : "";
  const facts = [d.batch, d.received].filter(Boolean).join(", ");
  const tail = facts ? ` (${facts})` : "";
  if (suggested.reason === "open_carton") {
    return [{ code: d.code }, { text: `${where} is already open${tail}. Finish it before ` }, { code: scannedCode }, { text: "." }];
  }
  return [{ code: scannedCode }, { text: " is newer. " }, { code: d.code }, { text: `${where} is older${tail}.` }];
}

/** fifoSuggestsParts as one sentence. */
export function fifoSuggestsText(scannedCode: string, suggested: WhNextCarton, now: Date = new Date()): string {
  return fifoSuggestsParts(scannedCode, suggested, now)
    .map((p) => ("code" in p ? p.code : p.text))
    .join("");
}
