import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import type { OfferFormat, OfferScope } from "@/lib/marketing-format";
import {
  buildOfferColumns,
  validateOfferMechanics,
  EMPTY_OFFER_DRAFT,
  type OfferDraft,
  type OfferForecastDefaults,
} from "@/lib/offer-forecast";

/**
 * Forecast-box defaults for the Add/Edit-offer dialog: one RPC call keyed on
 * the offer's mechanic fields, enabled only once the format's required
 * fields validate. Lift is never locked here — the dialog re-queries as the
 * mechanics change and the planner's edits live in ForecastEdits.
 */
export interface OfferForecastArgs {
  saleId: string;
  format: OfferFormat | null;
  scope: OfferScope;
  category: string;
  skuIds: string[];
  percentOff: string;
  dollarOff: string;
  minOrder: string;
  freeItemSkuId: string | null;
  getQty: string;
  buyQty: string;
  enabled: boolean;
}

export function useOfferForecastDefaults(args: OfferForecastArgs) {
  const draft: OfferDraft = {
    ...EMPTY_OFFER_DRAFT,
    format: args.format,
    scope: args.scope,
    category: args.category,
    skuIds: args.skuIds,
    percentOff: args.percentOff,
    dollarOff: args.dollarOff,
    minOrder: args.minOrder,
    freeItemSkuId: args.freeItemSkuId,
    getQty: args.getQty,
    buyQty: args.buyQty,
    // gift_code: whichever discount part is present rides along.
    discountKind: args.percentOff.trim() ? "percent" : args.dollarOff.trim() ? "dollar" : "none",
  };
  const valid = !!args.format && validateOfferMechanics(draft).ok;
  // Normalize through the same projection the save path uses, so the RPC
  // sees exactly the columns the format owns (everything else null).
  const cols = buildOfferColumns(draft);
  const skuIds = cols.scope === "sku_set" ? [...args.skuIds].sort() : [];

  const rpcArgs = {
    p_sale_id: args.saleId,
    p_format: args.format ?? "",
    p_scope: cols.scope,
    p_category: cols.category,
    p_sku_ids: skuIds,
    p_percent_off: cols.percent_off,
    p_dollar_off: cols.dollar_off,
    p_min_order: cols.min_order_amount,
    p_free_item_sku_id: cols.free_item_sku_id,
    p_get_qty: cols.get_qty,
    p_buy_qty: cols.buy_qty,
  };

  return useQuery({
    queryKey: ["mkt-offer-forecast-defaults", rpcArgs],
    enabled: args.enabled && !!args.saleId && valid,
    queryFn: async (): Promise<OfferForecastDefaults | null> => {
      const { data, error } = await supabase.rpc("rpc_offer_forecast_defaults", rpcArgs);
      if (error) throw error;
      if (!data || typeof data !== "object" || Array.isArray(data)) return null;
      return data as unknown as OfferForecastDefaults;
    },
    staleTime: 60 * 1000,
  });
}
