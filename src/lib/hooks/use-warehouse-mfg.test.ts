import { describe, it, expect, vi } from "vitest";
import {
  fetchWhLineCartons,
  FIFO_OVERRIDE_REASONS,
  fifoSuggestion,
  isAlreadyAtLine,
  MFG_INVALIDATE_ROOTS,
  mfgRpc,
  moveWhStock,
  openWhContainer,
  putawayWhContainerMove,
  relabelShortfall,
  rtsRelabelWh,
  splitLineCartons,
  takeToLineFlash,
  takeWhToLine,
  whErrorCode,
  WhMfgError,
  type WhLineCartonRow,
} from "./use-warehouse-mfg";
import { openWhContainer as openFromTasks } from "./use-warehouse-tasks";
import { newRtsPlan, addCarton, looseRemainder, setCartonQty, rtsCartonsPayload } from "@/lib/warehouse/rts-cartons";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function mockClient(response: { data: unknown; error: unknown }) {
  return { rpc: vi.fn().mockResolvedValue(response) };
}

function argsOf(client: { rpc: ReturnType<typeof vi.fn> }) {
  return client.rpc.mock.calls[0] as [string, Record<string, unknown>];
}

describe("mfgRpc (envelope with codes)", () => {
  it("returns the envelope when ok", async () => {
    const client = mockClient({ data: { ok: true, units: 12 }, error: null });
    const res = await mfgRpc("rpc_wh_take_to_line", { p_container_id: "c-1" }, "fallback", client);
    expect(res.units).toBe(12);
  });

  it("throws a WhMfgError with the message, the code and the extra fields", async () => {
    const client = mockClient({
      data: { ok: false, error: "insufficient_at_line", message: "MFG-LINE holds 90 loose finished BW20; the cartons need 96 (6 short).", available: 90, needed: 96 },
      error: null,
    });
    const err = await rtsRelabelWh({ skuId: "sku-1", cartons: [{ qty: 96, state: "sealed" }] }, client).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WhMfgError);
    expect((err as WhMfgError).message).toBe("MFG-LINE holds 90 loose finished BW20; the cartons need 96 (6 short).");
    expect(whErrorCode(err)).toBe("insufficient_at_line");
    expect((err as WhMfgError).details).toEqual({ available: 90, needed: 96 });
    expect(relabelShortfall(err)).toEqual({ available: 90, needed: 96, short: 6 });
  });

  it("falls back to the code, then the caller's sentence", async () => {
    await expect(mfgRpc("rpc_wh_take_to_line", { p_container_id: "c" }, "fallback", mockClient({ data: { ok: false, error: "forbidden" }, error: null }))).rejects.toThrow("forbidden");
    await expect(mfgRpc("rpc_wh_take_to_line", { p_container_id: "c" }, "fallback", mockClient({ data: null, error: null }))).rejects.toThrow("fallback");
  });

  it("rethrows transport errors untouched", async () => {
    const transport = { code: "PGRST301", message: "JWT expired" };
    await expect(takeWhToLine({ containerId: "c" }, mockClient({ data: null, error: transport }))).rejects.toBe(transport);
    expect(whErrorCode(transport)).toBeNull();
    expect(relabelShortfall(transport)).toBeNull();
  });
});

