/**
 * computeShop with the weekly backtest cache (perf 2026-10-18, lib/backtest-cache-shared) on the
 * scale fixture: the first run writes a cache row per planned variant and the week's role priors;
 * a second run the same day reads no 14-month history and writes the same metrics; the next night
 * reuses the backtests (only the variants whose refresh night it is are read again); variants that
 * never sold skip the stock part of the history read; a failing cache never fails compute.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeDb } from "./helpers/fake-prisma";

vi.mock("../app/db.server", async () => {
  const { createFakePrisma } = await import("./helpers/fake-prisma");
  const db = createFakePrisma({ variantMetric: ["shop", "variantId", "scope"], moneyAtStake: ["shop", "day"], action: ["shop", "dedupeKey"], variantBacktest: ["shop", "variantId"], backtestRun: ["shop"] });
  return { default: db.client, __fake: db };
});
vi.mock("../app/services/entitlements.server", () => ({ planFor: async () => "pro" }));

import * as dbModule from "../app/db.server";
import { useFakeFacts } from "./helpers/fake-facts";
import { computeShop } from "../app/services/compute.server";
import { isRefreshNight } from "../app/lib/backtest-cache-shared";
import { FX_NOW, FX_SHOP, computeOutput, seedScaleFixture } from "./fixtures/scale-compute-fixture";

const db = (dbModule as unknown as { __fake: FakeDb }).__fake;
useFakeFacts(db);
const DAY_MS = 86_400_000;
const TODAY = "2026-10-16"; // FX_NOW in Madrid
const WINDOW_FROM = Date.parse("2026-07-18T00:00:00Z"); // today − 90
const CACHE_TO = Date.parse("2026-07-24T00:00:00Z"); // the cached window's end: today − 90 + 6

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

type Where = { day?: { gte?: Date; lt?: Date }; variantId?: { in?: string[] } };
/** The stock reads that reach before the 90-day window (the 14-month history), with their variants. */
function historyStockReads(): string[][] {
  return db.calls
    .filter((c) => c.table === "stockDaily" && c.op === "groupBy")
    .map((c) => (c.args as { where: Where }).where)
    .filter((w) => w.day?.gte instanceof Date && w.day.gte.getTime() < WINDOW_FROM)
    .map((w) => w.variantId?.in ?? []);
}
/** Only the chunks' history reads (through the cache window's end; not the first run's role pre-pass). */
const chunkHistoryStockReads = () =>
  db.calls
    .filter((c) => c.table === "stockDaily" && c.op === "groupBy")
    .map((c) => (c.args as { where: Where }).where)
    .filter((w) => w.day?.lt?.getTime() === CACHE_TO)
    .map((w) => w.variantId?.in ?? []);

const onlineMetrics = () => (computeOutput(db) as { metrics: { scope: string; variantId: string; orderQty: number | null; inputs: { error?: { ratio: number | null; samples: number } | null } }[] }).metrics.filter((m) => m.scope === "online");

