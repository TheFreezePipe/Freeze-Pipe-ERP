import { Fragment, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Plus, Rocket, Pencil, Trash2, ChevronDown, ChevronRight } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  useLaunches,
  useDeleteLaunch,
  useInventory,
  useLaunchFactorySupply,
  useLaunchInbound,
  usePdBoard,
  type MktLaunchWithMembers,
} from "@/lib/hooks";
import { useSetLaunchApproval } from "@/lib/hooks/use-marketing-signals";
import { useAuth } from "@/lib/auth-context";
import { LaunchFormDialog } from "@/components/marketing/LaunchFormDialog";
import { ConfirmCell } from "@/components/marketing/ConfirmCell";
import { AddProductsDialog } from "@/components/marketing/AddProductsDialog";
import { LaunchSupplyTable } from "@/components/marketing/LaunchSupplyTable";
import { RiskDotMark, VerdictMark } from "@/components/marketing/LaunchLinkParts";
import { launchKindLabel } from "@/components/marketing/launch-format";
import { launchPhase, LAUNCH_PHASE_COLOR, LAUNCH_PHASE_LABEL, isPastKey, dayKeyOf } from "@/lib/marketing-format";
import { toast } from "@/hooks/use-toast";
import { describeError } from "@/lib/supabase-error";
import { format, parseISO } from "date-fns";
import { EMPTY_INBOUND, launchOrderBy, launchReadyBy, launchSkuIds } from "@/lib/marketing/launch-link";
import {
  EMPTY_FACTORY_SUPPLY,
  EMPTY_SPLIT,
  launchProducts,
  launchRollup,
  splitTotal,
  warehouseBySku,
  type LaunchSupplyContext,
  type Tone,
} from "@/lib/marketing/launch-supply";
import { launchMemberItems, taggedDropHints } from "@/components/marketing/launch-members";

function fmt(d: string | null): string {
  if (!d) return "—";
  try { return format(parseISO(d), "MMM d, yyyy"); } catch { return d; }
}

/** The Status cell's verdict chip for an upcoming launch (launchRollup's chip), by tone. */
const CHIP = "inline-flex w-fit items-center gap-1.5 whitespace-nowrap rounded border px-1.5 py-0.5 text-[10px] tabular-nums";
const CHIP_TONE: Record<Tone, string> = {
  g: `${CHIP} border-green-500/30 bg-green-500/10 text-green-400`,
  a: `${CHIP} border-amber-500/40 bg-amber-500/10 text-amber-400`,
  r: `${CHIP} border-red-500/40 bg-red-500/10 text-red-400`,
};

export default function Launches() {
  const { data: launches = [], isLoading } = useLaunches();
  const { data: inventory = [] } = useInventory();
  const { isAdmin, isManager, profile } = useAuth();
  const canEdit = isAdmin || isManager;
  const del = useDeleteLaunch();
  const todayKey = format(new Date(), "yyyy-MM-dd");
  const setApproval = useSetLaunchApproval();

  // Warehouse buckets per SKU — the ledgers' stock rows, and the "Sold out"
  // reading once a launched product has nothing left in the building.
  const warehouse = useMemo(() => warehouseBySku(inventory), [inventory]);
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

  // Supply for every SKU on a launch, one query each: inbound freight and the
  // open factory orders. With the warehouse buckets they are the context
  // every product's ledger reads, so the collapsed row, its Status chip and
  // the expanded table show the same numbers.
  const skuIds = useMemo(() => launchSkuIds(launches), [launches]);
  const { data: inbound = EMPTY_INBOUND } = useLaunchInbound(skuIds);
  const { data: factory = EMPTY_FACTORY_SUPPLY } = useLaunchFactorySupply(skuIds);
  const ctx = useMemo<LaunchSupplyContext>(() => ({ warehouse, inbound, factory }), [warehouse, inbound, factory]);

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
    const soldCount = realMembers.filter((m) => splitTotal(warehouse.get(m.sku_id!) ?? EMPTY_SPLIT) <= 0).length;
    const total = realMembers.length;
    const allSold = total > 0 && soldCount === total;
    const phase = launchPhase(l.launch_date, todayKey, allSold, l.early_access_date);
    const isOpen = expanded.has(l.id);
    // One array per launch: the row's mark, words and chip and the expanded table read it alike.
    const products = launchProducts(items, l, ctx, todayKey);
    const roll = launchRollup(products, l);
    const readyBy = launchReadyBy(l);
    const orderBy = launchOrderBy(l);
    // The order-by date matters only while it can still be acted on: upcoming, and either still
    // ahead or with a product whose supply falls short of its need.
    const showOrderBy = !!orderBy && phase === "upcoming" && (todayKey <= orderBy || roll.counts.short > 0);
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
            <RiskDotMark dot={roll.tone} />
            {roll.text}
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
              {phase === "upcoming" && roll.chip && (
                <span className={CHIP_TONE[roll.chip.tone]}>
                  <VerdictMark tone={roll.chip.tone} />
                  {roll.chip.text}
                </span>
              )}
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
            <LaunchSupplyTable
              launch={l}
              products={products}
              todayIso={todayKey}
              canEdit={canEdit}
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
                <col className="w-[200px]" />
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
