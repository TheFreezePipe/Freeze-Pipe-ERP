import { Check, X } from "lucide-react";
import { cn } from "@/lib/utils";

export type FlashTone = "ok" | "fail";

/**
 * Full-screen scan feedback, readable at arm's length: green check on a
 * match, red cross on a miss. Click-through, so it never blocks the next tap.
 */
export function ResultFlash({ tone, label }: { tone: FlashTone | null; label?: string }) {
  if (!tone) return null;
  const ok = tone === "ok";
  return (
    <div
      className={cn(
        "pointer-events-none fixed inset-0 z-50 flex items-center justify-center animate-in fade-in duration-150",
        ok ? "bg-green-950/80" : "bg-red-950/80",
      )}
      role="status"
      aria-live="assertive"
    >
      <div className="flex flex-col items-center gap-3 animate-in zoom-in-95 duration-200">
        <div
          className={cn(
            "flex h-24 w-24 items-center justify-center rounded-full",
            ok ? "bg-green-500/25" : "bg-red-500/25",
          )}
        >
          {ok ? <Check className="h-12 w-12 text-green-400" /> : <X className="h-12 w-12 text-red-400" />}
        </div>
        {label && (
          <p className={cn("text-lg font-semibold", ok ? "text-green-400" : "text-red-400")}>{label}</p>
        )}
      </div>
    </div>
  );
}