describe("takeWhToLine (rpc_wh_take_to_line)", () => {
  it("sends the carton and a fresh client event id", async () => {
    const client = mockClient({ data: { ok: true, container: { code: "C-OB-0010" }, from: { code: "01-01-3" }, units: 12 }, error: null });
    const res = await takeWhToLine({ containerId: "ctr-1" }, client);
    const [name, args] = argsOf(client);
    expect(name).toBe("rpc_wh_take_to_line");
    expect(args.p_container_id).toBe("ctr-1");
    expect(args.p_client_event_id).toMatch(UUID);
    expect(res.units).toBe(12);
  });

  it("keeps a client event id the caller passes (a retry replays the first result)", async () => {
    const client = mockClient({ data: { ok: true, units: 12, duplicate: true }, error: null });
    await takeWhToLine({ containerId: "ctr-1", clientEventId: "evt-1" }, client);
    expect(argsOf(client)[1]).toEqual({ p_container_id: "ctr-1", p_client_event_id: "evt-1" });
  });

  it("recognises already_at_line, which the Workspace accepts silently", async () => {
    const client = mockClient({
      data: { ok: false, error: "already_at_line", message: "C-OB-0010 is already at the manufacturing line." },
      error: null,
    });
    const err = await takeWhToLine({ containerId: "ctr-1" }, client).catch((e: unknown) => e);
    expect(isAlreadyAtLine(err)).toBe(true);
    expect(isAlreadyAtLine(new Error("C-OB-0010 is already at the manufacturing line."))).toBe(false);
  });

  it("leaves p_fifo_override out unless the worker gave a reason", async () => {
    const client = mockClient({ data: { ok: true, units: 12, fifo: { followed: true, suggested_code: null, override: null } }, error: null });
    await takeWhToLine({ containerId: "ctr-1", clientEventId: "evt-1", fifoOverride: null }, client);
    expect(argsOf(client)[1]).not.toHaveProperty("p_fifo_override");
  });

  it("sends the override reason with the same client event id", async () => {
    const client = mockClient({
      data: { ok: true, units: 12, fifo: { followed: false, suggested_code: "C-466-004", override: "buried" } },
      error: null,
    });
    const res = await takeWhToLine({ containerId: "ctr-1", clientEventId: "evt-1", fifoOverride: "buried" }, client);
    expect(argsOf(client)[1]).toEqual({ p_container_id: "ctr-1", p_client_event_id: "evt-1", p_fifo_override: "buried" });
    expect(res.fifo).toEqual({ followed: false, suggested_code: "C-466-004", override: "buried" });
    expect(FIFO_OVERRIDE_REASONS).toEqual(["buried", "damaged", "closer", "other"]);
  });

  it("reads a fifo_suggests refusal: the older carton and the scanned one", async () => {
    const suggested = {
      container_id: "c-old",
      code: "C-466-004",
      state: "sealed",
      qty: 48,
      bucket: "raw",
      location_id: "l-1",
      location_code: "05-02-1",
      factory_order_id: "fo-1",
      factory_order_number: "FO-2026-118",
      order_date: "2026-08-01",
      shipment_id: "s-1",
      shipment_number: "SH-1",
      received_at: "2026-10-20T15:00:00Z",
      reason: "oldest_batch",
    };
    const scanned = { code: "C-472-003", factory_order_number: "FO-2026-131", order_date: "2026-09-01", received_at: null, location_code: "05-03-1" };
    const client = mockClient({
      data: { ok: false, error: "fifo_suggests", message: "C-472-003 is newer; C-466-004 in 05-02-1 is older.", suggested, scanned },
      error: null,
    });
    const err = await takeWhToLine({ containerId: "c-new" }, client).catch((e: unknown) => e);
    expect(whErrorCode(err)).toBe("fifo_suggests");
    expect(fifoSuggestion(err)).toEqual({ suggested, scanned, message: "C-472-003 is newer; C-466-004 in 05-02-1 is older." });
    expect(isAlreadyAtLine(err)).toBe(false);
  });

  it("flashes green when FIFO was followed, amber with the reason when it was skipped", () => {
    expect(takeToLineFlash("C-466-004", { fifo: { followed: true, suggested_code: "C-466-004", override: null } })).toEqual({
      tone: "ok",
      label: "C-466-004 to the line",
      skipped: null,
    });
    expect(takeToLineFlash("C-472-003", { fifo: { followed: false, suggested_code: "C-466-004", override: "buried" } }, "buried")).toEqual({
      tone: "warn",
      label: "Taken to the line · FIFO skipped (buried)",
      skipped: "buried",
    });
    // The server's recorded reason wins over the one the screen sent.
    expect(takeToLineFlash("C-1", { fifo: { followed: false, suggested_code: "C-2", override: "closer" } }, "other").skipped).toBe("closer");
    // A server that says nothing about FIFO: the override the screen sent, if any.
    const silent = {} as Parameters<typeof takeToLineFlash>[1];
    expect(takeToLineFlash("C-1", silent).tone).toBe("ok");
    expect(takeToLineFlash("C-1", silent, "damaged").label).toBe("Taken to the line · FIFO skipped (damaged)");
  });

  it("is not a fifo suggestion for other errors or a refusal without a carton", () => {
    expect(fifoSuggestion(new WhMfgError("x", "already_at_line"))).toBeNull();
    expect(fifoSuggestion(new WhMfgError("x", "fifo_suggests", { suggested: null }))).toBeNull();
    expect(fifoSuggestion(new Error("fifo_suggests"))).toBeNull();
  });
});

