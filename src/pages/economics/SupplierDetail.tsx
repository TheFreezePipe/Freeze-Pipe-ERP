import { useMemo, useState, useEffect } from "react";
import { Link, useParams } from "react-router-dom";
import { format, parseISO, differenceInDays } from "date-fns";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { StatCard } from "@/components/shared/StatCard";
import {
  ArrowLeft,
  Building2,
  ShieldCheck,
  PackageCheck,
  Factory,
  Timer,
  AlarmClock,
  AlertTriangle,
  TrendingUp,
  DollarSign,
  Save,
  PieChart as PieIcon,
  ListMinus,
  Ship,
} from "lucide-react";
import {
  useSupplier,
  useSupplierStats,
  useUpdateSupplier,
  useUpdateSupplierActive,
  useFactoryOrders,
  useSuppliers,
  useSupplierSpendShares,
  useSupplierShipments,
  useSupplierAuditTrail,
  useProducts,
} from "@/lib/hooks";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  Legend,
} from "recharts";

/**
 * Supplier detail — COO-level view of a single vendor. KPIs at the top,
 * active orders + open quality issues in the middle, and an editable admin
 * panel at the bottom.
 *
 * Data strategy: `useSupplierStats` aggregates from factory_orders + items
 * + breakage/variance tables client-side. Fine for MVP scale. If any
 * supplier ever exceeds ~1k orders, move the aggregation to a SQL view.
 */
