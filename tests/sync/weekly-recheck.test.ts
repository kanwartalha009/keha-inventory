/**
 * Weekly sales re-check (services/sync/weekly-recheck.server) on the in-memory Prisma with a fake
 * ShopifyQL client: one totals query for the last 35 days, only the differing days re-read and
 * rewritten (a refunded order 20 days ago), never today, compute queued only when a day changed,
 * the result kept in backfillState.weeklyRecheck, throttle / errors, and the hourly tick queuing
 * each shop on its own hour of the week.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeDb } from "../helpers/fake-prisma";
import type { ShopifyqlClient } from "../../app/services/sync/shopifyql.server";
import { ShopifyqlThrottledError, addDays, assertPastRange, type DayRange, type ParseResult } from "../../app/lib/sync/shopifyql-shared";

vi.mock("../../app/db.server", async () => {
  const { createFakePrisma } = await import("../helpers/fake-prisma");
  const db = createFakePrisma({
    shop: ["domain"],
    salesDaily: ["shop", "day", "variantId", "locationKey", "channel"],
  });
  return { default: db.client, __fake: db };
});
const q = vi.hoisted(() => ({ enqueue: vi.fn(async (_shop: string, _kind: string, _delay?: number) => true) }));
vi.mock("../../app/services/jobs/queue.server", () => ({ enqueueJob: q.enqueue }));

import * as dbModule from "../../app/db.server";
import { useFakeFacts } from "../helpers/fake-facts";
import { recheckJob, recheckTick, runWeeklyRecheck, storedDailyUnits } from "../../app/services/sync/weekly-recheck.server";
import { readWeeklyRecheck, recheckSlot } from "../../app/lib/sync/weekly-recheck-shared";
import type { DataJobDeps } from "../../app/services/sync/backfill.server";

const db = (dbModule as unknown as { __fake: FakeDb }).__fake;
useFakeFacts(db);
const S = "acme.myshopify.com";
const TZ = "Europe/Madrid";
const V = "gid://shopify/ProductVariant/1";
const NOW = Date.parse("2026-10-18T08:00:00Z"); // 10:00 in Madrid: today 2026-10-18, yesterday 2026-10-17
const YESTERDAY = "2026-10-17";
const REFUND_DAY = addDays(YESTERDAY, -20); // 2026-09-27
const WINDOW: DayRange = { since: addDays(YESTERDAY, -34), until: YESTERDAY };

function days(r: DayRange): string[] {
  const out: string[] = [];
  for (let d = r.since; d <= r.until; d = addDays(d, 1)) out.push(d);
  return out;
}

/**
 * Shopify now: 3 units a day (online 2 + Madrid store 1), except the refund day where a 2-unit
 * online order was refunded after the nightly re-read window had passed it.
 */
const shopifyUnits = (day: string) => (day === REFUND_DAY ? 1 : 3);

function fakeQl(opts: { throttle?: boolean } = {}) {
  const calls: { kind: string; range: DayRange }[] = [];
  const res = <T>(rows: T[], missing: string[]): ParseResult<T> => ({ rows, skipped: 0, missingColumns: missing });
  const guard = (kind: string, range: DayRange, today: string) => {
    assertPastRange(range, today); // never today (I-12)
    calls.push({ kind, range });
    if (opts.throttle) throw new ShopifyqlThrottledError(5);
  };
  const fail = async (): Promise<never> => {
    throw new Error("not used by the re-check");
  };
  const ql: ShopifyqlClient = {
    run: fail,
    salesDaily: fail,
    stockDaily: fail,
    sessionsDaily: fail,
    shopDaily: fail,
    salesDailyByLocation: async (r, t) => {
      guard("salesByLocation", r, t);
      return res(
        days(r).flatMap((day) => [
          { day, variantId: V, locationKey: "online", channel: "unknown", sold: shopifyUnits(day) - 1, gross: 0, returned: 0 },
          { day, variantId: V, locationKey: "Madrid Store", channel: "unknown", sold: 1, gross: 0, returned: 0 },
        ]),
        ["sales_channel", "gross_sales", "quantity_returned"],
      );
    },
    salesDailyByChannel: async (r, t) => {
      guard("salesByChannel", r, t);
      return res(
        days(r).map((day) => ({ day, variantId: V, locationKey: "unknown", channel: "Online Store", sold: shopifyUnits(day), gross: 25 * shopifyUnits(day), returned: day === REFUND_DAY ? 2 : 0 })),
        ["pos_location_name"],
      );
    },
    salesTotalsDaily: async (r, t) => {
      guard("totals", r, t);
      return res(days(r).map((day) => ({ day, sold: shopifyUnits(day) })), []);
    },
  };
  return { ql, calls };
}