describe("rtsRelabelWh (rpc_wh_rts_relabel)", () => {
  it("sends the SKU, the cartons from the plan, the parent, the task log and a client event id", async () => {
    const plan = looseRemainder(setCartonQty(addCarton(newRtsPlan(100), 48), 2, 48));
    const client = mockClient({
      data: {
        ok: true,
        containers: [
          { id: "g1", code: "C-466-007R1", qty: 48, state: "sealed", suggested: { location_id: "l1", code: "02-01-1", reason: "same_sku_face" }, move_id: "m1" },
          { id: "g2", code: "C-466-007R2", qty: 48, state: "sealed", suggested: null, move_id: "m2" },
        ],
        parent: { id: "p1", code: "C-466-007", state: "void" },
        remainder: { qty: 4, left_at_line: false, to: { code: "02-01-1" }, container: { id: "o1", code: "C-OB-0001" } },
        print_job_id: "job-1",
        print: { ok: true, job_id: "job-1", status: "queued", target: "printer", routed_by: "station", printer: { id: "pr", code: "MFG-1", name: "Mfg desk 1" }, station_location_id: "st", message: null },
        putaway_tasks: ["m1", "m2"],
        movement_group_id: "grp",
      },
      error: null,
    });
    const res = await rtsRelabelWh(
      { skuId: "sku-1", cartons: rtsCartonsPayload(plan), parentContainerId: "p1", taskLogId: "tl-1" },
      client,
    );
    const [name, args] = argsOf(client);
    expect(name).toBe("rpc_wh_rts_relabel");
    expect(args).toMatchObject({
      p_sku_id: "sku-1",
      p_cartons: [
        { qty: 48, state: "sealed" },
        { qty: 48, state: "sealed" },
        { qty: 4, loose: true },
      ],
      p_parent_container_id: "p1",
      p_task_log_id: "tl-1",
    });
    expect(args.p_client_event_id).toMatch(UUID);
    expect(res.dormant).toBe(false);
    expect(res.containers.map((c) => c.code)).toEqual(["C-466-007R1", "C-466-007R2"]);
    expect(res.containers[1].suggested).toBeNull();
    expect(res.parent).toEqual({ id: "p1", code: "C-466-007", state: "void" });
    expect(res.remainder).toMatchObject({ qty: 4, left_at_line: false });
    expect(res.printJobId).toBe("job-1");
    expect(res.print?.target).toBe("printer");
    expect(res.putawayTasks).toEqual(["m1", "m2"]);
  });

  it("sends null parent and task log for No label without a log id", async () => {
    const client = mockClient({ data: { ok: true, dormant: true }, error: null });
    await rtsRelabelWh({ skuId: "sku-1", cartons: [{ qty: 12, state: "sealed" }] }, client);
    expect(argsOf(client)[1]).toMatchObject({ p_parent_container_id: null, p_task_log_id: null });
  });

  it("passes the dormant answer through with nothing minted", async () => {
    const client = mockClient({ data: { ok: true, dormant: true }, error: null });
    const res = await rtsRelabelWh({ skuId: "sku-1", cartons: [{ qty: 12, state: "sealed" }], clientEventId: "evt-9" }, client);
    expect(argsOf(client)[1].p_client_event_id).toBe("evt-9");
    expect(res).toEqual({
      dormant: true,
      duplicate: false,
      containers: [],
      parent: null,
      remainder: null,
      printJobId: null,
      print: null,
      putawayTasks: [],
    });
  });

  it("marks a replayed result as a duplicate", async () => {
    const client = mockClient({ data: { ok: true, duplicate: true, containers: [], putaway_tasks: [] }, error: null });
    expect((await rtsRelabelWh({ skuId: "s", cartons: [{ qty: 1, state: "sealed" }] }, client)).duplicate).toBe(true);
  });
});

