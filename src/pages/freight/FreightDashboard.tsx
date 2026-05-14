import { StatCard } from "@/components/shared/StatCard";
import {
  Ship,
  Plane,
  AlertTriangle,
  DollarSign,
  Plus,
  ChevronDown,
  Package,
  Calendar,
  Truck,
  CheckSquare,
  Square,
  RefreshCw,
  PackageCheck,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useNavigate } from "react-router-dom";
import { EtaCell } from "@/components/freight/EtaCell";
import { StatusSelectWithOverride } from "@/components/freight/StatusSelectWithOverride";
import { ShipmentTrackingWorker, useRefreshAllTracking } from "@/lib/tracking/use-shipment-tracking";
import { getCarrierTrackingUrl } from "@/lib/tracking/carrier-urls";
import { useToast } from "@/hooks/use-toast";
import { useMemo, useState } from "react";
import { format, differenceInDays, parseISO } from "date-fns";
import { cn } from "@/lib/utils";
import { useUrlFilter } from "@/lib/use-url-filter";
import {
  useFreightShipments,
  useFreightLineItems,
  useConfirmFreightReceipt,
  type FreightLineItemWithProduct,
} from "@/lib/hooks";
import type { FreightShipment } from "@/types/database";
import { useAuth } from "@/lib/auth-context";

// Delivered shipments visibility:
//   * Receipt-confirmed deliveries within the last RECENT_DELIVERY_DAYS
//     are always visible (operators are still likely to be cycle-counting
//     against them or referencing them for any inbound discrepancies).
//   * Older receipt-confirmed deliveries are hidden by default. A button
//     reveals them in batches of REVEAL_BATCH_SIZE, most-recent-first;
//     each subsequent click of "Show more" reveals another batch.
const RECENT_DELIVERY_DAYS = 3;
const REVEAL_BATCH_SIZE = 20;

