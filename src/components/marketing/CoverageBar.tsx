/**
 * A launch product's coverage bar: one segment per supply row, sized by its
 * units over max(basis, total) and shaded by the row's tone (green by the
 * ready-by goal, amber by the first selling day, red after), hatched when
 * the arrival is an estimate. A dashed red outline follows the segments for
 * the shortfall and a white tick marks the need when one is set. Pure SVG
 * stretched to its cell; every segment carries a title ("Sea 476 · 270 ·
 * Oct 12"). The numbers come from the ledger — nothing is computed here but
 * widths.
 */
import { useId } from "react";
import { coverageTitle, type SupplyLedger, type Tone } from "@/lib/marketing/launch-supply";

const W = 230;
const H = 12;
const BAR_Y = 2;
const BAR_H = 8;

/** SVG fills take colours, not classes: Tailwind green-400 / amber-400 / red-400, the need tick and the empty outline. */
const TONE_FILL: Record<Tone, string> = { g: "#4ade80", a: "#fbbf24", r: "#f87171" };
const NEED_TICK = "#f2f2f2";
const EMPTY_STROKE = "#3d3d3d";

const TONES: readonly Tone[] = ["g", "a", "r"];

const px = (n: number) => Math.round(n * 10) / 10;

export function CoverageBar({ ledger }: { ledger: SupplyLedger }) {
  // Pattern ids must be unique per bar on the page; useId's delimiters are not safe inside url(#…).
  const uid = useId().replace(/[^A-Za-z0-9_-]/g, "");
  const hatchId = (tone: Tone) => `${uid}-${tone}`;

  const scale = Math.max(ledger.basis, ledger.total) || 1;
  const segments = [];
  let x = 0;
  for (const row of ledger.rows) {
    if (!row.units) continue;
    const w = Math.max(2, (row.units / scale) * W);
    segments.push(
      <rect
        key={row.key}
        x={px(x)}
        y={BAR_Y}
        width={px(Math.max(1, w - 1))}
        height={BAR_H}
        rx={1}
        fill={row.estimated ? `url(#${hatchId(row.tone)})` : TONE_FILL[row.tone]}
      >
        <title>{coverageTitle(row)}</title>
      </rect>,
    );
    x += w;
  }
  const shortfall = ledger.basis - ledger.total;
  const needX = ledger.need != null ? Math.min(W - 1, (ledger.need / scale) * W) : null;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="block h-3 w-full">
      <defs>
        {TONES.map((tone) => (
          <pattern key={tone} id={hatchId(tone)} width={4} height={4} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width={4} height={4} fill={TONE_FILL[tone]} fillOpacity={0.22} />
            <rect width={1.6} height={4} fill={TONE_FILL[tone]} />
          </pattern>
        ))}
      </defs>
      {segments}
      {shortfall > 0 && (
        <rect
          x={px(x + 0.5)}
          y={BAR_Y + 0.5}
          width={px(Math.max(0, (shortfall / scale) * W - 1))}
          height={BAR_H - 1}
          fill="none"
          stroke={TONE_FILL.r}
          strokeDasharray="2 2"
        />
      )}
      {needX != null && <rect x={px(needX - 1)} y={0} width={2} height={H} fill={NEED_TICK} fillOpacity={0.85} />}
      {segments.length === 0 && shortfall <= 0 && <rect x={0} y={BAR_Y} width={W} height={BAR_H} fill="none" stroke={EMPTY_STROKE} />}
    </svg>
  );
}
