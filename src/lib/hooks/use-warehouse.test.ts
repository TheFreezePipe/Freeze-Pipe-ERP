import { describe, it, expect, vi } from "vitest";
import { whRpc } from "./use-warehouse";
import {
  describePrintJob,
  endWhStation,
  labelStockFor,
  openWhContainer,
  orderPutawayQueue,
  PINNED_STATION_KEY,
  printerAddressProblem,
  printerDraftProblems,
  printerUpsertSql,
  putawayRank,
  putawayWhContainer,
  putawayWhLoose,
  readPinnedStation,
  resolveWhScan,
  startWhStation,
  suggestWhPutaway,
  writePinnedStation,
} from "./use-warehouse-tasks";
import {
  generateWhLocations,
  markWhPrinted,
  requestWhLabels,
  resequenceWh,
  saveWhLayout,
  saveWhLocation,
} from "./use-warehouse-layout";
import { createWhCount, saveWhLayoutChecked, setWhFixtureBlocked, WhLayoutRejectedError } from "./use-warehouse-map";
import {
  addCartonEntries,
  addLooseUnit,
  approveWhVariance,
  cartonKey,
  countLinesPayload,
  deleteWhPrinter,
  EMPTY_PRINTER_FORM,
  isCountDue,
  labelColourFlag,
  likelyCause,
  looseKey,
  nextCountTask,
  orderCountPath,
  printerFormFrom,
  printerFormProblems,
  printerPayload,
  readPhysicalLayer,
  recordWhCount,
  removeEntry,
  runWhReconcile,
  saveWhPrinter,
  scheduleWhCounts,
  setEntryQty,
  setWhPhysicalLayerLive,
  sortReconcileLines,
  WhPrinterStaleError,
  type WhCountEntry,
  type WhCountMovement,
} from "./use-warehouse-counts";

function mockClient(response: { data: unknown; error: unknown }) {
  return { rpc: vi.fn().mockResolvedValue(response) };
}

describe("whRpc (warehouse envelope seam)", () => {
  it("calls the named RPC with its arguments and returns the envelope", async () => {
    const client = mockClient({ data: { ok: true, code: "138332000051" }, error: null });
    const result = await whRpc("rpc_wh_link_barcode", { p_sku_id: "sku-1", p_scan: "1383325" }, "fallback", client);
    expect(client.rpc).toHaveBeenCalledWith("rpc_wh_link_barcode", { p_sku_id: "sku-1", p_scan: "1383325" });
    expect(result.code).toBe("138332000051");
  });

  it("throws the server's error text when ok is false", async () => {
    const client = mockClient({ data: { ok: false, error: "That code already belongs to BW20" }, error: null });
    await expect(
      whRpc("rpc_wh_link_barcode", { p_sku_id: "sku-1", p_scan: "1383325" }, "fallback", client),
    ).rejects.toThrow("That code already belongs to BW20");
  });

  it("falls back to the caller's message when the envelope has none", async () => {
    const client = mockClient({ data: null, error: null });
    await expect(whRpc("rpc_wh_barcode_coverage", {}, "Couldn't load barcode coverage", client)).rejects.toThrow(
      "Couldn't load barcode coverage",
    );
  });

  it("rethrows transport errors untouched", async () => {
    const transport = { code: "42883", message: "function rpc_wh_resolve_scan does not exist" };
    const client = mockClient({ data: null, error: transport });
    await expect(whRpc("rpc_wh_resolve_scan", { p_scan: "BW20" }, "fallback", client)).rejects.toBe(transport);
  });
});

describe("whRpc with Phase 1 envelopes", () => {
  it("throws the human message rather than the machine code", async () => {
    const client = mockClient({
      data: { ok: false, error: "already_at_line", message: "C-466-007 is already at the manufacturing line." },
      error: null,
    });
    await expect(whRpc("rpc_wh_take_to_line", { p_container_id: "ctr-1" }, "fallback", client)).rejects.toThrow(
      "C-466-007 is already at the manufacturing line.",
    );
  });
});

describe("station session mutations", () => {
  it("start calls rpc_wh_start_station with the scanned value and the device id", async () => {
    const client = mockClient({
      data: { ok: true, unchanged: false, ended_previous: null, session: { id: "s-1", code: "ST-MFG-2" }, printers: [] },
      error: null,
    });
    const result = await startWhStation({ scan: "%ST-MFG-2", deviceId: "dev-1" }, client);
    expect(client.rpc).toHaveBeenCalledWith("rpc_wh_start_station", { p_scan_value: "%ST-MFG-2", p_device_id: "dev-1" });
    expect(result.session.code).toBe("ST-MFG-2");
  });

  it("start sends a null device id when there is none", async () => {
    const client = mockClient({ data: { ok: true, session: { id: "s-1" }, printers: [] }, error: null });
    await startWhStation({ scan: "%ST-DOCK" }, client);
    expect(client.rpc).toHaveBeenCalledWith("rpc_wh_start_station", { p_scan_value: "%ST-DOCK", p_device_id: null });
  });

  it("start throws the server's message when ok is false", async () => {
    const client = mockClient({
      data: { ok: false, error: "not_a_station", message: "02-01-2 is not a station label." },
      error: null,
    });
    await expect(startWhStation({ scan: "%02-01-2" }, client)).rejects.toThrow("02-01-2 is not a station label.");
  });

  it("end calls rpc_wh_end_station with no arguments", async () => {
    const client = mockClient({ data: { ok: true, ended: "s-1" }, error: null });
    const result = await endWhStation(client);
    expect(client.rpc).toHaveBeenCalledWith("rpc_wh_end_station", {});
    expect(result.ended).toBe("s-1");
  });

  it("end throws when ok is false", async () => {
    const client = mockClient({ data: { ok: false, error: "forbidden", message: "Station sessions need an internal account." }, error: null });
    await expect(endWhStation(client)).rejects.toThrow("Station sessions need an internal account.");
  });
});

