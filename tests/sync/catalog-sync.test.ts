/**
 * Catalog sync service (task 1.3) against a fake Admin client and an in-memory Prisma:
 * bulk polling with injected sleep/fetch, stale variants removed, location roles kept,
 * stock-now pagination, the single-item refresh and the Shop row.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePrisma } from "../helpers/fake-prisma";
import { useFakeFacts } from "../helpers/fake-facts";
import type { AdminGraphqlClient } from "../../app/models/shop.server";

const fake = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("../../app/db.server", () => ({
  get default() {
    return fake.db;
  },
}));

import {
  AdminThrottledError,
  BulkOperationError,
  gql,
  deleteProduct,
  ensureShop,
  refreshStockForInventoryItem,
  runBulkQuery,
  syncCatalog,
  syncLocations,
  syncProduct,
  syncStockNow,
} from "../../app/services/sync/catalog.server";

const S = "acme.myshopify.com";
const jsonl = readFileSync(join(__dirname, "fixtures/catalog.jsonl"), "utf8");

const db = createFakePrisma(
  {
    variant: ["id"],
    collection: ["id"],
    location: ["id"],
    stockNow: ["shop", "variantId", "locationId"],
    shop: ["domain"],
  },
  ["variant", "stockNow"],
);
fake.db = db.client;
useFakeFacts(db);

type Handler = (query: string, variables?: Record<string, unknown>) => unknown;

function admin(handler: Handler) {
  const calls: { query: string; variables?: Record<string, unknown> }[] = [];
  const client: AdminGraphqlClient = {
    graphql: async (query, options) => {
      calls.push({ query, variables: options?.variables });
      return new Response(JSON.stringify({ data: handler(query, options?.variables) }), { status: 200 });
    },
  };
  return { client, calls };
}

beforeEach(() => db.reset());

describe("runBulkQuery", () => {
  it("polls bulkOperation(id) until COMPLETED, then downloads the JSONL", async () => {
    let polls = 0;
    const a = admin((q) => {
      if (q.includes("bulkOperationRunQuery"))
        return { bulkOperationRunQuery: { bulkOperation: { id: "gid://shopify/BulkOperation/1", status: "CREATED" }, userErrors: [] } };
      polls++;
      return { bulkOperation: { id: "gid://shopify/BulkOperation/1", status: polls < 3 ? "RUNNING" : "COMPLETED", url: "https://x/result.jsonl" } };
    });
    const sleeps: number[] = [];
    const text = await runBulkQuery(a.client, "{ products { edges { node { id } } } }", {
      sleep: async (ms) => void sleeps.push(ms),
      fetch: async (url) => new Response(`{"id":"gid://shopify/Product/1"}\n${url}`),
      pollMs: 10,
    });
    expect(polls).toBe(3);
    expect(sleeps).toEqual([10, 10]);
    expect(text).toContain("result.jsonl");
    expect(a.calls[0].query).toContain("groupObjects: false");
    expect(a.calls.slice(1).every((c) => c.query.includes("bulkOperation(id: $id)"))).toBe(true);
  });

  it("returns empty text for a completed operation without a url (empty shop)", async () => {
    const a = admin((q) =>
      q.includes("bulkOperationRunQuery")
        ? { bulkOperationRunQuery: { bulkOperation: { id: "b", status: "CREATED" }, userErrors: [] } }
        : { bulkOperation: { id: "b", status: "COMPLETED", url: null } },
    );
    expect(await runBulkQuery(a.client, "{}", { sleep: async () => {} })).toBe("");
  });

  it("throws on userErrors, FAILED and timeout", async () => {
    const bad = admin(() => ({ bulkOperationRunQuery: { bulkOperation: null, userErrors: [{ message: "already running" }] } }));
    await expect(runBulkQuery(bad.client, "{}")).rejects.toThrow("already running");

    const failed = admin((q) =>
      q.includes("bulkOperationRunQuery")
        ? { bulkOperationRunQuery: { bulkOperation: { id: "b", status: "CREATED" }, userErrors: [] } }
        : { bulkOperation: { id: "b", status: "FAILED", errorCode: "TIMEOUT" } },
    );
    await expect(runBulkQuery(failed.client, "{}", { sleep: async () => {} })).rejects.toThrow(BulkOperationError);

    let t = 0;
    const slow = admin((q) =>
      q.includes("bulkOperationRunQuery")
        ? { bulkOperationRunQuery: { bulkOperation: { id: "b", status: "CREATED" }, userErrors: [] } }
        : { bulkOperation: { id: "b", status: "RUNNING" } },
    );
    await expect(
      runBulkQuery(slow.client, "{}", { sleep: async (ms) => void (t += ms), now: () => t, pollMs: 1000, timeoutMs: 5000 }),
    ).rejects.toThrow("timed out");
  });
});

function bulkAdmin(text: string) {
  return admin((q) =>
    q.includes("bulkOperationRunQuery")
      ? { bulkOperationRunQuery: { bulkOperation: { id: "b", status: "CREATED" }, userErrors: [] } }
      : { bulkOperation: { id: "b", status: "COMPLETED", url: "https://x" } },
  ).client;
}

describe("syncCatalog", () => {
  it("upserts every variant and removes variants the catalog no longer has", async () => {
    db.tables.variant = [{ id: "gid://shopify/ProductVariant/777", shop: S, productId: "gid://shopify/Product/77" }];
    db.tables.stockNow = [{ shop: S, variantId: "gid://shopify/ProductVariant/777", locationId: "L" }];
    db.tables.variantMetric = [{ shop: S, variantId: "gid://shopify/ProductVariant/777", scope: "online" }];
    db.tables.collection = [
      { id: "gid://shopify/Collection/301", shop: S, title: "Old name", handle: "old" },
      { id: "gid://shopify/Collection/999", shop: S, title: "Gone", handle: "gone" },
      { id: "gid://shopify/Collection/888", shop: "other.myshopify.com", title: "Other shop", handle: "other" },
    ];
    const r = await syncCatalog(bulkAdmin(jsonl), S, { sleep: async () => {}, fetch: async () => new Response(jsonl) });
    expect(r).toEqual({ variants: 4, products: 3, malformed: 2, orphans: 1, removed: 1, collections: 2, collectionsRemoved: 1 });
    // Titles refreshed, new ones added, the shop's stale one removed, other shops untouched.
    expect(db.tables.collection.map((c) => [c.id, c.shop, c.title, c.handle]).sort()).toEqual([
      ["gid://shopify/Collection/301", S, "Summer", "summer"],
      ["gid://shopify/Collection/302", S, "", ""],
      ["gid://shopify/Collection/888", "other.myshopify.com", "Other shop", "other"],
    ]);
    expect(db.tables.variant.map((v) => v.id).sort()).toEqual([
      "gid://shopify/ProductVariant/1001",
      "gid://shopify/ProductVariant/1002",
      "gid://shopify/ProductVariant/2001",
      "gid://shopify/ProductVariant/3001",
    ]);
    expect(db.tables.stockNow).toEqual([]);
    expect(db.tables.variantMetric).toEqual([]);
    expect(db.tables.variant.every((v) => v.shop === S)).toBe(true);
  });

  it("is idempotent (a second run changes nothing)", async () => {
    const deps = { sleep: async () => {}, fetch: async () => new Response(jsonl) };
    await syncCatalog(bulkAdmin(jsonl), S, deps);
    const first = JSON.stringify(db.tables.variant.map(({ updatedAt: _u, ...v }) => v));
    await syncCatalog(bulkAdmin(jsonl), S, deps);
    expect(JSON.stringify(db.tables.variant.map(({ updatedAt: _u, ...v }) => v))).toBe(first);
  });
});

describe("syncProduct / deleteProduct", () => {
  it("re-reads one product's variants and drops the ones it no longer has", async () => {
    db.tables.variant = [
      { id: "gid://shopify/ProductVariant/1001", shop: S, productId: "gid://shopify/Product/1" },
      { id: "gid://shopify/ProductVariant/1099", shop: S, productId: "gid://shopify/Product/1" },
    ];
    const a = admin(() => ({
      product: {
        id: "gid://shopify/Product/1",
        title: "Basic Tee v2",
        handle: "basic-tee",
        status: "ACTIVE",
        vendor: "Acme",
        productType: "Shirts",
        createdAt: "2025-01-10T09:00:00Z",
        hasVariantsThatRequiresComponents: false,
        collections: { nodes: [{ id: "gid://shopify/Collection/301" }] },
        variants: {
          nodes: [{ id: "gid://shopify/ProductVariant/1001", title: "S", price: "27.00", inventoryItem: { tracked: true, unitCost: null } }],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    }));
    expect(await syncProduct(a.client, S, "gid://shopify/Product/1")).toBe(1);
    expect(db.tables.variant).toHaveLength(1);
    expect(db.tables.variant[0]).toMatchObject({ productTitle: "Basic Tee v2", price: "27.00", cost: null, collections: ["gid://shopify/Collection/301"] });
  });

  it("deletes a product's variants, stock now and metrics only", async () => {
    db.tables.variant = [
      { id: "v1", shop: S, productId: "gid://shopify/Product/1" },
      { id: "v2", shop: S, productId: "gid://shopify/Product/2" },
    ];
    db.tables.stockNow = [
      { shop: S, variantId: "v1", locationId: "L" },
      { shop: S, variantId: "v2", locationId: "L" },
    ];
    db.tables.variantMetric = [{ shop: S, variantId: "v1", scope: "online" }];
    expect(await deleteProduct(S, "gid://shopify/Product/1")).toBe(1);
    expect(db.tables.variant.map((v) => v.id)).toEqual(["v2"]);
    expect(db.tables.stockNow.map((v) => v.variantId)).toEqual(["v2"]);
    expect(db.tables.variantMetric).toEqual([]);
  });
});

describe("syncLocations", () => {
  it("upserts locations (inactive included) and never overwrites a stored role", async () => {
    db.tables.location = [{ id: "gid://shopify/Location/1", shop: S, name: "Old", active: true, online: true, role: "warehouse" }];
    const a = admin(() => ({
      locations: {
        nodes: [
          { id: "gid://shopify/Location/1", name: "Main warehouse", isActive: true, fulfillsOnlineOrders: true },
          { id: "gid://shopify/Location/2", name: "Madrid store", isActive: false, fulfillsOnlineOrders: false },
        ],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    }));
    await syncLocations(a.client, S);
    expect(a.calls[0].query).toContain("includeInactive: true");
    expect(db.tables.location).toEqual([
      { id: "gid://shopify/Location/1", shop: S, name: "Main warehouse", active: true, online: true, role: "warehouse" },
      { id: "gid://shopify/Location/2", shop: S, name: "Madrid store", active: false, online: false },
    ]);
  });
});

const level = (loc: string, onHand: number, available = onHand) => ({
  location: { id: loc },
  quantities: [
    { name: "available", quantity: available },
    { name: "incoming", quantity: 0 },
    { name: "committed", quantity: onHand - available },
    { name: "on_hand", quantity: onHand },
  ],
});

describe("syncStockNow", () => {
  it("pages through inventory items, follows an item's extra levels, removes rows not seen", async () => {
    db.tables.location = [{ id: "L1", shop: S }];
    // The catalog stage runs first in a pass: the variants read exist; V9 is gone from the catalog.
    db.tables.variant = [{ id: "gid://shopify/ProductVariant/1001", shop: S }, { id: "gid://shopify/ProductVariant/1002", shop: S }];
    db.tables.stockNow = [{ shop: S, variantId: "gid://shopify/ProductVariant/9", locationId: "gid://shopify/Location/1", updatedAt: new Date(0) }];
    const a = admin((q, v) => {
      if (q.includes("KehaInvStockItem"))
        return {
          inventoryItem: {
            id: "gid://shopify/InventoryItem/5001",
            variants: { nodes: [{ id: "gid://shopify/ProductVariant/1001" }] },
            inventoryLevels: { nodes: [level("gid://shopify/Location/2", 4)], pageInfo: { hasNextPage: false, endCursor: null } },
          },
        };
      if (!v?.after)
        return {
          inventoryItems: {
            nodes: [
              {
                id: "gid://shopify/InventoryItem/5001",
                variants: { nodes: [{ id: "gid://shopify/ProductVariant/1001" }] },
                inventoryLevels: { nodes: [level("gid://shopify/Location/1", 10, 8)], pageInfo: { hasNextPage: true, endCursor: "lv1" } },
              },
            ],
            pageInfo: { hasNextPage: true, endCursor: "p1" },
          },
        };
      return {
        inventoryItems: {
          nodes: [
            {
              id: "gid://shopify/InventoryItem/5002",
              variants: { nodes: [{ id: "gid://shopify/ProductVariant/1002" }] },
              inventoryLevels: { nodes: [level("gid://shopify/Location/1", 0)], pageInfo: { hasNextPage: false, endCursor: null } },
            },
            { id: "gid://shopify/InventoryItem/5999", variants: { nodes: [] }, inventoryLevels: { nodes: [level("gid://shopify/Location/1", 3)] } },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      };
    });
    expect(await syncStockNow(a.client, S)).toBe(3);
    expect(a.calls[0].variables).toMatchObject({ first: 128, levels: 1 });
    const rows = db.tables.stockNow.map(({ updatedAt: _u, ...r }) => r);
    expect(rows).toEqual([
      { shop: S, variantId: "gid://shopify/ProductVariant/1001", locationId: "gid://shopify/Location/1", available: 8, incoming: 0, committed: 2, onHand: 10 },
      { shop: S, variantId: "gid://shopify/ProductVariant/1001", locationId: "gid://shopify/Location/2", available: 4, incoming: 0, committed: 0, onHand: 4 },
      { shop: S, variantId: "gid://shopify/ProductVariant/1002", locationId: "gid://shopify/Location/1", available: 0, incoming: 0, committed: 0, onHand: 0 },
    ]);
  });
});

describe("stock now: change-only writes (DB scale)", () => {
  it("a second pass with the same levels rewrites nothing; a level no longer listed goes", async () => {
    db.tables.location = [{ id: "L1", shop: S }];
    db.tables.variant = [{ id: "gid://shopify/ProductVariant/1", shop: S }];
    let levels = [level("gid://shopify/Location/1", 5), level("gid://shopify/Location/2", 3)];
    const a = admin(() => ({
      inventoryItems: {
        nodes: [{ id: "gid://shopify/InventoryItem/1", variants: { nodes: [{ id: "gid://shopify/ProductVariant/1" }] }, inventoryLevels: { nodes: levels, pageInfo: { hasNextPage: false } } }],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    }));
    await syncStockNow(a.client, S);
    const stamps = db.tables.stockNow.map((r) => (r.updatedAt as Date).getTime());
    db.calls.length = 0;
    await syncStockNow(a.client, S);
    expect(db.calls.filter((c) => c.table === "stockNow" && (c.op === "update" || c.op === "create"))).toEqual([]);
    expect(db.tables.stockNow.map((r) => (r.updatedAt as Date).getTime())).toEqual(stamps);
    levels = [level("gid://shopify/Location/1", 4)];
    await syncStockNow(a.client, S);
    expect(db.tables.stockNow.map((r) => [r.locationId, r.onHand])).toEqual([["gid://shopify/Location/1", 4]]);
  });
});

describe("refreshStockForInventoryItem", () => {
  it("refreshes one item and drops levels it no longer has", async () => {
    db.tables.stockNow = [
      { shop: S, variantId: "gid://shopify/ProductVariant/1001", locationId: "gid://shopify/Location/1", onHand: 1 },
      { shop: S, variantId: "gid://shopify/ProductVariant/1001", locationId: "gid://shopify/Location/3", onHand: 5 },
      { shop: S, variantId: "gid://shopify/ProductVariant/2", locationId: "gid://shopify/Location/3", onHand: 5 },
    ];
    const a = admin(() => ({
      inventoryItem: {
        id: "gid://shopify/InventoryItem/5001",
        variants: { nodes: [{ id: "gid://shopify/ProductVariant/1001" }] },
        inventoryLevels: { nodes: [level("gid://shopify/Location/1", 7)], pageInfo: { hasNextPage: false } },
      },
    }));
    expect(await refreshStockForInventoryItem(a.client, S, "gid://shopify/InventoryItem/5001")).toBe(1);
    expect(db.tables.stockNow.map((r) => [r.variantId, r.locationId, r.onHand])).toEqual([
      ["gid://shopify/ProductVariant/1001", "gid://shopify/Location/1", 7],
      ["gid://shopify/ProductVariant/2", "gid://shopify/Location/3", 5],
    ]);
  });

  it("does nothing for an unknown item", async () => {
    const a = admin(() => ({ inventoryItem: null }));
    expect(await refreshStockForInventoryItem(a.client, S, "gid://shopify/InventoryItem/1")).toBe(0);
  });
});

/** What @shopify/shopify-api throws for a GraphQL error response (as in the live Railway log). */
class GraphqlQueryError extends Error {
  body: unknown;
  constructor(message: string, body: unknown) {
    super(message);
    this.name = "GraphqlQueryError";
    this.body = body;
  }
}

