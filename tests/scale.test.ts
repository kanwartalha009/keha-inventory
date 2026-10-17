/**
 * Scale invariants (DB audit 2026-10-17, "before 100 stores"). Each block names the invariant it
 * guards; the heavy fixtures live in their own files:
 *  - #1 large months: tests/sync/large-month.test.ts (a 3.72 M-row stock month) — here: the
 *    row cap splits a SALES step into parts that are each read, reconciled and written alone.
 *  - #5 connections: an explicit Prisma pool; no `in` list past Postgres's 32,767 bind
 *    parameters on Products.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeDb } from "./helpers/fake-prisma";

vi.mock("../app/db.server", async () => {
  const { createFakePrisma } = await import("./helpers/fake-prisma");
  const db = createFakePrisma({ salesDaily: ["shop", "day", "variantId", "locationKey", "channel"] });
  return { default: db.client, __fake: db };
});

import * as dbModule from "../app/db.server";
import { DB_CONNECTION_LIMIT, DB_POOL_TIMEOUT_S, withPoolSettings } from "../app/lib/db-url-shared";
import { MAX_IN_IDS, listProducts } from "../app/models/products.server";
import { storeSales } from "../app/services/sync/facts.server";
import { addDays, type DayRange } from "../app/lib/sync/shopifyql-shared";
import type { ShopifyqlClient } from "../app/services/sync/shopifyql.server";
import { ShopifyqlRowCapError } from "../app/lib/sync/shopifyql-shared";

const db = (dbModule as unknown as { __fake: FakeDb }).__fake;
const S = "scale.myshopify.com";

beforeEach(() => {
  db.reset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("#1 the row cap splits a sales step; each part is reconciled and written on its own", () => {
  it("a month whose sales views are over the cap is stored in parts, every day once", async () => {
    const SEPT: DayRange = { since: "2026-09-01", until: "2026-09-30" };
    const reads: DayRange[] = [];
    const sold = (day: string) => 1 + (Number(day.slice(8)) % 3);
    const rowsFor = (r: DayRange, channel: boolean) => {
      const out = [];
      for (let d = r.since; d <= r.until; d = addDays(d, 1)) {
        out.push({ day: d, variantId: "gid://shopify/ProductVariant/1", locationKey: channel ? "all" : "online", channel: channel ? "Online Store" : "all", sold: sold(d), returned: 0, gross: sold(d) * 10 });
      }
      return out;
    };
    // Any read longer than 10 days is over the cap; rows are complete through day 10 of the range.
    const view = (channel: boolean) => async (r: DayRange) => {
      reads.push(r);
      const days = (Date.parse(r.until) - Date.parse(r.since)) / 86_400_000 + 1;
      if (days > 10) throw new ShopifyqlRowCapError(1000, 1001, addDays(r.since, 9));
      return { rows: rowsFor(r, channel), skipped: 0, missingColumns: [] };
    };
    const ql = {
      salesDailyByLocation: view(false),
      salesDailyByChannel: view(true),
      salesTotalsDaily: async (r: DayRange) => ({ rows: rowsFor(r, true).map((x) => ({ day: x.day, sold: x.sold })), skipped: 0, missingColumns: [] }),
    } as unknown as ShopifyqlClient;
    const r = await storeSales(S, ql, SEPT, "2026-10-16", []);
    expect(r.rows).toBe(60); // 30 days × 2 views
    const days = new Set((db.tables.salesDaily ?? []).map((x) => (x.day as Date).toISOString().slice(0, 10)));
    expect(days.size).toBe(30);
    // Parts: Sept 1–10, 11–20, 21–30 (each read once more after the capped read of the longer range).
    const deletes = db.calls.filter((c) => c.table === "salesDaily" && c.op === "deleteMany").map((c) => (c.args as { where: { day: { gte: Date; lte: Date } } }).where.day);
    expect(deletes.map((d) => [d.gte.toISOString().slice(0, 10), d.lte.toISOString().slice(0, 10)])).toEqual([
      ["2026-09-01", "2026-09-10"],
      ["2026-09-11", "2026-09-20"],
      ["2026-09-21", "2026-09-30"],
    ]);
  });
});

describe("#5 connections", () => {
  it("DATABASE_URL gets an explicit pool unless it sets one itself", () => {
    expect(withPoolSettings("postgresql://u:p@db:5432/app")).toBe(`postgresql://u:p@db:5432/app?connection_limit=${DB_CONNECTION_LIMIT}&pool_timeout=${DB_POOL_TIMEOUT_S}`);
    expect(withPoolSettings("postgres://db/app?sslmode=require")).toBe(`postgres://db/app?sslmode=require&connection_limit=${DB_CONNECTION_LIMIT}&pool_timeout=${DB_POOL_TIMEOUT_S}`);
    // PgBouncer: its own settings win, ours are only added where missing.
    expect(withPoolSettings("postgresql://db/app?pgbouncer=true&connection_limit=3")).toBe(`postgresql://db/app?pgbouncer=true&connection_limit=3&pool_timeout=${DB_POOL_TIMEOUT_S}`);
    expect(withPoolSettings("postgresql://db/app?connection_limit=5&pool_timeout=9")).toBe("postgresql://db/app?connection_limit=5&pool_timeout=9");
    expect(withPoolSettings(undefined)).toBeUndefined();
    expect(withPoolSettings("file:./dev.db")).toBe("file:./dev.db");
  });

  it("Products with a status filter matching more variants than an `in` list may carry: no statement past MAX_IN_IDS ids", async () => {
    const n = MAX_IN_IDS + 1;
    db.tables.shop = [{ domain: S, timezone: "UTC", settings: {} }];
    db.tables.location = [];
    db.tables.purchaseOrder = [];
    db.tables.stockNow = [];
    db.tables.variant = [];
    db.tables.variantMetric = [];
    for (let i = 0; i < n; i++) {
      const id = `gid://shopify/ProductVariant/${i}`;
      db.tables.variant.push({ id, shop: S, productId: `P${i}`, productTitle: `Product ${String(i).padStart(6, "0")}`, variantTitle: "", sku: null, vendor: null, image: null, tracked: true, isBundle: false, noReorder: false });
      db.tables.variantMetric.push({ shop: S, variantId: id, scope: "online", status: "healthy", rate: 1, daysLeft: 10, neverRunsOut: false, orderQty: null, orderBy: null });
    }
    const page = await listProducts(S, { status: "healthy" } as never, 2, false);
    expect(page.total).toBe(n);
    expect(page.rows[0].id).toBe(`gid://shopify/ProductVariant/${page.info.skip}`);
    const inSizes = db.calls.flatMap((c) => {
      const where = (c.args as { where?: { id?: { in?: unknown[] }; variantId?: { in?: unknown[] } } } | undefined)?.where;
      return [where?.id?.in?.length ?? 0, where?.variantId?.in?.length ?? 0];
    });
    expect(Math.max(...inSizes)).toBeLessThanOrEqual(MAX_IN_IDS);
  });
});
