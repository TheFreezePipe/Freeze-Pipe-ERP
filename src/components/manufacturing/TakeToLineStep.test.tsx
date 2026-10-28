import { createRef, type RefObject } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { WhNextCarton } from "@/lib/hooks/use-warehouse";
import { WhMfgError } from "@/lib/hooks/use-warehouse-mfg";
import type { StepScanTarget } from "./TakeToLineStep";

// Take-to-line step: the FIFO suggestion above the scan, the fifo_suggests
// prompt with its four reasons, and the override retry. The scan resolver,
// the take-to-line mutation, the next-carton query and the flash are stubbed.

const mocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  take: vi.fn(),
  show: vi.fn(),
  next: undefined as Record<string, unknown> | undefined,
  nextCalls: [] as string[][],
}));

vi.mock("@/lib/hooks", () => ({
  resolveWhScan: mocks.resolve,
  useWhStartStation: () => ({ mutate: vi.fn() }),
}));

vi.mock("@/lib/hooks/use-warehouse-mfg", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/hooks/use-warehouse-mfg")>();
  return { ...actual, useWhTakeToLine: () => ({ mutateAsync: mocks.take }) };
});

vi.mock("@/lib/hooks/use-warehouse-fifo", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/hooks/use-warehouse-fifo")>();
  return {
    ...actual,
    useWhNextCartons: (ids: string[]) => {
      mocks.nextCalls.push(ids);
      return { data: mocks.next };
    },
  };
});

vi.mock("@/pages/floor/use-floor-flash", () => ({ useFloorFlash: () => ({ flash: null, show: mocks.show }) }));
vi.mock("@/components/warehouse/ScanSink", () => ({ ScanSink: () => null }));

const { TakeToLineStep } = await import("./TakeToLineStep");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const YEAR = new Date().getFullYear();
const PRODUCT = { id: "sku-1", sku: "BW20" };

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
} as WhNextCarton;

function resolvesTo(id: string, code: string, location: string) {
  mocks.resolve.mockResolvedValue({
    kind: "container",
    id,
    code,
    match: { id, code, sku_id: "sku-1", sku: "BW20", qty: 48, state: "sealed", location_code: location },
    candidates: [],
  });
}

function fifoRefusal() {
  return new WhMfgError("C-472-003 is newer; C-466-004 in 05-02-1 is older.", "fifo_suggests", {
    suggested: OLDER,
    scanned: { code: "C-472-003", factory_order_number: "FO-2026-131", order_date: null, received_at: null, location_code: "05-03-1" },
  });
}

function renderStep(product: { id: string; sku: string } | null = PRODUCT) {
  const ref = createRef<StepScanTarget>();
  const onTaken = vi.fn();
  render(
    <MemoryRouter>
      <TakeToLineStep ref={ref} product={product} taken={[]} noCarton={null} onTaken={onTaken} onNoCarton={vi.fn()} />
    </MemoryRouter>,
  );
  return { ref, onTaken };
}

async function scan(ref: RefObject<StepScanTarget | null>, raw: string) {
  await act(async () => {
    ref.current?.scan(raw);
  });
}

const PULL = "Pull C-466-004 from 05-02-1 (oldest batch, FO-2026-118)";
const PROMPT = "C-472-003 is newer. C-466-004 in 05-02-1 is older (FO-2026-118, received Oct 20).";

function pullLine() {
  return screen.queryByText((_, el) => el?.tagName === "P" && el.textContent === PULL);
}

function queryPromptSentence() {
  return screen.queryByText((_, el) => el?.tagName === "P" && el.textContent === PROMPT);
}

function promptSentence() {
  const el = queryPromptSentence();
  if (!el) throw new Error("The FIFO prompt is not shown");
  return el;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.next = { "sku-1": OLDER };
  mocks.nextCalls = [];
});

describe("TakeToLineStep · FIFO suggestion", () => {
  it("names the carton to pull for the task's SKU", () => {
    renderStep();
    expect(mocks.nextCalls.at(-1)).toEqual(["sku-1"]);
    expect(pullLine()).toBeInTheDocument();
    // The code opens the passport in a new tab, so the task on this page is kept.
    const link = screen.getByRole("link", { name: "C-466-004" });
    expect(link).toHaveAttribute("href", "/inventory/cartons/C-466-004");
    expect(link).toHaveAttribute("target", "_blank");
  });

  it("shows nothing when the step does not know the SKU, or nothing raw is on the shelf", () => {
    renderStep(null);
    expect(mocks.nextCalls.at(-1)).toEqual([]);
    expect(screen.queryByText(/^Pull /)).toBeNull();
  });

  it("shows nothing when the server names no carton", () => {
    mocks.next = { "sku-1": null };
    renderStep();
    expect(screen.queryByText(/Pull /)).toBeNull();
  });

  it("takes the suggested carton with the normal flash", async () => {
    resolvesTo("c-old", "C-466-004", "05-02-1");
    mocks.take.mockResolvedValue({
      ok: true,
      units: 48,
      from: { code: "05-02-1" },
      fifo: { followed: true, suggested_code: "C-466-004", override: null },
    });
    const { ref, onTaken } = renderStep();
    await scan(ref, "%C-466-004");
    await waitFor(() => expect(onTaken).toHaveBeenCalled());
    const params = mocks.take.mock.calls[0][0];
    expect(params.containerId).toBe("c-old");
    expect(params.clientEventId).toMatch(UUID);
    expect(params.fifoOverride).toBeUndefined();
    expect(onTaken).toHaveBeenCalledWith(expect.objectContaining({ id: "c-old", units: 48, from_code: "05-02-1", already_at_line: false }));
    expect(mocks.show).toHaveBeenLastCalledWith("ok", "C-466-004 to the line");
  });
});