export default function FreightDashboard() {
  const navigate = useNavigate();
  const [filter, setFilter] = useUrlFilter<"all" | "sea" | "air" | "high_risk">("filter", "all");
  // Number of "older than RECENT_DELIVERY_DAYS" deliveries currently
  // revealed past the default. Starts at 0 (all old ones hidden); each
  // "Show N more" click adds REVEAL_BATCH_SIZE. Resets on page refresh
  // by design — the default state of "recent only" is the right landing
  // view; a freshly-loaded page shouldn't carry over a previous deep dive.
  const [revealedOlderCount, setRevealedOlderCount] = useState(0);

  const { data: freight = [], isLoading } = useFreightShipments();
  const { data: freightLineItems = [] } = useFreightLineItems();
  const { refresh: refreshTracking, isRefreshing } = useRefreshAllTracking();
  const { toast } = useToast();

  async function handleRefreshTracking() {
    try {
      const report = await refreshTracking();
      const bits: string[] = [];
      bits.push(`${report.shipments_checked} checked`);
      if (report.eta_changes > 0) bits.push(`${report.eta_changes} ETA${report.eta_changes === 1 ? "" : "s"} updated`);
      if (report.status_changes > 0) bits.push(`${report.status_changes} status change${report.status_changes === 1 ? "" : "s"}`);
      if (report.errors > 0) bits.push(`${report.errors} error${report.errors === 1 ? "" : "s"}`);
      const noChanges = report.eta_changes === 0 && report.status_changes === 0 && report.errors === 0;
      toast({
        title: "Tracking refreshed",
        description: noChanges ? `${report.shipments_checked} shipment${report.shipments_checked === 1 ? "" : "s"} checked, no changes` : bits.join(" · "),
        variant: report.errors > 0 ? "destructive" : "default",
      });
    } catch (err) {
      toast({
        title: "Tracking refresh failed",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    }
  }

  const stats = useMemo(() => {
    const active = freight.filter(f => f.status !== "delivered");
    const seaCount = active.filter(f => f.freight_type === "sea").length;
    const airCount = active.filter(f => f.freight_type === "air").length;
    const highRiskCount = active.filter(f => f.status === "high_risk").length;

    const highRiskItems = freightLineItems.filter(li => {
      const shipment = freight.find(f => f.id === li.freight_shipment_id);
      return shipment?.status === "high_risk";
    });
    const cashAtRiskCost = highRiskItems.reduce((s, li) => s + (li.unit_cost ?? 0) * li.quantity, 0);
    const cashAtRiskRetail = highRiskItems.reduce((s, li) => s + (li.retail_value ?? 0) * li.quantity, 0);

    return { seaCount, airCount, highRiskCount, cashAtRiskCost, cashAtRiskRetail };
  }, [freight, freightLineItems]);

  const sortedFreight = useMemo(() => {
    let filtered = freight;
    if (filter === "sea") filtered = filtered.filter(f => f.freight_type === "sea");
    else if (filter === "air") filtered = filtered.filter(f => f.freight_type === "air");
    else if (filter === "high_risk") filtered = filtered.filter(f => f.status === "high_risk");

    // Pending receipt: carrier flipped status to delivered, but admin/manager
    // hasn't confirmed physical receipt yet. These get pinned to the top of
    // the list with green-glow styling and a "Confirm receipt" button so
    // operators can't miss them. Inventory only credits on confirmation.
    const pendingReceipt = filtered
      .filter(f => f.status === "delivered" && !f.receipt_confirmed_at)
      .sort((a, b) => {
        // Most recently delivered first
        if (!a.actual_arrival_date) return 1;
        if (!b.actual_arrival_date) return -1;
        return b.actual_arrival_date.localeCompare(a.actual_arrival_date);
      });

    // In-transit ordering: tier-by-status first, then shipment_number
    // ascending within each tier. Tier order goes high_risk → tracking
    // → cleared_customs → on_the_water → pending so the closest-to-here
    // shipments cluster at the top regardless of which one's ETA happens
    // to be soonest. Inside each tier, numeric shipment_number puts the
    // oldest order first; falls back to lexicographic for any carrier-
    // prefixed numbers that aren't pure-digit.
    const STATUS_TIER: Record<string, number> = {
      high_risk: 0,
      tracking: 1,
      cleared_customs: 2,
      on_the_water: 3,
      pending: 4,
    };
    function cmpShipmentNumber(a: string | null, b: string | null): number {
      if (!a) return 1;
      if (!b) return -1;
      const na = parseInt(a, 10);
      const nb = parseInt(b, 10);
      if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) {
        return na - nb;
      }
      return a.localeCompare(b);
    }
    const inTransit = filtered
      .filter(f => f.status !== "delivered")
      .sort((a, b) => {
        const tierA = STATUS_TIER[a.status] ?? 99;
        const tierB = STATUS_TIER[b.status] ?? 99;
        if (tierA !== tierB) return tierA - tierB;
        return cmpShipmentNumber(a.shipment_number, b.shipment_number);
      });

    const delivered = filtered
      .filter(f => f.status === "delivered" && !!f.receipt_confirmed_at)
      .sort((a, b) => {
        if (!a.actual_arrival_date) return 1;
        if (!b.actual_arrival_date) return -1;
        return b.actual_arrival_date.localeCompare(a.actual_arrival_date);
      });

    // Split into recent (visible always) and older (hidden by default,
    // revealed in batches via the "Show N more" button). Cutoff is
    // RECENT_DELIVERY_DAYS calendar days back from today, evaluated at
    // midnight UTC to avoid intra-day boundary flakiness.
    const cutoff = new Date();
    cutoff.setUTCDate(cutoff.getUTCDate() - RECENT_DELIVERY_DAYS);
    const cutoffIso = cutoff.toISOString().slice(0, 10);
    const recentDelivered: FreightShipment[] = [];
    const olderDelivered: FreightShipment[] = [];
    for (const f of delivered) {
      // Sort key was actual_arrival_date; group by the same field.
      // Missing dates fall to the older bucket (defensive — these
      // shouldn't exist for receipt_confirmed_at-set rows).
      if (f.actual_arrival_date && f.actual_arrival_date >= cutoffIso) {
        recentDelivered.push(f);
      } else {
        olderDelivered.push(f);
      }
    }
    const revealedOlder = olderDelivered.slice(0, revealedOlderCount);
    const visibleDelivered = [...recentDelivered, ...revealedOlder];
    const remainingOlder = olderDelivered.length - revealedOlder.length;

    return {
      pendingReceipt,
      inTransit,
      delivered: visibleDelivered,
      remainingOlder,
      totalOlderHidden: olderDelivered.length,
      totalDelivered: delivered.length,
    };
  }, [filter, revealedOlderCount, freight]);

  // Pre-bucket line items by shipment so each card render is O(1) instead
  // of a fresh filter pass.
  const linesByShipment = useMemo(() => {
    const out = new Map<string, FreightLineItemWithProduct[]>();
    for (const li of freightLineItems) {
      const arr = out.get(li.freight_shipment_id);
      if (arr) arr.push(li);
      else out.set(li.freight_shipment_id, [li]);
    }
    return out;
  }, [freightLineItems]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64 text-muted-foreground text-sm">
        Loading shipments…
      </div>
    );
  }

  return (
    // max-w-5xl matches the supplier ShipmentsList — keeps card meta rows
    // dense and readable instead of stretching across wide monitors.
    <div className="space-y-6 max-w-5xl">
      {/* Background workers — one per active shipment, polls carrier APIs.
          Mounted at page level so unmounting a card (e.g. via filter
          change) doesn't kill an in-flight tracking request. */}
      {sortedFreight.inTransit.map(f => (
        <ShipmentTrackingWorker key={f.id} shipment={f} />
      ))}

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Freight Tracking</h1>
          <p className="text-muted-foreground">Monitor all shipments</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={handleRefreshTracking} disabled={isRefreshing}>
            <RefreshCw className={cn("mr-2 h-4 w-4", isRefreshing && "animate-spin")} />
            {isRefreshing ? "Refreshing…" : "Refresh tracking"}
          </Button>
          <Button onClick={() => navigate("/freight/new")}>
            <Plus className="mr-2 h-4 w-4" />
            New Shipment
          </Button>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard title="Sea Freight" value={stats.seaCount} subtitle="Active shipments" icon={Ship} iconColor="text-blue-400" />
        <StatCard title="Air Freight" value={stats.airCount} subtitle="Active shipments" icon={Plane} iconColor="text-cyan-400" />
        <StatCard title="High Risk" value={stats.highRiskCount} subtitle="Under inspection" icon={AlertTriangle} iconColor="text-red-400" />
        <StatCard title="Cash at Risk" value={`$${stats.cashAtRiskCost.toLocaleString()}`} subtitle={`$${stats.cashAtRiskRetail.toLocaleString()} retail value`} icon={DollarSign} iconColor="text-yellow-400" />
      </div>

      <Tabs value={filter} onValueChange={(v) => setFilter(v as typeof filter)}>
        <TabsList>
          <TabsTrigger value="all">All</TabsTrigger>
          <TabsTrigger value="sea">Sea</TabsTrigger>
          <TabsTrigger value="air">Air</TabsTrigger>
          <TabsTrigger value="high_risk">High Risk</TabsTrigger>
        </TabsList>
      </Tabs>

      {sortedFreight.inTransit.length === 0 && sortedFreight.totalDelivered === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No shipments match the current filter.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {/* Pending receipt confirmation: carrier-flagged delivered but
              awaiting admin/manager sign-off. Pinned to the very top so
              they're impossible to miss. ShipmentCard adds green-glow
              styling + the Confirm Receipt button for these. */}
          {sortedFreight.pendingReceipt.length > 0 && (
            <>
              <div className="flex items-center gap-3 pb-1 px-1">
                <div className="h-px bg-green-500/40 flex-1" />
                <span className="text-[10px] uppercase tracking-wider text-green-400 font-semibold inline-flex items-center gap-1.5">
                  <PackageCheck className="h-3 w-3" />
                  Awaiting Receipt Confirmation ({sortedFreight.pendingReceipt.length})
                </span>
                <div className="h-px bg-green-500/40 flex-1" />
              </div>
              {sortedFreight.pendingReceipt.map(f => (
                <ShipmentCard
                  key={f.id}
                  shipment={f}
                  lines={linesByShipment.get(f.id) ?? []}
                />
              ))}
            </>
          )}

          {sortedFreight.pendingReceipt.length > 0 && sortedFreight.inTransit.length > 0 && (
            <div className="flex items-center gap-3 pt-4 pb-1 px-1">
              <div className="h-px bg-border flex-1" />
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                In Transit
              </span>
              <div className="h-px bg-border flex-1" />
            </div>
          )}

          {sortedFreight.inTransit.map(f => (
            <ShipmentCard
              key={f.id}
              shipment={f}
              lines={linesByShipment.get(f.id) ?? []}
            />
          ))}

          {sortedFreight.inTransit.length > 0 && sortedFreight.delivered.length > 0 && (
            <div className="flex items-center gap-3 pt-4 pb-1 px-1">
              <div className="h-px bg-border flex-1" />
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Delivered
              </span>
              <div className="h-px bg-border flex-1" />
            </div>
          )}

          {sortedFreight.delivered.map(f => (
            <ShipmentCard
              key={f.id}
              shipment={f}
              lines={linesByShipment.get(f.id) ?? []}
            />
          ))}

          {/* Reveal-more button — sized one batch at a time so a long
              delivered history doesn't dump a massive list into the DOM
              when the user just wants to peek. Button text reflects the
              two states: nothing-revealed-yet (show first batch) vs
              some-revealed (show next batch). */}
          {sortedFreight.remainingOlder > 0 && (
            <div className="flex justify-center pt-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  setRevealedOlderCount((n) => n + REVEAL_BATCH_SIZE)
                }
                className="text-xs text-muted-foreground"
              >
                {revealedOlderCount === 0
                  ? `Show ${Math.min(REVEAL_BATCH_SIZE, sortedFreight.totalOlderHidden)} hidden delivered (${sortedFreight.totalOlderHidden} older than ${RECENT_DELIVERY_DAYS} days)`
                  : `Show ${Math.min(REVEAL_BATCH_SIZE, sortedFreight.remainingOlder)} more (${sortedFreight.remainingOlder} remaining)`}
                <ChevronDown className="ml-1 h-3 w-3" />
              </Button>
            </div>
          )}
        </div>
      )}

    </div>
  );
}

