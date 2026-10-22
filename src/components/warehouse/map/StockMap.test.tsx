import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import staging from "@/lib/warehouse/__fixtures__/staging-layout.json";
import type { WhLayout, WhLocationSummary } from "@/lib/hooks";

// Stock › Map with the hooks stubbed: URL state drives mode, search, the
// drawer and the elevation.

const layout = staging as unknown as WhLayout;
const locations = (staging.locations as Record<string, unknown>[]).map((l) => {
  const stocked = l.code === "02-01-2";
  return {
    ...l,
    rack_code: (staging.racks as { id: string; code: string }[]).find((r) => r.id === l.rack_id)?.code ?? null,
    last_counted_at: null,
    label_printed_at: null,
    label_verified_at: null,
    bucket_lock: null,
    cartons: stocked ? 1 : 0,
    units: stocked ? 7 : 0,
    contents: stocked
      ? [{ container_id: "c1", code: "C-OB-0001", sku_id: "sku-bw20", sku: "BW20", qty: 7, bucket: "finished", state: "open", label_stock: "white" }]
      : [],
  } as unknown as WhLocationSummary;
});

vi.mock("@/lib/auth-context", () => ({ useAuth: () => ({ hasRole: () => true }) }));

vi.mock("@/lib/hooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/hooks")>();
  const idle = { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false };
  return {
    ...actual,
    useWhLayout: () => ({ data: layout, isLoading: false, error: null }),
    useWhLocations: () => ({ data: locations, isLoading: false, error: null }),
    useWhLocationExtras: () => ({ data: new Map() }),
    useWhContainers: () => ({ data: [] }),
    useWhSkuIndex: () => ({ data: [{ id: "sku-bw20", sku: "BW20", product_name: "Bong", monthly_demand: 30 }] }),
    useForecastDemandMap: () => new Map(),
    useWhLocation: () => ({
      data: {
        location: null,
        balances: [],
        containers: [{ id: "c1", code: "C-OB-0001", state: "open", label_stock: "white", qty: 7, sku: { sku: "BW20", product_name: "Bong" } }],
        movements: [],
      },
      isLoading: false,
    }),
    useWhCreateCount: () => idle,
    useWhFixtureBlocked: () => idle,
  };
});

const { StockMap } = await import("./StockMap");

function Url() {
  const loc = useLocation();
  return <output data-testid="url">{loc.search}</output>;
}

function renderAt(search: string) {
  return render(
    <MemoryRouter initialEntries={[`/inventory/stock${search}`]}>
      <StockMap />
      <Url />
    </MemoryRouter>,
  );
}

describe("StockMap", () => {
  it("opens the drawer from ?loc= and totals the search", () => {
    renderAt("?view=map&loc=02-01-2&q=BW20");
    expect(screen.getByText("Face 02 · Bay 01 · Level 2")).toBeTruthy();
    expect(screen.getByText("C-OB-0001")).toBeTruthy();
    expect(screen.getByText("1 bin · 7 units · 1 carton")).toBeTruthy();
  });

  it("keeps the mode in the URL and says when heat has nothing to paint", () => {
    renderAt("?view=map");
    fireEvent.click(screen.getByRole("radio", { name: "Heat" }));
    expect(screen.getByTestId("url").textContent).toContain("mode=heat");
  });

  it("shows the elevation for ?rack= and goes back to the plan", () => {
    renderAt("?view=map&rack=R02");
    expect(screen.getByText("Face 02")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Plan/ }));
    expect(screen.getByTestId("url").textContent).not.toContain("rack=");
  });

  it("Elevation opens the selected location's face, or the first face in walk order", () => {
    renderAt("?view=map&loc=02-01-2");
    fireEvent.click(screen.getByRole("radio", { name: "Elevation" }));
    expect(screen.getByTestId("url").textContent).toContain("face=02");
    fireEvent.click(screen.getByRole("radio", { name: "Plan" }));
    expect(screen.getByTestId("url").textContent).not.toContain("face=");
  });

  it("the drawer's Rack view switches to that face", () => {
    renderAt("?view=map&loc=02-01-2");
    fireEvent.click(screen.getByRole("button", { name: /Rack view/ }));
    expect(screen.getByTestId("url").textContent).toContain("face=02");
  });
});
