import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { WhCartonPassport } from "@/lib/hooks/use-warehouse";

// The passport page with its hook stubbed: header chips and links, the legs
// strip, the timeline in server order, the batch's sibling links, the
// counts card, label printing and the not-found state.

const usePassport = vi.fn();
vi.mock("@/lib/hooks/use-warehouse-passport", () => ({
  useWhCartonPassport: (code: string) => usePassport(code),
}));

vi.mock("@/components/warehouse/LabelSheet", () => ({
  default: (props: { kind: string; ids: string[]; title?: string }) => (
    <div data-testid="label-sheet">
      {props.kind} {props.ids.join(",")} {props.title}
    </div>
  ),
}));

const { default: CartonPassport } = await import("./CartonPassport");

const passport = {
  carton: {
    id: "ctr-7r1",
    code: "C-466-007R1",
    sku_id: "sku-bw20",
    sku: "BW20DNA",
    product_name: "Freeze Pipe DNA",
    state: "sealed",
    qty: 12,
    qty_initial: 12,
    bucket: "finished",
    label_stock: "green",
    location_id: "loc-02012",
    location_code: "02-01-2",
    created_at: "2026-10-28T19:35:00Z",
    opened_at: null,
    finished_at: "2026-10-28T19:35:00Z",
    finished_by_name: "Maria",
    parent: { id: "ctr-7", code: "C-466-007", state: "void" },
    children: [],
    superseded_by: null,
    carton_seq: 7,
    carton_of: 31,
  },
  batch: {
    factory_order: {
      id: "fo-118",
      order_number: "FO-2026-118",
      supplier_name: "Nancy",
      order_date: "2026-07-28",
      expected_completion: "2026-08-29",
      status: "shipped",
    },
    item: { quantity_ordered: 2400, quantity_finished: 2400, consolidator_confirmed_quantity: 2400, quantity_breakage: 7 },
    shipment: {
      id: "sh-466",
      shipment_number: "Sea 466",
      ship_date: "2026-09-06",
      eta: "2026-10-09",
      actual_arrival_date: "2026-10-18",
      status: "delivered",
    },
    summary: { cartons_received: 198, cartons_short: 2, finished: 171, raw_on_shelf: 24, at_the_line: 3, broken_units: 7 },
    siblings: [
      { id: "ctr-4", code: "C-466-004", state: "open", qty: 4, location_code: "MFG-LINE", since: "2026-10-28T15:00:00Z" },
      { id: "ctr-8", code: "C-466-008", state: "sealed", qty: 12, location_code: "05-02-1", since: "2026-10-20T12:40:00Z" },
    ],
    siblings_total: 197,
  },
  timeline: [
    { at: "2026-07-28T00:00:00+00:00", kind: "ordered", title: "Factory order FO-2026-118 placed", detail: "BW20DNA 2,400 units", actor_name: "Nancy" },
    { at: "2026-09-06T00:00:00+00:00", kind: "shipped", title: "Shipped · Sea 466", detail: null, actor_name: null },
    { at: "2026-10-20T12:05:00Z", kind: "checked_in", title: "Checked in", detail: "carton 7 of 31 · 12 raw", actor_name: "Devon" },
    { at: "2026-10-20T12:40:00Z", kind: "putaway", title: "Put away · 05-02-1", detail: null, actor_name: "Devon" },
    { at: "2026-10-27T14:12:00Z", kind: "pulled", title: "Pulled to the line", detail: null, actor_name: "Maria" },
    { at: "2026-10-28T19:35:00Z", kind: "relabel", title: "Relabelled from · C-466-007", detail: null, actor_name: "Maria" },
    { at: "2026-10-28T19:36:00Z", kind: "labels", title: "Labels printed · lpn_rts", detail: null, actor_name: null },
    { at: "2026-10-28T19:41:00Z", kind: "moved", title: "Moved · 02-01-2", detail: null, actor_name: "Maria" },
  ],
  legs: {
    order_to_finished_days: 32,
    finished_to_shipped_days: 8,
    water_days: 31,
    arrival_to_checkin_days: null,
    checkin_to_shelf_minutes: 35,
    shelf_to_line_days: 7,
    line_to_rts_days: 1.24,
  },
} as unknown as WhCartonPassport;

function found() {
  return { data: { found: true, passport }, isLoading: false, error: null, refetch: vi.fn(), isFetching: false };
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/inventory/cartons/:code" element={<CartonPassport />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  usePassport.mockReset();
  usePassport.mockReturnValue(found());
});

