import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Plus, Tag, Pencil } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useSales, type MktSale, type MktSaleListRow } from "@/lib/hooks";
import { useSetSaleApproval } from "@/lib/hooks/use-marketing-signals";
import { ConfirmCell } from "@/components/marketing/ConfirmCell";
import { useAuth } from "@/lib/auth-context";
import { SaleFormDialog } from "@/components/marketing/SaleFormDialog";
import { SaleResultCell } from "@/components/marketing/sale/SaleResultCell";
import { salePhase, PHASE_COLOR, PHASE_LABEL, isPastKey, dayKeyOf } from "@/lib/marketing-format";
import { format } from "date-fns";

/** Stored calendar day, parsed as a local date so a UTC-midnight timestamp never reads as the day before. */
function localDay(d: string | null): Date | null {
  const key = dayKeyOf(d);
  if (!key) return null;
  const [y, m, day] = key.split("-").map(Number);
  return y && m && day ? new Date(y, m - 1, day) : null;
}
function fmt(d: string | null): string {
  const dt = localDay(d);
  return dt ? format(dt, "MMM d, yyyy") : "—";
}
function fmtDay(d: string | null): string {
  const dt = localDay(d);
  return dt ? format(dt, "MMM d") : "—";
}
/** "Oct 5 – 9, 2026" when the sale stays in one month, "Nov 12 – Dec 1, 2026" otherwise. */
function range(s: string | null, e: string | null): string {
  const a = localDay(s), b = localDay(e);
  if (!a && !b) return "No dates set";
  if (!a || !b) return `${fmt(s)} → ${fmt(e)}`;
  if (a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth()) return `${format(a, "MMM d")} – ${format(b, "d, yyyy")}`;
  if (a.getFullYear() === b.getFullYear()) return `${format(a, "MMM d")} – ${format(b, "MMM d, yyyy")}`;
  return `${fmt(s)} – ${fmt(e)}`;
}

/** The offers as a short subtitle: at most two labels, then "+N". */
function offersSummary(offers: MktSaleListRow["offers"]): string {
  if (!offers?.length) return "No offers yet";
  const labels = offers.map((o) => o.label);
  if (labels.length <= 2) return labels.join(" · ");
  return `${labels[0]} · ${labels[1]} +${labels.length - 2}`;
}

export default function SalesList() {
  const navigate = useNavigate();
  const { data: sales = [], isLoading } = useSales();
  const { isAdmin, isManager, profile } = useAuth();
  const canEdit = isAdmin || isManager;
  const todayKey = format(new Date(), "yyyy-MM-dd");
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<MktSale | null>(null);
  const setApproval = useSetSaleApproval();

  // Same rule as Launches: upcoming first (soonest on top, undated leading —
  // they need dates), then past newest-first under a quiet divider. Live and
  // early-access sales are "upcoming" by this rule and sort to the top because
  // their start is the earliest still-relevant date.
  const { upcoming, past } = useMemo(() => {
    const up: MktSaleListRow[] = [];
    const pa: MktSaleListRow[] = [];
    for (const s of sales) {
      (s.ends_at && isPastKey(dayKeyOf(s.ends_at), todayKey) ? pa : up).push(s);
    }
    const startOf = (s: MktSaleListRow) => dayKeyOf(s.early_access_starts_at ?? s.starts_at) ?? "";
    up.sort((a, b) => startOf(a).localeCompare(startOf(b)));
    pa.sort((a, b) => startOf(b).localeCompare(startOf(a)));
    return { upcoming: up, past: pa };
  }, [sales, todayKey]);

  function renderRow(s: MktSaleListRow) {
    const p = salePhase(s.starts_at, s.ends_at, todayKey, s.early_access_starts_at);
    return (
      <tr
        key={s.id}
        className="cursor-pointer border-t border-border/40 hover:bg-muted/20"
        onClick={() => navigate(`/marketing/sales/${s.id}`)}
      >
        <td className="px-4 py-3">
          <p className="font-medium">{s.name}</p>
          <p className="mt-0.5 truncate text-xs text-muted-foreground" title={s.offers?.map((o) => o.label).join(", ")}>
            {s.offers?.length ? `${s.offers.length} ${s.offers.length === 1 ? "offer" : "offers"} · ` : ""}{offersSummary(s.offers)}
          </p>
        </td>
        <td className="whitespace-nowrap px-4 py-3 tabular-nums">
          {range(s.starts_at, s.ends_at)}
          {s.early_access_starts_at && (
            <p className="text-[10px] text-violet-400">EA {fmtDay(s.early_access_starts_at)}</p>
          )}
        </td>
        <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
          <SaleResultCell sale={s} todayKey={todayKey} />
        </td>
        <td className="px-4 py-3">
          {p ? (
            <span className={`whitespace-nowrap rounded px-2 py-0.5 text-xs ${PHASE_COLOR[p]}`}>{PHASE_LABEL[p]}</span>
          ) : (
            <span className="text-xs text-muted-foreground/60">no dates</span>
          )}
        </td>
        <td className="px-4 py-3">
          <ConfirmCell
            status={(s as MktSale & { approval_status?: string }).approval_status}
            canEdit={canEdit && !!profile?.id}
            pending={setApproval.isPending}
            onSet={(confirmed) =>
              setApproval.mutate({ id: s.id, status: confirmed ? "confirmed" : "draft", actorId: profile!.id })
            }
          />
        </td>
        <td className="px-4 py-3 text-right">
          {canEdit && (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={(e) => { e.stopPropagation(); setEditing(s); }}
            >
              <Pencil className="h-3.5 w-3.5" />
            </Button>
          )}
        </td>
      </tr>
    );
  }

  return (
    <div className="space-y-6 max-w-5xl">
      <SaleFormDialog open={createOpen} onOpenChange={setCreateOpen} />
      <SaleFormDialog
        open={!!editing}
        onOpenChange={(o) => !o && setEditing(null)}
        sale={editing}
        datesLocked={!!editing && isPastKey(dayKeyOf(editing.starts_at), todayKey)}
      />

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Sales</h1>
          <p className="text-muted-foreground">Promotions and their offers</p>
        </div>
        {canEdit && (
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="mr-2 h-4 w-4" /> New Sale
          </Button>
        )}
      </div>

      {isLoading ? (
        <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">Loading sales…</div>
      ) : sales.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <Tag className="h-8 w-8 text-muted-foreground/50" />
            <p className="text-sm text-muted-foreground">No sales yet.</p>
            {canEdit && (
              <Button variant="outline" size="sm" onClick={() => setCreateOpen(true)}>
                <Plus className="mr-2 h-4 w-4" /> Create your first sale
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="overflow-x-auto p-0">
            {/* Same shell as Launches: fixed layout, every column but the name has a set width. */}
            <table className="w-full min-w-[860px] table-fixed text-sm">
              <colgroup>
                <col />
                <col className="w-[170px]" />
                <col className="w-[300px]" />
                <col className="w-[110px]" />
                <col className="w-[108px]" />
                <col className="w-[56px]" />
              </colgroup>
              <thead className="border-b border-border/50 text-left text-muted-foreground">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Sale</th>
                  <th className="px-4 py-2.5 font-medium">Dates</th>
                  <th className="px-4 py-2.5 font-medium">Result</th>
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
