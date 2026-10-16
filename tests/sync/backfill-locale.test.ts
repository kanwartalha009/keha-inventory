/**
 * Production bug 2026-10-17 (Railway): "[sync/backfill] …: shop read failed (unknown)
 * GraphqlQueryError: Access denied for shopLocales field. Required access: read_locales …".
 * The shop read asked for shopLocales in the same query, so a store without `read_locales`
 * never started its backfill. Now the language is a separate read that falls back to "en":
 * the real ensureShop runs here against an Admin client that denies shopLocales, and the
 * backfill must read the shop (currency, time zone) and go on to the products pass.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeDb } from "../helpers/fake-prisma";
import type { AdminGraphqlClient } from "../../app/models/shop.server";
import type { ShopifyqlClient } from "../../app/services/sync/shopifyql.server";

vi.mock("../../app/db.server", async () => {
  const { createFakePrisma } = await import("../helpers/fake-prisma");
  const db = createFakePrisma({ shop: ["domain"] });
  return { default: db.client, __fake: db };
});

const cat = vi.hoisted(() => ({
  syncCatalog: vi.fn(async () => ({ variants: 1, products: 1, malformed: 0, orphans: 0, removed: 0 })),
  syncLocations: vi.fn(async () => []),
  syncStockNow: vi.fn(async () => 1),
}));
// The real ensureShop (and gql) — only the heavy catalog passes are faked.
vi.mock("../../app/services/sync/catalog.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../app/services/sync/catalog.server")>()),
  ...cat,
}));

import * as dbModule from "../../app/db.server";
import { runBackfill } from "../../app/services/sync/backfill.server";
import { readBackfillState } from "../../app/lib/sync/backfill-shared";

const db = (dbModule as unknown as { __fake: FakeDb }).__fake;
const S = "dev-novasolutions.myshopify.com";
const DENIED =
  "Access denied for shopLocales field. Required access: `read_locales` access scope or `read_markets_home` access scope.";

/** What @shopify/shopify-api throws for a GraphQL error response. */
class GraphqlQueryError extends Error {
  constructor(message: string, readonly body: unknown) {
    super(message);
    this.name = "GraphqlQueryError";
  }
}

function adminWithoutLocales(): { client: AdminGraphqlClient; queries: string[] } {
  const queries: string[] = [];
  return {
    queries,
    client: {
      graphql: async (query) => {
        queries.push(query);
        if (query.includes("shopLocales")) {
          throw new GraphqlQueryError(`GraphQL Client: ${DENIED}`, {
            errors: [{ message: DENIED, extensions: { code: "ACCESS_DENIED" } }],
          });
        }
        if (query.includes("KehaInvShopInfo")) {
          return new Response(
            JSON.stringify({ data: { shop: { name: "Nova", currencyCode: "AED", ianaTimezone: "Asia/Dubai", myshopifyDomain: S } } }),
            { status: 200 },
          );
        }
        throw new Error(`unexpected query: ${query.slice(0, 60)}`);
      },
    },
  };
}

const unusedQl = {} as ShopifyqlClient;

beforeEach(() => {
  db.reset();
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("backfill on a store without read_locales", () => {
  it("reads the shop, stores English, and runs the products pass", async () => {
    const a = adminWithoutLocales();
    const outcome = await runBackfill(S, {
      getAdmin: async () => a.client,
      shopifyql: () => unusedQl,
      now: () => Date.parse("2026-10-16T22:00:00Z"), // 02:00 on the 17th in Dubai, still the 16th in UTC
      sleep: async () => {},
      maxSteps: 1,
    });

    expect(outcome).toBe("progress");
    expect(console.error).not.toHaveBeenCalled();
    expect(a.queries.some((q) => q.includes("KehaInvShopInfo") && !q.includes("shopLocales"))).toBe(true);
    expect(db.tables.shop).toHaveLength(1);
    expect(db.tables.shop[0]).toMatchObject({ domain: S, currency: "AED", timezone: "Asia/Dubai", locale: "en" });
    const state = readBackfillState(db.tables.shop[0].backfillState);
    expect(state.startedAt).toBeTruthy();
    expect(state.range?.until).toBe("2026-10-16"); // yesterday in Asia/Dubai (UTC would give the 15th)
    expect(cat.syncCatalog).toHaveBeenCalledTimes(1);
    expect(cat.syncLocations).toHaveBeenCalledTimes(1);
    expect(cat.syncStockNow).toHaveBeenCalledTimes(1);
  });
});
