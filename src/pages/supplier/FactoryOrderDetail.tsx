import { useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { format, parseISO } from "date-fns";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import {
  useSupplierFactoryOrder,
  useCancelFactoryOrder,
  useConsolidatorReceive,
  useSetItemAlternateEta,
  useReportItemFinished,
  useFactoryOrderComponentStatus,
  isItemOverdue,
  type SupplierFactoryOrderRow,
  type SupplierFactoryOrderItemRow,
} from "@/lib/hooks";
import { useAuth } from "@/lib/auth-context";
import { supabase } from "@/lib/supabase";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, XCircle, PackageCheck, AlertTriangle, Link as LinkIcon } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

import { FACTORY_ORDER_STATUS_COLORS as STATUS_COLOR } from "@/lib/status-colors";

// Small query to resolve whether the current caller consolidates for the
// producing supplier on this order. Empty result = no, non-empty = yes.
function useCallerConsolidatesFor(supplierId: string | null, producingSupplierId: string | null) {
  return useQuery({
    queryKey: ["supplier", "consolidates-check", supplierId, producingSupplierId],
    enabled: !!supplierId && !!producingSupplierId && supplierId !== producingSupplierId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("suppliers")
        .select("consolidates_for")
        .eq("id", supplierId!)
        .single();
      if (error) throw error;
      const arr = (data as { consolidates_for: string[] | null } | null)?.consolidates_for ?? [];
      return arr.includes(producingSupplierId!);
    },
    staleTime: 5 * 60 * 1000,
  });
}