// ---------------------------------------------------------------------------
// ShipmentCard — admin-side card mirroring the supplier portal's layout
// (single-row dense header with cartons-primary + meta grid; lines table
// below) with admin-only additions: inline status override, EtaCell with
// auto-tracking timestamp, days-left chip, and per-line cost columns.
// Whole card is a click target → navigates to /freight/:id. Interactive
// children (status select) stop propagation so they don't hijack clicks.
// ---------------------------------------------------------------------------
function ShipmentCard({
  shipment,
  lines,
}: {
  shipment: FreightShipment;
  lines: FreightLineItemWithProduct[];
}) {
  const navigate = useNavigate();
  const { isAdmin, isManager, user } = useAuth();
  const { toast } = useToast();
  const confirmReceipt = useConfirmFreightReceipt();
  const totalUnits = lines.reduce((sum, l) => sum + (l.quantity ?? 0), 0);
  const totalCartons = shipment.total_cartons ?? 0;
  const totalCost = lines.reduce((s, l) => s + (l.unit_cost ?? 0) * (l.quantity ?? 0), 0);

  const isPending = shipment.status === "pending";
  const isHighRisk = shipment.status === "high_risk";
  const missingTracking = isPending && !shipment.tracking_number;
  // Pending receipt: carrier said delivered, operator hasn't confirmed yet.
  const isPendingReceipt = shipment.status === "delivered" && !shipment.receipt_confirmed_at;

  // Border tint precedence: pending_receipt (green glow, most actionable) >
  // high_risk (red) > missing tracking on pending (amber) > primary.
  const borderTone = isPendingReceipt
    ? "border-l-4 border-l-green-500 ring-2 ring-green-500/40 shadow-[0_0_15px_rgba(34,197,94,0.25)]"
    : isHighRisk
      ? "border-l-4 border-l-red-500/70"
      : missingTracking
        ? "border-l-4 border-l-amber-500/70"
        : "border-l-4 border-l-primary/50";

  // Days left until ETA; only meaningful for in-transit shipments. Color
  // tiers: red overdue, amber <5d, muted otherwise. Delivered shows nothing
  // here (the card belongs to the Delivered section).
  const daysLeft = shipment.eta && shipment.status !== "delivered"
    ? differenceInDays(parseISO(shipment.eta), new Date())
    : null;

  function activate() {
    navigate(`/freight/${shipment.id}`);
  }

  async function handleConfirmReceipt(e: React.MouseEvent) {
    e.stopPropagation();
    if (!user) return;
    try {
      const result = await confirmReceipt.mutateAsync({
        shipmentId: shipment.id,
        actorId: user.id,
      });
      const lineCount = result.line_items_processed ?? 0;
      toast({
        title: `Receipt confirmed: ${shipment.shipment_number}`,
        description: `${lineCount} line item${lineCount === 1 ? "" : "s"} credited to warehouse_raw`,
      });
    } catch (err) {
      toast({
        title: "Confirmation failed",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    }
  }

  return (
    <Card
      className={`${borderTone} cursor-pointer transition-colors hover:bg-accent/20 focus-within:ring-2 focus-within:ring-primary/40`}
      role="button"
      tabIndex={0}
      onClick={activate}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          activate();
        }
      }}
    >
      {/* Confirmation banner — only when pending receipt. Shows carrier
          delivery date + Confirm Receipt button (admin/manager only). */}
      {isPendingReceipt && (
        <div className="flex items-center justify-between gap-3 px-5 py-2.5 bg-green-500/10 border-b border-green-500/30">
          <div className="flex items-center gap-2 text-sm">
            <PackageCheck className="h-4 w-4 text-green-400 shrink-0" />
            <span className="text-green-100">
              Marked delivered by carrier
              {shipment.actual_arrival_date && (
                <> on <span className="font-medium">{format(parseISO(shipment.actual_arrival_date), "MMM d, yyyy")}</span></>
              )}.{" "}
              <span className="text-green-300/80">
                {(isAdmin || isManager)
                  ? "Confirm receipt to credit warehouse inventory."
                  : "Awaiting admin or manager to confirm receipt."}
              </span>
            </span>
          </div>
          {(isAdmin || isManager) && (
            <Button
              size="sm"
              variant="default"
              className="bg-green-600 hover:bg-green-500 text-white shrink-0"
              onClick={handleConfirmReceipt}
              disabled={confirmReceipt.isPending}
            >
              <PackageCheck className="mr-1.5 h-3.5 w-3.5" />
              {confirmReceipt.isPending ? "Confirming…" : "Confirm receipt"}
            </Button>
          )}
        </div>
      )}
      <CardContent className="p-0">
        {/* Header — single row: identity cluster (left) + cartons callout
            (middle) + meta grid (right). Same shape as the supplier card
            with the status badge replaced by the editable status select. */}
        <div className="px-5 py-2.5 border-b border-border/80 bg-muted/30 flex items-center gap-5">
          <div className="shrink-0 flex items-center gap-4">
            <div>
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="font-mono text-sm font-semibold">
                  {shipment.shipment_number ?? (
                    <span className="italic text-muted-foreground font-normal">
                      awaiting number
                    </span>
                  )}
                </span>
                {shipment.freight_type === "sea" ? (
                  <Ship className="h-3.5 w-3.5 text-blue-400" aria-label="Sea freight" />
                ) : (
                  <Plane className="h-3.5 w-3.5 text-cyan-400" aria-label="Air freight" />
                )}
              </div>
              {/* Editable status + admin-only context badges. Stop
                  propagation so opening the dropdown doesn't trigger
                  the card's click-to-navigate. */}
              <div
                className="flex items-center gap-1.5 mt-1 flex-wrap"
                onClick={(e) => e.stopPropagation()}
              >
                <StatusSelectWithOverride shipment={shipment} variant="compact" />
                {missingTracking && (
                  <Badge
                    variant="outline"
                    className="border-amber-500/40 text-amber-400 text-[10px] py-0"
                  >
                    tracking missing
                  </Badge>
                )}
                {daysLeft !== null && (
                  <Badge
                    variant="outline"
                    className={cn(
                      "text-[10px] py-0 tabular-nums",
                      daysLeft < 0
                        ? "border-red-500/40 text-red-400"
                        : daysLeft < 5
                          ? "border-amber-500/40 text-amber-400"
                          : "border-border text-muted-foreground",
                    )}
                  >
                    {daysLeft < 0 ? `${Math.abs(daysLeft)}d overdue` : `${daysLeft}d left`}
                  </Badge>
                )}
              </div>
            </div>
            {/* Totals callout — cartons primary (matches supplier),
                units + cost as supporting context. */}
            <div className="text-right border-l border-border/50 pl-4">
              <div className="text-3xl font-semibold tabular-nums leading-none">
                {totalCartons.toLocaleString()}
              </div>
              <div className="text-[10px] text-muted-foreground uppercase tracking-wider mt-0.5">
                carton{totalCartons === 1 ? "" : "s"}
              </div>
              <div className="text-xs text-muted-foreground mt-1 tabular-nums">
                {totalUnits.toLocaleString()} units
              </div>
            </div>
          </div>

          {/* Meta grid — Tracking / Carrier / Cost / Shipped / ETA. ETA
              uses EtaCell so it carries the auto-tracking timestamp +
              refresh button (admin-only behavior). */}
          <div className="flex-1 min-w-0 grid grid-cols-2 sm:grid-cols-3 gap-x-5 gap-y-1.5 text-sm border-l border-border/50 pl-5">
            <DetailRow
              icon={<Truck className="h-3.5 w-3.5" />}
              label="Tracking"
              value={shipment.tracking_number}
              mono
              href={getCarrierTrackingUrl(shipment.carrier_name, shipment.tracking_number)}
            />
            <DetailRow
              icon={<Package className="h-3.5 w-3.5" />}
              label="Carrier"
              value={shipment.carrier_name}
            />
            <DetailRow
              icon={<DollarSign className="h-3.5 w-3.5" />}
              label="Freight cost"
              value={
                shipment.freight_cost && shipment.freight_cost > 0
                  ? `$${shipment.freight_cost.toLocaleString()}`
                  : null
              }
            />
            <DetailRow
              icon={<Calendar className="h-3.5 w-3.5" />}
              label="Shipped"
              value={shipment.ship_date ? format(parseISO(shipment.ship_date), "MMM d, yyyy") : null}
            />
            <div className="flex items-start gap-2 min-w-0">
              <span className="text-muted-foreground/70 mt-0.5 shrink-0">
                <Calendar className="h-3.5 w-3.5" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  ETA
                </div>
                <div className="text-sm">
                  <EtaCell shipment={shipment} />
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Lines — admin gets two extra columns vs. supplier:
            unit cost and line total. Prefilled stays as a boolean
            checkbox (consistent with supplier view). */}
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-wider text-muted-foreground">
              <th className="px-5 py-2">SKU</th>
              <th className="px-3 py-2 text-right">Qty</th>
              <th className="px-3 py-2 text-right">Unit Cost</th>
              <th className="px-3 py-2 text-right">Line Total</th>
              <th className="px-3 py-2 text-center w-24">Prefilled</th>
            </tr>
          </thead>
          <tbody>
            {lines.length === 0 ? (
              <tr>
                <td
                  colSpan={5}
                  className="px-5 py-4 text-center text-xs text-muted-foreground italic"
                >
                  No line items on this shipment.
                </td>
              </tr>
            ) : (
              <>
                {lines.map((line) => (
                  <LineRow key={line.id} line={line} />
                ))}
                {lines.length > 1 && (
                  <tr className="border-t border-border/50 bg-muted/20">
                    <td
                      className="px-5 py-2 text-[10px] uppercase tracking-wider text-muted-foreground"
                      colSpan={3}
                    >
                      Shipment Total
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums font-semibold">
                      ${totalCost.toLocaleString()}
                    </td>
                    <td className="px-3 py-2" />
                  </tr>
                )}
              </>
            )}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// DetailRow — icon + label + value in the meta grid. Same pattern as the
