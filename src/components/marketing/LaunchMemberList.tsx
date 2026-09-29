/**
 * Launches page — a launch's products, expanded under its row. Card-backed
 * members show the PD card's stage, next deadline, order by and risk (the
 * board's own deadline chain and risk dot, anchored on this launch) with a
 * link to open the card; plain members show their SKU or working name.
 */
import { Link } from "react-router-dom";
import { ChevronRight, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { deadlineChain, nextDeadline, riskDot } from "@/lib/marketing/pd";
import { followsLaunch, pdStageLabel } from "@/lib/marketing/launch-link";
import type { MktLaunchCard, MktLaunchWithMembers } from "@/lib/hooks";
import { fmtDay, relDays } from "./launch-format";
import { launchMemberItems } from "./launch-members";
import { OwnDateChip, RiskDotMark, StageChip } from "./LaunchLinkParts";

interface Props {
  launch: MktLaunchWithMembers;
  todayIso: string;
  canEdit: boolean;
  onAddProducts: () => void;
}

const GRID = "grid grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,0.8fr)_minmax(0,0.8fr)_auto] items-center gap-3";

export function LaunchMemberList({ launch, todayIso, canEdit, onAddProducts }: Props) {
  const items = launchMemberItems(launch);

  return (
    <div className="overflow-hidden rounded-lg border border-border/60">
      {items.length > 0 && (
        <div className={`${GRID} border-b border-border/60 bg-muted/30 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground`}>
          <span>Product</span>
          <span>Stage</span>
          <span>Next deadline</span>
          <span>Order by</span>
          <span>Risk</span>
          <span className="w-12" />
        </div>
      )}
      {items.map((it) =>
        it.kind === "card" ? (
          <CardRow key={it.key} card={it.card} todayIso={todayIso} />
        ) : (
          <div key={it.key} className={`${GRID} border-b border-border/40 px-3 py-2 text-sm`}>
            <span className="min-w-0 truncate">
              {it.sku && <span className="mr-2 font-mono text-xs">{it.sku}</span>}
              {it.name}
            </span>
            <span className="text-muted-foreground/60">—</span>
            <span className="text-muted-foreground/60">—</span>
            <span className="text-muted-foreground/60">—</span>
            <span className="text-muted-foreground/60">—</span>
            <span className="w-12" />
          </div>
        ),
      )}
      {canEdit && (
        <div className="flex justify-end px-3 py-2">
          <Button variant="outline" size="sm" className="h-7" onClick={onAddProducts}>
            <Plus className="mr-1.5 h-3.5 w-3.5" /> Add products
          </Button>
        </div>
      )}
    </div>
  );
}

function CardRow({ card, todayIso }: { card: MktLaunchCard; todayIso: string }) {
  const chain = deadlineChain(card, todayIso);
  const next = nextDeadline(chain);
  const orderBy = chain?.find((r) => r.key === "orderBy") ?? null;
  const halted = card.stage === "halted";
  const dot = halted ? null : riskDot(card, todayIso);
  return (
    <div className={`${GRID} border-b border-border/40 px-3 py-2 text-sm tabular-nums`}>
      <span className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 truncate font-medium" title={card.name}>{card.name}</span>
        {!followsLaunch(card) && <OwnDateChip date={card.target_launch_date} />}
      </span>
      <span><StageChip label={pdStageLabel(card.stage)} /></span>
      <span className="whitespace-nowrap">{next ? `${next.label} ${fmtDay(next.date)}` : "—"}</span>
      <span className="whitespace-nowrap">{orderBy ? fmtDay(orderBy.date) : "—"}</span>
      <span className="flex items-center gap-1.5 whitespace-nowrap">
        {halted || !next ? (
          <span className="text-muted-foreground/60">—</span>
        ) : (
          <>
            <RiskDotMark dot={dot} />
            <span className="text-xs text-muted-foreground">{relDays(next.days)}</span>
          </>
        )}
      </span>
      <Link
        to={`/marketing/product-development?card=${card.id}`}
        className="inline-flex w-12 items-center justify-end gap-0.5 text-xs text-muted-foreground hover:text-foreground"
      >
        Open <ChevronRight className="h-3 w-3" />
      </Link>
    </div>
  );
}