/** What the nightly runs stored before the refund: 3 units every day, both views. */
function seedStoredSales(over: Record<string, number> = {}) {
  db.tables.salesDaily = days({ since: addDays(YESTERDAY, -60), until: YESTERDAY }).flatMap((day) => {
    const u = over[day] ?? 3;
    return [
      { shop: S, day: new Date(`${day}T00:00:00Z`), variantId: V, locationKey: "all", channel: "Online Store", sold: u, returned: 0, gross: 25 * u },
      { shop: S, day: new Date(`${day}T00:00:00Z`), variantId: V, locationKey: "gid://shopify/Location/1", channel: "all", sold: u - 1, returned: 0, gross: 0 },
      { shop: S, day: new Date(`${day}T00:00:00Z`), variantId: V, locationKey: "gid://shopify/Location/2", channel: "all", sold: 1, returned: 0, gross: 0 },
    ];
  });
}

function seedShop(state: Record<string, unknown> = {}) {
  db.tables.shop = [
    {
      domain: S,
      timezone: TZ,
      currency: "EUR",
      uninstalledAt: null,
      lastNightlyAt: null,
      backfillState: { finishedAt: "2026-09-01T00:00:00Z", syncedThrough: YESTERDAY, datasets: { sales: { done: 14, total: 14, syncedThrough: YESTERDAY } }, ...state },
    },
  ];
}

const afterSync = vi.fn(async (_shop: string) => {});
function deps(ql: ShopifyqlClient): DataJobDeps {
  return { getAdmin: async () => ({ graphql: vi.fn() }), shopifyql: () => ql, now: () => NOW, sleep: async () => {}, afterSync };
}
const stored = () => readWeeklyRecheck(db.tables.shop[0].backfillState);

beforeEach(() => {
  db.reset();
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  db.tables.location = [
    { id: "gid://shopify/Location/1", shop: S, name: "Warehouse", active: true, online: true },
    { id: "gid://shopify/Location/2", shop: S, name: "Madrid Store", active: true, online: false },
  ];
  seedShop();
  seedStoredSales();
});