const SHOP_DATA = { shop: { name: "Acme", currencyCode: "EUR", ianaTimezone: "Europe/Madrid", myshopifyDomain: S } };
const DENIED =
  "Access denied for shopLocales field. Required access: `read_locales` access scope or `read_markets_home` access scope.";

/** Admin without read_locales: shopLocales is denied, everything else answers. */
function noLocalesAdmin(mode: "throw" | "errors") {
  const calls: string[] = [];
  const client: AdminGraphqlClient = {
    graphql: async (query) => {
      calls.push(query);
      if (query.includes("shopLocales")) {
        const body = { errors: [{ message: DENIED, extensions: { code: "ACCESS_DENIED" } }], data: null };
        if (mode === "throw") throw new GraphqlQueryError(`GraphQL Client: ${DENIED}`, body);
        return new Response(JSON.stringify(body), { status: 200 });
      }
      return new Response(JSON.stringify({ data: SHOP_DATA }), { status: 200 });
    },
  };
  return { client, calls };
}

describe("ensureShop", () => {
  it("upserts the Shop row from shop, then shopLocales, and clears uninstalledAt on reinstall", async () => {
    db.tables.shop = [{ domain: S, currency: "USD", timezone: "UTC", locale: "en", uninstalledAt: new Date() }];
    const a = admin((q) => (q.includes("shopLocales") ? { shopLocales: [{ locale: "es", primary: true }] } : SHOP_DATA));
    const info = await ensureShop(a.client, S);
    expect(info.name).toBe("Acme");
    // The shop read never asks for shopLocales (read_locales): the language is its own query.
    expect(a.calls[0].query).toContain("shop {");
    expect(a.calls[0].query).not.toContain("shopLocales");
    expect(a.calls[1].query).toContain("shopLocales");
    expect(a.calls.map((c) => c.query).join()).not.toContain("primaryLocale");
    expect(db.tables.shop).toEqual([{ domain: S, currency: "EUR", timezone: "Europe/Madrid", locale: "es", uninstalledAt: null }]);
  });

  it.each(["throw", "errors"] as const)(
    "still reads the shop when shopLocales is ACCESS_DENIED (%s): new row in English",
    async (mode) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const a = noLocalesAdmin(mode);
      const info = await ensureShop(a.client, `new-${mode}.myshopify.com`);
      expect(info).toMatchObject({ currency: "EUR", timezone: "Europe/Madrid", locale: "en" });
      expect(db.tables.shop).toEqual([
        { domain: `new-${mode}.myshopify.com`, currency: "EUR", timezone: "Europe/Madrid", locale: "en" },
      ]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain("read_locales");
      warn.mockRestore();
    },
  );

  it("keeps the stored language when shopLocales is denied", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    db.tables.shop = [{ domain: S, currency: "USD", timezone: "UTC", locale: "es", uninstalledAt: new Date() }];
    await ensureShop(noLocalesAdmin("throw").client, S);
    expect(db.tables.shop).toEqual([{ domain: S, currency: "EUR", timezone: "Europe/Madrid", locale: "es", uninstalledAt: null }]);
    warn.mockRestore();
  });

  it("surfaces GraphQL errors", async () => {
    const client: AdminGraphqlClient = {
      graphql: async () => new Response(JSON.stringify({ errors: [{ message: "Access denied" }] }), { status: 200 }),
    };
    await expect(ensureShop(client, S)).rejects.toThrow("Access denied");
  });
});

