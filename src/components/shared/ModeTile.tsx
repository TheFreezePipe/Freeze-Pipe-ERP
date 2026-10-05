import { Factory, Plane, Ship, Warehouse, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Rounded icon tile for where units are — in the warehouse, on sea or air
 * freight, or at the factory — in the colors the inventory KPI cards give
 * the same four places. The inventory breakdown popovers use it at md, the
 * launch supply ledger's Where cell at sm.
 */
const MODES = {
  warehouse: { icon: Warehouse, tone: "bg-green-400/10 text-green-400" },
  sea: { icon: Ship, tone: "bg-blue-400/10 text-blue-400" },
  air: { icon: Plane, tone: "bg-cyan-400/10 text-cyan-400" },
  factory: { icon: Factory, tone: "bg-orange-400/10 text-orange-400" },
} satisfies Record<string, { icon: LucideIcon; tone: string }>;

const SIZES = {
  sm: { tile: "h-6 w-6", icon: "h-3.5 w-3.5" },
  md: { tile: "h-8 w-8", icon: "h-4 w-4" },
} as const;

interface ModeTileProps {
  mode: keyof typeof MODES;
  size: keyof typeof SIZES;
}

export function ModeTile({ mode, size }: ModeTileProps) {
  const { icon: Icon, tone } = MODES[mode];
  return (
    <span className={cn("flex shrink-0 items-center justify-center rounded-md", SIZES[size].tile, tone)}>
      <Icon className={SIZES[size].icon} />
    </span>
  );
}
