-- A pre-launch SKU (PD-promoted: is_active=false, archived_at IS NULL)
-- joins Stock Levels and the rest of the system the moment its first
-- factory-order line is placed (owner decision 2026-08-27; supersedes
-- "inactive until arrival" from the Phase-1 promote RPC). The inventory
-- row already exists — trg_seed_inventory_level_for_new_sku created it at
-- promotion — so flipping is_active is all activation takes.
--
-- SECURITY DEFINER: supplier-portal users can insert factory_order_items
-- but cannot update product_skus under RLS; the activation must not
-- depend on who placed the order. Archived SKUs are never reactivated.

CREATE OR REPLACE FUNCTION public.fn_activate_sku_on_order()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  UPDATE product_skus
     SET is_active = true
   WHERE id = NEW.sku_id AND NOT is_active AND archived_at IS NULL;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_activate_sku_on_order ON public.factory_order_items;
CREATE TRIGGER trg_activate_sku_on_order
AFTER INSERT ON public.factory_order_items
FOR EACH ROW EXECUTE FUNCTION public.fn_activate_sku_on_order();
