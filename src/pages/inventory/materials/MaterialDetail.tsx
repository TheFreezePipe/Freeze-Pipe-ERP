import { useMemo } from "react";
import { useParams, Link } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  ArrowLeft,
  Beaker,
  AlertTriangle,
  CheckCircle2,
  PackageSearch,
  ArrowUpRight,
  ArrowDownRight,
} from "lucide-react";
import { GlycerinBarrels } from "@/components/materials/GlycerinBarrels";
import {
  useMaterial,
  useAllRecipes,
  useInventory,
  useProducts,
  useProfiles,
  useMaterialTransactions,
} from "@/lib/hooks";
import {
  computeMaterialRunway,
  computeReorderSuggestion,
} from "@/lib/materials/runway";
import { useShouldShowMaterialsFeature } from "@/lib/feature-flags";
import { cn } from "@/lib/utils";
import { format, parseISO } from "date-fns";

export default function MaterialDetail() {
  const { materialId } = useParams<{ materialId: string }>();
  const showFlag = useShouldShowMaterialsFeature();

  const { data: material, isLoading } = useMaterial(materialId);
  const { data: allRecipes = [] } = useAllRecipes();
  const { data: inventory = [] } = useInventory();
  const { data: products = [] } = useProducts();
  const { data: profiles = [] } = useProfiles();
  const { data: transactions = [] } = useMaterialTransactions(materialId);

  const runway = useMemo(() => {
    if (!material) return null;
    return computeMaterialRunway(material, {
      materials: [material],
      allRecipes,
      fillableInventory: inventory
        .filter((inv) => inv.product?.category === "fillable")
        .map((inv) => ({
          product: {
            id: inv.product!.id,
            category: inv.product!.category,
            monthly_demand: inv.product!.monthly_demand,
          },
          inventory: {
            warehouse_raw: inv.warehouse_raw,
            warehouse_prefilled_raw: inv.warehouse_prefilled_raw,
            warehouse_in_production: inv.warehouse_in_production,
          },
        })),
    });
  }, [material, allRecipes, inventory]);

  const reorder = useMemo(() => {
    if (!material || !runway) return null;
    return computeReorderSuggestion(material, material.inventory?.on_hand_qty ?? 0, runway);
  }, [material, runway]);

  // SKUs that consume this material, with each one's daily contribution to
  // the burn rate. Only fillable SKUs drive the runway model, so non-fillable
  // recipe rows show a zero contribution (flagged).
  const consumedBy = useMemo(() => {
    if (!material) return [];
    return allRecipes
      .filter((r) => r.material_id === material.id)
      .map((r) => {
        const p = products.find((pp) => pp.id === r.sku_id);
        const isFillable = p?.category === "fillable";
        const monthly = p?.monthly_demand ?? 0;
        const dailyContribution = isFillable ? (monthly / 30) * r.quantity_per_unit : 0;
        return {
          skuId: r.sku_id,
          sku: p?.sku ?? "—",
          name: p?.product_name ?? "",
          qtyPerUnit: r.quantity_per_unit,
          monthly,
          dailyContribution,
          isFillable,
        };
      })
      .sort((a, b) => b.dailyContribution - a.dailyContribution);
  }, [material, allRecipes, products]);

  function profileName(id: string | null): string {
    if (!id) return "System";
    return profiles.find((p) => p.id === id)?.full_name ?? "Unknown";
  }

  if (!showFlag) {
    return <div className="p-8 text-sm text-muted-foreground">This feature isn't available yet.</div>;
  }
  if (isLoading) {
    return <div className="p-8 text-sm text-muted-foreground">Loading material…</div>;
  }
  if (!material) {
    return (
      <div className="p-8 space-y-3">
        <p className="text-sm text-muted-foreground">Material not found.</p>
        <Link to="/inventory/materials" className="text-sm text-primary hover:underline">
          ← Back to Materials
        </Link>
      </div>
    );
  }

  const onHand = material.inventory?.on_hand_qty ?? 0;
  const unit = material.unit_of_measure;
  const dollarOnHand = onHand * (material.unit_cost ?? 0);
  const isGlycerin = material.code === "GLYCERIN";

  const fmt = (n: number, max = 2) =>
    n.toLocaleString(undefined, { maximumFractionDigits: max });

  const runwayLabel = (() => {
    if (!runway) return "—";
    if (runway.consumptionSource === "no_recipes") return "no recipe";
    if (runway.consumptionSource === "no_demand") return "no demand";
    return runway.currentRunwayDays != null ? `${runway.currentRunwayDays}d` : "—";
  })();

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="space-y-2">
        <Link
          to="/inventory/materials"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Materials
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-bold font-mono">{material.code}</h1>
          <span className="text-lg text-muted-foreground">{material.name}</span>
          <Badge variant="outline" className="text-[10px]">{material.category}</Badge>
          {!material.is_active && (
            <Badge variant="outline" className="text-[10px] border-muted text-muted-foreground">
              archived
            </Badge>
          )}
        </div>
      </div>

      {/* Stat cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatBox label="On Hand" value={`${fmt(onHand)} ${unit}`} sub={`$${fmt(dollarOnHand, 0)} at cost`} />
        <StatBox
          label="Current Runway"
          value={runwayLabel}
          sub={runway && runway.dailyConsumption > 0 ? `${fmt(runway.dailyConsumption, 3)} ${unit}/day` : "no burn estimate"}
          tone={
            runway?.currentRunwayDays != null
              ? runway.currentRunwayDays < 14
                ? "red"
                : runway.currentRunwayDays < 30
                  ? "amber"
                  : "green"
              : undefined
          }
        />
        <StatBox
          label="Pipeline Runway"
          value={runway?.pipelineRunwayDays != null ? `${runway.pipelineRunwayDays}d` : "—"}
          sub={runway && runway.pipelineConsumptionQty > 0 ? `${fmt(runway.pipelineConsumptionQty, 0)} ${unit} to finish pipeline` : "incl. in-process stock"}
        />
        <StatBox
          label="Reorder Point"
          value={material.reorder_point_qty != null ? `${fmt(material.reorder_point_qty)} ${unit}` : "—"}
          sub={material.lead_time_days != null ? `${material.lead_time_days}d lead time` : "no lead time set"}
        />
      </div>

      {/* Reorder helper */}
      {reorder && <ReorderHelper material={material} reorder={reorder} onHand={onHand} unit={unit} fmt={fmt} />}

      {/* Glycerin barrels */}
      {isGlycerin && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Beaker className="h-4 w-4 text-cyan-400" />
              Glycerin on Hand
            </CardTitle>
          </CardHeader>
          <CardContent>
            <GlycerinBarrels onHandLiters={onHand} dailyConsumptionLiters={runway?.dailyConsumption ?? null} />
          </CardContent>
        </Card>
      )}

      {/* Consumed by */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <PackageSearch className="h-4 w-4 text-muted-foreground" />
            Consumed by SKUs
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Recipes that use this material, ranked by daily burn. Define recipes on each SKU's detail page.
          </p>
        </CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          {consumedBy.length === 0 ? (
            <p className="px-4 py-6 text-sm text-muted-foreground">
              No SKU recipes reference this material yet.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                  <th className="px-4 py-2">SKU</th>
                  <th className="px-3 py-2 text-right">Qty / unit</th>
                  <th className="px-3 py-2 text-right">Monthly demand</th>
                  <th className="px-3 py-2 text-right">Daily burn</th>
                </tr>
              </thead>
              <tbody>
                {consumedBy.map((c) => (
                  <tr key={c.skuId} className="border-b border-border/40">
                    <td className="px-4 py-2">
                      <Link to={`/economics/${c.skuId}`} className="font-medium hover:underline">
                        {c.sku}
                      </Link>
                      <span className="ml-1.5 text-muted-foreground/70 hidden sm:inline">{c.name}</span>
                      {!c.isFillable && (
                        <span className="ml-1.5 text-[10px] text-muted-foreground/60">(non-fillable)</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmt(c.qtyPerUnit, 3)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{fmt(c.monthly, 0)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {c.dailyContribution > 0 ? `${fmt(c.dailyContribution, 2)} ${unit}` : "—"}
                    </td>
                  </tr>
                ))}
                <tr className="border-t border-border font-medium">
                  <td className="px-4 py-2" colSpan={3}>Total daily burn</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {runway ? `${fmt(runway.dailyConsumption, 2)} ${unit}` : "—"}
                  </td>
                </tr>
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {/* Transaction history */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">History</CardTitle>
          <p className="text-xs text-muted-foreground">Cycle counts and receipts (most recent first)</p>
        </CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          {transactions.length === 0 ? (
            <p className="px-4 py-6 text-sm text-muted-foreground">No transactions recorded yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                  <th className="px-4 py-2">When</th>
                  <th className="px-3 py-2">Type</th>
                  <th className="px-3 py-2 text-right">Change</th>
                  <th className="px-3 py-2">By</th>
                  <th className="px-4 py-2">Notes</th>
                </tr>
              </thead>
              <tbody>
                {transactions.map((t) => (
                  <tr key={t.id} className="border-b border-border/40">
                    <td className="px-4 py-2 text-xs text-muted-foreground whitespace-nowrap tabular-nums">
                      {(() => {
                        try {
                          return format(parseISO(t.created_at), "MMM d, yyyy h:mm a");
                        } catch {
                          return t.created_at;
                        }
                      })()}
                    </td>
                    <td className="px-3 py-2 text-xs">{t.transaction_type.replace(/_/g, " ")}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      <span
                        className={cn(
                          "inline-flex items-center gap-0.5 font-medium",
                          t.quantity_change > 0 ? "text-green-400" : t.quantity_change < 0 ? "text-red-400" : "text-muted-foreground",
                        )}
                      >
                        {t.quantity_change > 0 ? (
                          <ArrowUpRight className="h-3 w-3" />
                        ) : t.quantity_change < 0 ? (
                          <ArrowDownRight className="h-3 w-3" />
                        ) : null}
                        {t.quantity_change > 0 ? "+" : ""}
                        {fmt(t.quantity_change)}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">{profileName(t.performed_by)}</td>
                    <td className="px-4 py-2 text-xs text-muted-foreground max-w-[280px] truncate">{t.notes ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function StatBox({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "red" | "amber" | "green";
}) {
  const toneClass =
    tone === "red"
      ? "text-red-400"
      : tone === "amber"
        ? "text-yellow-400"
        : tone === "green"
          ? "text-green-400"
          : "text-foreground";
  return (
    <Card>
      <CardContent className="pt-5">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className={cn("text-2xl font-bold tabular-nums", toneClass)}>{value}</p>
        {sub && <p className="text-[11px] text-muted-foreground mt-0.5">{sub}</p>}
      </CardContent>
    </Card>
  );
}

function ReorderHelper({
  reorder,
  onHand,
  unit,
  fmt,
}: {
  material: { reorder_point_qty: number | null };
  reorder: import("@/lib/materials/runway").ReorderSuggestion;
  onHand: number;
  unit: string;
  fmt: (n: number, max?: number) => string;
}) {
  const reasonText: Record<string, string> = {
    below_reorder_point: "On-hand is below the reorder point.",
    within_lead_time: "You'll run out within the lead time + safety window.",
    ok: "Stock is healthy — no reorder needed right now.",
    no_estimate: "No burn-rate estimate yet (needs a recipe + demand). Only the manual reorder point can flag this material.",
  };

  const tone = reorder.shouldReorder
    ? reorder.reason === "below_reorder_point"
      ? "red"
      : "amber"
    : "ok";

  return (
    <Card
      className={cn(
        tone === "red" && "border-red-500/50 bg-red-500/5",
        tone === "amber" && "border-amber-500/50 bg-amber-500/5",
      )}
    >
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          {reorder.shouldReorder ? (
            <AlertTriangle className={cn("h-4 w-4", tone === "red" ? "text-red-400" : "text-amber-400")} />
          ) : (
            <CheckCircle2 className="h-4 w-4 text-green-400" />
          )}
          {reorder.shouldReorder ? "Reorder recommended" : "Reorder helper"}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">{reasonText[reorder.reason]}</p>

        {reorder.suggestedOrderQty != null && reorder.suggestedOrderQty > 0 && (
          <div className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
            <div>
              <p className="text-xs text-muted-foreground">Suggested order</p>
              <p className="text-lg font-bold tabular-nums">
                ~{fmt(reorder.suggestedOrderQty, 0)} {unit}
              </p>
              <p className="text-[11px] text-muted-foreground">
                brings cover to ~{reorder.leadTimeDays + reorder.targetCoverDays} days
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Place order by</p>
              <p className="text-lg font-bold tabular-nums">
                {reorder.orderByDays == null
                  ? "—"
                  : reorder.orderByDays <= 0
                    ? "Now"
                    : `~${Math.floor(reorder.orderByDays)} days`}
              </p>
              <p className="text-[11px] text-muted-foreground">
                {reorder.orderByDays != null && reorder.orderByDays <= 0
                  ? "past the safe reorder date"
                  : `${reorder.leadTimeDays}d lead time`}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">On hand</p>
              <p className="text-lg font-bold tabular-nums">
                {fmt(onHand)} {unit}
              </p>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
