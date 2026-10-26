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
