import { useId, useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { X } from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { describeError } from "@/lib/supabase-error";
import { DISPLAY_CATEGORIES } from "@/lib/constants";
import { cn } from "@/lib/utils";
import {
  describeOffer,
  OFFER_FORMATS,
  OFFER_FORMAT_LABEL,
  SCOPE_LABEL,
  type OfferFormat,
} from "@/lib/marketing-format";
import {
  buildForecastColumns,
  buildOfferColumns,
  draftFromOffer,
  EMPTY_FORECAST_EDITS,
  EMPTY_OFFER_DRAFT,
  FORMAT_SCOPES,
  forecastView,
  intOrNull,
  isGiftFormat,
  validateOffer,
  validateForecastEdits,
  validateOfferMechanics,
  type DiscountKind,
  type ForecastEdits,
  type OfferDraft,
  type OfferForecastDefaults,
  type Scope,
} from "@/lib/offer-forecast";
import {
  useCreateOffer,
  useUpdateOffer,
  useDeleteOffer,
  useSetOfferSkus,
  useProducts,
  useOfferForecastDefaults,
  type MktOfferInsert,
  type MktOfferWithSkus,
} from "@/lib/hooks";
import type { ProductSKU } from "@/types/database";
import { OfferFormatBadge } from "./OfferSentence";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  saleId: string;
  offer?: MktOfferWithSkus | null;
}

const DOT = "·";
const DASH = "—";

export function OfferFormDialog({ open, onOpenChange, saleId, offer }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-describedby={undefined}
        className="flex max-h-[88vh] max-w-xl flex-col gap-0 overflow-hidden p-0"
      >
        <OfferForm saleId={saleId} offer={offer ?? null} onClose={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Form body — mounted fresh on every open (Radix unmounts closed content), so
// all state initializes from props once and never syncs in an effect.
// ---------------------------------------------------------------------------

function storedDefaults(row: MktOfferWithSkus | null): OfferForecastDefaults | null {
  const src = row?.defaults_source;
  if (!src || typeof src !== "object" || Array.isArray(src) || !("cell" in src)) return null;
  return src as unknown as OfferForecastDefaults;
}

function storedEdits(row: MktOfferWithSkus | null): ForecastEdits {
  if (!row) return EMPTY_FORECAST_EDITS;
  const s = (n: number | null) => (n == null ? "" : String(n));
  return { lift: s(row.expected_uplift_pct), orders: s(row.expected_orders), giftUnits: s(row.planner_gift_units) };
}

function fmtNum(n: number, digits = 1): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: digits });
}

