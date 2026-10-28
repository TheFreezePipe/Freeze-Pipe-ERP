import { History } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CartonLink } from "@/components/warehouse/CartonLink";
import type { WhFifoOverride, WhNextCarton } from "@/lib/hooks/use-warehouse";
import { fifoSuggestsParts } from "@/lib/hooks/use-warehouse-fifo";
import { FIFO_OVERRIDE_REASONS } from "@/lib/hooks/use-warehouse-mfg";
import { cn } from "@/lib/utils";

const REASON_LABELS: Record<WhFifoOverride, string> = {
  buried: "Buried",
  damaged: "Damaged",
  closer: "Closer",
  other: "Other",
};

interface FifoOverridePromptProps {
  /** The carton the worker scanned (refused with fifo_suggests; nothing moved). */
  scannedCode: string;
  /** The older carton FIFO suggests instead. */
  suggested: WhNextCarton;
  busy?: boolean;
  disabled?: boolean;
  /** Take the scanned carton anyway, recorded as a deviation with this reason. */
  onReason: (reason: WhFifoOverride) => void;
  /** Leave the scanned carton and go for the older one. */
  onTakeOlder: () => void;
  className?: string;
}

/**
 * FIFO is a suggestion, never a block: when a worker takes another carton to
 * the line than the one FIFO names, say why the other is older and let them
 * continue with one tap and a reason. Used by the Workspace take-to-line step
 * and Floor Move. Carton codes open the passport in a new tab, so the task in
 * progress on this page is kept.
 */
export function FifoOverridePrompt({
  scannedCode,
  suggested,
  busy = false,
  disabled = false,
  onReason,
  onTakeOlder,
  className,
}: FifoOverridePromptProps) {
  const parts = fifoSuggestsParts(scannedCode, suggested);
  return (
    <div
      className={cn("space-y-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-200", className)}
      role="region"
      aria-label="Older carton on the shelf"
    >
      <div className="flex items-start gap-2">
        <History className="mt-0.5 h-4 w-4 shrink-0" />
        <p>
          {parts.map((p, i) => ("code" in p ? <CartonLink key={i} code={p.code} newTab /> : <span key={i}>{p.text}</span>))}
        </p>
      </div>
      <p className="text-xs text-amber-200/80">
        Take <span className="font-mono tabular-nums">{scannedCode}</span> anyway? Say why:
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {FIFO_OVERRIDE_REASONS.map((reason) => (
          <Button
            key={reason}
            type="button"
            variant="outline"
            className="h-10 rounded-full px-3 text-sm touch-manipulation"
            onClick={() => onReason(reason)}
            disabled={disabled || busy}
          >
            {REASON_LABELS[reason]}
          </Button>
        ))}
        <Button
          type="button"
          variant="ghost"
          className="h-10 px-3 text-sm touch-manipulation"
          onClick={onTakeOlder}
          disabled={disabled || busy}
        >
          Take the older one instead
        </Button>
      </div>
    </div>
  );
}
