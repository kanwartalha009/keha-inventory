/**
 * accuracy.server (spec §7.8) on an in-memory Prisma: snapshot on the 1st only (fresh metrics,
 * store row, idempotent), grading of last month from the online pool view only (never the
 * channel view), waiting for the sales history to reach the month's end, idempotent.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeDb } from "./helpers/fake-prisma";

vi.mock("../app/db.server", async () => {
  const { createFakePrisma } = await import("./helpers/fake-prisma");
  const db = createFakePrisma({ forecastSnapshot: ["shop", "month", "variantId"], accuracyMonth: ["shop", "month"] });
  return { default: db.client, __fake: db };
});

import * as dbModule from "../app/db.server";
import { accuracyDetail, runAccuracy, runAccuracyAllShops } from "../app/services/accuracy.server";
import { addDays } from "../app/lib/sync/shopifyql-shared";

const db = (dbModule as unknown as { __fake: FakeDb }).__fake;
const S = "acme.myshopify.com";
const L1 = "gid://shopify/Location/1";
const A = "gid://shopify/ProductVariant/1";
const B = "gid://shopify/ProductVariant/2";
const d = (day: string) => new Date(`${day}T00:00:00.000Z`);
const FIRST = new Date("2026-11-01T08:00:00Z"); // 09:00 in Madrid

function seed(syncedThrough = "2026-10-31") {
  db.reset();
  db.tables.shop = [
    {
      domain: S,
      timezone: "Europe/Madrid",
      uninstalledAt: null,
      backfillState: { datasets: { sales: { done: 13, total: 13, doneThrough: "2025-10-01", syncedThrough } } },
    },
  ];
  db.tables.location = [{ id: L1, shop: S, active: true, online: true }];
  db.tables.variant = [
    { id: A, shop: S, collections: [] },
    { id: B, shop: S, collections: [] },
  ];
  db.tables.variantMetric = [
    { shop: S, variantId: A, scope: "online", rate: 2, computedAt: new Date("2026-11-01T04:00:00Z") },
    { shop: S, variantId: B, scope: "online", rate: null, computedAt: new Date("2026-11-01T04:00:00Z") },
  ];
  db.tables.forecastSnapshot = [];
  db.tables.accuracyMonth = [];
  db.tables.salesDaily = [];
}

beforeEach(() => seed());

describe("snapshot", () => {
  it("on the 1st: rate × seasonal × trend × days for variants with a rate, plus the store row", async () => {
    const r = await runAccuracy(S, FIRST);
    expect(r.snapshot).toBe("written");
    const rows = db.tables.forecastSnapshot.map((x) => ({ m: (x.month as Date).toISOString().slice(0, 10), v: x.variantId, p: x.predicted }));
    // No seasonal history in this fixture → seasonal 1, trend 1: 2/day × 30 days.
    expect(rows).toEqual([
      { m: "2026-11-01", v: A, p: 60 },
      { m: "2026-11-01", v: "__store__", p: 60 },
    ]);
  });

  it("M7: keeps the naive baseline per variant (last-28-day in-stock rate × days)", async () => {
    db.tables.variantMetric[0].inputs = { windows: [{ days: 28, rate: 3 }, { days: 56, rate: 2 }] };
    await runAccuracy(S, FIRST);
    expect(db.tables.forecastSnapshot.find((x) => x.variantId === `__naive__:${A}`)!.predicted).toBe(90);
  });

  it("is idempotent and keeps the first snapshot", async () => {
    await runAccuracy(S, FIRST);
    db.tables.variantMetric[0].rate = 5;
    expect((await runAccuracy(S, new Date("2026-11-01T09:00:00Z"))).snapshot).toBe("exists");
    expect(db.tables.forecastSnapshot.find((x) => x.variantId === A)!.predicted).toBe(60);
  });

  it("review fix: the first run of days 1–3 takes a missing snapshot (a missed 1st no longer skips the month)", async () => {
    for (const m of db.tables.variantMetric) m.computedAt = new Date("2026-11-03T04:00:00Z");
    expect((await runAccuracy(S, new Date("2026-11-03T08:00:00Z"))).snapshot).toBe("written");
    expect(db.tables.forecastSnapshot.find((x) => x.variantId === A)!.predicted).toBe(60);
    expect((await runAccuracy(S, new Date("2026-11-03T09:00:00Z"))).snapshot).toBe("exists");
    seed();
    for (const m of db.tables.variantMetric) m.computedAt = new Date("2026-11-04T04:00:00Z");
    expect((await runAccuracy(S, new Date("2026-11-04T08:00:00Z"))).snapshot).toBe("not_due");
  });

  it("only on days 1–3 (store time) and only with fresh metrics", async () => {
    expect((await runAccuracy(S, new Date("2026-11-04T08:00:00Z"))).snapshot).toBe("not_due");
    // 31 Oct 23:30 UTC is already 1 Nov in Madrid.
    expect((await runAccuracy(S, new Date("2026-10-31T23:30:00Z"))).snapshot).toBe("written");
    seed();
    for (const m of db.tables.variantMetric) m.computedAt = new Date("2026-10-29T04:00:00Z");
    expect((await runAccuracy(S, FIRST)).snapshot).toBe("stale_metrics");
    expect(db.tables.forecastSnapshot).toEqual([]);
  });
});

describe("grading last month", () => {
  function october() {
    db.tables.forecastSnapshot.push(
      { shop: S, month: d("2026-10-01"), variantId: A, predicted: 62, actual: null },
      { shop: S, month: d("2026-10-01"), variantId: B, predicted: 31, actual: null },
      { shop: S, month: d("2026-10-01"), variantId: "__store__", predicted: 93, actual: null },
    );
    for (let i = 0; i < 31; i++) {
      const day = d(addDays("2026-10-01", i));
      db.tables.salesDaily.push({ shop: S, day, variantId: A, locationKey: "online", channel: "all", sold: 2, returned: 0, gross: 0 });
      // Channel view of the same sales: revenue only, never added to the units.
      db.tables.salesDaily.push({ shop: S, day, variantId: A, locationKey: "all", channel: "Online Store", sold: 2, returned: 0, gross: 50 });
      if (i < 20) {
        db.tables.salesDaily.push({ shop: S, day, variantId: B, locationKey: L1, channel: "all", sold: 1, returned: 0, gross: 0 });
        db.tables.salesDaily.push({ shop: S, day, variantId: B, locationKey: "all", channel: "Online Store", sold: 1, returned: 0, gross: 20 });
      }
    }
    // A POS store outside the pool: not counted.
    db.tables.salesDaily.push({ shop: S, day: d("2026-10-05"), variantId: A, locationKey: "gid://shopify/Location/9", channel: "all", sold: 40, returned: 0, gross: 0 });
    // September revenue (channel view): what ranks October's top 20 (the month before, no look-ahead).
    db.tables.salesDaily.push({ shop: S, day: d("2026-09-15"), variantId: A, locationKey: "all", channel: "Online Store", sold: 2, returned: 0, gross: 50 });
    db.tables.salesDaily.push({ shop: S, day: d("2026-09-15"), variantId: B, locationKey: "all", channel: "Online Store", sold: 1, returned: 0, gross: 20 });
  }

  it("fills actuals from the online pool view and writes AccuracyMonth", async () => {
    october();
    const r = await runAccuracy(S, FIRST);
    expect(r.grade).toBe("written");
    const actual = Object.fromEntries(
      db.tables.forecastSnapshot.filter((x) => (x.month as Date).toISOString().startsWith("2026-10")).map((x) => [x.variantId, x.actual]),
    );
    expect(actual).toEqual({ [A]: 62, [B]: 20, __store__: 82 });
    const m = db.tables.accuracyMonth[0];
    expect((m.month as Date).toISOString().slice(0, 10)).toBe("2026-10-01");
    expect(m.storeErrorPct).toBeCloseTo((11 / 82) * 100, 10);
    // M7: top-20 WAPE = (|62 − 62| + |31 − 20|) ÷ 82 (was the mean of % errors: 27.5 %).
    expect(m.top20ErrorPct).toBeCloseTo((11 / 82) * 100, 10);
    expect(m.graded).toBe(2);
    // Idempotent.
    expect((await runAccuracy(S, new Date("2026-11-01T10:00:00Z"))).grade).toBe("exists");
    expect(db.tables.accuracyMonth).toHaveLength(1);
  });

  it("M7: sold-out days leave the forecast side; the scorecard detail shows engine vs naive", async () => {
    october();
    db.tables.forecastSnapshot.push({ shop: S, month: d("2026-10-01"), variantId: `__naive__:${B}`, predicted: 40, actual: null });
    // B: in stock 20 days (it sold 1 a day), then 11 sold-out days (0 units, nothing sold).
    db.tables.stockDaily = [];
    for (let i = 0; i < 31; i++) {
      const day = d(addDays("2026-10-01", i));
      db.tables.stockDaily.push({ shop: S, day, variantId: B, locationId: L1, endUnits: i < 20 ? 5 : 0, outOfStock: i >= 20 });
    }
    await runAccuracy(S, FIRST);
    // B's 31 forecast × 20/31 in stock = 20 vs 20 sold: 0 error. Store: 62 + 20 vs 82 → 0 %.
    const m = db.tables.accuracyMonth[0];
    expect(m.top20ErrorPct).toBeCloseTo(0, 10);
    expect(m.storeErrorPct).toBeCloseTo(0, 10);
    expect(db.tables.forecastSnapshot.find((x) => x.variantId === `__instock__:${B}`)!.predicted).toBeCloseTo(20 / 31, 12);
    const detail = (await accuracyDetail(S, "2026-10-01"))!;
    expect(detail.top20.engine).toMatchObject({ n: 2 });
    expect(detail.top20.engine.wapePct).toBeCloseTo(0, 10);
    // Naive for B only: 40 × 20/31 vs 20.
    expect(detail.top20.naive.n).toBe(1);
    expect(detail.top20.naive.wapePct).toBeCloseTo(((40 * 20) / 31 - 20) / 20 * 100, 10);
  });

  it("review fix: the top 20 is ranked by revenue in the month BEFORE the graded month (as the backtest)", async () => {
    october();
    // B sold in October but had no September revenue: not ranked, so not in the top-20 mean.
    db.tables.salesDaily = db.tables.salesDaily.filter((x) => !(x.variantId === B && (x.day as Date).toISOString().startsWith("2026-09")));
    await runAccuracy(S, FIRST);
    expect(db.tables.accuracyMonth[0]).toMatchObject({ top20ErrorPct: 0, graded: 1 });
  });

  it("review fix: grades every snapshotted, ungraded month whose data is complete (none skipped), idempotent", async () => {
    october();
    // August and September were snapshotted but never graded (e.g. the app was down on those days).
    for (const m of ["2026-08-01", "2026-09-01"]) {
      db.tables.forecastSnapshot.push(
        { shop: S, month: d(m), variantId: A, predicted: 50, actual: null },
        { shop: S, month: d(m), variantId: "__store__", predicted: 50, actual: null },
      );
    }
    db.tables.accuracyMonth.push({ shop: S, month: d("2026-08-01"), storeErrorPct: 1, top20ErrorPct: 1, graded: 1 });
    expect((await runAccuracy(S, new Date("2026-11-20T08:00:00Z"))).grade).toBe("written");
    expect(db.tables.accuracyMonth.map((m) => (m.month as Date).toISOString().slice(0, 7)).sort()).toEqual(["2026-08", "2026-09", "2026-10"]);
    expect(db.tables.accuracyMonth.find((m) => (m.month as Date).toISOString().startsWith("2026-08"))).toMatchObject({ storeErrorPct: 1 }); // untouched
    expect((await runAccuracy(S, new Date("2026-11-20T09:00:00Z"))).grade).toBe("exists");
    expect(db.tables.accuracyMonth).toHaveLength(3);
  });

  it("waits until the sales history reaches the month's last day", async () => {
    seed("2026-10-30");
    october();
    expect((await runAccuracy(S, FIRST)).grade).toBe("waiting");
    expect(db.tables.accuracyMonth).toEqual([]);
  });

  it("no snapshot → nothing to grade; not enough coverage → nulls", async () => {
    expect((await runAccuracy(S, FIRST)).grade).toBe("no_snapshot");
    october();
    db.tables.shop[0].backfillState = { datasets: { sales: { doneThrough: "2025-10-01", syncedThrough: "2026-10-31", skippedMonths: ["2026-10-01"] } } };
    expect((await runAccuracy(S, FIRST)).grade).toBe("written");
    expect(db.tables.accuracyMonth[0]).toMatchObject({ storeErrorPct: null, top20ErrorPct: null, graded: 0 });
  });

  it("the all-shops runner never throws and skips uninstalled shops", async () => {
    db.tables.shop.push({ domain: "gone.myshopify.com", timezone: "UTC", uninstalledAt: new Date(), backfillState: {} });
    const counts = await runAccuracyAllShops(FIRST);
    expect(counts).toEqual({ "written/no_snapshot": 1 });
  });
});
