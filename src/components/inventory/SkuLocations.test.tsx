import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import type { WhSkuLocation } from "@/lib/hooks/use-warehouse-sku-locations";

// The drawer's Locations section with the data hook stubbed: rows per
// location, a row expands to its cartons (passport links) and loose units,
// plus the empty and loading states.

const mocks = vi.hoisted(() => ({
  result: { data: undefined as WhSkuLocation[] | undefined, isLoading: false, isError: false, error: null as unknown },
  hook: vi.fn(),
}));

vi.mock("@/lib/hooks/use-warehouse-sku-locations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/hooks/use-warehouse-sku-locations")>();
  return {
    ...actual,
    useWhSkuLocations: (skuId: string, enabled: boolean) => {
      mocks.hook(skuId, enabled);
      return mocks.result;
    },
  };
});

const { SkuLocations } = await import("./SkuLocations");

const THIS_YEAR = new Date().getFullYear();

const LOCATIONS: WhSkuLocation[] = [
  {
    location: { id: "l1", code: "02-01-1", kind: "bay_level", zone: "RAW", pickable: true, is_overflow: false, pick_sequence: 10 },
    units: 60,
    cartons: [
      {
        id: "c1",
        code: "C-466-007",
        state: "sealed",
        qty: 24,
        label_stock: "white",
        created_at: `${THIS_YEAR}-10-12T12:00:00Z`,
        bucket: "raw",
        buckets: ["raw"],
      },
      {
        id: "c2",
        code: "C-466-008R1",
        state: "open",
        qty: 24,
        label_stock: "green",
        created_at: `${THIS_YEAR}-10-14T12:00:00Z`,
        bucket: "finished",
        buckets: ["finished"],
      },
    ],
    loose: [{ bucket: "raw", units: 12 }],
  },
  {
    location: { id: "l2", code: "02-04-3", kind: "bay_level", zone: "RAW", pickable: false, is_overflow: true, pick_sequence: 40 },
    units: 400,
    cartons: [],
    loose: [{ bucket: "prefilled_raw", units: 400 }],
  },
  {
    location: { id: "l3", code: "MFG-LINE", kind: "virtual", zone: "MFG", pickable: false, is_overflow: false, pick_sequence: null },
    units: 23,
    cartons: [
      {
        id: "c3",
        code: "C-470-001",
        state: "open",
        qty: 23,
        label_stock: "white",
        created_at: `${THIS_YEAR}-10-20T12:00:00Z`,
        bucket: "raw",
        buckets: ["raw"],
      },
    ],
    loose: [],
  },
];

function Url() {
  return <output data-testid="url">{useLocation().pathname}</output>;
}