// supplier card. Empty values render a muted em dash so the grid stays
// aligned regardless of which fields are populated.
// ---------------------------------------------------------------------------
function DetailRow({
  icon,
  label,
  value,
  mono,
  href,
}: {
  icon: React.ReactNode;
  label: string;
  value: string | null | undefined;
  mono?: boolean;
  /** Optional external URL; when present, the value renders as an anchor
   *  that opens in a new tab. Used for carrier tracking page links. */
  href?: string | null;
}) {
  const empty = !value;
  const baseClass = `text-sm truncate ${mono ? "font-mono text-xs" : ""} ${
    empty ? "text-muted-foreground/60" : ""
  }`;
  return (
    <div className="flex items-start gap-2 min-w-0">
      <span className="text-muted-foreground/70 mt-0.5 shrink-0">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
        {href && value ? (
          // Stop propagation so clicking the link doesn't also trigger
          // the surrounding card's navigate-to-detail handler.
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className={`${baseClass} text-primary hover:underline block`}
            title="Open carrier tracking page"
          >
            {value}
          </a>
        ) : (
          <div className={baseClass}>{value ?? "—"}</div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// LineRow — admin-side line: SKU + Qty + Unit Cost + Line Total + boolean
// Prefilled. Costs are nullable in the schema so each math/format call
// guards with `?? 0`.
// ---------------------------------------------------------------------------
function LineRow({ line }: { line: FreightLineItemWithProduct }) {
  const unitCost = line.unit_cost ?? 0;
  const qty = line.quantity ?? 0;
  const lineTotal = unitCost * qty;
  const prefilled = line.quantity_prefilled;

  let prefilledCell: React.ReactNode;
  if (prefilled === null || prefilled === undefined) {
    prefilledCell = (
      <span className="text-muted-foreground/60 text-xs" title="Not a fillable SKU">
        —
      </span>
    );
  } else if (prefilled > 0) {
    prefilledCell = (
      <span className="inline-flex items-center gap-1.5 text-green-400" title="Prefilled">
        <CheckSquare className="h-4 w-4" />
        <span className="text-xs">Yes</span>
      </span>
    );
  } else {
    prefilledCell = (
      <span className="inline-flex items-center gap-1.5 text-muted-foreground" title="Not prefilled">
        <Square className="h-4 w-4" />
        <span className="text-xs">No</span>
      </span>
    );
  }

  return (
    <tr className="border-t border-border/50">
      <td className="px-5 py-2.5">
        {line.product ? (
          <div className="flex items-baseline gap-2 min-w-0">
            <span className="font-mono text-xs">{line.product.sku}</span>
            <span className="text-muted-foreground text-xs truncate">
              {line.product.product_name}
            </span>
          </div>
        ) : (
          <span className="font-mono text-xs text-muted-foreground">
            {line.sku_id.slice(0, 8)}…
          </span>
        )}
      </td>
      <td className="px-3 py-2.5 text-right tabular-nums font-medium">
        {qty.toLocaleString()}
      </td>
      <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">
        {unitCost > 0 ? `$${unitCost.toFixed(2)}` : "—"}
      </td>
      <td className="px-3 py-2.5 text-right tabular-nums">
        {lineTotal > 0 ? `$${lineTotal.toLocaleString()}` : "—"}
      </td>
      <td className="px-3 py-2.5 text-center">{prefilledCell}</td>
    </tr>
  );
}