function OfferForm({
  saleId,
  offer,
  onClose,
}: {
  saleId: string;
  offer: MktOfferWithSkus | null;
  onClose: () => void;
}) {
  const [initial] = useState(() => offer);
  const editing = !!initial;
  const ids = useId();
  const { data: products = [] } = useProducts();
  const create = useCreateOffer();
  const update = useUpdateOffer();
  const remove = useDeleteOffer();
  const setSkus = useSetOfferSkus();

  const [draft, setDraft] = useState<OfferDraft>(() =>
    initial ? draftFromOffer(initial, initial.offer_skus.map((s) => s.sku_id)) : EMPTY_OFFER_DRAFT,
  );
  const [labelTouched, setLabelTouched] = useState<boolean>(() => {
    if (!initial) return false;
    const auto = describeOffer(initial, {
      freeItemName: initial.free_item?.product_name,
      skuCodes: initial.offer_skus.map((s) => s.product?.sku).filter((c): c is string => !!c),
      categoryName: initial.category,
    }).deal;
    return initial.label.trim() !== auto;
  });
  const [edits, setEdits] = useState<ForecastEdits>(() => storedEdits(initial));

  const patch = (p: Partial<OfferDraft>) => setDraft((d) => ({ ...d, ...p }));

  const productById = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const pickable = useMemo(
    () => products.filter((p) => p.is_active || draft.skuIds.includes(p.id) || p.id === draft.freeItemSkuId),
    [products, draft.skuIds, draft.freeItemSkuId],
  );

  const format = draft.format;
  const cols = buildOfferColumns(draft);
  const mechOk = validateOfferMechanics(draft, format === "gift_code" ? draft.discountKind : undefined).ok;
  const description = describeOffer(cols, {
    freeItemName: draft.freeItemSkuId ? productById.get(draft.freeItemSkuId)?.product_name : null,
    skuCodes: draft.skuIds.map((id) => productById.get(id)?.sku ?? id),
    categoryName: draft.category || null,
  });
  const autoLabel = mechOk ? description.deal : "";
  const label = labelTouched ? draft.label : autoLabel;
  const valid = validateOffer({ ...draft, label });

  const forecast = useOfferForecastDefaults({
    saleId,
    format,
    scope: draft.scope,
    category: draft.category,
    skuIds: draft.skuIds,
    percentOff: draft.percentOff,
    dollarOff: draft.dollarOff,
    minOrder: draft.minOrder,
    freeItemSkuId: draft.freeItemSkuId,
    getQty: draft.getQty,
    buyQty: draft.buyQty,
    enabled: mechOk,
  });
  // Keep the last loaded defaults on screen while a re-query is in flight.
  const [shown, setShown] = useState<OfferForecastDefaults | null>(() => storedDefaults(initial));
  if (forecast.data !== undefined && forecast.data !== shown) setShown(forecast.data);
  // On a failed re-query keep the last good defaults (stored on the row when
  // editing) rather than nulling derived_* on save.
  const defaults = mechOk ? shown : null;

  function selectFormat(next: OfferFormat) {
    if (draft.format === next) return;
    // An override typed against the previous format's derived value means
    // nothing for the new one.
    setEdits(EMPTY_FORECAST_EDITS);
    setDraft((d) => {
      if (d.format === next) return d;
      const keepScope = FORMAT_SCOPES[next].includes(d.scope);
      return {
        ...EMPTY_OFFER_DRAFT,
        format: next,
        scope: keepScope ? d.scope : FORMAT_SCOPES[next][0],
        category: keepScope ? d.category : "",
        skuIds: keepScope ? d.skuIds : [],
        code: d.code,
        label: d.label,
      };
    });
  }

  function setDiscountKind(kind: DiscountKind) {
    patch({ discountKind: kind, percentOff: "", dollarOff: "" });
  }

  function onLabelChange(v: string) {
    if (v === "") {
      setLabelTouched(false);
      patch({ label: "" });
    } else {
      setLabelTouched(true);
      patch({ label: v });
    }
  }

  const pending = create.isPending || update.isPending || setSkus.isPending || remove.isPending;
  const forecastValid = validateForecastEdits(edits, format);
  const canSave = valid.ok && forecastValid.ok && !pending && !forecast.isFetching;
  const getQtyNum = Number(draft.getQty) || 1;

  async function handleSubmit() {
    if (!valid.ok || !forecastValid.ok || !cols.format) return;
    const payload: MktOfferInsert = {
      ...cols,
      format: cols.format,
      ...buildForecastColumns(defaults, edits, format, getQtyNum),
      sale_id: saleId,
      label: label.trim(),
    };
    const skuIds = cols.scope === "sku_set" ? draft.skuIds : [];
    try {
      let offerId: string;
      if (initial) {
        await update.mutateAsync({ id: initial.id, saleId, updates: payload });
        offerId = initial.id;
      } else {
        const created = await create.mutateAsync(payload);
        offerId = created.id;
      }
      if (initial || skuIds.length > 0) {
        try {
          await setSkus.mutateAsync({ offerId, saleId, skuIds });
        } catch (err) {
          // Never leave a sku_set offer with no members behind.
          if (!initial) await remove.mutateAsync({ id: offerId, saleId }).catch(() => undefined);
          throw err;
        }
      }
      toast({ title: editing ? "Offer updated" : "Offer added" });
      onClose();
    } catch (err) {
      toast({ title: "Couldn't save", description: describeError(err), variant: "destructive" });
    }
  }

  return (
    <>
      <div className="shrink-0 border-b px-6 py-4">
        <DialogTitle>{editing ? "Edit offer" : "Add offer"}</DialogTitle>
      </div>

      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-6">
        <FormatPicker value={format} onChange={selectFormat} />

        {format && (
          <>
            <fieldset className="space-y-4">
              <legend className="mb-3 text-sm font-semibold">{OFFER_FORMAT_LABEL[format]}</legend>
              <FormatFields
                ids={ids}
                draft={draft}
                patch={patch}
                onDiscountKind={setDiscountKind}
                products={pickable}
                productById={productById}
              />
            </fieldset>

            <fieldset className="space-y-4">
              <legend className="mb-3 text-sm font-semibold">Redemption</legend>
              {format !== "gift_code" && (
                <Field label="Coupon code" htmlFor={`${ids}-code`}>
                  <Input
                    id={`${ids}-code`}
                    value={draft.code}
                    onChange={(e) => patch({ code: e.target.value.toUpperCase() })}
                    className="font-mono uppercase"
                    autoCapitalize="characters"
                    spellCheck={false}
                  />
                </Field>
              )}
              <Field label="Label" required htmlFor={`${ids}-label`}>
                <Input id={`${ids}-label`} value={label} onChange={(e) => onLabelChange(e.target.value)} />
              </Field>
            </fieldset>

            <ForecastBox
              ids={ids}
              format={format}
              defaults={defaults}
              edits={edits}
              setEdits={setEdits}
              getQty={intOrNull(draft.getQty) ?? 1}
            />
          </>
        )}
      </div>

      {valid.ok && format && (
        <div aria-live="polite" className="flex shrink-0 flex-wrap items-center gap-2 border-t bg-primary/5 px-6 py-2.5 text-sm">
          <OfferFormatBadge format={format} />
          <span className="font-medium">{description.deal}</span>
          <span className="text-muted-foreground">{DOT}</span>
          <span className="text-muted-foreground">{description.how}</span>
        </div>
      )}

      <div className="flex shrink-0 justify-end gap-2 border-t px-6 py-4">
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={handleSubmit} disabled={!canSave}>
          {pending ? "Saving…" : editing ? "Save offer" : "Add offer"}
        </Button>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Format picker — six radio cards, roving tabindex + arrow keys.
// ---------------------------------------------------------------------------

function FormatPicker({ value, onChange }: { value: OfferFormat | null; onChange: (f: OfferFormat) => void }) {
  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>, i: number) {
    const n = OFFER_FORMATS.length;
    let next: number | null = null;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (i + 1) % n;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (i - 1 + n) % n;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = n - 1;
    if (next == null) return;
    e.preventDefault();
    onChange(OFFER_FORMATS[next]);
    const group = e.currentTarget.closest("[role=radiogroup]");
    group?.querySelectorAll<HTMLButtonElement>("[role=radio]")[next]?.focus();
  }
  return (
    <fieldset>
      <legend className="mb-3 text-sm font-semibold">Format</legend>
      <div role="radiogroup" aria-required="true" className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {OFFER_FORMATS.map((f, i) => {
          const checked = value === f;
          return (
            <button
              key={f}
              type="button"
              role="radio"
              aria-checked={checked}
              tabIndex={checked || (value == null && i === 0) ? 0 : -1}
              onClick={() => onChange(f)}
              onKeyDown={(e) => onKeyDown(e, i)}
              className={cn(
                "flex min-h-[42px] items-center rounded-md border px-3 text-left text-sm transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                checked ? "border-primary bg-primary/5" : "border-border",
              )}
            >
              {OFFER_FORMAT_LABEL[f]}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}

// ---------------------------------------------------------------------------
// Per-format fields (exactly the stored shape's columns).
// ---------------------------------------------------------------------------

interface FieldsProps {
  ids: string;
  draft: OfferDraft;
  patch: (p: Partial<OfferDraft>) => void;
  onDiscountKind: (k: DiscountKind) => void;
  products: ProductSKU[];
  productById: Map<string, ProductSKU>;
}

function FormatFields({ ids, draft, patch, onDiscountKind, products, productById }: FieldsProps) {
  const format = draft.format;
  if (!format) return null;
  const sitewide = draft.scope === "sitewide";

  const percentField = (
    <Field label="Percent off" required htmlFor={`${ids}-pct`}>
      <div className="flex items-center gap-1.5">
        <Input
          id={`${ids}-pct`}
          type="number"
          min={1}
          max={100}
          inputMode="decimal"
          className="w-20"
          value={draft.percentOff}
          onChange={(e) => patch({ percentOff: e.target.value })}
        />
        <span className="text-sm text-muted-foreground">%</span>
      </div>
    </Field>
  );
  const dollarField = (
    <Field label="Dollars off" required htmlFor={`${ids}-dol`}>
      <div className="flex items-center gap-1.5">
        <span className="text-sm text-muted-foreground">$</span>
        <Input
          id={`${ids}-dol`}
          type="number"
          min={0}
          step="0.01"
          inputMode="decimal"
          className="w-24"
          value={draft.dollarOff}
          onChange={(e) => patch({ dollarOff: e.target.value })}
        />
      </div>
    </Field>
  );
  const minOrderField = (required: boolean) => (
    <Field label="Minimum order" required={required} htmlFor={`${ids}-min`}>
      <div className="flex items-center gap-1.5">
        <span className="text-sm text-muted-foreground">$</span>
        <Input
          id={`${ids}-min`}
          type="number"
          min={0}
          step="0.01"
          inputMode="decimal"
          className="w-28"
          value={draft.minOrder}
          onChange={(e) => patch({ minOrder: e.target.value })}
        />
      </div>
    </Field>
  );
  const giftFields = (
    <>
      <Field label="Free item" required htmlFor={`${ids}-gift`}>
        <Select value={draft.freeItemSkuId ?? ""} onValueChange={(v) => patch({ freeItemSkuId: v || null })}>
          <SelectTrigger id={`${ids}-gift`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {products.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                <span className="font-mono text-xs">{p.sku}</span>
                <span className="ml-2 text-muted-foreground">{p.product_name}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field label="Qty" required htmlFor={`${ids}-get`}>
        <Input
          id={`${ids}-get`}
          type="number"
          min={1}
          step={1}
          inputMode="numeric"
          className="w-16"
          value={draft.getQty}
          onChange={(e) => patch({ getQty: e.target.value })}
        />
      </Field>
    </>
  );
  const scopeFields = (label: string) => (
    <ScopeFields ids={ids} label={label} draft={draft} patch={patch} products={products} productById={productById} />
  );

  switch (format) {
    case "percent":
      return (
        <>
          {percentField}
          {scopeFields("Applies to")}
          {sitewide && minOrderField(false)}
        </>
      );
    case "dollar":
      return (
        <>
          {dollarField}
          {scopeFields("Applies to")}
          {!sitewide && (
            <div className="flex items-center gap-2">
              <Checkbox
                id={`${ids}-once`}
                checked={draft.oncePerOrder}
                onCheckedChange={(c) => patch({ oncePerOrder: c === true })}
              />
              <Label htmlFor={`${ids}-once`}>Once per order</Label>
            </div>
          )}
          {sitewide && minOrderField(false)}
        </>
      );
    case "gift_min":
      return (
        <>
          {giftFields}
          {minOrderField(true)}
        </>
      );
    case "gift_skus":
      return (
        <>
          {giftFields}
          {scopeFields("Qualifying items")}
        </>
      );
    case "gift_code":
      return (
        <>
          <Field label="Coupon code" required htmlFor={`${ids}-gcode`}>
            <Input
              id={`${ids}-gcode`}
              value={draft.code}
              onChange={(e) => patch({ code: e.target.value.toUpperCase() })}
              className="font-mono uppercase"
              autoCapitalize="characters"
              spellCheck={false}
            />
          </Field>
          {giftFields}
          <Field label="Discount" htmlFor={`${ids}-kind`}>
            <Select value={draft.discountKind} onValueChange={(v) => onDiscountKind(v as DiscountKind)}>
              <SelectTrigger id={`${ids}-kind`} className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None</SelectItem>
                <SelectItem value="percent">% off</SelectItem>
                <SelectItem value="dollar">$ off</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          {draft.discountKind === "percent" && percentField}
          {draft.discountKind === "dollar" && dollarField}
          {draft.discountKind !== "none" && scopeFields("Applies to")}
        </>
      );
    case "bxgy":
      return (
        <>
          <div className="flex gap-4">
            <Field label="Buy" required htmlFor={`${ids}-buy`}>
              <Input
                id={`${ids}-buy`}
                type="number"
                min={1}
                step={1}
                inputMode="numeric"
                className="w-16"
                value={draft.buyQty}
                onChange={(e) => patch({ buyQty: e.target.value })}
              />
            </Field>
            <Field label="Get free" required htmlFor={`${ids}-get`}>
              <Input
                id={`${ids}-get`}
                type="number"
                min={1}
                step={1}
                inputMode="numeric"
                className="w-16"
                value={draft.getQty}
                onChange={(e) => patch({ getQty: e.target.value })}
              />
            </Field>
          </div>
          {scopeFields("Applies to")}
        </>
      );
  }
}

// ---------------------------------------------------------------------------
// Applies-to: scope Select limited to FORMAT_SCOPES, then Category / SKUs.
// ---------------------------------------------------------------------------

function ScopeFields({
  ids,
  label,
  draft,
  patch,
  products,
  productById,
}: {
  ids: string;
  label: string;
  draft: OfferDraft;
  patch: (p: Partial<OfferDraft>) => void;
  products: ProductSKU[];
  productById: Map<string, ProductSKU>;
}) {
  const format = draft.format;
  if (!format) return null;
  const scopes = FORMAT_SCOPES[format];
  const skuIds = draft.skuIds;
  return (
    <>
      <Field label={label} required htmlFor={`${ids}-scope`}>
        <Select value={draft.scope} onValueChange={(v) => patch({ scope: v as Scope })}>
          <SelectTrigger id={`${ids}-scope`} className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {scopes.map((s) => (
              <SelectItem key={s} value={s}>
                {SCOPE_LABEL[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      {draft.scope === "category" && (
        <Field label="Category" required htmlFor={`${ids}-cat`}>
          <Select value={draft.category} onValueChange={(v) => patch({ category: v })}>
            <SelectTrigger id={`${ids}-cat`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DISPLAY_CATEGORIES.map((c) => (
                <SelectItem key={c} value={c}>
                  {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      )}

      {draft.scope === "sku_set" && (
        <Field label="SKUs" required htmlFor={`${ids}-sku`}>
          <Select
            key={skuIds.length}
            onValueChange={(v) => patch({ skuIds: skuIds.includes(v) ? skuIds : [...skuIds, v] })}
          >
            <SelectTrigger id={`${ids}-sku`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {products
                .filter((p) => !skuIds.includes(p.id))
                .map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    <span className="font-mono text-xs">{p.sku}</span>
                    <span className="ml-2 text-muted-foreground">{p.product_name}</span>
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
          {skuIds.length > 0 && (
            <div className="flex flex-wrap gap-1.5 pt-1">
              {skuIds.map((id) => {
                const code = productById.get(id)?.sku ?? id;
                return (
                  <span
                    key={id}
                    className="inline-flex items-center gap-0.5 whitespace-nowrap rounded bg-muted py-0.5 pl-2 pr-0.5 font-mono text-xs"
                  >
                    {code}
                    <button
                      type="button"
                      aria-label={`Remove ${code}`}
                      onClick={() => patch({ skuIds: skuIds.filter((x) => x !== id) })}
                      className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-background/60 hover:text-foreground"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                );
              })}
            </div>
          )}
        </Field>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Forecast box
// ---------------------------------------------------------------------------

function dotN(n: number | null | undefined): string {
  return n != null ? ` ${DOT} ${n}` : "";
}

function liftChip(d: OfferForecastDefaults | null): string | null {
  if (!d || d.lift_pct == null) return null;
  switch (d.lift_source) {
    case "measured":
      return `Measured${dotN(d.lift_n)}`;
    case "seeded":
      return `Seeded${dotN(d.lift_n)}`;
    case "last_year":
      return "Last year";
    default:
      return "Default";
  }
}

function ordersChip(d: OfferForecastDefaults | null): string | null {
  if (!d || d.orders == null) return null;
  return d.orders_source === "last_year" ? "Last year" : "Derived";
}

function attachChip(d: OfferForecastDefaults | null): string | null {
  if (!d || d.attach_pct == null) return null;
  return d.attach_source === "measured" ? "Measured" : "Default";
}

function ForecastBox({
  ids,
  format,
  defaults,
  edits,
  setEdits,
  getQty,
}: {
  ids: string;
  format: OfferFormat;
  defaults: OfferForecastDefaults | null;
  edits: ForecastEdits;
  setEdits: (u: (e: ForecastEdits) => ForecastEdits) => void;
  getQty: number;
}) {
  // Planner-first: Lift and Orders are typed (empty until then); the
  // history estimate sits beside each as a reference value with its source.
  const view = forecastView(defaults, edits, getQty, format);
  const gift = isGiftFormat(format);
  const edit = (k: keyof ForecastEdits) => (v: string) => setEdits((e) => ({ ...e, [k]: v }));
  const estLift = defaults?.lift_pct ?? null;
  const estOrders = defaults?.orders ?? null;
  // What Gift units read without a typed cap (the planner's orders flow through).
  const computedGift = forecastView(defaults, { ...edits, giftUnits: "" }, getQty, format).giftUnits;
  const after = defaults?.after_ratio ?? null;
  // The after-effect comes from the same history rows as the lift prior, so
  // it is "Measured" only once that cell holds measured (not backfilled) rows.
  const afterChip = `${defaults?.lift_source === "measured" ? "Measured" : "Seeded"}${dotN(defaults?.after_n)}`;

  return (
    <fieldset className="rounded-md border border-amber-500/25 bg-amber-500/[0.03] px-4 pb-4 pt-1">
      <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-amber-400/90">Forecast</legend>
      <div className="flex flex-wrap items-end gap-x-6 gap-y-4">
        <Cell label="Lift" htmlFor={`${ids}-lift`} required>
          <NumInput
            id={`${ids}-lift`}
            value={edits.lift}
            shown={null}
            onChange={edit("lift")}
            width="w-20"
            suffix="%"
          />
        </Cell>
        <Cell label="History">
          <Value>{estLift != null ? `${fmtNum(estLift)}%` : DASH}</Value>
          <Chip text={liftChip(defaults)} />
        </Cell>
        {format !== "percent" && (
          <Cell label="Depth">
            <Value>{defaults?.depth_pct != null ? `${fmtNum(defaults.depth_pct)}%` : DASH}</Value>
          </Cell>
        )}
        {after != null && (
          <Cell label="After">
            <Value>
              {`${after >= 1 ? "+" : ""}${Math.round((after - 1) * 100)}% ${DOT} 14d`}
            </Value>
            <Chip text={afterChip} />
          </Cell>
        )}
      </div>

      {gift && (
        <div className="mt-4 flex flex-wrap items-end gap-x-3 gap-y-4">
          <Cell label="Orders" htmlFor={`${ids}-orders`} required>
            <NumInput
              id={`${ids}-orders`}
              value={edits.orders}
              shown={null}
              onChange={edit("orders")}
              width="w-24"
              integer
              min={1}
            />
            <Muted>{estOrders != null ? fmtNum(estOrders, 0) : DASH}</Muted>
            <Chip text={ordersChip(defaults)} />
          </Cell>
          <Op>&times;</Op>
          <Cell label="Attach">
            <Value>{defaults?.attach_pct != null ? `${fmtNum(defaults.attach_pct)}%` : DASH}</Value>
            <Chip text={attachChip(defaults)} />
          </Cell>
          <Op>&times;</Op>
          <Cell label="Qty">
            <Value>{getQty}</Value>
          </Cell>
          <Op>=</Op>
          <Cell label="Gift units" htmlFor={`${ids}-gift-units`}>
            <NumInput
              id={`${ids}-gift-units`}
              value={edits.giftUnits}
              shown={view.giftUnits}
              onChange={edit("giftUnits")}
              width="w-24"
              integer
              min={0}
            />
            <Chip text={view.giftUnitsSet ? "Set" : view.giftUnits != null ? "Computed" : null} set={view.giftUnitsSet} />
            {view.giftUnitsSet && <Muted>{computedGift != null ? fmtNum(computedGift, 0) : DASH}</Muted>}
          </Cell>
        </div>
      )}
    </fieldset>
  );
}

function NumInput({
  id,
  value,
  shown,
  onChange,
  width,
  suffix,
  integer,
  min,
}: {
  id: string;
  value: string;
  shown: number | null;
  onChange: (v: string) => void;
  width: string;
  suffix?: string;
  integer?: boolean;
  min?: number;
}) {
  const display = value !== "" ? value : shown != null ? String(shown) : "";
  return (
    <div className="flex items-center gap-1">
      <Input
        id={id}
        type="number"
        inputMode={integer ? "numeric" : "decimal"}
        step={integer ? 1 : "any"}
        min={min}
        className={cn("h-8 text-sm", width)}
        value={display}
        onChange={(e) => onChange(e.target.value)}
      />
      {suffix && <span className="text-sm text-muted-foreground">{suffix}</span>}
      {display === "" && <span className="text-sm text-muted-foreground">{DASH}</span>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small layout atoms
// ---------------------------------------------------------------------------

function Field({
  label,
  required,
  htmlFor,
  children,
}: {
  label: string;
  required?: boolean;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor}>
        {label}
        {required && <span className="ml-0.5 text-primary">*</span>}
      </Label>
      {children}
    </div>
  );
}

function Cell({ label, htmlFor, required, children }: { label: string; htmlFor?: string; required?: boolean; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <Label htmlFor={htmlFor} className="text-xs text-muted-foreground">
        {label}
        {required && <span className="ml-0.5 text-primary">*</span>}
      </Label>
      <div className="flex min-h-8 items-center gap-1.5">{children}</div>
    </div>
  );
}

function Value({ children }: { children: ReactNode }) {
  return <span className="text-sm tabular-nums">{children}</span>;
}

function Muted({ children }: { children: ReactNode }) {
  return <span className="text-xs tabular-nums text-muted-foreground">{children}</span>;
}

function Op({ children }: { children: ReactNode }) {
  return <span className="pb-2 text-sm text-muted-foreground">{children}</span>;
}

function Chip({ text, set }: { text: string | null; set?: boolean }) {
  if (!text) return null;
  return (
    <span
      className={cn(
        "whitespace-nowrap rounded border px-1.5 py-0.5 text-[10px] leading-none",
        set ? "border-primary/40 bg-primary/10 text-primary" : "border-amber-500/30 bg-amber-500/10 text-amber-400/90",
      )}
    >
      {text}
    </span>
  );
}
