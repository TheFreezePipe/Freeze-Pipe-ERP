import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

// Settings › Warehouse › Labels: the carton label size radios, the format
// summary and the two sample prints. Only the hooks the card uses are stubbed;
// LabelSheet is replaced by a probe that echoes the props it was given.

const mocks = vi.hoisted(() => ({
  settings: { data: undefined as unknown, isLoading: false },
  setSetting: vi.fn(),
  sample: { data: null as { id: string; code: string } | null, isLoading: false, isError: false },
  requestBrowser: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }) }));

vi.mock("@/lib/hooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/hooks")>();
  return {
    ...actual,
    useWarehouseSettings: () => mocks.settings,
    useSetWarehouseSetting: () => ({ mutate: mocks.setSetting, isPending: false }),
  };
});

vi.mock("@/lib/hooks/use-warehouse-labels", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/hooks/use-warehouse-labels")>();
  return {
    ...actual,
    useWhSampleContainer: () => mocks.sample,
    useWhRequestBrowserLabels: () => ({ mutate: mocks.requestBrowser, isPending: false }),
  };
});

vi.mock("@/components/warehouse/LabelSheet", () => ({
  default: (props: { kind: string; ids: string[]; from?: string; title?: string; existingJob?: { id: string } | null }) => (
    <div
      data-testid="label-sheet"
      data-kind={props.kind}
      data-ids={props.ids.join(",")}
      data-from={props.from}
      data-title={props.title}
      data-existing-job={props.existingJob?.id ?? ""}
    />
  ),
}));

const { LabelsCard } = await import("./WarehouseSettings");
const labelHooks = await vi.importActual<typeof import("@/lib/hooks/use-warehouse-labels")>("@/lib/hooks/use-warehouse-labels");

const SAMPLE = { id: "c-1", code: "C-OB-0007" };
const SAMPLE_BUTTON = /print sample on my station printer/i;
const BROWSER_BUTTON = /print sample from browser/i;

function radio(name: string) {
  return screen.getByRole("radio", { name });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.settings = { data: { labels: { lpn: "4x2", location: "3x1", dpi: 203 } }, isLoading: false };
  mocks.sample = { data: SAMPLE, isLoading: false, isError: false };
});

describe("Labels card", () => {
  it("reflects 4x2 and summarises its stock and barcode", () => {
    render(<LabelsCard />);
    expect(screen.getByText("Labels")).toBeTruthy();
    expect(radio("4 × 2, one label per carton")).toBeChecked();
    expect(radio("4 × 6 pair, two labels per carton")).not.toBeChecked();
    expect(screen.getByText(/Carton: white 4×2 · RTS: green 4×2 · Location and station: white 3×1/)).toBeTruthy();
    expect(screen.getByText(/Code 128, value % plus the code/)).toBeTruthy();
    expect(screen.getByText(/there is no label editor/)).toBeTruthy();
  });

  it("reflects 4x6 and switches the summary to the pair stock", () => {
    mocks.settings = { data: { labels: { lpn: "4x6", location: "3x1", dpi: 203 } }, isLoading: false };
    render(<LabelsCard />);
    expect(radio("4 × 6 pair, two labels per carton")).toBeChecked();
    expect(radio("4 × 2, one label per carton")).not.toBeChecked();
    expect(screen.getByText(/Carton: white 4×6 pair · RTS: green 4×6 pair · Location and station: white 3×1/)).toBeTruthy();
  });

  it("writes the whole labels value with the new size and keeps the other keys", () => {
    mocks.settings = { data: { labels: { lpn: "4x2", location: "3x1", dpi: 300 } }, isLoading: false };
    render(<LabelsCard />);
    fireEvent.click(radio("4 × 6 pair, two labels per carton"));
    expect(mocks.setSetting).toHaveBeenCalledTimes(1);
    expect(mocks.setSetting).toHaveBeenCalledWith(
      { key: "labels", value: { lpn: "4x6", location: "3x1", dpi: 300 } },
      expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
    );
  });

  it("does not write when the selected size is chosen again", () => {
    render(<LabelsCard />);
    fireEvent.click(radio("4 × 2, one label per carton"));
    expect(mocks.setSetting).not.toHaveBeenCalled();
  });

  it("falls back to 4x2 and the default keys when labels was never saved", () => {
    mocks.settings = { data: {}, isLoading: false };
    render(<LabelsCard />);
    expect(radio("4 × 2, one label per carton")).toBeChecked();
    fireEvent.click(radio("4 × 6 pair, two labels per carton"));
    expect(mocks.setSetting).toHaveBeenCalledWith(
      { key: "labels", value: { lpn: "4x6", location: "3x1", dpi: 203 } },
      expect.any(Object),
    );
  });

  it("toasts the result of the change", () => {
    render(<LabelsCard />);
    fireEvent.click(radio("4 × 6 pair, two labels per carton"));
    const options = mocks.setSetting.mock.calls[0][1] as { onSuccess: () => void; onError: (err: unknown) => void };
    options.onSuccess();
    expect(mocks.toast).toHaveBeenLastCalledWith({ title: "Carton labels set to 4×6 pair" });
    options.onError(new Error("labels.lpn must be 4x2 or 4x6"));
    expect(mocks.toast).toHaveBeenLastCalledWith({
      title: "Couldn't change the label size",
      description: "labels.lpn must be 4x2 or 4x6",
      variant: "destructive",
    });
  });

  it("disables both sample buttons and says why when there is no carton", () => {
    mocks.sample = { data: null, isLoading: false, isError: false };
    render(<LabelsCard />);
    expect(screen.getByRole("button", { name: BROWSER_BUTTON })).toBeDisabled();
    expect(screen.getByRole("button", { name: SAMPLE_BUTTON })).toBeDisabled();
    expect(screen.getByText("Check in a shipment with carton labels first.")).toBeTruthy();
  });

  it("opens the sheet for the sample carton on the station printer path", async () => {
    render(<LabelsCard />);
    expect(screen.getByText(/Samples use the newest carton, C-OB-0007/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: SAMPLE_BUTTON }));
    const sheet = await screen.findByTestId("label-sheet");
    expect(sheet.dataset.kind).toBe("lpn");
    expect(sheet.dataset.ids).toBe("c-1");
    expect(sheet.dataset.from).toBe("desktop");
    expect(sheet.dataset.title).toBe("Sample carton label");
    expect(sheet.dataset.existingJob).toBe("");
    expect(mocks.requestBrowser).not.toHaveBeenCalled();
  });

  it("forces the browser path by queuing a browser job and handing it to the sheet", async () => {
    mocks.requestBrowser.mockImplementation((_req: unknown, options: { onSuccess: (res: unknown) => void }) =>
      options.onSuccess({ job_id: "job-1", target: "browser", payload: { kind: "lpn" }, message: null }),
    );
    render(<LabelsCard />);
    fireEvent.click(screen.getByRole("button", { name: BROWSER_BUTTON }));
    expect(mocks.requestBrowser).toHaveBeenCalledWith(
      { kind: "lpn", ids: ["c-1"], from: "desktop" },
      expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
    );
    const sheet = await screen.findByTestId("label-sheet");
    expect(sheet.dataset.kind).toBe("lpn");
    expect(sheet.dataset.ids).toBe("c-1");
    expect(sheet.dataset.title).toBe("Sample carton label");
    expect(sheet.dataset.existingJob).toBe("job-1");
  });

  it("opens nothing and says so when printing is blocked", () => {
    mocks.requestBrowser.mockImplementation((_req: unknown, options: { onSuccess: (res: unknown) => void }) =>
      options.onSuccess({ job_id: "job-2", target: "none", payload: null, message: "Printing is blocked on this environment (outbound mode is blocked)." }),
    );
    render(<LabelsCard />);
    fireEvent.click(screen.getByRole("button", { name: BROWSER_BUTTON }));
    expect(screen.queryByTestId("label-sheet")).toBeNull();
    expect(mocks.toast).toHaveBeenCalledWith({
      title: "Sample not printed",
      description: "Printing is blocked on this environment (outbound mode is blocked).",
    });
  });
});

