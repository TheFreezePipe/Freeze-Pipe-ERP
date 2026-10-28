import { lazy, Suspense, useState, type ComponentType } from "react";
import { Link, useParams } from "react-router-dom";
import { differenceInCalendarDays, format, parseISO } from "date-fns";
import {
  AlertCircle,
  ArrowDownToLine,
  ArrowRightLeft,
  CircleDot,
  ClipboardCheck,
  ClipboardList,
  Factory,
  Forklift,
  PackageCheck,
  PackageOpen,
  PackageSearch,
  Printer,
  RefreshCw,
  ScanLine,
  Ship,
  Tag,
  Truck,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CartonLink } from "@/components/warehouse/CartonLink";
import { LocationCode } from "@/components/warehouse/LocationCode";
import { FACTORY_ORDER_STATUSES, FREIGHT_STATUSES } from "@/lib/constants";
import type { WhCartonPassport } from "@/lib/hooks/use-warehouse";
import { useWhCartonPassport } from "@/lib/hooks/use-warehouse-passport";
import { factoryOrderPath, INVENTORY_ROUTES, shipmentPath } from "@/lib/inventory-routes";
import { CONTAINER_STATE_COLORS, FACTORY_ORDER_STATUS_COLORS, FREIGHT_STATUS_COLORS } from "@/lib/status-colors";
import { cn, humanizeEnum } from "@/lib/utils";

// Lazy: LabelSheet pulls in the barcode renderer (~1 MB); load it on first print.
const LabelSheet = lazy(() => import("@/components/warehouse/LabelSheet"));

/**
 * Carton passport (/inventory/cartons/:code; owner decision 2026-10-28): one
 * carton's life from its factory order to where it is now, on the layout of
 * the design canvas's "Carton passport" board. Reached by clicking a carton
 * code anywhere in the app (<CartonLink>), never from the navigation.
 *
 *   header      code, state, label stock, batch (factory order) and shipment
 *               chips, and the actions (print the label pair, move, count)
 *   summary     SKU, units and bucket, where it is and since when, its
 *               parent / relabelled children / replacement as passport links
 *   legs        elapsed time per leg (only the legs whose two ends exist)
 *   timeline    every recorded step, oldest first, with who did it
 *   batch       the factory order, where the rest of its cartons are now
 *   checks      the timeline's check-ins, counts and label prints
 *
 * Everything comes from rpc_wh_carton_passport; an unknown code is a
 * not-found state, not an error.
 */

type Passport = WhCartonPassport;
type Carton = Passport["carton"];
type Batch = Passport["batch"];
type TimelineEntry = Passport["timeline"][number];
type Legs = Passport["legs"];

const CHIP = "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-[11px] font-semibold";
const TONE = {
  green: "border-green-500/40 bg-green-500/10 text-green-400",
  amber: "border-amber-500/35 bg-amber-500/10 text-amber-400",
  red: "border-orange-400/40 bg-orange-400/10 text-orange-300",
  blue: "border-blue-500/40 bg-blue-500/10 text-blue-300",
  grey: "border-slate-400/30 bg-slate-400/10 text-slate-300",
} as const;

const BUCKET_LABEL: Record<string, string> = {
  raw: "Raw",
  prefilled_raw: "Pre-filled raw",
  in_production: "In production",
  finished: "Finished",
  other: "Other",
};

/** The timeline's `kind` → its icon. Anything unknown gets a dot. */
const KIND_ICON: Record<string, ComponentType<{ className?: string }>> = {
  ordered: ClipboardList,
  factory: Factory,
  shipped: Ship,
  delivered: Truck,
  checked_in: PackageCheck,
  putaway: ArrowDownToLine,
  pulled: Forklift,
  moved: ArrowRightLeft,
  opened: PackageOpen,
  relabel: Tag,
  count: ClipboardCheck,
  labels: Printer,
  other: CircleDot,
};

/** Entries that verified the carton, for "Counts and checks". */
const CHECK_KINDS = new Set(["checked_in", "count", "labels"]);

/** Entries that put the carton where it is now (for "since"). */
const PLACE_KINDS = new Set(["checked_in", "putaway", "moved", "pulled", "relabel"]);

