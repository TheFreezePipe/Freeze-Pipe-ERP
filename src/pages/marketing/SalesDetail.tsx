import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { ArrowLeft, Pencil, Trash2, Plus, TrendingUp } from "lucide-react";
import { useSaleLift } from "@/lib/hooks/use-marketing-signals";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  useSaleWithOffers,
  useDeleteSale,
  useDeleteOffer,
  type MktOfferWithSkus,
} from "@/lib/hooks";
import { useAuth } from "@/lib/auth-context";
import { SaleFormDialog } from "@/components/marketing/SaleFormDialog";
import { OfferFormDialog } from "@/components/marketing/OfferFormDialog";
import { describeOffer, salePhase, PHASE_COLOR, isPastKey, dayKeyOf } from "@/lib/marketing-format";
import { toast } from "@/hooks/use-toast";
import { describeError } from "@/lib/supabase-error";
import { format, parseISO } from "date-fns";

function fmt(d: string | null): string {
  if (!d) return "—";
  try { return format(parseISO(d), "MMM d, yyyy"); } catch { return d; }
}

/** Post-sale outcomes: units during the window vs the trailing-28d
 *  pre-sale baseline, per affected SKU. Computed nightly by
 *  rpc_compute_marketing_outcomes into mkt_sale_sku_lift. */
function SalePerformance({ saleId }: { saleId: string }) {
  const { data: rows = [], isLoading } = useSaleLift(saleId);
  if (isLoading) return null;
  if (rows.length === 0) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <TrendingUp className="h-4 w-4" /> Performance
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Outcomes compute overnight once the sale has ended (and need the
            sale's offers to cover at least one SKU).
          </p>
        </CardContent>
      </Card>
    );
  }
  const totalUnits = rows.reduce((s, r) => s + r.units_during, 0);
  // Overall lift only aggregates SKUs that HAD a pre-sale baseline. Including
  // zero-baseline SKUs (new products) would add their units to the numerator
  // with nothing in the denominator, inflating the headline lift.
  const baselined = rows.filter((r) => r.baseline_daily > 0);
  const liftUnits = baselined.reduce((s, r) => s + r.units_during, 0);
  const expectedUnits = baselined.reduce((s, r) => s + r.baseline_daily * r.days, 0);
  const overallLift = expectedUnits > 0 ? Math.round((liftUnits / expectedUnits - 1) * 100) : null;
  const noBaselineCount = rows.length - baselined.length;
  const liftColor = (v: number | null) =>
    v == null ? "text-muted-foreground" : v >= 0 ? "text-green-400" : "text-red-400";
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <TrendingUp className="h-4 w-4" /> Performance
          <span className="text-sm font-normal text-muted-foreground">
            {totalUnits.toLocaleString()} units during the sale
            {overallLift != null && (
              <> · <span className={liftColor(overallLift)}>{overallLift >= 0 ? "+" : ""}{overallLift}% vs baseline</span></>
            )}
            {noBaselineCount > 0 && (
              <> · <span title="Excluded from the lift figure — no pre-sale sales history to compare against">{noBaselineCount} new SKU{noBaselineCount > 1 ? "s" : ""} w/o baseline</span></>
            )}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <table className="w-full text-sm">
          <thead className="border-b border-border/50 text-left text-xs uppercase tracking-wider text-muted-foreground">
            <tr>
              <th className="px-4 py-2">SKU</th>
              <th className="px-3 py-2 text-right">Units during</th>
              <th className="px-3 py-2 text-right">Baseline/day</th>
              <th className="px-3 py-2 text-right">Lift</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 10).map((r) => (
              <tr key={r.sku_id} className="border-b border-border/40 last:border-0">
                <td className="px-4 py-2">
                  <span className="font-mono">{r.sku}</span>
                  <span className="ml-2 text-xs text-muted-foreground">{r.product_name}</span>
                </td>
                <td className="px-3 py-2 text-right tabular-nums font-medium">{r.units_during.toLocaleString()}</td>
                <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{r.baseline_daily.toFixed(1)}</td>
                <td className={`px-3 py-2 text-right tabular-nums ${liftColor(r.lift_pct)}`}>
                  {r.lift_pct == null ? "—" : `${r.lift_pct >= 0 ? "+" : ""}${r.lift_pct}%`}
                </td>
              </tr>
            ))}
            {rows.length > 10 && (
              <tr><td colSpan={4} className="px-4 py-2 text-xs text-muted-foreground">+{rows.length - 10} more SKUs</td></tr>
            )}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

