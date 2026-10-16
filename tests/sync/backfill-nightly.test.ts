/**
 * Backfill and nightly services (task 1.4b) on an in-memory Prisma with a fake ShopifyQL
 * client: 13 months newest first, durable resumable state, throttle → stop → resume to the
 * same rows, never today, POS names → Location ids, nightly once per store-local day after
 * 03:00 and only after the backfill, catch-up range, retention.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeDb } from "../helpers/fake-prisma";
import type { ShopifyqlClient } from "../../app/services/sync/shopifyql.server";
import { createSleepBudget } from "../../app/lib/sync/budget-shared";
import {
  ShopifyqlParseError,
  ShopifyqlThrottledError,
  addDays,
  assertPastRange,
  type DayRange,
  type ParseResult,
} from "../../app/lib/sync/shopifyql-shared";

vi.mock("../../app/db.server", async () => {
  const { createFakePrisma } = await import("../helpers/fake-prisma");
  const db = createFakePrisma({
    shop: ["domain"],
    stockDaily: ["shop", "day", "variantId", "locationId"],
    salesDaily: ["shop", "day", "variantId", "locationKey", "channel"],
    sessionsDaily: ["shop", "day", "landingPath", "trafficType"],
    shopDaily: ["shop", "day"],
  });
  return { default: db.client, __fake: db };
});

const cat = vi.hoisted(() => ({
  ensureShop: vi.fn(),
  syncCatalog: vi.fn(async () => ({ variants: 1, products: 1, malformed: 0, orphans: 0, removed: 0 })),
  syncLocations: vi.fn(async () => []),
  syncStockNow: vi.fn(async () => 1),
}));
vi.mock("../../app/services/sync/catalog.server", () => cat);

import * as dbModule from "../../app/db.server";
import { runBackfill, withShopLock, type DataJobDeps } from "../../app/services/sync/backfill.server";
import { nightlyRange, runNightly } from "../../app/services/sync/nightly.server";
import { readBackfillState } from "../../app/lib/sync/backfill-shared";

const db = (dbModule as unknown as { __fake: FakeDb }).__fake;
const S = "acme.myshopify.com";
const TZ = "Europe/Madrid";
const V = "gid://shopify/ProductVariant/1";
const NOW = Date.parse("2026-10-16T08:00:00Z"); // 10:00 in Madrid; today 2026-10-16

function days(r: DayRange): string[] {
  const out: string[] = [];
  for (let d = r.since; d <= r.until; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Fake ShopifyQL: one variant, rows for every day; records every call; can throw on call #n. */
function fakeQl(opts: { throttleOnCall?: number } = {}) {
  const calls: { kind: string; range: DayRange; today: string }[] = [];
  const res = <T>(rows: T[], missing: string[]): ParseResult<T> => ({ rows, skipped: 0, missingColumns: missing });
  const guard = (kind: string, range: DayRange, today: string) => {
    assertPastRange(range, today); // the real builders refuse today too (I-12)
    calls.push({ kind, range, today });
    if (opts.throttleOnCall && calls.length === opts.throttleOnCall) throw new ShopifyqlThrottledError(5);
  };
  const ql: ShopifyqlClient = {
    run: async () => {
      throw new Error("not used");
    },
    salesDaily: async () => {
      throw new Error("3-dimension query must not be used yet");
    },
    stockDaily: async (r, t) => {
      guard("stock", r, t);
      return res(
        days(r).flatMap((day) => [
          { day, variantId: V, locationName: "Warehouse", endUnits: 10, outOfStock: false },
          { day, variantId: V, locationName: "Madrid Store", endUnits: 0, outOfStock: true },
        ]),
        [],
      );
    },
    salesDailyByLocation: async (r, t) => {
      guard("salesByLocation", r, t);
      return res(
        days(r).flatMap((day) => [
          { day, variantId: V, locationKey: "online", channel: "unknown", sold: 2, gross: 0, returned: 0 },
          { day, variantId: V, locationKey: "Madrid Store", channel: "unknown", sold: 1, gross: 0, returned: 0 },
        ]),
        ["sales_channel", "gross_sales", "quantity_returned"],
      );
    },
    salesDailyByChannel: async (r, t) => {
      guard("salesByChannel", r, t);
      return res(
        days(r).map((day) => ({ day, variantId: V, locationKey: "unknown", channel: "Online Store", sold: 3, gross: 75, returned: 0 })),
        ["pos_location_name", "quantity_returned"],
      );
    },
    sessionsDaily: async (r, t) => {
      guard("sessions", r, t);
      return res(days(r).map((day) => ({ day, landingPath: "/products/tee", trafficType: "google", sessions: 10, checkouts: 1 })), []);
    },
    shopDaily: async (r, t) => {
      guard("shopDaily", r, t);
      return res(days(r).map((day) => ({ day, orders: 4, gross: 200 })), []);
    },
  };
  return { ql, calls };
}

