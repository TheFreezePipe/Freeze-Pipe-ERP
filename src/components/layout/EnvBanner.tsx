import { cn } from "@/lib/utils";
import { isDemoMode, APP_ENV, shouldShowEnvBanner } from "@/lib/env";

/** One-line environment strip (never on prod). */
export function EnvBanner() {
  if (!shouldShowEnvBanner) return null;
  return (
    <div
      className={cn(
        "shrink-0 py-1 text-center text-xs font-semibold",
        APP_ENV === "staging" ? "bg-amber-500 text-black" :
        isDemoMode ? "bg-orange-500 text-black" :
        "bg-blue-500 text-white",
      )}
    >
      {isDemoMode
        ? "DEMO MODE — data is in-memory and will be lost on reload"
        : import.meta.env.MODE === "verify"
          ? "VERIFY MODE — live production data, signed in as the UI-verification account"
          : `${APP_ENV.toUpperCase()} ENVIRONMENT — not production data`}
    </div>
  );
}
