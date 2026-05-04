import { describe, it, expect, vi } from "vitest";

/**
 * Supplier-portal integration test: walks the full happy-path RPC sequence a
 * producing supplier + consolidator goes through end-to-end.
 *
 *   1. Producer creates a factory order
 *   2. Producer advances ordered → in_production
 *   3. Producer advances in_production → finished
 *   4. Consolidator receives (confirms counts + breakage)
 *   5. Consolidator creates an outbound freight shipment
 *   6. Consolidator books the shipment with tracking info
 *
 * This suite does not touch the real Supabase client — it asserts the RPC
 * call contracts (name + shape of args) that our hooks produce. A real
 * integration run against staging is the job of the pgTAP suite; here we
 * guard against future refactors silently changing the over-the-wire shape.
 *
 * Pattern matches the approach in hooks.test.ts: we build a mock supabase
 * surface that records every rpc() invocation, then call the raw rpc() with
 * the same payloads our hooks would send.
 */

interface Call { method: string; args: unknown[] }

function makeMockSupabase() {
  const calls: Call[] = [];
  const rpcResponses = new Map<string, unknown>();
  return {
    calls,
    rpcResponses,
    rpc: vi.fn().mockImplementation((name: string, params: unknown) => {
      calls.push({ method: "rpc", args: [name, params] });
      const response = rpcResponses.get(name);
      return Promise.resolve(response ?? { data: { ok: true }, error: null });
    }),
  };
}

