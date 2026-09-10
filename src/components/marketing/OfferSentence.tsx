import {
  describeOffer,
  inferOfferFormat,
  isOfferFormat,
  OFFER_FORMAT_LABEL,
  type OfferFormat,
  type OfferLike,
} from "@/lib/marketing-format";
import { cn } from "@/lib/utils";

/** Small uppercase format badge shared by the sale-page row and the dialog strip. */
export function OfferFormatBadge({ format, className }: { format: OfferFormat; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center whitespace-nowrap rounded border border-border/60 bg-muted/40 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground",
        className,
      )}
    >
      {OFFER_FORMAT_LABEL[format]}
    </span>
  );
}

export type OfferSentenceRow = OfferLike & {
  label: string;
  expected_uplift_pct?: number | null;
  derived_lift_pct?: number | null;
  planner_gift_units?: number | null;
  derived_gift_units?: number | null;
};

interface Props {
  offer: OfferSentenceRow;
  freeItemName?: string | null;
  skuCodes?: string[];
  className?: string;
}

function signed(n: number): string {
  const r = Math.round(n);
  return `${r >= 0 ? "+" : ""}${r}%`;
}

/**
 * One offer as a sentence: the label line, then the deal (unless the label
 * already IS the deal), the target, how it redeems, and the planning chips.
 * Text comes from describeOffer so this row and the dialog strip can never
 * disagree.
 */
export function OfferSentence({ offer, freeItemName, skuCodes, className }: Props) {
  const d = describeOffer(offer, {
    freeItemName: freeItemName ?? null,
    skuCodes,
    categoryName: offer.category,
  });
  const format: OfferFormat | null = isOfferFormat(offer.format) ? offer.format : inferOfferFormat(offer);
  const label = offer.label.trim();
  const showDeal = label !== d.deal;
  const lift = offer.expected_uplift_pct ?? offer.derived_lift_pct ?? null;
  const gift = offer.planner_gift_units ?? offer.derived_gift_units ?? null;

  return (
    <div className={cn("min-w-0 space-y-1", className)}>
      <p className="font-medium">{label || d.deal}</p>
      <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
        {format && <OfferFormatBadge format={format} />}
        {showDeal && <span className="text-foreground/80">{d.deal}</span>}
        {showDeal && <span>&middot;</span>}
        <span>{d.target}</span>
        <span>&middot;</span>
        {d.code ? (
          <span>
            Code <span className="font-mono text-foreground/80">{d.code}</span>
          </span>
        ) : (
          <span>{d.how}</span>
        )}
        {lift != null && (
          <span className="whitespace-nowrap rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-400">
            Lift {signed(lift)}
          </span>
        )}
        {gift != null && (
          <span className="whitespace-nowrap rounded bg-violet-500/10 px-1.5 py-0.5 text-[10px] text-violet-400">
            Gift {gift.toLocaleString()}
          </span>
        )}
      </p>
    </div>
  );
}
