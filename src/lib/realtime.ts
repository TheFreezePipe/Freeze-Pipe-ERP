import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { isDemoMode } from "@/lib/env";

const DEBOUNCE_MS = 250;

// Each subscription gets its own topic so two mounts (or StrictMode's
// mount-unmount-mount) never share a channel that is mid-teardown.
let channelSeq = 0;

/**
 * Keep pages fresh from Supabase Realtime: any INSERT/UPDATE/DELETE on the
 * given public tables invalidates the given query roots (debounced 250 ms so
 * a burst of row changes costs one refetch). Backgrounded phones drop the
 * socket silently, so the roots are also invalidated whenever the page
 * becomes visible again. No-op in demo mode.
 *
 *   useLiveInvalidate("wh-stock", ["wh_inventory_balances", "wh_containers"],
 *     [["wh-location"], ["wh-balances"], ["wh-containers"]]);
 */
export function useLiveInvalidate(channel: string, tables: string[], queryRoots: string[][]) {
  const qc = useQueryClient();
  // Value keys so callers can pass inline array literals.
  const tablesKey = tables.join(",");
  const rootsKey = JSON.stringify(queryRoots);

  useEffect(() => {
    if (isDemoMode) return;

    const roots = JSON.parse(rootsKey) as string[][];
    const tableList = tablesKey ? tablesKey.split(",") : [];
    let timer: ReturnType<typeof setTimeout> | null = null;

    const invalidateNow = () => {
      for (const queryKey of roots) void qc.invalidateQueries({ queryKey });
    };
    const scheduleInvalidate = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        invalidateNow();
      }, DEBOUNCE_MS);
    };

    channelSeq += 1;
    const subscription = supabase.channel(`${channel}-${channelSeq}`);
    for (const table of tableList) {
      subscription.on("postgres_changes", { event: "*", schema: "public", table }, scheduleInvalidate);
    }
    subscription.subscribe();

    const onVisibility = () => {
      if (document.visibilityState === "visible") invalidateNow();
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      if (timer) clearTimeout(timer);
      void supabase.removeChannel(subscription);
    };
  }, [qc, channel, tablesKey, rootsKey]);
}
