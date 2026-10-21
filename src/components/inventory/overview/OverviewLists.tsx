import { Link, useNavigate } from "react-router-dom";
import { format, parseISO } from "date-fns";
import { PackageCheck, Plane, Ship } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FREIGHT_STATUSES } from "@/lib/constants";
import { INVENTORY_ROUTES, shipmentPath, stockSearch } from "@/lib/inventory-routes";
import { BREAKAGE_STATUS_COLORS, FREIGHT_STATUS_COLORS, VARIANCE_STATUS_COLORS } from "@/lib/status-colors";
import type { FreightShipment } from "@/types/database";
import { cn, humanizeEnum } from "@/lib/utils";

// Row shapes the Overview derives; the lists below only render them.

export interface RunningLowRow {
  id: string;
  sku: string;
  name: string;
  finished: number;
  /** Warehouse days of supply, the Stock page's Warehouse DOS. */
  dos: number;
  inTransit: number;
  onOrder: number;
}

export interface ShipmentRow {
  shipment: FreightShipment;
  supplier: string | null;
  units: number;
  received: number;
}

export interface IssueRow {
  id: string;
  kind: "breakage" | "variance";
  createdAt: string;
  title: string;
  sku: string | null;
  supplier: string | null;
  status: string;
}

export interface MaterialRow {
  id: string;
  code: string;
  name: string;
  onHand: number;
  unit: string;
  reorderAt: number;
  runwayDays: number | null;
}

const ROW = "flex items-center justify-between gap-3 border-t border-border/50 py-2 first:border-t-0";

function dosTone(dos: number): string {
  if (dos < 7) return "text-red-400";
  if (dos < 14) return "text-amber-400";
  return "";
}

function FreightIcon({ type }: { type: string }) {
  return type === "sea" ? (
    <Ship className="h-3.5 w-3.5 shrink-0 text-blue-400" aria-label="Sea freight" />
  ) : (
    <Plane className="h-3.5 w-3.5 shrink-0 text-cyan-400" aria-label="Air freight" />
  );
}

function FreightStatusBadge({ status }: { status: string }) {
  const label = (FREIGHT_STATUSES as Record<string, { label: string }>)[status]?.label ?? humanizeEnum(status);
  return (
    <Badge variant="outline" className={cn("shrink-0 text-[10px]", FREIGHT_STATUS_COLORS[status])}>
      {label}
    </Badge>
  );
}

/** Lowest warehouse days of supply first. Row opens Stock filtered to the SKU. */
export function RunningLowList({ rows }: { rows: RunningLowRow[] }) {
  return (
    <div className="text-sm">
      <div className="grid grid-cols-[minmax(0,1fr)_4.5rem_3.5rem_minmax(0,1.2fr)] gap-x-3 px-2 pb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
        <span>SKU</span>
        <span className="text-right">Finished</span>
        <span className="text-right">Days</span>
        <span>Coming</span>
      </div>
      {rows.map((r) => {
        const coming = [
          r.inTransit > 0 ? `${r.inTransit.toLocaleString()} in transit` : null,
          r.onOrder > 0 ? `${r.onOrder.toLocaleString()} on order` : null,
        ].filter(Boolean);
        return (
          <Link
            key={r.id}
            to={stockSearch(r.sku)}
            className="grid grid-cols-[minmax(0,1fr)_4.5rem_3.5rem_minmax(0,1.2fr)] items-center gap-x-3 rounded-md border-t border-border/50 px-2 py-2 first-of-type:border-t-0 hover:bg-muted/40"
          >
            <span className="min-w-0">
              <span className="block truncate font-medium">{r.sku}</span>
              <span className="block truncate text-xs text-muted-foreground">{r.name}</span>
            </span>
            <span className={cn("text-right tabular-nums", r.finished === 0 && "text-red-400")}>
              {r.finished.toLocaleString()}
            </span>
            <span className={cn("text-right font-medium tabular-nums", dosTone(r.dos))}>
              {r.dos <= 0 ? "Out" : `${Math.round(r.dos)}d`}
            </span>
            <span className="truncate text-xs text-muted-foreground">{coming.length > 0 ? coming.join(" · ") : "Nothing coming"}</span>
          </Link>
        );
      })}
    </div>
  );
}