function deps(ql: ShopifyqlClient, extra: Partial<DataJobDeps> = {}): DataJobDeps {
  return { getAdmin: async () => ({ graphql: vi.fn() }), shopifyql: () => ql, now: () => NOW, sleep: async () => {}, ...extra };
}

const iso = (d: unknown) => (d as Date).toISOString().slice(0, 10);

beforeEach(() => {
  db.reset();
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  cat.ensureShop.mockImplementation(async () => {
    const existing = db.tables.shop?.find((s) => s.domain === S);
    if (!existing) (db.tables.shop ??= []).push({ domain: S, timezone: TZ, currency: "EUR", locale: "es", backfillState: {}, uninstalledAt: null, lastNightlyAt: null });
    return { name: "Acme", currency: "EUR", timezone: TZ, locale: "es", myshopifyDomain: S };
  });
  db.tables.location = [
    { id: "gid://shopify/Location/1", shop: S, name: "Warehouse", active: true, online: true },
    { id: "gid://shopify/Location/2", shop: S, name: "Madrid Store", active: true, online: false },
  ];
});

const state = () => readBackfillState(db.tables.shop[0].backfillState);

describe("runBackfill", () => {
  it("reads products, then 13 months newest first, and finishes with yesterday as syncedThrough", async () => {
    const { ql, calls } = fakeQl();
    const afterSync = vi.fn(async () => {});
    expect(await runBackfill(S, deps(ql, { afterSync }))).toBe("done");

    expect(cat.syncCatalog).toHaveBeenCalledTimes(1);
    expect(cat.syncLocations).toHaveBeenCalledTimes(1);
    expect(cat.syncStockNow).toHaveBeenCalledTimes(1);
    const stockRanges = calls.filter((c) => c.kind === "stock").map((c) => c.range);
    expect(stockRanges).toHaveLength(13);
    expect(stockRanges[0]).toEqual({ since: "2026-10-01", until: "2026-10-15" });
    expect(stockRanges[12]).toEqual({ since: "2025-10-01", until: "2025-10-31" });
    expect(calls.every((c) => c.today === "2026-10-16")).toBe(true);
    expect(calls.some((c) => c.kind === "salesDaily")).toBe(false);

    const s = state();
    expect(s).toMatchObject({ first90Ready: true, syncedThrough: "2026-10-15", range: { from: "2025-10-01", until: "2026-10-15" } });
    expect(s.finishedAt).toBeTruthy();
    expect(s.datasets?.visits).toMatchObject({ done: 13, total: 13, doneThrough: "2025-10-01" });
    expect(s.datasets?.totals).toMatchObject({ done: 13, total: 13 });
    // Compute once when first90Ready flipped (early numbers), once when finished.
    expect(afterSync).toHaveBeenCalledTimes(2);

    const nDays = 380; // 2025-10-01 … 2026-10-15
    expect(db.tables.stockDaily).toHaveLength(nDays * 2);
    expect(db.tables.salesDaily).toHaveLength(nDays * 3); // online + Madrid (location view) + Online Store (channel view)
    expect(db.tables.sessionsDaily).toHaveLength(nDays);
    expect(db.tables.shopDaily).toHaveLength(nDays);
    for (const t of ["stockDaily", "salesDaily", "sessionsDaily", "shopDaily"]) {
      expect(db.tables[t].every((r) => iso(r.day) < "2026-10-16"), t).toBe(true);
    }
    expect(new Set(db.tables.salesDaily.map((r) => `${r.locationKey}|${r.channel}`))).toEqual(
      new Set(["online|all", "gid://shopify/Location/2|all", "all|Online Store"]),
    );
    expect(db.tables.stockDaily.find((r) => r.locationId === "gid://shopify/Location/2")?.outOfStock).toBe(true);

    // A finished backfill is a no-op.
    expect(await runBackfill(S, deps(ql))).toBe("done");
    expect(cat.syncCatalog).toHaveBeenCalledTimes(1);
  });

  it("stops on a throttle with durable progress, then resumes to exactly the same rows", async () => {
    const reference = fakeQl();
    await runBackfill(S, deps(reference.ql));
    const snapshot = (t: string) =>
      db.tables[t].map((r) => JSON.stringify({ ...r, day: iso(r.day) })).sort();
    const want = Object.fromEntries(["stockDaily", "salesDaily", "sessionsDaily", "shopDaily"].map((t) => [t, snapshot(t)]));

    db.reset();
    db.tables.location = [
      { id: "gid://shopify/Location/1", shop: S, name: "Warehouse", active: true, online: true },
      { id: "gid://shopify/Location/2", shop: S, name: "Madrid Store", active: true, online: false },
    ];
    // Per month: stock(1), sales by location + by channel (2), visits(1), totals(1).
    const first = fakeQl({ throttleOnCall: 9 }); // month 2: stock(6), sales(7–8), visits(9)
    expect(await runBackfill(S, deps(first.ql))).toBe("throttled");
    const s = state();
    expect(s.finishedAt).toBeUndefined();
    expect(s.datasets?.stock?.done).toBe(2);
    expect(s.datasets?.sales?.done).toBe(2);
    expect(s.datasets?.visits).toMatchObject({ done: 1, attempts: 0, lastErrorCode: "throttled", lastError: expect.stringContaining("throttled") });

    const second = fakeQl();
    expect(await runBackfill(S, deps(second.ql))).toBe("done");
    expect(second.calls[0]).toMatchObject({ kind: "sessions", range: { since: "2026-09-01" } });
    expect(cat.syncCatalog).toHaveBeenCalledTimes(2); // once per full backfill, not again on resume
    for (const t of Object.keys(want)) expect(snapshot(t), t).toEqual(want[t]);
    expect(state().datasets?.visits?.lastError).toBeNull();
  });

  it("review H3: a failing dataset never blocks the others; its month is skipped after 5 runs", async () => {
    const { ql } = fakeQl();
    const broken: ShopifyqlClient = {
      ...ql,
      stockDaily: async () => {
        throw new ShopifyqlParseError(["bad column"], "q");
      },
    };
    expect(await runBackfill(S, deps(broken))).toBe("error");
    let s = state();
    expect(s.datasets?.stock).toMatchObject({ done: 0, attempts: 1, lastErrorCode: "shopifyql_parse" });
    expect(s.datasets?.sales?.done).toBe(13);
    expect(s.datasets?.visits?.done).toBe(13);
    expect(s.datasets?.totals?.done).toBe(13);
    expect(s.first90Ready).toBeUndefined(); // needs stock too
    for (let run = 2; run <= 5; run++) await runBackfill(S, deps(broken));
    s = state();
    expect(s.datasets?.stock).toMatchObject({ done: 1, attempts: 0, degraded: true, skippedMonths: ["2026-10-01"] });
    expect(s.finishedAt).toBeUndefined();
  });

  it("review H5: a throttled stock-now pass resumes at its saved cursor without re-running the catalog", async () => {
    const { ql } = fakeQl();
    cat.syncStockNow.mockImplementationOnce(async (...args: unknown[]) => {
      const onPage = args[4] as (r: { cursor: string; startedAt: string }) => Promise<void>;
      await onPage({ cursor: "page-7", startedAt: "2026-10-16T07:59:00.000Z" });
      const e = new Error("Admin API still throttled after 5 attempts");
      e.name = "AdminThrottledError";
      throw e;
    });
    expect(await runBackfill(S, deps(ql))).toBe("throttled");
    expect(state().datasets?.products).toMatchObject({ stage: "stock", cursor: "page-7", cursorStartedAt: "2026-10-16T07:59:00.000Z", lastErrorCode: "throttled", attempts: 0 });
    expect(cat.syncCatalog).toHaveBeenCalledTimes(1);

    expect(await runBackfill(S, deps(ql))).toBe("done");
    expect(cat.syncCatalog).toHaveBeenCalledTimes(1); // not re-run
    expect(cat.syncLocations).toHaveBeenCalledTimes(1);
    expect((cat.syncStockNow.mock.calls[1] as unknown[])[3]).toEqual({ cursor: "page-7", startedAt: "2026-10-16T07:59:00.000Z" });
    expect(state().datasets?.products).toMatchObject({ done: 1, stage: null, cursor: null });
  });

  it("per-tick step cap: at most maxSteps steps, then 'progress'", async () => {
    const { ql, calls } = fakeQl();
    expect(await runBackfill(S, deps(ql, { maxSteps: 6 }))).toBe("progress");
    const s = state();
    expect(s.datasets?.products?.done).toBe(1);
    expect([s.datasets?.stock?.done, s.datasets?.sales?.done, s.datasets?.visits?.done, s.datasets?.totals?.done]).toEqual([2, 1, 1, 1]);
    expect(calls.filter((c) => c.kind === "stock")).toHaveLength(2);
  });

  it("compute runs as soon as first90Ready flips, before the backfill is finished (spec J1)", async () => {
    const { ql } = fakeQl();
    const seen: Array<{ ready: boolean; finished: boolean; visits: number }> = [];
    const afterSync = vi.fn(async () => {
      const st = state();
      seen.push({ ready: !!st.first90Ready, finished: !!st.finishedAt, visits: st.datasets?.visits?.done ?? 0 });
    });
    await runBackfill(S, deps(ql, { maxSteps: 12, afterSync }));
    expect(seen).toEqual([{ ready: true, finished: false, visits: 2 }]); // after sales of month 3
  });

  it("review H4: a throttle longer than the tick's wait budget stops the run instead of sleeping", async () => {
    const slept: number[] = [];
    const budget = createSleepBudget(async (ms) => void slept.push(ms), 30_000);
    const reset = new Date(NOW + 90_000).toISOString();
    const admin = {
      graphql: vi.fn(async () =>
        new Response(JSON.stringify({ errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }], extensions: { shopifyqlCost: { requestedQueryCost: 10, maximumAvailable: 1000, currentlyAvailable: 0, windowResetAt: reset } } }), {
          status: 200,
        }),
      ),
    };
    const outcome = await runBackfill(S, { getAdmin: async () => admin, now: () => NOW, sleep: async () => {}, throttleSleep: budget.sleep });
    expect(outcome).toBe("throttled");
    expect(slept).toEqual([]); // a 90 s wait never started
    expect(state().datasets?.stock).toMatchObject({ done: 0, attempts: 0, lastErrorCode: "throttled" });
  });

  it("re-running the same month replaces rows instead of duplicating them", async () => {
    const { ql } = fakeQl();
    await runBackfill(S, deps(ql, { maxSteps: 2 })); // products + stock of the newest month
    const before = db.tables.stockDaily.length;
    const st = readBackfillState(db.tables.shop[0].backfillState);
    db.tables.shop[0].backfillState = { ...st, datasets: { ...st.datasets, stock: { done: 0, total: 13 } } };
    await runBackfill(S, deps(ql, { maxSteps: 1 }));
    expect(db.tables.stockDaily.length).toBe(before);
  });

  it("skips an uninstalled shop and never throws when the shop read fails", async () => {
    const { ql } = fakeQl();
    db.tables.shop = [{ domain: S, timezone: TZ, backfillState: {}, uninstalledAt: new Date() }];
    expect(await runBackfill(S, deps(ql))).toBe("skipped");
    cat.ensureShop.mockRejectedValueOnce(new Error("401"));
    expect(await runBackfill(S, deps(ql))).toBe("error");
  });

  it("withShopLock refuses a second concurrent run for the same shop", async () => {
    let release!: () => void;
    const p = withShopLock(S, () => new Promise<string>((r) => (release = () => r("ok"))));
    expect(await withShopLock(S, async () => "second")).toBe("busy");
    release();
    expect(await p).toBe("ok");
    expect(await withShopLock(S, async () => "third")).toBe("third");
  });
});

