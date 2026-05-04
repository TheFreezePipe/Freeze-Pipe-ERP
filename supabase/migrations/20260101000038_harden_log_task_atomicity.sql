-- =============================================================
-- Migration 038: harden rpc_log_task_completion atomicity
-- =============================================================
-- Defensive wrapper around the task-log RPC so that any unexpected
-- exception (trigger misfire, constraint violation, extension drift,
-- etc.) produces a structured {ok: false} envelope for the caller
-- WITHOUT leaving partial state behind.
--
-- Background: the body already runs as a single plpgsql BEGIN…END
-- with no sub-blocks, so the whole thing is one transaction. If the
-- top-level call raises, Postgres rolls the whole thing back and the
-- client sees a raw 500. That's atomic, but:
--
--   1. The caller sees a generic "internal server error" instead of a
--      structured error they can handle.
--   2. If we ever add a sub-BEGIN…EXCEPTION block inside the body
--      (e.g. for per-line retries), the outer atomicity weakens — a
--      future contributor could inadvertently let a task_log row
--      persist after a failed inventory move.
--
-- The fix: wrap the existing body in a BEGIN…EXCEPTION WHEN OTHERS
-- block. plpgsql EXCEPTION handlers create an implicit subtransaction;
-- raising an exception inside rolls back ALL work done in that block,
-- including the task_logs + inventory_transactions inserts. Our
-- handler catches, packages SQLSTATE + SQLERRM into the envelope, and
-- returns cleanly — no partial rows, no raw 500.
--
-- This is a belt-and-suspenders change. Today's code is already
-- atomic; this guards against future regressions and gives the client
-- a consistent error shape.
--
-- Signature unchanged from migration 027 (+036 cleanup):
--   (UUID, TEXT, INTEGER, TEXT, UUID, TIMESTAMPTZ, TIMESTAMPTZ, UUID)
-- CREATE OR REPLACE is sufficient.
-- =============================================================

CREATE OR REPLACE FUNCTION rpc_log_task_completion(
  p_sku_id UUID,
  p_task_type TEXT,
  p_quantity INTEGER,
  p_notes TEXT,
  p_actor_id UUID,
  p_time_started TIMESTAMPTZ DEFAULT NULL,
  p_time_completed TIMESTAMPTZ DEFAULT now(),
  p_location_id UUID DEFAULT NULL
) RETURNS JSONB AS $$
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
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION rpc_log_task_completion(
  UUID, TEXT, INTEGER, TEXT, UUID, TIMESTAMPTZ, TIMESTAMPTZ, UUID
) TO authenticated;
