import {
  computeBarrelVisual,
  BARREL_LITERS,
  BARRELS_PER_TYPICAL_ORDER,
} from "@/lib/materials/runway";

/**
 * 4+-barrel visual for glycerin on-hand. Sequential drain (rightmost
 * empties first) per the May-26 product spec. Barrel count is dynamic
 * to handle the "post-delivery surplus" case where 5+ barrels are on
 * hand briefly — render as many barrels as needed, never fewer than
 * BARRELS_PER_TYPICAL_ORDER (4) so the visual stays familiar.
 *
 * Each barrel is a single SVG with a clipPath that masks the fluid
 * region to the current fill level. Lightweight, no animation.
 */
export function GlycerinBarrels({
  onHandLiters,
  dailyConsumptionLiters,
}: {
  onHandLiters: number;
  dailyConsumptionLiters: number | null;
}) {
  const viz = computeBarrelVisual(onHandLiters, dailyConsumptionLiters);

  return (
    <div className="space-y-3">
      <div className="flex items-end gap-3 flex-wrap">
        {viz.barrels.map((b) => (
          <BarrelSvg key={b.index} fillFraction={b.fillFraction} index={b.index} total={viz.barrels.length} />
        ))}
      </div>
      <div className="flex items-center gap-4 text-xs text-muted-foreground flex-wrap">
        <div>
          <span className="font-medium text-foreground tabular-nums">
            {Math.round(viz.totalLiters).toLocaleString()} L
          </span>{" "}
          on hand
        </div>
        <div>
          <span className="font-medium text-foreground tabular-nums">
            {viz.totalBarrels.toFixed(2)}
          </span>{" "}
          barrels equivalent ({BARREL_LITERS} L each)
        </div>
        {viz.daysUntilNextBarrelEmpty != null && (
          <div>
            <span className="font-medium text-foreground tabular-nums">
              {viz.daysUntilNextBarrelEmpty}d
            </span>{" "}
            until the active barrel is empty
          </div>
        )}
        {viz.barrels.length > BARRELS_PER_TYPICAL_ORDER && (
          <div className="text-amber-300/80">
            Above typical {BARRELS_PER_TYPICAL_ORDER}-barrel order — fresh delivery on hand
          </div>
        )}
      </div>
    </div>
  );
}

function BarrelSvg({
  fillFraction,
  index,
  total,
}: {
  fillFraction: number;
  index: number;
  total: number;
}) {
  // Barrel geometry: 80px wide × 110px tall, with banded stripes for
  // visual interest. Fluid region is a clipPath that maps fillFraction
  // to a y-coordinate (0 = empty / clipped at bottom, 1 = full).
  const W = 80;
  const H = 110;
  // Fluid region — exclude the top "rim" and bottom "foot" of the barrel.
  const fluidTop = 14;
  const fluidBottom = H - 8;
  const fluidHeight = fluidBottom - fluidTop;
  const visibleHeight = fluidHeight * Math.max(0, Math.min(1, fillFraction));
  const fillY = fluidBottom - visibleHeight;

  // Sequential drain — show the leftmost barrel as the most-full and
  // the rightmost as the most-empty. The label below confirms which is
  // currently being drained.
  const isActiveBarrel = fillFraction > 0 && fillFraction < 1;
  const isEmpty = fillFraction <= 0;

  const clipId = `barrel-fluid-${index}-${total}`;

  return (
    <div className="flex flex-col items-center gap-1">
      <svg
        width={W}
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        className={isEmpty ? "opacity-50" : ""}
      >
        <defs>
          <clipPath id={clipId}>
            <rect x="6" y={fluidTop} width={W - 12} height={fluidHeight} rx="4" />
          </clipPath>
        </defs>

        {/* Barrel body outline */}
        <rect
          x="4"
          y="10"
          width={W - 8}
          height={H - 14}
          rx="6"
          fill="hsl(0, 0%, 14%)"
          stroke="hsl(0, 0%, 35%)"
          strokeWidth="1.5"
        />

        {/* Fluid (light cyan — reads as "clear liquid") */}
        <rect
          x="6"
          y={fillY}
          width={W - 12}
          height={visibleHeight}
          fill="hsl(189, 80%, 55%)"
          opacity="0.85"
          clipPath={`url(#${clipId})`}
        />

        {/* Barrel bands */}
        {[H * 0.28, H * 0.56, H * 0.84].map((y, i) => (
          <line
            key={i}
            x1="4"
            y1={y}
            x2={W - 4}
            y2={y}
            stroke="hsl(0, 0%, 30%)"
            strokeWidth="1"
          />
        ))}

        {/* Top rim */}
        <rect x="2" y="6" width={W - 4} height="8" rx="2" fill="hsl(0, 0%, 22%)" stroke="hsl(0, 0%, 38%)" strokeWidth="1" />

        {/* Fill percentage label inside the barrel */}
        <text
          x={W / 2}
          y={H / 2 + 4}
          textAnchor="middle"
          fontSize="11"
          fontWeight="600"
          fill={fillFraction > 0.5 ? "white" : "hsl(0, 0%, 70%)"}
          style={{ pointerEvents: "none" }}
        >
          {Math.round(fillFraction * 100)}%
        </text>
      </svg>
      <span className={`text-[10px] ${isActiveBarrel ? "text-amber-300 font-medium" : "text-muted-foreground"}`}>
        {isActiveBarrel ? "active" : `#${index + 1}`}
      </span>
    </div>
  );
}
