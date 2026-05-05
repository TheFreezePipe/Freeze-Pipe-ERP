-- =============================================================
-- BASELINE: Production schema snapshot from staging
-- =============================================================
-- Source:  Supabase staging project sitwttqdqqkucwkcyoks
-- Dumped:  2026-05-04 via pg_dump 17.6
-- Replaces: original migrations 20260101000001..059 (archived
--           in supabase/migrations/_archived/)
--
-- After this migration applies, two follow-up steps remain
-- and must be done by the deploy phase (Cowork Phase 3-8):
--   1. ALTER DATABASE postgres SET app.settings.project_url = '...';
--      ALTER DATABASE postgres SET app.settings.service_role_jwt = '...';
--   2. Re-create the 3 cron jobs from original migration 016
--      (tracking-reconcile, shipstation-reconcile-nightly,
--       audit-chain-verify) once the URL/JWT are set.
-- =============================================================

-- Required extensions (must precede any object that references them).
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_net;
CREATE EXTENSION IF NOT EXISTS pg_cron;

--
-- PostgreSQL database dump
--


-- Dumped from database version 17.6
-- Dumped by pg_dump version 17.6

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: pg_database_owner
--

CREATE SCHEMA IF NOT EXISTS public;


ALTER SCHEMA public OWNER TO pg_database_owner;