describe("Admin API throttling (review H5)", () => {
  const throttled = (available = 0) =>
    new Response(
      JSON.stringify({
        errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }],
        extensions: { cost: { requestedQueryCost: 100, throttleStatus: { maximumAvailable: 1000, currentlyAvailable: available, restoreRate: 50 } } },
      }),
    );
  const ok = () => new Response(JSON.stringify({ data: { shop: { name: "Acme" } } }));

  it("retries a returned THROTTLED error after the bucket's refill time", async () => {
    const responses = [throttled(0), throttled(60), ok()];
    const client: AdminGraphqlClient = { graphql: vi.fn(async () => responses.shift()!) };
    const slept: number[] = [];
    const data = await gql<{ shop: { name: string } }>(client, "q", undefined, { throttleSleep: async (ms) => void slept.push(ms) });
    expect(data.shop.name).toBe("Acme");
    expect(slept).toEqual([2000, 1000]); // (100 − 0) ÷ 50, then (100 − 60) ÷ 50 → min 1 s
  });

  it("retries throttles the library throws (graphQLErrors wrapper, HTTP 429)", async () => {
    const thrown = [
      Object.assign(new Error("GraphQL error"), { body: { errors: { graphQLErrors: [{ extensions: { code: "THROTTLED" } }] } } }),
      new Response("{}", { status: 429 }),
      Object.assign(new Error("429"), { response: { code: 429, retryAfter: 2 } }),
    ];
    const client: AdminGraphqlClient = {
      graphql: vi.fn(async () => {
        const t = thrown.shift();
        if (t) throw t;
        return ok();
      }),
    };
    const slept: number[] = [];
    await gql(client, "q", undefined, { sleep: async (ms) => void slept.push(ms) });
    expect(slept).toEqual([1000, 2000, 2000]); // 2^0 s, 2^1 s, Retry-After 2 s
  });

  it("gives up after 5 attempts with AdminThrottledError; other errors are not retried", async () => {
    const client: AdminGraphqlClient = { graphql: vi.fn(async () => throttled()) };
    await expect(gql(client, "q", undefined, { sleep: async () => {} })).rejects.toBeInstanceOf(AdminThrottledError);
    expect(client.graphql).toHaveBeenCalledTimes(5);
    const denied: AdminGraphqlClient = {
      graphql: vi.fn(async () => new Response(JSON.stringify({ errors: [{ message: "Access denied" }] }))),
    };
    await expect(gql(denied, "q", undefined, { sleep: async () => {} })).rejects.toThrow("Access denied");
    expect(denied.graphql).toHaveBeenCalledTimes(1);
  });

  it("paces stock pages on the bucket and resumes a pass from its saved cursor", async () => {
    db.tables.location = [{ id: "L1", shop: S }];
    db.tables.variant = [{ id: "gid://shopify/ProductVariant/1", shop: S }, { id: "gid://shopify/ProductVariant/2", shop: S }];
    db.tables.stockNow = [{ shop: S, variantId: "gid://shopify/ProductVariant/9", locationId: "gid://shopify/Location/1", updatedAt: new Date(0) }];
    const afters: unknown[] = [];
    const client: AdminGraphqlClient = {
      graphql: vi.fn(async (_q: string, o?: { variables?: Record<string, unknown> }) => {
        afters.push(o?.variables?.after);
        const last = o?.variables?.after === "p2";
        return new Response(
          JSON.stringify({
            data: {
              inventoryItems: {
                nodes: [
                  {
                    id: "gid://shopify/InventoryItem/1",
                    variants: { nodes: [{ id: `gid://shopify/ProductVariant/${last ? 2 : 1}` }] },
                    inventoryLevels: { nodes: [level("gid://shopify/Location/1", 5)], pageInfo: { hasNextPage: false } },
                  },
                ],
                pageInfo: { hasNextPage: !last, endCursor: last ? null : "p2" },
              },
            },
            extensions: { cost: { requestedQueryCost: 300, throttleStatus: { maximumAvailable: 1000, currentlyAvailable: 100, restoreRate: 100 } } },
          }),
        );
      }),
    };
    const slept: number[] = [];
    const saved: unknown[] = [];
    const n = await syncStockNow(
      client,
      S,
      { throttleSleep: async (ms) => void slept.push(ms) },
      { cursor: "p1", startedAt: new Date(Date.now() - 60_000).toISOString() },
      async (r) => void saved.push(r.cursor),
    );
    expect(afters).toEqual(["p1", "p2"]); // resumed at p1, not page 1
    expect(saved).toEqual(["p2"]);
    expect(slept).toEqual([2000]); // 100 available < 300 next page cost → (300 − 100) ÷ 100 s
    expect(n).toBe(2);
    expect(db.tables.stockNow.map((r) => r.variantId).sort()).toEqual(["gid://shopify/ProductVariant/1", "gid://shopify/ProductVariant/2"]);
  });
});
