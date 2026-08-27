/**
 * Violet "pre-launch" tag for PD-promoted SKUs that haven't been activated
 * yet (see src/lib/product-lifecycle.ts). Shared by SKU Economics and the
 * factory-order / freight SKU pickers so the state reads the same everywhere.
 */
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export function PreLaunchBadge({ className }: { className?: string }) {
  return (
    <Badge variant="outline" className={cn("border-violet-500/50 text-violet-400 text-[10px]", className)}>
      pre-launch
    </Badge>
  );
}
