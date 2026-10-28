import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { WhNextCarton } from "@/lib/hooks/use-warehouse";
import { WhMfgError } from "@/lib/hooks/use-warehouse-mfg";

// Floor Move › Take to line with FIFO: a carton other than the suggestion is
// refused with fifo_suggests; the screen says why and lets the worker go on
// with a reason. The data hooks, the task shell, the scan sink and the flash
// are stubbed; the scan sink hands its onScan to the test.

const mocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  take: vi.fn(),
  show: vi.fn(),
  onScan: null as ((raw: string) => void) | null,
}));

vi.mock("@/lib/hooks", () => ({
  resolveWhScan: mocks.resolve,
  useWarehouseSettings: () => ({ data: {} }),
  useWhLocations: () => ({ data: [{ id: "l-line", code: "MFG-LINE", zone: "MFG", kind: "virtual", contents: [] }] }),
  useWhStartStation: () => ({ mutate: vi.fn() }),
  useWhSuggestPutaway: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/lib/hooks/use-warehouse-mfg", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/hooks/use-warehouse-mfg")>();
  return {
    ...actual,
    useWhTakeToLine: () => ({ mutateAsync: mocks.take }),
    useWhLooseBalances: () => ({ data: [], isLoading: false }),
    useWhMoveStock: () => ({ mutateAsync: vi.fn() }),
    useWhOpenContainer: () => ({ mutateAsync: vi.fn() }),
    useWhPutawayContainerMove: () => ({ mutateAsync: vi.fn() }),
  };
});

vi.mock("@/components/layout/TaskShell", () => ({
  TaskHeader: ({ title, progress, right }: { title: string; progress?: string; right?: ReactNode }) => (
    <div>
      <h1>{title}</h1>
      {progress && <span>{progress}</span>}
      {right}
    </div>
  ),
  TaskActions: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/warehouse/ScanSink", () => ({
  ScanSink: ({ onScan }: { onScan: (raw: string) => void }) => {
    mocks.onScan = onScan;
    return null;
  },
}));

vi.mock("./use-floor-flash", () => ({ useFloorFlash: () => ({ flash: null, show: mocks.show }) }));

const { default: GoMove } = await import("./GoMove");

const YEAR = new Date().getFullYear();

const OLDER: WhNextCarton = {
  container_id: "c-old",
  code: "C-466-004",
  state: "sealed",
  qty: 48,
  bucket: "raw",
  location_id: "l-old",
  location_code: "05-02-1",
  factory_order_id: "fo-118",
  factory_order_number: "FO-2026-118",
  order_date: `${YEAR}-08-01`,
  shipment_id: "s-1",
  shipment_number: "SH-1",
  received_at: `${YEAR}-10-20T15:00:00Z`,
  reason: "oldest_batch",
};

const PROMPT = "C-472-003 is newer. C-466-004 in 05-02-1 is older (FO-2026-118, received Oct 20).";

function resolvesTo(id: string, code: string, location: string) {
  mocks.resolve.mockResolvedValue({
    kind: "container",
    id,
    code,
    match: {
      id,
      code,
      sku_id: "sku-1",
      sku: "BW20",
      product_name: "Bowl",
      qty: 48,
      state: "sealed",
      label_stock: "white",
      location_id: `l-${location}`,
      location_code: location,
    },
    candidates: [],
  });
}

function fifoRefusal() {
  return new WhMfgError("C-472-003 is newer; C-466-004 in 05-02-1 is older.", "fifo_suggests", {
    suggested: OLDER,
    scanned: { code: "C-472-003", factory_order_number: "FO-2026-131", order_date: null, received_at: null, location_code: "05-03-1" },
  });
}

function queryPrompt() {
  return screen.queryByText((_, el) => el?.tagName === "P" && el.textContent === PROMPT);
}

async function scanAndTake(raw: string) {
  render(
    <MemoryRouter>
      <GoMove />
    </MemoryRouter>,
  );
  await act(async () => {
    mocks.onScan?.(raw);
  });
  await waitFor(() => expect(screen.getByRole("button", { name: /Take to line/ })).toBeInTheDocument());
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /Take to line/ }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.onScan = null;
});

