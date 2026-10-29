import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import type { WhBucket, WhContainerState } from "./use-warehouse";

/**
 * Where one SKU is in the warehouse, location by location, for the SKU
 * drawer's Locations section: the units at each location, the cartons (LPNs)
 * holding it and any loose units by bucket.
 *
 * One read of wh_inventory_balances for the SKU with its location and
 * carton embedded; groupWhSkuLocations() does the folding so it can be tested
 * without a client. Only positive balances count: the section answers "where
 * can I find it", and a negative balance is a count problem the Counts tab
 * owns.
 */

export interface WhSkuLocationRef {
  id: string;
  code: string;
  kind: string;
  zone: string | null;
  pickable: boolean;
  is_overflow: boolean;
  pick_sequence: number | null;
}

export interface WhSkuLocationCarton {
  id: string;
  code: string;
  state: WhContainerState;
  /** This carton's on-hand of the SKU (every bucket it holds, summed). */
  qty: number;
  label_stock: "white" | "green";
  created_at: string | null;
  /** The bucket holding most of this carton's units. */
  bucket: WhBucket;
  /** Every bucket of the SKU in the carton, most units first (almost always one). */
  buckets: WhBucket[];
}

export interface WhSkuLocationLoose {
  bucket: WhBucket;
  units: number;
}

export interface WhSkuLocation {
  location: WhSkuLocationRef;
  units: number;
  cartons: WhSkuLocationCarton[];
  loose: WhSkuLocationLoose[];
}

/** One wh_inventory_balances row as the query below returns it. */
export interface WhSkuBalanceRow {
  id: string;
  location_id: string;
  container_id: string | null;
  bucket: WhBucket;
  on_hand: number;
  location: (WhSkuLocationRef & { active?: boolean }) | null;
  container: {
    id: string;
    code: string;
    state: WhContainerState;
    qty: number;
    label_stock: "white" | "green";
    created_at: string | null;
  } | null;
}

/** Virtual locations in words: they are states, not places on a shelf. */
export const VIRTUAL_LOCATION_WORDS: Record<string, string> = {
  "MFG-LINE": "At the line",
  UNLOCATED: "Unlocated",
};

const VIRTUAL_ORDER = ["MFG-LINE", "UNLOCATED"];

const BUCKET_ORDER: WhBucket[] = ["raw", "prefilled_raw", "in_production", "finished", "other"];

function bucketRank(b: WhBucket): number {
  const i = BUCKET_ORDER.indexOf(b);
  return i === -1 ? BUCKET_ORDER.length : i;
}

function compareLocations(a: WhSkuLocationRef, b: WhSkuLocationRef): number {
  const av = a.kind === "virtual";
  const bv = b.kind === "virtual";
  if (av !== bv) return av ? 1 : -1;
  if (av) {
    const ia = VIRTUAL_ORDER.indexOf(a.code);
    const ib = VIRTUAL_ORDER.indexOf(b.code);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.code.localeCompare(b.code);
  }
  const sa = a.pick_sequence ?? Number.POSITIVE_INFINITY;
  const sb = b.pick_sequence ?? Number.POSITIVE_INFINITY;
  if (sa !== sb) return sa < sb ? -1 : 1;
  return a.code.localeCompare(b.code);
}

function compareCartons(a: WhSkuLocationCarton, b: WhSkuLocationCarton): number {
  // Oldest first (FIFO reading order); a carton with no date goes last.
  if (a.created_at !== b.created_at) {
    if (a.created_at == null) return 1;
    if (b.created_at == null) return -1;
    return a.created_at < b.created_at ? -1 : 1;
  }
  return a.code.localeCompare(b.code);
}

/**
 * Fold balance rows into one entry per location: real locations by walk
 * order (pick_sequence, unset last) then code, virtual ones (the line,
 * unlocated) last. A carton appears once per location however many buckets
 * of the SKU it holds, with their units summed. Rows with no positive
 * on-hand, or whose location or carton the reader can't see, are left out.
 */
export function groupWhSkuLocations(rows: WhSkuBalanceRow[]): WhSkuLocation[] {
  type CartonAcc = Omit<WhSkuLocationCarton, "bucket" | "buckets"> & { byBucket: Map<WhBucket, number> };
  type LocAcc = { location: WhSkuLocationRef; units: number; cartons: Map<string, CartonAcc>; loose: Map<WhBucket, number> };
  const byLocation = new Map<string, LocAcc>();

  for (const row of rows) {
    const qty = Number(row.on_hand) || 0;
    if (qty <= 0 || !row.location) continue;
    if (row.container_id && !row.container) continue;

    const { id, code, kind, zone, pickable, is_overflow, pick_sequence } = row.location;
    let loc = byLocation.get(id);
    if (!loc) {
      loc = {
        location: { id, code, kind, zone: zone ?? null, pickable: !!pickable, is_overflow: !!is_overflow, pick_sequence: pick_sequence ?? null },
        units: 0,
        cartons: new Map(),
        loose: new Map(),
      };
      byLocation.set(id, loc);
    }
    loc.units += qty;

    if (row.container) {
      const c = row.container;
      let carton = loc.cartons.get(c.id);
      if (!carton) {
        carton = { id: c.id, code: c.code, state: c.state, qty: 0, label_stock: c.label_stock, created_at: c.created_at ?? null, byBucket: new Map() };
        loc.cartons.set(c.id, carton);
      }
      carton.qty += qty;
      carton.byBucket.set(row.bucket, (carton.byBucket.get(row.bucket) ?? 0) + qty);
    } else {
      loc.loose.set(row.bucket, (loc.loose.get(row.bucket) ?? 0) + qty);
    }
  }

  return [...byLocation.values()]
    .map((loc) => ({
      location: loc.location,
      units: loc.units,
      cartons: [...loc.cartons.values()]
        .map(({ byBucket, ...carton }) => {
          const buckets = [...byBucket.entries()]
            .sort((a, b) => b[1] - a[1] || bucketRank(a[0]) - bucketRank(b[0]))
            .map(([bucket]) => bucket);
          return { ...carton, bucket: buckets[0], buckets };
        })
        .sort(compareCartons),
      loose: [...loc.loose.entries()]
        .map(([bucket, units]) => ({ bucket, units }))
        .sort((a, b) => bucketRank(a.bucket) - bucketRank(b.bucket)),
    }))
    .sort((a, b) => compareLocations(a.location, b.location));
}

const SKU_LOCATIONS_SELECT =
  "id, location_id, container_id, bucket, on_hand, " +
  "location:wh_locations(id, code, kind, zone, pickable, is_overflow, pick_sequence, active), " +
  "container:wh_containers(id, code, state, qty, label_stock, created_at)";

/** Every location holding the SKU, grouped (see groupWhSkuLocations). */
export async function fetchWhSkuLocations(skuId: string, client: unknown = supabase): Promise<WhSkuLocation[]> {
  const { data, error } = await (client as typeof supabase)
    .from("wh_inventory_balances")
    .select(SKU_LOCATIONS_SELECT)
    .eq("sku_id", skuId)
    .gt("on_hand", 0)
    .limit(1000);
  if (error) throw error;
  return groupWhSkuLocations((data ?? []) as unknown as WhSkuBalanceRow[]);
}

/** The SKU drawer's Locations section. `enabled` false (drawer closed) keeps it from fetching. */
export function useWhSkuLocations(skuId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ["wh-sku-locations", skuId],
    enabled: enabled && !!skuId,
    queryFn: () => fetchWhSkuLocations(skuId as string),
    staleTime: 15 * 1000,
  });
}