export default function SupplierDetail() {
  const { id } = useParams<{ id: string }>();
  const supplierQ = useSupplier(id);
  const statsQ = useSupplierStats(id);
  const allSuppliers = useSuppliers();
  const allOrders = useFactoryOrders();
  const shipmentsQ = useSupplierShipments(id);
  const auditQ = useSupplierAuditTrail(id);
  const spendQ = useSupplierSpendShares();
  const updateSupplier = useUpdateSupplier();
  const updateActive = useUpdateSupplierActive();
  const productsQ = useProducts();

  // Editable admin form state — seeded from the fetched supplier once it loads.
  const [form, setForm] = useState({
    name: "",
    country: "",
    contact_name: "",
    contact_email: "",
    contact_phone: "",
    default_lead_time_days: "",
    payment_terms: "",
    invoice_currency: "",
    notes: "",
    is_producer: false,
    is_filler: false,
    is_export_broker: false,
  });
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveOk, setSaveOk] = useState(false);

  useEffect(() => {
    const s = supplierQ.data;
    if (!s) return;
    setForm({
      name: s.name,
      country: s.country,
      contact_name: s.contact_name ?? "",
      contact_email: s.contact_email ?? "",
      contact_phone: s.contact_phone ?? "",
      default_lead_time_days: s.default_lead_time_days?.toString() ?? "",
      payment_terms: s.payment_terms ?? "",
      invoice_currency: s.invoice_currency,
      notes: s.notes ?? "",
      is_producer: s.is_producer,
      is_filler: s.is_filler,
      is_export_broker: s.is_export_broker,
    });
  }, [supplierQ.data]);

  const supplier = supplierQ.data;
  const stats = statsQ.data;

  // Active orders specifically for this supplier, from the shared orders query.
  const supplierOrders = useMemo(() => {
    if (!id) return [];
    return (allOrders.data ?? []).filter((o) => o.supplier_id === id);
  }, [allOrders.data, id]);
  const activeSupplierOrders = useMemo(
    () =>
      supplierOrders
        .filter((o) => o.status !== "canceled" && o.status !== "shipped")
        .sort((a, b) =>
          (a.expected_completion ?? "").localeCompare(b.expected_completion ?? ""),
        ),
    [supplierOrders],
  );

  // SKU lookup for portfolio + audit trail display.
  const skuLookup = useMemo(() => {
    const m = new Map<string, { sku: string; product_name: string }>();
    for (const p of productsQ.data ?? []) {
      m.set(p.id, { sku: p.sku, product_name: p.product_name });
    }
    return m;
  }, [productsQ.data]);

  // Spend concentration — this supplier's share of total factory-order spend
  // across the last 365 days. Returns { share, thisSpend, totalSpend }.
  const spendShare = useMemo(() => {
    if (!id || !spendQ.data) return null;
    const total = spendQ.data.totalSpend;
    const thisSpend = spendQ.data.bySupplier.get(id) ?? 0;
    return {
      share: total > 0 ? thisSpend / total : 0,
      thisSpend,
      totalSpend: total,
    };
  }, [id, spendQ.data]);

  // Resolve consolidates_for display — show supplier names, not UUIDs.
  const consolidatesForNames = useMemo(() => {
    if (!supplier) return [] as string[];
    const lookup = new Map((allSuppliers.data ?? []).map((s) => [s.id, s.name] as const));
    return supplier.consolidates_for.map((supId) => lookup.get(supId) ?? supId.slice(0, 8));
  }, [supplier, allSuppliers.data]);
  const consolidatedByNames = useMemo(() => {
    if (!supplier) return [] as string[];
    return (allSuppliers.data ?? [])
      .filter((s) => s.consolidates_for.includes(supplier.id))
      .map((s) => s.name);
  }, [supplier, allSuppliers.data]);

  async function handleSave() {
    if (!supplier) return;
    setSaveError(null);
    setSaveOk(false);
    try {
      await updateSupplier.mutateAsync({
        id: supplier.id,
        updates: {
          name: form.name.trim(),
          country: form.country.trim() || "CN",
          contact_name: form.contact_name.trim() || null,
          contact_email: form.contact_email.trim() || null,
          contact_phone: form.contact_phone.trim() || null,
          default_lead_time_days: form.default_lead_time_days
            ? parseInt(form.default_lead_time_days, 10)
            : null,
          payment_terms: form.payment_terms.trim() || null,
          invoice_currency: form.invoice_currency.trim() || "USD",
          notes: form.notes.trim() || null,
          is_producer: form.is_producer,
          is_filler: form.is_filler,
          is_export_broker: form.is_export_broker,
        },
      });
      setSaveOk(true);
      setTimeout(() => setSaveOk(false), 2500);
    } catch (err) {
      if (err instanceof Error) setSaveError(err.message);
      else if (err && typeof err === "object") {
        const e = err as { message?: unknown };
        if (typeof e.message === "string") setSaveError(e.message);
        else setSaveError("Save failed");
      } else setSaveError("Save failed");
    }
  }

  if (supplierQ.isLoading) {
    return <div className="p-8 text-sm text-muted-foreground">Loading supplier…</div>;
  }
  if (!supplier) {
    return (
      <div className="p-8 text-sm text-red-400">
        Supplier not found. <Link to="/economics/suppliers" className="underline">Back to list</Link>.
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-6xl">
      {/* Header */}
      <div>
        <Button variant="ghost" size="sm" asChild>
          <Link to="/economics/suppliers">
            <ArrowLeft className="mr-1.5 h-4 w-4" /> All suppliers
          </Link>
        </Button>
        <div className="mt-2 flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-3">
              <Building2 className="h-5 w-5 text-muted-foreground" />
              <h1 className="text-2xl font-semibold">{supplier.name}</h1>
              <Badge variant="outline" className="font-mono text-[10px]">{supplier.code}</Badge>
              <Badge
                variant="outline"
                className={`text-[10px] ${supplier.is_active ? "border-green-500/30 text-green-400" : "border-muted text-muted-foreground"}`}
              >
                {supplier.is_active ? "active" : "inactive"}
              </Badge>
            </div>
            <div className="flex flex-wrap gap-1.5 mt-2">
              {supplier.is_producer && (
                <Badge variant="outline" className="text-[10px] border-blue-500/30 text-blue-400">
                  <Factory className="mr-1 h-2.5 w-2.5" /> producer
                </Badge>
              )}
              {supplier.is_filler && (
                <Badge variant="outline" className="text-[10px] border-amber-500/30 text-amber-400">
                  <PackageCheck className="mr-1 h-2.5 w-2.5" /> filler
                </Badge>
              )}
              {supplier.is_export_broker && (
                <Badge variant="outline" className="text-[10px] border-green-500/30 text-green-400">
                  <ShieldCheck className="mr-1 h-2.5 w-2.5" /> broker
                </Badge>
              )}
            </div>
            {(consolidatesForNames.length > 0 || consolidatedByNames.length > 0) && (
              <p className="text-xs text-muted-foreground mt-2">
                {consolidatesForNames.length > 0 && (
                  <>Consolidates for: <span className="text-foreground">{consolidatesForNames.join(", ")}</span></>
                )}
                {consolidatesForNames.length > 0 && consolidatedByNames.length > 0 && " · "}
                {consolidatedByNames.length > 0 && (
                  <>Consolidated by: <span className="text-foreground">{consolidatedByNames.join(", ")}</span></>
                )}
              </p>
            )}
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={updateActive.isPending}
            onClick={() => updateActive.mutate({ id: supplier.id, isActive: !supplier.is_active })}
          >
            {supplier.is_active ? "Deactivate" : "Reactivate"}
          </Button>
        </div>
      </div>

      {/* KPI cards. Compute presentation values once so the JSX stays legible
          and — importantly — the runtime never dereferences `stats` when it's
          still undefined during the initial load. */}
      {(() => {
        const onTime = stats?.onTimeRate ?? null;
        const breakage = stats?.breakageRate ?? null;
        const lead = stats?.avgLeadTimeDays ?? null;
        const onTimeColor =
          onTime === null
            ? "text-muted-foreground"
            : onTime >= 0.9
              ? "text-green-400"
              : onTime >= 0.75
                ? "text-yellow-400"
                : "text-red-400";
        const breakageColor =
          breakage === null
            ? "text-muted-foreground"
            : breakage <= 0.01
              ? "text-green-400"
              : breakage <= 0.03
                ? "text-yellow-400"
                : "text-red-400";
        return (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            <StatCard
              title="On-Time Rate (90d)"
              value={onTime !== null ? `${Math.round(onTime * 100)}%` : "—"}
              subtitle={onTime === null ? "Not enough receives to score" : "Items received by effective ETA"}
              icon={TrendingUp}
              iconColor={onTimeColor}
            />
            <StatCard
              title="Breakage Rate (90d)"
              value={breakage !== null ? `${(breakage * 100).toFixed(2)}%` : "—"}
              subtitle={breakage === null ? "Not enough receives to score" : "Broken units / confirmed units"}
              icon={AlertTriangle}
              iconColor={breakageColor}
            />
            <StatCard
              title="Open Order Value"
              value={`$${Math.round(stats?.openOrderValue ?? 0).toLocaleString()}`}
              subtitle={`${stats?.activeOrders ?? 0} active order${stats?.activeOrders === 1 ? "" : "s"}`}
              icon={DollarSign}
              iconColor="text-blue-400"
            />
            <StatCard
              title="Avg Lead Time (90d)"
              value={lead !== null ? `${Math.round(lead)}d` : "—"}
              subtitle={
                supplier.default_lead_time_days
                  ? `vs ${supplier.default_lead_time_days}d default`
                  : "order → fully received"
              }
              icon={Timer}
              iconColor="text-indigo-400"
            />
            <StatCard
              title="Spend Share (365d)"
              value={spendShare ? `${(spendShare.share * 100).toFixed(1)}%` : "—"}
              subtitle={
                spendShare && spendShare.totalSpend > 0
                  ? `$${Math.round(spendShare.thisSpend).toLocaleString()} of $${Math.round(spendShare.totalSpend).toLocaleString()}`
                  : "Concentration across all suppliers"
              }
              icon={PieIcon}
              iconColor={
                !spendShare
                  ? "text-muted-foreground"
                  : spendShare.share >= 0.5
                    ? "text-red-400"
                    : spendShare.share >= 0.25
                      ? "text-yellow-400"
                      : "text-blue-400"
              }
            />
          </div>
        );
      })()}

      {/* Overdue / quality callouts */}
      {(stats?.overdueItems ?? 0) > 0 ||
      (stats?.openBreakageReports ?? 0) > 0 ||
      (stats?.openVariances ?? 0) > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <AlarmClock className="h-4 w-4 text-red-400" />
              Needs attention
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-4 text-sm">
            {(stats?.overdueItems ?? 0) > 0 && (
              <div className="flex items-center gap-2">
                <span className="text-2xl font-semibold text-red-400 tabular-nums">
                  {stats!.overdueItems}
                </span>
                <span className="text-xs text-muted-foreground">
                  overdue item{stats!.overdueItems === 1 ? "" : "s"}
                </span>
              </div>
            )}
            {(stats?.openBreakageReports ?? 0) > 0 && (
              <div className="flex items-center gap-2">
                <span className="text-2xl font-semibold text-amber-400 tabular-nums">
                  {stats!.openBreakageReports}
                </span>
                <span className="text-xs text-muted-foreground">
                  open breakage report{stats!.openBreakageReports === 1 ? "" : "s"}
                </span>
              </div>
            )}
            {(stats?.openVariances ?? 0) > 0 && (
              <div className="flex items-center gap-2">
                <span className="text-2xl font-semibold text-amber-400 tabular-nums">
                  {stats!.openVariances}
                </span>
                <span className="text-xs text-muted-foreground">
                  open variance{stats!.openVariances === 1 ? "" : "s"}
                </span>
              </div>
            )}
          </CardContent>
        </Card>
      ) : null}

      {/* Active orders */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Active Orders</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {activeSupplierOrders.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              No active orders.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                  <th className="px-4 py-3">Order #</th>
                  <th className="px-3 py-3">Order Date</th>
                  <th className="px-3 py-3">Expected</th>
                  <th className="px-3 py-3 text-right">Days Left</th>
                  <th className="px-3 py-3">Status</th>
                  <th className="px-3 py-3 text-right">Units</th>
                  <th className="px-3 py-3 text-right">Value</th>
                </tr>
              </thead>
              <tbody>
                {activeSupplierOrders.map((o) => {
                  const ordered = (o.items ?? []).reduce((s, i) => s + i.quantity_ordered, 0);
                  const value = (o.items ?? []).reduce(
                    (s, i) => s + (i.unit_cost ?? 0) * i.quantity_ordered,
                    0,
                  );
                  const daysLeft = o.expected_completion
                    ? differenceInDays(parseISO(o.expected_completion), new Date())
                    : null;
                  return (
                    <tr key={o.id} className="border-b border-border/50 hover:bg-muted/30">
                      <td className="px-4 py-3 text-xs font-mono">
                        {o.order_number ?? <span className="text-muted-foreground italic">—</span>}
                      </td>
                      <td className="px-3 py-3 text-xs tabular-nums text-muted-foreground">
                        {o.order_date ? format(parseISO(o.order_date), "MMM d, yyyy") : "—"}
                      </td>
                      <td className="px-3 py-3 text-xs tabular-nums">
                        {o.expected_completion
                          ? format(parseISO(o.expected_completion), "MMM d, yyyy")
                          : "—"}
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums text-xs">
                        {daysLeft !== null ? (
                          <span
                            className={
                              daysLeft < 0
                                ? "text-red-400 font-medium"
                                : daysLeft < 5
                                  ? "text-yellow-400"
                                  : "text-muted-foreground"
                            }
                          >
                            {daysLeft < 0 ? `${Math.abs(daysLeft)}d late` : `${daysLeft}d`}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-3 py-3">
                        <Badge variant="outline" className="text-[10px]">
                          {o.status.replace("_", " ")}
                        </Badge>
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums">
                        {ordered.toLocaleString()}
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums">
                        ${Math.round(value).toLocaleString()}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {/* Monthly trend chart — 6-month throughput + on-time rate */}
      {stats && stats.monthly.some((m) => m.received > 0) && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <TrendingUp className="h-4 w-4" />
              6-Month Trend
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-56 w-full">
              <ResponsiveContainer>
                <LineChart
                  data={stats.monthly.map((m) => ({
                    month: m.month.slice(5), // MM
                    received: m.received,
                    onTimePct: m.onTimeRate !== null ? Math.round(m.onTimeRate * 100) : null,
                  }))}
                  margin={{ top: 10, right: 16, left: 0, bottom: 0 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#333" opacity={0.3} />
                  <XAxis dataKey="month" tick={{ fontSize: 11 }} stroke="#666" />
                  <YAxis
                    yAxisId="left"
                    tick={{ fontSize: 11 }}
                    stroke="#3b82f6"
                    label={{ value: "Items received", angle: -90, position: "insideLeft", style: { fontSize: 10 } }}
                  />
                  <YAxis
                    yAxisId="right"
                    orientation="right"
                    domain={[0, 100]}
                    tick={{ fontSize: 11 }}
                    stroke="#22c55e"
                    label={{ value: "On-time %", angle: 90, position: "insideRight", style: { fontSize: 10 } }}
                  />
                  <Tooltip
                    contentStyle={{ background: "#111", border: "1px solid #333", fontSize: 12 }}
                  />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Line
                    yAxisId="left"
                    type="monotone"
                    dataKey="received"
                    name="Items received"
                    stroke="#3b82f6"
                    strokeWidth={2}
                    dot
                  />
                  <Line
                    yAxisId="right"
                    type="monotone"
                    dataKey="onTimePct"
                    name="On-time %"
                    stroke="#22c55e"
                    strokeWidth={2}
                    dot
                    connectNulls
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      )}

      {/* SKU Portfolio — last 365 days */}
      {stats && stats.skuPortfolio.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <ListMinus className="h-4 w-4" />
              SKU Portfolio (365d)
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                  <th className="px-4 py-3">SKU</th>
                  <th className="px-3 py-3 text-right">Ordered</th>
                  <th className="px-3 py-3 text-right">Received</th>
                  <th className="px-3 py-3 text-right">Value</th>
                  <th className="px-3 py-3">Last ordered</th>
                </tr>
              </thead>
              <tbody>
                {stats.skuPortfolio.map((row) => {
                  const meta = skuLookup.get(row.sku_id);
                  return (
                    <tr key={row.sku_id} className="border-b border-border/50 hover:bg-muted/30">
                      <td className="px-4 py-3">
                        {meta ? (
                          <>
                            <span className="font-mono text-xs">{meta.sku}</span>
                            <span className="ml-2 text-muted-foreground text-xs">{meta.product_name}</span>
                          </>
                        ) : (
                          <span className="font-mono text-xs text-muted-foreground">
                            {row.sku_id.slice(0, 8)}…
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums">
                        {row.totalOrdered.toLocaleString()}
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums">
                        {row.totalConfirmed > 0 ? (
                          row.totalConfirmed.toLocaleString()
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums">
                        ${Math.round(row.totalValue).toLocaleString()}
                      </td>
                      <td className="px-3 py-3 text-xs tabular-nums text-muted-foreground">
                        {row.lastOrdered
                          ? format(parseISO(row.lastOrdered), "MMM d, yyyy")
                          : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      {/* Shipments declared — brokers only. If the supplier isn't a broker,
          this section doesn't render. */}
      {supplier.is_export_broker && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Ship className="h-4 w-4" />
              Shipments Declared
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {shipmentsQ.isLoading ? (
              <div className="py-8 text-center text-sm text-muted-foreground">Loading…</div>
            ) : (shipmentsQ.data ?? []).length === 0 ? (
              <div className="py-8 text-center text-sm text-muted-foreground">
                No shipments declared by this supplier.
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                    <th className="px-4 py-3">Shipment #</th>
                    <th className="px-3 py-3">Carrier</th>
                    <th className="px-3 py-3">Status</th>
                    <th className="px-3 py-3">ETA</th>
                    <th className="px-3 py-3 text-right">ETA Drift</th>
                    <th className="px-3 py-3 text-right">Cartons</th>
                  </tr>
                </thead>
                <tbody>
                  {(shipmentsQ.data ?? []).map((s) => {
                    // Drift: current ETA vs original ETA (in days). Positive =
                    // pushed later; negative = pulled earlier.
                    let drift: number | null = null;
                    if (s.eta && s.eta_original) {
                      drift =
                        (new Date(s.eta).getTime() - new Date(s.eta_original).getTime()) / 86400_000;
                    }
                    return (
                      <tr key={s.id} className="border-b border-border/50 hover:bg-muted/30">
                        <td className="px-4 py-3 font-mono text-xs">
                          {s.shipment_number ?? <span className="text-muted-foreground italic">—</span>}
                        </td>
                        <td className="px-3 py-3 text-xs">
                          {s.carrier_name ?? <span className="text-muted-foreground">—</span>}
                          {s.tracking_number && (
                            <div className="text-[10px] text-muted-foreground font-mono">
                              {s.tracking_number}
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-3">
                          <Badge variant="outline" className="text-[10px]">
                            {s.status.replace(/_/g, " ")}
                          </Badge>
                        </td>
                        <td className="px-3 py-3 text-xs tabular-nums">
                          {s.eta ? format(parseISO(s.eta), "MMM d, yyyy") : "—"}
                        </td>
                        <td className="px-3 py-3 text-right tabular-nums text-xs">
                          {drift === null ? (
                            <span className="text-muted-foreground">—</span>
                          ) : drift === 0 ? (
                            <span className="text-muted-foreground">on plan</span>
                          ) : (
                            <span className={drift > 0 ? "text-red-400" : "text-green-400"}>
                              {drift > 0 ? `+${drift}d` : `${drift}d`}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-3 text-right tabular-nums">
                          {s.total_cartons ?? <span className="text-muted-foreground">—</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>
      )}

      {/* Audit trail */}
      {(auditQ.data ?? []).length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Recent Activity</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                  <th className="px-4 py-3 w-48">When</th>
                  <th className="px-3 py-3">Action</th>
                  <th className="px-3 py-3">Target</th>
                </tr>
              </thead>
              <tbody>
                {(auditQ.data ?? []).map((e) => (
                  <tr key={e.id} className="border-b border-border/50">
                    <td className="px-4 py-3 text-xs tabular-nums text-muted-foreground">
                      {format(parseISO(e.created_at), "MMM d, h:mm a")}
                    </td>
                    <td className="px-3 py-3 text-xs">
                      <span className="font-mono">{e.action}</span>
                    </td>
                    <td className="px-3 py-3 text-xs text-muted-foreground font-mono">
                      {e.target_table}/{e.target_id.slice(0, 8)}…
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      {/* Admin / contact edit */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Admin</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label className="text-xs">Name</Label>
              <Input
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Country</Label>
              <Input
                value={form.country}
                onChange={(e) => setForm((f) => ({ ...f, country: e.target.value.toUpperCase() }))}
                maxLength={2}
                className="font-mono"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Contact name</Label>
              <Input
                value={form.contact_name}
                onChange={(e) => setForm((f) => ({ ...f, contact_name: e.target.value }))}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Contact email</Label>
              <Input
                type="email"
                value={form.contact_email}
                onChange={(e) => setForm((f) => ({ ...f, contact_email: e.target.value }))}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Contact phone</Label>
              <Input
                value={form.contact_phone}
                onChange={(e) => setForm((f) => ({ ...f, contact_phone: e.target.value }))}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Default lead time (days)</Label>
              <Input
                type="number"
                min={0}
                value={form.default_lead_time_days}
                onChange={(e) => setForm((f) => ({ ...f, default_lead_time_days: e.target.value }))}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Payment terms</Label>
              <Input
                value={form.payment_terms}
                onChange={(e) => setForm((f) => ({ ...f, payment_terms: e.target.value }))}
                placeholder="e.g. Net 30"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Invoice currency</Label>
              <Input
                value={form.invoice_currency}
                onChange={(e) =>
                  setForm((f) => ({ ...f, invoice_currency: e.target.value.toUpperCase() }))
                }
                maxLength={3}
                className="font-mono"
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label className="text-xs">Capabilities</Label>
            <div className="flex flex-col gap-2 rounded-md border border-border p-3 text-xs">
              <label className="flex items-center gap-2 cursor-pointer">
                <Checkbox
                  checked={form.is_producer}
                  onCheckedChange={(c) => setForm((f) => ({ ...f, is_producer: c === true }))}
                />
                <span>Producer — makes goods</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <Checkbox
                  checked={form.is_filler}
                  onCheckedChange={(c) => setForm((f) => ({ ...f, is_filler: c === true }))}
                />
                <span>Filler — fillable-product assembly</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <Checkbox
                  checked={form.is_export_broker}
                  onCheckedChange={(c) => setForm((f) => ({ ...f, is_export_broker: c === true }))}
                />
                <span>Export broker — can create shipments in the portal</span>
              </label>
            </div>
          </div>

          <div className="space-y-1">
            <Label className="text-xs">Notes</Label>
            <Textarea
              rows={3}
              value={form.notes}
              onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
              placeholder="Anything internal staff should know"
            />
          </div>

          <div className="flex items-center justify-end gap-3">
            {saveOk && <span className="text-xs text-green-400">Saved.</span>}
            {saveError && <span className="text-xs text-red-400">{saveError}</span>}
            <Button onClick={handleSave} disabled={updateSupplier.isPending}>
              <Save className="mr-1.5 h-4 w-4" />
              {updateSupplier.isPending ? "Saving…" : "Save changes"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