--
-- Name: _default_location_id(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public._default_location_id() RETURNS uuid
    LANGUAGE sql STABLE
    AS $$
  SELECT id FROM locations WHERE is_default = true LIMIT 1
$$;


ALTER FUNCTION public._default_location_id() OWNER TO postgres;

--
-- Name: _task_type_movement(text); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public._task_type_movement(p_task_type text) RETURNS TABLE(from_field text, to_field text)
    LANGUAGE plpgsql
    AS $$
BEGIN
  CASE p_task_type
    WHEN 'emptying' THEN
      RETURN QUERY SELECT 'warehouse_raw'::TEXT, 'warehouse_in_production'::TEXT;
    WHEN 'rtsing' THEN
      RETURN QUERY SELECT 'warehouse_in_production'::TEXT, 'warehouse_finished'::TEXT;
    WHEN 'prefilled_rtsing' THEN
      RETURN QUERY SELECT 'warehouse_raw'::TEXT, 'warehouse_finished'::TEXT;
    WHEN 'filling_capping' THEN
      -- Stays in warehouse_in_production; no bucket change.
      RETURN QUERY SELECT NULL::TEXT, NULL::TEXT;
    WHEN 'breakage' THEN
      -- Pure decrement: units discovered broken are removed from
      -- warehouse_finished without landing anywhere else. The RPC handles
      -- to_field IS NULL as a plain subtract (no increment).
      RETURN QUERY SELECT 'warehouse_finished'::TEXT, NULL::TEXT;
    ELSE
      RAISE EXCEPTION 'Unknown task_type: %', p_task_type;
  END CASE;
END;
$$;


ALTER FUNCTION public._task_type_movement(p_task_type text) OWNER TO postgres;

--
-- Name: archive_sku(uuid, uuid, text); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.archive_sku(p_sku_id uuid, p_actor_id uuid, p_reason text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_sku RECORD;
  v_inv_total INTEGER;
BEGIN
  SELECT * INTO v_sku FROM product_skus WHERE id = p_sku_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SKU % not found', p_sku_id;
  END IF;
  IF v_sku.archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'SKU % is already archived', v_sku.sku;
  END IF;

  SELECT COALESCE(
    warehouse_raw + warehouse_in_production + warehouse_finished + warehouse_other,
    0
  ) INTO v_inv_total
  FROM inventory_levels WHERE sku_id = p_sku_id;

  IF COALESCE(v_inv_total, 0) > 0 THEN
    RAISE EXCEPTION 'Cannot archive SKU % — has % units on hand in the warehouse. Move stock to warehouse_other or mark as breakage first.',
      v_sku.sku, v_inv_total
      USING HINT = 'If this is intentional, call archive_sku_force() instead.';
  END IF;

  UPDATE product_skus
     SET archived_at = now(),
         archived_by = p_actor_id,
         archive_reason = p_reason,
         is_active = false
   WHERE id = p_sku_id;

  INSERT INTO inventory_transactions (
    sku_id, transaction_type, quantity, field_affected,
    reference_id, reference_type, notes, performed_by
  ) VALUES (
    p_sku_id, 'sku_archived', 0, 'archived_at',
    p_sku_id, 'product_sku',
    format('%s archived: %s', v_sku.sku, p_reason),
    p_actor_id
  );
END;
$$;


ALTER FUNCTION public.archive_sku(p_sku_id uuid, p_actor_id uuid, p_reason text) OWNER TO postgres;

--
-- Name: archive_sku_force(uuid, uuid, text); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.archive_sku_force(p_sku_id uuid, p_actor_id uuid, p_reason text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_sku RECORD;
BEGIN
  SELECT * INTO v_sku FROM product_skus WHERE id = p_sku_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SKU % not found', p_sku_id;
  END IF;

  UPDATE product_skus
     SET archived_at = now(),
         archived_by = p_actor_id,
         archive_reason = p_reason,
         is_active = false
   WHERE id = p_sku_id;

  INSERT INTO inventory_transactions (
    sku_id, transaction_type, quantity, field_affected,
    reference_id, reference_type, notes, performed_by
  ) VALUES (
    p_sku_id, 'sku_archived_force', 0, 'archived_at',
    p_sku_id, 'product_sku',
    format('%s force-archived: %s', v_sku.sku, p_reason),
    p_actor_id
  );
END;
$$;


ALTER FUNCTION public.archive_sku_force(p_sku_id uuid, p_actor_id uuid, p_reason text) OWNER TO postgres;

--
-- Name: audit_hash_chain(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.audit_hash_chain() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_prev_hash TEXT;
  v_payload TEXT;
BEGIN
  SELECT row_hash INTO v_prev_hash
    FROM inventory_transactions
   ORDER BY created_at DESC, id DESC
   LIMIT 1;

  NEW.prev_hash := COALESCE(v_prev_hash, '0000000000000000000000000000000000000000000000000000000000000000');

  v_payload := COALESCE(NEW.id::text, '') || '|'
            || COALESCE(NEW.sku_id::text, '') || '|'
            || COALESCE(NEW.transaction_type, '') || '|'
            || COALESCE(NEW.quantity::text, '') || '|'
            || COALESCE(NEW.field_affected, '') || '|'
            || COALESCE(NEW.movement_kind, '') || '|'
            || COALESCE(NEW.from_field, '') || '|'
            || COALESCE(NEW.to_field, '') || '|'
            || COALESCE(NEW.reference_id::text, '') || '|'
            || COALESCE(NEW.reference_type, '') || '|'
            || COALESCE(NEW.notes, '') || '|'
            || COALESCE(NEW.performed_by::text, '') || '|'
            || COALESCE(NEW.created_at::text, now()::text) || '|'
            || NEW.prev_hash;

  -- Fully qualify to `extensions.digest` so resolution doesn't depend
  -- on the caller's search_path (SECURITY DEFINER RPCs pin it to
  -- `public`, which doesn't contain pgcrypto in Supabase projects).
  NEW.row_hash := encode(extensions.digest(v_payload, 'sha256'), 'hex');
  RETURN NEW;
END;
$$;


ALTER FUNCTION public.audit_hash_chain() OWNER TO postgres;

--
-- Name: block_audit_logs_mutation(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.block_audit_logs_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only. UPDATE/DELETE is not permitted.'
    USING HINT = 'Log a corrective entry with a reference to the original. Never edit history in place.';
END;
$$;


ALTER FUNCTION public.block_audit_logs_mutation() OWNER TO postgres;

--
-- Name: block_audit_mutation(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.block_audit_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'Audit log is immutable. UPDATE/DELETE of inventory_transactions is not permitted.'
    USING HINT = 'Insert a new entry describing the correction instead.';
END;
$$;


ALTER FUNCTION public.block_audit_mutation() OWNER TO postgres;

--
-- Name: block_breakage_report_delete(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.block_breakage_report_delete() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'component_breakage_reports is append-only. DELETE is not permitted.';
END;
$$;


ALTER FUNCTION public.block_breakage_report_delete() OWNER TO postgres;

--
-- Name: block_direct_role_update(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.block_direct_role_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  -- If the role is being changed and we're not the service_role (which
  -- is what the RPC runs as with SECURITY DEFINER), block it.
  IF NEW.role IS DISTINCT FROM OLD.role THEN
    -- current_setting('role') is 'authenticated' for user sessions and
    -- something else when invoked via SECURITY DEFINER. The cleanest check
    -- is "is this being called from within rpc_update_user_role?" via a
    -- GUC we set inside that function. If the GUC isn't set, reject.
    IF COALESCE(current_setting('app.role_change_allowed', true), '') != 'yes' THEN
      RAISE EXCEPTION 'Direct updates to profiles.role are not allowed. Use rpc_update_user_role() instead.'
        USING HINT = 'SELECT rpc_update_user_role(target_user_id, new_role, your_user_id);';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION public.block_direct_role_update() OWNER TO postgres;

--
-- Name: block_shipment_variance_delete(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.block_shipment_variance_delete() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'shipment_variances is append-only. DELETE is not permitted.';
END;
$$;


ALTER FUNCTION public.block_shipment_variance_delete() OWNER TO postgres;

--
-- Name: block_sku_hard_delete(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.block_sku_hard_delete() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'Hard delete of product_skus is not allowed. Use archive_sku() instead.'
    USING HINT = 'Call SELECT archive_sku(''<sku_id>'', auth.uid(), ''reason'') to hide the SKU.';
END;
$$;


ALTER FUNCTION public.block_sku_hard_delete() OWNER TO postgres;

--
-- Name: block_task_log_mutation(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.block_task_log_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'task_logs is append-only. UPDATE/DELETE is not permitted.'
    USING HINT = 'Log a new corrective task entry with a note explaining the fix. Never edit history in place.';
END;
$$;


ALTER FUNCTION public.block_task_log_mutation() OWNER TO postgres;

--
-- Name: bump_row_version(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.bump_row_version() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  -- If caller did not touch row_version explicitly, bump it by 1.
  -- If caller set a specific value (e.g., to reset), respect it.
  IF NEW.row_version = OLD.row_version THEN
    NEW.row_version = OLD.row_version + 1;
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION public.bump_row_version() OWNER TO postgres;

--
-- Name: check_bom_no_cycle(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.check_bom_no_cycle() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_visited UUID[] := ARRAY[NEW.parent_sku_id];
  v_current UUID := NEW.component_sku_id;
  v_depth INTEGER := 0;
BEGIN
  WHILE v_depth < 20 LOOP
    v_depth := v_depth + 1;
    IF v_current = NEW.parent_sku_id THEN
      RAISE EXCEPTION 'BOM insert/update would create a cycle at sku %', v_current;
    END IF;
    IF v_current = ANY(v_visited) THEN
      EXIT;
    END IF;
    v_visited := array_append(v_visited, v_current);
    SELECT component_sku_id INTO v_current
      FROM product_boms
     WHERE parent_sku_id = v_current
       AND effective_until IS NULL
     LIMIT 1;
    IF v_current IS NULL THEN EXIT; END IF;
  END LOOP;
  RETURN NEW;
END;
$$;


ALTER FUNCTION public.check_bom_no_cycle() OWNER TO postgres;

--
-- Name: check_shipped_factory_order_has_cost(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.check_shipped_factory_order_has_cost() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_bad_items INTEGER;
BEGIN
  IF NEW.status = 'shipped' AND OLD.status != 'shipped' THEN
    SELECT COUNT(*) INTO v_bad_items
      FROM factory_order_items
     WHERE factory_order_id = NEW.id AND unit_cost = 0;
    IF v_bad_items > 0 THEN
      RAISE EXCEPTION 'Factory order % has % line item(s) without a unit_cost; set costs before shipping.',
        NEW.order_number, v_bad_items;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION public.check_shipped_factory_order_has_cost() OWNER TO postgres;

--
-- Name: enforce_breakage_report_append_only(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.enforce_breakage_report_append_only() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.factory_order_item_id  IS DISTINCT FROM OLD.factory_order_item_id
  OR NEW.producing_supplier_id  IS DISTINCT FROM OLD.producing_supplier_id
  OR NEW.reporter_supplier_id   IS DISTINCT FROM OLD.reporter_supplier_id
  OR NEW.sku_id                 IS DISTINCT FROM OLD.sku_id
  OR NEW.quantity_broken        IS DISTINCT FROM OLD.quantity_broken
  OR NEW.reason_category        IS DISTINCT FROM OLD.reason_category
  OR NEW.description            IS DISTINCT FROM OLD.description
  OR NEW.created_at             IS DISTINCT FROM OLD.created_at
  OR NEW.created_by             IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'component_breakage_reports: immutable field modified. Only workflow fields may change.'
      USING HINT = 'Open a new report to correct the facts; resolve the old one with notes.';
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION public.enforce_breakage_report_append_only() OWNER TO postgres;

--
-- Name: enforce_breakage_reporter_consolidates(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.enforce_breakage_reporter_consolidates() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_consolidates UUID[];
BEGIN
  SELECT consolidates_for INTO v_consolidates
    FROM suppliers WHERE id = NEW.reporter_supplier_id;
  IF v_consolidates IS NULL OR NOT (NEW.producing_supplier_id = ANY(v_consolidates)) THEN
    RAISE EXCEPTION
      'reporter_supplier_id (%) does not consolidate for producing_supplier_id (%)',
      NEW.reporter_supplier_id, NEW.producing_supplier_id
      USING HINT = 'Only a consolidator (suppliers.consolidates_for contains the producer) may open a breakage report.';
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION public.enforce_breakage_reporter_consolidates() OWNER TO postgres;

--
-- Name: enforce_shipment_variance_append_only(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.enforce_shipment_variance_append_only() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.freight_line_item_id   IS DISTINCT FROM OLD.freight_line_item_id
  OR NEW.shipment_id            IS DISTINCT FROM OLD.shipment_id
  OR NEW.sku_id                 IS DISTINCT FROM OLD.sku_id
  OR NEW.origin_supplier_id     IS DISTINCT FROM OLD.origin_supplier_id
  OR NEW.declared_quantity      IS DISTINCT FROM OLD.declared_quantity
  OR NEW.received_quantity      IS DISTINCT FROM OLD.received_quantity
  OR NEW.variance_type          IS DISTINCT FROM OLD.variance_type
  OR NEW.created_at             IS DISTINCT FROM OLD.created_at
  OR NEW.created_by             IS DISTINCT FROM OLD.created_by
  OR NEW.notes                  IS DISTINCT FROM OLD.notes THEN
    RAISE EXCEPTION 'shipment_variances: immutable field modified. Only status / resolution fields may change.'
      USING HINT = 'To record a correction, resolve this variance and open a new one.';
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION public.enforce_shipment_variance_append_only() OWNER TO postgres;

--
-- Name: handle_new_user(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.handle_new_user() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
BEGIN
  INSERT INTO profiles (id, email, full_name, role)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.email),
    'user'
  );
  RETURN NEW;
END;
$$;


ALTER FUNCTION public.handle_new_user() OWNER TO postgres;

--
-- Name: jwt_is_internal(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.jwt_is_internal() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM profiles
     WHERE id = auth.uid() AND is_active = true
       AND role IN ('admin', 'manager', 'user')
  )
$$;


ALTER FUNCTION public.jwt_is_internal() OWNER TO postgres;

--
-- Name: jwt_supplier_id(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.jwt_supplier_id() RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT supplier_id FROM profiles
   WHERE id = auth.uid() AND is_active = true AND role = 'supplier'
$$;


ALTER FUNCTION public.jwt_supplier_id() OWNER TO postgres;

--
-- Name: jwt_supplier_scope(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.jwt_supplier_scope() RETURNS uuid[]
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT COALESCE(ARRAY[s.id] || s.consolidates_for, ARRAY[]::UUID[])
    FROM profiles p
    JOIN suppliers s ON s.id = p.supplier_id
   WHERE p.id = auth.uid() AND p.is_active = true AND p.role = 'supplier'
$$;


ALTER FUNCTION public.jwt_supplier_scope() OWNER TO postgres;

--
-- Name: prevent_freight_status_regression(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.prevent_freight_status_regression() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.status = 'delivered' AND NEW.status != 'delivered' THEN
    RAISE EXCEPTION 'Cannot change status of delivered shipment % from delivered back to %. If this is a mistake, insert a corrective audit entry and update manually via SQL.',
      NEW.shipment_number, NEW.status;
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION public.prevent_freight_status_regression() OWNER TO postgres;

--
-- Name: restore_sku(uuid, uuid); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.restore_sku(p_sku_id uuid, p_actor_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_sku RECORD;
BEGIN
  SELECT * INTO v_sku FROM product_skus WHERE id = p_sku_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SKU % not found', p_sku_id;
  END IF;
  IF v_sku.archived_at IS NULL THEN
    RAISE EXCEPTION 'SKU % is not archived', v_sku.sku;
  END IF;

  UPDATE product_skus
     SET archived_at = NULL,
         archived_by = NULL,
         archive_reason = NULL,
         is_active = true
   WHERE id = p_sku_id;

  INSERT INTO inventory_transactions (
    sku_id, transaction_type, quantity, field_affected,
    reference_id, reference_type, notes, performed_by
  ) VALUES (
    p_sku_id, 'sku_restored', 0, 'archived_at',
    p_sku_id, 'product_sku',
    format('%s restored from archive', v_sku.sku),
    p_actor_id
  );
END;
$$;


ALTER FUNCTION public.restore_sku(p_sku_id uuid, p_actor_id uuid) OWNER TO postgres;

--
-- Name: rpc_acknowledge_breakage_report(uuid, boolean); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.rpc_acknowledge_breakage_report(p_report_id uuid, p_dispute boolean DEFAULT false) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_row component_breakage_reports%ROWTYPE;
  v_scope UUID[] := jwt_supplier_scope();
  v_new_status TEXT;
BEGIN
  SELECT * INTO v_row FROM component_breakage_reports WHERE id = p_report_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found'); END IF;
  IF NOT jwt_is_internal() AND NOT (v_row.producing_supplier_id = ANY(v_scope)) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_authorized');
  END IF;
  IF v_row.status != 'open' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_transition', 'current_status', v_row.status);
  END IF;
  v_new_status := CASE WHEN p_dispute THEN 'disputed' ELSE 'acknowledged' END;
  UPDATE component_breakage_reports SET status = v_new_status, acknowledged_at = now(), acknowledged_by = auth.uid() WHERE id = p_report_id;
  INSERT INTO audit_logs (actor_id, action, target_table, target_id, details)
  VALUES (auth.uid(), 'breakage_report.acknowledge', 'component_breakage_reports', p_report_id, jsonb_build_object('new_status', v_new_status));
  RETURN jsonb_build_object('ok', true, 'new_status', v_new_status);
END;
$$;


ALTER FUNCTION public.rpc_acknowledge_breakage_report(p_report_id uuid, p_dispute boolean) OWNER TO postgres;

--
-- Name: rpc_acknowledge_shipment_variance(uuid); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.rpc_acknowledge_shipment_variance(p_variance_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_row shipment_variances%ROWTYPE;
  v_scope UUID[] := jwt_supplier_scope();
BEGIN
  SELECT * INTO v_row FROM shipment_variances WHERE id = p_variance_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found'); END IF;
  IF NOT jwt_is_internal() AND NOT (v_row.origin_supplier_id = ANY(v_scope)) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_authorized');
  END IF;
  IF v_row.status != 'open' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_transition', 'current_status', v_row.status);
  END IF;
  UPDATE shipment_variances SET status = 'acknowledged', acknowledged_at = now(), acknowledged_by = auth.uid() WHERE id = p_variance_id;
  INSERT INTO audit_logs (actor_id, action, target_table, target_id, details)
  VALUES (auth.uid(), 'shipment_variance.acknowledge', 'shipment_variances', p_variance_id, '{}'::JSONB);
  RETURN jsonb_build_object('ok', true);
END;
$$;


ALTER FUNCTION public.rpc_acknowledge_shipment_variance(p_variance_id uuid) OWNER TO postgres;

--
-- Name: rpc_admin_link_factory_order_to_parent(uuid, uuid); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.rpc_admin_link_factory_order_to_parent(p_child_order_id uuid, p_parent_order_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_role TEXT;
  v_parent factory_orders%ROWTYPE;
  v_child  factory_orders%ROWTYPE;
BEGIN
  SELECT role INTO v_role FROM profiles WHERE id = auth.uid();
  IF v_role NOT IN ('admin', 'manager') THEN
    RAISE EXCEPTION 'forbidden: admin/manager only';
  END IF;
  IF p_child_order_id = p_parent_order_id THEN
    RAISE EXCEPTION 'cannot link an order to itself';
  END IF;
  SELECT * INTO v_parent FROM factory_orders WHERE id = p_parent_order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'parent order % not found', p_parent_order_id;
  END IF;
  IF v_parent.parent_factory_order_id IS NOT NULL THEN
    RAISE EXCEPTION 'parent order is itself a child — only one level of nesting allowed';
  END IF;
  SELECT * INTO v_child FROM factory_orders WHERE id = p_child_order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'child order % not found', p_child_order_id;
  END IF;
  IF EXISTS (
    SELECT 1 FROM factory_orders WHERE parent_factory_order_id = p_child_order_id
  ) THEN
    RAISE EXCEPTION 'child order already has its own children — cannot demote to grandchild';
  END IF;
  UPDATE factory_orders
     SET parent_factory_order_id = p_parent_order_id,
         updated_at = now()
   WHERE id = p_child_order_id;
END;
$$;


ALTER FUNCTION public.rpc_admin_link_factory_order_to_parent(p_child_order_id uuid, p_parent_order_id uuid) OWNER TO postgres;

--
-- Name: rpc_admin_unlink_factory_order_from_parent(uuid); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.rpc_admin_unlink_factory_order_from_parent(p_child_order_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_role TEXT;
BEGIN
  SELECT role INTO v_role FROM profiles WHERE id = auth.uid();
  IF v_role NOT IN ('admin', 'manager') THEN
    RAISE EXCEPTION 'forbidden: admin/manager only';
  END IF;
  UPDATE factory_orders
     SET parent_factory_order_id = NULL,
         updated_at = now()
   WHERE id = p_child_order_id;
END;
$$;


ALTER FUNCTION public.rpc_admin_unlink_factory_order_from_parent(p_child_order_id uuid) OWNER TO postgres;

--
-- Name: rpc_apply_freight_delivery(uuid, uuid); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.rpc_apply_freight_delivery(p_shipment_id uuid, p_actor_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_shipment freight_shipments%ROWTYPE;
  v_li RECORD;
  v_moved_count INTEGER := 0;
BEGIN
  SELECT * INTO v_shipment FROM freight_shipments WHERE id = p_shipment_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'shipment not found');
  END IF;
  IF v_shipment.status = 'delivered' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'shipment already delivered');
  END IF;

  -- --------------------------------------------------------------
  -- Protected section: any exception rolls back the whole delivery
  -- (inventory increments + audit rows + status flip) so partial
  -- deliveries never materialize. Same belt-and-suspenders pattern
  -- we added to rpc_log_task_completion in migration 038.
  -- --------------------------------------------------------------
  BEGIN
    FOR v_li IN
      SELECT * FROM freight_line_items WHERE freight_shipment_id = p_shipment_id
    LOOP
      -- Lock the inventory row so the concurrent delivery + task-log
      -- writers can't race on warehouse_raw.
      PERFORM 1 FROM inventory_levels WHERE sku_id = v_li.sku_id FOR UPDATE;

      -- Straight increment — no legacy transit column to decrement.
      -- The in-transit half of the lifecycle lives in freight_shipments
      -- (status in {pending, on_the_water, …}); once status flips to
      -- 'delivered' below, the UI treats those units as warehouse-resident.
      UPDATE inventory_levels
         SET warehouse_raw = warehouse_raw + v_li.quantity
       WHERE sku_id = v_li.sku_id;

      -- Audit row. movement_kind = 'net_change' because there's no
      -- inventory-side source bucket being drained — the units physically
      -- came from the carrier. (Using 'category_move' would fail the
      -- chk_move_fields_consistent CHECK since from_field must be NULL.)
      INSERT INTO inventory_transactions (
        sku_id, transaction_type, quantity, field_affected,
        movement_kind, from_field, to_field,
        reference_id, reference_type, notes, performed_by
      ) VALUES (
        v_li.sku_id, 'freight_delivered', v_li.quantity, 'warehouse_raw',
        'net_change', NULL, 'warehouse_raw',
        p_shipment_id, 'freight_shipment',
        format('%s delivered: %s units landed', v_shipment.shipment_number, v_li.quantity),
        p_actor_id
      );
      v_moved_count := v_moved_count + 1;
    END LOOP;

    UPDATE freight_shipments
       SET status = 'delivered',
           actual_arrival_date = COALESCE(actual_arrival_date, CURRENT_DATE)
     WHERE id = p_shipment_id;

    RETURN jsonb_build_object('ok', true, 'line_items_processed', v_moved_count);

  EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'internal_error',
      'sqlstate', SQLSTATE,
      'message', SQLERRM
    );
  END;
END;
$$;


ALTER FUNCTION public.rpc_apply_freight_delivery(p_shipment_id uuid, p_actor_id uuid) OWNER TO postgres;

--
-- Name: rpc_apply_freight_status_override(uuid, text, uuid, integer, text); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.rpc_apply_freight_status_override(p_shipment_id uuid, p_new_status text, p_actor_id uuid, p_expected_version integer, p_reason text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_shipment freight_shipments%ROWTYPE;
  v_prev_status TEXT;
BEGIN
  IF NOT jwt_is_internal() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;

  IF p_new_status NOT IN (
    'pending', 'on_the_water', 'high_risk', 'cleared_customs', 'tracking', 'delivered'
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_status', 'status', p_new_status);
  END IF;

  -- Delivery is its own RPC — it has to move units from in-flight to
  -- the warehouse. Refuse here so the caller picks the right path.
  IF p_new_status = 'delivered' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'use_delivery_rpc',
      'hint', 'call rpc_apply_freight_delivery for delivered transitions'
    );
  END IF;

  SELECT * INTO v_shipment FROM freight_shipments WHERE id = p_shipment_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;

  IF v_shipment.row_version != p_expected_version THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'version_conflict',
      'current_version', v_shipment.row_version
    );
  END IF;

  v_prev_status := v_shipment.status;

  UPDATE freight_shipments
     SET status = p_new_status,
         status_overridden_at = now(),
         status_overridden_by = p_actor_id
   WHERE id = p_shipment_id;

  INSERT INTO audit_logs (actor_id, action, target_table, target_id, details)
  VALUES (
    p_actor_id,
    'freight.status_override',
    'freight_shipments',
    p_shipment_id,
    jsonb_build_object(
      'shipment_number', v_shipment.shipment_number,
      'prev_status', v_prev_status,
      'new_status', p_new_status,
      'reason', p_reason
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'prev_status', v_prev_status,
    'new_status', p_new_status
  );
END;
$$;


ALTER FUNCTION public.rpc_apply_freight_status_override(p_shipment_id uuid, p_new_status text, p_actor_id uuid, p_expected_version integer, p_reason text) OWNER TO postgres;

--
-- Name: rpc_apply_shipstation_sale(uuid, uuid); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.rpc_apply_shipstation_sale(p_order_id uuid, p_system_actor_id uuid DEFAULT NULL::uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_order shipstation_orders%ROWTYPE;
  v_item RECORD;
  v_sku product_skus%ROWTYPE;
  v_available INTEGER;
  v_line_items_applied INTEGER := 0;
  v_line_items_unresolved INTEGER := 0;
BEGIN
  SELECT * INTO v_order FROM shipstation_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'order not found');
  END IF;
  IF v_order.inventory_applied_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'already_applied', true);
  END IF;

  FOR v_item IN
    SELECT * FROM shipstation_order_items WHERE shipstation_order_id = p_order_id
  LOOP
    IF v_item.sku_id IS NULL THEN
      v_line_items_unresolved := v_line_items_unresolved + 1;
      CONTINUE;
    END IF;

    SELECT * INTO v_sku FROM product_skus WHERE id = v_item.sku_id;
    PERFORM 1 FROM inventory_levels WHERE sku_id = v_item.sku_id FOR UPDATE;

    SELECT warehouse_finished INTO v_available
      FROM inventory_levels WHERE sku_id = v_item.sku_id;

    IF COALESCE(v_available, 0) < v_item.quantity THEN
      INSERT INTO inventory_transactions (
        sku_id, transaction_type, quantity, field_affected,
        movement_kind, notes, performed_by
      ) VALUES (
        v_item.sku_id, 'shipstation_oversell_warning',
        -v_item.quantity, 'warehouse_finished',
        'metadata',
        format('%s: oversold on ShipStation order %s — available %s, sold %s. Requires cycle-count correction.',
          v_sku.sku, v_order.order_number, COALESCE(v_available, 0), v_item.quantity),
        p_system_actor_id
      );
      CONTINUE;
    END IF;

    UPDATE inventory_levels
       SET warehouse_finished = warehouse_finished - v_item.quantity
     WHERE sku_id = v_item.sku_id;

    INSERT INTO inventory_transactions (
      sku_id, transaction_type, quantity, field_affected,
      movement_kind, reference_id, reference_type, notes, performed_by
    ) VALUES (
      v_item.sku_id, 'order_shipped', -v_item.quantity, 'warehouse_finished',
      'net_change', p_order_id, 'shipstation_order',
      format('ShipStation order %s: -%s units', v_order.order_number, v_item.quantity),
      p_system_actor_id
    );
    v_line_items_applied := v_line_items_applied + 1;
  END LOOP;

  IF v_line_items_unresolved = 0 THEN
    UPDATE shipstation_orders
       SET inventory_applied_at = now(),
           inventory_apply_error = NULL,
           inventory_apply_attempts = inventory_apply_attempts + 1
     WHERE id = p_order_id;
  ELSE
    UPDATE shipstation_orders
       SET inventory_apply_attempts = inventory_apply_attempts + 1,
           inventory_apply_error = format('%s line item(s) have unresolved SKU codes', v_line_items_unresolved)
     WHERE id = p_order_id;
  END IF;

  RETURN jsonb_build_object(
    'ok', v_line_items_unresolved = 0,
    'applied', v_line_items_applied,
    'unresolved', v_line_items_unresolved
  );
END;
$$;


ALTER FUNCTION public.rpc_apply_shipstation_sale(p_order_id uuid, p_system_actor_id uuid) OWNER TO postgres;

--
-- Name: rpc_bulk_cycle_count(jsonb, text, text, uuid); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.rpc_bulk_cycle_count(p_adjustments jsonb, p_reason text, p_notes text, p_actor_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
DECLARE
  v_adj         JSONB;
  v_sku_id      UUID;
  v_field       TEXT;
  v_delta       INTEGER;
  v_sku         product_skus%ROWTYPE;
  v_current     INTEGER;
  v_new         INTEGER;
  v_failures    JSONB := '[]'::JSONB;
  v_results     JSONB := '[]'::JSONB;
  v_applied     INTEGER := 0;
BEGIN
  IF p_adjustments IS NULL OR jsonb_typeof(p_adjustments) <> 'array' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'p_adjustments must be a JSON array');
  END IF;
  IF jsonb_array_length(p_adjustments) = 0 THEN
    RETURN jsonb_build_object('ok', true, 'applied', 0, 'adjustments', '[]'::JSONB);
  END IF;
  FOR v_adj IN SELECT * FROM jsonb_array_elements(p_adjustments) LOOP
    v_sku_id := (v_adj->>'sku_id')::UUID;
    v_field  := v_adj->>'field';
    v_delta  := (v_adj->>'delta')::INTEGER;
    IF v_delta IS NULL OR v_delta = 0 THEN
      v_failures := v_failures || jsonb_build_object('sku_id', v_sku_id, 'field', v_field, 'reason', 'delta_must_be_nonzero');
      CONTINUE;
    END IF;
    IF v_field NOT IN ('warehouse_raw','warehouse_in_production','warehouse_finished','warehouse_other') THEN
      v_failures := v_failures || jsonb_build_object('sku_id', v_sku_id, 'field', v_field, 'reason', 'invalid_field');
      CONTINUE;
    END IF;
    SELECT * INTO v_sku FROM product_skus WHERE id = v_sku_id;
    IF NOT FOUND THEN
      v_failures := v_failures || jsonb_build_object('sku_id', v_sku_id, 'field', v_field, 'reason', 'sku_not_found');
      CONTINUE;
    END IF;
    EXECUTE format('SELECT %I FROM inventory_levels WHERE sku_id = $1', v_field)
      INTO v_current USING v_sku_id;
    v_new := COALESCE(v_current, 0) + v_delta;
    IF v_new < 0 THEN
      v_failures := v_failures || jsonb_build_object(
        'sku_id', v_sku_id, 'field', v_field, 'delta', v_delta,
        'current', COALESCE(v_current, 0), 'reason', 'would_go_negative'
      );
      CONTINUE;
    END IF;
  END LOOP;
  IF jsonb_array_length(v_failures) > 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'validation_failed', 'failures', v_failures);
  END IF;
  FOR v_adj IN SELECT * FROM jsonb_array_elements(p_adjustments) LOOP
    v_sku_id := (v_adj->>'sku_id')::UUID;
    v_field  := v_adj->>'field';
    v_delta  := (v_adj->>'delta')::INTEGER;
    IF v_delta = 0 THEN CONTINUE; END IF;
    SELECT * INTO v_sku FROM product_skus WHERE id = v_sku_id;
    PERFORM 1 FROM inventory_levels WHERE sku_id = v_sku_id FOR UPDATE;
    EXECUTE format('SELECT %I FROM inventory_levels WHERE sku_id = $1', v_field)
      INTO v_current USING v_sku_id;
    v_new := COALESCE(v_current, 0) + v_delta;
    IF v_new < 0 THEN
      RAISE EXCEPTION 'rpc_bulk_cycle_count: SKU % field % would go negative on apply (concurrent write race?)',
        v_sku.sku, v_field;
    END IF;
    EXECUTE format('UPDATE inventory_levels SET %I = $1 WHERE sku_id = $2', v_field)
      USING v_new, v_sku_id;
    INSERT INTO inventory_transactions (
      sku_id, transaction_type, quantity, field_affected,
      movement_kind, notes, performed_by
    ) VALUES (
      v_sku_id, 'cycle_count', v_delta, v_field, 'net_change',
      format('%s: %s%s on %s (%s)%s',
        v_sku.sku,
        CASE WHEN v_delta > 0 THEN '+' ELSE '' END,
        v_delta, v_field, p_reason,
        CASE WHEN p_notes IS NOT NULL THEN ' — ' || p_notes ELSE '' END
      ),
      p_actor_id
    );
    v_results := v_results || jsonb_build_object('sku_id', v_sku_id, 'field', v_field, 'delta', v_delta, 'new_value', v_new);
    v_applied := v_applied + 1;
  END LOOP;
  RETURN jsonb_build_object('ok', true, 'applied', v_applied, 'adjustments', v_results);
END;
$_$;


ALTER FUNCTION public.rpc_bulk_cycle_count(p_adjustments jsonb, p_reason text, p_notes text, p_actor_id uuid) OWNER TO postgres;

--
-- Name: rpc_clear_freight_status_override(uuid, uuid, integer); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.rpc_clear_freight_status_override(p_shipment_id uuid, p_actor_id uuid, p_expected_version integer) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_shipment freight_shipments%ROWTYPE;
BEGIN
  IF NOT jwt_is_internal() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;

  SELECT * INTO v_shipment FROM freight_shipments WHERE id = p_shipment_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;

  IF v_shipment.row_version != p_expected_version THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'version_conflict',
      'current_version', v_shipment.row_version
    );
  END IF;

  IF v_shipment.status_overridden_at IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'noop', true);
  END IF;

  UPDATE freight_shipments
     SET status_overridden_at = NULL,
         status_overridden_by = NULL
   WHERE id = p_shipment_id;

  INSERT INTO audit_logs (actor_id, action, target_table, target_id, details)
  VALUES (
    p_actor_id,
    'freight.status_override_cleared',
    'freight_shipments',
    p_shipment_id,
    jsonb_build_object(
      'shipment_number', v_shipment.shipment_number,
      'status_at_clear', v_shipment.status
    )
  );

  RETURN jsonb_build_object('ok', true);
END;
$$;


ALTER FUNCTION public.rpc_clear_freight_status_override(p_shipment_id uuid, p_actor_id uuid, p_expected_version integer) OWNER TO postgres;

--
-- Name: rpc_consolidator_confirm_factory_order_receive(jsonb); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.rpc_consolidator_confirm_factory_order_receive(p_payload jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_caller_supplier_id UUID := jwt_supplier_id();
  v_order_id UUID := (p_payload->>'factory_order_id')::UUID;
  v_expected_version INTEGER := (p_payload->>'expected_version')::INTEGER;
  v_order factory_orders%ROWTYPE;
  v_item JSONB;
  v_foi factory_order_items%ROWTYPE;
  v_confirmed INTEGER;
  v_breakage INTEGER;
  v_items_processed INTEGER := 0;
  v_breakage_reports_created INTEGER := 0;
  v_report_id UUID;
BEGIN
  IF v_caller_supplier_id IS NULL AND NOT jwt_is_internal() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_authorized');
  END IF;
  SELECT * INTO v_order FROM factory_orders WHERE id = v_order_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found'); END IF;
  IF v_order.row_version != v_expected_version THEN
    RETURN jsonb_build_object('ok', false, 'error', 'version_conflict', 'current_version', v_order.row_version);
  END IF;
  IF v_caller_supplier_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM suppliers WHERE id = v_caller_supplier_id AND v_order.supplier_id = ANY(consolidates_for)) THEN
      RETURN jsonb_build_object('ok', false, 'error', 'not_consolidator_for_producer');
    END IF;
  END IF;
  IF v_order.status NOT IN ('in_production', 'finished') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_receivable', 'current_status', v_order.status);
  END IF;
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_payload->'items') LOOP
    SELECT * INTO v_foi FROM factory_order_items
     WHERE id = (v_item->>'factory_order_item_id')::UUID AND factory_order_id = v_order_id FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'error', 'item_not_in_order', 'factory_order_item_id', v_item->>'factory_order_item_id');
    END IF;
    IF v_foi.consolidator_confirmed_quantity IS NOT NULL THEN
      RETURN jsonb_build_object('ok', false, 'error', 'already_confirmed', 'factory_order_item_id', v_foi.id);
    END IF;
    v_confirmed := (v_item->>'confirmed_quantity')::INTEGER;
    v_breakage := COALESCE((v_item->>'breakage_quantity')::INTEGER, 0);
    IF v_confirmed < 0 OR v_breakage < 0 OR v_breakage > v_confirmed THEN
      RETURN jsonb_build_object('ok', false, 'error', 'invalid_quantities', 'factory_order_item_id', v_foi.id);
    END IF;
    UPDATE factory_order_items SET consolidator_confirmed_quantity = v_confirmed,
      consolidator_confirmed_at = now(), consolidator_confirmed_by = auth.uid(), quantity_breakage = v_breakage
     WHERE id = v_foi.id;
    IF v_breakage > 0 AND v_caller_supplier_id IS NOT NULL AND v_caller_supplier_id != v_order.supplier_id THEN
      INSERT INTO component_breakage_reports (factory_order_item_id, producing_supplier_id, reporter_supplier_id,
        sku_id, quantity_broken, reason_category, description, status, created_by)
      VALUES (v_foi.id, v_order.supplier_id, v_caller_supplier_id, v_foi.sku_id, v_breakage,
              COALESCE(v_item->>'breakage_reason_category', 'other'),
              COALESCE(v_item->>'breakage_description', 'Auto-opened from receive. Add details.'),
              'open', auth.uid()) RETURNING id INTO v_report_id;
      v_breakage_reports_created := v_breakage_reports_created + 1;
    END IF;
    v_items_processed := v_items_processed + 1;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM factory_order_items WHERE factory_order_id = v_order_id AND consolidator_confirmed_quantity IS NULL)
     AND v_order.status != 'finished' THEN
    UPDATE factory_orders SET status = 'finished' WHERE id = v_order_id;
  END IF;
  INSERT INTO audit_logs (actor_id, action, target_table, target_id, details)
  VALUES (auth.uid(), 'factory_order.consolidator_receive', 'factory_orders', v_order_id,
          jsonb_build_object('items_processed', v_items_processed, 'breakage_reports_created', v_breakage_reports_created));
  RETURN jsonb_build_object('ok', true, 'items_processed', v_items_processed, 'breakage_reports_created', v_breakage_reports_created);
END;
$$;


ALTER FUNCTION public.rpc_consolidator_confirm_factory_order_receive(p_payload jsonb) OWNER TO postgres;

--
-- Name: rpc_cycle_count(uuid, text, integer, text, text, uuid); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.rpc_cycle_count(p_sku_id uuid, p_field text, p_delta integer, p_reason text, p_notes text, p_actor_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
DECLARE
  v_sku product_skus%ROWTYPE;
  v_current INTEGER;
  v_new INTEGER;
BEGIN
  IF p_delta = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'delta must be non-zero');
  END IF;
  IF p_field NOT IN (
    'warehouse_raw', 'warehouse_in_production', 'warehouse_finished', 'warehouse_other'
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'cycle counts only apply to warehouse buckets');
  END IF;

  SELECT * INTO v_sku FROM product_skus WHERE id = p_sku_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'sku not found');
  END IF;

  PERFORM 1 FROM inventory_levels WHERE sku_id = p_sku_id FOR UPDATE;

  EXECUTE format('SELECT %I FROM inventory_levels WHERE sku_id = $1', p_field)
    INTO v_current USING p_sku_id;
  v_new := COALESCE(v_current, 0) + p_delta;

  IF v_new < 0 THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'would_go_negative',
      'current', v_current,
      'delta', p_delta
    );
  END IF;

  EXECUTE format('UPDATE inventory_levels SET %I = $1 WHERE sku_id = $2', p_field)
    USING v_new, p_sku_id;

  INSERT INTO inventory_transactions (
    sku_id, transaction_type, quantity, field_affected,
    movement_kind, notes, performed_by
  ) VALUES (
    p_sku_id, 'cycle_count', p_delta, p_field,
    'net_change',
    format('%s: %s%s on %s (%s)%s',
      v_sku.sku,
      CASE WHEN p_delta > 0 THEN '+' ELSE '' END,
      p_delta,
      p_field,
      p_reason,
      CASE WHEN p_notes IS NOT NULL THEN ' — ' || p_notes ELSE '' END
    ),
    p_actor_id
  );

  RETURN jsonb_build_object('ok', true, 'new_value', v_new);
END;
$_$;


ALTER FUNCTION public.rpc_cycle_count(p_sku_id uuid, p_field text, p_delta integer, p_reason text, p_notes text, p_actor_id uuid) OWNER TO postgres;

--
-- Name: rpc_factory_order_component_status(uuid); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.rpc_factory_order_component_status(p_factory_order_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_parent factory_orders%ROWTYPE;
  v_is_internal BOOLEAN;
  v_supplier_scope UUID[];
BEGIN
  SELECT * INTO v_parent FROM factory_orders WHERE id = p_factory_order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'factory_order % not found', p_factory_order_id;
  END IF;

  v_is_internal := jwt_is_internal();
  IF NOT v_is_internal THEN
    v_supplier_scope := jwt_supplier_scope();
    IF NOT (v_parent.supplier_id = ANY(v_supplier_scope)) THEN
      RAISE EXCEPTION 'forbidden: caller does not own this order';
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'expected_components', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'component_sku_id', t.component_sku_id,
        'component_sku',    t.sku,
        'quantity_needed',  t.quantity_needed
      )), '[]'::JSONB)
      FROM (
        SELECT b.component_sku_id,
               sk.sku,
               SUM(foi.quantity_ordered * b.units_per_parent)::INTEGER AS quantity_needed
          FROM factory_order_items foi
          JOIN product_boms b
            ON b.parent_sku_id = foi.sku_id
           AND b.component_type = 'produced'
           AND b.effective_until IS NULL
          JOIN product_skus sk ON sk.id = b.component_sku_id
         WHERE foi.factory_order_id = p_factory_order_id
         GROUP BY b.component_sku_id, sk.sku
      ) t
    ),
    'child_orders', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id',                  c.id,
        'order_number',        c.order_number,
        'supplier_id',         c.supplier_id,
        'supplier_code',       s.code,
        'supplier_name',       s.name,
        'status',              c.status,
        'order_date',          c.order_date,
        'expected_completion', c.expected_completion,
        'components', (
          SELECT COALESCE(jsonb_agg(jsonb_build_object(
            'sku_id',            ci.sku_id,
            'sku',               sk.sku,
            'quantity_ordered',  ci.quantity_ordered,
            'quantity_finished', ci.quantity_finished
          )), '[]'::JSONB)
          FROM factory_order_items ci
          JOIN product_skus sk ON sk.id = ci.sku_id
          WHERE ci.factory_order_id = c.id
        )
      )), '[]'::JSONB)
      FROM factory_orders c
      JOIN suppliers s ON s.id = c.supplier_id
      WHERE c.parent_factory_order_id = p_factory_order_id
    )
  );
END;
$$;


ALTER FUNCTION public.rpc_factory_order_component_status(p_factory_order_id uuid) OWNER TO postgres;

--
-- Name: rpc_factory_order_component_status_batch(uuid[]); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.rpc_factory_order_component_status_batch(p_parent_order_ids uuid[]) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_is_internal BOOLEAN;
  v_supplier_scope UUID[];
  v_visible UUID[];
  v_result JSONB := '{}'::JSONB;
  v_parent_id UUID;
BEGIN
  IF p_parent_order_ids IS NULL OR cardinality(p_parent_order_ids) = 0 THEN
    RETURN '{}'::JSONB;
  END IF;

  v_is_internal := jwt_is_internal();
  IF v_is_internal THEN
    v_visible := p_parent_order_ids;
  ELSE
    v_supplier_scope := jwt_supplier_scope();
    SELECT array_agg(fo.id)
      INTO v_visible
      FROM factory_orders fo
     WHERE fo.id = ANY(p_parent_order_ids)
       AND fo.supplier_id = ANY(v_supplier_scope);
    IF v_visible IS NULL THEN
      RETURN '{}'::JSONB;
    END IF;
  END IF;

  FOREACH v_parent_id IN ARRAY v_visible LOOP
    v_result := v_result || jsonb_build_object(
      v_parent_id::TEXT,
      jsonb_build_object(
        'expected_components', (
          SELECT COALESCE(jsonb_agg(jsonb_build_object(
            'component_sku_id', t.component_sku_id,
            'component_sku',    t.sku,
            'quantity_needed',  t.quantity_needed
          )), '[]'::JSONB)
          FROM (
            SELECT b.component_sku_id,
                   sk.sku,
                   SUM(foi.quantity_ordered * b.units_per_parent)::INTEGER AS quantity_needed
              FROM factory_order_items foi
              JOIN product_boms b
                ON b.parent_sku_id = foi.sku_id
               AND b.component_type = 'produced'
               AND b.effective_until IS NULL
              JOIN product_skus sk ON sk.id = b.component_sku_id
             WHERE foi.factory_order_id = v_parent_id
             GROUP BY b.component_sku_id, sk.sku
          ) t
        ),
        'child_orders', (
          SELECT COALESCE(jsonb_agg(jsonb_build_object(
            'id',                  c.id,
            'order_number',        c.order_number,
            'supplier_id',         c.supplier_id,
            'supplier_code',       s.code,
            'supplier_name',       s.name,
            'status',              c.status,
            'order_date',          c.order_date,
            'expected_completion', c.expected_completion,
            'components', (
              SELECT COALESCE(jsonb_agg(jsonb_build_object(
                'sku_id',            ci.sku_id,
                'sku',               sk.sku,
                'quantity_ordered',  ci.quantity_ordered,
                'quantity_finished', ci.quantity_finished
              )), '[]'::JSONB)
              FROM factory_order_items ci
              JOIN product_skus sk ON sk.id = ci.sku_id
              WHERE ci.factory_order_id = c.id
            )
          )), '[]'::JSONB)
          FROM factory_orders c
          JOIN suppliers s ON s.id = c.supplier_id
          WHERE c.parent_factory_order_id = v_parent_id
        )
      )
    );
  END LOOP;

  RETURN v_result;
END;
$$;


ALTER FUNCTION public.rpc_factory_order_component_status_batch(p_parent_order_ids uuid[]) OWNER TO postgres;

--
-- Name: rpc_file_component_breakage_report(uuid, integer, text, text); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.rpc_file_component_breakage_report(p_factory_order_item_id uuid, p_quantity_broken integer, p_reason_category text, p_description text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_caller_supplier_id UUID := jwt_supplier_id();
  v_foi factory_order_items%ROWTYPE;
  v_order factory_orders%ROWTYPE;
  v_report_id UUID;
BEGIN
  IF v_caller_supplier_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'not_a_supplier'); END IF;
  IF p_quantity_broken IS NULL OR p_quantity_broken <= 0 THEN RETURN jsonb_build_object('ok', false, 'error', 'invalid_quantity'); END IF;
  IF p_description IS NULL OR length(trim(p_description)) = 0 THEN RETURN jsonb_build_object('ok', false, 'error', 'description_required'); END IF;
  SELECT * INTO v_foi FROM factory_order_items WHERE id = p_factory_order_item_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'item_not_found'); END IF;
  SELECT * INTO v_order FROM factory_orders WHERE id = v_foi.factory_order_id;
  IF NOT EXISTS (SELECT 1 FROM suppliers WHERE id = v_caller_supplier_id AND v_order.supplier_id = ANY(consolidates_for)) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_consolidator_for_producer');
  END IF;
  INSERT INTO component_breakage_reports (factory_order_item_id, producing_supplier_id, reporter_supplier_id,
    sku_id, quantity_broken, reason_category, description, status, created_by)
  VALUES (p_factory_order_item_id, v_order.supplier_id, v_caller_supplier_id, v_foi.sku_id,
          p_quantity_broken, p_reason_category, p_description, 'open', auth.uid()) RETURNING id INTO v_report_id;
  INSERT INTO audit_logs (actor_id, action, target_table, target_id, details)
  VALUES (auth.uid(), 'breakage_report.create', 'component_breakage_reports', v_report_id,
          jsonb_build_object('factory_order_item_id', p_factory_order_item_id, 'quantity_broken', p_quantity_broken, 'reason_category', p_reason_category));
  RETURN jsonb_build_object('ok', true, 'breakage_report_id', v_report_id);
END;
$$;


ALTER FUNCTION public.rpc_file_component_breakage_report(p_factory_order_item_id uuid, p_quantity_broken integer, p_reason_category text, p_description text) OWNER TO postgres;

--
-- Name: rpc_log_task_completion(uuid, text, integer, text, uuid, timestamp with time zone, timestamp with time zone, uuid); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.rpc_log_task_completion(p_sku_id uuid, p_task_type text, p_quantity integer, p_notes text, p_actor_id uuid, p_time_started timestamp with time zone DEFAULT NULL::timestamp with time zone, p_time_completed timestamp with time zone DEFAULT now(), p_location_id uuid DEFAULT NULL::uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
DECLARE
  v_sku product_skus%ROWTYPE;
  v_move RECORD;
  v_task_log_id UUID;
  v_available INTEGER;
  v_location_id UUID;
BEGIN
  v_location_id := COALESCE(p_location_id, _default_location_id());

  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'quantity must be positive');
  END IF;

  SELECT * INTO v_sku FROM product_skus WHERE id = p_sku_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'sku not found');
  END IF;
  IF v_sku.archived_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'sku is archived');
  END IF;

  SELECT * INTO v_move FROM _task_type_movement(p_task_type);

  PERFORM 1 FROM inventory_levels
    WHERE sku_id = p_sku_id AND location_id = v_location_id FOR UPDATE;

  -- --------------------------------------------------------------
  -- Protected section: any exception here causes the subtransaction
  -- to roll back — including the task_logs + inventory_transactions
  -- inserts below. The outer caller receives a structured envelope.
  -- --------------------------------------------------------------
  BEGIN
    IF v_move.from_field IS NOT NULL THEN
      EXECUTE format(
        'SELECT %I FROM inventory_levels WHERE sku_id = $1 AND location_id = $2',
        v_move.from_field
      ) INTO v_available USING p_sku_id, v_location_id;

      IF v_available IS NULL OR v_available < p_quantity THEN
        RETURN jsonb_build_object(
          'ok', false,
          'error', 'insufficient_source_stock',
          'available', COALESCE(v_available, 0),
          'requested', p_quantity,
          'location_id', v_location_id
        );
      END IF;

      IF v_move.to_field IS NOT NULL THEN
        EXECUTE format(
          'UPDATE inventory_levels SET %I = %I - $1, %I = %I + $1 WHERE sku_id = $2 AND location_id = $3',
          v_move.from_field, v_move.from_field,
          v_move.to_field, v_move.to_field
        ) USING p_quantity, p_sku_id, v_location_id;
      ELSE
        EXECUTE format(
          'UPDATE inventory_levels SET %I = %I - $1 WHERE sku_id = $2 AND location_id = $3',
          v_move.from_field, v_move.from_field
        ) USING p_quantity, p_sku_id, v_location_id;
      END IF;
    END IF;

    INSERT INTO task_logs (
      employee_id, sku_id, task_type, quantity_processed,
      time_started, time_completed, notes
    ) VALUES (
      p_actor_id, p_sku_id, p_task_type, p_quantity,
      p_time_started, p_time_completed, p_notes
    ) RETURNING id INTO v_task_log_id;

    INSERT INTO inventory_transactions (
      sku_id, transaction_type, quantity, field_affected,
      movement_kind, from_field, to_field,
      reference_id, reference_type, notes, performed_by
    ) VALUES (
      p_sku_id, 'task_logged', p_quantity,
      COALESCE(v_move.to_field, v_move.from_field, 'warehouse_in_production'),
      CASE
        WHEN v_move.from_field IS NULL THEN 'metadata'
        WHEN v_move.to_field IS NULL THEN 'write_off'
        ELSE 'category_move'
      END,
      v_move.from_field, v_move.to_field,
      v_task_log_id, 'task_log',
      format('%s: %s of %s units%s',
        v_sku.sku, replace(p_task_type, '_', ' '), p_quantity,
        CASE WHEN p_notes IS NOT NULL THEN ' — ' || p_notes ELSE '' END),
      p_actor_id
    );

    RETURN jsonb_build_object('ok', true, 'task_log_id', v_task_log_id);

  EXCEPTION WHEN OTHERS THEN
    -- All work in this BEGIN block has been rolled back. Emit a
    -- structured envelope with enough context to diagnose without
    -- surfacing raw SQL to the end user.
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'internal_error',
      'sqlstate', SQLSTATE,
      'message', SQLERRM
    );
  END;
