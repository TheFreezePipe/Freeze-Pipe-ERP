import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { CartonLink } from "./CartonLink";

function Url() {
  const loc = useLocation();
  return <output data-testid="url">{loc.pathname}</output>;
}

function renderLink(ui: ReactElement) {
  return render(
    <MemoryRouter initialEntries={["/inventory/stock"]}>
      <Routes>
        <Route path="*" element={<>{ui}<Url /></>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("CartonLink", () => {
  it("renders the code as a link to the carton passport", () => {
    renderLink(<CartonLink code="C-466-007R1" />);
    const link = screen.getByRole("link", { name: "C-466-007R1" });
    expect(link.getAttribute("href")).toBe("/inventory/cartons/C-466-007R1");
    expect(link.className).toContain("font-mono");
  });

  it("encodes characters that would break the route", () => {
    renderLink(<CartonLink code="C-1/2#A" />);
    expect(screen.getByRole("link").getAttribute("href")).toBe("/inventory/cartons/C-1%2F2%23A");
  });

  it("takes custom text and a class", () => {
    renderLink(
      <CartonLink code="C-466-007" className="text-lg">
        carton 7
      </CartonLink>,
    );
    const link = screen.getByRole("link", { name: "carton 7" });
    expect(link.getAttribute("href")).toBe("/inventory/cartons/C-466-007");
    expect(link.className).toContain("text-lg");
  });

  it("opens in a new tab when asked", () => {
    renderLink(<CartonLink code="C-466-007" newTab />);
    const link = screen.getByRole("link");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
  });

  it("navigates without firing the click handler of the row it sits in", () => {
    const onRow = vi.fn();
    renderLink(
      <table>
        <tbody>
          <tr onClick={onRow}>
            <td>
              <CartonLink code="C-466-008" />
            </td>
            <td>05-02-1</td>
          </tr>
        </tbody>
      </table>,
    );
    fireEvent.click(screen.getByRole("link", { name: "C-466-008" }));
    expect(onRow).not.toHaveBeenCalled();
    expect(screen.getByTestId("url").textContent).toBe("/inventory/cartons/C-466-008");

    fireEvent.click(screen.getByText("05-02-1"));
    expect(onRow).toHaveBeenCalledTimes(1);
  });
});
