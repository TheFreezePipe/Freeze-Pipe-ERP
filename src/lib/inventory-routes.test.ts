import { describe, expect, it } from "vitest";
import {
  INVENTORY_ROUTES,
  LEGACY_ROUTE_PATHS,
  legacyRedirect,
  shipmentPath,
  stockSearch,
  stockView,
} from "./inventory-routes";

describe("legacyRedirect", () => {
  it.each([
    ["/freight", "", "/inventory/shipments"],
    ["/freight/new", "", "/inventory/shipments/new"],
    ["/freight/0b7c2f1e-1234", "", "/inventory/shipments/0b7c2f1e-1234"],
    ["/warehouse", "", "/inventory"],
    ["/warehouse/map", "", "/inventory/stock?view=map"],
    ["/warehouse/putaway", "", "/inventory/shipments?filter=receiving"],
    ["/warehouse/counts", "", "/inventory/stock?view=counts"],
    ["/warehouse/locations", "", "/settings?tab=warehouse"],
    ["/inventory/quality-issues", "", "/inventory/issues"],
  ])("%s → %s", (pathname, search, expected) => {
    expect(legacyRedirect(pathname, search)).toBe(expected);
  });

  it("keeps the Shipments filter on /freight", () => {
    expect(legacyRedirect("/freight", "?filter=high_risk")).toBe("/inventory/shipments?filter=high_risk");
  });

  it("carries the query string through path params", () => {
    expect(legacyRedirect("/freight/abc", "?tab=cartons")).toBe("/inventory/shipments/abc?tab=cartons");
    expect(legacyRedirect("/freight/new", "?from=fo-1")).toBe("/inventory/shipments/new?from=fo-1");
  });

  it("merges the old query with the target's own, the target winning", () => {
    expect(legacyRedirect("/warehouse/map", "?q=BW20")).toBe("/inventory/stock?q=BW20&view=map");
    expect(legacyRedirect("/warehouse/putaway", "?filter=sea")).toBe("/inventory/shipments?filter=receiving");
    expect(legacyRedirect("/warehouse/locations", "?tab=users")).toBe("/settings?tab=warehouse");
  });

  it("accepts a search string with or without the leading ?", () => {
    expect(legacyRedirect("/freight", "filter=air")).toBe("/inventory/shipments?filter=air");
  });

  it("ignores a trailing slash and letter case", () => {
    expect(legacyRedirect("/freight/", "")).toBe("/inventory/shipments");
    expect(legacyRedirect("/Warehouse/Counts", "")).toBe("/inventory/stock?view=counts");
  });

  it("returns null for routes that are not legacy", () => {
    expect(legacyRedirect("/inventory", "")).toBeNull();
    expect(legacyRedirect("/inventory/stock", "?view=map")).toBeNull();
    expect(legacyRedirect("/inventory/shipments/abc", "")).toBeNull();
    expect(legacyRedirect("/freight/abc/extra", "")).toBeNull();
    expect(legacyRedirect("/warehouse/racks", "")).toBeNull();
    expect(legacyRedirect("/", "")).toBeNull();
  });

  it("resolves every route App.tsx mounts as a redirect", () => {
    for (const pattern of LEGACY_ROUTE_PATHS) {
      expect(legacyRedirect(pattern.replace(":id", "x1"), ""), pattern).not.toBeNull();
    }
  });
});

describe("route helpers", () => {
  it("stockView leaves the default view out of the URL", () => {
    expect(stockView("sku")).toBe(INVENTORY_ROUTES.stock);
    expect(stockView("location")).toBe("/inventory/stock?view=location");
    expect(stockView("map")).toBe("/inventory/stock?view=map");
    expect(stockView("counts")).toBe("/inventory/stock?view=counts");
  });

  it("stockSearch encodes the query", () => {
    expect(stockSearch("BW20")).toBe("/inventory/stock?q=BW20");
    expect(stockSearch("BW20 DNA&X")).toBe("/inventory/stock?q=BW20+DNA%26X");
  });

  it("shipmentPath points under Inventory", () => {
    expect(shipmentPath("s-1")).toBe("/inventory/shipments/s-1");
  });
});