describe("CartonPassport", () => {
  it("reads the code from the URL, decoded", () => {
    usePassport.mockReturnValue({ data: undefined, isLoading: true, error: null, refetch: vi.fn(), isFetching: true });
    renderAt("/inventory/cartons/C-1%2F2");
    expect(usePassport).toHaveBeenCalledWith("C-1/2");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("C-1/2");
  });

  it("renders the header: code, state, label stock, batch and shipment links, actions", () => {
    renderAt("/inventory/cartons/C-466-007R1");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("C-466-007R1");
    expect(screen.getByText("RTS · green label")).toBeTruthy();
    const batchLinks = screen.getAllByRole("link", { name: /FO-2026-118/ });
    expect(batchLinks.length).toBeGreaterThan(0);
    for (const a of batchLinks) expect(a.getAttribute("href")).toBe("/inventory/factory-orders/fo-118");
    const shipmentLinks = screen.getAllByRole("link", { name: /Sea 466/ });
    for (const a of shipmentLinks) expect(a.getAttribute("href")).toBe("/inventory/shipments/sh-466");
    expect(screen.getByRole("link", { name: /Move/ }).getAttribute("href")).toBe("/go/move");
    expect(screen.getByRole("link", { name: /Count now/ }).getAttribute("href")).toBe("/go/count");
    expect(screen.getByRole("link", { name: "Open batch" }).getAttribute("href")).toBe("/inventory/factory-orders/fo-118");
    // The summary: SKU, units and the parent as a passport link.
    expect(screen.getAllByText("BW20DNA").length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: "C-466-007" }).getAttribute("href")).toBe("/inventory/cartons/C-466-007");
  });

  it("shows only the legs that have both ends, the dock leg in minutes", () => {
    renderAt("/inventory/cartons/C-466-007R1");
    const strip = screen.getByLabelText("Time per leg");
    expect(within(strip).getByText("Order → finished")).toBeTruthy();
    expect(within(strip).getByText("32 d")).toBeTruthy();
    expect(within(strip).getByText("35 min")).toBeTruthy();
    expect(within(strip).getByText("1.2 d")).toBeTruthy();
    expect(within(strip).queryByText("Arrival → check-in")).toBeNull();
  });

  it("lists the timeline in the server's order, oldest first", () => {
    renderAt("/inventory/cartons/C-466-007R1");
    const items = within(screen.getByRole("list", { name: "Timeline" })).getAllByRole("listitem");
    expect(items.map((li) => li.getAttribute("data-kind"))).toEqual([
      "ordered",
      "shipped",
      "checked_in",
      "putaway",
      "pulled",
      "relabel",
      "labels",
      "moved",
    ]);
    expect(items[0].textContent).toContain("Factory order FO-2026-118 placed");
    // A date-only step shows its calendar day whatever the browser's time zone.
    expect(items[0].textContent).toContain("Jul 28");
    expect(items[2].textContent).toContain("Devon");
  });

  it("links every sibling carton and says how many more there are", () => {
    renderAt("/inventory/cartons/C-466-007R1");
    expect(screen.getByRole("link", { name: "C-466-004" }).getAttribute("href")).toBe("/inventory/cartons/C-466-004");
    expect(screen.getByRole("link", { name: "C-466-008" }).getAttribute("href")).toBe("/inventory/cartons/C-466-008");
    expect(screen.getByText(/195 more cartons in this batch/)).toBeTruthy();
    expect(screen.getByText("171 finished")).toBeTruthy();
    expect(screen.getByText(/7 broken units/)).toBeTruthy();
  });

  it("puts check-ins, counts and label prints in Counts and checks", () => {
    renderAt("/inventory/cartons/C-466-007R1");
    const checks = within(screen.getByRole("list", { name: "Counts and checks" })).getAllByRole("listitem");
    expect(checks).toHaveLength(2);
    expect(checks[0].textContent).toContain("Checked in");
    expect(checks[1].textContent).toContain("Labels printed");
  });

  it("prints the green label pair for an RTS carton", async () => {
    renderAt("/inventory/cartons/C-466-007R1");
    fireEvent.click(screen.getByRole("button", { name: /Print label pair/ }));
    expect((await screen.findByTestId("label-sheet")).textContent).toContain("lpn_rts ctr-7r1");
  });

  it("says when no carton has the code, with a way back to Stock", () => {
    usePassport.mockReturnValue({ data: { found: false, code: "C-NOPE" }, isLoading: false, error: null, refetch: vi.fn(), isFetching: false });
    renderAt("/inventory/cartons/C-NOPE");
    expect(screen.getByText(/No carton/).textContent).toContain("C-NOPE");
    expect(screen.getByRole("link", { name: "Back to Stock" }).getAttribute("href")).toBe("/inventory/stock");
  });

  it("shows a load error with a retry", () => {
    const refetch = vi.fn();
    usePassport.mockReturnValue({ data: undefined, isLoading: false, error: new Error("permission denied"), refetch, isFetching: false });
    renderAt("/inventory/cartons/C-466-007R1");
    expect(screen.getByText("permission denied")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Try again/ }));
    expect(refetch).toHaveBeenCalled();
  });
});
