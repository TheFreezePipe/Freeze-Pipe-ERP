import { useState } from "react";
import { usePdBoard } from "@/lib/hooks/use-pd";
import { needsReview } from "@/lib/marketing/pd";
import { toCardLike } from "./pd-field-utils";

/**
 * Sidebar count for the Product Development item = size of the board's
 * Review list (same needsReview rule the board's toggle uses). Renders
 * nothing when zero so the row stays quiet.
 */
export function PdReviewBadge() {
  const { data: cards } = usePdBoard();
  const [todayIso] = useState(() => new Date().toISOString().slice(0, 10));
  if (!cards?.length) return null;
  const n = cards.filter((c) =>
    needsReview({ ...toCardLike(c), last_reviewed_at: c.last_reviewed_at, created_at: c.created_at }, todayIso),
  ).length;
  if (n === 0) return null;
  return (
    <span className="ml-auto rounded-full bg-red-500/15 px-1.5 py-px text-[10px] font-semibold tabular-nums text-red-400">
      {n}
    </span>
  );
}
