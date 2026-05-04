import type { TrackingUpdate } from "./types";

/**
 * Demo-mode persistence for tracking state.
 *
 * In production, tracking updates land in Supabase (via an edge function running
 * on pg_cron). In demo mode, we persist to localStorage so ETA drift survives
 * page reloads. The client reads this on boot and patches `demoFreight` in place.
 */

const STORAGE_KEY = "freeze-pipe-freight-tracking-v1";

export interface TrackingStoreEntry {
  shipmentId: string;
  eta: string;
  eta_original: string;
  eta_last_checked_at: string;
  actual_arrival_date: string | null;
  status: "on_the_water" | "high_risk" | "cleared_customs" | "tracking" | "delivered";
  status_overridden_at: string | null;
  last_update?: TrackingUpdate;
}

type TrackingStore = Record<string, TrackingStoreEntry>;

function readStore(): TrackingStore {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed as TrackingStore : {};
  } catch {
    return {};
  }
}

function writeStore(store: TrackingStore): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // Quota exceeded or storage disabled — silently no-op; the app still works,
    // drift just won't survive a reload.
  }
}

export function getTrackingEntry(shipmentId: string): TrackingStoreEntry | null {
  const store = readStore();
  return store[shipmentId] ?? null;
}

export function saveTrackingEntry(entry: TrackingStoreEntry): void {
  const store = readStore();
  store[entry.shipmentId] = entry;
  writeStore(store);
}

export function getAllTrackingEntries(): TrackingStore {
  return readStore();
}

/** For dev / testing: clear all persisted tracking state. */
export function clearTrackingStore(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
