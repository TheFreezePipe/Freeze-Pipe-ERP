import { Link, useNavigate } from "react-router-dom";
import { format, parseISO } from "date-fns";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  useSupplierFreightShipments,
  type SupplierFreightShipmentWithLines,
  type SupplierFreightLineItemRow,
} from "@/lib/hooks";
import {
  Plus,
  Ship,
  Plane,
  Package,
  Calendar,
  Truck,
  DollarSign,
  CheckSquare,
  Square,
} from "lucide-react";

import { FREIGHT_STATUS_COLORS as STATUS_COLOR } from "@/lib/status-colors";

export default function ShipmentsList() {
  const { data, isLoading, error } = useSupplierFreightShipments();
  if (isLoading) return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;
  if (error) return <div className="p-6 text-sm text-red-400">Error loading shipments.</div>;

  const shipments = data ?? [];

  return (
    // max-w-5xl caps the reading width so meta rows stay dense and readable
    // rather than stretching into thin columns on large monitors.
    <div className="space-y-4 max-w-5xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Shipments</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Freight you've declared. Click a shipment to add tracking info or edit details.
          </p>
        </div>
        <Button asChild>
          <Link to="/supplier/shipments/new">
            <Plus className="mr-2 h-4 w-4" />
            New Shipment
          </Link>
        </Button>
      </div>

      {shipments.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No shipments yet.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {shipments.map((s) => (
            <ShipmentCard key={s.id} shipment={s} />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ShipmentCard — header block groups shipping metadata on the left (tracking,
// carrier, dates) with a prominent totals callout on the right (units,
// cartons, cost). Line items appear in a compact table below with a boolean
// prefilled indicator rather than per-unit counts — prefilling is all-or-
// nothing per SKU line in practice.
// ---------------------------------------------------------------------------
function ShipmentCard({
  shipment,
}: {
  shipment: SupplierFreightShipmentWithLines;
}) {
  const navigate = useNavigate();
  const lines = shipment.lines ?? [];
  const totalUnits = lines.reduce((sum, l) => sum + (l.quantity ?? 0), 0);
  const totalCartons = shipment.total_cartons ?? 0;
  const isPending = shipment.status === "pending";
  const missingTracking = isPending && !shipment.tracking_number;

  // Border tint: amber if we're still pending and there's no tracking
  // number yet (prompts the supplier to fill it in); primary otherwise.
  const borderTone = missingTracking
    ? "border-l-4 border-l-amber-500/70"
    : "border-l-4 border-l-primary/50";

  function activate() {
    navigate(`/supplier/shipments/${shipment.id}`);
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
      <CardContent className="p-0">
        {/* Header — identity + totals on one row (left), details grid (right).
            Single-row layout trims the vertical footprint vs. a stacked
            "identity → body" structure. Cartons are the primary number
            (that's what the supplier's actually loading onto the truck);
            units read as supporting context. */}
        <div className="px-5 py-2.5 border-b border-border/80 bg-muted/30 flex items-center gap-5">
          {/* Identity + totals — left side */}
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
              <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                <Badge
                  variant="outline"
                  className={`${STATUS_COLOR[shipment.status]} text-[10px] py-0`}
                >
                  {shipment.status.replace(/_/g, " ")}
                </Badge>
                {missingTracking && (
                  <Badge
                    variant="outline"
                    className="border-amber-500/40 text-amber-400 text-[10px] py-0"
                  >
                    tracking missing
                  </Badge>
                )}
              </div>
            </div>
            {/* Totals callout — cartons primary, units supporting */}
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

          {/* Shipping metadata — compact iconified grid on the right */}
          <div className="flex-1 min-w-0 grid grid-cols-2 sm:grid-cols-3 gap-x-5 gap-y-1.5 text-sm border-l border-border/50 pl-5">
            <DetailRow
              icon={<Truck className="h-3.5 w-3.5" />}
              label="Tracking"
              value={shipment.tracking_number}
              mono
            />
            <DetailRow
              icon={<Package className="h-3.5 w-3.5" />}
              label="Carrier"
              value={shipment.carrier_name}
            />
            <DetailRow
              icon={<DollarSign className="h-3.5 w-3.5" />}
              label="Cost"
              value={
                shipment.freight_cost && shipment.freight_cost > 0
                  ? `$${shipment.freight_cost.toLocaleString()}`
                  : null
              }
            />
            <DetailRow
              icon={<Calendar className="h-3.5 w-3.5" />}
              label="Shipped"
              value={shipment.ship_date ? fmtDate(shipment.ship_date) : null}
            />
            <DetailRow
              icon={<Calendar className="h-3.5 w-3.5" />}
              label="ETA"
              value={shipment.eta ? fmtDate(shipment.eta) : null}
            />
          </div>
        </div>

        {/* Lines — compact table with boolean prefilled indicator */}
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-wider text-muted-foreground">
              <th className="px-5 py-2">SKU</th>
              <th className="px-3 py-2 text-right">Qty</th>
              <th className="px-3 py-2 text-center w-24">Prefilled</th>
            </tr>
          </thead>
          <tbody>
            {lines.length === 0 ? (
              <tr>
                <td
                  colSpan={3}
                  className="px-5 py-4 text-center text-xs text-muted-foreground italic"
                >
                  No line items on this shipment.
                </td>
              </tr>
            ) : (
              lines.map((line) => <LineRow key={line.id} line={line} />)
            )}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// DetailRow — icon + label + value, with a consistent grayed "—" fallback so
// the meta grid stays aligned even when fields are empty.
// ---------------------------------------------------------------------------
function DetailRow({
  icon,
  label,
  value,
  mono,
}: {
  icon: React.ReactNode;
  label: string;
  value: string | null | undefined;
  mono?: boolean;
}) {
  const empty = !value;
  return (
    <div className="flex items-start gap-2 min-w-0">
      <span className="text-muted-foreground/70 mt-0.5 shrink-0">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
        <div
          className={`text-sm truncate ${mono ? "font-mono text-xs" : ""} ${
            empty ? "text-muted-foreground/60" : ""
          }`}
        >
          {value ?? "—"}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// LineRow — SKU + qty + boolean prefilled checkbox. Per business rule,
// prefilling is applied at the whole-line level: either every unit of this
// SKU on this shipment was prefilled or none were (no partial state).
//   quantity_prefilled > 0  → checked
//   quantity_prefilled == 0 → unchecked
//   quantity_prefilled null → non-fillable SKU; dash
// ---------------------------------------------------------------------------
function LineRow({ line }: { line: SupplierFreightLineItemRow }) {
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
      <span
        className="inline-flex items-center gap-1.5 text-green-400"
        title="Prefilled"
      >
        <CheckSquare className="h-4 w-4" />
        <span className="text-xs">Yes</span>
      </span>
    );
  } else {
    prefilledCell = (
      <span
        className="inline-flex items-center gap-1.5 text-muted-foreground"
        title="Not prefilled"
      >
        <Square className="h-4 w-4" />
        <span className="text-xs">No</span>
      </span>
    );
  }

  return (
    <tr className="border-t border-border/50">
      <td className="px-5 py-2.5">
        {line.sku ? (
          <div className="flex items-baseline gap-2 min-w-0">
            <span className="font-mono text-xs">{line.sku.sku}</span>
            <span className="text-muted-foreground text-xs truncate">
              {line.sku.product_name}
            </span>
          </div>
        ) : (
          <span className="font-mono text-xs text-muted-foreground">
            {line.sku_id.slice(0, 8)}…
          </span>
        )}
      </td>
      <td className="px-3 py-2.5 text-right tabular-nums font-medium">
        {line.quantity.toLocaleString()}
      </td>
      <td className="px-3 py-2.5 text-center">{prefilledCell}</td>
    </tr>
  );
}

function fmtDate(iso: string) {
  return format(parseISO(iso), "MMM d, yyyy");
}
