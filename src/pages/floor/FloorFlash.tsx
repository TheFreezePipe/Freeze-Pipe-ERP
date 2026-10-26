import { AlertTriangle } from "lucide-react";
import { ResultFlash } from "@/components/warehouse/ResultFlash";
import type { FloorFlashState } from "./use-floor-flash";

/**
 * Green and red come from ResultFlash; amber ("accepted, but not what was
 * suggested") is drawn here in the same shape, because ResultFlash has only
 * the two tones.
 */
export function FloorFlash({ flash }: { flash: FloorFlashState | null }) {
  if (!flash) return null;
  if (flash.tone !== "warn") return <ResultFlash key={flash.id} tone={flash.tone} label={flash.label} />;
  return (
    <div
      key={flash.id}
      className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-amber-950/80 px-6 animate-in fade-in duration-150"
      role="status"
      aria-live="assertive"
    >
      <div className="flex flex-col items-center gap-3 text-center animate-in zoom-in-95 duration-200">
        <div className="flex h-24 w-24 items-center justify-center rounded-full bg-amber-500/25">
          <AlertTriangle className="h-12 w-12 text-amber-400" />
        </div>
        {flash.label && <p className="text-lg font-semibold text-amber-300">{flash.label}</p>}
      </div>
    </div>
  );
}
