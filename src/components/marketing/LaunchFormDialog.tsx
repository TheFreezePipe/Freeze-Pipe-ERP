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
import { Plus, X } from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { describeError } from "@/lib/supabase-error";
import {
  useCreateLaunch,
  useUpdateLaunch,
  useProducts,
  type MktLaunchWithMembers,
  type LaunchMemberInput,
} from "@/lib/hooks";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  launch?: MktLaunchWithMembers | null;
  /** Prefill launch date when creating (e.g. from a calendar day click). */
  defaultDate?: string | null;
  /** Lock the date fields (past launch — protected from rescheduling). */
  datesLocked?: boolean;
}

const NONE = "__none__";
const KINDS: { value: string; label: string }[] = [
  { value: "launch", label: "Launch" },
  { value: "drop", label: "Drop" },
  { value: "studio_drop", label: "Studio drop" },
  { value: "restock", label: "Restock" },
];
const dateInput = (v: string | null) => (v ? v.slice(0, 10) : "");
const numOrNull = (s: string): number | null => {
  const t = s.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

type MemberRow = { sku_id: string; planned_name: string; expected: string; limited: string; confidence: string };
const emptyMember = (): MemberRow => ({ sku_id: NONE, planned_name: "", expected: "", limited: "", confidence: NONE });

export function LaunchFormDialog({ open, onOpenChange, launch, defaultDate, datesLocked }: Props) {
  const { data: products = [] } = useProducts();
  const create = useCreateLaunch();
  const update = useUpdateLaunch();
  const editing = !!launch;

  const [name, setName] = useState("");
  const [kind, setKind] = useState<string>("launch");
  const [launchDate, setLaunchDate] = useState("");
  const [readyBy, setReadyBy] = useState("");
  const [preorder, setPreorder] = useState(false);
  const [notes, setNotes] = useState("");
  const [members, setMembers] = useState<MemberRow[]>([emptyMember()]);

  useEffect(() => {
    if (!open) return;
    setName(launch?.name ?? "");
    setKind(launch?.kind ?? "launch");
    setLaunchDate(dateInput(launch?.launch_date ?? null) || (defaultDate ?? ""));
    setReadyBy(dateInput(launch?.inventory_ready_by ?? null));
    setPreorder(launch?.preorder ?? false);
    setNotes(launch?.notes ?? "");
    const rows = (launch?.skus ?? [])
      .slice()
      .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
      .map((s): MemberRow => ({
        sku_id: s.sku_id ?? NONE,
        planned_name: s.planned_name ?? "",
        expected: s.expected_first_30d_units != null ? String(s.expected_first_30d_units) : "",
        limited: s.limited_qty != null ? String(s.limited_qty) : "",
        confidence: s.planner_confidence != null ? String(s.planner_confidence) : NONE,
      }));
    setMembers(rows.length > 0 ? rows : [emptyMember()]);
  }, [open, launch, defaultDate]);

  const pending = create.isPending || update.isPending;
  const isStudio = kind === "studio_drop";

  function updateMember(i: number, patch: Partial<MemberRow>) {
    setMembers((prev) => prev.map((m, idx) => (idx === i ? { ...m, ...patch } : m)));
  }

  async function handleSubmit() {
    if (!name.trim()) {
      toast({ title: "Name required", description: "Give the launch/drop a name.", variant: "destructive" });
      return;
    }
    // Each member must identify a product (existing SKU or a working name).
    for (const m of members) {
      if (m.sku_id === NONE && !m.planned_name.trim()) {
        toast({ title: "Identify each product", description: "Pick a SKU or enter a working name for every product row.", variant: "destructive" });
        return;
      }
    }
    const memberPayload: LaunchMemberInput[] = members.map((m) => ({
      sku_id: m.sku_id === NONE ? null : m.sku_id,
      planned_name: m.sku_id === NONE ? m.planned_name.trim() || null : null,
      expected_first_30d_units: numOrNull(m.expected),
      limited_qty: numOrNull(m.limited),
      planner_confidence: m.confidence === NONE ? null : Number(m.confidence),
    }));
    const launchPayload = {
      name: name.trim(),
      kind,
      launch_date: launchDate || null,
      inventory_ready_by: readyBy || null,
      preorder,
      notes: notes.trim() || null,
    };
    try {
      if (editing && launch) {
        await update.mutateAsync({ id: launch.id, updates: launchPayload, members: memberPayload });
        toast({ title: "Launch updated" });
      } else {
        await create.mutateAsync({ launch: launchPayload, members: memberPayload });
        toast({ title: "Launch created" });
      }
      onOpenChange(false);
    } catch (err) {
      toast({ title: "Couldn't save", description: describeError(err), variant: "destructive" });
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[88vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit launch" : "New launch / drop"}</DialogTitle>
          <DialogDescription>
            One event can bundle several products — a Studio Drop usually has 3–4. For a brand-new product, use a working name until its SKU exists.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-4">
            <div className="col-span-2 space-y-1.5">
              <Label>Name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={isStudio ? "e.g. Summer Studio Drop" : "e.g. Mini Recycler launch"} />
            </div>
            <div className="space-y-1.5">
              <Label>Type</Label>
              <Select value={kind} onValueChange={setKind}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {KINDS.map((k) => <SelectItem key={k.value} value={k.value}>{k.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
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

          <div className="flex items-center gap-3">
            <Switch checked={preorder} onCheckedChange={setPreorder} id="preorder" />
            <Label htmlFor="preorder" className="cursor-pointer">Pre-order</Label>
          </div>

          {/* Member products */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-base">Products <span className="text-xs font-normal text-muted-foreground">({members.length})</span></Label>
              <Button type="button" variant="outline" size="sm" onClick={() => setMembers((prev) => [...prev, emptyMember()])}>
                <Plus className="mr-1.5 h-3.5 w-3.5" /> Add product
              </Button>
            </div>

            {members.map((m, i) => (
              <div key={i} className="space-y-3 rounded-lg border border-border/50 p-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-muted-foreground">Product {i + 1}</span>
                  {members.length > 1 && (
                    <button type="button" onClick={() => setMembers((prev) => prev.filter((_, idx) => idx !== i))} className="text-muted-foreground hover:text-foreground">
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label className="text-xs">Existing SKU</Label>
                    <Select value={m.sku_id} onValueChange={(v) => updateMember(i, { sku_id: v })}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NONE}>— new / planned —</SelectItem>
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
                    <Label className="text-xs">Working name <span className="text-muted-foreground/60">if new</span></Label>
                    <Input
                      value={m.planned_name}
                      onChange={(e) => updateMember(i, { planned_name: e.target.value })}
                      placeholder="not-yet-created product"
                      disabled={m.sku_id !== NONE}
                    />
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <div className="space-y-1.5">
                    <Label className="text-xs">Exp. 1st-30d units</Label>
                    <Input type="number" min={0} value={m.expected} onChange={(e) => updateMember(i, { expected: e.target.value })} />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Limited qty</Label>
                    <Input type="number" min={0} value={m.limited} onChange={(e) => updateMember(i, { limited: e.target.value })} />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Confidence (1–5)</Label>
                    <Select value={m.confidence} onValueChange={(v) => updateMember(i, { confidence: v })}>
                      <SelectTrigger><SelectValue placeholder="—" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NONE}>—</SelectItem>
                        {[1, 2, 3, 4, 5].map((n) => <SelectItem key={n} value={String(n)}>{n}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </div>
            ))}
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