describe("weekly sales re-check", () => {
  it("a refunded order 20 days ago: one totals query, only that day re-read and rewritten, compute queued", async () => {
    const { ql, calls } = fakeQl();
    expect(await runWeeklyRecheck(S, deps(ql))).toBe("corrected:1");
    // One cheap totals query for the 35 days, ending yesterday (never today) …
    expect(calls[0]).toEqual({ kind: "totals", range: WINDOW });
    // … then the normal sales read for the differing day only (both views + its reconcile total).
    const reads = calls.slice(1);
    expect(reads.map((c) => c.range)).toEqual(reads.map(() => ({ since: REFUND_DAY, until: REFUND_DAY })));
    expect(reads.map((c) => c.kind).sort()).toEqual(["salesByChannel", "salesByLocation", "totals"]);
    // Stored: the refund day now 1 unit (both views), the other days untouched.
    const units = await storedDailyUnits(S, WINDOW);
    expect(units.get(REFUND_DAY)).toBe(1);
    expect(units.get(addDays(REFUND_DAY, 1))).toBe(3);
    const locRows = db.tables.salesDaily.filter((r) => (r.day as Date).toISOString().startsWith(REFUND_DAY) && r.locationKey !== "all");
    expect(locRows.reduce((a, r) => a + Number(r.sold), 0)).toBe(1);
    const returned = db.tables.salesDaily.find((r) => (r.day as Date).toISOString().startsWith(REFUND_DAY) && r.locationKey === "all");
    expect(returned?.returned).toBe(2);
    // Recorded and logged; the plan is recomputed.
    expect(stored()).toMatchObject({ outcome: "done", since: WINDOW.since, until: YESTERDAY, differing: 1, corrected: 1, unitsBefore: 105, unitsAfter: 103, changed: 2 });
    expect(stored()!.share).toBeCloseTo(2 / 105);
    expect(afterSync).toHaveBeenCalledWith(S);
    expect(vi.mocked(console.log).mock.calls.flat().join(" ")).toMatch(/1 day\(s\) differed from Shopify, 1 corrected \(units 105 → 103/);
    // The rest of the backfill state is kept.
    expect(db.tables.shop[0].backfillState).toMatchObject({ finishedAt: "2026-09-01T00:00:00Z", syncedThrough: YESTERDAY });
  });

  it("nothing differs: only the totals query, nothing rewritten, no compute", async () => {
    seedStoredSales({ [REFUND_DAY]: 1 });
    const before = JSON.stringify(db.tables.salesDaily);
    const { ql, calls } = fakeQl();
    expect(await runWeeklyRecheck(S, deps(ql))).toBe("unchanged");
    expect(calls.map((c) => c.kind)).toEqual(["totals"]);
    expect(JSON.stringify(db.tables.salesDaily)).toBe(before);
    expect(afterSync).not.toHaveBeenCalled();
    expect(stored()).toMatchObject({ outcome: "done", differing: 0, corrected: 0, share: 0 });
  });

  it("days older than the window are never touched, even when they differ", async () => {
    const old = addDays(WINDOW.since, -1);
    seedStoredSales({ [old]: 9 });
    const { ql, calls } = fakeQl();
    await runWeeklyRecheck(S, deps(ql));
    expect(calls.every((c) => c.range.since >= WINDOW.since)).toBe(true);
    const oldRow = db.tables.salesDaily.find((r) => (r.day as Date).toISOString().startsWith(old) && r.locationKey === "all");
    expect(oldRow?.sold).toBe(9);
  });

  it("the window ends where the sales sync stopped (the nightly run reads the rest)", async () => {
    seedShop({ syncedThrough: "2026-10-10", datasets: { sales: { done: 14, total: 14, syncedThrough: "2026-10-10" } } });
    const { ql, calls } = fakeQl();
    await runWeeklyRecheck(S, deps(ql));
    expect(calls[0].range).toEqual({ since: "2026-09-06", until: "2026-10-10" });
  });

  it("skipped before the backfill finished, and for an uninstalled shop", async () => {
    const { ql, calls } = fakeQl();
    db.tables.shop[0].backfillState = { datasets: {} };
    expect(await runWeeklyRecheck(S, deps(ql))).toBe("skipped");
    seedShop();
    db.tables.shop[0].uninstalledAt = new Date();
    expect(await runWeeklyRecheck(S, deps(ql))).toBe("skipped");
    expect(calls).toEqual([]);
  });

  it("throttled: nothing recorded, the job is queued again in 5 minutes", async () => {
    const { ql } = fakeQl({ throttle: true });
    const handler = recheckJob({ getAdmin: async () => ({ graphql: vi.fn() }), shopifyql: () => ql, now: () => NOW, sleep: async () => {} });
    expect(await handler({ id: "1", shop: S, kind: "recheck", attempts: 0, version: 0, owner: "w" })).toBe("throttled");
    expect(stored()).toBeNull();
    expect(q.enqueue).toHaveBeenCalledWith(S, "recheck", 5 * 60_000);
  });

  it("the job handler queues compute when a day was corrected", async () => {
    const { ql } = fakeQl();
    const handler = recheckJob({ getAdmin: async () => ({ graphql: vi.fn() }), shopifyql: () => ql, now: () => NOW, sleep: async () => {} });
    expect(await handler({ id: "1", shop: S, kind: "recheck", attempts: 0, version: 0, owner: "w" })).toBe("corrected:1");
    expect(q.enqueue).toHaveBeenCalledWith(S, "compute");
  });

  it("an error is recorded and logged, never thrown", async () => {
    const { ql } = fakeQl();
    ql.salesTotalsDaily = async () => {
      throw new Error("boom");
    };
    expect(await runWeeklyRecheck(S, deps(ql))).toBe("error");
    expect(stored()).toMatchObject({ outcome: "error", corrected: 0, error: "Error: boom" });
  });
});

describe("the hourly tick", () => {
  const sunday = Date.parse("2026-10-18T00:00:00Z");
  const atSlot = (shop: string) => new Date(sunday + recheckSlot(shop) * 3600_000 + 60_000);

  beforeEach(() => {
    db.tables.session = [{ shop: S }, { shop: S }, { shop: "new.myshopify.com" }];
    db.tables.shop.push({ domain: "new.myshopify.com", timezone: TZ, uninstalledAt: null, backfillState: { datasets: {} } });
  });

  it("queues a fully read shop on its own hour of the week, once", async () => {
    expect(await recheckTick(atSlot(S))).toMatchObject({ queued: 1, skipped: 1 });
    expect(q.enqueue).toHaveBeenCalledWith(S, "recheck");
    q.enqueue.mockClear();
    expect((await recheckTick(new Date(atSlot(S).getTime() + 3600_000))).queued).toBeUndefined();
    expect(q.enqueue).not.toHaveBeenCalled();
  });

  it("not again the same week once it ran", async () => {
    db.tables.shop[0].backfillState = { ...(db.tables.shop[0].backfillState as object), weeklyRecheck: { at: atSlot(S).toISOString(), outcome: "done" } };
    expect((await recheckTick(atSlot(S))).not_due).toBe(1);
    expect(q.enqueue).not.toHaveBeenCalled();
  });
});