/** Next shipments by ETA. Row opens the shipment. */
export function ArrivingList({ rows }: { rows: ShipmentRow[] }) {
  return (
    <div className="text-sm">
      {rows.map(({ shipment, supplier, units }) => (
        <Link key={shipment.id} to={shipmentPath(shipment.id)} className={cn(ROW, "-mx-2 rounded-md px-2 hover:bg-muted/40")}>
          <span className="min-w-0">
            <span className="flex items-center gap-1.5">
              <FreightIcon type={shipment.freight_type} />
              <span className="truncate font-medium">{shipment.shipment_number}</span>
              <span className="truncate text-muted-foreground">
                {[supplier, `${units.toLocaleString()} units`].filter(Boolean).join(" · ")}
              </span>
            </span>
            <span className="block text-xs text-muted-foreground">
              {shipment.eta ? `ETA ${format(parseISO(shipment.eta), "EEE MMM d")}` : "No ETA yet"}
              {shipment.carrier_name ? ` · ${shipment.carrier_name}` : ""}
            </span>
          </span>
          <FreightStatusBadge status={shipment.status} />
        </Link>
      ))}
    </div>
  );
}

/** Shipments being checked in, each with a Check in button to its page. */
export function ReceivingList({ rows }: { rows: ShipmentRow[] }) {
  const navigate = useNavigate();
  return (
    <div className="text-sm">
      {rows.map(({ shipment, supplier, units, received }) => (
        <div key={shipment.id} className={ROW}>
          <span className="min-w-0">
            <span className="flex items-center gap-1.5">
              <FreightIcon type={shipment.freight_type} />
              <Link to={shipmentPath(shipment.id)} className="truncate font-medium hover:underline">
                {shipment.shipment_number}
              </Link>
              {supplier && <span className="truncate text-muted-foreground">{supplier}</span>}
            </span>
            <span className="block text-xs text-muted-foreground">
              {received.toLocaleString()} of {units.toLocaleString()} units checked in
              {shipment.eta ? ` · due ${format(parseISO(shipment.eta), "MMM d")}` : ""}
            </span>
          </span>
          <Button size="sm" variant="outline" className="h-8 shrink-0" onClick={() => navigate(shipmentPath(shipment.id))}>
            <PackageCheck className="mr-1.5 h-3.5 w-3.5" />
            Check in
          </Button>
        </div>
      ))}
    </div>
  );
}

/** Newest open breakage reports and shipment variances. */
export function IssuesList({ rows }: { rows: IssueRow[] }) {
  return (
    <div className="text-sm">
      {rows.map((r) => (
        <Link key={`${r.kind}-${r.id}`} to={INVENTORY_ROUTES.issues} className={cn(ROW, "-mx-2 rounded-md px-2 hover:bg-muted/40")}>
          <span className="min-w-0">
            <span className="flex items-center gap-1.5">
              <Badge
                variant="outline"
                className={cn(
                  "shrink-0 text-[10px]",
                  r.kind === "breakage" ? "border-red-500/30 text-red-400" : "border-amber-500/30 text-amber-400",
                )}
              >
                {r.kind === "breakage" ? "Breakage" : "Variance"}
              </Badge>
              <span className="truncate">{r.title}</span>
            </span>
            <span className="block truncate text-xs text-muted-foreground">
              {[r.sku, r.supplier, format(parseISO(r.createdAt), "MMM d")].filter(Boolean).join(" · ")}
            </span>
          </span>
          <Badge
            variant="outline"
            className={cn(
              "shrink-0 text-[10px]",
              (r.kind === "breakage" ? BREAKAGE_STATUS_COLORS : VARIANCE_STATUS_COLORS)[r.status],
            )}
          >
            {humanizeEnum(r.status)}
          </Badge>
        </Link>
      ))}
    </div>
  );
}

/** Materials below their reorder point, shortest runway first. */
export function MaterialsLowList({ rows }: { rows: MaterialRow[] }) {
  return (
    <div className="text-sm">
      {rows.map((m) => (
        <Link
          key={m.id}
          to={`${INVENTORY_ROUTES.materials}/${m.id}`}
          className={cn(ROW, "-mx-2 rounded-md px-2 hover:bg-muted/40")}
        >
          <span className="min-w-0">
            <span className="flex items-center gap-1.5">
              <span className="font-mono text-xs font-medium">{m.code}</span>
              <span className="truncate text-muted-foreground">{m.name}</span>
            </span>
            <span className="block text-xs text-muted-foreground">
              {m.onHand.toLocaleString()} {m.unit} on hand · reorder at {m.reorderAt.toLocaleString()}
            </span>
          </span>
          <span
            className={cn(
              "shrink-0 text-xs tabular-nums",
              // Same tiers as the Materials page's Days Runway column.
              m.runwayDays == null
                ? "text-muted-foreground"
                : m.runwayDays < 14
                  ? "text-red-400"
                  : m.runwayDays < 30
                    ? "text-amber-400"
                    : "",
            )}
            title="Days of stock at the current burn rate, as on the Materials page"
          >
            {m.runwayDays == null ? "no runway data" : `${Math.round(m.runwayDays)}d runway`}
          </span>
        </Link>
      ))}
    </div>
  );
}