END;
$_$;


ALTER FUNCTION public.rpc_log_task_completion(p_sku_id uuid, p_task_type text, p_quantity integer, p_notes text, p_actor_id uuid, p_time_started timestamp with time zone, p_time_completed timestamp with time zone, p_location_id uuid) OWNER TO postgres;

--
-- Name: rpc_promote_user_to_supplier(uuid, uuid); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.rpc_promote_user_to_supplier(p_target_user_id uuid, p_supplier_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_actor_role TEXT;
  v_target profiles%ROWTYPE;
BEGIN
  SELECT role INTO v_actor_role FROM profiles WHERE id = auth.uid();
  IF v_actor_role IS DISTINCT FROM 'admin' THEN RETURN jsonb_build_object('ok', false, 'error', 'admin_only'); END IF;
  IF NOT EXISTS (SELECT 1 FROM suppliers WHERE id = p_supplier_id) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'supplier_not_found');
  END IF;
  SELECT * INTO v_target FROM profiles WHERE id = p_target_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'user_not_found'); END IF;
  IF v_target.role = 'supplier' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'already_supplier', 'current_supplier_id', v_target.supplier_id);
  END IF;
  IF EXISTS (SELECT 1 FROM profiles WHERE supplier_id = p_supplier_id AND role = 'supplier' AND is_active = true) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'supplier_already_has_active_user');
  END IF;
  UPDATE profiles SET role = 'supplier', supplier_id = p_supplier_id WHERE id = p_target_user_id;
  INSERT INTO audit_logs (actor_id, action, target_table, target_id, details)
  VALUES (auth.uid(), 'profile.promote_to_supplier', 'profiles', p_target_user_id,
          jsonb_build_object('supplier_id', p_supplier_id, 'previous_role', v_target.role));
  RETURN jsonb_build_object('ok', true, 'supplier_id', p_supplier_id);
END;
$$;


ALTER FUNCTION public.rpc_promote_user_to_supplier(p_target_user_id uuid, p_supplier_id uuid) OWNER TO postgres;

--
-- Name: rpc_resolve_breakage_report(uuid, text, uuid, boolean); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.rpc_resolve_breakage_report(p_report_id uuid, p_resolution_notes text, p_replacement_factory_order_id uuid DEFAULT NULL::uuid, p_write_off boolean DEFAULT false) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_row component_breakage_reports%ROWTYPE;
  v_final_status TEXT;
BEGIN
  IF NOT jwt_is_internal() THEN RETURN jsonb_build_object('ok', false, 'error', 'internal_only'); END IF;
  IF p_resolution_notes IS NULL OR length(trim(p_resolution_notes)) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'resolution_notes_required');
  END IF;
  SELECT * INTO v_row FROM component_breakage_reports WHERE id = p_report_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found'); END IF;
  IF v_row.status NOT IN ('open', 'acknowledged', 'disputed') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_transition', 'current_status', v_row.status);
  END IF;
  v_final_status := CASE WHEN p_write_off THEN 'written_off' ELSE 'resolved' END;
  UPDATE component_breakage_reports SET status = v_final_status, resolved_at = now(), resolved_by = auth.uid(),
    resolution_notes = p_resolution_notes,
    replacement_requested = CASE WHEN p_replacement_factory_order_id IS NOT NULL THEN true ELSE replacement_requested END,
    replacement_factory_order_id = COALESCE(p_replacement_factory_order_id, replacement_factory_order_id),
    acknowledged_at = COALESCE(acknowledged_at, now()), acknowledged_by = COALESCE(acknowledged_by, auth.uid())
   WHERE id = p_report_id;
  INSERT INTO audit_logs (actor_id, action, target_table, target_id, details)
  VALUES (auth.uid(), 'breakage_report.resolve', 'component_breakage_reports', p_report_id,
          jsonb_build_object('final_status', v_final_status, 'replacement_factory_order_id', p_replacement_factory_order_id));
  RETURN jsonb_build_object('ok', true, 'final_status', v_final_status);
END;
$$;


ALTER FUNCTION public.rpc_resolve_breakage_report(p_report_id uuid, p_resolution_notes text, p_replacement_factory_order_id uuid, p_write_off boolean) OWNER TO postgres;

--
-- Name: rpc_resolve_shipment_variance(uuid, text, boolean); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.rpc_resolve_shipment_variance(p_variance_id uuid, p_resolution_notes text, p_write_off boolean DEFAULT false) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_row shipment_variances%ROWTYPE;
  v_final_status TEXT;
BEGIN
  IF NOT jwt_is_internal() THEN RETURN jsonb_build_object('ok', false, 'error', 'internal_only'); END IF;
  IF p_resolution_notes IS NULL OR length(trim(p_resolution_notes)) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'resolution_notes_required');
  END IF;
  SELECT * INTO v_row FROM shipment_variances WHERE id = p_variance_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found'); END IF;
  IF v_row.status NOT IN ('open', 'acknowledged') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_transition', 'current_status', v_row.status);
  END IF;
  v_final_status := CASE WHEN p_write_off THEN 'written_off' ELSE 'resolved' END;
  UPDATE shipment_variances SET status = v_final_status, resolved_at = now(), resolved_by = auth.uid(),
    resolution_notes = p_resolution_notes,
    acknowledged_at = COALESCE(acknowledged_at, now()), acknowledged_by = COALESCE(acknowledged_by, auth.uid())
   WHERE id = p_variance_id;
  INSERT INTO audit_logs (actor_id, action, target_table, target_id, details)
  VALUES (auth.uid(), 'shipment_variance.resolve', 'shipment_variances', p_variance_id, jsonb_build_object('final_status', v_final_status));
  RETURN jsonb_build_object('ok', true, 'final_status', v_final_status);
END;
$$;


ALTER FUNCTION public.rpc_resolve_shipment_variance(p_variance_id uuid, p_resolution_notes text, p_write_off boolean) OWNER TO postgres;

--
-- Name: rpc_set_profile_active(uuid, boolean); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.rpc_set_profile_active(p_target_user_id uuid, p_is_active boolean) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_actor_role TEXT;
BEGIN
  SELECT role INTO v_actor_role FROM profiles WHERE id = auth.uid();
  IF v_actor_role IS DISTINCT FROM 'admin' THEN RETURN jsonb_build_object('ok', false, 'error', 'admin_only'); END IF;
  IF p_target_user_id = auth.uid() AND p_is_active = false THEN
    RETURN jsonb_build_object('ok', false, 'error', 'cannot_deactivate_self');
  END IF;
  UPDATE profiles SET is_active = p_is_active WHERE id = p_target_user_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'user_not_found'); END IF;
  INSERT INTO audit_logs (actor_id, action, target_table, target_id, details)
  VALUES (auth.uid(), CASE WHEN p_is_active THEN 'profile.reactivate' ELSE 'profile.deactivate' END,
          'profiles', p_target_user_id, '{}'::JSONB);
  RETURN jsonb_build_object('ok', true, 'is_active', p_is_active);
END;
$$;


ALTER FUNCTION public.rpc_set_profile_active(p_target_user_id uuid, p_is_active boolean) OWNER TO postgres;

--
-- Name: rpc_supplier_advance_factory_order(uuid, integer, text); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.rpc_supplier_advance_factory_order(p_factory_order_id uuid, p_expected_version integer, p_notes text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_supplier_id UUID := jwt_supplier_id();
  v_row factory_orders%ROWTYPE;
  v_next_status TEXT;
BEGIN
  IF v_supplier_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_a_supplier');
  END IF;
  SELECT * INTO v_row FROM factory_orders WHERE id = p_factory_order_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found'); END IF;
  IF v_row.supplier_id != v_supplier_id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_your_order');
  END IF;
  IF v_row.row_version != p_expected_version THEN
    RETURN jsonb_build_object('ok', false, 'error', 'version_conflict', 'current_version', v_row.row_version);
  END IF;
  v_next_status := CASE v_row.status WHEN 'ordered' THEN 'in_production' WHEN 'in_production' THEN 'finished' ELSE NULL END;
  IF v_next_status IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_transition', 'current_status', v_row.status);
  END IF;
  UPDATE factory_orders SET status = v_next_status WHERE id = p_factory_order_id;
  INSERT INTO audit_logs (actor_id, action, target_table, target_id, details)
  VALUES (auth.uid(), 'factory_order.advance', 'factory_orders', p_factory_order_id,
          jsonb_build_object('from', v_row.status, 'to', v_next_status, 'notes', p_notes));
  RETURN jsonb_build_object('ok', true, 'new_status', v_next_status);
END;
$$;


ALTER FUNCTION public.rpc_supplier_advance_factory_order(p_factory_order_id uuid, p_expected_version integer, p_notes text) OWNER TO postgres;

--
-- Name: rpc_supplier_cancel_factory_order(uuid, integer, text); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.rpc_supplier_cancel_factory_order(p_factory_order_id uuid, p_expected_version integer, p_reason text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_supplier_id UUID := jwt_supplier_id();
  v_row factory_orders%ROWTYPE;
BEGIN
  IF v_supplier_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'not_a_supplier'); END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'reason_required');
  END IF;
  SELECT * INTO v_row FROM factory_orders WHERE id = p_factory_order_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found'); END IF;
  IF v_row.supplier_id != v_supplier_id AND NOT (v_row.supplier_id = ANY(jwt_supplier_scope())) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_your_order');
  END IF;
  IF v_row.row_version != p_expected_version THEN
    RETURN jsonb_build_object('ok', false, 'error', 'version_conflict', 'current_version', v_row.row_version);
  END IF;
  IF v_row.status NOT IN ('ordered', 'in_production') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_cancelable', 'current_status', v_row.status);
  END IF;
  UPDATE factory_orders SET status = 'canceled', canceled_at = now(),
    canceled_by = auth.uid(), canceled_reason = p_reason WHERE id = p_factory_order_id;
  INSERT INTO audit_logs (actor_id, action, target_table, target_id, details)
  VALUES (auth.uid(), 'factory_order.cancel', 'factory_orders', p_factory_order_id,
          jsonb_build_object('from_status', v_row.status, 'reason', p_reason));
  RETURN jsonb_build_object('ok', true);
END;
$$;


ALTER FUNCTION public.rpc_supplier_cancel_factory_order(p_factory_order_id uuid, p_expected_version integer, p_reason text) OWNER TO postgres;

--
-- Name: rpc_supplier_create_factory_order(jsonb); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.rpc_supplier_create_factory_order(p_payload jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_supplier_id UUID := jwt_supplier_id();
  v_idempotency_key UUID := (p_payload->>'idempotency_key')::UUID;
  v_order_date DATE := CURRENT_DATE;
  v_expected_completion DATE := (p_payload->>'expected_completion')::DATE;
  v_order_id UUID;
  v_existing_order_id UUID;
  v_item JSONB;
  v_item_count INTEGER := 0;
  v_alt_eta DATE;
  v_order_number TEXT;
BEGIN
  IF v_supplier_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_a_supplier');
  END IF;

  IF v_idempotency_key IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_idempotency_key');
  END IF;

  SELECT id INTO v_existing_order_id
    FROM factory_orders
   WHERE supplier_id = v_supplier_id
     AND idempotency_key = v_idempotency_key;
  IF v_existing_order_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'factory_order_id', v_existing_order_id, 'replayed', true);
  END IF;

  IF jsonb_array_length(p_payload->'items') = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'no_items');
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_payload->'items') LOOP
    v_alt_eta := NULLIF(v_item->>'alternate_expected_completion', '')::DATE;
    IF v_alt_eta IS NOT NULL AND v_alt_eta < v_order_date THEN
      RETURN jsonb_build_object(
        'ok', false,
        'error', 'alt_eta_before_order_date',
        'sku_id', v_item->>'sku_id',
        'alternate_expected_completion', v_alt_eta
      );
    END IF;
  END LOOP;

  v_order_number := NULLIF(trim(p_payload->>'order_number'), '');

  INSERT INTO factory_orders (
    supplier_id, order_date, expected_completion, status, notes,
    idempotency_key, order_number
  )
  VALUES (
    v_supplier_id,
    v_order_date,
    v_expected_completion,
    'ordered',
    p_payload->>'notes',
    v_idempotency_key,
    v_order_number
  )
  RETURNING id INTO v_order_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_payload->'items') LOOP
    v_alt_eta := NULLIF(v_item->>'alternate_expected_completion', '')::DATE;
    INSERT INTO factory_order_items (
      factory_order_id,
      sku_id,
      quantity_ordered,
      alternate_expected_completion
    ) VALUES (
      v_order_id,
      (v_item->>'sku_id')::UUID,
      (v_item->>'quantity')::INTEGER,
      v_alt_eta
    );
    v_item_count := v_item_count + 1;
  END LOOP;

  INSERT INTO audit_logs (actor_id, action, target_table, target_id, details)
  VALUES (
    auth.uid(),
    'factory_order.create',
    'factory_orders',
    v_order_id,
    jsonb_build_object(
      'supplier_id', v_supplier_id,
      'item_count', v_item_count,
      'order_number', v_order_number
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'factory_order_id', v_order_id,
    'item_count', v_item_count,
    'order_number', v_order_number
  );
END;
$$;


ALTER FUNCTION public.rpc_supplier_create_factory_order(p_payload jsonb) OWNER TO postgres;

--
-- Name: rpc_supplier_create_freight_shipment(jsonb); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.rpc_supplier_create_freight_shipment(p_payload jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_supplier_id UUID := jwt_supplier_id();
  v_supplier suppliers%ROWTYPE;
  v_idempotency_key UUID := (p_payload->>'idempotency_key')::UUID;
  v_shipment_id UUID;
  v_existing_id UUID;
  v_shipment_number TEXT;
  v_freight_type TEXT;
  v_ship_date DATE;
  v_freight_cost NUMERIC;
  v_tracking TEXT;
  v_carrier TEXT;
  v_initial_status TEXT;
  v_line JSONB;
  v_line_count INTEGER := 0;
  v_source_foi UUID;
  v_qty INTEGER;
  v_qty_prefilled INTEGER;
BEGIN
  IF v_supplier_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_a_supplier');
  END IF;

  IF v_idempotency_key IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_idempotency_key');
  END IF;

  SELECT * INTO v_supplier FROM suppliers WHERE id = v_supplier_id;
  IF NOT FOUND OR NOT v_supplier.is_export_broker THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_authorized_as_broker');
  END IF;

  SELECT id INTO v_existing_id
    FROM freight_shipments
   WHERE origin_supplier_id = v_supplier_id
     AND idempotency_key = v_idempotency_key;
  IF v_existing_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'shipment_id', v_existing_id, 'replayed', true);
  END IF;

  IF jsonb_array_length(p_payload->'lines') = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'no_lines');
  END IF;

  v_shipment_number := NULLIF(trim(p_payload->>'shipment_number'), '');
  IF v_shipment_number IS NULL THEN
    v_shipment_number := v_supplier.code
      || '-'
      || to_char((now() at time zone 'utc')::DATE, 'YYYYMMDD')
      || '-'
      || substring(v_idempotency_key::text, 1, 8);
  END IF;

  v_freight_type := COALESCE(NULLIF(trim(p_payload->>'freight_type'), ''), 'sea');
  IF v_freight_type NOT IN ('sea', 'air') THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'invalid_freight_type',
      'freight_type', v_freight_type
    );
  END IF;

  v_ship_date := NULLIF(p_payload->>'ship_date', '')::DATE;

  v_freight_cost := COALESCE((p_payload->>'freight_cost')::NUMERIC, 0);
  IF v_freight_cost < 0 THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'invalid_freight_cost',
      'freight_cost', v_freight_cost
    );
  END IF;

  -- Auto-promote: tracking + carrier at creation time means the
  -- shipment is already on the water, per migration 035 state machine.
  v_tracking := NULLIF(p_payload->>'tracking_number', '');
  v_carrier := NULLIF(p_payload->>'carrier', '');
  IF v_tracking IS NOT NULL AND v_carrier IS NOT NULL THEN
    v_initial_status := 'on_the_water';
  ELSE
    v_initial_status := 'pending';
  END IF;

  INSERT INTO freight_shipments (
    origin_supplier_id,
    created_by_supplier_user_id,
    idempotency_key,
    shipment_number,
    freight_type,
    tracking_number,
    carrier_name,
    status,
    ship_date,
    eta,
    eta_original,
    total_cartons,
    freight_cost,
    insurance_cost,
    duties_cost,
    total_cost
  ) VALUES (
    v_supplier_id,
    auth.uid(),
    v_idempotency_key,
    v_shipment_number,
    v_freight_type,
    v_tracking,
    v_carrier,
    v_initial_status,
    v_ship_date,
    NULLIF(p_payload->>'eta', '')::DATE,
    NULLIF(p_payload->>'eta', '')::DATE,
    COALESCE((p_payload->>'total_cartons')::INTEGER, 0),
    v_freight_cost,
    0,
    0,
    v_freight_cost
  ) RETURNING id INTO v_shipment_id;

  FOR v_line IN SELECT * FROM jsonb_array_elements(p_payload->'lines') LOOP
    v_source_foi := NULLIF(v_line->>'source_factory_order_item_id', '')::UUID;
    v_qty := (v_line->>'supplier_declared_quantity')::INTEGER;
    v_qty_prefilled := NULLIF(v_line->>'quantity_prefilled', '')::INTEGER;

    IF v_qty_prefilled IS NOT NULL AND (v_qty_prefilled < 0 OR v_qty_prefilled > v_qty) THEN
      RETURN jsonb_build_object(
        'ok', false,
        'error', 'invalid_prefilled_quantity',
        'sku_id', v_line->>'sku_id',
        'quantity', v_qty,
        'quantity_prefilled', v_qty_prefilled
      );
    END IF;

    IF v_source_foi IS NOT NULL THEN
      IF NOT EXISTS (
        SELECT 1 FROM factory_order_items foi
        JOIN factory_orders fo ON fo.id = foi.factory_order_id
        WHERE foi.id = v_source_foi
          AND (fo.supplier_id = ANY(jwt_supplier_scope())
               OR fo.ship_via_supplier_id = ANY(jwt_supplier_scope()))
      ) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'invalid_source_foi',
                                  'source_factory_order_item_id', v_source_foi);
      END IF;
    END IF;

    INSERT INTO freight_line_items (
      freight_shipment_id,
      sku_id,
      quantity,
      supplier_declared_quantity,
      source_factory_order_item_id,
      unit_cost,
      quantity_prefilled
    ) VALUES (
      v_shipment_id,
      (v_line->>'sku_id')::UUID,
      v_qty,
      v_qty,
      v_source_foi,
      0,
      v_qty_prefilled
    );
    v_line_count := v_line_count + 1;
  END LOOP;

  INSERT INTO audit_logs (actor_id, action, target_table, target_id, details)
  VALUES (
    auth.uid(),
    'freight_shipment.create',
    'freight_shipments',
    v_shipment_id,
    jsonb_build_object(
      'origin_supplier_id', v_supplier_id,
      'shipment_number', v_shipment_number,
      'freight_type', v_freight_type,
      'freight_cost', v_freight_cost,
      'initial_status', v_initial_status,
      'line_count', v_line_count
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'shipment_id', v_shipment_id,
    'shipment_number', v_shipment_number,
    'status', v_initial_status,
    'line_count', v_line_count
  );
END;
$$;


ALTER FUNCTION public.rpc_supplier_create_freight_shipment(p_payload jsonb) OWNER TO postgres;

--
-- Name: rpc_supplier_report_item_finished(uuid, integer, integer); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.rpc_supplier_report_item_finished(p_factory_order_item_id uuid, p_quantity_finished integer, p_expected_version integer) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_supplier_id UUID := jwt_supplier_id();
  v_item factory_order_items%ROWTYPE;
  v_order factory_orders%ROWTYPE;
  v_shipped INTEGER;
  v_prev_finished INTEGER;
  v_new_status TEXT;
  v_all_finished BOOLEAN;
BEGIN
  IF v_supplier_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_a_supplier');
  END IF;

  IF p_quantity_finished IS NULL OR p_quantity_finished < 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_quantity');
  END IF;

  -- Fetch + lock the item and its parent order. Locks in this order (item
  -- then order) match the surrounding RPCs — keeping lock order stable
  -- avoids cross-RPC deadlocks.
  SELECT * INTO v_item
    FROM factory_order_items
   WHERE id = p_factory_order_item_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'item_not_found');
  END IF;

  SELECT * INTO v_order
    FROM factory_orders
   WHERE id = v_item.factory_order_id
   FOR UPDATE;
  IF NOT FOUND THEN
    -- Can't happen with the FK but defensive.
    RETURN jsonb_build_object('ok', false, 'error', 'order_not_found');
  END IF;

  IF v_order.supplier_id != v_supplier_id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_your_order');
  END IF;

  IF v_order.row_version != p_expected_version THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'version_conflict',
      'current_version', v_order.row_version
    );
  END IF;

  IF v_order.status NOT IN ('ordered', 'in_production') THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'order_not_editable',
      'current_status', v_order.status
    );
  END IF;

  IF p_quantity_finished > v_item.quantity_ordered THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'exceeds_ordered',
      'quantity_ordered', v_item.quantity_ordered
    );
  END IF;

  -- Can't drop below the shipped count — those units are already out the
  -- door, claiming they aren't finished would be nonsensical.
  SELECT COALESCE(SUM(quantity), 0) INTO v_shipped
    FROM freight_line_items
   WHERE source_factory_order_item_id = p_factory_order_item_id;

  IF p_quantity_finished < v_shipped THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'cannot_reduce_below_shipped',
      'already_shipped', v_shipped
    );
  END IF;

  v_prev_finished := v_item.quantity_finished;

  -- Apply the update.
  UPDATE factory_order_items
     SET quantity_finished = p_quantity_finished
   WHERE id = p_factory_order_item_id;

  -- Auto-advance order status based on the aggregate. Two rules:
  --   ordered → in_production: any item with non-zero quantity_finished.
  --   in_production → finished: every item fully finished (or breakage
  --     accounts for the gap, mirroring orderFullyShipped logic on the UI).
  v_new_status := v_order.status;

  IF v_order.status = 'ordered' AND p_quantity_finished > 0 THEN
    v_new_status := 'in_production';
  END IF;

  SELECT NOT EXISTS (
    SELECT 1 FROM factory_order_items
     WHERE factory_order_id = v_order.id
       AND COALESCE(quantity_finished, 0) + COALESCE(quantity_breakage, 0)
           < quantity_ordered
  ) INTO v_all_finished;

  IF v_all_finished THEN
    v_new_status := 'finished';
  END IF;

  IF v_new_status != v_order.status THEN
    UPDATE factory_orders
       SET status = v_new_status
     WHERE id = v_order.id;
  ELSE
    -- No status change but bump row_version anyway so concurrent readers
    -- see the item update reflected in their cache-busting key.
    UPDATE factory_orders
       SET row_version = row_version + 1
     WHERE id = v_order.id;
  END IF;

  INSERT INTO audit_logs (actor_id, action, target_table, target_id, details)
  VALUES (
    auth.uid(),
    'factory_order_item.report_finished',
    'factory_order_items',
    p_factory_order_item_id,
    jsonb_build_object(
      'factory_order_id', v_order.id,
      'previous_quantity_finished', v_prev_finished,
      'new_quantity_finished', p_quantity_finished,
      'previous_status', v_order.status,
      'new_status', v_new_status
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'quantity_finished', p_quantity_finished,
    'order_status', v_new_status
  );
END;
$$;


ALTER FUNCTION public.rpc_supplier_report_item_finished(p_factory_order_item_id uuid, p_quantity_finished integer, p_expected_version integer) OWNER TO postgres;

--
-- Name: rpc_supplier_set_item_alternate_eta(uuid, date, integer); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.rpc_supplier_set_item_alternate_eta(p_factory_order_item_id uuid, p_alternate_eta date, p_expected_version integer) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_supplier_id UUID := jwt_supplier_id();
  v_item factory_order_items%ROWTYPE;
  v_order factory_orders%ROWTYPE;
BEGIN
  IF v_supplier_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_a_supplier');
  END IF;

  SELECT * INTO v_item
    FROM factory_order_items
   WHERE id = p_factory_order_item_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'item_not_found');
  END IF;

  SELECT * INTO v_order
    FROM factory_orders
   WHERE id = v_item.factory_order_id
   FOR UPDATE;
  IF NOT FOUND THEN
    -- Can't happen with FK but defensive.
    RETURN jsonb_build_object('ok', false, 'error', 'order_not_found');
  END IF;

  -- Must own the parent order. Consolidators shouldn't be editing the
  -- producer's item-level ETAs; that's the producer's call. If a
  -- consolidator needs to override, we'd add a separate RPC.
  IF v_order.supplier_id != v_supplier_id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_your_order');
  END IF;

  IF v_order.row_version != p_expected_version THEN
    RETURN jsonb_build_object(
      'ok', false, 'error', 'version_conflict',
      'current_version', v_order.row_version
    );
  END IF;

  IF v_order.status NOT IN ('ordered', 'in_production') THEN
    RETURN jsonb_build_object(
      'ok', false, 'error', 'order_not_editable',
      'current_status', v_order.status
    );
  END IF;

  -- Optional sanity: alt ETA should be >= order_date. Let NULL past the check.
  IF p_alternate_eta IS NOT NULL AND p_alternate_eta < v_order.order_date THEN
    RETURN jsonb_build_object('ok', false, 'error', 'alt_eta_before_order_date');
  END IF;

  UPDATE factory_order_items
     SET alternate_expected_completion = p_alternate_eta
   WHERE id = p_factory_order_item_id;

  -- Bump parent order's row_version so other callers notice the change.
  -- We don't update order.updated_at explicitly â the set_updated_at
  -- trigger on factory_orders fires on UPDATE of any column, so the
  -- row_version bump below is sufficient and also triggers updated_at.
  UPDATE factory_orders
     SET row_version = row_version + 1
   WHERE id = v_order.id;

  INSERT INTO audit_logs (actor_id, action, target_table, target_id, details)
  VALUES (
    auth.uid(),
    'factory_order_item.set_alt_eta',
    'factory_order_items',
    p_factory_order_item_id,
    jsonb_build_object(
      'factory_order_id', v_order.id,
      'previous_alt_eta', v_item.alternate_expected_completion,
      'new_alt_eta', p_alternate_eta
    )
  );

  RETURN jsonb_build_object('ok', true);
