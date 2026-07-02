import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { getEffectiveDemand } from "@/lib/demand";
import { computeListD2C } from "@/lib/inventory-math";
import { DISPLAY_CATEGORIES, displayCategoryRank } from "@/lib/constants";
import { useNavigate } from "react-router-dom";
import { ExternalLink, Plus, Search, X } from "lucide-react";
import { useMemo, useState } from "react";
import {
  useProducts,
  useAllSkuEconomics,
  useAllPrimarySkuSupplierCosts,
  useCreateProduct,
  useForecastDemandMap,
} from "@/lib/hooks";
import type { ProductSKU } from "@/types/database";
import { useTableSort, applySort, SortableTh } from "@/components/shared/table-sort";

const emptyForm = {
  sku: "",
  product_name: "",
  upc_code: "",
  category: "fillable" as "fillable" | "non_fillable",
  display_category: "" as string,
  retail_price: "",
  standard_quantity_per_carton: "",
  abc_classification: "" as string,
  monthly_demand: "",
};

export default function SKUList() {
  const navigate = useNavigate();
  const { data: products = [] } = useProducts();
  const forecastMap = useForecastDemandMap();
  // Batch-fetch the per-SKU economics + primary supplier cost. Used to
  // compute Total D2C and Contribution Margin inline; previously these
  // columns were hardcoded to "—".
  const { data: economicsById } = useAllSkuEconomics();
  const { data: primaryCostBySkuId } = useAllPrimarySkuSupplierCosts();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [errors, setErrors] = useState<Record<string, string>>({});
  // Server-side error from the create RPC (e.g. unique-key violation,
  // RLS denial). Distinct from `errors` which holds field-level client
  // validation. Cleared when the user opens the dialog or starts typing.
  const [submitError, setSubmitError] = useState<string | null>(null);
  const createProduct = useCreateProduct();

  // Filter state. Search hits SKU + product name; selects narrow by
  // display_category and ABC classification. "Show archived" surfaces
  // SKUs that have archived_at set OR is_active=false.
  const [searchQuery, setSearchQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [abcFilter, setAbcFilter] = useState<string>("all");
  const [showArchived, setShowArchived] = useState(false);

  const filteredProducts = useMemo(() => {
    const filtered = products.filter((product) => {
      const archivedAt = (product as ProductSKU & { archived_at?: string | null })
        .archived_at;
      const isArchived = !!archivedAt || !product.is_active;
      if (isArchived && !showArchived) return false;

      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        const matchesSku = product.sku.toLowerCase().includes(q);
        const matchesName = product.product_name.toLowerCase().includes(q);
        if (!matchesSku && !matchesName) return false;
      }
      if (categoryFilter !== "all" && product.display_category !== categoryFilter) {
        return false;
      }
      if (abcFilter !== "all") {
        if (abcFilter === "none") {
          if (product.abc_classification !== null) return false;
        } else if (product.abc_classification !== abcFilter) {
          return false;
        }
      }
      return true;
    });

    // Sort by Chase's operational category priority (Pipes → Bases),
    // then by product name within each category. Matches the Stock
    // Levels page so the two tables read in the same sequence.
    // Spread before sort because `products` from the hook is upstream-
    // owned and we don't want to mutate the query cache.
    return [...filtered].sort((a, b) => {
      const ra = displayCategoryRank(a.display_category);
      const rb = displayCategoryRank(b.display_category);
      if (ra !== rb) return ra - rb;
      return a.product_name.localeCompare(b.product_name);
    });
  }, [products, searchQuery, categoryFilter, abcFilter, showArchived]);

  // Per-row derived economics, computed once so the sortable columns
  // (costs, margins, monthly $) have concrete values to sort on instead
  // of being computed inline during render.
  const tableRows = useMemo(() => {
    return filteredProducts.map((product) => {
      const econ = economicsById?.get(product.id) ?? null;
      const primaryUnitCost = primaryCostBySkuId?.get(product.id)?.unit_cost ?? 0;
      const d2c = computeListD2C(econ, primaryUnitCost, product.retail_price ?? 0, product.category);
      const demand = getEffectiveDemand(product.id, product.monthly_demand, forecastMap);
      const marginPerUnit =
        d2c && (product.retail_price ?? 0) > 0 ? (product.retail_price ?? 0) - d2c.totalD2C : null;
      const monthlyContribution =
        marginPerUnit !== null && demand > 0 ? marginPerUnit * demand : null;
      const archivedAt = (product as ProductSKU & { archived_at?: string | null }).archived_at;
      const isArchived = !!archivedAt || !product.is_active;
      return { product, econ, d2c, demand, marginPerUnit, monthlyContribution, isArchived };
    });
  }, [filteredProducts, economicsById, primaryCostBySkuId, forecastMap]);

  const { sort, toggleSort } = useTableSort();
  type Row = (typeof tableRows)[number];
  const sortedRows = useMemo(
    () =>
      applySort<Row>(tableRows, sort, {
        sku: (r) => r.product.sku,
        line: (r) => r.product.display_category,
        abc: (r) => r.product.abc_classification,
        retail: (r) => ((r.product.retail_price ?? 0) > 0 ? r.product.retail_price : null),
        demand: (r) => (r.demand > 0 ? r.demand : null),
        raw: (r) => r.d2c?.rawCost ?? null,
        imp: (r) => r.d2c?.importCost ?? null,
        mfg: (r) => r.d2c?.mfgCost ?? null,
        ps: (r) => r.d2c?.packShipCost ?? null,
        total: (r) => r.d2c?.totalD2C ?? null,
        marginD: (r) => r.marginPerUnit,
        marginPct: (r) =>
          r.d2c && (r.product.retail_price ?? 0) > 0 ? r.d2c.contributionMargin : null,
        monthly: (r) => r.monthlyContribution,
      }),
    [tableRows, sort],
  );

  const hasFilters =
    !!searchQuery || categoryFilter !== "all" || abcFilter !== "all" || showArchived;
  function resetFilters() {
    setSearchQuery("");
    setCategoryFilter("all");
    setAbcFilter("all");
    setShowArchived(false);
  }

  function updateForm(field: string, value: string) {
    setForm(prev => ({ ...prev, [field]: value }));
    if (errors[field]) setErrors(prev => { const n = { ...prev }; delete n[field]; return n; });
  }

  function validate() {
    const e: Record<string, string> = {};
    if (!form.sku.trim()) e.sku = "SKU is required";
    else if (products.some(p => p.sku.toLowerCase() === form.sku.trim().toLowerCase())) e.sku = "SKU already exists";
    if (!form.product_name.trim()) e.product_name = "Product name is required";
    if (!form.display_category) e.display_category = "Display category is required";
    if (!form.retail_price || parseFloat(form.retail_price) <= 0) e.retail_price = "Retail price is required";
    if (!form.standard_quantity_per_carton || parseInt(form.standard_quantity_per_carton, 10) <= 0) e.standard_quantity_per_carton = "Qty per carton is required";
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  async function handleSave() {
    if (!validate()) return;
    setSubmitError(null);
    try {
      const created = await createProduct.mutateAsync({
        sku: form.sku.trim(),
        product_name: form.product_name.trim(),
        category: form.category,
        display_category: form.display_category,
        retail_price: form.retail_price ? parseFloat(form.retail_price) : null,
        standard_quantity_per_carton: form.standard_quantity_per_carton
          ? parseInt(form.standard_quantity_per_carton, 10)
          : null,
        upc_code: form.upc_code.trim() || null,
        abc_classification: form.abc_classification || null,
        monthly_demand: form.monthly_demand ? parseInt(form.monthly_demand, 10) : null,
      });
      setDialogOpen(false);
      setForm(emptyForm);
      setErrors({});
      // Drop the operator straight onto the new SKU's detail page so they
      // can fill in costs / supplier / etc. without a second click. Falls
      // back to staying on the list page if the insert succeeded but the
      // returned row is somehow missing an id (shouldn't happen).
      if (created?.id) navigate(`/economics/${created.id}`);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Failed to create SKU");
    }
  }

  function handleClose() {
    setDialogOpen(false);
    setForm(emptyForm);
    setErrors({});
    setSubmitError(null);
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">SKU Economics</h1>
          <p className="text-muted-foreground">Cost breakdown and economics for all products</p>
        </div>
        <Button onClick={() => setDialogOpen(true)} className="gap-2">
          <Plus className="h-4 w-4" />
          New Product
        </Button>
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="relative flex-1 min-w-[260px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search by SKU or product name…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="cat-filter" className="text-xs text-muted-foreground">Product Line</Label>
          <Select value={categoryFilter} onValueChange={setCategoryFilter}>
            <SelectTrigger id="cat-filter" className="h-9 w-[180px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All categories</SelectItem>
              {DISPLAY_CATEGORIES.map((cat) => (
                <SelectItem key={cat} value={cat}>{cat}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="abc-filter" className="text-xs text-muted-foreground">ABC</Label>
          <Select value={abcFilter} onValueChange={setAbcFilter}>
            <SelectTrigger id="abc-filter" className="h-9 w-[120px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="A">A</SelectItem>
              <SelectItem value="B">B</SelectItem>
              <SelectItem value="C">C</SelectItem>
              <SelectItem value="none">Unclassified</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Button
          variant={showArchived ? "default" : "outline"}
          size="sm"
          className="h-9"
          onClick={() => setShowArchived((v) => !v)}
        >
          {showArchived ? "Hide archived" : "Show archived"}
        </Button>
        {hasFilters && (
          <Button variant="ghost" size="sm" className="h-9 text-xs text-muted-foreground" onClick={resetFilters}>
            <X className="mr-1 h-3 w-3" /> Clear
          </Button>
        )}
        <div className="ml-auto text-xs text-muted-foreground pb-1.5 tabular-nums">
          {filteredProducts.length} of {products.length} {products.length === 1 ? "SKU" : "SKUs"}
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">All SKUs</CardTitle>
        </CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          <table className="w-full text-sm min-w-[1200px]">
            {/* Three-section header — colored top labels group the cost-
                breakdown columns and the profitability columns visually
                so the wide table reads in three blocks. */}
            <thead>
              <tr className="text-[9px] uppercase tracking-wider text-muted-foreground/70 border-b border-border/40">
                <th colSpan={5} className="px-4 pt-3 pb-1"></th>
                <th colSpan={5} className="px-2 pt-3 pb-1 text-center border-l border-border bg-muted/20">
                  Cost Breakdown ($/unit)
                </th>
                <th colSpan={3} className="px-2 pt-3 pb-1 text-center border-l border-border bg-muted/20">
                  Profitability
                </th>
              </tr>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                <SortableTh sortKey="sku" sort={sort} onToggle={toggleSort} className="px-4 py-2">SKU</SortableTh>
                <SortableTh sortKey="line" sort={sort} onToggle={toggleSort} className="px-3 py-2">Product Line</SortableTh>
                <SortableTh sortKey="abc" sort={sort} onToggle={toggleSort} className="px-3 py-2">ABC</SortableTh>
                <SortableTh sortKey="retail" sort={sort} onToggle={toggleSort} className="px-3 py-2 text-right">Retail</SortableTh>
                <SortableTh sortKey="demand" sort={sort} onToggle={toggleSort} className="px-3 py-2 text-right">Monthly Demand</SortableTh>
                <SortableTh sortKey="raw" sort={sort} onToggle={toggleSort} className="px-2 py-2 text-right border-l border-border" title="Primary supplier unit cost + additional raw cost">Raw</SortableTh>
                <SortableTh sortKey="imp" sort={sort} onToggle={toggleSort} className="px-2 py-2 text-right" title="Sea/Air freight (weighted) + breakage allowance">Imp</SortableTh>
                <SortableTh sortKey="mfg" sort={sort} onToggle={toggleSort} className="px-2 py-2 text-right" title="US labor + glycerin (unfilled path) or CN manufacturing (prefilled path), weighted by prefilled %">Mfg</SortableTh>
                <SortableTh sortKey="ps" sort={sort} onToggle={toggleSort} className="px-2 py-2 text-right" title="Packing material + packing labor + outbound shipping + 3% credit-card fee">P&amp;S</SortableTh>
                <SortableTh sortKey="total" sort={sort} onToggle={toggleSort} className="px-2 py-2 text-right font-semibold">Total D2C</SortableTh>
                <SortableTh sortKey="marginD" sort={sort} onToggle={toggleSort} className="px-2 py-2 text-right border-l border-border" title="Margin per unit in dollars: retail − total D2C">Margin&nbsp;$</SortableTh>
                <SortableTh sortKey="marginPct" sort={sort} onToggle={toggleSort} className="px-2 py-2 text-right" title="Margin as % of retail (contribution margin ratio)">Margin&nbsp;%</SortableTh>
                <SortableTh sortKey="monthly" sort={sort} onToggle={toggleSort} className="px-3 py-2 text-right font-semibold" title="Monthly contribution: forecasted demand × per-unit margin">Monthly $</SortableTh>
              </tr>
            </thead>
            <tbody>
              {sortedRows.map(({ product, econ, d2c, demand, marginPerUnit, monthlyContribution, isArchived }) => {
                return (
                  <tr
                    key={product.id}
                    className={`border-b border-border/50 hover:bg-muted/50 cursor-pointer ${
                      isArchived ? "opacity-60" : ""
                    }`}
                    onClick={() => navigate(`/economics/${product.id}`)}
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <div>
                          <div className="flex items-center gap-2">
                            <p className="font-medium">{product.sku}</p>
                            {isArchived && (
                              <Badge variant="outline" className="border-red-500/50 text-red-400 text-[10px]">
                                archived
                              </Badge>
                            )}
                          </div>
                          <p className="text-xs text-muted-foreground">{product.product_name}</p>
                        </div>
                        <ExternalLink className="h-3 w-3 text-muted-foreground" />
                      </div>
                    </td>
                    <td className="px-3 py-3">
                      <span className="text-xs text-muted-foreground">{product.display_category}</span>
                    </td>
                    <td className="px-3 py-3">
                      <Badge
                        variant="outline"
                        className={
                          product.abc_classification === "A"
                            ? "border-green-500 text-green-400"
                            : product.abc_classification === "B"
                              ? "border-yellow-500 text-yellow-400"
                              : "border-muted text-muted-foreground"
                        }
                      >
                        {product.abc_classification ?? "-"}
                      </Badge>
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums">
                      {(product.retail_price ?? 0) > 0 ? (
                        `$${(product.retail_price ?? 0).toFixed(2)}`
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums">
                      {demand > 0 ? (
                        demand.toLocaleString()
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </td>

                    {/* Cost breakdown — 4 component columns + total. Each is
                        a small dollar amount; muted "—" when no economics
                        row exists yet so the user knows which SKUs need
                        their costs filled in.

                        Raw column tooltip: when the SKU carries a non-
                        zero additional_raw_cost AND the operator captured
                        a reason on the detail page, surface it here so
                        the "why is BW64P showing $1 extra?" question is
                        answered on hover instead of requiring a drill-in. */}
                    {(() => {
                      const addlReason = econ?.additional_raw_cost_reason;
                      const addl = econ?.additional_raw_cost ?? 0;
                      const tip =
                        addl > 0 && addlReason && addlReason.trim() !== ""
                          ? `Includes $${addl.toFixed(2)} additional raw cost — ${addlReason}`
                          : undefined;
                      return (
                        <td
                          className="px-2 py-3 text-right tabular-nums text-xs border-l border-border"
                          title={tip}
                        >
                          {d2c ? `$${d2c.rawCost.toFixed(2)}` : <Dash />}
                          {tip && (
                            <span className="ml-1 text-amber-400/70" aria-hidden>
                              *
                            </span>
                          )}
                        </td>
                      );
                    })()}
                    <td className="px-2 py-3 text-right tabular-nums text-xs">
                      {d2c ? `$${d2c.importCost.toFixed(2)}` : <Dash />}
                    </td>
                    <td className="px-2 py-3 text-right tabular-nums text-xs">
                      {d2c ? (
                        product.category === "non_fillable" ? (
                          <span className="text-muted-foreground/60" title="Non-fillable SKU — no manufacturing cost">
                            n/a
                          </span>
                        ) : (
                          `$${d2c.mfgCost.toFixed(2)}`
                        )
                      ) : (
                        <Dash />
                      )}
                    </td>
                    <td className="px-2 py-3 text-right tabular-nums text-xs">
                      {d2c ? `$${d2c.packShipCost.toFixed(2)}` : <Dash />}
                    </td>
                    <td className="px-2 py-3 text-right tabular-nums font-semibold">
                      {d2c ? (
                        `$${d2c.totalD2C.toFixed(2)}`
                      ) : (
                        <span className="text-muted-foreground" title="No economics row yet — open the SKU to enter cost data">
                          —
                        </span>
                      )}
                    </td>

                    {/* Profitability — three metrics side by side. Margin $
                        and Margin % share the same color tier; Monthly $ is
                        emphasized as the headline business number and
                        colored by sign (green positive, red negative). */}
                    <td className="px-2 py-3 text-right tabular-nums border-l border-border">
                      {marginPerUnit !== null ? (
                        <span className={marginPerUnit < 0 ? "text-red-400" : ""}>
                          ${marginPerUnit.toFixed(2)}
                        </span>
                      ) : (
                        <Dash />
                      )}
                    </td>
                    <td className="px-2 py-3 text-right tabular-nums">
                      {d2c && (product.retail_price ?? 0) > 0 ? (
                        <span className={marginColor(d2c.contributionMargin)}>
                          {(d2c.contributionMargin * 100).toFixed(1)}%
                        </span>
                      ) : (
                        <Dash />
                      )}
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums font-semibold">
                      {monthlyContribution !== null ? (
                        <span
                          className={
                            monthlyContribution < 0 ? "text-red-400" : "text-green-400"
                          }
                          title={`${demand.toLocaleString()} units × $${(marginPerUnit ?? 0).toFixed(2)} margin`}
                        >
                          {monthlyContribution < 0 ? "−" : ""}$
                          {Math.abs(monthlyContribution).toLocaleString(undefined, {
                            maximumFractionDigits: 0,
                          })}
                        </span>
                      ) : (
                        <Dash />
                      )}
                    </td>
                  </tr>
                );
              })}
              {filteredProducts.length === 0 && (
                <tr>
                  <td colSpan={13} className="px-4 py-12 text-center text-muted-foreground text-sm">
                    No SKUs match the current filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {/* New Product Dialog */}
      <Dialog open={dialogOpen} onOpenChange={v => { if (!v) handleClose(); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Add New Product</DialogTitle>
            <DialogDescription>Create a new SKU in the product catalog. Economics can be configured after creation.</DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            {/* SKU + Name */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">SKU Code *</Label>
                <Input
                  placeholder="FP-XXX-000"
                  value={form.sku}
                  onChange={e => updateForm("sku", e.target.value)}
                  className={errors.sku ? "border-red-500" : ""}
                />
                {errors.sku && <p className="text-[11px] text-red-400">{errors.sku}</p>}
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Product Name *</Label>
                <Input
                  placeholder="Freeze Pipe ..."
                  value={form.product_name}
                  onChange={e => updateForm("product_name", e.target.value)}
                  className={errors.product_name ? "border-red-500" : ""}
                />
                {errors.product_name && <p className="text-[11px] text-red-400">{errors.product_name}</p>}
              </div>
            </div>

            {/* UPC */}
            <div className="space-y-1.5">
              <Label className="text-xs">UPC Code</Label>
              <Input
                placeholder="Optional"
                value={form.upc_code}
                onChange={e => updateForm("upc_code", e.target.value)}
              />
            </div>

            {/* Category + Display Category */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">Manufacturing Category *</Label>
                <Select value={form.category} onValueChange={v => updateForm("category", v)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="fillable">Fillable</SelectItem>
                    <SelectItem value="non_fillable">Non-Fillable</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Product Line *</Label>
                <Select value={form.display_category} onValueChange={v => updateForm("display_category", v)}>
                  <SelectTrigger className={errors.display_category ? "border-red-500" : ""}>
                    <SelectValue placeholder="Select..." />
                  </SelectTrigger>
                  <SelectContent>
                    {DISPLAY_CATEGORIES.map(cat => (
                      <SelectItem key={cat} value={cat}>{cat}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {errors.display_category && <p className="text-[11px] text-red-400">{errors.display_category}</p>}
              </div>
            </div>

            {/* Retail Price + Qty per Carton */}
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">Retail Price *</Label>
                <Input
                  type="number"
                  step="0.01"
                  placeholder="0.00"
                  value={form.retail_price}
                  onChange={e => updateForm("retail_price", e.target.value)}
                  className={errors.retail_price ? "border-red-500" : ""}
                />
                {errors.retail_price && <p className="text-[11px] text-red-400">{errors.retail_price}</p>}
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Qty per Carton *</Label>
                <Input
                  type="number"
                  placeholder="12"
                  value={form.standard_quantity_per_carton}
                  onChange={e => updateForm("standard_quantity_per_carton", e.target.value)}
                  className={errors.standard_quantity_per_carton ? "border-red-500" : ""}
                />
                {errors.standard_quantity_per_carton && <p className="text-[11px] text-red-400">{errors.standard_quantity_per_carton}</p>}
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">ABC Classification</Label>
                <Select value={form.abc_classification} onValueChange={v => updateForm("abc_classification", v)}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select..." />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="A">A</SelectItem>
                    <SelectItem value="B">B</SelectItem>
                    <SelectItem value="C">C</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Monthly Demand */}
            <div className="space-y-1.5">
              <Label className="text-xs">Est. Monthly Demand</Label>
              <Input
                type="number"
                placeholder="0"
                value={form.monthly_demand}
                onChange={e => updateForm("monthly_demand", e.target.value)}
              />
            </div>
          </div>

          {submitError && (
            <div className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300">
              {submitError}
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={handleClose} disabled={createProduct.isPending}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={createProduct.isPending}>
              {createProduct.isPending ? "Creating…" : "Create Product"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// Cell placeholder shown when a SKU has no economics row yet so each
// breakdown column reads consistently muted instead of "$0.00" (which
// would look like real data). Hover for context.
function Dash() {
  return (
    <span
      className="text-muted-foreground/60"
      title="No economics row yet — open the SKU to enter cost data"
    >
      —
    </span>
  );
}

// Margin % tiering — green ≥ 50%, yellow ≥ 30%, red below. Matches the
// rule of thumb the team uses for "this SKU pays for itself comfortably"
// vs "we should look at the cost stack."
function marginColor(ratio: number): string {
  if (ratio >= 0.5) return "text-green-400";
  if (ratio >= 0.3) return "text-yellow-400";
  return "text-red-400";
}
