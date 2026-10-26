import { Minus, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface BigStepperProps {
  value: number;
  onChange: (next: number) => void;
  min?: number;
  max?: number;
  step?: number;
  /**
   * Adds −N / +N buttons under the stepper for counts in the dozens: the
   * floor screens never ask for typing, because a paired scanner hides the
   * phone's keyboard.
   */
  bigStep?: number;
  /** The caption under the number; null hides it. */
  unit?: string | null;
  /** lg: the Workspace quantity card (56 px buttons, 36 px number); md: a list row (48 px, 26 px). */
  size?: "lg" | "md";
  disabled?: boolean;
  /** What the number is, for screen readers ("Units in C-466-007"). */
  label?: string;
  className?: string;
}

function clamp(n: number, min: number, max: number | undefined): number {
  const low = Math.max(min, n);
  return max == null ? low : Math.min(max, low);
}

/**
 * The big round − / + stepper (design §9.3), the same look as the
 * Manufacturing Workspace quantity card: outline round buttons either side of
 * a large tabular number. Targets stay at least 48 px for gloved thumbs.
 */
export function BigStepper({
  value,
  onChange,
  min = 0,
  max,
  step = 1,
  bigStep,
  unit = "units",
  size = "lg",
  disabled = false,
  label,
  className,
}: BigStepperProps) {
  const lg = size === "lg";
  const set = (n: number) => onChange(clamp(n, min, max));
  const button = cn("shrink-0 rounded-full text-lg touch-manipulation", lg ? "h-14 w-14" : "h-12 w-12");
  const icon = lg ? "h-6 w-6" : "h-5 w-5";

  return (
    <div className={cn("flex flex-col items-center gap-2", className)}>
      <div className={cn("flex items-center justify-center", lg ? "gap-4" : "gap-2")}>
        <Button
          type="button"
          variant="outline"
          size="icon"
          className={button}
          disabled={disabled || value <= min}
          onClick={() => set(value - step)}
          aria-label={`Minus ${step}`}
        >
          <Minus className={icon} />
        </Button>
        <div className={cn("text-center", lg ? "min-w-[80px]" : "min-w-[52px]")}>
          <p
            className={cn("font-bold tabular-nums", lg ? "text-4xl" : "text-[26px] font-extrabold leading-none")}
            aria-live="polite"
            aria-label={label ? `${label}: ${value}` : undefined}
          >
            {value}
          </p>
          {unit && <p className="text-xs text-muted-foreground">{unit}</p>}
        </div>
        <Button
          type="button"
          variant="outline"
          size="icon"
          className={button}
          disabled={disabled || (max != null && value >= max)}
          onClick={() => set(value + step)}
          aria-label={`Plus ${step}`}
        >
          <Plus className={icon} />
        </Button>
      </div>
      {bigStep != null && bigStep > step && (
        <div className="flex gap-2">
          <Button
            type="button"
            variant="ghost"
            className="h-12 min-w-[64px] rounded-full text-sm font-semibold tabular-nums touch-manipulation"
            disabled={disabled || value <= min}
            onClick={() => set(value - bigStep)}
          >
            −{bigStep}
          </Button>
          <Button
            type="button"
            variant="ghost"
            className="h-12 min-w-[64px] rounded-full text-sm font-semibold tabular-nums touch-manipulation"
            disabled={disabled || (max != null && value >= max)}
            onClick={() => set(value + bigStep)}
          >
            +{bigStep}
          </Button>
        </div>
      )}
    </div>
  );
}
