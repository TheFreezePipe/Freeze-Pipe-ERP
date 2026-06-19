import { useEffect, useState } from "react";
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
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { toast } from "@/hooks/use-toast";
import { describeError } from "@/lib/supabase-error";
import {
  useCreateLaunch,
  useUpdateLaunch,
  useProducts,
  type MktLaunchWithProduct,
} from "@/lib/hooks";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  launch?: MktLaunchWithProduct | null;
  /** Prefill launch date when creating (e.g. from a calendar day click). */
  defaultDate?: string | null;
  /** Lock the date fields (past launch — protected from rescheduling). */
  datesLocked?: boolean;
}

const NONE = "__none__";
const KINDS = ["launch", "drop", "restock"] as const;
const dateInput = (v: string | null) => (v ? v.slice(0, 10) : "");
const numOrNull = (s: string): number | null => {
  const t = s.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

export function LaunchFormDialog({ open, onOpenChange, launch, defaultDate, datesLocked }: Props) {
  const { data: products = [] } = useProducts();
  const create = useCreateLaunch();
  const update = useUpdateLaunch();
  const editing = !!launch;

  const [kind, setKind] = useState<string>("launch");
  const [skuId, setSkuId] = useState<string>(NONE);
  const [plannedName, setPlannedName] = useState("");
  const [launchDate, setLaunchDate] = useState("");
  const [readyBy, setReadyBy] = useState("");
  const [limitedQty, setLimitedQty] = useState("");
  const [preorder, setPreorder] = useState(false);
  const [expectedUnits, setExpectedUnits] = useState("");
  const [confidence, setConfidence] = useState<string>(NONE);
  const [notes, setNotes] = useState("");

  useEffect(() => {
    if (!open) return;
    setKind(launch?.kind ?? "launch");
    setSkuId(launch?.sku_id ?? NONE);
    setPlannedName(launch?.planned_name ?? "");
    setLaunchDate(dateInput(launch?.launch_date ?? null) || (defaultDate ?? ""));
    setReadyBy(dateInput(launch?.inventory_ready_by ?? null));
    setLimitedQty(launch?.limited_qty != null ? String(launch.limited_qty) : "");
    setPreorder(launch?.preorder ?? false);
    setExpectedUnits(launch?.expected_first_30d_units != null ? String(launch.expected_first_30d_units) : "");
    setConfidence(launch?.planner_confidence != null ? String(launch.planner_confidence) : NONE);
    setNotes(launch?.notes ?? "");
  }, [open, launch, defaultDate]);

  const pending = create.isPending || update.isPending;

  async function handleSubmit() {
    const realSku = skuId === NONE ? null : skuId;
    if (!realSku && !plannedName.trim()) {
      toast({
        title: "Identify the product",
        description: "Pick an existing SKU or enter a working name for the new product.",
        variant: "destructive",
      });
      return;
    }
    const payload = {
      kind,
      sku_id: realSku,
      planned_name: plannedName.trim() || null,
      launch_date: launchDate || null,
      inventory_ready_by: readyBy || null,
      limited_qty: numOrNull(limitedQty),
      preorder,
      expected_first_30d_units: numOrNull(expectedUnits),
      planner_confidence: confidence === NONE ? null : Number(confidence),
      notes: notes.trim() || null,
    };
    try {
      if (editing && launch) {
        await update.mutateAsync({ id: launch.id, updates: payload });
        toast({ title: "Launch updated" });
      } else {
        await create.mutateAsync(payload);
        toast({ title: "Launch created" });
      }
      onOpenChange(false);
    } catch (err) {
      toast({ title: "Couldn't save", description: describeError(err), variant: "destructive" });
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl max-h-[88vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit launch" : "New launch / drop"}</DialogTitle>
          <DialogDescription>
            Plan a product launch, limited drop, or restock. For a brand-new product, use a working name until its SKU exists.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>Type</Label>
              <Select value={kind} onValueChange={setKind}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {KINDS.map((k) => <SelectItem key={k} value={k} className="capitalize">{k}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-end pb-2 text-[11px] text-muted-foreground">
              Status (Upcoming / Launched / Sold out) is derived automatically.
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Existing SKU <span className="text-xs text-muted-foreground font-normal">or use a working name below</span></Label>
            <Select value={skuId} onValueChange={setSkuId}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>— none / new product —</SelectItem>
                {products.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    <span className="font-mono text-xs">{p.sku}</span>
                    <span className="ml-2 text-muted-foreground">{p.product_name}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Working name <span className="text-xs text-muted-foreground font-normal">for a not-yet-created product</span></Label>
            <Input value={plannedName} onChange={(e) => setPlannedName(e.target.value)} placeholder="e.g. Mini Recycler v2" />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>Launch date</Label>
              <Input type="date" value={launchDate} onChange={(e) => setLaunchDate(e.target.value)} disabled={datesLocked} />
            </div>
            <div className="space-y-1.5">
              <Label>Inventory ready by</Label>
              <Input type="date" value={readyBy} onChange={(e) => setReadyBy(e.target.value)} disabled={datesLocked} />
            </div>
          </div>
          {datesLocked && (
            <p className="-mt-2 text-[11px] text-amber-400/80">🔒 This launch date has passed — its dates are locked.</p>
          )}

          <div className="grid grid-cols-3 gap-4">
            <div className="space-y-1.5">
              <Label>Limited qty</Label>
              <Input type="number" min={0} value={limitedQty} onChange={(e) => setLimitedQty(e.target.value)} placeholder="drops" />
            </div>
            <div className="space-y-1.5">
              <Label>Exp. 1st-30d units</Label>
              <Input type="number" min={0} value={expectedUnits} onChange={(e) => setExpectedUnits(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Confidence (1–5)</Label>
              <Select value={confidence} onValueChange={setConfidence}>
                <SelectTrigger><SelectValue placeholder="—" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>—</SelectItem>
                  {[1, 2, 3, 4, 5].map((n) => <SelectItem key={n} value={String(n)}>{n}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <Switch checked={preorder} onCheckedChange={setPreorder} id="preorder" />
            <Label htmlFor="preorder" className="cursor-pointer">Pre-order</Label>
          </div>

          <div className="space-y-1.5">
            <Label>Notes <span className="text-xs text-muted-foreground font-normal">optional</span></Label>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={pending}>
            {pending ? "Saving…" : editing ? "Save changes" : "Create launch"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
