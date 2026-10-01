import { Fragment, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Plus, Rocket, Pencil, Trash2, ChevronDown, ChevronRight } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  useLaunches,
  useDeleteLaunch,
  useInventory,
  useFactoryOrders,
  useLaunchInbound,
  usePdBoard,
  type MktLaunchWithMembers,
} from "@/lib/hooks";
import { useSetLaunchApproval } from "@/lib/hooks/use-marketing-signals";
import { useAuth } from "@/lib/auth-context";
import { LaunchFormDialog } from "@/components/marketing/LaunchFormDialog";
import { ConfirmCell } from "@/components/marketing/ConfirmCell";
import { AddProductsDialog } from "@/components/marketing/AddProductsDialog";
import { LaunchMemberList } from "@/components/marketing/LaunchMemberList";
import { RiskDotMark } from "@/components/marketing/LaunchLinkParts";
import { launchKindLabel, stockSignal, type StockSignal } from "@/components/marketing/launch-format";
import { launchPhase, LAUNCH_PHASE_COLOR, LAUNCH_PHASE_LABEL, isPastKey, dayKeyOf } from "@/lib/marketing-format";
import { toast } from "@/hooks/use-toast";
import { describeError } from "@/lib/supabase-error";
import { format, parseISO } from "date-fns";
import {
  EMPTY_INBOUND,
  incomingDatesBySku,
  launchHealth,
  launchHealthText,
  launchOrderBy,
  launchReadyBy,
  launchSkuIds,
  memberStocked,
} from "@/lib/marketing/launch-link";
import { launchMemberItems, taggedDropHints } from "@/components/marketing/launch-members";

function fmt(d: string | null): string {
  if (!d) return "—";
  try { return format(parseISO(d), "MMM d, yyyy"); } catch { return d; }
}

const CHIP = "w-fit whitespace-nowrap rounded border px-1.5 py-0.5 text-[10px]";
const CHIP_RED = `${CHIP} border-red-500/40 bg-red-500/10 text-red-400`;
const CHIP_AMBER = `${CHIP} border-amber-500/40 bg-amber-500/10 text-amber-400`;
const CHIP_CYAN = `${CHIP} border-cyan-500/30 bg-cyan-500/10 text-cyan-300`;
const CHIP_GREEN = `${CHIP} border-green-500/30 bg-green-500/10 text-green-400`;

/** One chip per upcoming launch: the stock signal (launch-format's stockSignal) as the Status cell shows it. */
function stockSignalChip(s: StockSignal): ReactNode {
  switch (s?.kind) {
    case "uncovered":
      return (
        <span className={CHIP_RED} title={s.skus.join(", ")}>
          ⚠ {s.skus.length} SKU{s.skus.length > 1 ? "s" : ""} not covered by launch
        </span>
      );
    case "window_passed":
      return <span className={CHIP_RED}>order window passed ({fmt(s.orderBy)})</span>;
    case "order_by":
      return <span className={CHIP_AMBER}>order by {fmt(s.orderBy)}</span>;
    case "incoming_overdue":
      return <span className={CHIP_AMBER}>incoming overdue ({fmt(s.date)})</span>;
    case "incoming":
      return <span className={CHIP_CYAN}>incoming by {fmt(s.date)}</span>;
    case "stocked":
      return <span className={CHIP_GREEN}>stock on hand</span>;
    default:
      // A quiet order-by date needs no chip: the Date column shows it while it can still be acted on.
      return null;
  }
}