END;
$$;


ALTER FUNCTION public.rpc_supplier_set_item_alternate_eta(p_factory_order_item_id uuid, p_alternate_eta date, p_expected_version integer) OWNER TO postgres;

--
-- Name: rpc_supplier_update_shipment_tracking(uuid, integer, text, text, date, date, numeric, boolean, boolean, boolean, boolean, boolean); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.rpc_supplier_update_shipment_tracking(p_shipment_id uuid, p_expected_version integer, p_tracking_number text DEFAULT NULL::text, p_carrier text DEFAULT NULL::text, p_eta date DEFAULT NULL::date, p_ship_date date DEFAULT NULL::date, p_freight_cost numeric DEFAULT NULL::numeric, p_clear_tracking_number boolean DEFAULT false, p_clear_carrier boolean DEFAULT false, p_clear_eta boolean DEFAULT false, p_clear_ship_date boolean DEFAULT false, p_clear_freight_cost boolean DEFAULT false) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_supplier_id UUID := jwt_supplier_id();
  v_row freight_shipments%ROWTYPE;
  v_prev_tracking TEXT;
  v_prev_carrier TEXT;
  v_prev_eta DATE;
  v_prev_ship_date DATE;
  v_prev_freight_cost NUMERIC;
  v_prev_status TEXT;
  v_final_tracking TEXT;
  v_final_carrier TEXT;
  v_new_status TEXT;
BEGIN
  IF v_supplier_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_a_supplier');
  END IF;

  SELECT * INTO v_row FROM freight_shipments WHERE id = p_shipment_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;

  IF v_row.origin_supplier_id IS DISTINCT FROM v_supplier_id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_your_shipment');
  END IF;

  IF v_row.row_version != p_expected_version THEN
    RETURN jsonb_build_object(
      'ok', false, 'error', 'version_conflict',
      'current_version', v_row.row_version
    );
  END IF;

  -- Editable while the supplier still owns the row. Once the freight
  -- has cleared customs, corrections require an admin.
  IF v_row.status NOT IN ('pending', 'on_the_water') THEN
    RETURN jsonb_build_object(
      'ok', false, 'error', 'shipment_not_editable',
      'current_status', v_row.status
    );
  END IF;

  IF p_freight_cost IS NOT NULL AND p_freight_cost < 0 THEN
    RETURN jsonb_build_object(
      'ok', false, 'error', 'invalid_freight_cost',
      'freight_cost', p_freight_cost
    );
  END IF;

  v_prev_tracking := v_row.tracking_number;
  v_prev_carrier := v_row.carrier_name;
  v_prev_eta := v_row.eta;
  v_prev_ship_date := v_row.ship_date;
  v_prev_freight_cost := v_row.freight_cost;
  v_prev_status := v_row.status;

  -- Compute post-update tracking + carrier so we can decide whether to
  -- auto-promote. Mirrors the CASE logic in the UPDATE below.
  v_final_tracking := CASE
    WHEN p_clear_tracking_number THEN NULL
    WHEN p_tracking_number IS NOT NULL THEN NULLIF(trim(p_tracking_number), '')
    ELSE v_row.tracking_number
  END;
  v_final_carrier := CASE
    WHEN p_clear_carrier THEN NULL
    WHEN p_carrier IS NOT NULL THEN NULLIF(trim(p_carrier), '')
    ELSE v_row.carrier_name
  END;

  -- pending + both tracking and carrier set -> on_the_water. Never
  -- demote: once on_the_water, clearing tracking does NOT return to
  -- pending (would be odd semantically and would bounce the reconcile
  -- loop).
  IF v_row.status = 'pending'
     AND v_final_tracking IS NOT NULL
     AND v_final_carrier IS NOT NULL THEN
    v_new_status := 'on_the_water';
  ELSE
    v_new_status := v_row.status;
  END IF;

  UPDATE freight_shipments
     SET tracking_number = v_final_tracking,
         carrier_name = v_final_carrier,
         eta = CASE
           WHEN p_clear_eta THEN NULL
           WHEN p_eta IS NOT NULL THEN p_eta
           ELSE eta
         END,
         ship_date = CASE
           WHEN p_clear_ship_date THEN NULL
           WHEN p_ship_date IS NOT NULL THEN p_ship_date
           ELSE ship_date
         END,
         freight_cost = CASE
           WHEN p_clear_freight_cost THEN 0
           WHEN p_freight_cost IS NOT NULL THEN p_freight_cost
           ELSE freight_cost
         END,
         total_cost = CASE
           WHEN p_clear_freight_cost THEN COALESCE(insurance_cost, 0) + COALESCE(duties_cost, 0)
           WHEN p_freight_cost IS NOT NULL THEN
             p_freight_cost + COALESCE(insurance_cost, 0) + COALESCE(duties_cost, 0)
           ELSE total_cost
         END,
         status = v_new_status
   WHERE id = p_shipment_id;

  INSERT INTO audit_logs (actor_id, action, target_table, target_id, details)
  VALUES (
    auth.uid(),
    'freight_shipment.update_tracking',
    'freight_shipments',
    p_shipment_id,
    jsonb_build_object(
      'prev_tracking_number', v_prev_tracking,
      'prev_carrier_name', v_prev_carrier,
      'prev_eta', v_prev_eta,
      'prev_ship_date', v_prev_ship_date,
      'prev_freight_cost', v_prev_freight_cost,
      'prev_status', v_prev_status,
      'new_status', v_new_status,
      'auto_promoted', (v_prev_status = 'pending' AND v_new_status = 'on_the_water'),
      'new_tracking_number_requested', p_tracking_number,
      'new_carrier_requested', p_carrier,
      'new_eta_requested', p_eta,
      'new_ship_date_requested', p_ship_date,
      'new_freight_cost_requested', p_freight_cost,
      'clear_flags', jsonb_build_object(
        'tracking_number', p_clear_tracking_number,
        'carrier', p_clear_carrier,
        'eta', p_clear_eta,
        'ship_date', p_clear_ship_date,
        'freight_cost', p_clear_freight_cost
      )
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'status', v_new_status,
    'promoted', (v_prev_status = 'pending' AND v_new_status = 'on_the_water')
  );
END;
$$;


ALTER FUNCTION public.rpc_supplier_update_shipment_tracking(p_shipment_id uuid, p_expected_version integer, p_tracking_number text, p_carrier text, p_eta date, p_ship_date date, p_freight_cost numeric, p_clear_tracking_number boolean, p_clear_carrier boolean, p_clear_eta boolean, p_clear_ship_date boolean, p_clear_freight_cost boolean) OWNER TO postgres;

--
-- Name: rpc_update_user_role(uuid, text, uuid); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.rpc_update_user_role(p_target_user_id uuid, p_new_role text, p_actor_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_actor profiles%ROWTYPE;
  v_target profiles%ROWTYPE;
BEGIN
  IF p_new_role NOT IN ('admin', 'manager', 'user') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid role');
  END IF;

  SELECT * INTO v_actor FROM profiles WHERE id = p_actor_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'actor not found');
  END IF;

  SELECT * INTO v_target FROM profiles WHERE id = p_target_user_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'target user not found');
  END IF;

  IF v_actor.role NOT IN ('admin', 'manager') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'only admins and managers can change roles');
  END IF;

  IF v_actor.id = v_target.id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'cannot change your own role');
  END IF;

  IF v_actor.role = 'manager' AND p_new_role = 'admin' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'managers cannot grant admin role');
  END IF;

  IF v_actor.role = 'manager' AND v_target.role = 'admin' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'managers cannot change an admin role');
  END IF;

  IF v_target.role = p_new_role THEN
    RETURN jsonb_build_object('ok', true, 'noop', true);
  END IF;

  PERFORM set_config('app.role_change_allowed', 'yes', true);
  UPDATE profiles SET role = p_new_role WHERE id = p_target_user_id;
  PERFORM set_config('app.role_change_allowed', '', true);

  INSERT INTO inventory_transactions (
    sku_id, transaction_type, quantity, field_affected,
    movement_kind, reference_id, reference_type, notes, performed_by
  ) VALUES (
    NULL, 'user_role_change', 0, 'role',
    'metadata', p_target_user_id, 'profile',
    format('%s: role changed %s → %s by %s',
      v_target.full_name, v_target.role, p_new_role, v_actor.full_name),
    p_actor_id
  );

  RETURN jsonb_build_object('ok', true, 'previous_role', v_target.role, 'new_role', p_new_role);
END;
$$;


ALTER FUNCTION public.rpc_update_user_role(p_target_user_id uuid, p_new_role text, p_actor_id uuid) OWNER TO postgres;

--
-- Name: update_updated_at(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.update_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


ALTER FUNCTION public.update_updated_at() OWNER TO postgres;

--
-- Name: validate_consolidates_for(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.validate_consolidates_for() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF array_length(NEW.consolidates_for, 1) > 0 THEN
    IF NEW.id = ANY(NEW.consolidates_for) THEN
      RAISE EXCEPTION 'supplier % cannot appear in its own consolidates_for array', NEW.id;
    END IF;
    IF EXISTS (
      SELECT 1
        FROM unnest(NEW.consolidates_for) AS sid
       WHERE sid NOT IN (SELECT id FROM suppliers)
    ) THEN
      RAISE EXCEPTION 'consolidates_for contains an id not present in suppliers';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION public.validate_consolidates_for() OWNER TO postgres;

--
-- Name: verify_audit_chain(timestamp with time zone); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.verify_audit_chain(p_start_from timestamp with time zone DEFAULT '-infinity'::timestamp with time zone) RETURNS TABLE(first_broken_id uuid, first_broken_at timestamp with time zone, message text)
    LANGUAGE plpgsql
    AS $$
DECLARE
  r RECORD;
  v_expected_prev TEXT := '0000000000000000000000000000000000000000000000000000000000000000';
  v_recomputed TEXT;
BEGIN
  IF p_start_from > '-infinity' THEN
    SELECT row_hash INTO v_expected_prev
      FROM inventory_transactions
     WHERE created_at < p_start_from
     ORDER BY created_at DESC, id DESC
     LIMIT 1;
    v_expected_prev := COALESCE(v_expected_prev, '0000000000000000000000000000000000000000000000000000000000000000');
  END IF;

  FOR r IN
    SELECT * FROM inventory_transactions
     WHERE created_at >= p_start_from
     ORDER BY created_at ASC, id ASC
  LOOP
    IF r.prev_hash != v_expected_prev THEN
      RETURN QUERY SELECT r.id, r.created_at, format('prev_hash mismatch at row %s', r.id);
      RETURN;
    END IF;
    v_recomputed := encode(extensions.digest(
      COALESCE(r.id::text, '') || '|'
      || COALESCE(r.sku_id::text, '') || '|'
      || COALESCE(r.transaction_type, '') || '|'
      || COALESCE(r.quantity::text, '') || '|'
      || COALESCE(r.field_affected, '') || '|'
      || COALESCE(r.movement_kind, '') || '|'
      || COALESCE(r.from_field, '') || '|'
      || COALESCE(r.to_field, '') || '|'
      || COALESCE(r.reference_id::text, '') || '|'
      || COALESCE(r.reference_type, '') || '|'
      || COALESCE(r.notes, '') || '|'
      || COALESCE(r.performed_by::text, '') || '|'
      || COALESCE(r.created_at::text, '') || '|'
      || r.prev_hash,
      'sha256'
    ), 'hex');
    IF v_recomputed != r.row_hash THEN
      RETURN QUERY SELECT r.id, r.created_at, format('row_hash does not match recomputation at %s', r.id);
      RETURN;
    END IF;
    v_expected_prev := r.row_hash;
  END LOOP;

  RETURN;
END;
$$;


ALTER FUNCTION public.verify_audit_chain(p_start_from timestamp with time zone) OWNER TO postgres;

--
-- Name: warn_freight_total_drift(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.warn_freight_total_drift() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_sum DECIMAL(14,4);
  v_drift DECIMAL(14,4);
BEGIN
  v_sum := COALESCE(NEW.freight_cost, 0)
         + COALESCE(NEW.insurance_cost, 0)
         + COALESCE(NEW.duties_cost, 0);
  IF NEW.total_cost > 0 THEN
    v_drift := ABS(NEW.total_cost - v_sum);
    IF v_drift > 1.0 THEN
      RAISE NOTICE 'Freight shipment % total_cost (%) drifts from component sum (%) by %',
        NEW.shipment_number, NEW.total_cost, v_sum, v_drift;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION public.warn_freight_total_drift() OWNER TO postgres;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: audit_logs; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.audit_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    actor_id uuid,
    action text NOT NULL,
    target_table text NOT NULL,
    target_id uuid NOT NULL,
    details jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT audit_logs_action_check CHECK ((length(TRIM(BOTH FROM action)) > 0)),
    CONSTRAINT audit_logs_target_table_check CHECK ((length(TRIM(BOTH FROM target_table)) > 0))
);


ALTER TABLE public.audit_logs OWNER TO postgres;

--
-- Name: component_breakage_reports; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.component_breakage_reports (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    factory_order_item_id uuid NOT NULL,
    producing_supplier_id uuid NOT NULL,
    reporter_supplier_id uuid NOT NULL,
    sku_id uuid NOT NULL,
    quantity_broken integer NOT NULL,
    reason_category text NOT NULL,
    description text NOT NULL,
    replacement_requested boolean DEFAULT false NOT NULL,
    replacement_factory_order_id uuid,
    status text DEFAULT 'open'::text NOT NULL,
    acknowledged_at timestamp with time zone,
    acknowledged_by uuid,
    resolution_notes text,
    resolved_at timestamp with time zone,
    resolved_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid NOT NULL,
    CONSTRAINT chk_breakage_ack_coherent CHECK ((((status = 'open'::text) AND (acknowledged_at IS NULL) AND (acknowledged_by IS NULL)) OR ((status <> 'open'::text) AND (acknowledged_at IS NOT NULL) AND (acknowledged_by IS NOT NULL)))),
    CONSTRAINT chk_breakage_distinct_parties CHECK ((producing_supplier_id <> reporter_supplier_id)),
    CONSTRAINT chk_breakage_replacement_coherent CHECK (((replacement_factory_order_id IS NULL) OR (replacement_requested = true))),
    CONSTRAINT chk_breakage_resolved_coherent CHECK ((((status = ANY (ARRAY['resolved'::text, 'written_off'::text])) AND (resolved_at IS NOT NULL) AND (resolved_by IS NOT NULL) AND (resolution_notes IS NOT NULL) AND (length(TRIM(BOTH FROM resolution_notes)) > 0)) OR ((status <> ALL (ARRAY['resolved'::text, 'written_off'::text])) AND (resolved_at IS NULL) AND (resolved_by IS NULL)))),
    CONSTRAINT chk_component_breakage_reports_description_max_len CHECK (((description IS NULL) OR (length(description) <= 4000))),
    CONSTRAINT chk_component_breakage_reports_resolution_notes_max_len CHECK (((resolution_notes IS NULL) OR (length(resolution_notes) <= 4000))),
    CONSTRAINT component_breakage_reports_description_check CHECK ((length(TRIM(BOTH FROM description)) > 0)),
    CONSTRAINT component_breakage_reports_quantity_broken_check CHECK ((quantity_broken > 0)),
    CONSTRAINT component_breakage_reports_reason_category_check CHECK ((reason_category = ANY (ARRAY['crushed_in_transit'::text, 'manufacturing_defect'::text, 'wet_damage'::text, 'contamination'::text, 'other'::text]))),
    CONSTRAINT component_breakage_reports_status_check CHECK ((status = ANY (ARRAY['open'::text, 'acknowledged'::text, 'disputed'::text, 'resolved'::text, 'written_off'::text])))
);


ALTER TABLE public.component_breakage_reports OWNER TO postgres;

--
-- Name: demand_overrides; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.demand_overrides (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    sku_id uuid NOT NULL,
    monthly_demand integer NOT NULL,
    reason text,
    overridden_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT demand_overrides_monthly_demand_check CHECK ((monthly_demand >= 0))
);


ALTER TABLE public.demand_overrides OWNER TO postgres;

--
-- Name: factory_order_items; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.factory_order_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    factory_order_id uuid NOT NULL,
    sku_id uuid NOT NULL,
    quantity_ordered integer NOT NULL,
    quantity_finished integer DEFAULT 0,
    unit_cost numeric(14,6) DEFAULT 0,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    row_version integer DEFAULT 1 NOT NULL,
    consolidator_confirmed_quantity integer,
    consolidator_confirmed_at timestamp with time zone,
    consolidator_confirmed_by uuid,
    quantity_breakage integer DEFAULT 0 NOT NULL,
    alternate_expected_completion date,
    CONSTRAINT chk_factory_order_items_breakage_bounds CHECK ((((consolidator_confirmed_quantity IS NULL) AND (quantity_breakage = 0)) OR ((consolidator_confirmed_quantity IS NOT NULL) AND (quantity_breakage <= consolidator_confirmed_quantity)))),
    CONSTRAINT chk_factory_order_items_confirm_coherent CHECK ((((consolidator_confirmed_quantity IS NULL) AND (consolidator_confirmed_at IS NULL) AND (consolidator_confirmed_by IS NULL)) OR ((consolidator_confirmed_quantity IS NOT NULL) AND (consolidator_confirmed_at IS NOT NULL) AND (consolidator_confirmed_by IS NOT NULL)))),
    CONSTRAINT chk_fo_item_cost_nonneg CHECK ((unit_cost >= (0)::numeric)),
    CONSTRAINT chk_fo_item_finished_bounded CHECK (((quantity_finished >= 0) AND (quantity_finished <= quantity_ordered))),
    CONSTRAINT chk_fo_item_ordered_positive CHECK ((quantity_ordered > 0)),
    CONSTRAINT factory_order_items_quantity_breakage_check CHECK ((quantity_breakage >= 0))
);


ALTER TABLE public.factory_order_items OWNER TO postgres;

--
-- Name: factory_orders; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.factory_orders (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    order_number text,
    status text DEFAULT 'ordered'::text NOT NULL,
    order_date date,
    expected_completion date,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    row_version integer DEFAULT 1 NOT NULL,
    supplier_id uuid NOT NULL,
    ship_via_supplier_id uuid,
    canceled_at timestamp with time zone,
    canceled_by uuid,
    canceled_reason text,
    idempotency_key uuid,
    parent_factory_order_id uuid,
    CONSTRAINT chk_factory_orders_cancellation_coherent CHECK ((((status = 'canceled'::text) AND (canceled_at IS NOT NULL) AND (canceled_by IS NOT NULL) AND (canceled_reason IS NOT NULL) AND (length(TRIM(BOTH FROM canceled_reason)) > 0)) OR ((status <> 'canceled'::text) AND (canceled_at IS NULL) AND (canceled_by IS NULL) AND (canceled_reason IS NULL)))),
    CONSTRAINT chk_factory_orders_notes_max_len CHECK (((notes IS NULL) OR (length(notes) <= 4000))),
    CONSTRAINT chk_fo_completion_after_order CHECK (((order_date IS NULL) OR (expected_completion IS NULL) OR (expected_completion >= order_date))),
    CONSTRAINT chk_fo_no_self_parent CHECK (((parent_factory_order_id IS NULL) OR (parent_factory_order_id <> id))),
    CONSTRAINT factory_orders_status_check CHECK ((status = ANY (ARRAY['ordered'::text, 'in_production'::text, 'finished'::text, 'shipped'::text, 'canceled'::text])))
);


ALTER TABLE public.factory_orders OWNER TO postgres;

--
-- Name: freight_line_items; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.freight_line_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    freight_shipment_id uuid NOT NULL,
    sku_id uuid NOT NULL,
    quantity integer NOT NULL,
    unit_cost numeric(14,6) DEFAULT 0,
    retail_value numeric(14,4) DEFAULT 0,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    row_version integer DEFAULT 1 NOT NULL,
    supplier_declared_quantity integer,
    source_factory_order_item_id uuid,
    quantity_prefilled integer,
    CONSTRAINT chk_freight_li_cost_nonneg CHECK ((unit_cost >= (0)::numeric)),
    CONSTRAINT chk_freight_li_qty_positive CHECK ((quantity > 0)),
    CONSTRAINT chk_freight_li_retail_nonneg CHECK ((retail_value >= (0)::numeric)),
    CONSTRAINT chk_freight_line_items_prefilled_bounds CHECK (((quantity_prefilled IS NULL) OR ((quantity_prefilled >= 0) AND (quantity_prefilled <= quantity)))),
    CONSTRAINT freight_line_items_supplier_declared_quantity_check CHECK (((supplier_declared_quantity IS NULL) OR (supplier_declared_quantity >= 0)))
);


ALTER TABLE public.freight_line_items OWNER TO postgres;

--
-- Name: freight_shipments; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.freight_shipments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    shipment_number text NOT NULL,
    freight_type text NOT NULL,
    status text DEFAULT 'on_the_water'::text NOT NULL,
    carrier_name text,
    broker_name text,
    forwarder_code text,
    tracking_number text,
    ship_date date,
    eta date,
    actual_arrival_date date,
    freight_cost numeric(14,4) DEFAULT 0,
    insurance_cost numeric(14,4) DEFAULT 0,
    duties_cost numeric(14,4) DEFAULT 0,
    total_cost numeric(14,4) DEFAULT 0,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    eta_original date,
    eta_last_checked_at timestamp with time zone,
    status_overridden_at timestamp with time zone,
    total_cartons integer,
    row_version integer DEFAULT 1 NOT NULL,
    status_overridden_by uuid,
    origin_supplier_id uuid,
    created_by_supplier_user_id uuid,
    idempotency_key uuid,
    CONSTRAINT chk_freight_arrival_after_ship CHECK (((ship_date IS NULL) OR (actual_arrival_date IS NULL) OR (actual_arrival_date >= ship_date))),
    CONSTRAINT chk_freight_cartons_nonneg CHECK (((total_cartons IS NULL) OR (total_cartons >= 0))),
    CONSTRAINT chk_freight_cost_nonneg CHECK ((freight_cost >= (0)::numeric)),
    CONSTRAINT chk_freight_duties_nonneg CHECK ((duties_cost >= (0)::numeric)),
    CONSTRAINT chk_freight_eta_after_ship CHECK (((ship_date IS NULL) OR (eta IS NULL) OR (eta >= ship_date))),
    CONSTRAINT chk_freight_idempotency_scoped CHECK (((idempotency_key IS NULL) OR (origin_supplier_id IS NOT NULL))),
    CONSTRAINT chk_freight_insurance_nonneg CHECK ((insurance_cost >= (0)::numeric)),
    CONSTRAINT chk_freight_shipments_notes_max_len CHECK (((notes IS NULL) OR (length(notes) <= 4000))),
    CONSTRAINT chk_freight_total_nonneg CHECK ((total_cost >= (0)::numeric)),
    CONSTRAINT freight_shipments_freight_type_check CHECK ((freight_type = ANY (ARRAY['air'::text, 'sea'::text]))),
    CONSTRAINT freight_shipments_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'on_the_water'::text, 'high_risk'::text, 'cleared_customs'::text, 'tracking'::text, 'delivered'::text])))
);


ALTER TABLE public.freight_shipments OWNER TO postgres;

--
-- Name: inventory_levels; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.inventory_levels (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    sku_id uuid NOT NULL,
    warehouse_raw integer DEFAULT 0,
    warehouse_in_production integer DEFAULT 0,
    warehouse_finished integer DEFAULT 0,
    warehouse_other integer DEFAULT 0,
    last_synced_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    row_version integer DEFAULT 1 NOT NULL,
    location_id uuid NOT NULL,
    CONSTRAINT chk_inv_warehouse_finished_nonneg CHECK ((warehouse_finished >= 0)),
    CONSTRAINT chk_inv_warehouse_other_nonneg CHECK ((warehouse_other >= 0)),
    CONSTRAINT chk_inv_warehouse_raw_nonneg CHECK ((warehouse_raw >= 0)),
    CONSTRAINT chk_inv_warehouse_wip_nonneg CHECK ((warehouse_in_production >= 0))
);


ALTER TABLE public.inventory_levels OWNER TO postgres;

--
-- Name: locations; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.locations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    location_type text NOT NULL,
    address_line1 text,
    address_line2 text,
    city text,
    state text,
    postal_code text,
    country text DEFAULT 'US'::text,
    is_default boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    row_version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    owner_supplier_id uuid,
    CONSTRAINT locations_location_type_check CHECK ((location_type = ANY (ARRAY['warehouse'::text, 'three_pl'::text, 'supplier_warehouse'::text, 'store'::text])))
);


ALTER TABLE public.locations OWNER TO postgres;

--
-- Name: inventory_levels_default; Type: VIEW; Schema: public; Owner: postgres
--

CREATE VIEW public.inventory_levels_default AS
 SELECT il.id,
    il.sku_id,
    il.warehouse_raw,
    il.warehouse_in_production,
    il.warehouse_finished,
    il.warehouse_other,
    il.last_synced_at,
    il.updated_at,
    il.row_version,
    il.location_id
   FROM (public.inventory_levels il
     JOIN public.locations l ON ((l.id = il.location_id)))
  WHERE (l.is_default = true);


