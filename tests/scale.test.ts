/**
 * Scale invariants (DB audit 2026-10-17, "before 100 stores"). Each block names the invariant it
 * guards; the heavy fixtures live in their own files:
 *  - #1 large months: tests/sync/large-month.test.ts (a 3.72 M-row stock month) — here: the
 *    row cap splits a SALES step into parts that are each read, reconciled and written alone.
 *  - #2 scheduler: work is a Postgres job queue (FOR UPDATE SKIP LOCKED + a lease per shop): two
 *    instances never run one job twice nor two jobs of one shop at once; WORKER_MODE web | worker
 *    | all. The SQL against real Postgres (parallel sessions): tests/jobs-store.test.ts; the ticks
 *    and handlers: tests/scheduler-data.test.ts.
 *  - #3 no full-history scans: once a shop's stored first / last days are built, compute and
 *    per-location compute read StockDaily / SalesDaily only with a lower day bound (the windows
 *    they need) or as single-variant index lookups (findFirst) — never a variant's whole history.
 *    Equality with the facts-based results: tests/scale-compute-golden.test.ts; the sync keeping
 *    the days equal to a fresh scan: tests/fact-days.test.ts.
 *  - #4 compute in chunks: per-day facts are read for one chunk of variants at a time (whole
 *    products, COMPUTE_CHUNK = 2,000 variants), at most COMPUTE_QUERY_CONCURRENCY reads in flight,
 *    and the event loop runs between chunks. Same rows written for every chunk size:
 *    tests/scale-compute-golden.test.ts.
 *  - #5 connections: an explicit Prisma pool; no `in` list past Postgres's 32,767 bind
 *    parameters on Products.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeDb } from "./helpers/fake-prisma";

vi.mock("../app/db.server", async () => {
  const { createFakePrisma } = await import("./helpers/fake-prisma");
  const db = createFakePrisma({ variantMetric: ["shop", "variantId", "scope"], moneyAtStake: ["shop", "day"], action: ["shop", "dedupeKey"] });
  return { default: db.client, __fake: db };
});
vi.mock("../app/services/entitlements.server", () => ({ planFor: async () => "pro" }));

import * as dbModule from "../app/db.server";
import { useFakeFacts } from "./helpers/fake-facts";
import { DB_CONNECTION_LIMIT, DB_POOL_TIMEOUT_S, withPoolSettings } from "../app/lib/db-url-shared";
import { MAX_IN_IDS, listProducts } from "../app/models/products.server";
import { storeSales } from "../app/services/sync/facts.server";
import { addDays, type DayRange } from "../app/lib/sync/shopifyql-shared";
import type { ShopifyqlClient } from "../app/services/sync/shopifyql.server";
import { ShopifyqlRowCapError } from "../app/lib/sync/shopifyql-shared";
import { PACE_LOOKBACK_DAYS } from "../app/lib/engine/rate-shared";
import { COMPUTE_QUERY_CONCURRENCY, computeShop, productChunks } from "../app/services/compute.server";
import { matches, type Row } from "./helpers/fake-prisma";
import { createMemoryJobStore } from "./helpers/memory-job-store";
import { setJobStore } from "../app/services/jobs/queue.server";
import { startWorkers } from "../app/services/jobs/worker.server";
import { FX_NOW, FX_SHOP, seedScaleFixture } from "./fixtures/scale-compute-fixture";

const db = (dbModule as unknown as { __fake: FakeDb }).__fake;
useFakeFacts(db);
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

describe("#2 two instances share the queue", () => {
  it("every job runs once; a shop's jobs one at a time; both instances work", async () => {
    const store = createMemoryJobStore();
    setJobStore(store);
    try {
      const shops = Array.from({ length: 8 }, (_, i) => `s${i}.myshopify.com`);
      for (const s of shops) for (const k of ["backfill", "compute", "alerts"] as const) await store.enqueue(s, k);
      const ran: string[] = [];
      const busy = new Set<string>();
      const by = { a: 0, b: 0 };
      const handler = (who: "a" | "b") => async (j: { shop: string; kind: string }) => {
        expect(busy.has(j.shop)).toBe(false);
        busy.add(j.shop);
        await new Promise((r) => setTimeout(r, 2));
        busy.delete(j.shop);
        ran.push(`${j.kind}:${j.shop}`);
        by[who]++;
        return "done";
      };
      const h = (who: "a" | "b") => ({ backfill: handler(who), nightly: handler(who), compute: handler(who), alerts: handler(who), maintenance: handler(who), recheck: handler(who) });
      // Two "instances": two worker pools on one queue (their owners differ).
      const a = startWorkers(h("a"), { count: 2, pollMs: 2 });
      const b = startWorkers(h("b"), { count: 2, pollMs: 2 });
      await vi.waitFor(() => expect(ran).toHaveLength(24), { timeout: 5000 });
      await Promise.all([a.stop(), b.stop()]);
      expect(new Set(ran).size).toBe(24);
      expect(by.a).toBeGreaterThan(0);
      expect(by.b).toBeGreaterThan(0);
    } finally {
      setJobStore(null);
    }
  });
});

describe("#3 compute never reads a variant's whole history once the stored days are built", () => {
  /**
   * Fact reads without a lower day bound (a variant's whole history) and the rows Postgres walks
   * for them: every row of the read's shop (and variants, when listed) — the index prefix
   * (shop, variantId, day); filters on other columns do not shorten the walk.
   */
  function fullHistoryReads(snapshot: Record<string, Row[]>) {
    const reads = db.calls.filter((c) => (c.table === "salesDaily" || c.table === "stockDaily") && (c.op === "groupBy" || c.op === "findMany" || c.op === "aggregate"));
    const unbounded = reads.filter((c) => {
      const day = (c.args as { where?: { day?: Record<string, unknown> } }).where?.day;
      return !day || !("gte" in day || "in" in day || "gt" in day);
    });
    const walked = unbounded.reduce((a, c) => {
      const w = (c.args as { where: Row }).where;
      return a + (snapshot[c.table] ?? []).filter((r) => matches(r, { shop: w.shop, ...(w.variantId ? { variantId: w.variantId } : {}) })).length;
    }, 0);
    return { reads: reads.length, unbounded: unbounded.length, walked };
  }

  it("before (facts): whole-history groupBys over every row; after (stored days): bounded windows and index lookups only", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    seedScaleFixture(db, {});
    const snapshot = { salesDaily: [...db.tables.salesDaily], stockDaily: [...db.tables.stockDaily] };
    db.calls.length = 0;
    await computeShop(FX_SHOP, { now: () => FX_NOW, buildDays: false });
    const before = fullHistoryReads(snapshot);
    expect(before.unbounded).toBeGreaterThan(0);

    seedScaleFixture(db, {});
    await computeShop(FX_SHOP, { now: () => FX_NOW }); // builds the days once
    db.calls.length = 0;
    await computeShop(FX_SHOP, { now: () => FX_NOW });
    const after = fullHistoryReads(snapshot);
    const lookups = db.calls.filter((c) => (c.table === "salesDaily" || c.table === "stockDaily") && c.op === "findFirst").length;
    // What is left unbounded is the lazy fill of null Variant columns: variants with no fact rows
    // (never sold), so Postgres walks nothing for them.
    expect(after.walked).toBe(0);
    expect(before.walked).toBeGreaterThan(50_000);
    console.info(`[scale] compute on the 30-variant fixture: before ${before.unbounded} whole-history reads walking ${before.walked} fact rows; after ${after.unbounded} walking ${after.walked} (${after.reads} fact reads in all, ${lookups} single-variant index lookups)`);
  }, 60_000);
});