describe("moveWhStock (rpc_wh_move_stock)", () => {
  it("sends loose units with their bucket and a client event id; optional fields go as null", async () => {
    const client = mockClient({ data: { ok: true, qty: 6, bucket: "finished" }, error: null });
    await moveWhStock({ skuId: "sku-1", qty: 6, fromLocationId: "l-from", toLocationId: "l-to", bucket: "finished" }, client);
    const [name, args] = argsOf(client);
    expect(name).toBe("rpc_wh_move_stock");
    expect(args).toMatchObject({
      p_sku_id: "sku-1",
      p_qty: 6,
      p_from_location_id: "l-from",
      p_to_location_id: "l-to",
      p_from_container_id: null,
      p_to_container_id: null,
      p_bucket: "finished",
      p_move_id: null,
    });
    expect(args.p_client_event_id).toMatch(UUID);
  });

  it("keeps the insufficient code and the available units", async () => {
    const client = mockClient({
      data: { ok: false, error: "insufficient", message: "01-01-1 has 2 BW20 available; 6 requested.", available: 2 },
      error: null,
    });
    const err = await moveWhStock({ skuId: "s", qty: 6, fromLocationId: "a", toLocationId: "b" }, client).catch((e: unknown) => e);
    expect(whErrorCode(err)).toBe("insufficient");
    expect((err as WhMfgError).details.available).toBe(2);
  });
});

describe("putawayWhContainerMove (rpc_wh_putaway_container)", () => {
  it("sends the carton, the scanned bay, the task when known and a client event id", async () => {
    const client = mockClient({ data: { ok: true, followed_suggestion: true }, error: null });
    await putawayWhContainerMove({ containerId: "c-1", locationId: "l-1" }, client);
    const [name, args] = argsOf(client);
    expect(name).toBe("rpc_wh_putaway_container");
    expect(args).toMatchObject({ p_container_id: "c-1", p_location_id: "l-1", p_move_id: null });
    expect(args.p_client_event_id).toMatch(UUID);
  });

  it("surfaces already_there as a code", async () => {
    const client = mockClient({ data: { ok: false, error: "already_there", message: "C-1 is already in 02-01-1." }, error: null });
    const err = await putawayWhContainerMove({ containerId: "c-1", locationId: "l-1", moveId: "m-1" }, client).catch((e: unknown) => e);
    expect(argsOf(client)[1].p_move_id).toBe("m-1");
    expect(whErrorCode(err)).toBe("already_there");
  });
});

describe("open container (re-exported)", () => {
  it("is the same rpc_wh_open_container helper the putaway screen uses", async () => {
    expect(openWhContainer).toBe(openFromTasks);
    const client = mockClient({ data: { ok: true, warning: "not_pickable", message: "WIP-01 is not a pick face." }, error: null });
    const res = await openWhContainer({ containerId: "c-1", toLocationId: "l-face" }, client);
    expect(argsOf(client)[0]).toBe("rpc_wh_open_container");
    expect(argsOf(client)[1]).toMatchObject({ p_container_id: "c-1", p_to_location_id: "l-face", p_unpack: false });
    expect(res.warning).toBe("not_pickable");
  });
});