export default function SalesDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: sale, isLoading } = useSaleWithOffers(id);
  const { isAdmin, isManager } = useAuth();
  const canEdit = isAdmin || isManager;
  const todayKey = format(new Date(), "yyyy-MM-dd");
  const deleteSale = useDeleteSale();
  const deleteOffer = useDeleteOffer();

  const [editSaleOpen, setEditSaleOpen] = useState(false);
  const [offerOpen, setOfferOpen] = useState(false);
  const [editingOffer, setEditingOffer] = useState<MktOfferWithSkus | null>(null);

  if (isLoading) {
    return <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">Loading sale…</div>;
  }
  if (!sale) {
    return (
      <div className="space-y-4 max-w-3xl">
        <Button variant="ghost" size="sm" onClick={() => navigate("/marketing/sales")}>
          <ArrowLeft className="mr-2 h-4 w-4" /> Back
        </Button>
        <p className="text-sm text-muted-foreground">Sale not found.</p>
      </div>
    );
  }

  async function handleDeleteSale() {
    if (!sale) return;
    if (!window.confirm(`Delete "${sale.name}" and all its offers? This can't be undone.`)) return;
    try {
      await deleteSale.mutateAsync(sale.id);
      toast({ title: "Sale deleted" });
      navigate("/marketing/sales");
    } catch (err) {
      toast({ title: "Couldn't delete", description: describeError(err), variant: "destructive" });
    }
  }

  async function handleDeleteOffer(offer: MktOfferWithSkus) {
    if (!sale) return;
    if (!window.confirm(`Delete offer "${offer.label}"?`)) return;
    try {
      await deleteOffer.mutateAsync({ id: offer.id, saleId: sale.id });
      toast({ title: "Offer deleted" });
    } catch (err) {
      toast({ title: "Couldn't delete", description: describeError(err), variant: "destructive" });
    }
  }

  const offers = sale.offers ?? [];

  return (
    <div className="space-y-6 max-w-3xl">
      <SaleFormDialog
        open={editSaleOpen}
        onOpenChange={setEditSaleOpen}
        sale={sale}
        datesLocked={isPastKey(dayKeyOf(sale.starts_at), todayKey)}
      />
      <OfferFormDialog open={offerOpen} onOpenChange={setOfferOpen} saleId={sale.id} />
      <OfferFormDialog
        open={!!editingOffer}
        onOpenChange={(o) => !o && setEditingOffer(null)}
        saleId={sale.id}
        offer={editingOffer}
      />

      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate("/marketing/sales")}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <h1 className="text-2xl font-bold">{sale.name}</h1>
        {(() => {
          const p = salePhase(sale.starts_at, sale.ends_at, todayKey);
          return p ? (
            <span className={`rounded px-2 py-0.5 text-xs capitalize ${PHASE_COLOR[p]}`}>{p}</span>
          ) : null;
        })()}
      </div>

      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">Details</CardTitle>
            {canEdit && (
              <div className="flex gap-1">
                <Button variant="outline" size="sm" onClick={() => setEditSaleOpen(true)}>
                  <Pencil className="mr-2 h-3.5 w-3.5" /> Edit
                </Button>
                <Button variant="ghost" size="sm" className="text-red-400 hover:text-red-300" onClick={handleDeleteSale}>
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div className="flex gap-2">
            <span className="w-28 text-muted-foreground">Runs</span>
            <span className="tabular-nums">{fmt(sale.starts_at)} → {fmt(sale.ends_at)}</span>
          </div>
          {sale.notes && (
            <div className="flex gap-2">
              <span className="w-28 shrink-0 text-muted-foreground">Notes</span>
              <span className="whitespace-pre-wrap">{sale.notes}</span>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">Offers <span className="text-sm font-normal text-muted-foreground">({offers.length})</span></CardTitle>
            {canEdit && (
              <Button size="sm" onClick={() => setOfferOpen(true)}>
                <Plus className="mr-2 h-4 w-4" /> Add offer
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          {offers.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">No offers yet — add the codes / discounts that make up this sale.</p>
          ) : (
            offers.map((o) => {
              const d = describeOffer(o, o.free_item?.product_name);
              return (
                <div key={o.id} className="flex items-center justify-between rounded-lg border border-border/50 p-3">
                  <div className="min-w-0">
                    <p className="font-medium">{o.label}</p>
                    <p className="text-xs text-muted-foreground">
                      <span className="text-foreground/80">{d.deal}</span>
                      <span className="mx-1.5">·</span>{d.target}
                      {d.code && (
                        <>
                          <span className="mx-1.5">·</span>
                          code <span className="font-mono text-foreground/80">{d.code}</span>
                        </>
                      )}
                      {o.scope === "sku_set" && (
                        <span className="ml-1.5 text-muted-foreground/70">({o.offer_skus?.length ?? 0} SKUs)</span>
                      )}
                    </p>
                  </div>
                  {canEdit && (
                    <div className="flex shrink-0 gap-1">
                      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setEditingOffer(o)}>
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button variant="ghost" size="icon" className="h-7 w-7 text-red-400 hover:text-red-300" onClick={() => handleDeleteOffer(o)}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </CardContent>
      </Card>

      {salePhase(sale.starts_at, sale.ends_at, todayKey) === "ended" && (
        <SalePerformance saleId={sale.id} />
      )}
    </div>
  );
}