/** Entries whose time comes from a date column (no time of day). */
const DATE_KINDS = new Set(["ordered", "factory", "shipped", "delivered"]);

type LegKey =
  | "order_to_finished_days"
  | "finished_to_shipped_days"
  | "water_days"
  | "arrival_to_checkin_days"
  | "checkin_to_shelf_minutes"
  | "shelf_to_line_days"
  | "line_to_rts_days";

const LEG_LABELS: { key: LegKey; label: string; minutes?: boolean }[] = [
  { key: "order_to_finished_days", label: "Order → finished" },
  { key: "finished_to_shipped_days", label: "Finished → shipped" },
  { key: "water_days", label: "On the water" },
  { key: "arrival_to_checkin_days", label: "Arrival → check-in" },
  { key: "checkin_to_shelf_minutes", label: "Dock → shelf", minutes: true },
  { key: "shelf_to_line_days", label: "Shelf → line" },
  { key: "line_to_rts_days", label: "Line → RTS" },
];

// ---- formatting ----------------------------------------------------------------

/** A Postgres date or a midnight-UTC timestamp made from one, read as that calendar day. */
function dayOf(value: string): Date {
  return parseISO(value.slice(0, 10));
}

function isMidnightUtc(value: string): boolean {
  return /T00:00(:00(\.0+)?)?(Z|\+00(:?00)?)$/.test(value);
}

function sameYear(d: Date): boolean {
  return d.getFullYear() === new Date().getFullYear();
}

/** "Jul 28" (this year) or "Jul 28, 2025". */
function shortDate(value: string | null | undefined): string {
  if (!value) return "—";
  const d = /^\d{4}-\d{2}-\d{2}$/.test(value) || isMidnightUtc(value) ? dayOf(value) : parseISO(value);
  return format(d, sameYear(d) ? "MMM d" : "MMM d, yyyy");
}

/** A timeline time: the day alone for date-only steps, else "Oct 20 · 7:05 AM". */
function whenText(at: string | null | undefined, kind: string): string {
  if (!at) return "";
  if (DATE_KINDS.has(kind) && isMidnightUtc(at)) return shortDate(at);
  const d = parseISO(at);
  return `${format(d, sameYear(d) ? "MMM d" : "MMM d, yyyy")} · ${format(d, "h:mm a")}`;
}

function legValue(value: number, minutes: boolean): string {
  if (minutes) {
    if (value < 120) return `${Math.round(value)} min`;
    if (value < 48 * 60) return `${trim1(value / 60)} h`;
    return `${trim1(value / 1440)} d`;
  }
  return `${value < 10 ? trim1(value) : Math.round(value)} d`;
}

function trim1(n: number): string {
  return (Math.round(n * 10) / 10).toString();
}

