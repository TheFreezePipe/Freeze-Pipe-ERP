import { describe, expect, it } from "vitest";
import { eventText } from "./pd-activity";

const names = new Map([["l-nl", "Northern Lights Studio drop"], ["l-old", "Heady drop 006"]]);

const ev = (over: { outcome: string; from_stage?: string | null; to_stage?: string | null; reason?: string | null; meta?: unknown }) => ({
  from_stage: null,
  to_stage: null,
  reason: null,
  meta: null,
  ...over,
});

describe("eventText", () => {
  it("launch link events read in plain words with the launch's name", () => {
    expect(
      eventText(
        ev({ outcome: "launch_moved", meta: { via: "attach", launch_id: "l-nl", old_date: "2026-11-05", new_date: "2026-11-16" } }),
        names,
      ),
    ).toBe("Added to Northern Lights Studio drop · Nov 5 → Nov 16");
    expect(
      eventText(
        ev({ outcome: "launch_moved", meta: { via: "attach", launch_id: "l-nl", from_launch_id: "l-old", old_date: "2026-11-16", new_date: "2026-11-16" } }),
        names,
      ),
    ).toBe("Moved to Northern Lights Studio drop from Heady drop 006");
    expect(eventText(ev({ outcome: "launch_moved", meta: { via: "halt", launch_id: "l-nl" } }), names)).toBe(
      "Removed from Northern Lights Studio drop",
    );
  });
  it("restore / link_sku / arrived archive never show a raw enum", () => {
    expect(eventText(ev({ outcome: "restore", to_stage: "ordered", reason: "Samples only" }), names)).toBe("Restored to Ordered · Samples only");
    expect(eventText(ev({ outcome: "link_sku", meta: { sku: "S04-NB2" } }), names)).toBe("Linked to SKU S04-NB2");
    expect(eventText(ev({ outcome: "archive", reason: "arrived", meta: { manual: true, note: "Counted in" } }), names)).toBe(
      "Marked arrived · Counted in",
    );
    expect(eventText(ev({ outcome: "archive", reason: "arrived" }), names)).toBe("Arrived");
  });
  it("the board's own moves keep the sheet's wording; an unknown outcome is humanized", () => {
    expect(eventText(ev({ outcome: "advance", from_stage: "china_working", to_stage: "prototype_sent" }), names)).toBe(
      "advanced China Working → Prototype Sent",
    );
    expect(eventText(ev({ outcome: "archive", reason: "shelved" }), names)).toBe("archived · shelved");
    expect(eventText(ev({ outcome: "some_new_thing" }), names)).toBe("Some new thing");
  });
});
