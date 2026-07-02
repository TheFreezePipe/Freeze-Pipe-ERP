import { format, parseISO } from "date-fns";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  useShipmentVariances,
  useAcknowledgeShipmentVariance,
  type ShipmentVarianceRow,
} from "@/lib/hooks";
import { useToast } from "@/hooks/use-toast";

import { VARIANCE_STATUS_COLORS as STATUS_COLOR } from "@/lib/status-colors";

const TYPE_LABEL: Record<ShipmentVarianceRow["variance_type"], string> = {
  shortage: "Shortage",
  overage: "Overage",
  breakage_in_transit: "Breakage in transit",
  damage: "Damage",
  other: "Other",
};

export default function VarianceInbox() {
  const { toast } = useToast();
  const { data, isLoading } = useShipmentVariances();
  const ack = useAcknowledgeShipmentVariance();

  if (isLoading) return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;
  const variances = data ?? [];

  async function onAck(id: string) {
    try {
      await ack.mutateAsync({ varianceId: id });
      toast({ title: "Variance acknowledged" });
    } catch (err) {
      toast({
        title: "Acknowledge failed",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Shipment Variances</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Automatically opened when the receiver's count doesn't match what you declared. You can
          acknowledge the issue — only internal staff can resolve or write off.
        </p>
      </div>

      {variances.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No variances on record.
          </CardContent>
        </Card>
      ) : (
        <div className="rounded-md border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-3 py-2">Opened</th>
                <th className="px-3 py-2">Type</th>
                <th className="px-3 py-2">Declared</th>
                <th className="px-3 py-2">Received</th>
                <th className="px-3 py-2">Δ</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2 w-28"></th>
              </tr>
            </thead>
            <tbody>
              {variances.map((v) => (
                <tr key={v.id} className="border-t border-border">
                  <td className="px-3 py-2">{format(parseISO(v.created_at), "MMM d, yyyy")}</td>
                  <td className="px-3 py-2 text-xs">{TYPE_LABEL[v.variance_type]}</td>
                  <td className="px-3 py-2 tabular-nums">{v.declared_quantity}</td>
                  <td className="px-3 py-2 tabular-nums">{v.received_quantity}</td>
                  <td className={`px-3 py-2 tabular-nums font-medium ${v.variance_quantity < 0 ? "text-red-400" : "text-blue-400"}`}>
                    {v.variance_quantity > 0 ? `+${v.variance_quantity}` : v.variance_quantity}
                  </td>
                  <td className="px-3 py-2">
                    <Badge variant="outline" className={STATUS_COLOR[v.status]}>
                      {v.status.replace(/_/g, " ")}
                    </Badge>
                  </td>
                  <td className="px-3 py-2 text-right">
                    {v.status === "open" ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => onAck(v.id)}
                        disabled={ack.isPending}
                      >
                        Acknowledge
                      </Button>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
