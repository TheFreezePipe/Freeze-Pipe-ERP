import { describe, expect, it } from "vitest";
import { withArrivedDropCards } from "./launch-format";
import type { AddProductGroup, BoardCardLike } from "./launch-members";

describe("withArrivedDropCards", () => {
  const card = (id: string, name: string, extra: Partial<BoardCardLike> = {}): BoardCardLike => ({ id, name, stage: "ordered", drop_tag: "Northern Lights", ...extra });
  const arrived = (id: string, name: string, extra: Partial<BoardCardLike> = {}) =>
    card(id, name, { archived_at: "2026-09-22T00:00:00Z", archive_reason: "arrived", ...extra });
  const groups: AddProductGroup<BoardCardLike>[] = [
    { tag: "Northern Lights", suggested: true, cards: [card("c1", "BW20DNA")] },
    { tag: "Alien Studio", suggested: false, cards: [card("c9", "Alien Recycler", { drop_tag: "Alien Studio" })] },
  ];

  it("adds the drop's arrived cards to the suggested group, sorted by name", () => {
    const out = withArrivedDropCards(groups, [arrived("c2", "NB6"), arrived("c3", "NB2")], "L1");
    expect(out[0].cards.map((c) => c.name)).toEqual(["BW20DNA", "NB2", "NB6"]);
    expect(out[1]).toBe(groups[1]);
  });

  it("leaves out cards already on this launch, non-arrived archived cards and duplicates", () => {
    const out = withArrivedDropCards(
      groups,
      [
        arrived("c2", "NB6", { linked_launch_id: "L1" }),
        card("c4", "Shelved", { archived_at: "2026-01-01T00:00:00Z", archive_reason: "shelved" }),
        arrived("c1", "BW20DNA"),
      ],
      "L1",
    );
    expect(out[0].cards.map((c) => c.id)).toEqual(["c1"]);
  });

  it("returns a copy of the groups when nothing is added", () => {
    const out = withArrivedDropCards(groups, [], "L1");
    expect(out).toEqual(groups);
    expect(out).not.toBe(groups);
  });
});
