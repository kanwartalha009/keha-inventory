/**
 * Catalog parsers (spec §6.3, task 1.3): bulk JSONL reassembly by __parentId in any order,
 * bundles flagged, untracked kept, missing cost = null (never 0), collections attached and
 * capped, malformed / orphan lines skipped and counted; locations, stock levels, shop info.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  adminThrottleWaitMs,
  hasThrottledError,
  paceWaitMs,
  readAdminCost,
  CATALOG_BULK_QUERY,
  MAX_COLLECTIONS,
  decimalOrNull,
  itemVariantId,
  levelRows,
  parseCatalogJsonl,
  parseShopInfo,
  stockPageSizes,
  toGid,
  toLocationRow,
  toVariantRow,
  toCollectionRow,
} from "../../app/lib/sync/catalog-shared";

const jsonl = readFileSync(join(__dirname, "fixtures/catalog.jsonl"), "utf8");

describe("parseCatalogJsonl", () => {
  const r = parseCatalogJsonl(jsonl);
  const byId = new Map(r.variants.map((v) => [v.id, v]));

  it("reassembles variants under their product regardless of line order", () => {
    expect(r.products).toBe(3);
    expect(r.variants.map((v) => v.id).sort()).toEqual([
      "gid://shopify/ProductVariant/1001",
      "gid://shopify/ProductVariant/1002",
      "gid://shopify/ProductVariant/2001",
      "gid://shopify/ProductVariant/3001",
    ]);
    const s = byId.get("gid://shopify/ProductVariant/1001")!;
    expect(s).toMatchObject({
      productId: "gid://shopify/Product/1",
      productTitle: "Basic Tee",
      variantTitle: "S",
      handle: "basic-tee",
      sku: "TEE-S",
      vendor: "Acme",
      productType: "Shirts",
      image: "https://cdn.shopify.com/tee.jpg",
      status: "ACTIVE",
      price: "25.00",
      cost: "8.50",
      costCurrency: "EUR",
      tracked: true,
      isBundle: false,
    });
    expect(s.productCreatedAt?.toISOString()).toBe("2025-01-10T09:00:00.000Z");
  });

  it("attaches collections (child lines before and after the product)", () => {
    expect(byId.get("gid://shopify/ProductVariant/1001")!.collections).toEqual([
      "gid://shopify/Collection/301",
      "gid://shopify/Collection/302",
    ]);
    expect(byId.get("gid://shopify/ProductVariant/2001")!.collections).toEqual([]);
  });

  it("keeps untracked variants with tracked = false and a null cost", () => {
    const m = byId.get("gid://shopify/ProductVariant/1002")!;
    expect(m.tracked).toBe(false);
    expect(m.cost).toBeNull();
    expect(m.costCurrency).toBeNull();
  });

  it("flags bundles from requiresComponents, else the product flag", () => {
    expect(byId.get("gid://shopify/ProductVariant/2001")!.isBundle).toBe(true);
    expect(byId.get("gid://shopify/ProductVariant/3001")!.isBundle).toBe(true);
  });

  it("an empty cost amount is null, never 0; an explicit 0 stays as Shopify has it", () => {
    expect(byId.get("gid://shopify/ProductVariant/2001")!.cost).toBeNull();
    expect(byId.get("gid://shopify/ProductVariant/3001")!.cost).toBe("0");
  });

  it("missing image / bad dates / empty strings become null", () => {
    const g = byId.get("gid://shopify/ProductVariant/2001")!;
    expect(g.image).toBeNull();
    expect(g.productType).toBeNull();
    expect(g.sku).toBeNull();
    expect(byId.get("gid://shopify/ProductVariant/3001")!.productCreatedAt).toBeNull();
  });

  it("skips and counts malformed lines and orphans", () => {
    expect(r.malformed).toBe(2); // "this is not json" and the JSON array
    expect(r.orphans).toBe(1); // the variant of Product/404
  });

  it("caps collections at 20 (bulk ignores first:)", () => {
    const lines = [JSON.stringify({ id: "gid://shopify/Product/9", title: "X", handle: "x" })];
    for (let i = 0; i < 25; i++) lines.push(JSON.stringify({ id: `gid://shopify/Collection/${i + 1}`, __parentId: "gid://shopify/Product/9" }));
    lines.push(JSON.stringify({ id: "gid://shopify/ProductVariant/90", __parentId: "gid://shopify/Product/9", inventoryItem: { tracked: true } }));
    const out = parseCatalogJsonl(lines.join("\n"));
    expect(out.variants[0].collections).toHaveLength(MAX_COLLECTIONS);
  });

  it("returns each collection once with its title and handle (task 2.5)", () => {
    expect(r.collections.sort((a, b) => (a.id < b.id ? -1 : 1))).toEqual([
      // Seen under Product/1 and Product/3; the title is trimmed; the last line wins.
      { id: "gid://shopify/Collection/301", title: "Summer", handle: "summer" },
      // No title / handle in the line: "" (the UI shows "—").
      { id: "gid://shopify/Collection/302", title: "", handle: "" },
    ]);
    expect(byId.get("gid://shopify/ProductVariant/3001")!.collections).toEqual(["gid://shopify/Collection/301"]);
  });

  it("keeps every collection row, also past the per-variant cap of 20, and drops unusable ids", () => {
    const lines = [JSON.stringify({ id: "gid://shopify/Product/9", title: "X", handle: "x" })];
    for (let i = 0; i < 25; i++)
      lines.push(JSON.stringify({ id: `gid://shopify/Collection/${i + 1}`, title: `C${i + 1}`, handle: `c-${i + 1}`, __parentId: "gid://shopify/Product/9" }));
    lines.push(JSON.stringify({ id: "gid://shopify/ProductVariant/90", __parentId: "gid://shopify/Product/9", inventoryItem: { tracked: true } }));
    const out = parseCatalogJsonl(lines.join("\n"));
    expect(out.collections).toHaveLength(25);
    expect(out.collections[0]).toEqual({ id: "gid://shopify/Collection/1", title: "C1", handle: "c-1" });
    expect(toCollectionRow({ id: "gid://shopify/Product/1", title: "Nope" })).toBeNull();
    expect(toCollectionRow({ id: 44, title: 5, handle: null })).toEqual({ id: "gid://shopify/Collection/44", title: "", handle: "" });
    expect(toCollectionRow(null)).toBeNull();
  });

  it("empty input is an empty catalog", () => {
    expect(parseCatalogJsonl("")).toEqual({ variants: [], collections: [], products: 0, malformed: 0, orphans: 0 });
  });
});

describe("bulk query shape", () => {
  it("uses at most 5 connections, nested at most 2 deep, and no first: arguments", () => {
    expect((CATALOG_BULK_QUERY.match(/edges/g) ?? []).length).toBeLessThanOrEqual(5);
    expect(CATALOG_BULK_QUERY).not.toMatch(/first:/);
    expect(CATALOG_BULK_QUERY).toContain("hasVariantsThatRequiresComponents");
    expect(CATALOG_BULK_QUERY).toContain("requiresComponents");
    expect(CATALOG_BULK_QUERY).toContain("collections { edges { node { id title handle } } }");
  });
});

describe("row helpers", () => {
  it("toGid accepts numbers, numeric strings and matching gids only", () => {
    expect(toGid("Location", 12)).toBe("gid://shopify/Location/12");
    expect(toGid("Location", "0012")).toBe("gid://shopify/Location/12");
    expect(toGid("Location", "gid://shopify/Location/5")).toBe("gid://shopify/Location/5");
    expect(toGid("Location", "gid://shopify/Product/5")).toBeUndefined();
    expect(toGid("Location", 0)).toBeUndefined();
    expect(toGid("Location", null)).toBeUndefined();
  });

  it("decimalOrNull never invents a number", () => {
    expect(decimalOrNull("12.30")).toBe("12.30");
    expect(decimalOrNull(4)).toBe("4");
    expect(decimalOrNull("")).toBeNull();
    expect(decimalOrNull("abc")).toBeNull();
    expect(decimalOrNull(undefined)).toBeNull();
  });

  it("toVariantRow rejects unusable ids", () => {
    expect(toVariantRow({ id: "x" }, { id: "gid://shopify/ProductVariant/1" }, [])).toBeNull();
  });

  it("maps locations", () => {
    expect(toLocationRow({ id: "gid://shopify/Location/1", name: "Warehouse", isActive: true, fulfillsOnlineOrders: true })).toEqual({
      id: "gid://shopify/Location/1",
      name: "Warehouse",
      active: true,
      online: true,
    });
    expect(toLocationRow({ id: "gid://shopify/Location/2", name: "Shop", isActive: false })).toMatchObject({ active: false, online: false });
    expect(toLocationRow({ id: "nope" })).toBeNull();
  });

  it("maps inventory levels by quantity name", () => {
    const item = { variants: { nodes: [{ id: "gid://shopify/ProductVariant/1001" }] } };
    expect(itemVariantId(item)).toBe("gid://shopify/ProductVariant/1001");
    expect(itemVariantId({ variants: { nodes: [] } })).toBeUndefined();
    const rows = levelRows("gid://shopify/ProductVariant/1001", [
      {
        location: { id: "gid://shopify/Location/1" },
        quantities: [
          { name: "on_hand", quantity: 12 },
          { name: "available", quantity: 9 },
          { name: "committed", quantity: 3 },
          { name: "incoming", quantity: 40 },
        ],
      },
      { location: null, quantities: [] },
      { location: { id: "gid://shopify/Location/2" }, quantities: [{ name: "available", quantity: -2 }] },
    ]);
    expect(rows).toEqual([
      { variantId: "gid://shopify/ProductVariant/1001", locationId: "gid://shopify/Location/1", available: 9, incoming: 40, committed: 3, onHand: 12 },
      { variantId: "gid://shopify/ProductVariant/1001", locationId: "gid://shopify/Location/2", available: -2, incoming: 0, committed: 0, onHand: 0 },
    ]);
  });

  it("stock page sizes keep the estimated cost under 1000", () => {
    for (const n of [0, 1, 3, 10, 50, 250, 400]) {
      const { first, levels } = stockPageSizes(n);
      expect(levels).toBeGreaterThanOrEqual(1);
      expect(levels).toBeLessThanOrEqual(250);
      expect(first).toBeGreaterThanOrEqual(1);
      if (first > 1) expect(first * (4 + 3 * levels)).toBeLessThanOrEqual(1000);
    }
    expect(stockPageSizes(3)).toEqual({ first: 69, levels: 3 });
  });

  it("reads shop info from shop + shopLocales (primary locale)", () => {
    expect(
      parseShopInfo({
        shop: { name: "Acme", currencyCode: "EUR", ianaTimezone: "Europe/Madrid", myshopifyDomain: "acme.myshopify.com" },
        shopLocales: [
          { locale: "en", primary: false },
          { locale: "es", primary: true },
        ],
      }),
    ).toEqual({ name: "Acme", currency: "EUR", timezone: "Europe/Madrid", locale: "es", myshopifyDomain: "acme.myshopify.com" });
    expect(parseShopInfo(null)).toMatchObject({ currency: "USD", timezone: "UTC", locale: "en" });
  });
});

describe("Admin API throttle maths (review H5)", () => {
  const body = {
    extensions: { cost: { requestedQueryCost: 202, actualQueryCost: null, throttleStatus: { maximumAvailable: 2000, currentlyAvailable: 2, restoreRate: 100 } } },
  };

  it("reads extensions.cost", () => {
    expect(readAdminCost(body)).toEqual({ requestedQueryCost: 202, maximumAvailable: 2000, currentlyAvailable: 2, restoreRate: 100 });
    expect(readAdminCost({})).toBeNull();
  });

  it("finds THROTTLED in returned errors and in the library's graphQLErrors wrapper", () => {
    expect(hasThrottledError([{ message: "Throttled", extensions: { code: "THROTTLED" } }])).toBe(true);
    expect(hasThrottledError({ graphQLErrors: [{ extensions: { code: "THROTTLED" } }] })).toBe(true);
    expect(hasThrottledError([{ message: "Access denied", extensions: { code: "ACCESS_DENIED" } }])).toBe(false);
    expect(hasThrottledError(undefined)).toBe(false);
  });

  it("waits for the refill to the requested cost, else 2^n s, capped at 60 s", () => {
    expect(adminThrottleWaitMs(readAdminCost(body), 1)).toBe(2000); // (202 − 2) ÷ 100 per s
    expect(adminThrottleWaitMs(null, 1)).toBe(1000);
    expect(adminThrottleWaitMs(null, 3)).toBe(4000);
    expect(adminThrottleWaitMs(null, 10)).toBe(60_000);
    expect(adminThrottleWaitMs({ requestedQueryCost: 50, currentlyAvailable: 60, restoreRate: 50, maximumAvailable: 1000 }, 1)).toBe(1000);
  });

  it("paces pages only when the bucket holds less than the next page's cost", () => {
    expect(paceWaitMs(readAdminCost(body), 202)).toBe(2000);
    expect(paceWaitMs({ requestedQueryCost: 10, currentlyAvailable: 900, restoreRate: 50, maximumAvailable: 1000 }, 202)).toBe(0);
    expect(paceWaitMs(null, 202)).toBe(0);
  });
});