describe("sample carton hook functions", () => {
  function selectClient(result: { data: unknown; error: unknown }) {
    const chain = {
      select: vi.fn(() => chain),
      neq: vi.fn(() => chain),
      order: vi.fn(() => chain),
      limit: vi.fn(async () => result),
    };
    return { chain, client: { from: vi.fn(() => chain) } };
  }

  it("reads the newest carton that is not void", async () => {
    const { chain, client } = selectClient({
      data: [{ id: "c-9", code: "C-OB-0009", created_at: "2026-10-28T10:00:00Z" }],
      error: null,
    });
    await expect(labelHooks.fetchWhSampleContainer(client)).resolves.toEqual({ id: "c-9", code: "C-OB-0009" });
    expect(client.from).toHaveBeenCalledWith("wh_containers");
    expect(chain.select).toHaveBeenCalledWith("id, code, created_at");
    expect(chain.neq).toHaveBeenCalledWith("state", "void");
    expect(chain.order).toHaveBeenCalledWith("created_at", { ascending: false });
    expect(chain.limit).toHaveBeenCalledWith(1);
  });

  it("returns null when there is no carton", async () => {
    const { client } = selectClient({ data: [], error: null });
    await expect(labelHooks.fetchWhSampleContainer(client)).resolves.toBeNull();
  });

  it("throws the query error", async () => {
    const failure = { message: "permission denied for table wh_containers" };
    const { client } = selectClient({ data: null, error: failure });
    await expect(labelHooks.fetchWhSampleContainer(client)).rejects.toBe(failure);
  });

  it("asks the server for the browser target", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { ok: true, job_id: "job-1", target: "browser" }, error: null });
    const res = await labelHooks.requestWhBrowserLabels({ kind: "lpn", ids: ["c-1"], from: "desktop" }, { rpc });
    expect(rpc).toHaveBeenCalledWith("rpc_wh_request_labels", {
      p_kind: "lpn",
      p_ids: ["c-1"],
      p_from: "desktop",
      p_printer_id: null,
      p_target: "browser",
    });
    expect(res.job_id).toBe("job-1");
  });

  it("surfaces the server's message when the request is refused", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { ok: false, error: "items_not_found", message: "No such carton." }, error: null });
    await expect(labelHooks.requestWhBrowserLabels({ kind: "lpn", ids: ["c-1"], from: "desktop" }, { rpc })).rejects.toThrow(
      "No such carton.",
    );
  });
});