describe("GoMove · take to line with FIFO", () => {
  it("takes the suggested carton with the normal flash", async () => {
    resolvesTo("c-old", "C-466-004", "05-02-1");
    mocks.take.mockResolvedValue({ ok: true, units: 48, from: { code: "05-02-1" }, fifo: { followed: true, suggested_code: "C-466-004", override: null } });
    await scanAndTake("%C-466-004");
    await waitFor(() => expect(mocks.show).toHaveBeenLastCalledWith("ok", "C-466-004 to the line"));
    expect(mocks.take.mock.calls[0][0]).toMatchObject({ containerId: "c-old" });
    expect(mocks.take.mock.calls[0][0].fifoOverride).toBeUndefined();
    expect(screen.getByText(/48 units from 05-02-1 to MFG-LINE/)).toBeInTheDocument();
  });

  it("a newer carton gets the prompt, not a block: the sentence, four reasons, nothing moved", async () => {
    resolvesTo("c-new", "C-472-003", "05-03-1");
    mocks.take.mockRejectedValueOnce(fifoRefusal());
    await scanAndTake("%C-472-003");
    await waitFor(() => expect(queryPrompt()).toBeInTheDocument());
    for (const name of ["Buried", "Damaged", "Closer", "Other", "Take the older one instead"]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
    expect(screen.queryByRole("button", { name: /Take to line/ })).toBeNull();
    expect(mocks.show).toHaveBeenLastCalledWith("warn", "Older carton on the shelf");
    expect(screen.getAllByRole("link", { name: "C-466-004" }).some((a) => a.getAttribute("target") === "_blank")).toBe(true);
  });

  it("a reason retries the same carton with the same client event id and records the skip", async () => {
    resolvesTo("c-new", "C-472-003", "05-03-1");
    mocks.take.mockRejectedValueOnce(fifoRefusal()).mockResolvedValueOnce({
      ok: true,
      units: 48,
      from: { code: "05-03-1" },
      fifo: { followed: false, suggested_code: "C-466-004", override: "buried" },
    });
    await scanAndTake("%C-472-003");
    await waitFor(() => expect(queryPrompt()).toBeInTheDocument());
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Buried" }));
    });
    await waitFor(() => expect(mocks.show).toHaveBeenLastCalledWith("warn", "Taken to the line · FIFO skipped (buried)"));
    const [first, retry] = mocks.take.mock.calls.map((c) => c[0]);
    expect(first.fifoOverride).toBeUndefined();
    expect(retry).toEqual({ containerId: "c-new", clientEventId: first.clientEventId, fifoOverride: "buried" });
    expect(queryPrompt()).toBeNull();
    expect(screen.getByText(/48 units from 05-03-1 to MFG-LINE · FIFO skipped \(buried\)/)).toBeInTheDocument();
    expect(screen.getByText("1 moved")).toBeInTheDocument();
  });

  it("'Take the older one instead' clears the prompt and says where the older carton is", async () => {
    resolvesTo("c-new", "C-472-003", "05-03-1");
    mocks.take.mockRejectedValueOnce(fifoRefusal());
    await scanAndTake("%C-472-003");
    await waitFor(() => expect(queryPrompt()).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Take the older one instead" }));
    expect(queryPrompt()).toBeNull();
    expect(screen.getByText("Scan C-466-004 in 05-02-1 and take it to the line instead.")).toBeInTheDocument();
    expect(mocks.take).toHaveBeenCalledTimes(1);
  });

  it("a transport error on the retry keeps the prompt and shows the error", async () => {
    resolvesTo("c-new", "C-472-003", "05-03-1");
    mocks.take.mockRejectedValueOnce(fifoRefusal()).mockRejectedValueOnce(new Error("Failed to fetch"));
    await scanAndTake("%C-472-003");
    await waitFor(() => expect(queryPrompt()).toBeInTheDocument());
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Other" }));
    });
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Failed to fetch"));
    expect(mocks.show).toHaveBeenLastCalledWith("fail", "Nothing moved");
    expect(queryPrompt()).toBeInTheDocument();
  });
});
