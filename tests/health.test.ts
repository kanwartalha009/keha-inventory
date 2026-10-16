/**
 * /health (spec §17, task 1.2b): kit fields kept; sync freshness and backfill % over
 * installed shops, the most recent dataset error, the ShopifyQL budget snapshot, and the
 * compute status. Prisma is the in-memory fake.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeDb } from "./helpers/fake-prisma";

// health.tsx reads prisma.novaOutbox at import time, so the fake must exist inside the factory.
vi.mock("../app/db.server", async () => {
  const { createFakePrisma: make } = await import("./helpers/fake-prisma");
  const db = make();
  return { default: db.client, __fake: db };
});
vi.mock("../app/services/scheduler.server", () => ({
  schedulerHeartbeat: () => ({ started: false, lastOutboxTickAt: null, lastHourlyTickAt: null, lastDataTickAt: null }),
}));
vi.mock("../app/services/app-pricing.server", () => ({ pricingStatus: () => ({ configured: false }) }));

import { loader } from "../app/routes/health";
import { createShopifyqlClient, resetShopifyqlBudget } from "../app/services/sync/shopifyql.server";
import * as dbModule from "../app/db.server";

const db = (dbModule as unknown as { __fake: FakeDb }).__fake;

async function health() {
  const res = await loader();
  return { status: res.status, body: (await res.json()) as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

beforeEach(() => {
  db.reset();
  resetShopifyqlBudget();
});

describe("/health", () => {
  it("keeps the kit fields and reports empty sync / compute on a fresh install", async () => {
    const { status, body } = await health();
    expect(status).toBe(200);
    expect(body).toMatchObject({ status: "ok", db: "ok", outbox: { pending: 0, dead: 0 } });
    expect(body.pricing).toEqual({ configured: false });
    expect(body.config).toBeDefined();
    expect(body.sync).toEqual({ lastNightlyAt: null, backfillPct: null, lastError: null, lastErrorAt: null });
    expect(body.shopifyqlBudget).toEqual({ lastCost: null, lastRemaining: null, lastAt: null });
    expect(body.compute).toEqual({ lastAt: null, shopsComputed: 0 });
  });

  it("reports freshness over installed shops only, and the most recent error", async () => {
    db.tables.shop = [
      {
        domain: "a.myshopify.com",
        uninstalledAt: null,
        lastNightlyAt: new Date("2026-10-15T03:10:00Z"),
        backfillState: {
          datasets: {
            products: { done: 1, total: 1 },
            stock: { done: 13, total: 13 },
            sales: { done: 13, total: 13, lastError: "old error", lastErrorAt: "2026-10-01T00:00:00Z" },
            visits: { done: 13, total: 13 },
          },
        },
      },
      {
        domain: "b.myshopify.com",
        uninstalledAt: null,
        lastNightlyAt: null,
        backfillState: {
          datasets: {
            products: { done: 1, total: 1 },
            stock: { done: 0, total: 13, lastError: "ShopifyQL still throttled after 5 attempts", lastErrorAt: "2026-10-16T09:00:00Z" },
          },
        },
      },
      {
        domain: "gone.myshopify.com",
        uninstalledAt: new Date("2026-10-10T00:00:00Z"),
        lastNightlyAt: new Date("2026-10-16T03:00:00Z"),
        backfillState: {},
      },
    ];
    const { body } = await health();
    expect(body.sync).toEqual({
      lastNightlyAt: "2026-10-15T03:10:00.000Z",
      backfillPct: 63, // a: 100, b: (100 + 0 + 0 + 0) / 4 = 25 → (100 + 25) / 2 = 62.5 → 63
      lastError: "ShopifyQL still throttled after 5 attempts",
      lastErrorAt: "2026-10-16T09:00:00Z",
    });
  });

  it("reports the last ShopifyQL budget seen", async () => {
    const client = createShopifyqlClient({
      graphql: async () =>
        new Response(
          JSON.stringify({
            data: { shopifyqlQuery: { tableData: { columns: [], rows: [] }, parseErrors: [] } },
            extensions: { shopifyqlCost: { requestedQueryCost: 12, maximumAvailable: 1000, currentlyAvailable: 988, windowResetAt: null } },
          }),
        ),
    });
    await client.run("FROM sales SHOW orders");
    const { body } = await health();
    expect(body.shopifyqlBudget).toMatchObject({ lastCost: 12, lastRemaining: 988 });
  });

  it("reports the last compute and shops with money cards in the last 36 h", async () => {
    const now = Date.now();
    const day = (msAgo: number) => {
      const d = new Date(now - msAgo);
      return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    };
    db.tables.variantMetric = [
      { shop: "a", variantId: "v1", scope: "online", computedAt: new Date("2026-10-16T03:20:00Z") },
      { shop: "a", variantId: "v2", scope: "online", computedAt: new Date("2026-10-16T03:21:00Z") },
    ];
    db.tables.moneyAtStake = [
      { shop: "a", day: day(0) },
      { shop: "a", day: day(24 * 3600e3) },
      { shop: "b", day: day(12 * 3600e3) },
      { shop: "c", day: day(5 * 24 * 3600e3) },
    ];
    const { body } = await health();
    expect(body.compute).toEqual({ lastAt: "2026-10-16T03:21:00.000Z", shopsComputed: 2 });
  });
});