describe("layout mutations", () => {
  it("save layout sends the payload as p_payload", async () => {
    const payload = { templates: [], racks: [{ code: "R01" }], faces: [], fixtures: [] };
    const client = mockClient({ data: { ok: true, racks: { created: 1, updated: 0 } }, error: null });
    const result = await saveWhLayout(payload, client);
    expect(client.rpc).toHaveBeenCalledWith("rpc_wh_save_layout", { p_payload: payload });
    expect(result.racks.created).toBe(1);
  });

  it("save layout throws the rejection message", async () => {
    const client = mockClient({
      data: { ok: false, error: "layout_rejected", message: "Nothing was saved: rack R99: template not found (template_not_found)." },
      error: null,
    });
    await expect(saveWhLayout({}, client)).rejects.toThrow("Nothing was saved: rack R99");
  });

  it("save location sends the patch as p_location", async () => {
    const client = mockClient({ data: { ok: true, created: false, location: { code: "IN-01" } }, error: null });
    await saveWhLocation({ code: "IN-01", x_mm: 10398, y_mm: 2372, z_mm: 0, width_mm: 3805, depth_mm: 4389 }, client);
    expect(client.rpc).toHaveBeenCalledWith("rpc_wh_save_location", {
      p_location: { code: "IN-01", x_mm: 10398, y_mm: 2372, z_mm: 0, width_mm: 3805, depth_mm: 4389 },
    });
  });

  it("save location throws when the location still holds stock", async () => {
    const client = mockClient({
      data: { ok: false, error: "location_not_empty", message: "02-01-1 still holds stock; move or count it out before deactivating (location_not_empty)." },
      error: null,
    });
    await expect(saveWhLocation({ id: "loc-1", active: false }, client)).rejects.toThrow("02-01-1 still holds stock");
  });

  it("generate passes the rack and the dry-run flag", async () => {
    const client = mockClient({ data: { ok: true, dry_run: true, create: ["01-01-1"], update: [], conflicts: [], deactivate: [], codes: [] }, error: null });
    const dry = await generateWhLocations({ dryRun: true }, client);
    expect(client.rpc).toHaveBeenCalledWith("rpc_wh_generate_locations", { p_rack_id: null, p_dry_run: true });
    expect(dry.create).toEqual(["01-01-1"]);
    await generateWhLocations({ rackId: "rack-1", dryRun: false }, client);
    expect(client.rpc).toHaveBeenLastCalledWith("rpc_wh_generate_locations", { p_rack_id: "rack-1", p_dry_run: false });
  });

  it("generate throws when ok is false", async () => {
    const client = mockClient({ data: { ok: false, error: "forbidden", message: "Generating locations needs an admin (forbidden)." }, error: null });
    await expect(generateWhLocations({ dryRun: true }, client)).rejects.toThrow("needs an admin");
  });

  it("resequence sends the rows as p_rows", async () => {
    const client = mockClient({ data: { ok: true, updated: 2 }, error: null });
    const rows = [{ code: "02-01-1", pick_sequence: 1021 }, { location_id: "loc-1", pick_sequence: 1011 }];
    const result = await resequenceWh(rows, client);
    expect(client.rpc).toHaveBeenCalledWith("rpc_wh_resequence", { p_rows: rows });
    expect(result.updated).toBe(2);
  });

  it("resequence throws on a clash", async () => {
    const client = mockClient({ data: { ok: false, error: "sequence_conflict", message: "Two rows ask for the same pick_sequence (sequence_conflict)." }, error: null });
    await expect(resequenceWh([{ code: "02-01-1", pick_sequence: 1 }], client)).rejects.toThrow("same pick_sequence");
  });
});

describe("label jobs", () => {
  it("request sends kind, ids, where from and the printer (null when none)", async () => {
    const client = mockClient({ data: { ok: true, job_id: "job-1", status: "queued", target: "browser", routed_by: "practice" }, error: null });
    const job = await requestWhLabels({ kind: "location", ids: ["a", "b"], from: "desktop" }, client);
    expect(client.rpc).toHaveBeenCalledWith("rpc_wh_request_labels", { p_kind: "location", p_ids: ["a", "b"], p_from: "desktop", p_printer_id: null });
    expect(job.target).toBe("browser");
  });

  it("request throws when outbound is blocked", async () => {
    const client = mockClient({ data: { ok: false, error: "outbound_blocked", message: "Printing is blocked on this environment (outbound mode is blocked)." }, error: null });
    await expect(requestWhLabels({ kind: "station", ids: ["s"], from: "desktop" }, client)).rejects.toThrow("Printing is blocked");
  });

  it("mark printed sends the job, the status and the error", async () => {
    const client = mockClient({ data: { ok: true, job_id: "job-1", status: "printed" }, error: null });
    await markWhPrinted({ jobId: "job-1", status: "printed" }, client);
    expect(client.rpc).toHaveBeenCalledWith("rpc_wh_mark_printed", { p_job_id: "job-1", p_status: "printed", p_error: null });
    await markWhPrinted({ jobId: "job-1", status: "failed", error: "paper out" }, client);
    expect(client.rpc).toHaveBeenLastCalledWith("rpc_wh_mark_printed", { p_job_id: "job-1", p_status: "failed", p_error: "paper out" });
  });

  it("mark printed throws when ok is false", async () => {
    const client = mockClient({ data: { ok: false, error: "job_not_found", message: "That print job does not exist." }, error: null });
    await expect(markWhPrinted({ jobId: "nope", status: "printed" }, client)).rejects.toThrow("That print job does not exist.");
  });
});

