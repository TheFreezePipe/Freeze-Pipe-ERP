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
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { AlertTriangle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { describeError } from "@/lib/supabase-error";
import { useAuth } from "@/lib/auth-context";
import { useCloseFreightShort, type FreightLineItemWithProduct } from "@/lib/hooks";
import type { FreightShipment } from "@/types/database";

// ---------------------------------------------------------------------------
// CloseShortDialog — final accounting for a partially received shipment.
//
// Lists each catalog line's shortfall, requires a reason (free-text note
// mandatory for "Other"), then calls rpc_close_freight_short which:
//   * files shortage variances (when the shipment has a portal supplier),
//   * shrinks each line to what physically arrived → missing units return
//     to on-order via the existing netting,
//   * reopens factory orders that had auto-completed on the old coverage,
//   * stamps closed_short_at + receipt confirmation.
// Irreversible from the UI, hence the destructive confirm.
// ---------------------------------------------------------------------------

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  shipment: FreightShipment;
  lineItems: FreightLineItemWithProduct[];
}

const REASONS = [
  { value: "lost_by_carrier", label: "Lost by carrier — claim filed" },
  { value: "damaged", label: "Damaged on arrival" },
  { value: "supplier_miscount", label: "Supplier miscount" },
  { value: "other", label: "Other" },
] as const;

export function CloseShortDialog({ open, onOpenChange, shipment, lineItems }: Props) {
  const { user } = useAuth();
  const { toast } = useToast();
  const closeShort = useCloseFreightShort();

  const [reason, setReason] = useState<string>("");
  const [note, setNote] = useState("");

  useEffect(() => {
    if (open) {
      setReason("");
      setNote("");
    }
  }, [open]);

  const shortLines = lineItems
    .filter((l) => l.sku_id && l.quantity - (l.quantity_received ?? 0) > 0)
    .map((l) => ({
      id: l.id,
      sku: l.product?.sku ?? l.sku_id?.slice(0, 8) ?? "?",
      name: l.product?.product_name ?? "",
      received: l.quantity_received ?? 0,
      declared: l.quantity,
      short: l.quantity - (l.quantity_received ?? 0),
    }));
  const totalShort = shortLines.reduce((s, l) => s + l.short, 0);

  const reasonLabel = REASONS.find((r) => r.value === reason)?.label ?? "";
  const noteRequired = reason === "other";
  const canConfirm =
    !!reason && (!noteRequired || note.trim().length > 0) && !closeShort.isPending && !!user;

  async function handleConfirm() {
    if (!user || !reason) return;
    const fullReason = noteRequired ? `Other — ${note.trim()}` : reasonLabel;
    try {
      const result = await closeShort.mutateAsync({
        shipmentId: shipment.id,
        reason: fullReason,
        actorId: user.id,
      });
      const bits = [`${(result.units_short ?? 0).toLocaleString()} units back to on order`];
      if ((result.variances_created ?? 0) > 0) {
        bits.push(`${result.variances_created} shortage variance${result.variances_created === 1 ? "" : "s"} filed`);
      }
      if ((result.factory_orders_reopened ?? 0) > 0) {
        bits.push(`${result.factory_orders_reopened} factory order${result.factory_orders_reopened === 1 ? "" : "s"} reopened`);
      }
      toast({
        title: `Closed short: ${shipment.shipment_number}`,
        description: bits.join(" · "),
      });
      onOpenChange(false);
    } catch (err) {
      toast({
        title: "Couldn't close short",
        description: describeError(err),
        variant: "destructive",
      });
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-red-400" />
            Close {shipment.shipment_number} short
          </DialogTitle>
          <DialogDescription>
            Each line is reduced to what physically arrived; the missing units go back to
            on-order and any auto-completed factory orders reopen. This can't be undone here.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Shortfall breakdown */}
          <div className="rounded-md border border-border/50 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-wider text-muted-foreground bg-muted/40">
                  <th className="px-3 py-1.5 font-medium">SKU</th>
                  <th className="px-3 py-1.5 text-right font-medium">Received</th>
                  <th className="px-3 py-1.5 text-right font-medium">Short</th>
                </tr>
              </thead>
              <tbody>
                {shortLines.map((l) => (
                  <tr key={l.id} className="border-t border-border/40">
                    <td className="px-3 py-1.5">
                      <span className="font-mono text-xs">{l.sku}</span>
                      <span className="ml-1.5 text-muted-foreground text-xs hidden sm:inline">{l.name}</span>
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">
                      {l.received.toLocaleString()} of {l.declared.toLocaleString()}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums font-medium text-red-400">
                      {l.short.toLocaleString()}
                    </td>
                  </tr>
                ))}
                {shortLines.length === 0 && (
                  <tr>
                    <td colSpan={3} className="px-3 py-4 text-center text-xs text-muted-foreground">
                      No shortfall — every catalog line is fully received.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="space-y-1.5">
            <Label>Reason</Label>
            <Select value={reason} onValueChange={setReason}>
              <SelectTrigger>
                <SelectValue placeholder="Why is this shipment short?" />
              </SelectTrigger>
              <SelectContent>
                {REASONS.map((r) => (
                  <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {noteRequired && (
            <div className="space-y-1.5">
              <Label>
                Details <span className="text-xs text-red-400 font-normal">required</span>
              </Label>
              <Textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={2}
                placeholder="What happened to the missing units?"
              />
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={closeShort.isPending}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={handleConfirm}
            disabled={!canConfirm || shortLines.length === 0}
          >
            {closeShort.isPending
              ? "Closing short…"
              : `Close short — ${totalShort.toLocaleString()} units back to on order`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
