import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { ArrowLeft, Pencil, Trash2, Plus } from "lucide-react";
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
import { describeOffer, SALE_STATUS_COLOR, isPastKey, dayKeyOf } from "@/lib/marketing-format";
import { toast } from "@/hooks/use-toast";
import { describeError } from "@/lib/supabase-error";
import { format, parseISO } from "date-fns";

function fmt(d: string | null): string {
  if (!d) return "—";
  try { return format(parseISO(d), "MMM d, yyyy"); } catch { return d; }
}

export default function SalesDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: sale, isLoading } = useSaleWithOffers(id);
  const { isAdmin, isManager } = useAuth();
  const canEdit = isAdmin || isManager;
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
        datesLocked={isPastKey(dayKeyOf(sale.starts_at), format(new Date(), "yyyy-MM-dd"))}
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
        <span className={`rounded px-2 py-0.5 text-xs capitalize ${SALE_STATUS_COLOR[sale.status] ?? ""}`}>
          {sale.status}
        </span>
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
    </div>
  );
}