function renderSection(enabled = true) {
  return render(
    <MemoryRouter initialEntries={["/inventory/stock"]}>
      <Routes>
        <Route
          path="*"
          element={
            <>
              <SkuLocations skuId="sku-1" productSku="FP-RAW-1" enabled={enabled} />
              <Url />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mocks.hook.mockReset();
  mocks.result = { data: LOCATIONS, isLoading: false, isError: false, error: null };
});

describe("SkuLocations", () => {
  it("lists one row per location with the totals in the header", () => {
    renderSection();
    expect(mocks.hook).toHaveBeenCalledWith("sku-1", true);
    expect(screen.getByRole("heading", { name: "Locations" })).toBeInTheDocument();
    expect(screen.getByText("483 units in 3 locations")).toBeInTheDocument();

    const list = screen.getByRole("list", { name: "Locations of FP-RAW-1" });
    const rows = within(list).getAllByRole("button");
    expect(rows).toHaveLength(3);
    rows.forEach((r) => expect(r).toHaveAttribute("aria-expanded", "false"));

    expect(rows[0]).toHaveTextContent("02-01-1");
    expect(rows[0]).toHaveTextContent("60 units");
    expect(rows[0]).toHaveTextContent("2 cartons + loose");
    expect(rows[1]).toHaveTextContent("overflow");
    expect(rows[1]).toHaveTextContent("400 units");
    expect(rows[1]).not.toHaveTextContent("carton");
    expect(rows[2]).toHaveTextContent("At the line");
    expect(rows[2]).toHaveTextContent("1 carton");

    // Nothing expanded yet: no carton links.
    expect(screen.queryAllByRole("link")).toHaveLength(0);
  });

  it("expands a location to its LPNs, linked to the carton passport, and collapses again", () => {
    renderSection();
    const row = screen.getByRole("button", { name: /02-01-1/ });
    fireEvent.click(row);
    expect(row).toHaveAttribute("aria-expanded", "true");

    const panel = screen.getByRole("list", { name: "Cartons at 02-01-1" });
    expect(row).toHaveAttribute("aria-controls", panel.id);
    const links = within(panel).getAllByRole("link");
    expect(links.map((l) => l.getAttribute("href"))).toEqual([
      "/inventory/cartons/C-466-007",
      "/inventory/cartons/C-466-008R1",
    ]);

    const items = within(panel).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent("C-466-007");
    expect(items[0]).toHaveTextContent("sealed");
    expect(items[0]).toHaveTextContent("raw");
    expect(items[0]).toHaveTextContent("24");
    expect(items[0]).toHaveTextContent("Oct 12");
    // The green-label carton's chip says so to screen readers too.
    expect(within(items[1]).getByText("open")).toHaveClass("text-green-400");
    expect(items[1]).toHaveTextContent("(green label)");
    expect(items[1]).toHaveTextContent("finished");
    expect(items[2]).toHaveTextContent("Loose · 12 units · raw");

    // The other locations stay collapsed.
    expect(screen.queryByRole("list", { name: "Cartons at 02-04-3" })).not.toBeInTheDocument();

    fireEvent.click(row);
    expect(row).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("list", { name: "Cartons at 02-01-1" })).not.toBeInTheDocument();
  });

  it("opens the carton passport from an LPN without toggling the row", () => {
    renderSection();
    const row = screen.getByRole("button", { name: /02-01-1/ });
    fireEvent.click(row);
    fireEvent.click(screen.getByRole("link", { name: "C-466-007" }));
    expect(screen.getByTestId("url").textContent).toBe("/inventory/cartons/C-466-007");
  });

  it("is a native button per row, so the keyboard can reach and toggle it", () => {
    renderSection();
    const row = screen.getByRole("button", { name: /02-04-3/ });
    expect(row.tagName).toBe("BUTTON");
    expect(row).toHaveAttribute("type", "button");
    row.focus();
    expect(row).toHaveFocus();
    fireEvent.click(row);
    expect(screen.getByRole("list", { name: "Cartons at 02-04-3" })).toHaveTextContent("Loose · 400 units · pre-filled");
  });

  it("says so when the SKU is in no location", () => {
    mocks.result = { data: [], isLoading: false, isError: false, error: null };
    renderSection();
    expect(screen.getByText("Not in any warehouse location yet")).toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
    expect(screen.queryByText(/units in/)).not.toBeInTheDocument();
  });

  it("shows a skeleton while loading", () => {
    mocks.result = { data: undefined, isLoading: true, isError: false, error: null };
    renderSection();
    expect(screen.getByRole("status", { name: "Loading locations" })).toBeInTheDocument();
    expect(screen.queryByText("Not in any warehouse location yet")).not.toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });

  it("shows the error instead of an empty list when the read fails", () => {
    mocks.result = { data: undefined, isLoading: false, isError: true, error: { message: "JWT expired" } };
    renderSection();
    expect(screen.getByText("Couldn't load locations: JWT expired")).toBeInTheDocument();
    expect(screen.queryByText("Not in any warehouse location yet")).not.toBeInTheDocument();
  });

  it("passes enabled through so a closed drawer fetches nothing", () => {
    renderSection(false);
    expect(mocks.hook).toHaveBeenCalledWith("sku-1", false);
  });
});
