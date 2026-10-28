import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { WhNextCarton } from "@/lib/hooks/use-warehouse";

// Manufacturing Overview: the FIFO "Next carton" line under each SKU row.
// The page's data hooks are stubbed; the next-carton hook records the SKU ids
// it was asked for and answers from `mocks.next`.

const mocks = vi.hoisted(() => ({
  inventory: [] as unknown[],
  next: undefined as Record<string, unknown> | undefined,
  nextCalls: [] as string[][],
}));

vi.mock("@/lib/hooks", () => ({
  useInventory: () => ({ data: mocks.inventory, isLoading: false }),
  useTaskLogs: () => ({ data: [], isLoading: false }),
  useForecastDemandMap: () => new Map<string, number>(),
}));

vi.mock("@/lib/hooks/use-marketing-signals", () => ({
  useUpcomingMarketingBySku: () => new Map(),
}));

vi.mock("@/lib/hooks/use-warehouse-fifo", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/hooks/use-warehouse-fifo")>();
  return {
    ...actual,
    useWhNextCartons: (ids: string[]) => {
      mocks.nextCalls.push(ids);
      return { data: mocks.next, isLoading: mocks.next === undefined };
    },
  };
});

const { default: ManufacturingDashboard } = await import("./ManufacturingDashboard");

function row(id: string, sku: string, category: string, levels: { raw: number; finished: number; demand: number }) {
  return {
    id: `inv-${id}`,
    sku_id: id,
    warehouse_raw: levels.raw,
    warehouse_prefilled_raw: 0,
    warehouse_in_production: 0,
    warehouse_finished: levels.finished,
    product: {
      id,
      sku,
      product_name: `${sku} product`,
      category,
      monthly_demand: levels.demand,
      abc_classification: "A",
    },
  };
}

const NEXT: WhNextCarton = {
  container_id: "c-1",
  code: "C-466-004",
  state: "open",
  qty: 30,
  bucket: "raw",
  location_id: "l-1",
  location_code: "05-02-1",
  factory_order_id: "fo-1",
  factory_order_number: "FO-2026-118",
  order_date: "2026-08-01",
  shipment_id: "s-1",
  shipment_number: "SH-1",
  received_at: `${new Date().getFullYear()}-10-20T15:00:00Z`,
  reason: "open_carton",
} as WhNextCarton;

function renderPage() {
  return render(
    <MemoryRouter>
      <ManufacturingDashboard />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mocks.nextCalls = [];
  mocks.next = undefined;
  mocks.inventory = [
    // Low finished stock against high demand: first by priority.
    row("sku-urgent", "BW20", "fillable", { raw: 100, finished: 2, demand: 300 }),
    row("sku-calm", "BW30", "fillable", { raw: 10, finished: 500, demand: 10 }),
    // Not fillable: not on the list, so not asked for.
    row("sku-part", "SP01", "spare_part", { raw: 5, finished: 5, demand: 5 }),
  ];
});

describe("Manufacturing Overview · next carton", () => {
  it("asks only for the SKUs on the list", () => {
    renderPage();
    const last = mocks.nextCalls.at(-1) ?? [];
    expect([...last].sort()).toEqual(["sku-calm", "sku-urgent"]);
  });

  it("names the next carton under the row and links its code to the passport", () => {
    mocks.next = { "sku-urgent": NEXT, "sku-calm": null };
    renderPage();
    const link = screen.getByRole("link", { name: "C-466-004" });
    expect(link).toHaveAttribute("href", "/inventory/cartons/C-466-004");
    expect(link.closest("p")).toHaveTextContent("Next carton: C-466-004 · 05-02-1 · FO-2026-118 · received Oct 20 · open carton");
    expect(screen.getByText("No raw carton on the shelf")).toBeInTheDocument();
  });

  it("keeps the SKU order and puts each line under its own row", () => {
    mocks.next = { "sku-urgent": NEXT, "sku-calm": null };
    renderPage();
    const urgent = screen.getByText("BW20");
    const calm = screen.getByText("BW30");
    expect(urgent.compareDocumentPosition(calm) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const line = screen.getByRole("link", { name: "C-466-004" });
    expect(urgent.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(line.compareDocumentPosition(calm) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("encodes the code in the link", () => {
    mocks.next = { "sku-urgent": { ...NEXT, code: "C-466/004 A" }, "sku-calm": null };
    renderPage();
    expect(screen.getByRole("link", { name: "C-466/004 A" })).toHaveAttribute("href", "/inventory/cartons/C-466%2F004%20A");
  });

  it("shows nothing while the suggestions load", () => {
    renderPage();
    expect(screen.queryByText(/Next carton:/)).toBeNull();
    expect(screen.queryByText("No raw carton on the shelf")).toBeNull();
    expect(screen.getByText("BW20")).toBeInTheDocument();
  });
});
