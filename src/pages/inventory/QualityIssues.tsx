import { useMemo, useState } from "react";
import { format, parseISO } from "date-fns";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { AlertTriangle, Scale, ShieldCheck } from "lucide-react";
import {
  useBreakageReports,
  useShipmentVariances,
  useResolveBreakageReport,
  useResolveShipmentVariance,
  useSuppliers,
  type BreakageReportRow,
  type ShipmentVarianceRow,
} from "@/lib/hooks";

/**
 * Admin-only Quality Issues hub. Merges breakage + variance pools so
 * internal staff can see what's outstanding across suppliers and resolve
 * each item with a reason + optional write-off flag.
 *
 * Resolution RPCs (rpc_resolve_breakage_report / rpc_resolve_shipment_variance)
 * enforce internal-only server-side, so the button does the right thing
 * regardless of what role the caller thinks they have.
 */
export default function QualityIssues() {
  const breakageQ = useBreakageReports();
  const variancesQ = useShipmentVariances();
  const suppliersQ = useSuppliers();
  const resolveBreakage = useResolveBreakageReport();
  const resolveVariance = useResolveShipmentVariance();

  const supplierLookup = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of suppliersQ.data ?? []) m.set(s.id, s.name);
    return m;
  }, [suppliersQ.data]);

  // Both lists filter out terminal rows (resolved / written_off) by default —
  // the whole point of this page is open issues.
  const openBreakage = useMemo(
    () =>
      (breakageQ.data ?? []).filter(
        (r) => r.status !== "resolved" && r.status !== "written_off",
      ),
    [breakageQ.data],
  );
  const openVariances = useMemo(
    () =>
      (variancesQ.data ?? []).filter(
        (v) => v.status !== "resolved" && v.status !== "written_off",
      ),
    [variancesQ.data],
  );

  // Single resolution dialog state — works for both breakage + variance.
  type Target =
    | { kind: "breakage"; row: BreakageReportRow }
    | { kind: "variance"; row: ShipmentVarianceRow }
    | null;
  const [target, setTarget] = useState<Target>(null);
  const [notes, setNotes] = useState("");
  const [writeOff, setWriteOff] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function openFor(t: Target) {
    setTarget(t);
    setNotes("");
    setWriteOff(false);
    setError(null);
  }

  async function submitResolve() {
    if (!target) return;
    if (notes.trim().length === 0) {
      setError("Resolution notes are required.");
      return;
    }
    setError(null);
    try {
      if (target.kind === "breakage") {
        await resolveBreakage.mutateAsync({
          reportId: target.row.id,
          resolutionNotes: notes.trim(),
          writeOff,
        });
      } else {
        await resolveVariance.mutateAsync({
          varianceId: target.row.id,
          resolutionNotes: notes.trim(),
          writeOff,
        });
      }
      setTarget(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Resolve failed");
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Quality Issues</h1>
        <p className="text-muted-foreground text-sm">
          Open breakage reports and shipment variances across all suppliers. Only internal staff
          can close these.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Open Breakage</p>
                <p className="text-3xl font-bold text-amber-400 tabular-nums mt-1">
                  {openBreakage.length}
                </p>
              </div>
              <AlertTriangle className="h-5 w-5 text-amber-400" />
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Open Variances</p>
                <p className="text-3xl font-bold text-amber-400 tabular-nums mt-1">
                  {openVariances.length}
                </p>
              </div>
              <Scale className="h-5 w-5 text-amber-400" />
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Total Open Value</p>
                <p className="text-3xl font-bold tabular-nums mt-1">
                  {openBreakage.length + openVariances.length}
                </p>
                <p className="text-xs text-muted-foreground mt-1">Across both queues</p>
              </div>
              <ShieldCheck className="h-5 w-5 text-muted-foreground" />
            </div>
          </CardContent>
        </Card>
      </div>

      <Tabs defaultValue="breakage">
        <TabsList>
          <TabsTrigger value="breakage">Breakage ({openBreakage.length})</TabsTrigger>
          <TabsTrigger value="variances">Variances ({openVariances.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="breakage" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Open Breakage Reports</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {openBreakage.length === 0 ? (
                <div className="py-10 text-center text-sm text-muted-foreground">
                  All clear — no open breakage reports.
                </div>
              ) : (
                <table className="w-full text-sm">
                  <thead className="bg-muted/40 text-left text-xs uppercase tracking-wider text-muted-foreground">
                    <tr>
                      <th className="px-4 py-3">Opened</th>
                      <th className="px-3 py-3">Producer → Reporter</th>
                      <th className="px-3 py-3 text-right">Qty</th>
                      <th className="px-3 py-3">Reason</th>
                      <th className="px-3 py-3">Description</th>
                      <th className="px-3 py-3">Status</th>
                      <th className="px-3 py-3 w-28"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {openBreakage.map((r) => (
                      <tr key={r.id} className="border-b border-border/50">
                        <td className="px-4 py-3 text-xs tabular-nums text-muted-foreground">
                          {format(parseISO(r.created_at), "MMM d")}
                        </td>
                        <td className="px-3 py-3 text-xs">
                          <span>{supplierLookup.get(r.producing_supplier_id) ?? "?"}</span>
                          <span className="mx-1 text-muted-foreground">→</span>
                          <span>{supplierLookup.get(r.reporter_supplier_id) ?? "?"}</span>
                        </td>
                        <td className="px-3 py-3 text-right tabular-nums">{r.quantity_broken}</td>
                        <td className="px-3 py-3 text-xs">{r.reason_category.replace(/_/g, " ")}</td>
                        <td className="px-3 py-3 text-xs truncate max-w-[280px]">{r.description}</td>
                        <td className="px-3 py-3">
                          <Badge variant="outline" className="text-[10px]">{r.status}</Badge>
                        </td>
                        <td className="px-3 py-3 text-right">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => openFor({ kind: "breakage", row: r })}
                          >
                            Resolve
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="variances" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Open Shipment Variances</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {openVariances.length === 0 ? (
                <div className="py-10 text-center text-sm text-muted-foreground">
                  All clear — no open variances.
                </div>
              ) : (
                <table className="w-full text-sm">
                  <thead className="bg-muted/40 text-left text-xs uppercase tracking-wider text-muted-foreground">
                    <tr>
                      <th className="px-4 py-3">Opened</th>
                      <th className="px-3 py-3">Origin</th>
                      <th className="px-3 py-3">Type</th>
                      <th className="px-3 py-3 text-right">Declared</th>
                      <th className="px-3 py-3 text-right">Received</th>
                      <th className="px-3 py-3 text-right">Δ</th>
                      <th className="px-3 py-3">Status</th>
                      <th className="px-3 py-3 w-28"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {openVariances.map((v) => (
                      <tr key={v.id} className="border-b border-border/50">
                        <td className="px-4 py-3 text-xs tabular-nums text-muted-foreground">
                          {format(parseISO(v.created_at), "MMM d")}
                        </td>
                        <td className="px-3 py-3 text-xs">
                          {supplierLookup.get(v.origin_supplier_id) ?? "?"}
                        </td>
                        <td className="px-3 py-3 text-xs">{v.variance_type.replace(/_/g, " ")}</td>
                        <td className="px-3 py-3 text-right tabular-nums">{v.declared_quantity}</td>
                        <td className="px-3 py-3 text-right tabular-nums">{v.received_quantity}</td>
                        <td
                          className={`px-3 py-3 text-right tabular-nums font-medium ${v.variance_quantity < 0 ? "text-red-400" : "text-blue-400"}`}
                        >
                          {v.variance_quantity > 0 ? `+${v.variance_quantity}` : v.variance_quantity}
                        </td>
                        <td className="px-3 py-3">
                          <Badge variant="outline" className="text-[10px]">{v.status}</Badge>
                        </td>
                        <td className="px-3 py-3 text-right">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => openFor({ kind: "variance", row: v })}
                          >
                            Resolve
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Resolve dialog — shared shape for both kinds of issue */}
      <Dialog
        open={!!target}
        onOpenChange={(o) => {
          if (!o) {
            setTarget(null);
            setError(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Resolve {target?.kind === "breakage" ? "breakage report" : "shipment variance"}
            </DialogTitle>
            <DialogDescription>
              Resolution is recorded in the audit log and cannot be undone. Pick{" "}
              <span className="font-mono text-xs">write off</span> if the units are being absorbed
              (no supplier credit, no replacement FO).
            </DialogDescription>
          </DialogHeader>

          {target && (
            <div className="space-y-3 text-sm">
              {target.kind === "breakage" && (
                <div className="rounded border border-border p-3 text-xs text-muted-foreground">
                  {target.row.quantity_broken} units · {target.row.reason_category.replace(/_/g, " ")}
                  <br />
                  <span className="italic">"{target.row.description}"</span>
                </div>
              )}
              {target.kind === "variance" && (
                <div className="rounded border border-border p-3 text-xs text-muted-foreground">
                  {target.row.variance_type.replace(/_/g, " ")} ·{" "}
                  declared {target.row.declared_quantity}, received {target.row.received_quantity} ·{" "}
                  Δ {target.row.variance_quantity}
                </div>
              )}

              <div className="space-y-1">
                <Label htmlFor="resolve-notes" className="text-xs">
                  Resolution notes <span className="text-red-400">*</span>
                </Label>
                <Textarea
                  id="resolve-notes"
                  rows={3}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="What was the outcome? e.g. 'Credit issued, supplier will replace in next shipment.'"
                />
              </div>

              <label className="flex items-center gap-2 cursor-pointer text-xs">
                <Checkbox checked={writeOff} onCheckedChange={(c) => setWriteOff(c === true)} />
                <span>Write-off — no supplier credit or replacement expected</span>
              </label>

              {error && <p className="text-xs text-red-400">{error}</p>}
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setTarget(null)}>
              Cancel
            </Button>
            <Button
              onClick={submitResolve}
              disabled={
                notes.trim().length === 0 ||
                resolveBreakage.isPending ||
                resolveVariance.isPending
              }
            >
              {resolveBreakage.isPending || resolveVariance.isPending ? "Resolving…" : "Resolve"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