ALTER VIEW public.inventory_levels_default OWNER TO postgres;

--
-- Name: inventory_totals_by_sku; Type: VIEW; Schema: public; Owner: postgres
--

CREATE VIEW public.inventory_totals_by_sku AS
 SELECT sku_id,
    sum(warehouse_raw) AS warehouse_raw,
    sum(warehouse_in_production) AS warehouse_in_production,
    sum(warehouse_finished) AS warehouse_finished,
    sum(warehouse_other) AS warehouse_other,
    count(*) AS location_count,
    max(updated_at) AS most_recent_update
   FROM public.inventory_levels
  GROUP BY sku_id;


ALTER VIEW public.inventory_totals_by_sku OWNER TO postgres;

--
-- Name: inventory_transactions; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.inventory_transactions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    sku_id uuid,
    transaction_type text NOT NULL,
    quantity integer NOT NULL,
    field_affected text NOT NULL,
    reference_id uuid,
    reference_type text,
    notes text,
    performed_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    movement_kind text DEFAULT 'net_change'::text NOT NULL,
    from_field text,
    to_field text,
    row_hash text,
    prev_hash text,
    actor_ip inet,
    actor_user_agent text,
    CONSTRAINT chk_inv_tx_reference_shape CHECK ((((reference_id IS NULL) AND (reference_type IS NULL)) OR ((reference_id IS NOT NULL) AND (reference_type IS NOT NULL) AND (reference_type = ANY (ARRAY['product_sku'::text, 'task_log'::text, 'freight_shipment'::text, 'factory_order'::text, 'shipstation_order'::text, 'profile'::text]))))),
    CONSTRAINT chk_inventory_transactions_notes_max_len CHECK (((notes IS NULL) OR (length(notes) <= 4000))),
    CONSTRAINT chk_move_fields_consistent CHECK (((movement_kind <> 'category_move'::text) OR ((from_field IS NOT NULL) AND (to_field IS NOT NULL)))),
    CONSTRAINT inventory_transactions_movement_kind_check CHECK ((movement_kind = ANY (ARRAY['net_change'::text, 'category_move'::text, 'metadata'::text])))
);


ALTER TABLE public.inventory_transactions OWNER TO postgres;

--
-- Name: labor_hours_daily; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.labor_hours_daily (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    homebase_employee_id text NOT NULL,
    work_date date NOT NULL,
    minutes_clocked integer DEFAULT 0 NOT NULL,
    minutes_breaks_paid integer DEFAULT 0 NOT NULL,
    minutes_breaks_unpaid integer DEFAULT 0 NOT NULL,
    source text DEFAULT 'homebase'::text NOT NULL,
    last_synced_at timestamp with time zone DEFAULT now() NOT NULL,
    raw_payload jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT labor_hours_daily_source_check CHECK ((source = ANY (ARRAY['homebase'::text, 'manual'::text, 'import'::text])))
);


ALTER TABLE public.labor_hours_daily OWNER TO postgres;

--
-- Name: product_boms; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.product_boms (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    parent_sku_id uuid NOT NULL,
    component_sku_id uuid NOT NULL,
    component_type text NOT NULL,
    units_per_parent integer DEFAULT 1 NOT NULL,
    assembled_at_supplier_id uuid NOT NULL,
    component_location_id uuid,
    effective_from date DEFAULT CURRENT_DATE NOT NULL,
    effective_until date,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    row_version integer DEFAULT 1 NOT NULL,
    CONSTRAINT chk_bom_effective_order CHECK (((effective_until IS NULL) OR (effective_until > effective_from))),
    CONSTRAINT chk_bom_location_required_for_consumable CHECK (((component_type <> 'consumable_inventory'::text) OR (component_location_id IS NOT NULL))),
    CONSTRAINT chk_bom_no_self_reference CHECK ((parent_sku_id <> component_sku_id)),
    CONSTRAINT product_boms_component_type_check CHECK ((component_type = ANY (ARRAY['produced'::text, 'consumable_inventory'::text]))),
    CONSTRAINT product_boms_units_per_parent_check CHECK ((units_per_parent > 0))
);


ALTER TABLE public.product_boms OWNER TO postgres;

--
-- Name: product_boms_active; Type: VIEW; Schema: public; Owner: postgres
--

CREATE VIEW public.product_boms_active AS
 SELECT id,
    parent_sku_id,
    component_sku_id,
    component_type,
    units_per_parent,
    assembled_at_supplier_id,
    component_location_id,
    effective_from,
    effective_until,
    notes,
    created_at,
    updated_at,
    row_version
   FROM public.product_boms
  WHERE (effective_until IS NULL);


ALTER VIEW public.product_boms_active OWNER TO postgres;

--
-- Name: product_skus; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.product_skus (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    sku text NOT NULL,
    product_name text NOT NULL,
    upc_code text,
    category text NOT NULL,
    display_category text DEFAULT 'Accessories'::text NOT NULL,
    retail_price numeric(14,4) DEFAULT 0,
    standard_quantity_per_carton integer DEFAULT 1,
    abc_classification text,
    monthly_demand integer DEFAULT 0,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    row_version integer DEFAULT 1 NOT NULL,
    archived_at timestamp with time zone,
    archived_by uuid,
    archive_reason text,
    CONSTRAINT chk_product_skus_archive_reason_max_len CHECK (((archive_reason IS NULL) OR (length(archive_reason) <= 1000))),
    CONSTRAINT chk_sku_monthly_demand_nonneg CHECK ((monthly_demand >= 0)),
    CONSTRAINT chk_sku_retail_nonneg CHECK ((retail_price >= (0)::numeric)),
    CONSTRAINT chk_sku_std_carton_positive CHECK ((standard_quantity_per_carton > 0)),
    CONSTRAINT product_skus_abc_classification_check CHECK ((abc_classification = ANY (ARRAY['A'::text, 'B'::text, 'C'::text]))),
    CONSTRAINT product_skus_category_check CHECK ((category = ANY (ARRAY['fillable'::text, 'non_fillable'::text])))
);


ALTER TABLE public.product_skus OWNER TO postgres;

--
-- Name: product_skus_active; Type: VIEW; Schema: public; Owner: postgres
--

CREATE VIEW public.product_skus_active AS
 SELECT id,
    sku,
    product_name,
    upc_code,
    category,
    display_category,
    retail_price,
    standard_quantity_per_carton,
    abc_classification,
    monthly_demand,
    is_active,
    created_at,
    updated_at,
    row_version,
    archived_at,
    archived_by,
    archive_reason
   FROM public.product_skus
  WHERE (archived_at IS NULL);


ALTER VIEW public.product_skus_active OWNER TO postgres;

--
-- Name: profiles; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.profiles (
    id uuid NOT NULL,
    email text NOT NULL,
    full_name text NOT NULL,
    role text DEFAULT 'user'::text NOT NULL,
    avatar_url text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    row_version integer DEFAULT 1 NOT NULL,
    homebase_employee_id text,
    homebase_employee_name text,
    homebase_linked_at timestamp with time zone,
    homebase_linked_by uuid,
    supplier_id uuid,
    is_active boolean DEFAULT true NOT NULL,
    CONSTRAINT chk_profile_email_format CHECK (((email ~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$'::text) OR (email = 'system@internal'::text))),
    CONSTRAINT chk_profile_supplier_role_consistency CHECK ((((role = 'supplier'::text) AND (supplier_id IS NOT NULL)) OR ((role <> 'supplier'::text) AND (supplier_id IS NULL)))),
    CONSTRAINT profiles_role_check CHECK ((role = ANY (ARRAY['admin'::text, 'manager'::text, 'user'::text, 'supplier'::text])))
);


ALTER TABLE public.profiles OWNER TO postgres;

--
-- Name: shipment_variances; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.shipment_variances (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    freight_line_item_id uuid NOT NULL,
    shipment_id uuid NOT NULL,
    sku_id uuid NOT NULL,
    origin_supplier_id uuid NOT NULL,
    declared_quantity integer NOT NULL,
    received_quantity integer NOT NULL,
    variance_quantity integer GENERATED ALWAYS AS ((received_quantity - declared_quantity)) STORED,
    variance_type text NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    notes text,
    resolution_notes text,
    acknowledged_at timestamp with time zone,
    acknowledged_by uuid,
    resolved_at timestamp with time zone,
    resolved_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    CONSTRAINT chk_shipment_variances_resolution_notes_max_len CHECK (((resolution_notes IS NULL) OR (length(resolution_notes) <= 4000))),
    CONSTRAINT chk_variance_ack_coherent CHECK ((((status = 'open'::text) AND (acknowledged_at IS NULL) AND (acknowledged_by IS NULL)) OR ((status <> 'open'::text) AND (acknowledged_at IS NOT NULL) AND (acknowledged_by IS NOT NULL)))),
    CONSTRAINT chk_variance_resolved_coherent CHECK ((((status = ANY (ARRAY['resolved'::text, 'written_off'::text])) AND (resolved_at IS NOT NULL) AND (resolved_by IS NOT NULL) AND (resolution_notes IS NOT NULL) AND (length(TRIM(BOTH FROM resolution_notes)) > 0)) OR ((status <> ALL (ARRAY['resolved'::text, 'written_off'::text])) AND (resolved_at IS NULL) AND (resolved_by IS NULL)))),
    CONSTRAINT shipment_variances_declared_quantity_check CHECK ((declared_quantity >= 0)),
    CONSTRAINT shipment_variances_received_quantity_check CHECK ((received_quantity >= 0)),
    CONSTRAINT shipment_variances_status_check CHECK ((status = ANY (ARRAY['open'::text, 'acknowledged'::text, 'resolved'::text, 'written_off'::text]))),
    CONSTRAINT shipment_variances_variance_type_check CHECK ((variance_type = ANY (ARRAY['shortage'::text, 'overage'::text, 'breakage_in_transit'::text, 'damage'::text, 'other'::text])))
);


ALTER TABLE public.shipment_variances OWNER TO postgres;

--
-- Name: shipstation_order_items; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.shipstation_order_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    shipstation_order_id uuid NOT NULL,
    shipstation_line_item_id bigint,
    sku_code text NOT NULL,
    sku_id uuid,
    quantity integer NOT NULL,
    unit_price_cents bigint DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_ss_item_qty_positive CHECK ((quantity > 0))
);


ALTER TABLE public.shipstation_order_items OWNER TO postgres;

--
-- Name: shipstation_orders; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.shipstation_orders (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    shipstation_order_id bigint NOT NULL,
    order_number text NOT NULL,
    order_status text NOT NULL,
    order_date timestamp with time zone NOT NULL,
    ship_date timestamp with time zone,
    customer_email text,
    customer_name text,
    store_id bigint,
    store_name text,
    order_total_cents bigint DEFAULT 0 NOT NULL,
    shipping_amount_cents bigint DEFAULT 0 NOT NULL,
    tax_amount_cents bigint DEFAULT 0 NOT NULL,
    inventory_applied_at timestamp with time zone,
    inventory_apply_attempts integer DEFAULT 0 NOT NULL,
    inventory_apply_error text,
    last_seen_via text,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    raw_payload jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT shipstation_orders_last_seen_via_check CHECK ((last_seen_via = ANY (ARRAY['webhook'::text, 'api_pull'::text, 'manual'::text])))
);


ALTER TABLE public.shipstation_orders OWNER TO postgres;

--
-- Name: shipstation_sync_runs; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.shipstation_sync_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    run_type text NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    status text DEFAULT 'running'::text NOT NULL,
    from_date timestamp with time zone,
    to_date timestamp with time zone,
    orders_pulled integer DEFAULT 0 NOT NULL,
    orders_new integer DEFAULT 0 NOT NULL,
    orders_updated integer DEFAULT 0 NOT NULL,
    orders_drift_detected integer DEFAULT 0 NOT NULL,
    error_message text,
    notes text,
    CONSTRAINT shipstation_sync_runs_run_type_check CHECK ((run_type = ANY (ARRAY['webhook_replay'::text, 'nightly_reconcile'::text, 'backfill'::text]))),
    CONSTRAINT shipstation_sync_runs_status_check CHECK ((status = ANY (ARRAY['running'::text, 'succeeded'::text, 'failed'::text])))
);


ALTER TABLE public.shipstation_sync_runs OWNER TO postgres;

--
-- Name: shipstation_unresolved_skus; Type: VIEW; Schema: public; Owner: postgres
--

CREATE VIEW public.shipstation_unresolved_skus AS
 SELECT i.sku_code,
    count(*) AS line_item_count,
    sum(i.quantity) AS total_units,
    min(o.order_date) AS first_seen,
    max(o.order_date) AS last_seen,
    count(DISTINCT o.id) AS distinct_orders
   FROM (public.shipstation_order_items i
     JOIN public.shipstation_orders o ON ((o.id = i.shipstation_order_id)))
  WHERE (i.sku_id IS NULL)
  GROUP BY i.sku_code
  ORDER BY (count(*)) DESC;


ALTER VIEW public.shipstation_unresolved_skus OWNER TO postgres;

--
-- Name: shipstation_webhook_events; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.shipstation_webhook_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    event_id text NOT NULL,
    event_type text NOT NULL,
    resource_url text,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    processed_at timestamp with time zone,
    processing_error text,
    attempts integer DEFAULT 0 NOT NULL,
    signature_verified boolean DEFAULT false NOT NULL,
    request_headers jsonb,
    request_body jsonb,
    resulting_order_id uuid
);


ALTER TABLE public.shipstation_webhook_events OWNER TO postgres;

--
-- Name: sku_economics; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.sku_economics (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    sku_id uuid NOT NULL,
    pct_from_yx numeric(5,2) DEFAULT 0,
    pct_from_nancy numeric(5,2) DEFAULT 0,
    nancy_raw_cost numeric(14,6) DEFAULT 0,
    yx_raw_cost numeric(14,6) DEFAULT 0,
    additional_raw_cost numeric(14,6) DEFAULT 0,
    pct_sea numeric(5,2) DEFAULT 0,
    pct_air numeric(5,2) DEFAULT 0,
    sea_freight_cost_per_unit numeric(14,6) DEFAULT 0,
    air_freight_cost_per_unit numeric(14,6) DEFAULT 0,
    breakage_issue_cost numeric(14,6) DEFAULT 0,
    pct_manufactured_us numeric(5,2) DEFAULT 0,
    pct_manufactured_cn numeric(5,2) DEFAULT 0,
    labor_cost_us numeric(14,6) DEFAULT 0,
    glycerin_cost_us numeric(14,6) DEFAULT 0,
    manufacturing_cost_cn numeric(14,6) DEFAULT 0,
    packing_material_cost numeric(14,6) DEFAULT 0,
    packing_labor_cost numeric(14,6) DEFAULT 0,
    shipping_cost numeric(14,6) DEFAULT 0,
    credit_card_fees numeric(14,6) DEFAULT 0,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    row_version integer DEFAULT 1 NOT NULL,
    mfg_override_pct_prefilled numeric(5,2),
    mfg_override_active boolean DEFAULT false NOT NULL,
    mfg_window_days smallint DEFAULT 30 NOT NULL,
    additional_raw_cost_reason text,
    CONSTRAINT chk_econ_costs_nonneg CHECK (((nancy_raw_cost >= (0)::numeric) AND (yx_raw_cost >= (0)::numeric) AND (additional_raw_cost >= (0)::numeric) AND (sea_freight_cost_per_unit >= (0)::numeric) AND (air_freight_cost_per_unit >= (0)::numeric) AND (breakage_issue_cost >= (0)::numeric) AND (labor_cost_us >= (0)::numeric) AND (glycerin_cost_us >= (0)::numeric) AND (manufacturing_cost_cn >= (0)::numeric) AND (packing_material_cost >= (0)::numeric) AND (packing_labor_cost >= (0)::numeric) AND (shipping_cost >= (0)::numeric) AND (credit_card_fees >= (0)::numeric))),
    CONSTRAINT chk_econ_pct_bounds CHECK ((((pct_from_yx >= (0)::numeric) AND (pct_from_yx <= (100)::numeric)) AND ((pct_from_nancy >= (0)::numeric) AND (pct_from_nancy <= (100)::numeric)) AND ((pct_sea >= (0)::numeric) AND (pct_sea <= (100)::numeric)) AND ((pct_air >= (0)::numeric) AND (pct_air <= (100)::numeric)) AND ((pct_manufactured_us >= (0)::numeric) AND (pct_manufactured_us <= (100)::numeric)) AND ((pct_manufactured_cn >= (0)::numeric) AND (pct_manufactured_cn <= (100)::numeric)))),
    CONSTRAINT chk_econ_pct_freight CHECK (((round((pct_sea + pct_air), 2) = (100)::numeric) OR ((pct_sea = (0)::numeric) AND (pct_air = (0)::numeric)))),
    CONSTRAINT chk_econ_pct_mfg CHECK (((round((pct_manufactured_us + pct_manufactured_cn), 2) = (100)::numeric) OR ((pct_manufactured_us = (0)::numeric) AND (pct_manufactured_cn = (0)::numeric)))),
    CONSTRAINT chk_econ_pct_sourcing CHECK (((round((pct_from_yx + pct_from_nancy), 2) = (100)::numeric) OR ((pct_from_yx = (0)::numeric) AND (pct_from_nancy = (0)::numeric)))),
    CONSTRAINT sku_economics_mfg_override_pct_prefilled_check CHECK (((mfg_override_pct_prefilled IS NULL) OR ((mfg_override_pct_prefilled >= (0)::numeric) AND (mfg_override_pct_prefilled <= (100)::numeric)))),
    CONSTRAINT sku_economics_mfg_window_days_check CHECK (((mfg_window_days >= 30) AND (mfg_window_days <= 90)))
);


ALTER TABLE public.sku_economics OWNER TO postgres;

--
-- Name: sku_supplier_costs; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.sku_supplier_costs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    sku_id uuid NOT NULL,
    supplier_id uuid NOT NULL,
    unit_cost numeric(10,4) NOT NULL,
    is_primary boolean DEFAULT false NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    row_version integer DEFAULT 1 NOT NULL,
    CONSTRAINT chk_sku_supplier_costs_notes_max_len CHECK (((notes IS NULL) OR (length(notes) <= 4000))),
    CONSTRAINT sku_supplier_costs_unit_cost_check CHECK ((unit_cost >= (0)::numeric))
);


ALTER TABLE public.sku_supplier_costs OWNER TO postgres;

--
-- Name: supplier_portal_breakage_reports; Type: VIEW; Schema: public; Owner: postgres
--

CREATE VIEW public.supplier_portal_breakage_reports WITH (security_invoker='true') AS
 SELECT id,
    factory_order_item_id,
    producing_supplier_id,
    reporter_supplier_id,
    sku_id,
    quantity_broken,
    reason_category,
    description,
    replacement_requested,
    replacement_factory_order_id,
    status,
    resolution_notes,
    acknowledged_at,
    resolved_at,
    created_at
   FROM public.component_breakage_reports;


ALTER VIEW public.supplier_portal_breakage_reports OWNER TO postgres;

--
-- Name: supplier_portal_factory_order_items; Type: VIEW; Schema: public; Owner: postgres
--

CREATE VIEW public.supplier_portal_factory_order_items WITH (security_invoker='true') AS
 SELECT id,
    factory_order_id,
    sku_id,
    quantity_ordered,
    consolidator_confirmed_quantity,
    consolidator_confirmed_at,
    quantity_breakage,
    created_at,
    row_version
   FROM public.factory_order_items foi;


ALTER VIEW public.supplier_portal_factory_order_items OWNER TO postgres;

--
-- Name: supplier_portal_factory_orders; Type: VIEW; Schema: public; Owner: postgres
--

CREATE VIEW public.supplier_portal_factory_orders WITH (security_invoker='true') AS
 SELECT id,
    supplier_id,
    ship_via_supplier_id,
    order_date,
    expected_completion,
    status,
    canceled_at,
    canceled_reason,
    notes,
    created_at,
    updated_at,
    row_version
   FROM public.factory_orders;


ALTER VIEW public.supplier_portal_factory_orders OWNER TO postgres;

--
-- Name: supplier_portal_freight_line_items; Type: VIEW; Schema: public; Owner: postgres
--

CREATE VIEW public.supplier_portal_freight_line_items WITH (security_invoker='true') AS
 SELECT id,
    freight_shipment_id,
    sku_id,
    quantity,
    supplier_declared_quantity,
    source_factory_order_item_id,
    created_at,
    updated_at,
    quantity_prefilled
   FROM public.freight_line_items fli;


ALTER VIEW public.supplier_portal_freight_line_items OWNER TO postgres;

--
-- Name: supplier_portal_freight_shipments; Type: VIEW; Schema: public; Owner: postgres
--

CREATE VIEW public.supplier_portal_freight_shipments WITH (security_invoker='true') AS
 SELECT id,
    origin_supplier_id,
    tracking_number,
    carrier_name,
    status,
    eta,
    eta_original,
    actual_arrival_date,
    total_cartons,
    created_by_supplier_user_id,
    idempotency_key,
    created_at,
    updated_at,
    row_version
   FROM public.freight_shipments;


ALTER VIEW public.supplier_portal_freight_shipments OWNER TO postgres;

--
-- Name: supplier_portal_skus; Type: VIEW; Schema: public; Owner: postgres
--

CREATE VIEW public.supplier_portal_skus WITH (security_invoker='true') AS
 SELECT id,
    sku,
    product_name,
    category,
    is_active,
    created_at
   FROM public.product_skus;


ALTER VIEW public.supplier_portal_skus OWNER TO postgres;

--
-- Name: supplier_portal_variances; Type: VIEW; Schema: public; Owner: postgres
--

CREATE VIEW public.supplier_portal_variances WITH (security_invoker='true') AS
 SELECT id,
    freight_line_item_id,
    shipment_id,
    sku_id,
    origin_supplier_id,
    declared_quantity,
    received_quantity,
    variance_quantity,
    variance_type,
    status,
    notes,
    resolution_notes,
    acknowledged_at,
    resolved_at,
    created_at
   FROM public.shipment_variances;


ALTER VIEW public.supplier_portal_variances OWNER TO postgres;