describe("runNightly", () => {
  async function finishedShop() {
    const { ql } = fakeQl();
    await runBackfill(S, deps(ql));
    vi.clearAllMocks();
  }

  it("does nothing until the backfill has finished", async () => {
    const { ql } = fakeQl();
    db.tables.shop = [{ domain: S, timezone: TZ, backfillState: { datasets: {} }, uninstalledAt: null, lastNightlyAt: null }];
    expect(await runNightly(S, deps(ql, { now: () => Date.parse("2026-10-17T02:00:00Z") }))).toBe("skipped");
  });

  it("waits for 03:00 store-local, runs once per local day, and continues from syncedThrough", async () => {
    await finishedShop();
    const { ql, calls } = fakeQl();
    const afterSync = vi.fn(async () => {});
    // 17 Oct 00:30Z = 02:30 in Madrid: not yet.
    expect(await runNightly(S, deps(ql, { now: () => Date.parse("2026-10-17T00:30:00Z"), afterSync }))).toBe("not_due");
    // 17 Oct 01:10Z = 03:10 in Madrid.
    const at = Date.parse("2026-10-17T01:10:00Z");
    expect(await runNightly(S, deps(ql, { now: () => at, afterSync }))).toBe("done");
    expect(calls.map((c) => c.range)).toEqual(Array(5).fill({ since: "2026-10-16", until: "2026-10-16" }));
    expect(cat.syncLocations).toHaveBeenCalledTimes(1);
    expect(cat.syncCatalog).toHaveBeenCalledTimes(1);
    expect(cat.syncStockNow).toHaveBeenCalledTimes(1);
    expect(afterSync).toHaveBeenCalledTimes(1);
    expect((db.tables.shop[0].lastNightlyAt as Date).getTime()).toBe(at);
    expect(state().syncedThrough).toBe("2026-10-16");
    expect(db.tables.stockDaily.every((r) => iso(r.day) <= "2026-10-16")).toBe(true);

    expect(await runNightly(S, deps(ql, { now: () => Date.parse("2026-10-17T20:00:00Z") }))).toBe("not_due");
  });

  it("a throttled night keeps lastNightlyAt unset so the next tick retries", async () => {
    await finishedShop();
    const { ql } = fakeQl({ throttleOnCall: 1 });
    expect(await runNightly(S, deps(ql, { now: () => Date.parse("2026-10-17T01:10:00Z") }))).toBe("throttled");
    expect(db.tables.shop[0].lastNightlyAt).toBeNull();
    expect(state().datasets?.stock?.lastError).toContain("nightly");
    const ok = fakeQl();
    expect(await runNightly(S, deps(ok.ql, { now: () => Date.parse("2026-10-17T02:10:00Z") }))).toBe("done");
    expect(state().datasets?.stock?.lastError).toBeNull();
  });

  it("a failing dataset doesn't block the night: others advance, it retries from its own syncedThrough", async () => {
    await finishedShop();
    const { ql, calls } = fakeQl();
    const broken: ShopifyqlClient = {
      ...ql,
      sessionsDaily: async () => {
        throw new ShopifyqlParseError(["bad"], "q");
      },
    };
    const at = Date.parse("2026-10-17T01:10:00Z");
    expect(await runNightly(S, deps(broken, { now: () => at }))).toBe("partial");
    const s = state();
    expect(s.datasets?.stock?.syncedThrough).toBe("2026-10-16");
    expect(s.datasets?.totals?.syncedThrough).toBe("2026-10-16");
    expect(s.datasets?.visits).toMatchObject({ syncedThrough: "2026-10-15", lastErrorCode: "shopifyql_parse" });
    expect(s.syncedThrough).toBe("2026-10-15"); // the slowest dataset
    expect((db.tables.shop[0].lastNightlyAt as Date).getTime()).toBe(at);
    expect(cat.syncCatalog).toHaveBeenCalledTimes(1);
    expect(calls.some((c) => c.kind === "shopDaily")).toBe(true);
    // Next night: visits catches up two days, the others one.
    const next = fakeQl();
    expect(await runNightly(S, deps(next.ql, { now: () => Date.parse("2026-10-18T01:10:00Z") }))).toBe("done");
    expect(next.calls.find((c) => c.kind === "sessions")?.range).toEqual({ since: "2026-10-16", until: "2026-10-17" });
    expect(next.calls.find((c) => c.kind === "stock")?.range).toEqual({ since: "2026-10-17", until: "2026-10-17" });
  });

  it("deletes daily facts older than 25 months", async () => {
    await finishedShop();
    db.tables.salesDaily.push({ shop: S, day: new Date("2024-09-15T00:00:00Z"), variantId: V, locationKey: "all", channel: "x", sold: 1, returned: 0, gross: 1 });
    db.tables.stockDaily.push({ shop: S, day: new Date("2024-09-17T00:00:00Z"), variantId: V, locationId: "L", endUnits: 1, outOfStock: false });
    const { ql } = fakeQl();
    await runNightly(S, deps(ql, { now: () => Date.parse("2026-10-17T01:10:00Z") }));
    expect(db.tables.salesDaily.some((r) => iso(r.day) === "2024-09-15")).toBe(false); // cutoff 2024-09-17
    expect(db.tables.stockDaily.some((r) => iso(r.day) === "2024-09-17")).toBe(true);
  });

  it("nightlyRange catches up missed days, capped", () => {
    expect(nightlyRange("2026-10-12", "2026-10-15")).toEqual({ since: "2026-10-13", until: "2026-10-15" });
    expect(nightlyRange("2026-10-15", "2026-10-15")).toBeNull();
    expect(nightlyRange(null, "2026-10-15")).toEqual({ since: "2026-10-15", until: "2026-10-15" });
    expect(nightlyRange("2025-01-01", "2026-10-15")).toEqual({ since: "2026-08-15", until: "2026-10-15" });
  });
});
