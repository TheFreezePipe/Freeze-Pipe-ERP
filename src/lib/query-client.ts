import { QueryClient, QueryCache, MutationCache } from "@tanstack/react-query";
import { toast } from "@/hooks/use-toast";
import { captureException } from "@/lib/observability";

/**
 * Global error surfacing for TanStack Query.
 *
 * Pages destructure reads as `const { data = [] } = useQuery(...)`, so a
 * failed fetch used to render as a silently-empty page — no banner, no
 * toast, no report. These cache-level handlers make every failure both
 * VISIBLE (toast) and REPORTED (Sentry via the observability layer):
 *
 *   - Query errors  → destructive toast + captureException. Throttled
 *     per query-key root (60s) and globally (3s) so an offline burst of
 *     20 failing queries produces one toast, not twenty.
 *   - Mutation errors → captureException always; toast ONLY when the
 *     mutation has no onError handler of its own (most pages already
 *     toast their mutation failures — don't double up).
 *
 * captureException no-ops outside prod / without VITE_SENTRY_DSN, so dev
 * stays quiet.
 */

const PER_KEY_TOAST_MS = 60_000;
const GLOBAL_TOAST_MS = 3_000;
const lastToastByKey = new Map<string, number>();
let lastGlobalToast = 0;

/** Human-ish label from a query key: ["sku-forecasts", ...] -> "sku forecasts". */
function describeKey(queryKey: unknown): string {
  if (Array.isArray(queryKey) && typeof queryKey[0] === "string") {
    return queryKey[0].replace(/[-_]/g, " ");
  }
  return "data";
}

function shouldToast(key: string): boolean {
  const now = Date.now();
  if (now - lastGlobalToast < GLOBAL_TOAST_MS) return false;
  if (now - (lastToastByKey.get(key) ?? 0) < PER_KEY_TOAST_MS) return false;
  lastToastByKey.set(key, now);
  lastGlobalToast = now;
  return true;
}

function errMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error, query) => {
      const key = describeKey(query.queryKey);
      void captureException(error, { source: "query", queryKey: key });
      if (shouldToast(key)) {
        toast({
          variant: "destructive",
          title: "Couldn't load data",
          description: `Loading ${key} failed — parts of this page may look empty. Check your connection and refresh. (${errMessage(error)})`,
        });
      }
    },
  }),
  mutationCache: new MutationCache({
    onError: (error, _variables, _context, mutation) => {
      void captureException(error, {
        source: "mutation",
        mutationKey: mutation.options.mutationKey ?? null,
      });
      if (!mutation.options.onError && shouldToast("mutation")) {
        toast({
          variant: "destructive",
          title: "Action failed",
          description: errMessage(error),
        });
      }
    },
  }),
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 2,
      retry: 1,
    },
  },
});