describe("map mutations", () => {
  it("count now sends the location ids, ad_hoc and the reason", async () => {
    const client = mockClient({ data: { ok: true, created: ["t-1"], existing: [], missing: [] }, error: null });
    const result = await createWhCount({ locationIds: ["loc-1"], reason: "Map: count now" }, client);
    expect(client.rpc).toHaveBeenCalledWith("rpc_wh_create_count", { p_location_ids: ["loc-1"], p_kind: "ad_hoc", p_reason: "Map: count now" });
    expect(result.created).toEqual(["t-1"]);
  });

  it("count now sends a null reason when there is none and throws the refusal", async () => {
    const client = mockClient({ data: { ok: false, error: "forbidden", message: "Creating counts needs a manager or admin." }, error: null });
    await expect(createWhCount({ locationIds: ["loc-1"], kind: "reconcile" }, client)).rejects.toThrow("needs a manager or admin");
    expect(client.rpc).toHaveBeenCalledWith("rpc_wh_create_count", { p_location_ids: ["loc-1"], p_kind: "reconcile", p_reason: null });
  });

  it("the blocked toggle saves one fixture through rpc_wh_save_layout with its row_version", async () => {
    const client = mockClient({ data: { ok: true, fixtures: { created: 0, updated: 1, deleted: 0 } }, error: null });
    await setWhFixtureBlocked({ id: "fx-1", blocked: true, rowVersion: 3 }, client);
    expect(client.rpc).toHaveBeenCalledWith("rpc_wh_save_layout", { p_payload: { fixtures: [{ id: "fx-1", blocked: true, row_version: 3 }] } });
    await setWhFixtureBlocked({ id: "fx-1", blocked: false }, client);
    expect(client.rpc).toHaveBeenLastCalledWith("rpc_wh_save_layout", { p_payload: { fixtures: [{ id: "fx-1", blocked: false }] } });
  });

  it("the editor's save keeps every problem of a rejected payload", async () => {
    const problems = [
      { row: "rack R02", error: "stale", message: "rack R02 changed since it was loaded (stale)." },
      { row: "face 03 on R02", error: "stale", message: "face 03 on R02 changed since it was loaded (stale)." },
    ];
    const client = mockClient({
      data: { ok: false, error: "layout_rejected", message: "Nothing was saved: rack R02 changed since it was loaded (stale). (+1 more)", problems },
      error: null,
    });
    const payload = { racks: [{ id: "r-2", row_version: 4, x_mm: 3300 }] };
    const err = await saveWhLayoutChecked(payload, client).catch((e: unknown) => e);
    expect(client.rpc).toHaveBeenCalledWith("rpc_wh_save_layout", { p_payload: payload });
    expect(err).toBeInstanceOf(WhLayoutRejectedError);
    expect((err as WhLayoutRejectedError).problems).toEqual(problems);
    expect((err as WhLayoutRejectedError).message).toContain("Nothing was saved");
  });

  it("the editor's save returns the counts on success and rethrows transport errors", async () => {
    const ok = mockClient({ data: { ok: true, racks: { created: 1, updated: 2 } }, error: null });
    const result = await saveWhLayoutChecked({ racks: [] }, ok);
    expect(result.racks.updated).toBe(2);
    const transport = { code: "PGRST", message: "network" };
    await expect(saveWhLayoutChecked({}, mockClient({ data: null, error: transport }))).rejects.toBe(transport);
  });
});

// ---- Slice 3D: phone putaway, stations, print jobs, printers ---------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("phone putaway calls", () => {
  it("putaway sends the carton, the location, the task and a fresh client_event_id", async () => {
    const client = mockClient({
      data: { ok: true, container: { code: "C-OB-9001-PA" }, followed_suggestion: true, next: null },
      error: null,
    });
    const result = await putawayWhContainer({ containerId: "ctr-1", locationId: "loc-1", moveId: "mv-1" }, client);
    const [name, args] = client.rpc.mock.calls[0];
    expect(name).toBe("rpc_wh_putaway_container");
    expect(args).toMatchObject({ p_container_id: "ctr-1", p_location_id: "loc-1", p_move_id: "mv-1" });
    expect(args.p_client_event_id).toMatch(UUID_RE);
    expect(result.followed_suggestion).toBe(true);
    await putawayWhContainer({ containerId: "ctr-1", locationId: "loc-1" }, client);
    expect(client.rpc.mock.calls[1][1].p_client_event_id).not.toBe(args.p_client_event_id);
    expect(client.rpc.mock.calls[1][1].p_move_id).toBeNull();
  });

  it("putaway keeps a client_event_id it is given and throws the refusal", async () => {
    const client = mockClient({
      data: { ok: false, error: "already_there", message: "C-OB-9001-PA is already in 02-01-3." },
      error: null,
    });
    await expect(
      putawayWhContainer({ containerId: "ctr-1", locationId: "loc-1", clientEventId: "evt-1" }, client),
    ).rejects.toThrow("C-OB-9001-PA is already in 02-01-3.");
    expect(client.rpc.mock.calls[0][1].p_client_event_id).toBe("evt-1");
  });

  it("a loose putaway is a stock move against its task", async () => {
    const client = mockClient({ data: { ok: true, sku: "BW20", qty: 6 }, error: null });
    await putawayWhLoose(
      { skuId: "sku-1", qty: 6, fromLocationId: "line", toLocationId: "face", bucket: "finished", moveId: "mv-2" },
      client,
    );
    const [name, args] = client.rpc.mock.calls[0];
    expect(name).toBe("rpc_wh_move_stock");
    expect(args).toMatchObject({
      p_sku_id: "sku-1",
      p_qty: 6,
      p_from_location_id: "line",
      p_to_location_id: "face",
      p_bucket: "finished",
      p_move_id: "mv-2",
    });
    expect(args.p_client_event_id).toMatch(UUID_RE);
  });

  it("suggest another sends the locations already shown", async () => {
    const client = mockClient({
      data: { ok: true, suggestion: { location_id: "loc-9", code: "05-02-3", reason: "nearest_empty" }, move_id: "mv-1" },
      error: null,
    });
    const res = await suggestWhPutaway({ containerId: "ctr-1", exclude: ["loc-1", "loc-2"] }, client);
    expect(client.rpc).toHaveBeenCalledWith("rpc_wh_suggest_putaway", { p_container_id: "ctr-1", p_exclude: ["loc-1", "loc-2"] });
    expect(res.suggestion.code).toBe("05-02-3");
  });

  it("open to pick face moves and opens the carton with a client_event_id", async () => {
    const client = mockClient({ data: { ok: true, units_moved: 12, warning: "not_pickable", message: "x" }, error: null });
    const res = await openWhContainer({ containerId: "ctr-1", toLocationId: "face-1" }, client);
    const [name, args] = client.rpc.mock.calls[0];
    expect(name).toBe("rpc_wh_open_container");
    expect(args).toMatchObject({ p_container_id: "ctr-1", p_to_location_id: "face-1", p_unpack: false });
    expect(args.p_client_event_id).toMatch(UUID_RE);
    expect(res.warning).toBe("not_pickable");
  });

  it("resolve keeps the id, kind and match the putaway screen needs", async () => {
    const client = mockClient({
      data: { ok: true, kind: "location", id: "loc-1", code: "02-01-3", match: { kind: "bay_level", active: true }, candidates: [] },
      error: null,
    });
    const r = await resolveWhScan("%Z02-01-3", client);
    expect(client.rpc).toHaveBeenCalledWith("rpc_wh_resolve_scan", { p_scan: "%Z02-01-3" });
    expect(r).toMatchObject({ kind: "location", id: "loc-1", code: "02-01-3", match: { kind: "bay_level", active: true } });
  });
});