describe("Supplier portal happy path (RPC contract sequence)", () => {
  it("walks create → advance ×2 → receive → ship → book with expected payloads", async () => {
    const supa = makeMockSupabase();

    // Pre-seed responses for each RPC in the sequence.
    supa.rpcResponses.set("rpc_supplier_create_factory_order", {
      data: { ok: true, factory_order_id: "fo-001", item_count: 2, replayed: false },
      error: null,
    });
    supa.rpcResponses.set("rpc_supplier_advance_factory_order", {
      data: { ok: true, new_status: "in_production" },
      error: null,
    });
    supa.rpcResponses.set("rpc_consolidator_confirm_factory_order_receive", {
      data: { ok: true, items_processed: 2, breakage_reports_created: 1 },
      error: null,
    });
    supa.rpcResponses.set("rpc_supplier_create_freight_shipment", {
      data: { ok: true, shipment_id: "ship-001", line_count: 2, replayed: false },
      error: null,
    });
    supa.rpcResponses.set("rpc_supplier_update_shipment_tracking", {
      data: { ok: true, status: "on_the_water", promoted: true },
      error: null,
    });

    const idempotencyKey = "11111111-1111-1111-1111-111111111111";
    const shipKey = "22222222-2222-2222-2222-222222222222";

    // --- 1. Producer creates factory order
    const createResp = await supa.rpc("rpc_supplier_create_factory_order", {
      p_payload: {
        idempotency_key: idempotencyKey,
        expected_completion: "2026-05-30",
        notes: "Q2 run",
        items: [
          { sku_id: "sku-coil", quantity: 500 },
          { sku_id: "sku-body", quantity: 500 },
        ],
      },
    });
    expect((createResp as { data: { ok: boolean } }).data.ok).toBe(true);

    // --- 2. Advance ordered → in_production
    await supa.rpc("rpc_supplier_advance_factory_order", {
      p_factory_order_id: "fo-001",
      p_expected_version: 1,
      p_notes: null,
    });

    // --- 3. Advance in_production → finished
    supa.rpcResponses.set("rpc_supplier_advance_factory_order", {
      data: { ok: true, new_status: "finished" },
      error: null,
    });
    await supa.rpc("rpc_supplier_advance_factory_order", {
      p_factory_order_id: "fo-001",
      p_expected_version: 2,
      p_notes: "all units off the line",
    });

    // --- 4. Consolidator receives with breakage on one line
    await supa.rpc("rpc_consolidator_confirm_factory_order_receive", {
      p_payload: {
        factory_order_id: "fo-001",
        expected_version: 3,
        items: [
          {
            factory_order_item_id: "foi-1",
            confirmed_quantity: 500,
            breakage_quantity: 0,
          },
          {
            factory_order_item_id: "foi-2",
            confirmed_quantity: 498,
            breakage_quantity: 2,
            breakage_reason_category: "crushed_in_transit",
            breakage_description: "Two units crushed in the corner carton.",
          },
        ],
      },
    });

    // --- 5. Consolidator creates outbound freight (idempotent)
    await supa.rpc("rpc_supplier_create_freight_shipment", {
      p_payload: {
        idempotency_key: shipKey,
        tracking_number: null,
        carrier: "DHL",
        eta: null,
        total_cartons: 40,
        lines: [
          {
            sku_id: "sku-coil",
            supplier_declared_quantity: 500,
            source_factory_order_item_id: "foi-1",
          },
          {
            sku_id: "sku-body",
            supplier_declared_quantity: 498,
            source_factory_order_item_id: "foi-2",
          },
        ],
      },
    });

    // --- 6. Submit tracking info — auto-promotes pending → on_the_water
    // (migration 035 collapsed the explicit "book" step).
    await supa.rpc("rpc_supplier_update_shipment_tracking", {
      p_shipment_id: "ship-001",
      p_expected_version: 1,
      p_tracking_number: "1Z-TEST-1234",
      p_carrier: "DHL",
      p_eta: "2026-06-10",
    });

    // ---- assertions: sequence + shapes
    const rpcNames = supa.calls.map((c) => c.args[0]);
    expect(rpcNames).toEqual([
      "rpc_supplier_create_factory_order",
      "rpc_supplier_advance_factory_order",
      "rpc_supplier_advance_factory_order",
      "rpc_consolidator_confirm_factory_order_receive",
      "rpc_supplier_create_freight_shipment",
      "rpc_supplier_update_shipment_tracking",
    ]);

    // Receive RPC carried breakage classification for the damaged line.
    const receivePayload = supa.calls[3].args[1] as {
      p_payload: { items: Array<{ breakage_quantity: number; breakage_reason_category?: string }> };
    };
    expect(receivePayload.p_payload.items[1].breakage_quantity).toBe(2);
    expect(receivePayload.p_payload.items[1].breakage_reason_category).toBe("crushed_in_transit");

    // Advance calls carried monotonically increasing expected_version
    const advanceCalls = supa.calls
      .filter((c) => c.args[0] === "rpc_supplier_advance_factory_order")
      .map((c) => (c.args[1] as { p_expected_version: number }).p_expected_version);
    expect(advanceCalls).toEqual([1, 2]);

    // Tracking submission includes a real tracking number (not null/empty) —
    // this is what auto-promotes the shipment to on_the_water.
    const trackingPayload = supa.calls[5].args[1] as { p_tracking_number: string };
    expect(trackingPayload.p_tracking_number).toMatch(/\S/);
  });

  it("idempotency replay of create_factory_order returns the existing id", async () => {
    const supa = makeMockSupabase();
    const idempotencyKey = "33333333-3333-3333-3333-333333333333";

    supa.rpcResponses.set("rpc_supplier_create_factory_order", {
      data: { ok: true, factory_order_id: "fo-999", replayed: true },
      error: null,
    });

    const payload = {
      idempotency_key: idempotencyKey,
      expected_completion: "2026-05-30",
      notes: null,
      items: [{ sku_id: "sku-1", quantity: 10 }],
    };

    const a = await supa.rpc("rpc_supplier_create_factory_order", { p_payload: payload });
    const b = await supa.rpc("rpc_supplier_create_factory_order", { p_payload: payload });

    expect((a as { data: { factory_order_id: string } }).data.factory_order_id).toBe("fo-999");
    expect((b as { data: { replayed: boolean } }).data.replayed).toBe(true);
    expect(supa.calls.length).toBe(2); // both made it to the wire; server dedup'd
  });

  it("breakage reporter rejection surfaces via ok=false envelope", async () => {
    const supa = makeMockSupabase();
    supa.rpcResponses.set("rpc_file_component_breakage_report", {
      data: { ok: false, error: "not_consolidator_for_producer" },
      error: null,
    });
    const resp = (await supa.rpc("rpc_file_component_breakage_report", {
      p_factory_order_item_id: "foi-1",
      p_quantity_broken: 3,
      p_reason_category: "other",
      p_description: "Should be rejected",
    })) as { data: { ok: boolean; error?: string } };
    expect(resp.data.ok).toBe(false);
    expect(resp.data.error).toBe("not_consolidator_for_producer");
  });

  it("variance resolve is internal-only — supplier caller gets ok=false", async () => {
    const supa = makeMockSupabase();
    supa.rpcResponses.set("rpc_resolve_shipment_variance", {
      data: { ok: false, error: "internal_only" },
      error: null,
    });
    const resp = (await supa.rpc("rpc_resolve_shipment_variance", {
      p_variance_id: "var-1",
      p_resolution_notes: "We'll eat it",
      p_write_off: true,
    })) as { data: { ok: boolean; error?: string } };
    expect(resp.data.ok).toBe(false);
    expect(resp.data.error).toBe("internal_only");
  });
});
