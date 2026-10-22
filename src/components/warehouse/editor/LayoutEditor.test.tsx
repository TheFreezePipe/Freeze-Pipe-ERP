import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import staging from "@/lib/warehouse/__fixtures__/staging-layout.json";
import type { WhLayout } from "@/lib/hooks";

// The editor against the staging layout with the hooks stubbed: palette →
// draft → one save_layout payload; undo; the generator preview.

const stamp = <T extends object>(rows: T[]) => rows.map((r) => ({ created_at: "", updated_at: "", row_version: 1, ...r }));
const layout = {
  templates: stamp(staging.templates),
  racks: stamp(staging.racks).map((r) => ({ ...r, site_location_id: "site" })),
  faces: stamp(staging.faces),
  fixtures: stamp(staging.fixtures),
} as unknown as WhLayout;

const saveLayout = vi.fn();
const generate = vi.fn();

vi.mock("@/lib/hooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/hooks")>();
  return {
    ...actual,
    useWhLayout: () => ({ data: layout, isLoading: false, error: null, refetch: async () => ({ data: layout }) }),
    useWhLocations: () => ({ data: [] }),
    useWhSaveLayoutChecked: () => ({ mutateAsync: saveLayout, isPending: false }),
    useWhSaveLocation: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useWhGenerateLocations: () => ({ mutate: generate, isPending: false }),
    useWhResequence: () => ({ mutate: vi.fn(), isPending: false }),
  };
});

const { LayoutEditor } = await import("./LayoutEditor");

describe("LayoutEditor", () => {
  beforeEach(() => {
    saveLayout.mockReset();
    generate.mockReset();
  });

  it("adds a fixture from the palette, undoes it, and saves one payload", async () => {
    saveLayout.mockResolvedValue({ ok: true, fixtures: { created: 1, updated: 0, deleted: 0 } });
    render(<LayoutEditor onClose={() => {}} />);
    expect(screen.getByText("Saved")).toBeTruthy();
    expect(screen.getByText(/PR-3L/)).toBeTruthy();

    fireEvent.click(screen.getByTitle("Drag a desk onto the plan"));
    expect(screen.getByText("Unsaved · 1 change")).toBeTruthy();
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Desk");

    fireEvent.click(screen.getByTitle("Undo (Ctrl+Z)"));
    expect(screen.getByText("Saved")).toBeTruthy();

    fireEvent.click(screen.getByTitle("Drag a desk onto the plan"));
    fireEvent.click(screen.getByTitle("Save layout (Ctrl+S)"));
    await waitFor(() => expect(saveLayout).toHaveBeenCalledTimes(1));
    const payload = saveLayout.mock.calls[0][0] as { racks: unknown[]; faces: unknown[]; fixtures: Record<string, unknown>[] };
    expect(payload.racks).toEqual([]);
    expect(payload.faces).toEqual([]);
    expect(payload.fixtures).toHaveLength(1);
    expect(payload.fixtures[0]).toMatchObject({ name: "Desk", kind: "desk", width_mm: 1500, depth_mm: 750 });
    expect(payload.fixtures[0]).not.toHaveProperty("id");
  });

  it("a new rack from a template brings a face and its codes", () => {
    render(<LayoutEditor onClose={() => {}} />);
    fireEvent.click(screen.getByTitle("Drag Shelving, 1 level onto the plan"));
    expect(screen.getByText("Unsaved · 2 changes")).toBeTruthy();
    expect((screen.getByLabelText("Code", { selector: "input.uppercase" }) as HTMLInputElement).value).toBe("R10");
    expect(screen.getByText("10-01-1")).toBeTruthy();
    expect(screen.getByText("10-02-1")).toBeTruthy();
  });

  it("previews the generator only when the layout is saved", () => {
    render(<LayoutEditor onClose={() => {}} />);
    const preview = screen.getAllByText("Preview locations")[0].closest("button") as HTMLButtonElement;
    expect(preview.disabled).toBe(false);
    fireEvent.click(preview);
    expect(generate).toHaveBeenCalledWith({ dryRun: true }, expect.anything());
    fireEvent.click(screen.getByTitle("Drag a desk onto the plan"));
    expect((screen.getAllByText("Preview locations")[0].closest("button") as HTMLButtonElement).disabled).toBe(true);
  });

  it("verify walk lists the faces by pass", () => {
    render(<LayoutEditor onClose={() => {}} />);
    fireEvent.click(screen.getByText("Verify walk"));
    expect(screen.getByText("Faces by walk pass")).toBeTruthy();
  });
});