export default function Launches() {
  const { data: launches = [], isLoading } = useLaunches();
  const { data: inventory = [] } = useInventory();
  const { isAdmin, isManager, profile } = useAuth();
  const canEdit = isAdmin || isManager;
  const del = useDeleteLaunch();
  const todayKey = format(new Date(), "yyyy-MM-dd");
  const setApproval = useSetLaunchApproval();

  // Total on-hand units per SKU — a launch reads "Sold out" once its linked
  // SKU has nothing left in the building.
  const onHandBySku = useMemo(() => {
    const m = new Map<string, number>();
    for (const inv of inventory) {
      m.set(
        inv.sku_id,
        (inv.warehouse_raw ?? 0) +
          (inv.warehouse_prefilled_raw ?? 0) +
          (inv.warehouse_in_production ?? 0) +
          (inv.warehouse_finished ?? 0) +
          (inv.warehouse_other ?? 0),
      );
    }
    return m;
  }, [inventory]);
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<MktLaunchWithMembers | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  // The id outlives the open flag so the dialog keeps its launch while it animates closed.
  const [addingId, setAddingId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const adding = addingId ? launches.find((l) => l.id === addingId) ?? null : null;
  function openAddProducts(id: string) {
    setAddingId(id);
    setAddOpen(true);
  }

  function toggleExpanded(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // Unattached board cards whose drop names an upcoming launch: "4 cards
  // tagged Alien Studio" under that launch's product chip.
  const { data: board = [] } = usePdBoard();
  const taggedHints = useMemo(() => taggedDropHints(board, launches, todayKey), [board, launches, todayKey]);

  // Inbound freight for every SKU on a launch (one query): an ordered product
  // with units on the water reads Shipped, judged by its ETA.
  const skuIds = useMemo(() => launchSkuIds(launches), [launches]);
  const { data: inbound = EMPTY_INBOUND } = useLaunchInbound(skuIds);

  // The Status chip's incoming date per SKU — the same date the product rows
  // show (the freight ETA once units are on the water, else the open factory
  // order's due date), from the same inbound map, so chip and rows agree.
  const { data: factoryOrders = [] } = useFactoryOrders();
  const incomingBySku = useMemo(() => incomingDatesBySku(skuIds, inbound, factoryOrders), [skuIds, inbound, factoryOrders]);

  // Upcoming first (soonest on top, undated leading — they need a date),
  // then past newest-first under a quiet divider.
  const { upcoming, past } = useMemo(() => {
    const up: MktLaunchWithMembers[] = [];
    const pa: MktLaunchWithMembers[] = [];
    for (const l of launches) {
      (l.launch_date && isPastKey(dayKeyOf(l.launch_date), todayKey) ? pa : up).push(l);
    }
    up.sort((a, b) => (a.launch_date ?? "").localeCompare(b.launch_date ?? ""));
    pa.sort((a, b) => (b.launch_date ?? "").localeCompare(a.launch_date ?? ""));
    return { upcoming: up, past: pa };
  }, [launches, todayKey]);

  async function handleDelete(l: MktLaunchWithMembers) {
    if (!window.confirm(`Delete "${l.name}"?`)) return;
    try {
      await del.mutateAsync(l.id);
      toast({ title: "Launch deleted" });
    } catch (err) {
      toast({ title: "Couldn't delete", description: describeError(err), variant: "destructive" });
    }
  }

  // A render function, not a nested component: a component declared here would be a new type every
  // render, remounting every row (and dropping keyboard focus) on each expand toggle.
  function renderRow(l: MktLaunchWithMembers) {
    // The products as every screen counts them: member rows minus halted cards' rows.
    const items = launchMemberItems(l);
    const memberLabels = items.map((it) =>
      it.kind === "card" ? it.row?.product?.sku || it.card.name : it.sku || it.name || "?",
    );
    // The subtitle names at most two products; the full list is one click away
    // in the expanded product rows. A long list here used to force the whole
    // table wider than the page (Status and Confirm ended up off-screen).
    const memberSummary =
      memberLabels.length <= 2
        ? memberLabels.join(", ")
        : `${memberLabels.slice(0, 2).join(", ")} +${memberLabels.length - 2} more`;
    const rows = items.map((it) => it.row).filter((r): r is NonNullable<typeof r> => !!r);
    const realMembers = rows.filter((m) => m.sku_id);
    const soldCount = realMembers.filter((m) => (onHandBySku.get(m.sku_id!) ?? 0) <= 0).length;
    const total = realMembers.length;
    const allSold = total > 0 && soldCount === total;
    const phase = launchPhase(l.launch_date, todayKey, allSold, l.early_access_date);
    const isOpen = expanded.has(l.id);
    // health.count is launchProductCount(l) — the one product count every screen uses.
    const health = launchHealth(l, inbound, todayKey);
    const readyBy = launchReadyBy(l);
    const orderBy = launchOrderBy(l);
    const signal = phase === "upcoming" ? stockSignal(realMembers, l, onHandBySku, incomingBySku, todayKey) : null;
    // The order-by date matters only while it can still be acted on: upcoming, and either still
    // ahead or with short SKUs nothing incoming covers (stockSignal's "window passed").
    const showOrderBy =
      !!orderBy &&
      phase === "upcoming" &&
      (todayKey <= orderBy ||
        realMembers.some((m) => !memberStocked(m, onHandBySku.get(m.sku_id!) ?? 0) && !incomingBySku.has(m.sku_id!)));
    const hints = taggedHints.get(l.id) ?? [];
    return (
      <Fragment key={l.id}>
      <tr className={`border-t border-border/40 hover:bg-muted/20 ${isOpen ? "bg-muted/10" : ""}`}>
        <td className="px-4 py-3">
          <p className="font-medium">
            {l.name}
            {/* Drafted from a Product Development card — link back to it. */}
            {l.pd_project_id && (
              <Link
                to={`/marketing/product-development?card=${l.pd_project_id}`}
                onClick={(e) => e.stopPropagation()}
                className="ml-2 rounded border border-primary/40 px-1.5 py-0.5 text-[10px] font-normal text-primary hover:bg-primary/10"
              >
                from PD
              </Link>
            )}
          </p>
          <p className="mt-0.5 truncate text-xs text-muted-foreground" title={memberLabels.join(", ")}>
            <span>{launchKindLabel(l.kind)}</span>
            {memberLabels.length > 0 && <> · {memberSummary}</>}
          </p>
        </td>
        <td className="whitespace-nowrap px-4 py-3 tabular-nums">
          {fmt(l.launch_date)}
          {l.early_access_date && (
            <p className="text-[10px] text-violet-400">EA {fmt(l.early_access_date)}</p>
          )}
          {readyBy && (
            <p className="text-[10px] text-muted-foreground">ready by {fmt(readyBy)}</p>
          )}
          {showOrderBy && (
            <p className="text-[10px] text-muted-foreground">order by {fmt(orderBy)}</p>
          )}
        </td>
        <td className="px-4 py-3">
          <button
            type="button"
            onClick={() => toggleExpanded(l.id)}
            aria-expanded={isOpen}
            className="inline-flex items-center gap-1.5 whitespace-nowrap rounded px-1 py-0.5 text-xs hover:bg-muted/40"
          >
            <RiskDotMark dot={health.worst} />
            {launchHealthText(health)}
            {isOpen ? <ChevronDown className="h-3 w-3 text-muted-foreground" /> : <ChevronRight className="h-3 w-3 text-muted-foreground" />}
          </button>
          {canEdit && hints.map((h) => (
            <button
              key={h.tag}
              type="button"
              onClick={() => openAddProducts(l.id)}
              className="mt-0.5 block whitespace-nowrap px-1 text-left text-[10px] text-muted-foreground hover:text-foreground hover:underline"
            >
              {h.count} {h.count === 1 ? "card" : "cards"} tagged {h.tag}
            </button>
          ))}
        </td>
        <td className="px-4 py-3">
          {!phase ? (
            <span className="text-xs text-muted-foreground/60">no date</span>
          ) : (
            <div className="flex flex-col gap-0.5">
              <span className={`w-fit whitespace-nowrap rounded px-2 py-0.5 text-xs ${LAUNCH_PHASE_COLOR[phase]}`}>{LAUNCH_PHASE_LABEL[phase]}</span>
              {phase === "launched" && soldCount > 0 && (
                <span className="text-[10px] text-amber-400/80">{soldCount} of {total} sold out</span>
              )}
              {stockSignalChip(signal)}
              {/* Outcomes once the 30d window has elapsed */}
              {phase !== "upcoming" && realMembers.some((m) => m.actual_first_30d_units != null || m.sold_out_at) && (
                <div className="text-[10px] text-muted-foreground space-y-0">
                  {realMembers.filter((m) => m.actual_first_30d_units != null || m.sold_out_at).map((m) => (
                    <p key={m.id}>
                      <span className="font-mono">{m.product?.sku ?? "?"}</span>
                      {m.actual_first_30d_units != null && (
                        <> · 30d: <span className="text-foreground">{m.actual_first_30d_units}</span>{m.expected_first_30d_units != null && <> vs {m.expected_first_30d_units} expected</>}</>
                      )}
                      {m.sold_out_at && <> · <span className="text-amber-400">sold out {fmt(m.sold_out_at)}</span></>}
                    </p>
                  ))}
                </div>
              )}
            </div>
          )}
        </td>
        <td className="px-4 py-3">
          <ConfirmCell
            status={(l as MktLaunchWithMembers & { approval_status?: string }).approval_status}
            canEdit={canEdit && !!profile?.id}
            pending={setApproval.isPending}
            onSet={(confirmed) =>
              setApproval.mutate({ id: l.id, status: confirmed ? "confirmed" : "draft", actorId: profile!.id })
            }
          />
        </td>
        <td className="px-4 py-3 text-right">
          {canEdit && (
            <div className="flex justify-end gap-1">
              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setEditing(l)}>
                <Pencil className="h-3.5 w-3.5" />
              </Button>
              <Button variant="ghost" size="icon" className="h-7 w-7 text-red-400 hover:text-red-300" onClick={() => handleDelete(l)}>
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          )}
        </td>
      </tr>
      {isOpen && (
        <tr className="bg-muted/10">
          <td colSpan={6} className="px-4 pb-4 pt-0">
            <LaunchMemberList
              launch={l}
              todayIso={todayKey}
              canEdit={canEdit}
              inbound={inbound}
              onHandBySku={onHandBySku}
              onAddProducts={() => openAddProducts(l.id)}
            />
          </td>
        </tr>
      )}
      </Fragment>
    );
  }

  return (
    <div className="space-y-6 max-w-5xl">
      <LaunchFormDialog open={createOpen} onOpenChange={setCreateOpen} />
      <LaunchFormDialog
        open={!!editing}
        onOpenChange={(o) => !o && setEditing(null)}
        launch={editing}
        datesLocked={!!editing && isPastKey(dayKeyOf(editing.launch_date), todayKey)}
      />
      <AddProductsDialog open={addOpen} launch={adding} todayIso={todayKey} onClose={() => setAddOpen(false)} />

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Launches &amp; Drops</h1>
          <p className="text-muted-foreground">New products, limited drops, and restocks</p>
        </div>
        {canEdit && (
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="mr-2 h-4 w-4" /> New Launch
          </Button>
        )}
      </div>

      {isLoading ? (
        <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">Loading launches…</div>
      ) : launches.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <Rocket className="h-8 w-8 text-muted-foreground/50" />
            <p className="text-sm text-muted-foreground">No launches planned yet.</p>
            {canEdit && (
              <Button variant="outline" size="sm" onClick={() => setCreateOpen(true)}>
                <Plus className="mr-2 h-4 w-4" /> Plan a launch
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="overflow-x-auto p-0">
            {/* Fixed layout: every column but Launch has a set width, so the
                table fits any page 1,024px and wider and the Launch cell
                truncates instead of stretching the row. Below 880px the
                card scrolls sideways as a fallback. */}
            <table className="w-full min-w-[860px] table-fixed text-sm">
              <colgroup>
                <col />
                <col className="w-[140px]" />
                <col className="w-[160px]" />
                <col className="w-[176px]" />
                <col className="w-[108px]" />
                <col className="w-[76px]" />
              </colgroup>
              <thead className="border-b border-border/50 text-left text-muted-foreground">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Launch</th>
                  <th className="px-4 py-2.5 font-medium">Date</th>
                  <th className="px-4 py-2.5 font-medium">Products</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                  <th className="px-4 py-2.5 font-medium">Confirmed</th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {upcoming.map(renderRow)}
                {upcoming.length > 0 && past.length > 0 && (
                  <tr className="border-t border-border/40">
                    <td colSpan={6} className="px-4 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">
                      Past
                    </td>
                  </tr>
                )}
                {past.map(renderRow)}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
