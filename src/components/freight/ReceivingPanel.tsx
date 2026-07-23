import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { ClipboardCheck, Minus, Plus, PackageCheck, AlertTriangle } from "lucide-react";
import { format, parseISO } from "date-fns";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { describeError } from "@/lib/supabase-error";
import { useAuth } from "@/lib/auth-context";
import {
  useCartonGroups,
  useRecordFreightReceipt,
  type CartonGroupWithSkus,
  type FreightLineItemWithProduct,
} from "@/lib/hooks";
import type { FreightShipment } from "@/types/database";
import { CloseShortDialog } from "@/components/freight/CloseShortDialog";

// ---------------------------------------------------------------------------
// ReceivingPanel — carton-native incremental check-in for a freight shipment.
//
// Modes:
//   * Carton mode  — shipment has persisted carton groups: one row per group
//     with − / + steppers; each tap is a single-entry RPC call.
//   * Unit mode    — legacy shipments without groups: one row per catalog
//     line item with a signed number input + Record button.
//
// "Partially received" is DERIVED (any quantity_received > 0 while
// receipt_confirmed_at is NULL) — there is deliberately no shipment status
// for it. Once receipt_confirmed_at is set the panel collapses to a
// read-only summary; a closed-short shipment gets an amber banner instead.
// Write controls are admin/manager-only (the RPC enforces this server-side
// too — hiding them just avoids surprising errors, matching canEdit
// patterns elsewhere).
// ---------------------------------------------------------------------------

interface Props {
  shipment: FreightShipment;
  lineItems: FreightLineItemWithProduct[];
}

/** Human label for a carton group's contents, derived from its SKU splits.
 *  Integral per-carton counts read "SKU × N/ctn"; non-integral splits fall
 *  back to the group total so we never show a fake fraction. */
function groupContentsLabel(group: CartonGroupWithSkus): string {
  return group.skus
    .map((s) => {
      const sku = s.product?.sku ?? "Unknown SKU";
      const perCarton = s.units_total / group.carton_qty;
      return Number.isInteger(perCarton)
        ? `${sku} × ${perCarton}/ctn`
        : `${sku} · ${s.units_total.toLocaleString()} total`;
    })
    .join(" + ");
}

/** Units credited so far for a group — mirrors the RPC's cumulative-rounding
 *  math (round(units_total * received / carton_qty) per SKU) so the
 *  microcopy matches what the server actually credited. */
function groupUnitsCredited(group: CartonGroupWithSkus): number {
  return group.skus.reduce(
    (sum, s) => sum + Math.round((s.units_total * group.received_cartons) / group.carton_qty),
    0,
  );
}