--
-- Name: suppliers; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.suppliers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    contact_name text,
    contact_email text,
    contact_phone text,
    address_line1 text,
    address_line2 text,
    city text,
    state_region text,
    postal_code text,
    country text DEFAULT 'CN'::text NOT NULL,
    default_lead_time_days integer,
    payment_terms text,
    invoice_currency character(3) DEFAULT 'USD'::bpchar NOT NULL,
    notes text,
    is_active boolean DEFAULT true NOT NULL,
    row_version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    is_producer boolean DEFAULT true NOT NULL,
    is_filler boolean DEFAULT false NOT NULL,
    is_export_broker boolean DEFAULT false NOT NULL,
    consolidates_for uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    CONSTRAINT chk_suppliers_notes_max_len CHECK (((notes IS NULL) OR (length(notes) <= 4000))),
    CONSTRAINT suppliers_contact_email_check CHECK (((contact_email IS NULL) OR (contact_email ~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$'::text))),
    CONSTRAINT suppliers_default_lead_time_days_check CHECK (((default_lead_time_days IS NULL) OR (default_lead_time_days >= 0)))
);


ALTER TABLE public.suppliers OWNER TO postgres;

--
-- Name: task_logs; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.task_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    employee_id uuid NOT NULL,
    sku_id uuid NOT NULL,
    task_type text NOT NULL,
    quantity_processed integer NOT NULL,
    time_started timestamp with time zone,
    time_completed timestamp with time zone,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_task_logs_notes_max_len CHECK (((notes IS NULL) OR (length(notes) <= 4000))),
    CONSTRAINT chk_task_qty_positive CHECK ((quantity_processed > 0)),
    CONSTRAINT chk_task_time_order CHECK (((time_started IS NULL) OR (time_completed IS NULL) OR (time_completed >= time_started))),
    CONSTRAINT task_logs_task_type_check CHECK ((task_type = ANY (ARRAY['emptying'::text, 'filling_capping'::text, 'rtsing'::text, 'prefilled_rtsing'::text, 'breakage'::text])))
);


ALTER TABLE public.task_logs OWNER TO postgres;

--
-- Name: audit_logs audit_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_pkey PRIMARY KEY (id);


--
-- Name: component_breakage_reports component_breakage_reports_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.component_breakage_reports
    ADD CONSTRAINT component_breakage_reports_pkey PRIMARY KEY (id);


--
-- Name: demand_overrides demand_overrides_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.demand_overrides
    ADD CONSTRAINT demand_overrides_pkey PRIMARY KEY (id);


--
-- Name: demand_overrides demand_overrides_sku_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.demand_overrides
    ADD CONSTRAINT demand_overrides_sku_id_key UNIQUE (sku_id);


--
-- Name: factory_order_items factory_order_items_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.factory_order_items
    ADD CONSTRAINT factory_order_items_pkey PRIMARY KEY (id);


--
-- Name: factory_orders factory_orders_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.factory_orders
    ADD CONSTRAINT factory_orders_pkey PRIMARY KEY (id);


--
-- Name: freight_line_items freight_line_items_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.freight_line_items
    ADD CONSTRAINT freight_line_items_pkey PRIMARY KEY (id);


--
-- Name: freight_shipments freight_shipments_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.freight_shipments
    ADD CONSTRAINT freight_shipments_pkey PRIMARY KEY (id);


--
-- Name: freight_shipments freight_shipments_shipment_number_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.freight_shipments
    ADD CONSTRAINT freight_shipments_shipment_number_key UNIQUE (shipment_number);


--
-- Name: inventory_levels inventory_levels_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.inventory_levels
    ADD CONSTRAINT inventory_levels_pkey PRIMARY KEY (id);


--
-- Name: inventory_levels inventory_levels_sku_location_unique; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.inventory_levels
    ADD CONSTRAINT inventory_levels_sku_location_unique UNIQUE (sku_id, location_id);


--
-- Name: inventory_transactions inventory_transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.inventory_transactions
    ADD CONSTRAINT inventory_transactions_pkey PRIMARY KEY (id);


--
-- Name: labor_hours_daily labor_hours_daily_homebase_employee_id_work_date_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.labor_hours_daily
    ADD CONSTRAINT labor_hours_daily_homebase_employee_id_work_date_key UNIQUE (homebase_employee_id, work_date);


--
-- Name: labor_hours_daily labor_hours_daily_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.labor_hours_daily
    ADD CONSTRAINT labor_hours_daily_pkey PRIMARY KEY (id);


--
-- Name: locations locations_code_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.locations
    ADD CONSTRAINT locations_code_key UNIQUE (code);


--
-- Name: locations locations_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.locations
    ADD CONSTRAINT locations_pkey PRIMARY KEY (id);


--
-- Name: product_boms product_boms_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.product_boms
    ADD CONSTRAINT product_boms_pkey PRIMARY KEY (id);


--
-- Name: product_skus product_skus_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.product_skus
    ADD CONSTRAINT product_skus_pkey PRIMARY KEY (id);


--
-- Name: product_skus product_skus_sku_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.product_skus
    ADD CONSTRAINT product_skus_sku_key UNIQUE (sku);


--
-- Name: profiles profiles_email_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_email_key UNIQUE (email);


--
-- Name: profiles profiles_homebase_employee_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_homebase_employee_id_key UNIQUE (homebase_employee_id);


--
-- Name: profiles profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_pkey PRIMARY KEY (id);


--
-- Name: shipment_variances shipment_variances_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.shipment_variances
    ADD CONSTRAINT shipment_variances_pkey PRIMARY KEY (id);


--
-- Name: shipstation_order_items shipstation_order_items_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.shipstation_order_items
    ADD CONSTRAINT shipstation_order_items_pkey PRIMARY KEY (id);


--
-- Name: shipstation_orders shipstation_orders_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.shipstation_orders
    ADD CONSTRAINT shipstation_orders_pkey PRIMARY KEY (id);


--
-- Name: shipstation_orders shipstation_orders_shipstation_order_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.shipstation_orders
    ADD CONSTRAINT shipstation_orders_shipstation_order_id_key UNIQUE (shipstation_order_id);


--
-- Name: shipstation_sync_runs shipstation_sync_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.shipstation_sync_runs
    ADD CONSTRAINT shipstation_sync_runs_pkey PRIMARY KEY (id);


--
-- Name: shipstation_webhook_events shipstation_webhook_events_event_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.shipstation_webhook_events
    ADD CONSTRAINT shipstation_webhook_events_event_id_key UNIQUE (event_id);


--
-- Name: shipstation_webhook_events shipstation_webhook_events_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.shipstation_webhook_events
    ADD CONSTRAINT shipstation_webhook_events_pkey PRIMARY KEY (id);


--
-- Name: sku_economics sku_economics_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.sku_economics
    ADD CONSTRAINT sku_economics_pkey PRIMARY KEY (id);


--
-- Name: sku_economics sku_economics_sku_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.sku_economics
    ADD CONSTRAINT sku_economics_sku_id_key UNIQUE (sku_id);


--
-- Name: sku_supplier_costs sku_supplier_costs_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.sku_supplier_costs
    ADD CONSTRAINT sku_supplier_costs_pkey PRIMARY KEY (id);


--
-- Name: suppliers suppliers_code_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.suppliers
    ADD CONSTRAINT suppliers_code_key UNIQUE (code);


--
-- Name: suppliers suppliers_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.suppliers
    ADD CONSTRAINT suppliers_pkey PRIMARY KEY (id);


--
-- Name: task_logs task_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.task_logs
    ADD CONSTRAINT task_logs_pkey PRIMARY KEY (id);


--
-- Name: sku_supplier_costs uniq_sku_supplier_costs; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.sku_supplier_costs
    ADD CONSTRAINT uniq_sku_supplier_costs UNIQUE (sku_id, supplier_id);


--
-- Name: idx_audit_logs_action; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_audit_logs_action ON public.audit_logs USING btree (action, created_at DESC);


--
-- Name: idx_audit_logs_actor; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_audit_logs_actor ON public.audit_logs USING btree (actor_id, created_at DESC) WHERE (actor_id IS NOT NULL);


--
-- Name: idx_audit_logs_target; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_audit_logs_target ON public.audit_logs USING btree (target_table, target_id, created_at DESC);


--
-- Name: idx_breakage_reports_foi; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_breakage_reports_foi ON public.component_breakage_reports USING btree (factory_order_item_id);


--
-- Name: idx_breakage_reports_producer_open; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_breakage_reports_producer_open ON public.component_breakage_reports USING btree (producing_supplier_id, created_at DESC) WHERE (status = ANY (ARRAY['open'::text, 'acknowledged'::text, 'disputed'::text]));


--
-- Name: idx_breakage_reports_reporter; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_breakage_reports_reporter ON public.component_breakage_reports USING btree (reporter_supplier_id, created_at DESC);


--
-- Name: idx_factory_orders_active_by_supplier; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_factory_orders_active_by_supplier ON public.factory_orders USING btree (supplier_id, status, order_date) WHERE (status <> 'canceled'::text);


--
-- Name: idx_factory_orders_idempotency; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX idx_factory_orders_idempotency ON public.factory_orders USING btree (supplier_id, idempotency_key) WHERE (idempotency_key IS NOT NULL);


--
-- Name: idx_factory_orders_parent; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_factory_orders_parent ON public.factory_orders USING btree (parent_factory_order_id) WHERE (parent_factory_order_id IS NOT NULL);


--
-- Name: idx_factory_orders_ship_via; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_factory_orders_ship_via ON public.factory_orders USING btree (ship_via_supplier_id) WHERE (ship_via_supplier_id IS NOT NULL);


--
-- Name: idx_factory_orders_supplier; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_factory_orders_supplier ON public.factory_orders USING btree (supplier_id);


--
-- Name: idx_fo_items_order; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_fo_items_order ON public.factory_order_items USING btree (factory_order_id);


--
-- Name: idx_fo_items_unique_per_order_sku; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX idx_fo_items_unique_per_order_sku ON public.factory_order_items USING btree (factory_order_id, sku_id);


--
-- Name: idx_freight_eta; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_freight_eta ON public.freight_shipments USING btree (eta) WHERE (status <> 'delivered'::text);


--
-- Name: idx_freight_items_shipment; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_freight_items_shipment ON public.freight_line_items USING btree (freight_shipment_id);


--
-- Name: idx_freight_items_unique_per_shipment_sku; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX idx_freight_items_unique_per_shipment_sku ON public.freight_line_items USING btree (freight_shipment_id, sku_id);


--
-- Name: idx_freight_line_items_prefill_tracked; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_freight_line_items_prefill_tracked ON public.freight_line_items USING btree (sku_id, freight_shipment_id) WHERE (quantity_prefilled IS NOT NULL);


--
-- Name: idx_freight_line_items_sku_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_freight_line_items_sku_id ON public.freight_line_items USING btree (sku_id);


--
-- Name: idx_freight_line_items_source_foi; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_freight_line_items_source_foi ON public.freight_line_items USING btree (source_factory_order_item_id) WHERE (source_factory_order_item_id IS NOT NULL);


--
-- Name: idx_freight_shipments_idempotency; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX idx_freight_shipments_idempotency ON public.freight_shipments USING btree (origin_supplier_id, idempotency_key) WHERE (idempotency_key IS NOT NULL);


--
-- Name: idx_freight_shipments_origin_supplier; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_freight_shipments_origin_supplier ON public.freight_shipments USING btree (origin_supplier_id, created_at DESC) WHERE (origin_supplier_id IS NOT NULL);


--
-- Name: idx_freight_status; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_freight_status ON public.freight_shipments USING btree (status);


--
-- Name: idx_freight_type; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_freight_type ON public.freight_shipments USING btree (freight_type);


--
-- Name: idx_inv_tx_created; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_inv_tx_created ON public.inventory_transactions USING btree (created_at DESC);


--
-- Name: idx_inv_tx_performed_by; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_inv_tx_performed_by ON public.inventory_transactions USING btree (performed_by);


--
-- Name: idx_inv_tx_reference; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_inv_tx_reference ON public.inventory_transactions USING btree (reference_type, reference_id) WHERE (reference_id IS NOT NULL);


--
-- Name: idx_inv_tx_sku; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_inv_tx_sku ON public.inventory_transactions USING btree (sku_id);


--
-- Name: idx_inventory_by_location; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_inventory_by_location ON public.inventory_levels USING btree (location_id);


--
-- Name: idx_labor_hours_date; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_labor_hours_date ON public.labor_hours_daily USING btree (work_date DESC);


--
-- Name: idx_labor_hours_employee; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_labor_hours_employee ON public.labor_hours_daily USING btree (homebase_employee_id);


--
-- Name: idx_locations_active; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_locations_active ON public.locations USING btree (is_active) WHERE (is_active = true);


--
-- Name: idx_locations_owner_supplier; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_locations_owner_supplier ON public.locations USING btree (owner_supplier_id) WHERE (owner_supplier_id IS NOT NULL);


--
-- Name: idx_locations_single_default; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX idx_locations_single_default ON public.locations USING btree (is_default) WHERE (is_default = true);


--
-- Name: idx_product_boms_active_unique; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX idx_product_boms_active_unique ON public.product_boms USING btree (parent_sku_id, component_sku_id) WHERE (effective_until IS NULL);


--
-- Name: idx_product_boms_component; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_product_boms_component ON public.product_boms USING btree (component_sku_id) WHERE (effective_until IS NULL);


--
-- Name: idx_product_boms_parent; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_product_boms_parent ON public.product_boms USING btree (parent_sku_id) WHERE (effective_until IS NULL);


--
-- Name: idx_product_skus_active; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_product_skus_active ON public.product_skus USING btree (is_active);


--
-- Name: idx_product_skus_not_archived; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_product_skus_not_archived ON public.product_skus USING btree (id) WHERE (archived_at IS NULL);


--
-- Name: idx_profiles_homebase; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_profiles_homebase ON public.profiles USING btree (homebase_employee_id) WHERE (homebase_employee_id IS NOT NULL);


--
-- Name: idx_profiles_supplier; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_profiles_supplier ON public.profiles USING btree (supplier_id) WHERE (supplier_id IS NOT NULL);


--
-- Name: idx_shipment_variances_open; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_shipment_variances_open ON public.shipment_variances USING btree (origin_supplier_id, created_at DESC) WHERE (status = ANY (ARRAY['open'::text, 'acknowledged'::text]));


--
-- Name: idx_shipment_variances_shipment; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_shipment_variances_shipment ON public.shipment_variances USING btree (shipment_id);


--
-- Name: idx_shipment_variances_sku; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_shipment_variances_sku ON public.shipment_variances USING btree (sku_id, created_at DESC);


--
-- Name: idx_sku_supplier_costs_supplier; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_sku_supplier_costs_supplier ON public.sku_supplier_costs USING btree (supplier_id);


--
-- Name: idx_ss_events_pending; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_ss_events_pending ON public.shipstation_webhook_events USING btree (received_at DESC) WHERE (processed_at IS NULL);


--
-- Name: idx_ss_events_type; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_ss_events_type ON public.shipstation_webhook_events USING btree (event_type);


--
-- Name: idx_ss_items_order; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_ss_items_order ON public.shipstation_order_items USING btree (shipstation_order_id);


--
-- Name: idx_ss_items_sku; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_ss_items_sku ON public.shipstation_order_items USING btree (sku_id);


--
-- Name: idx_ss_items_unresolved; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_ss_items_unresolved ON public.shipstation_order_items USING btree (sku_code) WHERE (sku_id IS NULL);


--
-- Name: idx_ss_items_unresolved_composite; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_ss_items_unresolved_composite ON public.shipstation_order_items USING btree (sku_code, shipstation_order_id) WHERE (sku_id IS NULL);


--
-- Name: idx_ss_orders_inventory_pending; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_ss_orders_inventory_pending ON public.shipstation_orders USING btree (inventory_applied_at) WHERE (inventory_applied_at IS NULL);


--
-- Name: idx_ss_orders_order_date; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_ss_orders_order_date ON public.shipstation_orders USING btree (order_date DESC);


--
-- Name: idx_ss_orders_order_number; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_ss_orders_order_number ON public.shipstation_orders USING btree (order_number);


--
-- Name: idx_ss_sync_started_at; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_ss_sync_started_at ON public.shipstation_sync_runs USING btree (started_at DESC);


--
-- Name: idx_suppliers_active; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_suppliers_active ON public.suppliers USING btree (is_active) WHERE (is_active = true);


--
-- Name: idx_task_logs_created; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_task_logs_created ON public.task_logs USING btree (created_at DESC);


--
-- Name: idx_task_logs_employee; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_task_logs_employee ON public.task_logs USING btree (employee_id);


--
-- Name: idx_task_logs_sku; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_task_logs_sku ON public.task_logs USING btree (sku_id);


--
-- Name: idx_task_logs_time_completed; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_task_logs_time_completed ON public.task_logs USING btree (time_completed DESC);


--
-- Name: idx_task_logs_type; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_task_logs_type ON public.task_logs USING btree (task_type);


--
-- Name: idx_task_logs_unique_submission; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX idx_task_logs_unique_submission ON public.task_logs USING btree (employee_id, sku_id, task_type, time_completed) WHERE (time_completed IS NOT NULL);


--
-- Name: uniq_sku_supplier_costs_primary; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX uniq_sku_supplier_costs_primary ON public.sku_supplier_costs USING btree (sku_id) WHERE (is_primary = true);


--
-- Name: demand_overrides set_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.demand_overrides FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();


--
-- Name: factory_orders set_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.factory_orders FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();


--
-- Name: freight_line_items set_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.freight_line_items FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();


--
-- Name: freight_shipments set_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.freight_shipments FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();


--
-- Name: inventory_levels set_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.inventory_levels FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();


--
-- Name: labor_hours_daily set_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.labor_hours_daily FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();


--
-- Name: locations set_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.locations FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();


--
-- Name: product_boms set_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.product_boms FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();


--
-- Name: product_skus set_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.product_skus FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();


--
-- Name: profiles set_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();


--
-- Name: shipstation_orders set_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.shipstation_orders FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();


--
-- Name: sku_economics set_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.sku_economics FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();


--
-- Name: sku_supplier_costs set_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.sku_supplier_costs FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();


--
-- Name: suppliers set_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.suppliers FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();


--
-- Name: inventory_transactions trg_audit_hash_chain; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trg_audit_hash_chain BEFORE INSERT ON public.inventory_transactions FOR EACH ROW EXECUTE FUNCTION public.audit_hash_chain();


--
-- Name: inventory_transactions trg_block_audit_delete; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trg_block_audit_delete BEFORE DELETE ON public.inventory_transactions FOR EACH ROW EXECUTE FUNCTION public.block_audit_mutation();


--
-- Name: audit_logs trg_block_audit_logs_delete; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trg_block_audit_logs_delete BEFORE DELETE ON public.audit_logs FOR EACH ROW EXECUTE FUNCTION public.block_audit_logs_mutation();


--
-- Name: audit_logs trg_block_audit_logs_update; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trg_block_audit_logs_update BEFORE UPDATE ON public.audit_logs FOR EACH ROW EXECUTE FUNCTION public.block_audit_logs_mutation();


--
-- Name: inventory_transactions trg_block_audit_update; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trg_block_audit_update BEFORE UPDATE ON public.inventory_transactions FOR EACH ROW EXECUTE FUNCTION public.block_audit_mutation();


--
-- Name: profiles trg_block_direct_role_update; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trg_block_direct_role_update BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.block_direct_role_update();


--
-- Name: product_skus trg_block_sku_delete; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trg_block_sku_delete BEFORE DELETE ON public.product_skus FOR EACH ROW EXECUTE FUNCTION public.block_sku_hard_delete();


--
-- Name: task_logs trg_block_task_log_delete; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trg_block_task_log_delete BEFORE DELETE ON public.task_logs FOR EACH ROW EXECUTE FUNCTION public.block_task_log_mutation();


--
-- Name: task_logs trg_block_task_log_update; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trg_block_task_log_update BEFORE UPDATE ON public.task_logs FOR EACH ROW EXECUTE FUNCTION public.block_task_log_mutation();


--
-- Name: component_breakage_reports trg_breakage_report_append_only; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trg_breakage_report_append_only BEFORE UPDATE ON public.component_breakage_reports FOR EACH ROW EXECUTE FUNCTION public.enforce_breakage_report_append_only();


--
-- Name: component_breakage_reports trg_breakage_report_no_delete; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trg_breakage_report_no_delete BEFORE DELETE ON public.component_breakage_reports FOR EACH ROW EXECUTE FUNCTION public.block_breakage_report_delete();


--
-- Name: component_breakage_reports trg_breakage_reporter_consolidates; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trg_breakage_reporter_consolidates BEFORE INSERT ON public.component_breakage_reports FOR EACH ROW EXECUTE FUNCTION public.enforce_breakage_reporter_consolidates();


--
-- Name: factory_order_items trg_bump_version_factory_order_items; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trg_bump_version_factory_order_items BEFORE UPDATE ON public.factory_order_items FOR EACH ROW EXECUTE FUNCTION public.bump_row_version();


--
-- Name: factory_orders trg_bump_version_factory_orders; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trg_bump_version_factory_orders BEFORE UPDATE ON public.factory_orders FOR EACH ROW EXECUTE FUNCTION public.bump_row_version();


--
-- Name: freight_line_items trg_bump_version_freight_line_items; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trg_bump_version_freight_line_items BEFORE UPDATE ON public.freight_line_items FOR EACH ROW EXECUTE FUNCTION public.bump_row_version();


--
-- Name: freight_shipments trg_bump_version_freight_shipments; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trg_bump_version_freight_shipments BEFORE UPDATE ON public.freight_shipments FOR EACH ROW EXECUTE FUNCTION public.bump_row_version();


--
-- Name: inventory_levels trg_bump_version_inventory_levels; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trg_bump_version_inventory_levels BEFORE UPDATE ON public.inventory_levels FOR EACH ROW EXECUTE FUNCTION public.bump_row_version();


--
-- Name: locations trg_bump_version_locations; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trg_bump_version_locations BEFORE UPDATE ON public.locations FOR EACH ROW EXECUTE FUNCTION public.bump_row_version();


--
-- Name: product_boms trg_bump_version_product_boms; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trg_bump_version_product_boms BEFORE UPDATE ON public.product_boms FOR EACH ROW EXECUTE FUNCTION public.bump_row_version();


--
-- Name: product_skus trg_bump_version_product_skus; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trg_bump_version_product_skus BEFORE UPDATE ON public.product_skus FOR EACH ROW EXECUTE FUNCTION public.bump_row_version();


--
-- Name: profiles trg_bump_version_profiles; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trg_bump_version_profiles BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.bump_row_version();


--
-- Name: sku_economics trg_bump_version_sku_economics; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trg_bump_version_sku_economics BEFORE UPDATE ON public.sku_economics FOR EACH ROW EXECUTE FUNCTION public.bump_row_version();


--
-- Name: sku_supplier_costs trg_bump_version_sku_supplier_costs; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trg_bump_version_sku_supplier_costs BEFORE UPDATE ON public.sku_supplier_costs FOR EACH ROW EXECUTE FUNCTION public.bump_row_version();


--
-- Name: suppliers trg_bump_version_suppliers; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trg_bump_version_suppliers BEFORE UPDATE ON public.suppliers FOR EACH ROW EXECUTE FUNCTION public.bump_row_version();


--
-- Name: product_boms trg_check_bom_no_cycle; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trg_check_bom_no_cycle BEFORE INSERT OR UPDATE ON public.product_boms FOR EACH ROW EXECUTE FUNCTION public.check_bom_no_cycle();


--
-- Name: factory_orders trg_factory_order_shipped_cost_check; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trg_factory_order_shipped_cost_check BEFORE UPDATE ON public.factory_orders FOR EACH ROW EXECUTE FUNCTION public.check_shipped_factory_order_has_cost();


--
-- Name: freight_shipments trg_freight_no_regression; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trg_freight_no_regression BEFORE UPDATE ON public.freight_shipments FOR EACH ROW WHEN ((old.status IS DISTINCT FROM new.status)) EXECUTE FUNCTION public.prevent_freight_status_regression();


--
-- Name: shipment_variances trg_shipment_variance_append_only; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trg_shipment_variance_append_only BEFORE UPDATE ON public.shipment_variances FOR EACH ROW EXECUTE FUNCTION public.enforce_shipment_variance_append_only();


--
-- Name: shipment_variances trg_shipment_variance_no_delete; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trg_shipment_variance_no_delete BEFORE DELETE ON public.shipment_variances FOR EACH ROW EXECUTE FUNCTION public.block_shipment_variance_delete();


--
-- Name: suppliers trg_validate_consolidates_for; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trg_validate_consolidates_for BEFORE INSERT OR UPDATE OF consolidates_for ON public.suppliers FOR EACH ROW EXECUTE FUNCTION public.validate_consolidates_for();


--
-- Name: freight_shipments trg_warn_freight_total_drift; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trg_warn_freight_total_drift BEFORE INSERT OR UPDATE ON public.freight_shipments FOR EACH ROW EXECUTE FUNCTION public.warn_freight_total_drift();


--
-- Name: audit_logs audit_logs_actor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: component_breakage_reports component_breakage_reports_acknowledged_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.component_breakage_reports
    ADD CONSTRAINT component_breakage_reports_acknowledged_by_fkey FOREIGN KEY (acknowledged_by) REFERENCES public.profiles(id) ON DELETE RESTRICT;


--
-- Name: component_breakage_reports component_breakage_reports_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.component_breakage_reports
    ADD CONSTRAINT component_breakage_reports_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE RESTRICT;


--
-- Name: component_breakage_reports component_breakage_reports_factory_order_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.component_breakage_reports
    ADD CONSTRAINT component_breakage_reports_factory_order_item_id_fkey FOREIGN KEY (factory_order_item_id) REFERENCES public.factory_order_items(id) ON DELETE RESTRICT;


--
-- Name: component_breakage_reports component_breakage_reports_producing_supplier_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.component_breakage_reports
    ADD CONSTRAINT component_breakage_reports_producing_supplier_id_fkey FOREIGN KEY (producing_supplier_id) REFERENCES public.suppliers(id) ON DELETE RESTRICT;


--
-- Name: component_breakage_reports component_breakage_reports_replacement_factory_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.component_breakage_reports
    ADD CONSTRAINT component_breakage_reports_replacement_factory_order_id_fkey FOREIGN KEY (replacement_factory_order_id) REFERENCES public.factory_orders(id) ON DELETE RESTRICT;


--
-- Name: component_breakage_reports component_breakage_reports_reporter_supplier_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.component_breakage_reports
    ADD CONSTRAINT component_breakage_reports_reporter_supplier_id_fkey FOREIGN KEY (reporter_supplier_id) REFERENCES public.suppliers(id) ON DELETE RESTRICT;


--
-- Name: component_breakage_reports component_breakage_reports_resolved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.component_breakage_reports
    ADD CONSTRAINT component_breakage_reports_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES public.profiles(id) ON DELETE RESTRICT;


--
-- Name: component_breakage_reports component_breakage_reports_sku_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.component_breakage_reports
    ADD CONSTRAINT component_breakage_reports_sku_id_fkey FOREIGN KEY (sku_id) REFERENCES public.product_skus(id) ON DELETE RESTRICT;


--
-- Name: demand_overrides demand_overrides_overridden_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.demand_overrides
    ADD CONSTRAINT demand_overrides_overridden_by_fkey FOREIGN KEY (overridden_by) REFERENCES public.profiles(id);


--
-- Name: demand_overrides demand_overrides_sku_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.demand_overrides
    ADD CONSTRAINT demand_overrides_sku_id_fkey FOREIGN KEY (sku_id) REFERENCES public.product_skus(id) ON DELETE RESTRICT;


--
-- Name: factory_order_items factory_order_items_consolidator_confirmed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.factory_order_items
    ADD CONSTRAINT factory_order_items_consolidator_confirmed_by_fkey FOREIGN KEY (consolidator_confirmed_by) REFERENCES public.profiles(id) ON DELETE RESTRICT;


--
-- Name: factory_order_items factory_order_items_factory_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.factory_order_items
    ADD CONSTRAINT factory_order_items_factory_order_id_fkey FOREIGN KEY (factory_order_id) REFERENCES public.factory_orders(id) ON DELETE CASCADE;


--
-- Name: factory_order_items factory_order_items_sku_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.factory_order_items
    ADD CONSTRAINT factory_order_items_sku_id_fkey FOREIGN KEY (sku_id) REFERENCES public.product_skus(id);


--
-- Name: factory_orders factory_orders_canceled_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.factory_orders
    ADD CONSTRAINT factory_orders_canceled_by_fkey FOREIGN KEY (canceled_by) REFERENCES public.profiles(id) ON DELETE RESTRICT;


--
-- Name: factory_orders factory_orders_parent_factory_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.factory_orders
    ADD CONSTRAINT factory_orders_parent_factory_order_id_fkey FOREIGN KEY (parent_factory_order_id) REFERENCES public.factory_orders(id) ON DELETE SET NULL;


--
-- Name: factory_orders factory_orders_ship_via_supplier_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.factory_orders
    ADD CONSTRAINT factory_orders_ship_via_supplier_id_fkey FOREIGN KEY (ship_via_supplier_id) REFERENCES public.suppliers(id) ON DELETE RESTRICT;


--
-- Name: factory_orders factory_orders_supplier_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.factory_orders
    ADD CONSTRAINT factory_orders_supplier_id_fkey FOREIGN KEY (supplier_id) REFERENCES public.suppliers(id) ON DELETE RESTRICT;


--
-- Name: freight_line_items freight_line_items_freight_shipment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.freight_line_items
    ADD CONSTRAINT freight_line_items_freight_shipment_id_fkey FOREIGN KEY (freight_shipment_id) REFERENCES public.freight_shipments(id) ON DELETE CASCADE;


--
-- Name: freight_line_items freight_line_items_sku_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.freight_line_items
    ADD CONSTRAINT freight_line_items_sku_id_fkey FOREIGN KEY (sku_id) REFERENCES public.product_skus(id);


--
-- Name: freight_line_items freight_line_items_source_factory_order_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.freight_line_items
    ADD CONSTRAINT freight_line_items_source_factory_order_item_id_fkey FOREIGN KEY (source_factory_order_item_id) REFERENCES public.factory_order_items(id) ON DELETE RESTRICT;


--
-- Name: freight_shipments freight_shipments_created_by_supplier_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.freight_shipments
    ADD CONSTRAINT freight_shipments_created_by_supplier_user_id_fkey FOREIGN KEY (created_by_supplier_user_id) REFERENCES public.profiles(id) ON DELETE RESTRICT;


--
-- Name: freight_shipments freight_shipments_origin_supplier_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.freight_shipments
    ADD CONSTRAINT freight_shipments_origin_supplier_id_fkey FOREIGN KEY (origin_supplier_id) REFERENCES public.suppliers(id) ON DELETE RESTRICT;


--
-- Name: freight_shipments freight_shipments_status_overridden_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.freight_shipments
    ADD CONSTRAINT freight_shipments_status_overridden_by_fkey FOREIGN KEY (status_overridden_by) REFERENCES public.profiles(id);


--
-- Name: inventory_levels inventory_levels_location_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.inventory_levels
    ADD CONSTRAINT inventory_levels_location_id_fkey FOREIGN KEY (location_id) REFERENCES public.locations(id) ON DELETE RESTRICT;


--
-- Name: inventory_levels inventory_levels_sku_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.inventory_levels
    ADD CONSTRAINT inventory_levels_sku_id_fkey FOREIGN KEY (sku_id) REFERENCES public.product_skus(id) ON DELETE RESTRICT;


--
-- Name: inventory_transactions inventory_transactions_performed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.inventory_transactions
    ADD CONSTRAINT inventory_transactions_performed_by_fkey FOREIGN KEY (performed_by) REFERENCES public.profiles(id);


--
-- Name: inventory_transactions inventory_transactions_sku_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.inventory_transactions
    ADD CONSTRAINT inventory_transactions_sku_id_fkey FOREIGN KEY (sku_id) REFERENCES public.product_skus(id);


--
-- Name: locations locations_owner_supplier_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.locations
    ADD CONSTRAINT locations_owner_supplier_id_fkey FOREIGN KEY (owner_supplier_id) REFERENCES public.suppliers(id) ON DELETE RESTRICT;


--
-- Name: product_boms product_boms_assembled_at_supplier_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.product_boms
    ADD CONSTRAINT product_boms_assembled_at_supplier_id_fkey FOREIGN KEY (assembled_at_supplier_id) REFERENCES public.suppliers(id) ON DELETE RESTRICT;


--
-- Name: product_boms product_boms_component_location_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.product_boms
    ADD CONSTRAINT product_boms_component_location_id_fkey FOREIGN KEY (component_location_id) REFERENCES public.locations(id) ON DELETE RESTRICT;


--
-- Name: product_boms product_boms_component_sku_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.product_boms
    ADD CONSTRAINT product_boms_component_sku_id_fkey FOREIGN KEY (component_sku_id) REFERENCES public.product_skus(id) ON DELETE RESTRICT;


--
-- Name: product_boms product_boms_parent_sku_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.product_boms
    ADD CONSTRAINT product_boms_parent_sku_id_fkey FOREIGN KEY (parent_sku_id) REFERENCES public.product_skus(id) ON DELETE RESTRICT;


--
-- Name: product_skus product_skus_archived_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.product_skus
    ADD CONSTRAINT product_skus_archived_by_fkey FOREIGN KEY (archived_by) REFERENCES public.profiles(id);


--
-- Name: profiles profiles_homebase_linked_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_homebase_linked_by_fkey FOREIGN KEY (homebase_linked_by) REFERENCES public.profiles(id);


--
-- Name: profiles profiles_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: profiles profiles_supplier_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_supplier_id_fkey FOREIGN KEY (supplier_id) REFERENCES public.suppliers(id) ON DELETE RESTRICT;


--
-- Name: shipment_variances shipment_variances_acknowledged_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.shipment_variances
    ADD CONSTRAINT shipment_variances_acknowledged_by_fkey FOREIGN KEY (acknowledged_by) REFERENCES public.profiles(id) ON DELETE RESTRICT;


--
-- Name: shipment_variances shipment_variances_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.shipment_variances
    ADD CONSTRAINT shipment_variances_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE RESTRICT;


--
-- Name: shipment_variances shipment_variances_freight_line_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.shipment_variances
    ADD CONSTRAINT shipment_variances_freight_line_item_id_fkey FOREIGN KEY (freight_line_item_id) REFERENCES public.freight_line_items(id) ON DELETE RESTRICT;


--
-- Name: shipment_variances shipment_variances_origin_supplier_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.shipment_variances
    ADD CONSTRAINT shipment_variances_origin_supplier_id_fkey FOREIGN KEY (origin_supplier_id) REFERENCES public.suppliers(id) ON DELETE RESTRICT;


--
-- Name: shipment_variances shipment_variances_resolved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.shipment_variances
    ADD CONSTRAINT shipment_variances_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES public.profiles(id) ON DELETE RESTRICT;


--
-- Name: shipment_variances shipment_variances_shipment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.shipment_variances
    ADD CONSTRAINT shipment_variances_shipment_id_fkey FOREIGN KEY (shipment_id) REFERENCES public.freight_shipments(id) ON DELETE RESTRICT;


--
-- Name: shipment_variances shipment_variances_sku_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.shipment_variances
    ADD CONSTRAINT shipment_variances_sku_id_fkey FOREIGN KEY (sku_id) REFERENCES public.product_skus(id) ON DELETE RESTRICT;


--
-- Name: shipstation_order_items shipstation_order_items_shipstation_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.shipstation_order_items
    ADD CONSTRAINT shipstation_order_items_shipstation_order_id_fkey FOREIGN KEY (shipstation_order_id) REFERENCES public.shipstation_orders(id) ON DELETE CASCADE;


--
-- Name: shipstation_order_items shipstation_order_items_sku_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.shipstation_order_items
    ADD CONSTRAINT shipstation_order_items_sku_id_fkey FOREIGN KEY (sku_id) REFERENCES public.product_skus(id) ON DELETE RESTRICT;


--
-- Name: shipstation_webhook_events shipstation_webhook_events_resulting_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.shipstation_webhook_events
    ADD CONSTRAINT shipstation_webhook_events_resulting_order_id_fkey FOREIGN KEY (resulting_order_id) REFERENCES public.shipstation_orders(id);


--
-- Name: sku_economics sku_economics_sku_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.sku_economics
    ADD CONSTRAINT sku_economics_sku_id_fkey FOREIGN KEY (sku_id) REFERENCES public.product_skus(id) ON DELETE RESTRICT;


--
-- Name: sku_supplier_costs sku_supplier_costs_sku_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.sku_supplier_costs
    ADD CONSTRAINT sku_supplier_costs_sku_id_fkey FOREIGN KEY (sku_id) REFERENCES public.product_skus(id) ON DELETE CASCADE;


--
-- Name: sku_supplier_costs sku_supplier_costs_supplier_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.sku_supplier_costs
    ADD CONSTRAINT sku_supplier_costs_supplier_id_fkey FOREIGN KEY (supplier_id) REFERENCES public.suppliers(id) ON DELETE RESTRICT;


--
-- Name: task_logs task_logs_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.task_logs
    ADD CONSTRAINT task_logs_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.profiles(id);


--
-- Name: task_logs task_logs_sku_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.task_logs
    ADD CONSTRAINT task_logs_sku_id_fkey FOREIGN KEY (sku_id) REFERENCES public.product_skus(id);


--
-- Name: product_skus Admins can manage SKUs; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Admins can manage SKUs" ON public.product_skus TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = ANY (ARRAY['admin'::text, 'manager'::text]))))));


--
-- Name: demand_overrides Admins can manage demand overrides; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Admins can manage demand overrides" ON public.demand_overrides TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = ANY (ARRAY['admin'::text, 'manager'::text]))))));


--
-- Name: sku_economics Admins can manage economics; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Admins can manage economics" ON public.sku_economics TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = ANY (ARRAY['admin'::text, 'manager'::text]))))));


--
-- Name: factory_order_items Admins can manage factory order items; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Admins can manage factory order items" ON public.factory_order_items TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = ANY (ARRAY['admin'::text, 'manager'::text]))))));


--
-- Name: factory_orders Admins can manage factory orders; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Admins can manage factory orders" ON public.factory_orders TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = ANY (ARRAY['admin'::text, 'manager'::text]))))));


--
-- Name: freight_shipments Admins can manage freight; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Admins can manage freight" ON public.freight_shipments TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = ANY (ARRAY['admin'::text, 'manager'::text]))))));


--
-- Name: freight_line_items Admins can manage freight items; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Admins can manage freight items" ON public.freight_line_items TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = ANY (ARRAY['admin'::text, 'manager'::text]))))));


--
-- Name: inventory_levels Admins can manage inventory; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Admins can manage inventory" ON public.inventory_levels TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = ANY (ARRAY['admin'::text, 'manager'::text]))))));


--
-- Name: locations Admins can manage locations; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Admins can manage locations" ON public.locations TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = ANY (ARRAY['admin'::text, 'manager'::text]))))));


--
-- Name: sku_supplier_costs Admins can manage sku supplier costs; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Admins can manage sku supplier costs" ON public.sku_supplier_costs TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = ANY (ARRAY['admin'::text, 'manager'::text])))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = ANY (ARRAY['admin'::text, 'manager'::text]))))));


--
-- Name: suppliers Admins can manage suppliers; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Admins can manage suppliers" ON public.suppliers TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = ANY (ARRAY['admin'::text, 'manager'::text]))))));


--
-- Name: shipstation_webhook_events Admins can read webhook events; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Admins can read webhook events" ON public.shipstation_webhook_events FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text)))));


--
-- Name: inventory_transactions Authenticated can insert inv transactions; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Authenticated can insert inv transactions" ON public.inventory_transactions FOR INSERT TO authenticated WITH CHECK (((performed_by = auth.uid()) OR (performed_by IS NULL)));


--
-- Name: task_logs Authenticated can insert task logs; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Authenticated can insert task logs" ON public.task_logs FOR INSERT TO authenticated WITH CHECK ((employee_id = auth.uid()));


--
-- Name: product_skus Authenticated can read SKUs; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Authenticated can read SKUs" ON public.product_skus FOR SELECT TO authenticated USING (true);


--
-- Name: demand_overrides Authenticated can read demand overrides; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Authenticated can read demand overrides" ON public.demand_overrides FOR SELECT TO authenticated USING (true);


--
-- Name: sku_economics Authenticated can read economics; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Authenticated can read economics" ON public.sku_economics FOR SELECT TO authenticated USING (true);


--
-- Name: inventory_transactions Authenticated can read inv transactions; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Authenticated can read inv transactions" ON public.inventory_transactions FOR SELECT TO authenticated USING (true);


--
-- Name: inventory_levels Authenticated can read inventory; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Authenticated can read inventory" ON public.inventory_levels FOR SELECT TO authenticated USING (true);


--
-- Name: labor_hours_daily Authenticated can read labor hours; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Authenticated can read labor hours" ON public.labor_hours_daily FOR SELECT TO authenticated USING (true);


--
-- Name: locations Authenticated can read locations; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Authenticated can read locations" ON public.locations FOR SELECT TO authenticated USING (true);


--
-- Name: shipstation_order_items Authenticated can read shipstation items; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Authenticated can read shipstation items" ON public.shipstation_order_items FOR SELECT TO authenticated USING (true);


--
-- Name: shipstation_orders Authenticated can read shipstation orders; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Authenticated can read shipstation orders" ON public.shipstation_orders FOR SELECT TO authenticated USING (true);


--
-- Name: sku_supplier_costs Authenticated can read sku supplier costs; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Authenticated can read sku supplier costs" ON public.sku_supplier_costs FOR SELECT TO authenticated USING (true);


--
-- Name: suppliers Authenticated can read suppliers; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Authenticated can read suppliers" ON public.suppliers FOR SELECT TO authenticated USING (true);


--
-- Name: shipstation_sync_runs Authenticated can read sync runs; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Authenticated can read sync runs" ON public.shipstation_sync_runs FOR SELECT TO authenticated USING (true);


--
-- Name: task_logs Authenticated can read task logs; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Authenticated can read task logs" ON public.task_logs FOR SELECT TO authenticated USING (true);


--
-- Name: profiles Authenticated users can read profiles; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Authenticated users can read profiles" ON public.profiles FOR SELECT TO authenticated USING (true);


--
-- Name: profiles Users can update own profile; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Users can update own profile" ON public.profiles FOR UPDATE TO authenticated USING ((auth.uid() = id));


--
-- Name: audit_logs; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

--
-- Name: component_breakage_reports; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.component_breakage_reports ENABLE ROW LEVEL SECURITY;

--
-- Name: demand_overrides; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.demand_overrides ENABLE ROW LEVEL SECURITY;

--
-- Name: factory_order_items; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.factory_order_items ENABLE ROW LEVEL SECURITY;

--
-- Name: factory_orders; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.factory_orders ENABLE ROW LEVEL SECURITY;

--
-- Name: freight_line_items; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.freight_line_items ENABLE ROW LEVEL SECURITY;

--
-- Name: freight_shipments; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.freight_shipments ENABLE ROW LEVEL SECURITY;

--
-- Name: audit_logs internal_select_audit_logs; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY internal_select_audit_logs ON public.audit_logs FOR SELECT TO authenticated USING (public.jwt_is_internal());


--
-- Name: product_boms internal_select_product_boms; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY internal_select_product_boms ON public.product_boms FOR SELECT TO authenticated USING (public.jwt_is_internal());


--
-- Name: inventory_levels; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.inventory_levels ENABLE ROW LEVEL SECURITY;

--
-- Name: inventory_transactions; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.inventory_transactions ENABLE ROW LEVEL SECURITY;

--
-- Name: labor_hours_daily; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.labor_hours_daily ENABLE ROW LEVEL SECURITY;

--
-- Name: locations; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.locations ENABLE ROW LEVEL SECURITY;

--
-- Name: product_boms; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.product_boms ENABLE ROW LEVEL SECURITY;

--
-- Name: product_skus; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.product_skus ENABLE ROW LEVEL SECURITY;

--
-- Name: profiles; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

--
-- Name: shipment_variances; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.shipment_variances ENABLE ROW LEVEL SECURITY;

--
-- Name: shipstation_order_items; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.shipstation_order_items ENABLE ROW LEVEL SECURITY;

--
-- Name: shipstation_orders; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.shipstation_orders ENABLE ROW LEVEL SECURITY;

--
-- Name: shipstation_sync_runs; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.shipstation_sync_runs ENABLE ROW LEVEL SECURITY;

--
-- Name: shipstation_webhook_events; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.shipstation_webhook_events ENABLE ROW LEVEL SECURITY;

--
-- Name: sku_economics; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.sku_economics ENABLE ROW LEVEL SECURITY;

--
-- Name: sku_supplier_costs; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.sku_supplier_costs ENABLE ROW LEVEL SECURITY;

--
-- Name: component_breakage_reports supplier_insert_breakage_reports_as_reporter; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY supplier_insert_breakage_reports_as_reporter ON public.component_breakage_reports FOR INSERT TO authenticated WITH CHECK (((reporter_supplier_id = public.jwt_supplier_id()) AND (created_by = auth.uid()) AND (status = 'open'::text)));


--
-- Name: factory_orders supplier_insert_own_factory_orders; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY supplier_insert_own_factory_orders ON public.factory_orders FOR INSERT TO authenticated WITH CHECK (((supplier_id = public.jwt_supplier_id()) AND (status = 'ordered'::text)));


--
-- Name: factory_order_items supplier_insert_own_foi; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY supplier_insert_own_foi ON public.factory_order_items FOR INSERT TO authenticated WITH CHECK (((EXISTS ( SELECT 1
   FROM public.factory_orders fo
  WHERE ((fo.id = factory_order_items.factory_order_id) AND (fo.supplier_id = public.jwt_supplier_id()) AND (fo.status = 'ordered'::text)))) AND (consolidator_confirmed_quantity IS NULL) AND (consolidator_confirmed_at IS NULL) AND (consolidator_confirmed_by IS NULL) AND (quantity_breakage = 0)));


--
-- Name: freight_line_items supplier_insert_own_freight_lines; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY supplier_insert_own_freight_lines ON public.freight_line_items FOR INSERT TO authenticated WITH CHECK (((EXISTS ( SELECT 1
   FROM public.freight_shipments s
  WHERE ((s.id = freight_line_items.freight_shipment_id) AND (s.origin_supplier_id = public.jwt_supplier_id()) AND (s.status = ANY (ARRAY['pending'::text, 'on_the_water'::text]))))) AND (supplier_declared_quantity IS NOT NULL) AND (quantity = supplier_declared_quantity)));


--
-- Name: freight_shipments supplier_insert_own_shipments; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY supplier_insert_own_shipments ON public.freight_shipments FOR INSERT TO authenticated WITH CHECK (((origin_supplier_id = public.jwt_supplier_id()) AND (created_by_supplier_user_id = auth.uid()) AND (status = ANY (ARRAY['pending'::text, 'on_the_water'::text]))));


--
-- Name: product_boms supplier_select_assembled_boms; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY supplier_select_assembled_boms ON public.product_boms FOR SELECT TO authenticated USING ((assembled_at_supplier_id = ANY (public.jwt_supplier_scope())));


--
-- Name: suppliers supplier_select_in_scope; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY supplier_select_in_scope ON public.suppliers FOR SELECT TO authenticated USING ((id = ANY (public.jwt_supplier_scope())));


--
-- Name: factory_orders supplier_select_in_scope_factory_orders; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY supplier_select_in_scope_factory_orders ON public.factory_orders FOR SELECT TO authenticated USING (((supplier_id = ANY (public.jwt_supplier_scope())) OR (ship_via_supplier_id = ANY (public.jwt_supplier_scope()))));


--
-- Name: factory_order_items supplier_select_in_scope_foi; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY supplier_select_in_scope_foi ON public.factory_order_items FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.factory_orders fo
  WHERE ((fo.id = factory_order_items.factory_order_id) AND ((fo.supplier_id = ANY (public.jwt_supplier_scope())) OR (fo.ship_via_supplier_id = ANY (public.jwt_supplier_scope())))))));


