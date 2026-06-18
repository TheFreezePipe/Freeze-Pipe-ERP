import { useEffect, useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { X } from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { describeError } from "@/lib/supabase-error";
import { DISPLAY_CATEGORIES } from "@/lib/constants";
import {
  useCreateOffer,
  useUpdateOffer,
  useSetOfferSkus,
  useProducts,
  type MktOfferWithSkus,
} from "@/lib/hooks";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  saleId: string;
  offer?: MktOfferWithSkus | null;
}

const NONE = "__none__";
const numOrNull = (s: string): number | null => {
  const t = s.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

export function OfferFormDialog({ open, onOpenChange, saleId, offer }: Props) {
  const { data: products = [] } = useProducts();
  const create = useCreateOffer();
  const update = useUpdateOffer();
  const setSkus = useSetOfferSkus();
  const editing = !!offer;

  const [label, setLabel] = useState("");
  const [code, setCode] = useState("");
  const [scope, setScope] = useState<string>("sitewide");
  const [category, setCategory] = useState<string>("");
  const [skuIds, setSkuIds] = useState<string[]>([]);
  const [percentOff, setPercentOff] = useState("");
  const [dollarOff, setDollarOff] = useState("");
  const [freeItem, setFreeItem] = useState<string>(NONE);
  const [minOrder, setMinOrder] = useState("");
  const [buyQty, setBuyQty] = useState("");
  const [getQty, setGetQty] = useState("");

  useEffect(() => {
    if (!open) return;
    setLabel(offer?.label ?? "");
    setCode(offer?.code ?? "");
    setScope(offer?.scope ?? "sitewide");
    setCategory(offer?.category ?? "");
    setSkuIds(offer?.offer_skus?.map((s) => s.sku_id) ?? []);
    setPercentOff(offer?.percent_off != null ? String(offer.percent_off) : "");
    setDollarOff(offer?.dollar_off != null ? String(offer.dollar_off) : "");
    setFreeItem(offer?.free_item_sku_id ?? NONE);
    setMinOrder(offer?.min_order_amount != null ? String(offer.min_order_amount) : "");
    setBuyQty(offer?.buy_qty != null ? String(offer.buy_qty) : "");
    setGetQty(offer?.get_qty != null ? String(offer.get_qty) : "");
  }, [open, offer]);

  const productById = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const pending = create.isPending || update.isPending || setSkus.isPending;

  async function handleSubmit() {
    if (!label.trim()) {
      toast({ title: "Label required", description: "Describe the offer.", variant: "destructive" });
      return;
    }
    if (scope === "category" && !category) {
      toast({ title: "Pick a category", variant: "destructive" });
      return;
    }
    if (scope === "sku_set" && skuIds.length === 0) {
      toast({ title: "Add at least one SKU", variant: "destructive" });
      return;
    }
    const payload = {
      sale_id: saleId,
      label: label.trim(),
      code: code.trim() || null,
      scope,
      category: scope === "category" ? category : null,
      percent_off: numOrNull(percentOff),
      dollar_off: numOrNull(dollarOff),
      free_item_sku_id: freeItem === NONE ? null : freeItem,
      min_order_amount: numOrNull(minOrder),
      buy_qty: numOrNull(buyQty),
      get_qty: numOrNull(getQty),
    };
    try {
      let offerId = offer?.id;
      if (editing && offer) {
        await update.mutateAsync({ id: offer.id, saleId, updates: payload });
      } else {
        const created = await create.mutateAsync(payload);
        offerId = created.id;
      }
      if (offerId) {
        // Keep the membership table in sync with the chosen scope.
        await setSkus.mutateAsync({
          offerId,
          saleId,
          skuIds: scope === "sku_set" ? skuIds : [],
        });
      }
      toast({ title: editing ? "Offer updated" : "Offer added" });
      onOpenChange(false);
    } catch (err) {
      toast({ title: "Couldn't save", description: describeError(err), variant: "destructive" });
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl max-h-[88vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit offer" : "Add offer"}</DialogTitle>
          <DialogDescription>
            Mix any components — percent, dollar, free item, threshold. Leave the rest blank.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Label</Label>
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. 20% off sitewide + free grinder" />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>Coupon code <span className="text-xs text-muted-foreground font-normal">optional</span></Label>
              <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="e.g. LOVE" className="font-mono" />
            </div>
            <div className="space-y-1.5">
              <Label>Applies to</Label>
              <Select value={scope} onValueChange={setScope}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="sitewide">Sitewide</SelectItem>
                  <SelectItem value="category">A category</SelectItem>
                  <SelectItem value="sku_set">Specific SKUs</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {scope === "category" && (
            <div className="space-y-1.5">
              <Label>Category</Label>
              <Select value={category} onValueChange={setCategory}>
                <SelectTrigger><SelectValue placeholder="Pick a category" /></SelectTrigger>
                <SelectContent>
                  {DISPLAY_CATEGORIES.map((c) => (
                    <SelectItem key={c} value={c}>{c}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {scope === "sku_set" && (
            <div className="space-y-1.5">
              <Label>SKUs</Label>
              <Select key={skuIds.length} onValueChange={(v) => setSkuIds((prev) => (prev.includes(v) ? prev : [...prev, v]))}>
                <SelectTrigger><SelectValue placeholder="Add a SKU…" /></SelectTrigger>
                <SelectContent>
                  {products.filter((p) => !skuIds.includes(p.id)).map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      <span className="font-mono text-xs">{p.sku}</span>
                      <span className="ml-2 text-muted-foreground">{p.product_name}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {skuIds.length > 0 && (
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {skuIds.map((id) => (
                    <span key={id} className="inline-flex items-center gap-1 rounded bg-muted px-2 py-0.5 text-xs">
                      {productById.get(id)?.sku ?? id}
                      <button type="button" onClick={() => setSkuIds((prev) => prev.filter((x) => x !== id))} className="text-muted-foreground hover:text-foreground">
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>% off</Label>
              <Input type="number" min={0} max={100} value={percentOff} onChange={(e) => setPercentOff(e.target.value)} placeholder="e.g. 20" />
            </div>
            <div className="space-y-1.5">
              <Label>$ off</Label>
              <Input type="number" min={0} value={dollarOff} onChange={(e) => setDollarOff(e.target.value)} placeholder="e.g. 15" />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Free item <span className="text-xs text-muted-foreground font-normal">optional</span></Label>
            <Select value={freeItem} onValueChange={setFreeItem}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>None</SelectItem>
                {products.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    <span className="font-mono text-xs">{p.sku}</span>
                    <span className="ml-2 text-muted-foreground">{p.product_name}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div className="space-y-1.5">
              <Label>Min order $</Label>
              <Input type="number" min={0} value={minOrder} onChange={(e) => setMinOrder(e.target.value)} placeholder="threshold" />
            </div>
            <div className="space-y-1.5">
              <Label>Buy qty</Label>
              <Input type="number" min={1} value={buyQty} onChange={(e) => setBuyQty(e.target.value)} placeholder="BOGO" />
            </div>
            <div className="space-y-1.5">
              <Label>Get qty</Label>
              <Input type="number" min={1} value={getQty} onChange={(e) => setGetQty(e.target.value)} placeholder="BOGO" />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={pending}>
            {pending ? "Saving…" : editing ? "Save offer" : "Add offer"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