export function ReceivingPanel({ shipment, lineItems }: Props) {
  const { isAdmin, isManager, user } = useAuth();
  const canEdit = isAdmin || isManager;
  const { toast } = useToast();
  const { data: groups = [], isLoading: groupsLoading } = useCartonGroups(shipment.id);
  const record = useRecordFreightReceipt();

  const [closeShortOpen, setCloseShortOpen] = useState(false);
  // Which stepper is in flight ("<groupId>:+1" / "<groupId>:-1") or which
  // line's Record button ("<lineId>") — lets the tapped control show its
  // pending state while all write controls stay disabled during the call.
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const catalogLines = lineItems.filter((l) => l.sku_id);
  const nonCatalogCount = lineItems.length - catalogLines.length;
  const totalUnits = catalogLines.reduce((s, l) => s + l.quantity, 0);
  const receivedUnits = catalogLines.reduce((s, l) => s + (l.quantity_received ?? 0), 0);

  const cartonMode = groups.length > 0;
  const totalCartons = groups.reduce((s, g) => s + g.carton_qty, 0);
  const receivedCartons = groups.reduce((s, g) => s + g.received_cartons, 0);

  const isConfirmed = !!shipment.receipt_confirmed_at;
  const isClosedShort = !!shipment.closed_short_at;
  const partiallyReceived = receivedUnits > 0 && !isConfirmed;

  // Nothing receivable at all (e.g. sample-only shipment) — no panel.
  if (!groupsLoading && groups.length === 0 && catalogLines.length === 0) return null;

  async function tapCarton(group: CartonGroupWithSkus, delta: 1 | -1) {
    if (!user) return;
    setPendingKey(`${group.id}:${delta > 0 ? "+1" : "-1"}`);
    try {
      const result = await record.mutateAsync({
        shipmentId: shipment.id,
        actorId: user.id,
        entries: [{ carton_group_id: group.id, cartons: delta }],
      });
      if (result.fully_received) {
        toast({
          title: "All cartons checked in",
          description: "Shipment fully received — inventory credited and receipt confirmed.",
        });
      }
    } catch (err) {
      toast({
        title: "Couldn't record carton",
        description: describeError(err),
        variant: "destructive",
      });
    } finally {
      setPendingKey(null);
    }
  }

  async function recordUnits(line: FreightLineItemWithProduct) {
    if (!user) return;
    const raw = (drafts[line.id] ?? "").trim();
    const units = Number(raw);
    if (raw === "" || !Number.isInteger(units) || units === 0) {
      toast({
        title: "Enter a whole number of units",
        description: "Positive to receive, negative to correct a previous entry.",
        variant: "destructive",
      });
      return;
    }
    const received = line.quantity_received ?? 0;
    if (received + units < 0) {
      toast({
        title: "Correction too large",
        description: `Only ${received} units are checked in on this line.`,
        variant: "destructive",
      });
      return;
    }
    setPendingKey(line.id);
    try {
      const result = await record.mutateAsync({
        shipmentId: shipment.id,
        actorId: user.id,
        entries: [{ line_item_id: line.id, units }],
      });
      setDrafts((d) => ({ ...d, [line.id]: "" }));
      if (result.fully_received) {
        toast({
          title: "All units checked in",
          description: "Shipment fully received — inventory credited and receipt confirmed.",
        });
      } else {
        toast({
          title: units > 0 ? `Recorded ${units} units` : `Reversed ${-units} units`,
          description: `${line.product?.sku ?? "line"} now at ${received + units} of ${line.quantity}`,
        });
      }
    } catch (err) {
      toast({
        title: "Couldn't record units",
        description: describeError(err),
        variant: "destructive",
      });
    } finally {
      setPendingKey(null);
    }
  }

  // ---- Closed short: amber banner instead of controls ---------------------
  if (isClosedShort) {
    return (
      <Card className="border-l-4 border-l-amber-500/70">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <ClipboardCheck className="h-4 w-4 text-amber-400" />
            Receiving
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 flex items-start gap-3">
            <AlertTriangle className="h-5 w-5 text-amber-400 shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-semibold text-amber-300">
                Closed short on {format(parseISO(shipment.closed_short_at!), "MMM d, yyyy")}
                {shipment.closed_short_reason && <> — {shipment.closed_short_reason}</>}
              </p>
              <p className="text-[13px] text-muted-foreground mt-1">
                {receivedUnits.toLocaleString()} units checked in. Missing units were returned to
                on-order and shortage variances filed.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  // ---- Confirmed: read-only summary ---------------------------------------
  if (isConfirmed) {
    return (
      <Card className="border-l-4 border-l-green-500/70">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <ClipboardCheck className="h-4 w-4 text-green-400" />
            Receiving
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="rounded-lg border border-green-500/30 bg-green-500/10 p-4 flex items-center gap-4">
            <PackageCheck className="h-7 w-7 text-green-400 shrink-0" />
            <div>
              <p className="text-sm font-semibold text-green-300">
                {cartonMode ? "All cartons checked in" : "All units checked in"}
              </p>
              <p className="text-[13px] text-muted-foreground mt-0.5">
                {receivedUnits.toLocaleString()} units received in full · confirmed{" "}
                {format(parseISO(shipment.receipt_confirmed_at!), "MMM d, yyyy")}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  // ---- Active receiving ----------------------------------------------------
  const headlineDone = cartonMode
    ? totalCartons > 0 && receivedCartons >= totalCartons
    : totalUnits > 0 && receivedUnits >= totalUnits;
  const headlineReceived = cartonMode ? receivedCartons : receivedUnits;
  const headlineTotal = cartonMode ? totalCartons : totalUnits;
  const noun = cartonMode ? "carton" : "unit";

  const anyPending = record.isPending;

  return (
    <>
      <Card className={cn("border-l-4", headlineDone ? "border-l-green-500/70" : "border-l-amber-500/70")}>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <ClipboardCheck className={cn("h-4 w-4", headlineDone ? "text-green-400" : "text-amber-400")} />
            Receiving
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Headline banner — big count first, supporting line below. Phase 1
              has no carrier piece feed, so this is the neutral variant. */}
          <div
            className={cn(
              "rounded-lg border p-4 flex items-center gap-4",
              headlineDone
                ? "border-green-500/30 bg-green-500/10"
                : "border-amber-500/30 bg-amber-500/10",
            )}
          >
            <div
              className={cn(
                "text-4xl font-bold tabular-nums leading-none shrink-0",
                headlineDone ? "text-green-400" : "text-amber-400",
              )}
            >
              {headlineReceived.toLocaleString()}
              <span className="text-xl font-semibold text-muted-foreground">
                {" "}/ {headlineTotal.toLocaleString()}
              </span>
            </div>
            <div>
              <p className="text-sm font-semibold">
                {headlineDone
                  ? `All ${noun}s checked in`
                  : `${headlineReceived.toLocaleString()} of ${headlineTotal.toLocaleString()} ${noun}s checked in`}
              </p>
              <p className="text-[13px] text-muted-foreground">
                {receivedUnits.toLocaleString()} of {totalUnits.toLocaleString()} units credited to
                inventory
              </p>
            </div>
          </div>

          {groupsLoading ? (
            <p className="text-sm text-muted-foreground">Loading carton groups…</p>
          ) : cartonMode ? (
            /* ---- Carton mode: one row per group with − / + steppers ---- */
            <div className="space-y-3">
              {groups.map((group) => {
                const done = group.received_cartons >= group.carton_qty;
                const unitsCredited = groupUnitsCredited(group);
                const groupUnits = group.skus.reduce((s, sk) => s + sk.units_total, 0);
                return (
                  <div key={group.id} className="rounded-lg border border-border/60 p-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate" title={group.skus.map((s) => `${s.product?.sku ?? "?"} — ${s.product?.product_name ?? ""}`).join("\n")}>
                          {groupContentsLabel(group)}
                        </p>
                        {group.notes && (
                          <p className="text-[11px] text-muted-foreground truncate">{group.notes}</p>
                        )}
                      </div>
                      {canEdit && (
                        <div className="flex items-center gap-1.5 shrink-0">
                          <Button
                            size="icon"
                            variant="outline"
                            className="h-7 w-7"
                            onClick={() => tapCarton(group, -1)}
                            disabled={anyPending || group.received_cartons <= 0}
                            title="Remove one carton (correction)"
                          >
                            <Minus className={cn("h-3.5 w-3.5", pendingKey === `${group.id}:-1` && "animate-pulse")} />
                          </Button>
                          <Button
                            size="icon"
                            variant="outline"
                            className={cn("h-7 w-7", !done && "border-green-500/40 text-green-400 hover:text-green-300")}
                            onClick={() => tapCarton(group, 1)}
                            disabled={anyPending || done}
                            title="Check in one carton"
                          >
                            <Plus className={cn("h-3.5 w-3.5", pendingKey === `${group.id}:+1` && "animate-pulse")} />
                          </Button>
                        </div>
                      )}
                    </div>
                    <div className="mt-2 flex items-center gap-3">
                      <Progress
                        value={group.carton_qty > 0 ? (group.received_cartons / group.carton_qty) * 100 : 0}
                        className={cn("h-1.5 flex-1", done ? "[&>div]:bg-green-500" : "[&>div]:bg-amber-500")}
                      />
                      <span className={cn("text-xs tabular-nums shrink-0", done ? "text-green-400" : "text-muted-foreground")}>
                        received {group.received_cartons} of {group.carton_qty}
                      </span>
                    </div>
                    <p className="mt-1 text-[11px] text-muted-foreground tabular-nums">
                      {unitsCredited.toLocaleString()} of {groupUnits.toLocaleString()} units credited
                    </p>
                  </div>
                );
              })}
            </div>
          ) : (
            /* ---- Unit mode: legacy shipments without carton groups ---- */
            <div className="space-y-2">
              {catalogLines.map((line) => {
                const received = line.quantity_received ?? 0;
                const done = received >= line.quantity;
                return (
                  <div key={line.id} className="rounded-lg border border-border/60 p-3 flex items-center gap-3 flex-wrap">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">
                        <span className="font-mono text-xs">{line.product?.sku ?? line.sku_id?.slice(0, 8)}</span>
                        <span className="ml-2 text-muted-foreground text-xs">{line.product?.product_name ?? ""}</span>
                      </p>
                      <p className={cn("text-xs tabular-nums mt-0.5", done ? "text-green-400" : "text-muted-foreground")}>
                        received {received.toLocaleString()} of {line.quantity.toLocaleString()} units
                      </p>
                    </div>
                    {canEdit && (
                      <div className="flex items-center gap-1.5 shrink-0">
                        <Input
                          type="number"
                          step={1}
                          value={drafts[line.id] ?? ""}
                          onChange={(e) => setDrafts((d) => ({ ...d, [line.id]: e.target.value }))}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") recordUnits(line);
                          }}
                          placeholder="± units"
                          className="h-7 w-24 text-right tabular-nums"
                          disabled={anyPending}
                        />
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 px-2.5 text-xs"
                          onClick={() => recordUnits(line)}
                          disabled={anyPending || (drafts[line.id] ?? "").trim() === ""}
                        >
                          {pendingKey === line.id ? "Recording…" : "Record"}
                        </Button>
                      </div>
                    )}
                  </div>
                );
              })}
              {canEdit && (
                <p className="text-[11px] text-muted-foreground">
                  Enter a negative number to correct a previous entry.
                </p>
              )}
            </div>
          )}

          {nonCatalogCount > 0 && (
            <p className="text-[11px] text-muted-foreground">
              {nonCatalogCount} non-catalog (sample) line{nonCatalogCount === 1 ? "" : "s"} on this
              shipment {nonCatalogCount === 1 ? "isn't" : "aren't"} received into inventory.
            </p>
          )}

          {/* Footer: totals + close-short escape hatch once partially received */}
          <div className="flex items-center justify-between gap-3 border-t border-border/50 pt-3">
            <p className="text-xs text-muted-foreground tabular-nums">
              {cartonMode && (
                <>
                  {receivedCartons.toLocaleString()} of {totalCartons.toLocaleString()} cartons
                  {" · "}
                </>
              )}
              {receivedUnits.toLocaleString()} of {totalUnits.toLocaleString()} units received
            </p>
            {canEdit && partiallyReceived && !headlineDone && (
              <Button
                variant="ghost"
                size="sm"
                className="text-red-400 hover:text-red-300 hover:bg-red-500/10 h-7 text-xs"
                onClick={() => setCloseShortOpen(true)}
              >
                Close short…
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <CloseShortDialog
        open={closeShortOpen}
        onOpenChange={setCloseShortOpen}
        shipment={shipment}
        lineItems={lineItems}
      />
    </>
  );
}
