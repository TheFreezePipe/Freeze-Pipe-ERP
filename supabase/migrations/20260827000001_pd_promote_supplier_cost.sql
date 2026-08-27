-- PD promotion: also seed the quoting supplier's cost as the SKU's primary
-- sku_supplier_costs row. Everything downstream of ordering reads raw cost
-- from the primary supplier cost (rawCostFor / computeListD2C), so a
-- promoted SKU without one shows "no cost data" in the New Factory Order
-- dialog and a zero raw cost on SKU Economics even though the card knows
-- the quoted cost. Backfills any already-promoted PD SKUs.

CREATE OR REPLACE FUNCTION public.rpc_pd_promote_product(p_project_id uuid, p_product jsonb)
RETURNS jsonb
-- SECURITY DEFINER: writes product_skus + sku_economics + sku_supplier_costs
-- + audit_logs in one transaction; the admin gate is jwt_is_admin() on the
-- first line.
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  p        mkt_pd_projects%ROWTYPE;
  v_sku_id uuid;
  cb       jsonb;
  v_supplier_code text;
BEGIN
  IF NOT public.jwt_is_admin() THEN RETURN jsonb_build_object('ok', false, 'error', 'admin_only'); END IF;
  SELECT * INTO p FROM mkt_pd_projects WHERE id = p_project_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found'); END IF;
  IF p.linked_sku_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'sku_id', p.linked_sku_id, 'already', true);
  END IF;
  IF NOT p.cost_basis_confirmed OR p.msrp IS NULL OR p.quoted_unit_cost IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'margin_not_confirmed');
  END IF;
  IF coalesce(p_product->>'sku','') = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'sku_required');
  END IF;
  IF EXISTS (SELECT 1 FROM product_skus WHERE sku = p_product->>'sku') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'sku_exists');
  END IF;

  INSERT INTO product_skus (sku, product_name, category, display_category, retail_price,
                            standard_quantity_per_carton, upc_code, abc_classification,
                            monthly_demand, is_active)
  VALUES (p_product->>'sku',
          coalesce(p_product->>'product_name', p.name),
          coalesce(p_product->>'category', p.category, 'non_fillable'),
          coalesce(p_product->>'display_category', p.display_category),
          coalesce((p_product->>'retail_price')::numeric, p.msrp),
          coalesce((p_product->>'standard_quantity_per_carton')::int, p.carton_qty),
          nullif(p_product->>'upc_code',''),
          nullif(p_product->>'abc_classification',''),
          nullif(p_product->>'monthly_demand','')::int,
          false)  -- inactive until arrival (owner decision)
  RETURNING id INTO v_sku_id;

  -- economics row from the confirmed cost basis; raw cost lands on the
  -- supplier that quoted it
  cb := coalesce(p.cost_basis, '{}'::jsonb);
  SELECT code INTO v_supplier_code FROM suppliers WHERE id = p.supplier_id;
  INSERT INTO sku_economics (sku_id,
      pct_from_nancy, pct_from_yx, nancy_raw_cost, yx_raw_cost,
      pct_sea, pct_air, sea_freight_cost_per_unit, air_freight_cost_per_unit,
      glycerin_cost_us, labor_cost_us, packing_material_cost, packing_labor_cost,
      shipping_cost, credit_card_fees, pct_manufactured_us, pct_manufactured_cn)
  VALUES (v_sku_id,
      CASE WHEN v_supplier_code = 'NANCY' THEN 100 ELSE 0 END,
      CASE WHEN v_supplier_code = 'YX'    THEN 100 ELSE 0 END,
      CASE WHEN v_supplier_code = 'NANCY' THEN p.quoted_unit_cost ELSE 0 END,
      CASE WHEN v_supplier_code = 'YX'    THEN p.quoted_unit_cost ELSE 0 END,
      coalesce((cb->>'pct_sea')::numeric, 100), coalesce((cb->>'pct_air')::numeric, 0),
      coalesce((cb->>'sea_freight_cost_per_unit')::numeric, 0), coalesce((cb->>'air_freight_cost_per_unit')::numeric, 0),
      coalesce((cb->>'glycerin_cost_us')::numeric, 0), coalesce((cb->>'labor_cost_us')::numeric, 0),
      coalesce((cb->>'packing_material_cost')::numeric, 0), coalesce((cb->>'packing_labor_cost')::numeric, 0),
      coalesce((cb->>'shipping_cost')::numeric, 0), coalesce((cb->>'credit_card_fees')::numeric, 0),
      100, 0);

  -- the quoted cost becomes the SKU's primary supplier cost (brand-new SKU,
  -- so no primary can exist yet)
  IF p.supplier_id IS NOT NULL THEN
    INSERT INTO sku_supplier_costs (sku_id, supplier_id, unit_cost, is_primary, notes)
    VALUES (v_sku_id, p.supplier_id, p.quoted_unit_cost, true, 'Quoted on PD card');
  END IF;

  UPDATE mkt_pd_projects SET linked_sku_id = v_sku_id, sku_code = p_product->>'sku' WHERE id = p_project_id;
  INSERT INTO audit_logs (actor_id, action, target_table, target_id, details)
  VALUES (auth.uid(), 'pd.product_promoted', 'product_skus', v_sku_id,
          jsonb_build_object('project_id', p_project_id, 'sku', p_product->>'sku'));
  RETURN jsonb_build_object('ok', true, 'sku_id', v_sku_id);
END $$;

GRANT EXECUTE ON FUNCTION public.rpc_pd_promote_product(uuid, jsonb) TO authenticated;

-- Backfill: SKUs promoted before this migration (primary only when the SKU
-- has no primary cost yet).
INSERT INTO sku_supplier_costs (sku_id, supplier_id, unit_cost, is_primary, notes)
SELECT p.linked_sku_id, p.supplier_id, p.quoted_unit_cost,
       NOT EXISTS (SELECT 1 FROM sku_supplier_costs pc WHERE pc.sku_id = p.linked_sku_id AND pc.is_primary),
       'Quoted on PD card'
FROM mkt_pd_projects p
WHERE p.linked_sku_id IS NOT NULL
  AND p.supplier_id IS NOT NULL
  AND p.quoted_unit_cost IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM sku_supplier_costs c
    WHERE c.sku_id = p.linked_sku_id AND c.supplier_id = p.supplier_id
  );
