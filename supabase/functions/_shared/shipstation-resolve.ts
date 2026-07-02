// =============================================================
// Shared ShipStation line-item resolver
// =============================================================
// Single source of truth for turning raw ShipStation order items into
// shipstation_order_items rows. Used by BOTH shipstation-webhook and
// shipstation-reconcile (previously duplicated in each — audit 2026-07-02).
//
// Filtering: skip empty sku_code, skip qty <= 0, skip non-inventory entries.
// SKU id resolution priority:
//   1. shipstation_sku_handling.resolved_sku_id (exact alias)
//   2. case-insensitive product_skus.sku match
//   3. PREFIX RULE (new): for hyphenated codes, match the leading
//      segment(s) against the catalog (and against existing aliases),
//      shortest prefix first. This auto-routes the recurring patterns:
//        - One-of-One drops:   NB2-Bamboo, BW20-Fathers      -> NB2, BW20
//        - Build-A-Bong combos: NB5-Base_HT5_Red             -> NB5
//        - alias-seeded families: BW58-Textile (via BW58->BW58B alias)
//      Every prefix hit is auto-registered into shipstation_sku_handling
//      (notes: "auto: prefix rule ...") so it is visible, auditable, and
//      overridable by an operator like any manual alias.
//   4. NULL -> goes to triage queue, blocks the order's apply.
//
// Shortest-prefix-first is deliberate: it matches the operator's standing
// rule that customs/combos deduct the FINISHED product (NB2-Base_HT5_Blue
// resolves via segment "NB2" to the bong, not via "NB2-Base" to the base).
// Exact catalog matches (step 2) still win before any prefix logic, so a
// real accessory SKU like BW20-Bowl is never misrouted.
// =============================================================

// Minimal structural types — avoids coupling to each function's full
// ShipStationOrder shape and to a specific supabase-js version.
export interface ResolvableItem {
  sku: string;
  quantity: number;
  unitPrice: number;
  orderItemId: number | string;
}

// deno-lint-ignore no-explicit-any
type Client = any;

export async function resolveLineItems(
  supabase: Client,
  orderRowId: string,
  items: ResolvableItem[],
): Promise<Array<Record<string, unknown>>> {
  const trackable = items.filter((i) =>
    i.sku && i.sku.trim() !== "" && i.quantity > 0
  );
  if (trackable.length === 0) return [];

  const skuCodes = [...new Set(trackable.map((i) => i.sku))];

  // Handling table is small (~150 rows) — fetch it whole so the prefix rule
  // can also match aliases (e.g. seed alias BW58 -> BW58B resolves any
  // future BW58-<drop> code). Exact-code lookups keep their old semantics.
  const [{ data: handlingRows }, { data: allSkus }] = await Promise.all([
    supabase
      .from("shipstation_sku_handling")
      .select("sku_code, resolved_sku_id, is_non_inventory"),
    supabase
      .from("product_skus")
      .select("id, sku, is_active"),
  ]);

  const handlingMap = new Map<string, { resolved_sku_id: string | null; is_non_inventory: boolean }>(
    (handlingRows ?? []).map((r: { sku_code: string; resolved_sku_id: string | null; is_non_inventory: boolean }) =>
      [r.sku_code, { resolved_sku_id: r.resolved_sku_id, is_non_inventory: r.is_non_inventory }],
    ),
  );
  const skuByLowercase = new Map<string, string>(
    (allSkus ?? []).map((r: { id: string; sku: string }) => [r.sku.toLowerCase(), r.id]),
  );
  // Prefix candidates: active products only (never route a new drop code to
  // a retired SKU), plus lowercase alias -> resolved id.
  const activeSkuByLowercase = new Map<string, string>(
    (allSkus ?? [])
      .filter((r: { is_active: boolean }) => r.is_active)
      .map((r: { id: string; sku: string }) => [r.sku.toLowerCase(), r.id]),
  );
  const aliasByLowercase = new Map<string, string>();
  for (const r of handlingRows ?? []) {
    if (!r.is_non_inventory && r.resolved_sku_id) {
      aliasByLowercase.set((r.sku_code as string).toLowerCase(), r.resolved_sku_id as string);
    }
  }

  // Codes resolved via the prefix rule this run, queued for auto-registration.
  const autoRegistered: Array<{ sku_code: string; resolved_sku_id: string; notes: string }> = [];

  function prefixResolve(code: string): string | null {
    const segments = code.split("-").map((s) => s.trim()).filter((s) => s.length > 0);
    if (segments.length < 2) return null;
    // Shortest prefix first (see header comment). Stop before the full code —
    // the full string already failed exact matching.
    for (let n = 1; n < segments.length; n++) {
      const prefix = segments.slice(0, n).join("-").toLowerCase();
      const direct = activeSkuByLowercase.get(prefix);
      if (direct) {
        autoRegistered.push({
          sku_code: code,
          resolved_sku_id: direct,
          notes: `auto: prefix rule (matched catalog SKU "${prefix}")`,
        });
        return direct;
      }
      const viaAlias = aliasByLowercase.get(prefix);
      if (viaAlias) {
        autoRegistered.push({
          sku_code: code,
          resolved_sku_id: viaAlias,
          notes: `auto: prefix rule (via alias "${prefix}")`,
        });
        return viaAlias;
      }
    }
    return null;
  }

  const rows = trackable
    .map((i) => {
      const handling = handlingMap.get(i.sku);
      if (handling?.is_non_inventory) return null;
      const sku_id = handling?.resolved_sku_id
        ?? skuByLowercase.get(i.sku.toLowerCase())
        ?? prefixResolve(i.sku)
        ?? null;
      return {
        shipstation_order_id: orderRowId,
        shipstation_line_item_id: i.orderItemId,
        sku_code: i.sku,
        sku_id,
        quantity: i.quantity,
        unit_price_cents: Math.round(i.unitPrice * 100),
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  // Persist prefix resolutions as regular aliases (idempotent; best-effort —
  // a failure here never blocks item insertion, the code just resolves via
  // the prefix rule again next run).
  if (autoRegistered.length > 0) {
    const unique = [...new Map(autoRegistered.map((a) => [a.sku_code, a])).values()];
    await supabase
      .from("shipstation_sku_handling")
      .upsert(
        unique.map((a) => ({ ...a, is_non_inventory: false })),
        { onConflict: "sku_code", ignoreDuplicates: true },
      );
  }

  return rows;
}
