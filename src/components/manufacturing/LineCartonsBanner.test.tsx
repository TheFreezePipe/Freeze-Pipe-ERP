import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

// The Workspace banner with its hook stubbed: each carton code is a passport
// link, and the rest of a waiting row still opens its putaway.

vi.mock("@/lib/hooks/use-warehouse-mfg", () => ({
  useWhLineCartons: () => ({
    data: {
      waiting: [
        {
          id: "c-1",
          code: "C-466-007R1",
          qty: 12,
          sku: { sku: "BW20DNA" },
          finished_by: "me",
          putaway: { suggested_code: "02-01-2", created_by: "me" },
        },
      ],
      raw: [{ id: "c-2", code: "C-466-004", qty: 4, state: "open", sku: { sku: "BW20DNA" } }],
    },
  }),
}));

const { LineCartonsBanner } = await import("./LineCartonsBanner");

function Url() {
  const loc = useLocation();
  return <output data-testid="url">{`${loc.pathname}${loc.search}`}</output>;
}

function renderBanner() {
  return render(
    <MemoryRouter initialEntries={["/manufacturing/workspace"]}>
      <Routes>
        <Route
          path="*"
          element={
            <>
              <LineCartonsBanner me="me" />
              <Url />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe("LineCartonsBanner", () => {
  it("links a waiting carton's code to its passport and the row to its putaway", () => {
    renderBanner();
    expect(screen.getByRole("link", { name: "C-466-007R1" }).getAttribute("href")).toBe("/inventory/cartons/C-466-007R1");
    expect(screen.getByRole("link", { name: "Put away C-466-007R1" }).getAttribute("href")).toBe("/go/putaway?lpn=C-466-007R1");
    fireEvent.click(screen.getByRole("link", { name: "C-466-007R1" }));
    expect(screen.getByTestId("url").textContent).toBe("/inventory/cartons/C-466-007R1");
  });

  it("links the raw cartons at the line", () => {
    renderBanner();
    fireEvent.click(screen.getByRole("button", { name: /1 raw carton at the line/ }));
    expect(screen.getByRole("link", { name: "C-466-004" }).getAttribute("href")).toBe("/inventory/cartons/C-466-004");
  });
});