describe("TakeToLineStep · fifo_suggests prompt", () => {
  it("says why the other carton is older, offers four reasons and moves nothing", async () => {
    resolvesTo("c-new", "C-472-003", "05-03-1");
    mocks.take.mockRejectedValueOnce(fifoRefusal());
    const { ref, onTaken } = renderStep();
    await scan(ref, "%C-472-003");
    await waitFor(() => expect(promptSentence()).toBeInTheDocument());
    for (const name of ["Buried", "Damaged", "Closer", "Other", "Take the older one instead"]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
    expect(onTaken).not.toHaveBeenCalled();
    expect(mocks.show).toHaveBeenLastCalledWith("warn", "Older carton on the shelf");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(pullLine()).toBeNull();
    for (const code of ["C-472-003", "C-466-004"]) {
      const link = screen.getByRole("link", { name: code });
      expect(link).toHaveAttribute("href", `/inventory/cartons/${code}`);
      expect(link).toHaveAttribute("target", "_blank");
    }
  });

  it("a reason retries the same carton with the same client event id and the override", async () => {
    resolvesTo("c-new", "C-472-003", "05-03-1");
    mocks.take.mockRejectedValueOnce(fifoRefusal()).mockResolvedValueOnce({
      ok: true,
      units: 48,
      from: { code: "05-03-1" },
      fifo: { followed: false, suggested_code: "C-466-004", override: "buried" },
    });
    const { ref, onTaken } = renderStep();
    await scan(ref, "%C-472-003");
    await waitFor(() => expect(promptSentence()).toBeInTheDocument());
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Buried" }));
    });
    await waitFor(() => expect(onTaken).toHaveBeenCalled());
    const [first, retry] = mocks.take.mock.calls.map((c) => c[0]);
    expect(first.fifoOverride).toBeUndefined();
    expect(retry).toEqual({ containerId: "c-new", clientEventId: first.clientEventId, fifoOverride: "buried" });
    expect(onTaken).toHaveBeenCalledWith(expect.objectContaining({ id: "c-new", code: "C-472-003", units: 48, from_code: "05-03-1" }));
    expect(mocks.show).toHaveBeenLastCalledWith("warn", "Taken to the line · FIFO skipped (buried)");
    expect(queryPromptSentence()).toBeNull();
  });

  it("the normal flash when the retry says FIFO was followed after all", async () => {
    resolvesTo("c-new", "C-472-003", "05-03-1");
    mocks.take.mockRejectedValueOnce(fifoRefusal()).mockResolvedValueOnce({
      ok: true,
      units: 48,
      from: { code: "05-03-1" },
      fifo: { followed: true, suggested_code: null, override: null },
    });
    const { ref, onTaken } = renderStep();
    await scan(ref, "%C-472-003");
    await waitFor(() => expect(promptSentence()).toBeInTheDocument());
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Closer" }));
    });
    await waitFor(() => expect(onTaken).toHaveBeenCalled());
    expect(mocks.show).toHaveBeenLastCalledWith("ok", "C-472-003 to the line");
  });

  it("'Take the older one instead' clears the prompt and moves nothing", async () => {
    resolvesTo("c-new", "C-472-003", "05-03-1");
    mocks.take.mockRejectedValueOnce(fifoRefusal());
    const { ref, onTaken } = renderStep();
    await scan(ref, "%C-472-003");
    await waitFor(() => expect(promptSentence()).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Take the older one instead" }));
    expect(queryPromptSentence()).toBeNull();
    expect(pullLine()).toBeInTheDocument();
    expect(mocks.take).toHaveBeenCalledTimes(1);
    expect(onTaken).not.toHaveBeenCalled();
  });

  it("a transport error on the retry keeps the prompt and shows the error", async () => {
    resolvesTo("c-new", "C-472-003", "05-03-1");
    mocks.take.mockRejectedValueOnce(fifoRefusal()).mockRejectedValueOnce(new Error("Failed to fetch"));
    const { ref, onTaken } = renderStep();
    await scan(ref, "%C-472-003");
    await waitFor(() => expect(promptSentence()).toBeInTheDocument());
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Damaged" }));
    });
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Failed to fetch"));
    expect(promptSentence()).toBeInTheDocument();
    expect(onTaken).not.toHaveBeenCalled();
  });

  it("other errors still flash red with the server's sentence", async () => {
    resolvesTo("c-new", "C-472-003", "05-03-1");
    mocks.take.mockRejectedValueOnce(new WhMfgError("C-472-003 holds no stock.", "container_empty"));
    const { ref } = renderStep();
    await scan(ref, "%C-472-003");
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("C-472-003 holds no stock."));
    expect(mocks.show).toHaveBeenLastCalledWith("fail", "Not taken");
    expect(queryPromptSentence()).toBeNull();
  });
});