--
-- Name: audit_logs supplier_select_own_audit_logs; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY supplier_select_own_audit_logs ON public.audit_logs FOR SELECT TO authenticated USING ((actor_id = auth.uid()));


--
-- Name: component_breakage_reports supplier_select_own_breakage_reports; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY supplier_select_own_breakage_reports ON public.component_breakage_reports FOR SELECT TO authenticated USING (((producing_supplier_id = ANY (public.jwt_supplier_scope())) OR (reporter_supplier_id = ANY (public.jwt_supplier_scope()))));


--
-- Name: freight_line_items supplier_select_own_freight_lines; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY supplier_select_own_freight_lines ON public.freight_line_items FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.freight_shipments s
  WHERE ((s.id = freight_line_items.freight_shipment_id) AND (s.origin_supplier_id = ANY (public.jwt_supplier_scope()))))));


--
-- Name: inventory_levels supplier_select_own_inventory; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY supplier_select_own_inventory ON public.inventory_levels FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.locations l
  WHERE ((l.id = inventory_levels.location_id) AND (l.owner_supplier_id = ANY (public.jwt_supplier_scope()))))));


--
-- Name: locations supplier_select_own_locations; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY supplier_select_own_locations ON public.locations FOR SELECT TO authenticated USING ((owner_supplier_id = ANY (public.jwt_supplier_scope())));


--
-- Name: profiles supplier_select_own_profile; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY supplier_select_own_profile ON public.profiles FOR SELECT TO authenticated USING ((id = auth.uid()));


--
-- Name: freight_shipments supplier_select_own_shipments; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY supplier_select_own_shipments ON public.freight_shipments FOR SELECT TO authenticated USING ((origin_supplier_id = ANY (public.jwt_supplier_scope())));


--
-- Name: shipment_variances supplier_select_own_variances; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY supplier_select_own_variances ON public.shipment_variances FOR SELECT TO authenticated USING ((origin_supplier_id = ANY (public.jwt_supplier_scope())));


--
-- Name: product_skus supplier_select_related_skus; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY supplier_select_related_skus ON public.product_skus FOR SELECT TO authenticated USING (((public.jwt_supplier_id() IS NOT NULL) AND ((EXISTS ( SELECT 1
   FROM (public.factory_order_items foi
     JOIN public.factory_orders fo ON ((fo.id = foi.factory_order_id)))
  WHERE ((foi.sku_id = product_skus.id) AND (fo.supplier_id = ANY (public.jwt_supplier_scope()))))) OR (EXISTS ( SELECT 1
   FROM public.product_boms b
  WHERE ((b.component_sku_id = product_skus.id) AND (b.assembled_at_supplier_id = ANY (public.jwt_supplier_scope())) AND (b.effective_until IS NULL)))) OR (EXISTS ( SELECT 1
   FROM public.product_boms b
  WHERE ((b.parent_sku_id = product_skus.id) AND (b.assembled_at_supplier_id = ANY (public.jwt_supplier_scope())) AND (b.effective_until IS NULL)))))));


--
-- Name: suppliers; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.suppliers ENABLE ROW LEVEL SECURITY;

--
-- Name: task_logs; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.task_logs ENABLE ROW LEVEL SECURITY;

--
-- Name: SCHEMA public; Type: ACL; Schema: -; Owner: pg_database_owner
--

GRANT USAGE ON SCHEMA public TO postgres;
GRANT USAGE ON SCHEMA public TO anon;
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT USAGE ON SCHEMA public TO service_role;