describe("orderPutawayQueue", () => {
  type Row = Parameters<typeof orderPutawayQueue>[0][number];
  const row = (id: string, created: string, extra: Partial<Row> = {}): Row =>
    ({
      id,
      origin: "receipt",
      created_by: null,
      created_at: created,
      container: { code: id, sku_id: null, qty: 1, state: "sealed", label_stock: "white", location: { code: "02-01-1" } },
      from: { code: "IN-01" },
      ...extra,
    }) as Row;

  it("puts the worker's own RTS cartons first, then IN-01, then the rest, oldest first", () => {
    const at = (code: string) => ({ code, sku_id: null, qty: 1, state: "sealed" as const, label_stock: "white" as const, location: { code } });
    const rows = [
      row("elsewhere-old", "2026-10-20T08:00:00Z", { container: at("05-01-1") }),
      row("in-new", "2026-10-22T09:00:00Z", { container: at("IN-01") }),
      row("rts-other", "2026-10-21T09:00:00Z", { origin: "rts", created_by: "someone", container: at("MFG-LINE") }),
      row("rts-mine", "2026-10-22T10:00:00Z", { origin: "rts", created_by: "me", container: at("MFG-LINE") }),
      row("in-old", "2026-10-21T07:00:00Z", { container: at("IN-01") }),
    ];
    expect(orderPutawayQueue(rows, "me").map((r) => r.id)).toEqual(["rts-mine", "in-old", "in-new", "elsewhere-old", "rts-other"]);
    expect(putawayRank(rows[3], null)).toBe(2);
  });

  it("ranks loose units by where the task started", () => {
    const loose = row("loose", "2026-10-22T00:00:00Z", { container: null, from: { code: "IN-01" } });
    expect(putawayRank(loose, "me")).toBe(1);
  });
});

describe("describePrintJob", () => {
  const now = Date.parse("2026-10-23T12:00:00Z");
  const base = {
    status: "queued",
    created_at: "2026-10-23T11:59:55Z",
    claimed_at: null,
    error: null,
    printer_id: "p-1",
    attempts: 0,
  };
  const online = { name: "Dock printer", code: "DOCK-1", last_seen_at: "2026-10-23T11:59:40Z" };

  it("reads queued, printing, printed and failed", () => {
    expect(describePrintJob(base, online, now)).toMatchObject({ phase: "queued", text: "Queued for Dock printer", needsAction: false });
    expect(describePrintJob({ ...base, status: "claimed", claimed_at: "2026-10-23T11:59:58Z" }, online, now)).toMatchObject({
      phase: "printing",
      text: "Printing at Dock printer…",
    });
    expect(describePrintJob({ ...base, status: "printed" }, online, now)).toMatchObject({ phase: "printed", text: "Printed at Dock printer" });
    expect(describePrintJob({ ...base, status: "failed", error: "connect ECONNREFUSED" }, online, now)).toMatchObject({
      phase: "failed",
      text: "Failed: connect ECONNREFUSED",
      needsAction: true,
    });
  });

  it("calls a job stale after 30 s, or soon when its agent is offline", () => {
    expect(describePrintJob({ ...base, created_at: "2026-10-23T11:59:00Z" }, online, now)).toMatchObject({
      phase: "stale",
      needsAction: true,
    });
    const offline = { ...online, last_seen_at: "2026-10-23T11:50:00Z" };
    expect(describePrintJob({ ...base, created_at: "2026-10-23T11:59:50Z" }, offline, now)).toMatchObject({
      phase: "stale",
      text: "Queued for Dock printer, but its print agent is offline",
    });
    // last_seen_at unknown (printer list still loading): not judged offline
    expect(describePrintJob(base, { name: "Dock printer", code: "DOCK-1" }, now).phase).toBe("queued");
  });

  it("mentions the retry error while a failed attempt is back in the queue", () => {
    const view = describePrintJob({ ...base, attempts: 1, error: "paper out" }, online, now);
    expect(view.text).toBe("Queued for Dock printer (retrying after: paper out)");
  });

  it("maps label kinds to their stock", () => {
    expect(labelStockFor("lpn")).toBe("white_4x2");
    expect(labelStockFor("lpn_rts")).toBe("green_4x2");
    expect(labelStockFor("station")).toBe("white_3x1");
  });
});

