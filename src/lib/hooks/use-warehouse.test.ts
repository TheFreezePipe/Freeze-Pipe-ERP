import { describe, it, expect, vi } from "vitest";
import { whRpc } from "./use-warehouse";
import { endWhStation, startWhStation } from "./use-warehouse-tasks";
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