--
-- Name: FUNCTION _default_location_id(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public._default_location_id() TO anon;
GRANT ALL ON FUNCTION public._default_location_id() TO authenticated;
GRANT ALL ON FUNCTION public._default_location_id() TO service_role;


--
-- Name: FUNCTION _task_type_movement(p_task_type text); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public._task_type_movement(p_task_type text) TO anon;
GRANT ALL ON FUNCTION public._task_type_movement(p_task_type text) TO authenticated;
GRANT ALL ON FUNCTION public._task_type_movement(p_task_type text) TO service_role;


--
-- Name: FUNCTION archive_sku(p_sku_id uuid, p_actor_id uuid, p_reason text); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.archive_sku(p_sku_id uuid, p_actor_id uuid, p_reason text) TO anon;
GRANT ALL ON FUNCTION public.archive_sku(p_sku_id uuid, p_actor_id uuid, p_reason text) TO authenticated;
GRANT ALL ON FUNCTION public.archive_sku(p_sku_id uuid, p_actor_id uuid, p_reason text) TO service_role;


--
-- Name: FUNCTION archive_sku_force(p_sku_id uuid, p_actor_id uuid, p_reason text); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.archive_sku_force(p_sku_id uuid, p_actor_id uuid, p_reason text) TO anon;
GRANT ALL ON FUNCTION public.archive_sku_force(p_sku_id uuid, p_actor_id uuid, p_reason text) TO authenticated;
GRANT ALL ON FUNCTION public.archive_sku_force(p_sku_id uuid, p_actor_id uuid, p_reason text) TO service_role;


--
-- Name: FUNCTION audit_hash_chain(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.audit_hash_chain() TO anon;
GRANT ALL ON FUNCTION public.audit_hash_chain() TO authenticated;
GRANT ALL ON FUNCTION public.audit_hash_chain() TO service_role;


--
-- Name: FUNCTION block_audit_logs_mutation(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.block_audit_logs_mutation() TO anon;
GRANT ALL ON FUNCTION public.block_audit_logs_mutation() TO authenticated;
GRANT ALL ON FUNCTION public.block_audit_logs_mutation() TO service_role;


--
-- Name: FUNCTION block_audit_mutation(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.block_audit_mutation() TO anon;
GRANT ALL ON FUNCTION public.block_audit_mutation() TO authenticated;
GRANT ALL ON FUNCTION public.block_audit_mutation() TO service_role;


--
-- Name: FUNCTION block_breakage_report_delete(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.block_breakage_report_delete() TO anon;
GRANT ALL ON FUNCTION public.block_breakage_report_delete() TO authenticated;
GRANT ALL ON FUNCTION public.block_breakage_report_delete() TO service_role;


--
-- Name: FUNCTION block_direct_role_update(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.block_direct_role_update() TO anon;
GRANT ALL ON FUNCTION public.block_direct_role_update() TO authenticated;
GRANT ALL ON FUNCTION public.block_direct_role_update() TO service_role;


--
-- Name: FUNCTION block_shipment_variance_delete(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.block_shipment_variance_delete() TO anon;
GRANT ALL ON FUNCTION public.block_shipment_variance_delete() TO authenticated;
GRANT ALL ON FUNCTION public.block_shipment_variance_delete() TO service_role;


--
-- Name: FUNCTION block_sku_hard_delete(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.block_sku_hard_delete() TO anon;
GRANT ALL ON FUNCTION public.block_sku_hard_delete() TO authenticated;
GRANT ALL ON FUNCTION public.block_sku_hard_delete() TO service_role;


--
-- Name: FUNCTION block_task_log_mutation(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.block_task_log_mutation() TO anon;
GRANT ALL ON FUNCTION public.block_task_log_mutation() TO authenticated;
GRANT ALL ON FUNCTION public.block_task_log_mutation() TO service_role;


--
-- Name: FUNCTION bump_row_version(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.bump_row_version() TO anon;
GRANT ALL ON FUNCTION public.bump_row_version() TO authenticated;
GRANT ALL ON FUNCTION public.bump_row_version() TO service_role;


--
-- Name: FUNCTION check_bom_no_cycle(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.check_bom_no_cycle() TO anon;
GRANT ALL ON FUNCTION public.check_bom_no_cycle() TO authenticated;
GRANT ALL ON FUNCTION public.check_bom_no_cycle() TO service_role;


--
-- Name: FUNCTION check_shipped_factory_order_has_cost(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.check_shipped_factory_order_has_cost() TO anon;
GRANT ALL ON FUNCTION public.check_shipped_factory_order_has_cost() TO authenticated;
GRANT ALL ON FUNCTION public.check_shipped_factory_order_has_cost() TO service_role;


--
-- Name: FUNCTION enforce_breakage_report_append_only(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.enforce_breakage_report_append_only() TO anon;
GRANT ALL ON FUNCTION public.enforce_breakage_report_append_only() TO authenticated;
GRANT ALL ON FUNCTION public.enforce_breakage_report_append_only() TO service_role;


--
-- Name: FUNCTION enforce_breakage_reporter_consolidates(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.enforce_breakage_reporter_consolidates() TO anon;
GRANT ALL ON FUNCTION public.enforce_breakage_reporter_consolidates() TO authenticated;
GRANT ALL ON FUNCTION public.enforce_breakage_reporter_consolidates() TO service_role;


--
-- Name: FUNCTION enforce_shipment_variance_append_only(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.enforce_shipment_variance_append_only() TO anon;
GRANT ALL ON FUNCTION public.enforce_shipment_variance_append_only() TO authenticated;
GRANT ALL ON FUNCTION public.enforce_shipment_variance_append_only() TO service_role;


--
-- Name: FUNCTION handle_new_user(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.handle_new_user() TO anon;
GRANT ALL ON FUNCTION public.handle_new_user() TO authenticated;
GRANT ALL ON FUNCTION public.handle_new_user() TO service_role;


--
-- Name: FUNCTION jwt_is_internal(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.jwt_is_internal() TO anon;
GRANT ALL ON FUNCTION public.jwt_is_internal() TO authenticated;
GRANT ALL ON FUNCTION public.jwt_is_internal() TO service_role;


--
-- Name: FUNCTION jwt_supplier_id(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.jwt_supplier_id() TO anon;
GRANT ALL ON FUNCTION public.jwt_supplier_id() TO authenticated;
GRANT ALL ON FUNCTION public.jwt_supplier_id() TO service_role;


--
-- Name: FUNCTION jwt_supplier_scope(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.jwt_supplier_scope() TO anon;
GRANT ALL ON FUNCTION public.jwt_supplier_scope() TO authenticated;
GRANT ALL ON FUNCTION public.jwt_supplier_scope() TO service_role;


--
-- Name: FUNCTION prevent_freight_status_regression(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.prevent_freight_status_regression() TO anon;
GRANT ALL ON FUNCTION public.prevent_freight_status_regression() TO authenticated;
GRANT ALL ON FUNCTION public.prevent_freight_status_regression() TO service_role;


--
-- Name: FUNCTION restore_sku(p_sku_id uuid, p_actor_id uuid); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.restore_sku(p_sku_id uuid, p_actor_id uuid) TO anon;
GRANT ALL ON FUNCTION public.restore_sku(p_sku_id uuid, p_actor_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.restore_sku(p_sku_id uuid, p_actor_id uuid) TO service_role;


--
-- Name: FUNCTION rpc_acknowledge_breakage_report(p_report_id uuid, p_dispute boolean); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.rpc_acknowledge_breakage_report(p_report_id uuid, p_dispute boolean) TO anon;
GRANT ALL ON FUNCTION public.rpc_acknowledge_breakage_report(p_report_id uuid, p_dispute boolean) TO authenticated;
GRANT ALL ON FUNCTION public.rpc_acknowledge_breakage_report(p_report_id uuid, p_dispute boolean) TO service_role;


--
-- Name: FUNCTION rpc_acknowledge_shipment_variance(p_variance_id uuid); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.rpc_acknowledge_shipment_variance(p_variance_id uuid) TO anon;
GRANT ALL ON FUNCTION public.rpc_acknowledge_shipment_variance(p_variance_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.rpc_acknowledge_shipment_variance(p_variance_id uuid) TO service_role;


--
-- Name: FUNCTION rpc_admin_link_factory_order_to_parent(p_child_order_id uuid, p_parent_order_id uuid); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.rpc_admin_link_factory_order_to_parent(p_child_order_id uuid, p_parent_order_id uuid) TO anon;
GRANT ALL ON FUNCTION public.rpc_admin_link_factory_order_to_parent(p_child_order_id uuid, p_parent_order_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.rpc_admin_link_factory_order_to_parent(p_child_order_id uuid, p_parent_order_id uuid) TO service_role;


--
-- Name: FUNCTION rpc_admin_unlink_factory_order_from_parent(p_child_order_id uuid); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.rpc_admin_unlink_factory_order_from_parent(p_child_order_id uuid) TO anon;
GRANT ALL ON FUNCTION public.rpc_admin_unlink_factory_order_from_parent(p_child_order_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.rpc_admin_unlink_factory_order_from_parent(p_child_order_id uuid) TO service_role;


--
-- Name: FUNCTION rpc_apply_freight_delivery(p_shipment_id uuid, p_actor_id uuid); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.rpc_apply_freight_delivery(p_shipment_id uuid, p_actor_id uuid) TO anon;
GRANT ALL ON FUNCTION public.rpc_apply_freight_delivery(p_shipment_id uuid, p_actor_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.rpc_apply_freight_delivery(p_shipment_id uuid, p_actor_id uuid) TO service_role;


--
-- Name: FUNCTION rpc_apply_freight_status_override(p_shipment_id uuid, p_new_status text, p_actor_id uuid, p_expected_version integer, p_reason text); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.rpc_apply_freight_status_override(p_shipment_id uuid, p_new_status text, p_actor_id uuid, p_expected_version integer, p_reason text) TO anon;
GRANT ALL ON FUNCTION public.rpc_apply_freight_status_override(p_shipment_id uuid, p_new_status text, p_actor_id uuid, p_expected_version integer, p_reason text) TO authenticated;
GRANT ALL ON FUNCTION public.rpc_apply_freight_status_override(p_shipment_id uuid, p_new_status text, p_actor_id uuid, p_expected_version integer, p_reason text) TO service_role;


--
-- Name: FUNCTION rpc_apply_shipstation_sale(p_order_id uuid, p_system_actor_id uuid); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.rpc_apply_shipstation_sale(p_order_id uuid, p_system_actor_id uuid) TO anon;
GRANT ALL ON FUNCTION public.rpc_apply_shipstation_sale(p_order_id uuid, p_system_actor_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.rpc_apply_shipstation_sale(p_order_id uuid, p_system_actor_id uuid) TO service_role;


--
-- Name: FUNCTION rpc_bulk_cycle_count(p_adjustments jsonb, p_reason text, p_notes text, p_actor_id uuid); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.rpc_bulk_cycle_count(p_adjustments jsonb, p_reason text, p_notes text, p_actor_id uuid) TO anon;
GRANT ALL ON FUNCTION public.rpc_bulk_cycle_count(p_adjustments jsonb, p_reason text, p_notes text, p_actor_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.rpc_bulk_cycle_count(p_adjustments jsonb, p_reason text, p_notes text, p_actor_id uuid) TO service_role;


--
-- Name: FUNCTION rpc_clear_freight_status_override(p_shipment_id uuid, p_actor_id uuid, p_expected_version integer); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.rpc_clear_freight_status_override(p_shipment_id uuid, p_actor_id uuid, p_expected_version integer) TO anon;
GRANT ALL ON FUNCTION public.rpc_clear_freight_status_override(p_shipment_id uuid, p_actor_id uuid, p_expected_version integer) TO authenticated;
GRANT ALL ON FUNCTION public.rpc_clear_freight_status_override(p_shipment_id uuid, p_actor_id uuid, p_expected_version integer) TO service_role;


--
-- Name: FUNCTION rpc_consolidator_confirm_factory_order_receive(p_payload jsonb); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.rpc_consolidator_confirm_factory_order_receive(p_payload jsonb) TO anon;
GRANT ALL ON FUNCTION public.rpc_consolidator_confirm_factory_order_receive(p_payload jsonb) TO authenticated;
GRANT ALL ON FUNCTION public.rpc_consolidator_confirm_factory_order_receive(p_payload jsonb) TO service_role;


--
-- Name: FUNCTION rpc_cycle_count(p_sku_id uuid, p_field text, p_delta integer, p_reason text, p_notes text, p_actor_id uuid); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.rpc_cycle_count(p_sku_id uuid, p_field text, p_delta integer, p_reason text, p_notes text, p_actor_id uuid) TO anon;
GRANT ALL ON FUNCTION public.rpc_cycle_count(p_sku_id uuid, p_field text, p_delta integer, p_reason text, p_notes text, p_actor_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.rpc_cycle_count(p_sku_id uuid, p_field text, p_delta integer, p_reason text, p_notes text, p_actor_id uuid) TO service_role;


--
-- Name: FUNCTION rpc_factory_order_component_status(p_factory_order_id uuid); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.rpc_factory_order_component_status(p_factory_order_id uuid) TO anon;
GRANT ALL ON FUNCTION public.rpc_factory_order_component_status(p_factory_order_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.rpc_factory_order_component_status(p_factory_order_id uuid) TO service_role;


--
-- Name: FUNCTION rpc_factory_order_component_status_batch(p_parent_order_ids uuid[]); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.rpc_factory_order_component_status_batch(p_parent_order_ids uuid[]) TO anon;
GRANT ALL ON FUNCTION public.rpc_factory_order_component_status_batch(p_parent_order_ids uuid[]) TO authenticated;
GRANT ALL ON FUNCTION public.rpc_factory_order_component_status_batch(p_parent_order_ids uuid[]) TO service_role;


--
-- Name: FUNCTION rpc_file_component_breakage_report(p_factory_order_item_id uuid, p_quantity_broken integer, p_reason_category text, p_description text); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.rpc_file_component_breakage_report(p_factory_order_item_id uuid, p_quantity_broken integer, p_reason_category text, p_description text) TO anon;
GRANT ALL ON FUNCTION public.rpc_file_component_breakage_report(p_factory_order_item_id uuid, p_quantity_broken integer, p_reason_category text, p_description text) TO authenticated;
GRANT ALL ON FUNCTION public.rpc_file_component_breakage_report(p_factory_order_item_id uuid, p_quantity_broken integer, p_reason_category text, p_description text) TO service_role;


--
-- Name: FUNCTION rpc_log_task_completion(p_sku_id uuid, p_task_type text, p_quantity integer, p_notes text, p_actor_id uuid, p_time_started timestamp with time zone, p_time_completed timestamp with time zone, p_location_id uuid); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.rpc_log_task_completion(p_sku_id uuid, p_task_type text, p_quantity integer, p_notes text, p_actor_id uuid, p_time_started timestamp with time zone, p_time_completed timestamp with time zone, p_location_id uuid) TO anon;
GRANT ALL ON FUNCTION public.rpc_log_task_completion(p_sku_id uuid, p_task_type text, p_quantity integer, p_notes text, p_actor_id uuid, p_time_started timestamp with time zone, p_time_completed timestamp with time zone, p_location_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.rpc_log_task_completion(p_sku_id uuid, p_task_type text, p_quantity integer, p_notes text, p_actor_id uuid, p_time_started timestamp with time zone, p_time_completed timestamp with time zone, p_location_id uuid) TO service_role;


--
-- Name: FUNCTION rpc_promote_user_to_supplier(p_target_user_id uuid, p_supplier_id uuid); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.rpc_promote_user_to_supplier(p_target_user_id uuid, p_supplier_id uuid) TO anon;
GRANT ALL ON FUNCTION public.rpc_promote_user_to_supplier(p_target_user_id uuid, p_supplier_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.rpc_promote_user_to_supplier(p_target_user_id uuid, p_supplier_id uuid) TO service_role;


--
-- Name: FUNCTION rpc_resolve_breakage_report(p_report_id uuid, p_resolution_notes text, p_replacement_factory_order_id uuid, p_write_off boolean); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.rpc_resolve_breakage_report(p_report_id uuid, p_resolution_notes text, p_replacement_factory_order_id uuid, p_write_off boolean) TO anon;
GRANT ALL ON FUNCTION public.rpc_resolve_breakage_report(p_report_id uuid, p_resolution_notes text, p_replacement_factory_order_id uuid, p_write_off boolean) TO authenticated;
GRANT ALL ON FUNCTION public.rpc_resolve_breakage_report(p_report_id uuid, p_resolution_notes text, p_replacement_factory_order_id uuid, p_write_off boolean) TO service_role;


--
-- Name: FUNCTION rpc_resolve_shipment_variance(p_variance_id uuid, p_resolution_notes text, p_write_off boolean); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.rpc_resolve_shipment_variance(p_variance_id uuid, p_resolution_notes text, p_write_off boolean) TO anon;
GRANT ALL ON FUNCTION public.rpc_resolve_shipment_variance(p_variance_id uuid, p_resolution_notes text, p_write_off boolean) TO authenticated;
GRANT ALL ON FUNCTION public.rpc_resolve_shipment_variance(p_variance_id uuid, p_resolution_notes text, p_write_off boolean) TO service_role;


--
-- Name: FUNCTION rpc_set_profile_active(p_target_user_id uuid, p_is_active boolean); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.rpc_set_profile_active(p_target_user_id uuid, p_is_active boolean) TO anon;
GRANT ALL ON FUNCTION public.rpc_set_profile_active(p_target_user_id uuid, p_is_active boolean) TO authenticated;
GRANT ALL ON FUNCTION public.rpc_set_profile_active(p_target_user_id uuid, p_is_active boolean) TO service_role;


--
-- Name: FUNCTION rpc_supplier_advance_factory_order(p_factory_order_id uuid, p_expected_version integer, p_notes text); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.rpc_supplier_advance_factory_order(p_factory_order_id uuid, p_expected_version integer, p_notes text) TO anon;
GRANT ALL ON FUNCTION public.rpc_supplier_advance_factory_order(p_factory_order_id uuid, p_expected_version integer, p_notes text) TO authenticated;
GRANT ALL ON FUNCTION public.rpc_supplier_advance_factory_order(p_factory_order_id uuid, p_expected_version integer, p_notes text) TO service_role;


--
-- Name: FUNCTION rpc_supplier_cancel_factory_order(p_factory_order_id uuid, p_expected_version integer, p_reason text); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.rpc_supplier_cancel_factory_order(p_factory_order_id uuid, p_expected_version integer, p_reason text) TO anon;
GRANT ALL ON FUNCTION public.rpc_supplier_cancel_factory_order(p_factory_order_id uuid, p_expected_version integer, p_reason text) TO authenticated;
GRANT ALL ON FUNCTION public.rpc_supplier_cancel_factory_order(p_factory_order_id uuid, p_expected_version integer, p_reason text) TO service_role;


--
-- Name: FUNCTION rpc_supplier_create_factory_order(p_payload jsonb); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.rpc_supplier_create_factory_order(p_payload jsonb) TO anon;
GRANT ALL ON FUNCTION public.rpc_supplier_create_factory_order(p_payload jsonb) TO authenticated;
GRANT ALL ON FUNCTION public.rpc_supplier_create_factory_order(p_payload jsonb) TO service_role;


--
-- Name: FUNCTION rpc_supplier_create_freight_shipment(p_payload jsonb); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.rpc_supplier_create_freight_shipment(p_payload jsonb) TO anon;
GRANT ALL ON FUNCTION public.rpc_supplier_create_freight_shipment(p_payload jsonb) TO authenticated;
GRANT ALL ON FUNCTION public.rpc_supplier_create_freight_shipment(p_payload jsonb) TO service_role;


--
-- Name: FUNCTION rpc_supplier_report_item_finished(p_factory_order_item_id uuid, p_quantity_finished integer, p_expected_version integer); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.rpc_supplier_report_item_finished(p_factory_order_item_id uuid, p_quantity_finished integer, p_expected_version integer) TO anon;
GRANT ALL ON FUNCTION public.rpc_supplier_report_item_finished(p_factory_order_item_id uuid, p_quantity_finished integer, p_expected_version integer) TO authenticated;
GRANT ALL ON FUNCTION public.rpc_supplier_report_item_finished(p_factory_order_item_id uuid, p_quantity_finished integer, p_expected_version integer) TO service_role;


--
-- Name: FUNCTION rpc_supplier_set_item_alternate_eta(p_factory_order_item_id uuid, p_alternate_eta date, p_expected_version integer); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.rpc_supplier_set_item_alternate_eta(p_factory_order_item_id uuid, p_alternate_eta date, p_expected_version integer) TO anon;
GRANT ALL ON FUNCTION public.rpc_supplier_set_item_alternate_eta(p_factory_order_item_id uuid, p_alternate_eta date, p_expected_version integer) TO authenticated;
GRANT ALL ON FUNCTION public.rpc_supplier_set_item_alternate_eta(p_factory_order_item_id uuid, p_alternate_eta date, p_expected_version integer) TO service_role;


--
-- Name: FUNCTION rpc_supplier_update_shipment_tracking(p_shipment_id uuid, p_expected_version integer, p_tracking_number text, p_carrier text, p_eta date, p_ship_date date, p_freight_cost numeric, p_clear_tracking_number boolean, p_clear_carrier boolean, p_clear_eta boolean, p_clear_ship_date boolean, p_clear_freight_cost boolean); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.rpc_supplier_update_shipment_tracking(p_shipment_id uuid, p_expected_version integer, p_tracking_number text, p_carrier text, p_eta date, p_ship_date date, p_freight_cost numeric, p_clear_tracking_number boolean, p_clear_carrier boolean, p_clear_eta boolean, p_clear_ship_date boolean, p_clear_freight_cost boolean) TO anon;
GRANT ALL ON FUNCTION public.rpc_supplier_update_shipment_tracking(p_shipment_id uuid, p_expected_version integer, p_tracking_number text, p_carrier text, p_eta date, p_ship_date date, p_freight_cost numeric, p_clear_tracking_number boolean, p_clear_carrier boolean, p_clear_eta boolean, p_clear_ship_date boolean, p_clear_freight_cost boolean) TO authenticated;
GRANT ALL ON FUNCTION public.rpc_supplier_update_shipment_tracking(p_shipment_id uuid, p_expected_version integer, p_tracking_number text, p_carrier text, p_eta date, p_ship_date date, p_freight_cost numeric, p_clear_tracking_number boolean, p_clear_carrier boolean, p_clear_eta boolean, p_clear_ship_date boolean, p_clear_freight_cost boolean) TO service_role;


--
-- Name: FUNCTION rpc_update_user_role(p_target_user_id uuid, p_new_role text, p_actor_id uuid); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.rpc_update_user_role(p_target_user_id uuid, p_new_role text, p_actor_id uuid) TO anon;
GRANT ALL ON FUNCTION public.rpc_update_user_role(p_target_user_id uuid, p_new_role text, p_actor_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.rpc_update_user_role(p_target_user_id uuid, p_new_role text, p_actor_id uuid) TO service_role;


--
-- Name: FUNCTION update_updated_at(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.update_updated_at() TO anon;
GRANT ALL ON FUNCTION public.update_updated_at() TO authenticated;
GRANT ALL ON FUNCTION public.update_updated_at() TO service_role;


--
-- Name: FUNCTION validate_consolidates_for(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.validate_consolidates_for() TO anon;
GRANT ALL ON FUNCTION public.validate_consolidates_for() TO authenticated;
GRANT ALL ON FUNCTION public.validate_consolidates_for() TO service_role;


--
-- Name: FUNCTION verify_audit_chain(p_start_from timestamp with time zone); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.verify_audit_chain(p_start_from timestamp with time zone) TO anon;
GRANT ALL ON FUNCTION public.verify_audit_chain(p_start_from timestamp with time zone) TO authenticated;
GRANT ALL ON FUNCTION public.verify_audit_chain(p_start_from timestamp with time zone) TO service_role;


--
-- Name: FUNCTION warn_freight_total_drift(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.warn_freight_total_drift() TO anon;
GRANT ALL ON FUNCTION public.warn_freight_total_drift() TO authenticated;
GRANT ALL ON FUNCTION public.warn_freight_total_drift() TO service_role;


--
-- Name: TABLE audit_logs; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.audit_logs TO anon;
GRANT ALL ON TABLE public.audit_logs TO authenticated;
GRANT ALL ON TABLE public.audit_logs TO service_role;


--
-- Name: TABLE component_breakage_reports; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.component_breakage_reports TO anon;
GRANT ALL ON TABLE public.component_breakage_reports TO authenticated;
GRANT ALL ON TABLE public.component_breakage_reports TO service_role;


--
-- Name: TABLE demand_overrides; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.demand_overrides TO anon;
GRANT ALL ON TABLE public.demand_overrides TO authenticated;
GRANT ALL ON TABLE public.demand_overrides TO service_role;


--
-- Name: TABLE factory_order_items; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.factory_order_items TO anon;
GRANT ALL ON TABLE public.factory_order_items TO authenticated;
GRANT ALL ON TABLE public.factory_order_items TO service_role;


--
-- Name: TABLE factory_orders; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.factory_orders TO anon;
GRANT ALL ON TABLE public.factory_orders TO authenticated;
GRANT ALL ON TABLE public.factory_orders TO service_role;


--
-- Name: TABLE freight_line_items; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.freight_line_items TO anon;
GRANT ALL ON TABLE public.freight_line_items TO authenticated;
GRANT ALL ON TABLE public.freight_line_items TO service_role;


--
-- Name: TABLE freight_shipments; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.freight_shipments TO anon;
GRANT ALL ON TABLE public.freight_shipments TO authenticated;
GRANT ALL ON TABLE public.freight_shipments TO service_role;


--
-- Name: TABLE inventory_levels; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.inventory_levels TO anon;
GRANT ALL ON TABLE public.inventory_levels TO authenticated;
GRANT ALL ON TABLE public.inventory_levels TO service_role;


--
-- Name: TABLE locations; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.locations TO anon;
GRANT ALL ON TABLE public.locations TO authenticated;
GRANT ALL ON TABLE public.locations TO service_role;


--
-- Name: TABLE inventory_levels_default; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.inventory_levels_default TO anon;
GRANT ALL ON TABLE public.inventory_levels_default TO authenticated;
GRANT ALL ON TABLE public.inventory_levels_default TO service_role;


--
-- Name: TABLE inventory_totals_by_sku; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.inventory_totals_by_sku TO anon;
GRANT ALL ON TABLE public.inventory_totals_by_sku TO authenticated;
GRANT ALL ON TABLE public.inventory_totals_by_sku TO service_role;


--
-- Name: TABLE inventory_transactions; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.inventory_transactions TO anon;
GRANT ALL ON TABLE public.inventory_transactions TO authenticated;
GRANT ALL ON TABLE public.inventory_transactions TO service_role;


--
-- Name: TABLE labor_hours_daily; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.labor_hours_daily TO anon;
GRANT ALL ON TABLE public.labor_hours_daily TO authenticated;
GRANT ALL ON TABLE public.labor_hours_daily TO service_role;


--
-- Name: TABLE product_boms; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.product_boms TO anon;
GRANT ALL ON TABLE public.product_boms TO authenticated;
GRANT ALL ON TABLE public.product_boms TO service_role;


--
-- Name: TABLE product_boms_active; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.product_boms_active TO anon;
GRANT ALL ON TABLE public.product_boms_active TO authenticated;
GRANT ALL ON TABLE public.product_boms_active TO service_role;


--
-- Name: TABLE product_skus; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.product_skus TO anon;
GRANT ALL ON TABLE public.product_skus TO authenticated;
GRANT ALL ON TABLE public.product_skus TO service_role;


--
-- Name: TABLE product_skus_active; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.product_skus_active TO anon;
GRANT ALL ON TABLE public.product_skus_active TO authenticated;
GRANT ALL ON TABLE public.product_skus_active TO service_role;


--
-- Name: TABLE profiles; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.profiles TO anon;
GRANT ALL ON TABLE public.profiles TO authenticated;
GRANT ALL ON TABLE public.profiles TO service_role;


--
-- Name: TABLE shipment_variances; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.shipment_variances TO anon;
GRANT ALL ON TABLE public.shipment_variances TO authenticated;
GRANT ALL ON TABLE public.shipment_variances TO service_role;


--
-- Name: TABLE shipstation_order_items; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.shipstation_order_items TO anon;
GRANT ALL ON TABLE public.shipstation_order_items TO authenticated;
GRANT ALL ON TABLE public.shipstation_order_items TO service_role;


--
-- Name: TABLE shipstation_orders; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.shipstation_orders TO anon;
GRANT ALL ON TABLE public.shipstation_orders TO authenticated;
GRANT ALL ON TABLE public.shipstation_orders TO service_role;


--
-- Name: TABLE shipstation_sync_runs; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.shipstation_sync_runs TO anon;
GRANT ALL ON TABLE public.shipstation_sync_runs TO authenticated;
GRANT ALL ON TABLE public.shipstation_sync_runs TO service_role;


--
-- Name: TABLE shipstation_unresolved_skus; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.shipstation_unresolved_skus TO anon;
GRANT ALL ON TABLE public.shipstation_unresolved_skus TO authenticated;
GRANT ALL ON TABLE public.shipstation_unresolved_skus TO service_role;


--
-- Name: TABLE shipstation_webhook_events; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.shipstation_webhook_events TO anon;
GRANT ALL ON TABLE public.shipstation_webhook_events TO authenticated;
GRANT ALL ON TABLE public.shipstation_webhook_events TO service_role;


--
-- Name: TABLE sku_economics; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.sku_economics TO anon;
GRANT ALL ON TABLE public.sku_economics TO authenticated;
GRANT ALL ON TABLE public.sku_economics TO service_role;


--
-- Name: TABLE sku_supplier_costs; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.sku_supplier_costs TO anon;
GRANT ALL ON TABLE public.sku_supplier_costs TO authenticated;
GRANT ALL ON TABLE public.sku_supplier_costs TO service_role;


--
-- Name: TABLE supplier_portal_breakage_reports; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.supplier_portal_breakage_reports TO anon;
GRANT ALL ON TABLE public.supplier_portal_breakage_reports TO authenticated;
GRANT ALL ON TABLE public.supplier_portal_breakage_reports TO service_role;


--
-- Name: TABLE supplier_portal_factory_order_items; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.supplier_portal_factory_order_items TO anon;
GRANT ALL ON TABLE public.supplier_portal_factory_order_items TO authenticated;
GRANT ALL ON TABLE public.supplier_portal_factory_order_items TO service_role;


--
-- Name: TABLE supplier_portal_factory_orders; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.supplier_portal_factory_orders TO anon;
GRANT ALL ON TABLE public.supplier_portal_factory_orders TO authenticated;
GRANT ALL ON TABLE public.supplier_portal_factory_orders TO service_role;


--
-- Name: TABLE supplier_portal_freight_line_items; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.supplier_portal_freight_line_items TO anon;
GRANT ALL ON TABLE public.supplier_portal_freight_line_items TO authenticated;
GRANT ALL ON TABLE public.supplier_portal_freight_line_items TO service_role;


--
-- Name: TABLE supplier_portal_freight_shipments; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.supplier_portal_freight_shipments TO anon;
GRANT ALL ON TABLE public.supplier_portal_freight_shipments TO authenticated;
GRANT ALL ON TABLE public.supplier_portal_freight_shipments TO service_role;


--
-- Name: TABLE supplier_portal_skus; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.supplier_portal_skus TO anon;
GRANT ALL ON TABLE public.supplier_portal_skus TO authenticated;
GRANT ALL ON TABLE public.supplier_portal_skus TO service_role;


--
-- Name: TABLE supplier_portal_variances; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.supplier_portal_variances TO anon;
GRANT ALL ON TABLE public.supplier_portal_variances TO authenticated;
GRANT ALL ON TABLE public.supplier_portal_variances TO service_role;


--
-- Name: TABLE suppliers; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.suppliers TO anon;
GRANT ALL ON TABLE public.suppliers TO authenticated;
GRANT ALL ON TABLE public.suppliers TO service_role;


--
-- Name: TABLE task_logs; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.task_logs TO anon;
GRANT ALL ON TABLE public.task_logs TO authenticated;
GRANT ALL ON TABLE public.task_logs TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: postgres
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: supabase_admin
--



--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: postgres
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: supabase_admin
--



--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: postgres
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: supabase_admin
--



--
-- PostgreSQL database dump complete
--


