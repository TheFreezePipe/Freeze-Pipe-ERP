import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import staging from "@/lib/warehouse/__fixtures__/staging-layout.json";
import type { WhLayout, WhLocationSummary } from "@/lib/hooks";
import { FloorPlan } from "./FloorPlan";
import { RackElevation } from "./RackElevation";

// Smoke tests over the real staging layout: the plan and the elevation
// render every bay and route a tap or Enter to the right location code.

const layout = staging as unknown as WhLayout;

function summary(): WhLocationSummary[] {
  return (staging.locations as Record<string, unknown>[]).map((l) => {
    const code = l.code as string;
    const stocked = code === "02-01-2" || code === "02-01-3";
    return {
      ...l,
      site_location_id: null,
      rack_code: (staging.racks as { id: string; code: string }[]).find((r) => r.id === l.rack_id)?.code ?? null,
      walk_pass: null,
      walk_dir: null,
      allow_negative: false,
      default_bucket: null,
      bucket_lock: null,
      last_counted_at: null,
      label_printed_at: null,
      label_verified_at: null,
      cartons: stocked ? 2 : 0,
      units: stocked ? 24 : 0,
      units_raw: 0,
      units_prefilled_raw: 0,
      units_in_production: 0,
      units_finished: stocked ? 24 : 0,
      units_other: 0,
      sku_count: stocked ? 1 : 0,
      last_movement_at: null,
      contents: stocked
        ? [
            { container_id: `c-${code}-1`, code: `C-OB-${code}-1`, sku_id: "sku-bw20", sku: "BW20", qty: 12, bucket: "finished", state: "sealed", label_stock: "white" },
            { container_id: `c-${code}-2`, code: `C-OB-${code}-2`, sku_id: "sku-bw20", sku: "BW20", qty: 12, bucket: "finished", state: "open", label_stock: "white" },
          ]
        : [],
    } as unknown as WhLocationSummary;
  });
}

describe("FloorPlan", () => {
  it("draws one cell per bay and opens the first stocked level of a tapped bay", () => {
    const onSelect = vi.fn();
    render(<FloorPlan layout={layout} locations={summary()} onSelectLocation={onSelect} />);
    const cells = screen.getAllByRole("button", { name: /^Bay / });
    expect(cells).toHaveLength(28);
    fireEvent.keyDown(screen.getByRole("button", { name: "Bay 02-01, RTS" }), { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("02-01-2");
  });

  it("opens the chosen level, and named locations by their code", () => {
    const onSelect = vi.fn();
    render(<FloorPlan layout={layout} locations={summary()} level="3" mode="stock" onSelectLocation={onSelect} />);
    fireEvent.keyDown(screen.getByRole("button", { name: "Bay 02-01, RTS" }), { key: "Enter" });
    expect(onSelect).toHaveBeenLastCalledWith("02-01-3");
    fireEvent.keyDown(screen.getByRole("button", { name: /^IN-01/ }), { key: " " });
    expect(onSelect).toHaveBeenLastCalledWith("IN-01");
  });

  it("renders every mode and the walk path without throwing", () => {
    for (const mode of ["browse", "stock", "counted", "heat"] as const) {
      const { unmount } = render(
        <FloorPlan
          layout={layout}
          locations={summary()}
          mode={mode}
          showWalk
          heat={{ byLocation: new Map(), max: 0, stockedBins: 0 }}
          highlightIds={new Set(["x"])}
        />,
      );
      unmount();
    }
  });
});

describe("RackElevation", () => {
  it("shows a face as levels by bays and opens a cell", () => {
    const onSelect = vi.fn();
    render(
      <RackElevation
        layout={layout}
        locations={summary()}
        face="02"
        onSelectLocation={onSelect}
        onFaceChange={() => {}}
        onBack={() => {}}
      />,
    );
    expect(screen.getByText("Face 02")).toBeTruthy();
    // 3 bays × 3 levels
    expect(screen.getAllByRole("gridcell")).toHaveLength(9);
    fireEvent.click(screen.getByText("02-01-3"));
    expect(onSelect).toHaveBeenCalledWith("02-01-3");
    expect(screen.getAllByText("BW20").length).toBeGreaterThan(0);
  });
});
