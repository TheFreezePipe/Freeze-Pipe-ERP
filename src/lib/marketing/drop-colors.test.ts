import { describe, it, expect } from "vitest";
import { DROP_PALETTE, dropColorFor, dropColorMap, dropTagColor } from "./drop-colors";

describe("drop colors", () => {
  it("the two live drops hash to the same slot — the map keeps them apart", () => {
    expect(dropTagColor("Q4 Studio")).toBe(dropTagColor("Alien Studio"));
    const m = dropColorMap([
      { tag: "Q4 Studio", since: "2026-08-19" },
      { tag: "Alien Studio", since: "2026-08-25" },
    ]);
    expect(m.get("Q4 Studio")).toBe(dropTagColor("Q4 Studio")); // older keeps its color
    expect(m.get("Alien Studio")).not.toBe(m.get("Q4 Studio"));
  });

  it("adding a drop never recolors older ones", () => {
    const before = dropColorMap([
      { tag: "Q4 Studio", since: "2026-08-19" },
      { tag: "Alien Studio", since: "2026-08-25" },
    ]);
    const after = dropColorMap([
      { tag: "Q4 Studio", since: "2026-08-19" },
      { tag: "Alien Studio", since: "2026-08-25" },
      { tag: "Spring Drop", since: "2026-09-01" },
    ]);
    expect(after.get("Q4 Studio")).toBe(before.get("Q4 Studio"));
    expect(after.get("Alien Studio")).toBe(before.get("Alien Studio"));
    expect(new Set(after.values()).size).toBe(3);
  });

  it("six drops get six distinct colors; the fallback still answers for unknown tags", () => {
    const six = ["A", "B", "C", "D", "E", "F"].map((t, i) => ({ tag: t, since: `2026-01-0${i + 1}` }));
    expect(new Set(dropColorMap(six).values()).size).toBe(DROP_PALETTE.length);
    expect(dropColorFor(undefined, "Q4 Studio")).toBe(dropTagColor("Q4 Studio"));
  });
});
