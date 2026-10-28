import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Json } from "@/lib/database.types";
import { barcodeSvg } from "@/lib/warehouse/labels";

// LabelSheet on the browser path for an existing job (no request is queued),
// with the job hooks stubbed. The print document goes into a hidden iframe;
// the test catches that iframe before it reaches the page and reads its srcdoc.

vi.mock("@/lib/hooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/hooks")>();
  const idle = { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false };
  return { ...actual, useWhMarkPrinted: () => idle, useWhRequestLabels: () => idle };
});

const { default: LabelSheet } = await import("./LabelSheet");

function carton(n: number) {
  return {
    id: `c${n}`,
    code: `C-466-00${n}`,
    barcode: `%C-466-00${n}`,
    sku: "BW20",
    product_name: "Beaker 20",
    qty: 12,
    bucket: "finished",
    shipment: "466",
    carton_seq: n,
    carton_of: 40,
    date: "2026-10-28",
  };
}

const ids = ["c1", "c2", "c3"];

function renderSheet(payload: Record<string, unknown>) {
  return render(
    <LabelSheet
      open
      onOpenChange={() => {}}
      kind="lpn"
      ids={ids}
      title="3 carton labels"
      existingJob={{ id: "job-1", payload: payload as Json, kind: "lpn", itemIds: ids, cancelOnClose: false }}
    />,
  );
}

/** Click Print and return the document handed to the print iframe. */
async function printedDocument(): Promise<Document> {
  const append = document.body.appendChild.bind(document.body);
  let html: string | null = null;
  vi.spyOn(document.body, "appendChild").mockImplementation(((node: Node) => {
    if (node instanceof HTMLIFrameElement) {
      html = node.srcdoc;
      return node;
    }
    return append(node);
  }) as typeof document.body.appendChild);
  fireEvent.click(screen.getByRole("button", { name: "Print" }));
  await waitFor(() => expect(html).not.toBeNull());
  return new DOMParser().parseFromString(html ?? "", "text/html");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("LabelSheet, 4×6 carton pair", () => {
  const pair = { kind: "lpn", practice: false, size: "4x6", copies: 2, labels: [carton(1), carton(2), carton(3)] };

  it("counts labels in the title and copies in the description", () => {
    renderSheet(pair);
    expect(screen.getByRole("heading")).toHaveTextContent("Print 3 carton labels · 2 each");
    expect(screen.getByText(/3 × 4×6 in · 2 copies of each, 6 pages/)).toBeInTheDocument();
  });

  it("previews each label once, landscape, with the 5-dot barcode and its value", () => {
    const { baseElement } = renderSheet(pair);
    const labels = baseElement.querySelectorAll(".whl-preview .whl-label");
    expect(labels).toHaveLength(3);
    for (const l of labels) expect(l.classList.contains("whl-4x6")).toBe(true);
    const css = baseElement.querySelector(".whl-preview style")?.textContent ?? "";
    expect(css).toContain("width:6in;height:4in");
    const bar = labels[0].querySelector<HTMLElement>(".whl-bar");
    expect(bar?.style.width).toBe(`${barcodeSvg("%C-466-001", 5).widthMm}mm`);
    expect(labels[0].querySelector(".whl-human")?.textContent).toBe("%C-466-001");
  });

  it("prints each copy on its own 4×6 portrait page, the landscape box turned 90°", async () => {
    renderSheet(pair);
    const doc = await printedDocument();
    const css = doc.querySelector("style")?.textContent ?? "";
    expect(css).toContain("@page{size:4in 6in;margin:0;}");
    expect(css).toContain(".whl-page{position:relative;width:4in;height:6in;overflow:hidden;");
    expect(css).toContain(".whl-page>.whl-label{position:absolute;top:0;left:0;transform-origin:2in 2in;transform:rotate(90deg);}");
    const pages = [...doc.querySelectorAll(".whl-page")];
    expect(pages).toHaveLength(6);
    expect(pages.map((p) => p.querySelectorAll(".whl-label.whl-4x6").length)).toEqual([1, 1, 1, 1, 1, 1]);
    expect(pages.map((p) => p.querySelector(".whl-code")?.textContent)).toEqual([
      "C-466-001",
      "C-466-001",
      "C-466-002",
      "C-466-002",
      "C-466-003",
      "C-466-003",
    ]);
  });

  it("sets an RTS code smaller so it clears the badge", () => {
    const { baseElement, unmount } = renderSheet(pair);
    expect(baseElement.querySelector<HTMLElement>(".whl-preview .whl-code")?.style.fontSize).toBe("49pt");
    unmount();
    const rts = { ...carton(1), code: "C-466-001R1", barcode: "%C-466-001R1", label_stock: "green" };
    const { baseElement: el } = renderSheet({ kind: "lpn_rts", practice: false, size: "4x6", copies: 2, labels: [rts] });
    expect(el.querySelector(".whl-preview .whl-rts")?.textContent).toBe("RTS");
    expect(el.querySelector<HTMLElement>(".whl-preview .whl-code")?.style.fontSize).toBe("39pt");
  });

  it("a Reprint one job (copies 1) prints one page per label", async () => {
    renderSheet({ ...pair, copies: 1 });
    expect(screen.getByRole("heading")).toHaveTextContent(/^Print 3 carton labels$/);
    const doc = await printedDocument();
    expect(doc.querySelectorAll(".whl-page")).toHaveLength(3);
  });
});

describe("LabelSheet, 4×2 carton labels", () => {
  it("prints one 4×2 page per label, unrotated, as before", async () => {
    renderSheet({ kind: "lpn", practice: false, size: "4x2", labels: [carton(1), carton(2), carton(3)] });
    expect(screen.getByRole("heading")).toHaveTextContent(/^Print 3 carton labels$/);
    const doc = await printedDocument();
    const css = doc.querySelector("style")?.textContent ?? "";
    expect(css).toContain("@page{size:4in 2in;margin:0;}");
    expect(css).not.toContain("rotate(");
    expect(doc.querySelectorAll(".whl-page")).toHaveLength(0);
    expect(doc.querySelectorAll("body > .whl-label.whl-4x2")).toHaveLength(3);
    expect(doc.querySelector(".whl-human")).toBeNull();
  });
});
