import { useState } from "react";
import { format, parseISO } from "date-fns";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  useBreakageReports,
  useAcknowledgeBreakageReport,
  type BreakageReportRow,
} from "@/lib/hooks";
import { useAuth } from "@/lib/auth-context";
import { useToast } from "@/hooks/use-toast";

import { BREAKAGE_STATUS_COLORS as STATUS_COLOR } from "@/lib/status-colors";

export default function BreakageInbox() {
  const { supplierId } = useAuth();
  const { toast } = useToast();
  const { data, isLoading } = useBreakageReports();
  const ack = useAcknowledgeBreakageReport();
  const [selected, setSelected] = useState<BreakageReportRow | null>(null);
  const [dispute, setDispute] = useState(false);

  if (isLoading) return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;

  const reports = data ?? [];
  // Two buckets: "against me" (I'm producer) = action required by me,
  // and "filed by me" (I'm reporter) = awaiting the producer.
  const againstMe = reports.filter((r) => r.producing_supplier_id === supplierId);
  const byMe = reports.filter((r) => r.reporter_supplier_id === supplierId);

  async function onAck() {
    if (!selected) return;
    try {
      await ack.mutateAsync({ reportId: selected.id, dispute });
      toast({ title: dispute ? "Report disputed" : "Report acknowledged" });
      setSelected(null);
      setDispute(false);
    } catch (err) {
      toast({
        title: "Action failed",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Breakage Reports</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Filed by consolidators when goods arrive damaged or miscounted at receive.
        </p>
      </div>

      <Section
        title="Filed against you"
        subtitle="Awaiting your acknowledgment or dispute."
        reports={againstMe}
        actionable
        onSelect={(r) => setSelected(r)}
      />
      <Section
        title="Filed by you"
        subtitle="Awaiting producer response or internal resolution."
        reports={byMe}
      />

      <Dialog open={!!selected} onOpenChange={(o) => !o && setSelected(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Respond to breakage report</DialogTitle>
            <DialogDescription>
              {selected?.quantity_broken} unit(s) reported as{" "}
              <span className="italic">{selected?.reason_category?.replace(/_/g, " ")}</span>.
              Disputing does not reopen the facts — it signals disagreement for internal review.
            </DialogDescription>
          </DialogHeader>
          {selected && (
            <div className="space-y-2 text-sm">
              <p className="italic text-muted-foreground">"{selected.description}"</p>
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => { setSelected(null); setDispute(false); }}>
              Close
            </Button>
            <Button
              variant="outline"
              onClick={() => { setDispute(true); onAck(); }}
              disabled={ack.isPending}
            >
              Dispute
            </Button>
            <Button onClick={() => { setDispute(false); onAck(); }} disabled={ack.isPending}>
              {ack.isPending ? "Saving…" : "Acknowledge"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Section({
  title, subtitle, reports, actionable, onSelect,
}: {
  title: string;
  subtitle: string;
  reports: BreakageReportRow[];
  actionable?: boolean;
  onSelect?: (r: BreakageReportRow) => void;
}) {
  return (
    <div className="space-y-2">
      <div>
        <h2 className="text-sm font-semibold">{title}</h2>
        <p className="text-xs text-muted-foreground">{subtitle}</p>
      </div>
      {reports.length === 0 ? (
        <Card>
          <CardContent className="py-6 text-center text-xs text-muted-foreground">None.</CardContent>
        </Card>
      ) : (
        <div className="rounded-md border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-3 py-2">Filed</th>
                <th className="px-3 py-2">Qty</th>
                <th className="px-3 py-2">Reason</th>
                <th className="px-3 py-2">Description</th>
                <th className="px-3 py-2">Status</th>
                {actionable && <th className="px-3 py-2 w-28"></th>}
              </tr>
            </thead>
            <tbody>
              {reports.map((r) => (
                <tr key={r.id} className="border-t border-border">
                  <td className="px-3 py-2">{format(parseISO(r.created_at), "MMM d")}</td>
                  <td className="px-3 py-2 tabular-nums">{r.quantity_broken}</td>
                  <td className="px-3 py-2 text-xs">{r.reason_category.replace(/_/g, " ")}</td>
                  <td className="px-3 py-2 text-xs truncate max-w-[320px]">{r.description}</td>
                  <td className="px-3 py-2">
                    <Badge variant="outline" className={STATUS_COLOR[r.status]}>
                      {r.status.replace(/_/g, " ")}
                    </Badge>
                  </td>
                  {actionable && (
                    <td className="px-3 py-2 text-right">
                      {r.status === "open" ? (
                        <Button size="sm" variant="outline" onClick={() => onSelect?.(r)}>
                          Respond
                        </Button>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
