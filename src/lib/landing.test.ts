import { describe, it, expect } from "vitest";
import { landingPathFor } from "./landing";

describe("landingPathFor", () => {
  it("sends floor staff to the floor home", () => {
    expect(landingPathFor("user")).toBe("/go");
  });
  it("sends suppliers to the supplier portal", () => {
    expect(landingPathFor("supplier")).toBe("/supplier");
  });
  it("sends admins and managers to the dashboard", () => {
    expect(landingPathFor("admin")).toBe("/dashboard");
    expect(landingPathFor("manager")).toBe("/dashboard");
  });
});
