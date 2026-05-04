import { describe, it, expect } from "vitest";
import { updateWithVersion, ConcurrencyConflictError } from "./concurrency";

describe("updateWithVersion", () => {
  it("applies changes and bumps row_version when expected matches", () => {
    const row = { id: "r1", row_version: 3, name: "old" };
    const result = updateWithVersion(row, 3, { name: "new" }, { table: "test" });
    expect(result.name).toBe("new");
    expect(result.row_version).toBe(4);
  });

  it("throws ConcurrencyConflictError when versions differ", () => {
    const row = { id: "r1", row_version: 5, name: "old" };
    expect(() => updateWithVersion(row, 3, { name: "new" }, { table: "test" }))
      .toThrow(ConcurrencyConflictError);
  });

  it("error carries table, id, expected, and actual versions", () => {
    const row = { id: "r1", row_version: 5, name: "old" };
    try {
      updateWithVersion(row, 3, { name: "new" }, { table: "product_skus" });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConcurrencyConflictError);
      const e = err as ConcurrencyConflictError;
      expect(e.table).toBe("product_skus");
      expect(e.id).toBe("r1");
      expect(e.expectedVersion).toBe(3);
      expect(e.actualVersion).toBe(5);
    }
  });

  it("does not mutate the row when conflict is thrown", () => {
    const row = { id: "r1", row_version: 5, name: "old" };
    expect(() => updateWithVersion(row, 3, { name: "new" }, { table: "t" })).toThrow();
    expect(row.name).toBe("old");
    expect(row.row_version).toBe(5);
  });

  it("supports partial updates without touching untouched fields", () => {
    const row = { id: "r1", row_version: 1, a: "hello", b: 42, c: true };
    updateWithVersion(row, 1, { b: 100 }, { table: "t" });
    expect(row.a).toBe("hello");
    expect(row.b).toBe(100);
    expect(row.c).toBe(true);
  });
});