export default function FactoryOrderDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { supplierId } = useAuth();
  const { data, isLoading, error } = useSupplierFactoryOrder(id);
  const cancel = useCancelFactoryOrder();
  const receive = useConsolidatorReceive();
  const setAltEta = useSetItemAlternateEta();
  const reportFinished = useReportItemFinished();
  // Component-status RPC (migration 057). Returns BoM-derived expected
  // components + sibling YX-side child orders that fulfill them. The RPC
  // gates cross-supplier visibility — Nancy gets back the YX child's
  // status / ETA / quantities even though direct read of YX's
  // factory_orders is RLS-blocked.
  const componentStatus = useFactoryOrderComponentStatus(id ?? null);
  const canConsolidate = useCallerConsolidatesFor(
    supplierId,
    data?.order.supplier_id ?? null,
  );
  // YYYY-MM-DD in local time for the overdue comparison.
  const todayIso = new Date().toISOString().slice(0, 10);

  const [receiveRows, setReceiveRows] = useState<Record<string, { confirmed: number; breakage: number; reason?: string; desc?: string }>>({});

  const [cancelReason, setCancelReason] = useState("");
  const [cancelOpen, setCancelOpen] = useState(false);

  if (isLoading) return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;
  if (error || !data) return <div className="p-6 text-sm text-red-400">Order not found.</div>;

  const { order, items } = data;
  const canCancel = order.status === "ordered" || order.status === "in_production";
  const canReportFinished =
    supplierId === order.supplier_id &&
    (order.status === "ordered" || order.status === "in_production");

  async function onChangeFinished(
    item: SupplierFactoryOrderItemRow,
    nextValue: number,
  ) {
    if (!data) return;
    // No-op if unchanged — avoids firing the RPC and writing an audit row
    // every time the input loses focus.
    if ((item.quantity_finished ?? 0) === nextValue) return;
    if (!Number.isFinite(nextValue) || nextValue < 0) return;
    try {
      const res = await reportFinished.mutateAsync({
        factoryOrderItemId: item.id,
        quantityFinished: nextValue,
        expectedVersion: data.order.row_version,
        factoryOrderId: data.order.id,
      });
      // If the order auto-advanced, tell the user — otherwise stay quiet
      // to avoid toast fatigue when inputting multiple items in a row.
      if (res.order_status === "finished" && data.order.status !== "finished") {
        toast({ title: "All line items finished — order marked as finished" });
      }
    } catch (err) {
      toast({
        title: "Could not update finished count",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    }
  }

  async function onChangeAltEta(item: SupplierFactoryOrderItemRow, nextIso: string) {
    if (!data) return;
    // Empty string clears the override; store NULL server-side.
    const payload = nextIso.trim().length === 0 ? null : nextIso;
    // No-op if the value didn't actually change — avoids spurious audit rows.
    if ((item.alternate_expected_completion ?? null) === payload) return;
    try {
      await setAltEta.mutateAsync({
        factoryOrderItemId: item.id,
        alternateEta: payload,
        expectedVersion: data.order.row_version,
        factoryOrderId: data.order.id,
      });
    } catch (err) {
      toast({
        title: "Alt ETA update failed",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    }
  }

  async function onReceive() {
    if (!data) return;
    const items = Object.entries(receiveRows)
      .filter(([, v]) => v.confirmed !== undefined)
      .map(([foiId, v]) => ({
        factoryOrderItemId: foiId,
        confirmedQuantity: v.confirmed,
        breakageQuantity: v.breakage || 0,
        breakageReasonCategory: (v.reason as
          | "crushed_in_transit"
          | "manufacturing_defect"
          | "wet_damage"
          | "contamination"
          | "other"
          | undefined),
        breakageDescription: v.desc,
      }));
    if (items.length === 0) {
      toast({ title: "Enter at least one confirmed quantity", variant: "destructive" });
      return;
    }
    try {
      const res = await receive.mutateAsync({
        factoryOrderId: data.order.id,
        expectedVersion: data.order.row_version,
        items,
      });
      toast({
        title: `${res.items_processed} item(s) received`,
        description: res.breakage_reports_created > 0
          ? `${res.breakage_reports_created} breakage report(s) auto-opened.`
          : undefined,
      });
      setReceiveRows({});
    } catch (err) {
      toast({
        title: "Receive failed",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    }
  }

  async function onCancel() {
    try {
      await cancel.mutateAsync({
        factoryOrderId: order.id,
        expectedVersion: order.row_version,
        reason: cancelReason.trim(),
      });
      toast({ title: "Order canceled" });
      setCancelOpen(false);
      navigate("/supplier/orders");
    } catch (err) {
      toast({
        title: "Cancel failed",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    }
  }

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex items-center justify-between">
        <div>
          <Button variant="ghost" size="sm" asChild>
            <Link to="/supplier/orders"><ArrowLeft className="mr-1.5 h-4 w-4" /> All orders</Link>
          </Button>
          <h1 className="text-2xl font-semibold mt-1">Factory Order</h1>
          <p className="text-xs text-muted-foreground font-mono mt-0.5">{order.id}</p>
        </div>
        <Badge variant="outline" className={`${STATUS_COLOR[order.status]} text-sm`}>
          {order.status.replace("_", " ")}
        </Badge>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Header</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
          <div>
            <span className="text-muted-foreground">Order date: </span>
            {format(parseISO(order.order_date), "MMM d, yyyy")}
          </div>
          <div>
            <span className="text-muted-foreground">Expected: </span>
            {order.expected_completion
              ? format(parseISO(order.expected_completion), "MMM d, yyyy")
              : "—"}
          </div>
          <div className="col-span-2">
            <span className="text-muted-foreground">Notes: </span>
            {order.notes ?? "—"}
          </div>
          {order.status === "canceled" && order.canceled_reason && (
            <div className="col-span-2">
              <span className="text-muted-foreground">Cancel reason: </span>
              <span className="text-red-400">{order.canceled_reason}</span>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Component orders — read-only Nancy-side view of YX dependencies.
          Only renders when this order has BoM-driven expected components
          (i.e. it's a parent of a compound SKU like BW58/BW62). Computes
          missing components by comparing expected (from BoM) vs the sum
          across linked YX child orders. Critical for assembly planning:
          Nancy must receive the HT10 / HT6 parts from YX before joining
          them to the parent SKU at her facility. */}
      {componentStatus.data && componentStatus.data.expected_components.length > 0 && (
        <ComponentOrdersCard status={componentStatus.data} />
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Line items</CardTitle>
        </CardHeader>
        <CardContent>
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="py-2">SKU</th>
                <th className="py-2">Ordered</th>
                <th className="py-2">Finished</th>
                <th className="py-2">Alt ETA</th>
                <th className="py-2">Confirmed</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => {
                // Only the producing supplier can edit their own alt ETA, and
                // only while the order is still open (ordered / in_production).
                const canEditAlt =
                  supplierId === order.supplier_id &&
                  (order.status === "ordered" || order.status === "in_production");
                const overdue = isItemOverdue(it, order, todayIso);
                return (
                  <tr
                    key={it.id}
                    className={`border-t border-border ${overdue ? "bg-red-500/5" : ""}`}
                    title={overdue ? "Past the effective ETA and not yet received." : undefined}
                  >
                    <td className="py-2">
                      {it.sku ? (
                        <>
                          <span className="font-mono text-xs">{it.sku.sku}</span>
                          <span className="ml-2 text-muted-foreground">{it.sku.product_name}</span>
                        </>
                      ) : (
                        <span className="font-mono text-xs text-muted-foreground">{it.sku_id.slice(0, 8)}…</span>
                      )}
                    </td>
                    <td className="py-2">{it.quantity_ordered}</td>
                    <td className="py-2">
                      {canReportFinished ? (
                        <Input
                          type="number"
                          className="h-7 w-24"
                          min={0}
                          max={it.quantity_ordered}
                          defaultValue={it.quantity_finished ?? 0}
                          disabled={reportFinished.isPending}
                          onBlur={(e) => {
                            const v = parseInt(e.target.value || "0", 10);
                            onChangeFinished(it, Number.isNaN(v) ? 0 : v);
                          }}
                          onKeyDown={(e) => {
                            // Enter applies immediately instead of waiting for blur.
                            if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
                          }}
                          title="Units produced and ready. Order auto-advances when every line is fully finished."
                        />
                      ) : (
                        <span className={it.quantity_finished ? "" : "text-muted-foreground"}>
                          {it.quantity_finished ?? 0}
                        </span>
                      )}
                    </td>
                    <td className="py-2">
                      {canEditAlt ? (
                        <Input
                          type="date"
                          className="h-7 w-36"
                          value={it.alternate_expected_completion ?? ""}
                          min={order.order_date}
                          disabled={setAltEta.isPending}
                          onChange={(e) => onChangeAltEta(it, e.target.value)}
                          placeholder={order.expected_completion ?? ""}
                          title={
                            it.alternate_expected_completion
                              ? "Per-item override in effect"
                              : `Inheriting order ETA${order.expected_completion ? ` (${order.expected_completion})` : ""}`
                          }
                        />
                      ) : (
                        <span className={it.alternate_expected_completion ? "" : "text-muted-foreground"}>
                          {it.alternate_expected_completion
                            ? format(parseISO(it.alternate_expected_completion), "MMM d, yyyy")
                            : "inherit"}
                        </span>
                      )}
                    </td>
                    <td className="py-2">
                      {it.consolidator_confirmed_quantity ?? <span className="text-muted-foreground">—</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {/* Consolidator receive panel */}
      {canConsolidate.data === true &&
        (order.status === "in_production" || order.status === "finished") &&
        items.some((i) => i.consolidator_confirmed_quantity === null) && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <PackageCheck className="h-4 w-4" />
                Receive (consolidator dock count)
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-xs text-muted-foreground">
                You consolidate for this producer. Enter the physical count you received on the dock
                per line item. Breakage (damaged / unusable) is tracked separately — providing a
                reason and description here auto-opens a breakage report for the producer.
              </p>
              <div className="rounded-md border border-border overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-muted/40 text-left text-xs uppercase text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2">SKU</th>
                      <th className="px-3 py-2">Ordered</th>
                      <th className="px-3 py-2">Confirmed</th>
                      <th className="px-3 py-2">Breakage</th>
                      <th className="px-3 py-2">Reason</th>
                      <th className="px-3 py-2">Description</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items
                      .filter((it: SupplierFactoryOrderItemRow) => it.consolidator_confirmed_quantity === null)
                      .map((it: SupplierFactoryOrderItemRow) => {
                        const row = receiveRows[it.id] ?? { confirmed: 0, breakage: 0 };
                        return (
                          <tr key={it.id} className="border-t border-border">
                            <td className="px-3 py-2">
                              {it.sku ? (
                                <>
                                  <div className="font-mono text-xs">{it.sku.sku}</div>
                                  <div className="text-[10px] text-muted-foreground truncate max-w-[160px]">
                                    {it.sku.product_name}
                                  </div>
                                </>
                              ) : (
                                <span className="font-mono text-xs text-muted-foreground">
                                  {it.sku_id.slice(0, 8)}…
                                </span>
                              )}
                            </td>
                            <td className="px-3 py-2 tabular-nums">{it.quantity_ordered}</td>
                            <td className="px-3 py-2">
                              <Input
                                type="number"
                                min={0}
                                max={it.quantity_ordered * 2}
                                value={row.confirmed || ""}
                                className="h-8 w-24"
                                onChange={(e) =>
                                  setReceiveRows((r) => ({
                                    ...r,
                                    [it.id]: { ...row, confirmed: parseInt(e.target.value || "0", 10) },
                                  }))
                                }
                              />
                            </td>
                            <td className="px-3 py-2">
                              <Input
                                type="number"
                                min={0}
                                max={row.confirmed}
                                value={row.breakage || ""}
                                className="h-8 w-20"
                                onChange={(e) =>
                                  setReceiveRows((r) => ({
                                    ...r,
                                    [it.id]: { ...row, breakage: parseInt(e.target.value || "0", 10) },
                                  }))
                                }
                              />
                            </td>
                            <td className="px-3 py-2">
                              <select
                                className="h-8 text-xs rounded border border-border bg-background px-2"
                                disabled={(row.breakage ?? 0) === 0}
                                value={row.reason ?? ""}
                                onChange={(e) =>
                                  setReceiveRows((r) => ({ ...r, [it.id]: { ...row, reason: e.target.value } }))
                                }
                              >
                                <option value="">—</option>
                                <option value="crushed_in_transit">Crushed</option>
                                <option value="manufacturing_defect">Mfg defect</option>
                                <option value="wet_damage">Wet damage</option>
                                <option value="contamination">Contamination</option>
                                <option value="other">Other</option>
                              </select>
                            </td>
                            <td className="px-3 py-2">
                              <Input
                                className="h-8 text-xs"
                                placeholder="Optional note…"
                                disabled={(row.breakage ?? 0) === 0}
                                value={row.desc ?? ""}
                                onChange={(e) =>
                                  setReceiveRows((r) => ({ ...r, [it.id]: { ...row, desc: e.target.value } }))
                                }
                              />
                            </td>
                          </tr>
                        );
                      })}
                  </tbody>
                </table>
              </div>
              <Button onClick={onReceive} disabled={receive.isPending}>
                {receive.isPending ? "Submitting…" : "Submit receive"}
              </Button>
            </CardContent>
          </Card>
        )}

      {canCancel && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Actions</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {canCancel && (
              <Dialog open={cancelOpen} onOpenChange={setCancelOpen}>
                <DialogTrigger asChild>
                  <Button variant="destructive" size="sm">
                    <XCircle className="mr-1.5 h-4 w-4" />
                    Cancel order
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Cancel factory order</DialogTitle>
                    <DialogDescription>
                      Cancellation is permanent and recorded in the audit log. A reason is required.
                    </DialogDescription>
                  </DialogHeader>
                  <div className="space-y-2">
                    <Label htmlFor="reason">Reason</Label>
                    <Input
                      id="reason"
                      value={cancelReason}
                      onChange={(e) => setCancelReason(e.target.value)}
                      placeholder="e.g. duplicate of FO-2025-0042"
                    />
                  </div>
                  <DialogFooter>
                    <Button variant="outline" onClick={() => setCancelOpen(false)}>Keep order</Button>
                    <Button
                      variant="destructive"
                      disabled={cancelReason.trim().length === 0 || cancel.isPending}
                      onClick={onCancel}
                    >
                      {cancel.isPending ? "Canceling…" : "Cancel order"}
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ComponentOrdersCard — read-only Nancy-side view of YX dependencies for a
// parent factory_order. Server (rpc_factory_order_component_status, migration
// 057) returns expected_components from product_boms × line item qty, plus
// child_orders (other suppliers' factory_orders parented to this one).
//
// We compute the per-component "fulfilled" tally client-side by summing
// child_orders[].components[]; missing = needed − fulfilled. Linker UI is
// admin-only; this view is purely informational so Nancy can plan around
// the YX side's status and ETA.
// ---------------------------------------------------------------------------
function ComponentOrdersCard({
  status,
}: {
  status: NonNullable<ReturnType<typeof useFactoryOrderComponentStatus>["data"]>;
}) {
  // Roll up: how many of each component SKU are already covered by linked
  // child orders? Walk every child's components array and add to the bucket
  // keyed by sku_id.
  const fulfilledBySku = new Map<string, number>();
  for (const co of status.child_orders) {
    for (const c of co.components ?? []) {
      fulfilledBySku.set(c.sku_id, (fulfilledBySku.get(c.sku_id) ?? 0) + c.quantity_ordered);
    }
  }

  const missing = status.expected_components
    .map((e) => ({
      ...e,
      fulfilled: fulfilledBySku.get(e.component_sku_id) ?? 0,
    }))
    .filter((e) => e.fulfilled < e.quantity_needed);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <LinkIcon className="h-4 w-4" />
          Component orders
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Expected components summary */}
        <div className="text-xs text-muted-foreground">
          This order assembles components from another supplier. You must
          receive the parts listed below before joining them at your facility.
        </div>

        {/* Missing components warning — surfaces with a red chip when the
            sibling order isn't placed yet, or doesn't cover the full qty. */}
        {missing.length > 0 && (
          <div className="rounded border border-red-500/30 bg-red-500/5 p-2 space-y-1">
            <div className="text-[11px] uppercase tracking-wider text-red-400 font-medium flex items-center gap-1">
              <AlertTriangle className="h-3 w-3" />
              Missing component orders
            </div>
            {missing.map((m) => (
              <div key={m.component_sku_id} className="text-xs flex items-center gap-2">
                <span className="font-mono font-semibold">{m.component_sku}</span>
                <span className="text-muted-foreground tabular-nums">
                  need {m.quantity_needed.toLocaleString()}
                  {m.fulfilled > 0 && (
                    <>
                      , linked {m.fulfilled.toLocaleString()}, short{" "}
                      <span className="text-red-400">
                        {(m.quantity_needed - m.fulfilled).toLocaleString()}
                      </span>
                    </>
                  )}
                </span>
              </div>
            ))}
            <div className="text-[11px] text-muted-foreground/80 italic pt-1">
              Contact admin to place the missing component order.
            </div>
          </div>
        )}

        {/* Linked child orders — read-only metadata for each */}
        {status.child_orders.length === 0 ? (
          <div className="text-xs text-muted-foreground italic">
            No component orders linked yet.
          </div>
        ) : (
          <div className="space-y-2">
            {status.child_orders.map((c) => (
              <div
                key={c.id}
                className="rounded border border-border/60 bg-muted/20 p-2 text-xs space-y-1"
              >
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge variant="outline" className="text-[10px] py-0 border-blue-500/40 text-blue-400">
                    {c.supplier_name}
                  </Badge>
                  <span className="font-mono font-semibold">
                    {c.order_number ?? <span className="italic text-muted-foreground">awaiting #</span>}
                  </span>
                  <span className="text-muted-foreground">·</span>
                  <Badge
                    variant="outline"
                    className={`${STATUS_COLOR[c.status as SupplierFactoryOrderRow["status"]] ?? ""} text-[10px] py-0`}
                  >
                    {c.status.replace("_", " ")}
                  </Badge>
                  {c.expected_completion && (
                    <>
                      <span className="text-muted-foreground">·</span>
                      <span className="text-muted-foreground tabular-nums">
                        ETA {format(parseISO(c.expected_completion), "MMM d, yyyy")}
                      </span>
                    </>
                  )}
                </div>
                <div className="text-[11px] tabular-nums pl-1">
                  {(c.components ?? []).map((cc, idx) => (
                    <span key={cc.sku_id}>
                      {idx > 0 && <span className="text-border mx-1.5">·</span>}
                      <span className="font-mono">{cc.sku}</span>
                      <span className="text-muted-foreground">
                        {" "}
                        {cc.quantity_finished}/{cc.quantity_ordered}
                      </span>
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