describe("invalidation", () => {
  it("refreshes cartons, putaways, locations, the overview and balances", () => {
    const roots = MFG_INVALIDATE_ROOTS.map((r) => r[0]);
    for (const root of ["wh-containers", "wh-putaway", "wh-locations", "wh-location", "wh-overview", "wh-next-cartons"]) {
      expect(roots).toContain(root);
    }
  });
});

describe("splitLineCartons", () => {
  const row = (over: Partial<WhLineCartonRow>): WhLineCartonRow => ({
    id: "id",
    code: "C-1",
    sku_id: "sku-1",
    sku: { sku: "BW20", product_name: "Bowl" },
    qty: 12,
    state: "sealed",
    label_stock: "green",
    finished_by: null,
    finished_at: "2026-10-26T14:00:00Z",
    created_at: "2026-10-26T14:00:00Z",
    parent_container_id: null,
    moves: [],
    ...over,
  });
  const task = (over: Partial<NonNullable<WhLineCartonRow["moves"]>[number]> = {}) => ({
    id: "m",
    kind: "putaway",
    status: "open",
    origin: "rts",
    created_by: "someone",
    created_at: "2026-10-26T14:00:00Z",
    suggested: { code: "02-01-1" },
    ...over,
  });

  it("puts the worker's own green cartons first, then the oldest; raw cartons apart", () => {
    const rows = [
      row({ id: "a", code: "C-A", finished_at: "2026-10-26T13:00:00Z", moves: [task({ id: "ma" })] }),
      row({ id: "b", code: "C-B", finished_at: "2026-10-26T15:00:00Z", finished_by: "me", moves: [task({ id: "mb", created_by: "me" })] }),
      row({ id: "c", code: "C-C", finished_at: "2026-10-26T12:00:00Z", moves: [task({ id: "mc" })] }),
      row({ id: "w2", code: "C-OB-0011", label_stock: "white", finished_at: null, moves: [] }),
      row({ id: "w1", code: "C-OB-0010", label_stock: "white", finished_at: null, moves: null }),
    ];
    const { waiting, raw } = splitLineCartons(rows, "me");
    expect(waiting.map((c) => c.id)).toEqual(["b", "c", "a"]);
    expect(waiting[0].putaway).toMatchObject({ id: "mb", suggested_code: "02-01-1", created_by: "me" });
    expect(raw.map((c) => c.code)).toEqual(["C-OB-0010", "C-OB-0011"]);
    expect(raw[0].putaway).toBeNull();
  });

  it("leaves out green cartons with no open putaway task", () => {
    const rows = [row({ id: "done", moves: [task({ status: "done" })] }), row({ id: "none", moves: [] })];
    expect(splitLineCartons(rows, null).waiting).toEqual([]);
  });
});

describe("fetchWhLineCartons", () => {
  it("reads live cartons at MFG-LINE with their open putaway tasks and drops the join column", async () => {
    const calls: [string, ...unknown[]][] = [];
    const builder: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "order", "limit"]) {
      builder[m] = (...a: unknown[]) => {
        calls.push([m, ...a]);
        return m === "limit"
          ? Promise.resolve({ data: [{ id: "c1", code: "C-1", at: { code: "MFG-LINE" }, moves: [] }], error: null })
          : builder;
      };
    }
    const client = { from: vi.fn(() => builder) };
    const rows = await fetchWhLineCartons(client);
    expect(client.from).toHaveBeenCalledWith("wh_containers");
    expect(calls).toContainEqual(["eq", "at.code", "MFG-LINE"]);
    expect(calls).toContainEqual(["in", "state", ["sealed", "open"]]);
    expect(calls).toContainEqual(["eq", "moves.kind", "putaway"]);
    expect(calls).toContainEqual(["in", "moves.status", ["open", "in_progress"]]);
    expect(rows).toEqual([{ id: "c1", code: "C-1", moves: [] }]);
  });
});