describe("printer registration SQL (workaround)", () => {
  const draft = {
    code: "DOCK-1",
    name: "Dock's printer",
    stationLocationId: "0a1b2c3d-1111-4222-8333-944455566677",
    address: "tcp://192.168.1.50:9100",
    labelStock: "white_4x2" as const,
    dpi: 203 as const,
    active: true,
    agentId: "agent-dock",
  };

  it("accepts the three address forms and refuses others", () => {
    expect(printerAddressProblem("tcp://192.168.1.50:9100")).toBeNull();
    expect(printerAddressProblem("share://DOCK-PC/Zebra")).toBeNull();
    expect(printerAddressProblem("file://C:/labels")).toBeNull();
    expect(printerAddressProblem("Zebra ZD421")).toMatch(/tcp:\/\/, share:\/\/ or file:\/\//);
    expect(printerAddressProblem("share://DOCK PC/Zebra")).toMatch(/share:\/\//);
    expect(printerAddressProblem("tcp://")).toMatch(/tcp:\/\//);
  });

  it("lists every problem of a draft", () => {
    expect(printerDraftProblems(draft)).toEqual([]);
    expect(printerDraftProblems({ ...draft, code: "dock 1", name: " ", agentId: "" })).toHaveLength(3);
  });

  it("builds an upsert by code with quotes escaped", () => {
    const sql = printerUpsertSql(draft);
    expect(sql).toContain("INSERT INTO public.wh_printers");
    expect(sql).toContain("'Dock''s printer'");
    expect(sql).toContain("'0a1b2c3d-1111-4222-8333-944455566677'::uuid");
    expect(sql).toContain("'tcp://192.168.1.50:9100'");
    expect(sql).toContain("ON CONFLICT (code) DO UPDATE");
    expect(printerUpsertSql({ ...draft, stationLocationId: "x'; drop table y; --" })).toContain(", NULL, 'agent',");
  });
});

describe("pinned station", () => {
  it("stores and clears the pin", () => {
    writePinnedStation("ST-MFG-2");
    expect(window.localStorage.getItem(PINNED_STATION_KEY)).toBe("ST-MFG-2");
    expect(readPinnedStation()).toBe("ST-MFG-2");
    writePinnedStation(null);
    expect(readPinnedStation()).toBeNull();
  });

  it("ignores a value that is not a station code", () => {
    window.localStorage.setItem(PINNED_STATION_KEY, "02-01-3");
    expect(readPinnedStation()).toBeNull();
    window.localStorage.removeItem(PINNED_STATION_KEY);
  });
});

describe("ledger sync, reconcile and printer RPC contracts", () => {
  it("reconcile passes p_create_counts and returns the run's numbers", async () => {
    const client = mockClient({
      data: { ok: true, run_id: "run-1", live: false, mismatched_skus: 3, counts_enabled: false, counts_created: 0 },
      error: null,
    });
    const run = await whRpc("rpc_wh_reconcile_physical", { p_create_counts: false }, "fallback", client);
    expect(client.rpc).toHaveBeenCalledWith("rpc_wh_reconcile_physical", { p_create_counts: false });
    expect(run.mismatched_skus).toBe(3);
    expect(run.counts_enabled).toBe(false);
  });

  it("a label request can force the browser with p_target", async () => {
    const client = mockClient({
      data: { ok: true, job_id: "job-2", status: "queued", target: "browser", routed_by: "requested", printer: null },
      error: null,
    });
    const job = await whRpc(
      "rpc_wh_request_labels",
      { p_kind: "lpn", p_ids: ["ctr-1"], p_from: "phone", p_printer_id: null, p_target: "browser" },
      "fallback",
      client,
    );
    expect(client.rpc).toHaveBeenCalledWith("rpc_wh_request_labels", {
      p_kind: "lpn", p_ids: ["ctr-1"], p_from: "phone", p_printer_id: null, p_target: "browser",
    });
    expect(job.routed_by).toBe("requested");
  });

  it("saving a printer sends the payload as p_printer; removing one with jobs throws its message", async () => {
    const saved = mockClient({ data: { ok: true, created: true, printer: { id: "p-1", code: "MFG-1" } }, error: null });
    const result = await whRpc(
      "rpc_wh_save_printer",
      { p_printer: { code: "MFG-1", transport: "agent", address: "tcp://10.0.0.5:9100", label_stock: "green_4x2" } },
      "fallback",
      saved,
    );
    expect(result.created).toBe(true);
    const busy = mockClient({
      data: { ok: false, error: "printer_has_jobs", message: "MFG-1 still has 2 label jobs queued or printing; let them finish or cancel them first." },
      error: null,
    });
    await expect(whRpc("rpc_wh_delete_printer", { p_id: "p-1" }, "fallback", busy)).rejects.toThrow("MFG-1 still has 2 label jobs");
  });
});

// ---- Slice 4F: counts, moves, reconcile, printers, physical layer ------------------

describe("count RPC contracts", () => {
  const lines = [
    { sku_id: "sku-1", container_id: "ctr-1", counted_qty: 12, scan_value: "%C-466-007" },
    { sku_id: "sku-2", container_id: null, counted_qty: 3, scan_value: "850001234567" },
  ];

  it("record count sends the location, lines, task, start time and a fresh client_event_id", async () => {
    const client = mockClient({
      data: { ok: true, count_task_id: "t-1", status: "submitted", location: { code: "02-01-2" }, lines: [] },
      error: null,
    });
    const res = await recordWhCount(
      { locationId: "loc-1", lines, countTaskId: "t-1", startedAt: "2026-10-26T14:00:00Z" },
      client,
    );
    const [name, args] = client.rpc.mock.calls[0];
    expect(name).toBe("rpc_wh_record_count");
    expect(args).toMatchObject({
      p_location_id: "loc-1",
      p_lines: lines,
      p_count_task_id: "t-1",
      p_started_at: "2026-10-26T14:00:00Z",
    });
    expect(args.p_client_event_id).toMatch(UUID_RE);
    expect(res.status).toBe("submitted");
  });

  it("record count without a task sends nulls, keeps a given event id and throws the refusal", async () => {
    const client = mockClient({
      data: { ok: false, error: "container_void", message: "C-466-007 was relabelled as C-466-007R1; scan the green label." },
      error: null,
    });
    await expect(recordWhCount({ locationId: "loc-1", lines: [], clientEventId: "evt-9" }, client)).rejects.toThrow(
      "scan the green label",
    );
    expect(client.rpc.mock.calls[0][1]).toMatchObject({ p_count_task_id: null, p_started_at: null, p_client_event_id: "evt-9" });
  });

  it("approve sends the task and the decisions; unlisted lines are the server's accept", async () => {
    const client = mockClient({
      data: { ok: true, count_task_id: "t-1", lines: 2, adjusted_units: 3, levels_delta: -3, recounts: [] },
      error: null,
    });
    const decisions = [{ line_id: "l-1", resolution: "misplaced" as const }];
    const res = await approveWhVariance({ countTaskId: "t-1", decisions }, client);
    expect(client.rpc).toHaveBeenCalledWith("rpc_wh_approve_variance", { p_count_task_id: "t-1", p_decisions: decisions });
    expect(res.levels_delta).toBe(-3);
    const refused = mockClient({
      data: { ok: false, error: "forbidden", message: "Approving count variances needs a manager or admin." },
      error: null,
    });
    await expect(approveWhVariance({ countTaskId: "t-1", decisions: [] }, refused)).rejects.toThrow("needs a manager or admin");
  });

  it("the scheduler takes no arguments; the reconcile passes p_create_counts", async () => {
    const sched = mockClient({
      data: { ok: true, created: 4, due: 9, already_open: 1, left_for_later: 4, daily_cap: 4, scheduled_today: 4 },
      error: null,
    });
    const s = await scheduleWhCounts(sched);
    expect(sched.rpc).toHaveBeenCalledWith("rpc_wh_schedule_counts", {});
    expect(s.left_for_later).toBe(4);
    const rec = mockClient({ data: { ok: true, run_id: "r-1", counts_created: 0, counts_enabled: false }, error: null });
    await runWhReconcile({ createCounts: false }, rec);
    expect(rec.rpc).toHaveBeenCalledWith("rpc_wh_reconcile_physical", { p_create_counts: false });
    const denied = mockClient({ data: { ok: false, error: "forbidden", message: "The physical reconciliation needs an admin." }, error: null });
    await expect(runWhReconcile({ createCounts: true }, denied)).rejects.toThrow("needs an admin");
  });
});

describe("printer RPC contracts", () => {
  const row = {
    id: "p-1",
    code: "DOCK-1",
    name: "Dock printer",
    station_location_id: "st-1",
    transport: "agent",
    address: "tcp://10.0.0.5:9100",
    label_stock: "white_4x2",
    dpi: 203,
    agent_id: "agent-dock",
    last_seen_at: null,
    active: true,
    created_at: "2026-10-26T00:00:00Z",
    updated_at: "2026-10-26T00:00:00Z",
    row_version: 4,
  };

  it("save sends the payload as p_printer and returns the row", async () => {
    const client = mockClient({ data: { ok: true, created: false, printer: row }, error: null });
    const res = await saveWhPrinter({ id: "p-1", name: "Dock", row_version: 4 }, client);
    expect(client.rpc).toHaveBeenCalledWith("rpc_wh_save_printer", { p_printer: { id: "p-1", name: "Dock", row_version: 4 } });
    expect(res.printer.code).toBe("DOCK-1");
  });

  it("a stale save throws WhPrinterStaleError carrying the current row; other refusals throw their message", async () => {
    const stale = mockClient({
      data: {
        ok: false,
        error: "stale",
        message: "DOCK-1 changed since it was loaded; reload it and try again.",
        printer: { ...row, row_version: 5 },
      },
      error: null,
    });
    const err = await saveWhPrinter({ id: "p-1", row_version: 4 }, stale).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WhPrinterStaleError);
    expect((err as WhPrinterStaleError).printer?.row_version).toBe(5);
    const bad = mockClient({ data: { ok: false, error: "invalid_address", message: "Unknown printer address lpt1" }, error: null });
    const plain = await saveWhPrinter({ code: "X" }, bad).catch((e: unknown) => e);
    expect(plain).not.toBeInstanceOf(WhPrinterStaleError);
    expect((plain as Error).message).toContain("Unknown printer address");
    const transport = { code: "PGRST", message: "network" };
    await expect(saveWhPrinter({ code: "X" }, mockClient({ data: null, error: transport }))).rejects.toBe(transport);
  });

  it("delete sends p_id and throws while jobs wait", async () => {
    const ok = mockClient({
      data: { ok: true, printer: { ...row, active: false }, deactivated: true, already_inactive: false },
      error: null,
    });
    await deleteWhPrinter("p-1", ok);
    expect(ok.rpc).toHaveBeenCalledWith("rpc_wh_delete_printer", { p_id: "p-1" });
    const busy = mockClient({
      data: { ok: false, error: "printer_has_jobs", message: "DOCK-1 still has 1 label job queued or printing." },
      error: null,
    });
    await expect(deleteWhPrinter("p-1", busy)).rejects.toThrow("still has 1 label job");
  });

  it("the form round-trips a row and builds the payload the RPC takes", () => {
    const form = printerFormFrom(row as never);
    expect(form).toMatchObject({ id: "p-1", rowVersion: 4, transport: "agent", agentId: "agent-dock", dpi: 203 });
    expect(printerFormProblems(form)).toEqual([]);
    expect(printerPayload(form)).toEqual({
      id: "p-1",
      row_version: 4,
      code: "DOCK-1",
      name: "Dock printer",
      transport: "agent",
      address: "tcp://10.0.0.5:9100",
      label_stock: "white_4x2",
      dpi: 203,
      station_location_id: "st-1",
      agent_id: "agent-dock",
      active: true,
    });
    const browser = printerPayload({ ...EMPTY_PRINTER_FORM, code: "desk-2", transport: "browser", address: "tcp://x" });
    expect(browser).toMatchObject({ code: "DESK-2", name: "DESK-2", transport: "browser", address: null });
    expect(browser.id).toBeUndefined();
  });

  it("lists what is wrong with a form; only agent printers need an address and an agent id", () => {
    expect(printerFormProblems({ ...EMPTY_PRINTER_FORM, code: "DOCK 1", address: "lpt1", agentId: "" })).toHaveLength(3);
    expect(printerFormProblems({ ...EMPTY_PRINTER_FORM, code: "DESK-2", transport: "browser", address: "" })).toEqual([]);
  });
});

describe("physical layer switch", () => {
  function settingsClient(physical: unknown) {
    return {
      rpc: vi.fn(async (fn: string, args?: { p_key?: string; p_value?: unknown }) => {
        if (fn === "rpc_wh_get_settings") {
          return { data: { ok: true, settings: { physical_layer: physical, outbound: { mode: "practice" } } }, error: null };
        }
        return { data: { ok: true, key: args?.p_key, value: args?.p_value }, error: null };
      }),
    };
  }

  it("set live reads the current value and changes only live_since", async () => {
    const client = settingsClient({ enabled: false, mint_lpns: true, live_since: null, note: "kept" });
    await setWhPhysicalLayerLive({ liveSince: "2026-10-26T15:00:00.000Z" }, client);
    expect(client.rpc.mock.calls[0][0]).toBe("rpc_wh_get_settings");
    expect(client.rpc).toHaveBeenLastCalledWith("rpc_wh_set_setting", {
      p_key: "physical_layer",
      p_value: { enabled: false, mint_lpns: true, live_since: "2026-10-26T15:00:00.000Z", note: "kept" },
    });
  });

  it("clear live writes null and survives a missing setting", async () => {
    const client = settingsClient(undefined);
    await setWhPhysicalLayerLive({ liveSince: null }, client);
    expect(client.rpc).toHaveBeenLastCalledWith("rpc_wh_set_setting", { p_key: "physical_layer", p_value: { live_since: null } });
  });

  it("reads live only once live_since has passed", () => {
    const now = Date.parse("2026-10-26T12:00:00Z");
    expect(readPhysicalLayer({ live_since: "2026-10-26T11:00:00Z", mint_lpns: true }, now)).toMatchObject({
      live: true,
      mint_lpns: true,
      enabled: false,
    });
    expect(readPhysicalLayer({ live_since: "2026-10-27T00:00:00Z" }, now).live).toBe(false);
    expect(readPhysicalLayer({ live_since: null }, now)).toMatchObject({ live: false, live_since: null });
    expect(readPhysicalLayer("junk", now)).toMatchObject({ live: false, enabled: false, mint_lpns: false });
  });
});

describe("count path and the phone's scanned lines", () => {
  const task = (id: string, seq: number | null, code: string, due: string | null = "2026-10-26") => ({
    id,
    due_date: due,
    created_at: "2026-10-26T08:00:00Z",
    location: { code, pick_sequence: seq },
  });

  it("orders the path by pick_sequence, unsequenced last", () => {
    const path = orderCountPath([task("c", 3010, "03-01-1"), task("a", null, "IN-01"), task("b", 2021, "02-02-1")]);
    expect(path.map((t) => t.id)).toEqual(["b", "c", "a"]);
  });

  it("finds the next task after the current one, skipping done ones and wrapping", () => {
    const path = [task("a", 1, "A"), task("b", 2, "B"), task("c", 3, "C")];
    expect(nextCountTask(path, "a", new Set(["a"]))?.id).toBe("b");
    expect(nextCountTask(path, "b", new Set(["a", "b"]))?.id).toBe("c");
    expect(nextCountTask(path, "c", new Set(["c"]))?.id).toBe("a");
    expect(nextCountTask(path, null, new Set(["a"]))?.id).toBe("b");
    expect(nextCountTask(path, "c", new Set(["a", "b", "c"]))).toBeNull();
  });

  it("treats undated and past-due tasks as due", () => {
    expect(isCountDue({ due_date: null }, "2026-10-26")).toBe(true);
    expect(isCountDue({ due_date: "2026-10-25" }, "2026-10-26")).toBe(true);
    expect(isCountDue({ due_date: "2026-10-27" }, "2026-10-26")).toBe(false);
  });

  it("flags a white label in RTS and a green one in RAW", () => {
    expect(labelColourFlag("white", "RTS")).toBe("needs_green");
    expect(labelColourFlag("green", "RAW")).toBe("needs_white");
    expect(labelColourFlag("green", "RTS")).toBeNull();
    expect(labelColourFlag("white", "RAW")).toBeNull();
  });

  const carton = (over: Partial<WhCountEntry> = {}): WhCountEntry => ({
    key: "ctr-1",
    skuId: "sku-1",
    sku: "BW20",
    productName: "Bowl 20",
    containerId: "ctr-1",
    containerCode: "C-466-007",
    containerState: "sealed",
    qty: 12,
    scanValue: "%C-466-007",
    labelFlag: null,
    needsUnits: false,
    ...over,
  });

  it("adds one loose unit per product scan, newest line first", () => {
    let e: WhCountEntry[] = [carton()];
    e = addLooseUnit(e, { skuId: "sku-2", sku: "NB4", productName: null, scanValue: "850001" });
    e = addLooseUnit(e, { skuId: "sku-2", sku: "NB4", productName: null, scanValue: "850001" });
    expect(e.map((x) => [x.key, x.qty])).toEqual([
      [looseKey("sku-2"), 2],
      ["ctr-1", 12],
    ]);
  });

  it("never counts a carton twice and keys mixed cartons per SKU", () => {
    const first = addCartonEntries([], [carton()]);
    expect(first.duplicate).toBe(false);
    const again = addCartonEntries(first.entries, [carton({ qty: 99 })]);
    expect(again.duplicate).toBe(true);
    expect(again.entries).toHaveLength(1);
    expect(again.entries[0].qty).toBe(12);
    expect(cartonKey("ctr-2", "sku-1", true)).toBe("ctr-2:sku-1");
    expect(cartonKey("ctr-2", "sku-1", false)).toBe("ctr-2");
  });

  it("the stepper clamps and clears needsUnits; remove drops a line", () => {
    const open = [carton({ containerState: "open", qty: 0, needsUnits: true })];
    expect(setEntryQty(open, "ctr-1", 7)[0]).toMatchObject({ qty: 7, needsUnits: false });
    expect(setEntryQty(open, "ctr-1", -4)[0].qty).toBe(0);
    expect(removeEntry(open, "ctr-1")).toEqual([]);
  });

  it("builds p_lines: loose zeros dropped, an empty carton kept", () => {
    const loose = (skuId: string, qty: number, scan: string): WhCountEntry =>
      carton({ key: looseKey(skuId), skuId, containerId: null, containerCode: null, containerState: null, qty, scanValue: scan });
    const entries = [carton({ qty: 0, containerState: "open" }), loose("sku-2", 0, "850001"), loose("sku-3", 4, "NB4")];
    expect(countLinesPayload(entries)).toEqual([
      { sku_id: "sku-1", container_id: "ctr-1", counted_qty: 0, scan_value: "%C-466-007" },
      { sku_id: "sku-3", container_id: null, counted_qty: 4, scan_value: "NB4" },
    ]);
  });
});

describe("likelyCause", () => {
  const now = Date.parse("2026-10-26T16:00:00Z");
  const task = {
    location_id: "loc-1",
    started_at: "2026-10-26T14:00:00Z",
    submitted_at: "2026-10-26T14:20:00Z",
    moved_during_count: false,
  };
  const line = { sku_id: "sku-1", container_id: null, expected_qty: 10, counted_qty: 8, found_container_elsewhere: false, variance: -2 };
  const mv = (type: string, at: string, over: Partial<WhCountMovement> = {}): WhCountMovement => ({
    id: `${type}-${at}`,
    type,
    sku_id: "sku-1",
    qty: 2,
    from_location_id: "loc-1",
    to_location_id: null,
    from_container_id: null,
    to_container_id: null,
    created_at: at,
    note: null,
    sku: { sku: "BW20" },
    from_container: null,
    to_container: null,
    ...over,
  });

  it("says a matching line matches and names a carton found elsewhere", () => {
    expect(likelyCause(task, { ...line, counted_qty: 10, variance: 0 }, [], now)).toBe("Matches");
    expect(
      likelyCause(
        task,
        { ...line, found_container_elsewhere: true, container: { code: "C-466-007", location: { code: "02-01-3" } } },
        [],
        now,
      ),
    ).toBe("C-466-007 was booked at 02-01-3; found here");
  });

  it("blames a movement during the count first", () => {
    const moved = [mv("putaway", "2026-10-26T14:10:00Z", { to_location_id: "loc-1" })];
    expect(likelyCause({ ...task, moved_during_count: true }, line, moved, now)).toMatch(/^Stock moved during the count: put away 2/);
  });

  it("names a ship settlement, then a carton opened without a move", () => {
    expect(likelyCause(task, line, [mv("ship_settle", "2026-10-26T09:00:00Z")], now)).toMatch(/^Ship settlement drew 2 here/);
    const opened = [mv("open_container", "2026-10-26T10:00:00Z", { from_container: { code: "C-466-009" } })];
    expect(likelyCause(task, line, opened, now)).toMatch(/^C-466-009 opened .* without a move$/);
  });

  it("ignores other SKUs and falls back to the shape of the variance", () => {
    const other = [mv("ship_settle", "2026-10-26T09:00:00Z", { sku_id: "sku-9" })];
    expect(likelyCause(task, { ...line, expected_qty: 0, counted_qty: 3, variance: 3 }, other, now)).toBe(
      "Not booked here: misplaced from another bin?",
    );
    expect(likelyCause(task, { ...line, counted_qty: 0, variance: -10 }, [], now)).toBe("Nothing found: moved without a scan?");
    expect(likelyCause(task, line, [], now)).toBe("Fewer than booked; no recent movement");
  });

  it("sorts reconcile lines by the size of the residual", () => {
    const lines = [
      { residual: 2, bucket: "finished", sku: { sku: "NB4" } },
      { residual: -5, bucket: "finished", sku: { sku: "BW20" } },
      { residual: 2, bucket: "finished", sku: { sku: "AB1" } },
    ];
    expect(sortReconcileLines(lines).map((l) => l.sku.sku)).toEqual(["BW20", "AB1", "NB4"]);
  });
});