function plural(n: number, word: string): string {
  return `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;
}

function factoryStatus(status: string | null | undefined): string {
  if (!status) return "";
  return FACTORY_ORDER_STATUSES[status as keyof typeof FACTORY_ORDER_STATUSES]?.label ?? humanizeEnum(status);
}

function freightStatus(status: string | null | undefined): string {
  if (!status) return "";
  return FREIGHT_STATUSES[status as keyof typeof FREIGHT_STATUSES]?.label ?? humanizeEnum(status);
}

// ---- page ------------------------------------------------------------------------

export default function CartonPassport() {
  const { code: raw = "" } = useParams<{ code: string }>();
  const code = safeDecode(raw).trim();
  const { data, isLoading, error, refetch, isFetching } = useWhCartonPassport(code);

  if (!code || (data && !data.found)) return <NotFound code={code} />;
  if (isLoading) return <PassportSkeleton code={code} />;
  if (error || !data) {
    return (
      <div className="space-y-4">
        <Crumbs code={code} />
        <div className="flex items-start gap-2 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-300">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="flex-1">{error instanceof Error ? error.message : "Couldn't load the carton passport"}</span>
          <Button size="sm" variant="outline" onClick={() => void refetch()} disabled={isFetching}>
            <RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", isFetching && "animate-spin")} /> Try again
          </Button>
        </div>
      </div>
    );
  }
  return <PassportView passport={data.passport} />;
}

/** A malformed %-sequence in a hand-typed URL is left as typed. */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function Crumbs({ code }: { code: string }) {
  return (
    <nav aria-label="Breadcrumb" className="text-xs text-muted-foreground">
      <Link to={INVENTORY_ROUTES.overview} className="hover:text-foreground hover:underline">
        Inventory
      </Link>
      {" › "}
      <Link to={INVENTORY_ROUTES.stock} className="hover:text-foreground hover:underline">
        Stock
      </Link>
      {" › Cartons › "}
      <span className="font-mono tabular-nums text-foreground/80">{code}</span>
    </nav>
  );
}

function NotFound({ code }: { code: string }) {
  return (
    <div className="space-y-4">
      <Crumbs code={code || "?"} />
      <Card>
        <CardContent className="space-y-3 py-10 text-center">
          <PackageSearch className="mx-auto h-8 w-8 text-muted-foreground" />
          <p className="text-base font-semibold">
            No carton <span className="font-mono tabular-nums">{code || "(no code)"}</span>
          </p>
          <p className="text-sm text-muted-foreground">
            Nothing in the warehouse has this code. Check it against the label, or find the carton from Stock.
          </p>
          <Button asChild variant="outline">
            <Link to={INVENTORY_ROUTES.stock}>Back to Stock</Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

function PassportSkeleton({ code }: { code: string }) {
  return (
    <div className="space-y-4" aria-busy="true" aria-label={`Loading carton ${code}`}>
      <Crumbs code={code} />
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="font-mono text-2xl font-bold tabular-nums">{code}</h1>
        <div className="h-5 w-24 animate-pulse rounded-full bg-muted/40" />
        <div className="h-5 w-20 animate-pulse rounded-full bg-muted/40" />
      </div>
      <div className="h-4 w-2/3 animate-pulse rounded bg-muted/30" />
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
        {Array.from({ length: 7 }, (_, i) => (
          <div key={i} className="h-14 animate-pulse rounded-lg border border-border/60 bg-muted/20" />
        ))}
      </div>
      <div className="grid gap-3 lg:grid-cols-[1.2fr_1fr]">
        <div className="h-96 animate-pulse rounded-lg border border-border/60 bg-muted/20" />
        <div className="h-72 animate-pulse rounded-lg border border-border/60 bg-muted/20" />
      </div>
    </div>
  );
}

function PassportView({ passport }: { passport: Passport }) {
  const { carton, batch, legs } = passport;
  const timeline = passport.timeline ?? [];
  const [printing, setPrinting] = useState(false);
  const fo = batch?.factory_order ?? null;
  const shipment = batch?.shipment ?? null;
  const green = carton.label_stock === "green";
  const isVoid = carton.state === "void";

  return (
    <div className="space-y-4">
      <Crumbs code={carton.code} />

      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h1 className="mr-1 font-mono text-2xl font-bold tabular-nums">{carton.code}</h1>
          <span className={cn(CHIP, CONTAINER_STATE_COLORS[carton.state] ?? TONE.grey)}>{carton.state}</span>
          <span className={cn(CHIP, green ? TONE.green : TONE.grey)}>{green ? "RTS · green label" : "white label"}</span>
          {fo && (
            <Link
              to={factoryOrderPath(fo.id)}
              className={cn(CHIP, TONE.blue, "hover:border-blue-400")}
              title={`Factory order ${fo.order_number ?? ""}`.trim()}
            >
              <Factory className="h-3 w-3" />
              {fo.order_number ?? "Factory order"}
            </Link>
          )}
          {shipment && (
            <Link
              to={shipmentPath(shipment.id)}
              className={cn(CHIP, TONE.grey, "hover:border-slate-300")}
              title={`Shipment ${shipment.shipment_number ?? ""}`.trim()}
            >
              <Ship className="h-3 w-3" />
              {shipment.shipment_number ?? "Shipment"}
            </Link>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => setPrinting(true)} disabled={isVoid} title={isVoid ? "A void carton has no label" : undefined}>
            <Printer className="mr-1.5 h-4 w-4" /> Print label pair
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link to="/go/move">
              <ArrowRightLeft className="mr-1.5 h-4 w-4" /> Move
            </Link>
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link to="/go/count">
              <ScanLine className="mr-1.5 h-4 w-4" /> Count now
            </Link>
          </Button>
          {fo && (
            <Button asChild size="sm">
              <Link to={factoryOrderPath(fo.id)}>Open batch</Link>
            </Button>
          )}
        </div>
      </header>

      <Summary carton={carton} batch={batch} timeline={timeline} />

      <LegsStrip legs={legs} />

      <div className="grid gap-3 lg:grid-cols-[1.2fr_1fr]">
        <TimelineCard timeline={timeline} />
        <div className="flex min-w-0 flex-col gap-3">
          <BatchCard batch={batch} />
          <ChecksCard timeline={timeline} />
        </div>
      </div>

      {printing && (
        <Suspense fallback={null}>
          <LabelSheet
            open
            onOpenChange={(open) => !open && setPrinting(false)}
            kind={green ? "lpn_rts" : "lpn"}
            ids={[carton.id]}
            from="desktop"
            title={`label pair ${carton.code}`}
          />
        </Suspense>
      )}
    </div>
  );
}

// ---- summary line ------------------------------------------------------------------

function Summary({ carton, batch, timeline }: { carton: Carton; batch: Batch; timeline: TimelineEntry[] }) {
  const placed = [...timeline].reverse().find((t) => PLACE_KINDS.has(t.kind) && t.at);
  const since = placed?.at ?? carton.created_at;
  const orderDate = batch?.factory_order?.order_date ?? null;
  const shelved = timeline.find((t) => t.kind === "putaway" && t.at)?.at ?? null;
  const orderToShelf = orderDate && shelved ? differenceInCalendarDays(parseISO(shelved), dayOf(orderDate)) : null;
  const children = carton.children ?? [];

  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-sm">
      <span>
        <strong>{carton.sku ?? "MIXED"}</strong>
        {carton.product_name && <span className="text-muted-foreground"> · {carton.product_name}</span>}
      </span>
      <span>
        <strong className="tabular-nums">{carton.qty.toLocaleString()}</strong>
        {carton.qty_initial !== carton.qty && <span className="tabular-nums text-muted-foreground"> of {carton.qty_initial.toLocaleString()}</span>}{" "}
        units{carton.bucket ? ` · ${BUCKET_LABEL[carton.bucket] ?? humanizeEnum(carton.bucket)}` : ""}
      </span>
      {carton.location_code && (
        <span className="inline-flex flex-wrap items-baseline gap-x-1">
          at <LocationCode code={carton.location_code} size="small" className="text-sm" /> since {whenText(since, "other")}
        </span>
      )}
      {carton.carton_seq != null && carton.carton_of != null && (
        <span className="text-muted-foreground">
          carton <span className="tabular-nums">{carton.carton_seq}</span> of <span className="tabular-nums">{carton.carton_of}</span>
        </span>
      )}
      {carton.parent && (
        <span>
          from <CartonLink code={carton.parent.code} />
          <span className="text-muted-foreground"> ({carton.parent.state})</span>
        </span>
      )}
      {children.length > 0 && (
        <span>
          relabelled as{" "}
          {children.map((c, i) => (
            <span key={c.id}>
              {i > 0 && ", "}
              <CartonLink code={c.code} />
            </span>
          ))}
        </span>
      )}
      {carton.superseded_by && (
        <span className="text-amber-300">
          superseded by <CartonLink code={carton.superseded_by.code} />
        </span>
      )}
      {orderToShelf != null && orderToShelf >= 0 && (
        <span className="text-muted-foreground">{plural(orderToShelf, "day")} from order to shelf</span>
      )}
    </div>
  );
}

// ---- legs ------------------------------------------------------------------------------

function LegsStrip({ legs }: { legs: Legs | null | undefined }) {
  const value = (key: LegKey): number | null | undefined => (legs as Partial<Record<LegKey, number | null>> | null | undefined)?.[key];
  const shown = LEG_LABELS.filter((l) => value(l.key) != null);
  if (shown.length === 0) return null;
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] gap-2" aria-label="Time per leg">
      {shown.map((l) => (
        <div key={l.key} className="rounded-lg border border-border bg-card px-2.5 py-2">
          <div className="text-[11px] text-muted-foreground">{l.label}</div>
          <div className="text-base font-bold tabular-nums">{legValue(value(l.key) as number, !!l.minutes)}</div>
        </div>
      ))}
    </div>
  );
}

// ---- timeline ----------------------------------------------------------------------------

function TimelineCard({ timeline }: { timeline: TimelineEntry[] }) {
  return (
    <Card className="min-w-0">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">Timeline</CardTitle>
        <CardDescription className="text-xs">
          Every step this carton&apos;s units took, from the factory order to where it is now, with who did it.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {timeline.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing recorded yet.</p>
        ) : (
          <ol className="relative" aria-label="Timeline">
            <span className="absolute bottom-3 left-[11px] top-3 w-px bg-border" aria-hidden />
            {timeline.map((t, i) => {
              const Icon = KIND_ICON[t.kind] ?? CircleDot;
              const latest = i === timeline.length - 1;
              return (
                <li key={`${t.at ?? ""}-${t.kind}-${i}`} className="relative pb-3.5 pl-9 text-sm last:pb-0" data-kind={t.kind}>
                  <span
                    className={cn(
                      "absolute left-0 top-0 flex h-6 w-6 items-center justify-center rounded-full border bg-card",
                      latest ? "border-primary text-primary" : "border-border text-muted-foreground",
                    )}
                    aria-hidden
                  >
                    <Icon className="h-3.5 w-3.5" />
                  </span>
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="font-semibold">{t.title}</span>
                    {t.at && <span className="text-[11px] tabular-nums text-muted-foreground">{whenText(t.at, t.kind)}</span>}
                  </div>
                  {(t.detail || t.actor_name) && (
                    <p className="text-xs text-muted-foreground">{[t.actor_name, t.detail].filter(Boolean).join(" · ")}</p>
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}

// ---- batch -------------------------------------------------------------------------------

function BatchCard({ batch }: { batch: Batch }) {
  const fo = batch?.factory_order ?? null;
  const item = batch?.item ?? null;
  const shipment = batch?.shipment ?? null;
  const summary = batch?.summary ?? null;
  const siblings = batch?.siblings ?? [];
  const total = batch?.siblings_total ?? siblings.length;
  const more = Math.max(0, total - siblings.length);

  if (!fo) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Batch</CardTitle>
          <CardDescription className="text-xs">
            This carton is not tied to one factory order (its shipment carried this SKU from more than one order, or it was not
            checked in from a shipment), so the next-carton suggestion orders it by its check-in date.
          </CardDescription>
        </CardHeader>
        {shipment && (
          <CardContent className="text-sm">
            Shipment{" "}
            <Link to={shipmentPath(shipment.id)} className="font-medium text-primary hover:underline">
              {shipment.shipment_number ?? "open"}
            </Link>
            {shipment.actual_arrival_date && <span className="text-muted-foreground"> · landed {shortDate(shipment.actual_arrival_date)}</span>}
          </CardContent>
        )}
      </Card>
    );
  }

  const ordered = item?.quantity_ordered ?? null;
  const broken = summary?.broken_units ?? 0;
  const brokenPct = ordered && broken > 0 ? (broken / ordered) * 100 : null;

  return (
    <Card className="min-w-0">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">
          Batch{" "}
          <Link to={factoryOrderPath(fo.id)} className="text-primary hover:underline">
            {fo.order_number ?? "factory order"}
          </Link>
          {fo.supplier_name && <> · {fo.supplier_name}</>}
          {ordered != null && <> · {plural(ordered, "unit")}</>}
        </CardTitle>
        <CardDescription className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
          <span>ordered {shortDate(fo.order_date)}</span>
          {fo.expected_completion && <span>· expected {shortDate(fo.expected_completion)}</span>}
          {fo.status && (
            <Badge variant="outline" className={cn("rounded-full px-2 py-0 text-[10px]", FACTORY_ORDER_STATUS_COLORS[fo.status])}>
              {factoryStatus(fo.status)}
            </Badge>
          )}
          {shipment && (
            <span>
              · shipped on{" "}
              <Link to={shipmentPath(shipment.id)} className="text-foreground/90 hover:text-primary hover:underline">
                {shipment.shipment_number ?? "a shipment"}
              </Link>
              {shipment.status && (
                <Badge variant="outline" className={cn("ml-1.5 rounded-full px-2 py-0 text-[10px]", FREIGHT_STATUS_COLORS[shipment.status])}>
                  {freightStatus(shipment.status)}
                </Badge>
              )}
            </span>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {summary && (
          <div className="flex flex-wrap gap-1.5" aria-label="Where the batch is">
            <span className={cn(CHIP, TONE.grey)}>
              {summary.cartons_received.toLocaleString()} received
              {summary.cartons_short > 0 && ` · ${summary.cartons_short.toLocaleString()} short`}
            </span>
            <span className={cn(CHIP, TONE.green)}>{summary.finished.toLocaleString()} finished</span>
            <span className={cn(CHIP, TONE.blue)}>{summary.raw_on_shelf.toLocaleString()} raw on shelf</span>
            <span className={cn(CHIP, TONE.amber)}>{summary.at_the_line.toLocaleString()} at the line</span>
            {broken > 0 && (
              <span className={cn(CHIP, TONE.red)}>
                {plural(broken, "broken unit")}
                {brokenPct != null && ` (${brokenPct < 10 ? brokenPct.toFixed(1) : Math.round(brokenPct)} %)`}
              </span>
            )}
          </div>
        )}

        {siblings.length > 0 ? (
          <div className="-mx-1 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                  <th className="px-1.5 py-1.5 font-medium">Carton</th>
                  <th className="px-1.5 py-1.5 font-medium">State</th>
                  <th className="px-1.5 py-1.5 font-medium">Location</th>
                  <th className="px-1.5 py-1.5 text-right font-medium">Units</th>
                  <th className="px-1.5 py-1.5 font-medium">Since</th>
                </tr>
              </thead>
              <tbody>
                {siblings.map((s) => (
                  <tr key={s.id} className="border-b border-border/40 last:border-0">
                    <td className="whitespace-nowrap px-1.5 py-1.5">
                      <CartonLink code={s.code} className="text-xs" />
                    </td>
                    <td className="px-1.5 py-1.5">
                      <span className={cn(CHIP, "px-2 text-[10px]", CONTAINER_STATE_COLORS[s.state] ?? TONE.grey)}>{s.state}</span>
                    </td>
                    <td className="whitespace-nowrap px-1.5 py-1.5">
                      {s.location_code ? <LocationCode code={s.location_code} size="small" className="text-xs" /> : <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="px-1.5 py-1.5 text-right tabular-nums">{s.qty.toLocaleString()}</td>
                    <td className="whitespace-nowrap px-1.5 py-1.5 text-xs tabular-nums text-muted-foreground">{shortDate(s.since)}</td>
                  </tr>
                ))}
                {more > 0 && (
                  <tr>
                    <td colSpan={5} className="px-1.5 pt-2 text-xs text-muted-foreground">
                      … {plural(more, "more carton")} in this batch ·{" "}
                      <Link to={factoryOrderPath(fo.id)} className="text-primary hover:underline">
                        open the batch
                      </Link>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">No other cartons of this batch have been checked in.</p>
        )}
      </CardContent>
    </Card>
  );
}

// ---- counts and checks --------------------------------------------------------------

function ChecksCard({ timeline }: { timeline: TimelineEntry[] }) {
  const checks = timeline.filter((t) => CHECK_KINDS.has(t.kind));
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">Counts and checks</CardTitle>
        <CardDescription className="text-xs">Everything that verified this carton</CardDescription>
      </CardHeader>
      <CardContent>
        {checks.length === 0 ? (
          <p className="text-sm text-muted-foreground">No check-in, count or label print recorded yet.</p>
        ) : (
          <ul className="space-y-1 text-sm" aria-label="Counts and checks">
            {checks.map((t, i) => (
              <CheckRow key={`${t.at ?? ""}-${i}`} entry={t} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function CheckRow({ entry }: { entry: TimelineEntry }) {
  const Icon = KIND_ICON[entry.kind] ?? CircleDot;
  return (
    <li className="flex items-start gap-2">
      <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0">
        <span className="tabular-nums text-muted-foreground">{shortDate(entry.at)}</span> · {entry.title}
        {entry.detail && <span className="text-muted-foreground"> · {entry.detail}</span>}
      </span>
    </li>
  );
}
