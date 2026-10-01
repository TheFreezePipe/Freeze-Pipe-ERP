/**
 * Launches page — a launch's products, expanded under its row: one row per
 * product (launchMemberItems: member rows, halted cards left out, arrived
 * cards kept). Each row reads through memberState — In development (stage,
 * next deadline), Ordered (factory due against the launch's ship-by, placed
 * date), Shipped (ETA against ready-by, units booked of ordered), Arrived
 * (frozen, green) — with the risk dot and a link to the card; a plain SKU
 * row shows its stock reading and any inbound freight.
 */
import { Link } from "react-router-dom";
import { ChevronRight, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  EMPTY_INBOUND,
  followsLaunch,
  memberState,
  type InboundMap,
  type LaunchMemberRow,
  type MemberState,
} from "@/lib/marketing/launch-link";
import type { MktLaunchCard, MktLaunchWithMembers } from "@/lib/hooks";
import { fmtDay, relDays, slackText, stockReading } from "./launch-format";
import { launchMemberItems } from "./launch-members";
import { OwnDateChip, RiskDotMark, StageChip } from "./LaunchLinkParts";

interface Props {
  launch: MktLaunchWithMembers;
  todayIso: string;
  canEdit: boolean;
  onAddProducts: () => void;
  /** useLaunchInbound for the page's SKUs (EMPTY_INBOUND while loading). */
  inbound?: InboundMap;
  /** Total on-hand units per SKU (the page's inventory rollup). */
  onHandBySku?: ReadonlyMap<string, number>;
}

const GRID = "grid grid-cols-[minmax(0,1.6fr)_minmax(0,1.3fr)_minmax(0,1.1fr)_minmax(0,0.8fr)_auto] items-center gap-3";

const NONE = <span className="text-muted-foreground/60">—</span>;

export function LaunchMemberList({ launch, todayIso, canEdit, onAddProducts, inbound = EMPTY_INBOUND, onHandBySku }: Props) {
  const items = launchMemberItems(launch);

  return (
    <div className="overflow-hidden rounded-lg border border-border/60">
      {items.length > 0 && (
        <div className={`${GRID} border-b border-border/60 bg-muted/30 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground`}>
          <span>Product</span>
          <span>State</span>
          <span>Date</span>
          <span>Risk</span>
          <span className="w-12" />
        </div>
      )}
      {items.map((it) => {
        // A live card without a member row (should not happen) reads through a row built from the card.
        const row: LaunchMemberRow =
          it.kind === "card"
            ? it.row ?? { id: it.card.id, sku_id: it.card.linked_sku_id, planned_name: it.card.name, pd_project_id: it.card.id }
            : it.row;
        const state = memberState(row, launch, inbound, todayIso);
        const sku = it.kind === "card" ? it.row?.product?.sku ?? null : it.sku;
        const name = it.kind === "card" ? it.card.name : it.name;
        return (
          <div key={it.key} className={`${GRID} border-b border-border/40 px-3 py-2 text-sm tabular-nums`}>
            <span className="flex min-w-0 items-center gap-2">
              {sku && <span className="shrink-0 font-mono text-xs">{sku}</span>}
              <span className={`min-w-0 truncate ${it.kind === "card" ? "font-medium" : ""}`} title={name}>{name}</span>
              {it.kind === "card" && state.kind === "development" && !followsLaunch(it.card) && <OwnDateChip date={it.card.target_launch_date} />}
            </span>
            <StateCell state={state} row={row} onHand={onHandBySku?.get(row.sku_id ?? "")} />
            <DateCell state={state} />
            <RiskCell state={state} />
            {it.kind === "card" ? <OpenLink card={it.card} /> : <span className="w-12" />}
          </div>
        );
      })}
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

/** Chip (stage / Ordered / Shipped / Arrived) with the row's detail; a plain row's stock reading. */
function StateCell({ state, row, onHand }: { state: MemberState; row: LaunchMemberRow; onHand: number | undefined }) {
  if (state.kind === "plain") {
    const reading = stockReading(row, onHand);
    return (
      <span className="flex min-w-0 flex-col">
        <span className="truncate">{reading ?? NONE}</span>
        {state.detail && <span className="truncate text-[10px] text-muted-foreground" title={state.detail}>{state.detail}</span>}
      </span>
    );
  }
  return (
    <span className="flex min-w-0 flex-col items-start gap-0.5">
      <StageChip label={state.label} tone={state.kind === "arrived" ? "ok" : "default"} />
      {state.detail && <span className="w-full truncate text-[10px] text-muted-foreground" title={state.detail}>{state.detail}</span>}
    </span>
  );
}

/** The row's one date ("Factory due Oct 7", "ETA Oct 30", "Arrived Sep 22", a next deadline) over the launch date it is judged against. */
function DateCell({ state }: { state: MemberState }) {
  if (!state.date) return NONE;
  return (
    <span className="flex min-w-0 flex-col">
      <span className="truncate whitespace-nowrap">{state.date.label} {fmtDay(state.date.value)}</span>
      {state.against && (
        <span className="whitespace-nowrap text-[10px] text-muted-foreground">
          {state.against.label.toLowerCase()} {fmtDay(state.against.value)}
        </span>
      )}
    </span>
  );
}

function RiskCell({ state }: { state: MemberState }) {
  if (state.kind === "halted" || state.kind === "plain" || !state.risk) return NONE;
  const words = state.against ? slackText(state.against.slackDays) : state.kind === "arrived" ? null : state.date ? relDays(state.date.days) : null;
  return (
    <span className="flex items-center gap-1.5 whitespace-nowrap">
      <RiskDotMark dot={state.risk} />
      {words && <span className="text-xs text-muted-foreground">{words}</span>}
    </span>
  );
}

function OpenLink({ card }: { card: MktLaunchCard }) {
  return (
    <Link
      to={`/marketing/product-development?card=${card.id}`}
      className="inline-flex w-12 items-center justify-end gap-0.5 text-xs text-muted-foreground hover:text-foreground"
    >
      Open <ChevronRight className="h-3 w-3" />
    </Link>
  );
}