describe("#4 compute in chunks", () => {
  it("chunks hold whole products, in catalogue order, at most the chunk size (a bigger product alone)", () => {
    const plans = ["A", "B", "A", "C", "C", "C", "D", "B"].map((productId, i) => ({ v: { productId, id: String(i) } }));
    expect(productChunks(plans, 3).map((c) => c.map((p) => `${p.v.productId}${p.v.id}`))).toEqual([["A0", "A2"], ["B1", "B7"], ["C3", "C4", "C5"], ["D6"]]);
    expect(productChunks(plans, 2).map((c) => c.length)).toEqual([2, 2, 3, 1]);
    expect(productChunks(plans, 100)).toHaveLength(1);
  });

  it("per-day reads cover one chunk at a time, few in flight, and the event loop runs between chunks", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    seedScaleFixture(db, {});
    const client = db.client as Record<string, Record<string, (...a: unknown[]) => Promise<unknown>>>;
    const perDay: number[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const reals: Record<string, (...a: unknown[]) => Promise<unknown>> = {};
    for (const table of ["salesDaily", "stockDaily"]) {
      const real = (reals[table] = client[table].groupBy);
      client[table].groupBy = async (args: unknown) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 1)); // a real query takes time: lets reads overlap
        const rows = (await real(args)) as unknown[];
        inFlight--;
        if ((args as { by: string[] }).by.includes("day") && (args as { where: { variantId?: unknown } }).where.variantId) perDay.push(rows.length);
        return rows;
      };
    }
    const chunkSize = 6;
    const run = await computeShop(FX_SHOP, { now: () => FX_NOW, chunkSize, buildDays: false });
    for (const table of ["salesDaily", "stockDaily"]) client[table].groupBy = reals[table];
    expect(run.variants).toBe(30);
    // Each per-day read holds at most one chunk: ≤ chunkSize + a product's other variants, × the days
    // read × channels — the 90 days, or the 14 months before them (forecast quality 2026-10-17: the
    // spike cap's one-off rule and the forecast-error backtest read them for every variant).
    expect(Math.max(...perDay)).toBeLessThanOrEqual((chunkSize + 2) * (PACE_LOOKBACK_DAYS - 90) * 2);
    // The chunk's reads are capped; a read may itself run two (poolDays' facts fallback).
    expect(maxInFlight).toBeLessThanOrEqual(COMPUTE_QUERY_CONCURRENCY + 1);
    console.info(`[scale] compute in chunks of ${chunkSize}: ${perDay.length} per-day reads, largest ${Math.max(...perDay)} rows; ${maxInFlight} reads in flight at most`);
  }, 60_000);

  it("the event loop gets a turn between chunks (other requests are not blocked for the whole run)", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const turnsFor = async (chunkSize: number) => {
      seedScaleFixture(db, {});
      let turns = 0;
      let live = true;
      const tick = () => {
        turns++;
        if (live) setImmediate(tick);
      };
      setImmediate(tick);
      await computeShop(FX_SHOP, { now: () => FX_NOW, chunkSize, buildDays: false });
      live = false;
      return turns;
    };
    // The in-memory fake answers without I/O, so every turn comes from compute yielding.
    const one = await turnsFor(2000);
    const many = await turnsFor(3);
    expect(many - one).toBeGreaterThanOrEqual(Math.ceil(30 / 3) - 1);
  }, 60_000);
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