describe("compute with the backtest cache", () => {
  it("writes a cache row per planned variant and the week's priors; a second run the same day reads no history and writes the same rows", async () => {
    seedScaleFixture(db);
    await computeShop(FX_SHOP, { now: () => FX_NOW });
    const first = computeOutput(db);
    const planned = onlineMetrics().map((m) => m.variantId).sort();
    expect((db.tables.variantBacktest ?? []).map((r) => r.variantId).sort()).toEqual(planned);
    expect(db.tables.backtestRun).toHaveLength(1);
    expect((db.tables.backtestRun![0]!.day as Date).toISOString().slice(0, 10)).toBe(TODAY);
    // Never-sold variants with enough in-stock days skip the stock part of the history read.
    const read = new Set(chunkHistoryStockReads().flat());
    expect(read.size).toBeGreaterThan(10);
    const skipped = (db.tables.variantBacktest ?? []).filter((r) => r.history === null).map((r) => r.variantId as string);
    expect(skipped.length).toBeGreaterThan(0);
    for (const id of skipped) expect(read.has(id)).toBe(false);

    db.tables.variantMetric = [];
    db.tables.moneyAtStake = [];
    db.tables.action = [];
    db.calls.length = 0;
    await computeShop(FX_SHOP, { now: () => FX_NOW });
    expect(historyStockReads()).toEqual([]);
    expect(db.calls.some((c) => c.table === "salesDaily" && (c.args as { where: Where }).where.day?.lt?.getTime() === CACHE_TO)).toBe(false);
    expect(computeOutput(db)).toEqual(first);
  }, 60_000);

  it("the next night reuses the backtests; only the variants whose refresh night it is are read again", async () => {
    seedScaleFixture(db);
    await computeShop(FX_SHOP, { now: () => FX_NOW });
    const before = new Map(onlineMetrics().map((m) => [m.variantId, m.inputs.error ?? null]));
    db.calls.length = 0;
    await computeShop(FX_SHOP, { now: () => FX_NOW + DAY_MS });
    const next = "2026-10-17";
    const reread = new Set(historyStockReads().flat());
    const rows = new Map((db.tables.variantBacktest ?? []).map((r) => [r.variantId as string, r]));
    let reused = 0;
    for (const m of onlineMetrics()) {
      const row = rows.get(m.variantId)!;
      const day = (row.day as Date).toISOString().slice(0, 10);
      if (isRefreshNight(m.variantId, next)) {
        expect(day).toBe(next);
        continue;
      }
      expect(day, m.variantId).toBe(TODAY);
      expect(reread.has(m.variantId)).toBe(false);
      const was = before.get(m.variantId);
      if (was && m.inputs.error) {
        expect({ ratio: m.inputs.error.ratio, samples: m.inputs.error.samples }).toEqual({ ratio: was.ratio, samples: was.samples });
        reused++;
      }
    }
    expect(reused).toBeGreaterThan(5);
    // The week's role priors are kept, not measured again.
    expect((db.tables.backtestRun![0]!.day as Date).toISOString().slice(0, 10)).toBe(TODAY);
  }, 60_000);

  it("a week later the role priors are measured again from the stored backtests, not by the pre-pass (#6)", async () => {
    seedScaleFixture(db);
    // The first run measures them with the pre-pass: 14 months for the sampled variants, through today.
    const prePassReads = (today: string) =>
      db.calls.filter((c) => c.table === "stockDaily" && c.op === "groupBy" && (c.args as { where: Where }).where.day?.lt?.getTime() === Date.parse(`${today}T00:00:00Z`)).length;
    await computeShop(FX_SHOP, { now: () => FX_NOW });
    expect(prePassReads(TODAY)).toBeGreaterThan(0);
    for (let d = 1; d <= 7; d++) {
      db.calls.length = 0;
      await computeShop(FX_SHOP, { now: () => FX_NOW + d * DAY_MS });
      const today = new Date(FX_NOW + d * DAY_MS).toISOString().slice(0, 10);
      expect(prePassReads(today), `night +${d}`).toBe(0);
      expect((db.tables.backtestRun![0]!.day as Date).toISOString().slice(0, 10)).toBe(d < 7 ? TODAY : today);
    }
  }, 120_000);

  it("rows of variants no longer computed are swept once they are two refresh cycles old", async () => {
    seedScaleFixture(db);
    const old = (day: string, id: string) => ({ shop: FX_SHOP, variantId: id, day: new Date(`${day}T00:00:00Z`), horizon: 44, scopeKey: "x", backtested: false, ratio: null, windows: 0, samples: 0, bias: null, history: "" });
    db.tables.variantBacktest = [old("2026-09-30", "gid://shopify/ProductVariant/archived"), old("2026-10-05", "gid://shopify/ProductVariant/recent")];
    await computeShop(FX_SHOP, { now: () => FX_NOW });
    const ids = new Set((db.tables.variantBacktest ?? []).map((r) => r.variantId));
    expect(ids.has("gid://shopify/ProductVariant/archived")).toBe(false); // 16 days old
    expect(ids.has("gid://shopify/ProductVariant/recent")).toBe(true); // 11 days: kept
  }, 60_000);

  it("without the cache (backtestCache: false) it writes no cache rows and the same metrics", async () => {
    seedScaleFixture(db);
    await computeShop(FX_SHOP, { now: () => FX_NOW });
    const withCache = computeOutput(db);
    seedScaleFixture(db);
    await computeShop(FX_SHOP, { now: () => FX_NOW, backtestCache: false });
    expect(db.tables.variantBacktest ?? []).toEqual([]);
    expect(computeOutput(db)).toEqual(withCache);
  }, 60_000);

  it("a cache that fails to read or write never fails compute (the facts are read instead)", async () => {
    seedScaleFixture(db);
    await computeShop(FX_SHOP, { now: () => FX_NOW, backtestCache: false });
    const want = computeOutput(db);
    seedScaleFixture(db);
    const client = db.client as Record<string, Record<string, unknown>>;
    const boom = async () => {
      throw new Error("relation \"VariantBacktest\" does not exist");
    };
    const saved = { find: client.variantBacktest!.findMany, unique: client.backtestRun!.findUnique, upsert: client.backtestRun!.upsert, tx: client.$transaction };
    vi.spyOn(console, "error").mockImplementation(() => {});
    client.variantBacktest!.findMany = boom;
    client.backtestRun!.findUnique = boom;
    client.backtestRun!.upsert = boom;
    try {
      await computeShop(FX_SHOP, { now: () => FX_NOW });
    } finally {
      client.variantBacktest!.findMany = saved.find;
      client.backtestRun!.findUnique = saved.unique;
      client.backtestRun!.upsert = saved.upsert;
    }
    expect(computeOutput(db)).toEqual(want);
  }, 60_000);
});
