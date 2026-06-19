import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
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
import { toast } from "@/hooks/use-toast";
import { describeError } from "@/lib/supabase-error";
import { useCreateSale, useUpdateSale, type MktSale } from "@/lib/hooks";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sale?: MktSale | null;
  /** Prefill dates when creating (e.g. from a calendar day click). */
  defaultDate?: string | null;
  /** Lock the date fields (past sale — protected from rescheduling). */
  datesLocked?: boolean;
}

const dateInput = (v: string | null) => (v ? v.slice(0, 10) : "");

export function SaleFormDialog({ open, onOpenChange, sale, defaultDate, datesLocked }: Props) {
  const navigate = useNavigate();
  const create = useCreateSale();
  const update = useUpdateSale();
  const editing = !!sale;

  const [name, setName] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [notes, setNotes] = useState("");

  useEffect(() => {
    if (open) {
      setName(sale?.name ?? "");
      setStartsAt(dateInput(sale?.starts_at ?? null) || (defaultDate ?? ""));
      setEndsAt(dateInput(sale?.ends_at ?? null) || (defaultDate ?? ""));
      setNotes(sale?.notes ?? "");
    }
  }, [open, sale, defaultDate]);

  const pending = create.isPending || update.isPending;

  async function handleSubmit() {
    if (!name.trim()) {
      toast({ title: "Name required", description: "Give the sale a name.", variant: "destructive" });
      return;
    }
    if (startsAt && endsAt && endsAt < startsAt) {
      toast({ title: "Invalid dates", description: "End date is before start date.", variant: "destructive" });
      return;
    }
    const payload = {
      name: name.trim(),
      starts_at: startsAt || null,
      ends_at: endsAt || null,
      notes: notes.trim() || null,
    };
    try {
      if (editing && sale) {
        await update.mutateAsync({ id: sale.id, updates: payload });
        toast({ title: "Sale updated" });
      } else {
        await create.mutateAsync(payload);
        toast({ title: "Sale created" });
      }
      onOpenChange(false);
    } catch (err) {
      toast({ title: "Couldn't save", description: describeError(err), variant: "destructive" });
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit sale" : "New sale"}</DialogTitle>
          <DialogDescription>
            A sale is a container — add the individual offers (codes, % off, etc.) on its detail page.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Valentine's Day Sale" />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>Start date</Label>
              <Input type="date" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} disabled={datesLocked} />
            </div>
            <div className="space-y-1.5">
              <Label>End date</Label>
              <Input type="date" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} disabled={datesLocked} />
            </div>
          </div>
          {datesLocked && (
            <p className="-mt-2 text-[11px] text-amber-400/80">🔒 This sale has already started — its dates are locked.</p>
          )}
          <div className="space-y-1.5">
            <Label>Notes <span className="text-xs text-muted-foreground font-normal">optional</span></Label>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} />
          </div>
        </div>

        <DialogFooter>
          {editing && sale && (
            <Button
              variant="ghost"
              className="mr-auto"
              onClick={() => { onOpenChange(false); navigate(`/marketing/sales/${sale.id}`); }}
            >
              Open full sale &amp; offers →
            </Button>
          )}
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={pending}>
            {pending ? "Saving…" : editing ? "Save changes" : "Create sale"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
