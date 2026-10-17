/**
 * Stored first / last days (DB scale #3): what the sync keeps in Variant.firstStockDay /
 * firstSaleDay / lastSaleDay and VariantLocationDays must always equal what a fresh scan of the
 * facts says (buildFactDays is the oracle). A seeded random walk of the writes the sync makes —
 * months newest first (backfill), one day at a time (nightly), a month rewritten with different
 * rows (retry / correction), parts split around a gap, retention — is checked after every step.
 * Variant columns may stay null where the facts now hold a value (filled lazily by compute: the
 * catalog can create a variant after its first facts) — fillVariantDays then finds that value.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeDb, Row } from "./helpers/fake-prisma";

vi.mock("../app/db.server", async () => {
  const { createFakePrisma } = await import("./helpers/fake-prisma");
  const db = createFakePrisma();
  return { default: db.client, __fake: db };
});

import * as dbModule from "../app/db.server";
import { useFakeFacts } from "./helpers/fake-facts";
import { applyDays, buildFactDays, fillVariantDays, fixDaysAfterRetention } from "../app/services/sync/fact-days.server";
import { collectSales, collectStock, mergeFirst, mergeLast, newCollector, partsContiguous, RECOMPUTE, lastSaleBefore } from "../app/lib/sync/fact-days-shared";
import { firstSaleRows } from "../app/models/fact-days.server";
import { storeHistory } from "../app/services/sync/facts.server";
import type { ShopifyqlClient } from "../app/services/sync/shopifyql.server";
import type { SalesFact, StockFact } from "../app/lib/sync/facts-shared";
import { addDays, type DayRange } from "../app/lib/sync/shopifyql-shared";

const db = (dbModule as unknown as { __fake: FakeDb }).__fake;
useFakeFacts(db);
const S = "days.myshopify.com";
const VARIANTS = ["gid://shopify/ProductVariant/1", "gid://shopify/ProductVariant/2", "gid://shopify/ProductVariant/3", "gid://shopify/ProductVariant/4"];
const LOCS = ["gid://shopify/Location/1", "gid://shopify/Location/2"];
const d = (day: string) => new Date(`${day}T00:00:00.000Z`);
const iso = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : null);

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function days(r: DayRange): string[] {
  const out: string[] = [];
  for (let x = r.since; x <= r.until; x = addDays(x, 1)) out.push(x);
  return out;
}

/** What the stored days are now (Variant columns and every location row). */
function stored() {
  const variants = Object.fromEntries((db.tables.variant ?? []).map((v) => [v.id as string, { firstStockDay: iso(v.firstStockDay), firstSaleDay: iso(v.firstSaleDay), lastSaleDay: iso(v.lastSaleDay) }]));
  const locations = Object.fromEntries(
    (db.tables.variantLocationDays ?? [])
      .filter((r) => r.firstStockDay || r.lastSaleDay)
      .map((r) => [`${r.variantId}|${r.locationKey}`, { firstStockDay: iso(r.firstStockDay), lastSaleDay: iso(r.lastSaleDay) }]),
  );
  return { variants, locations };
}

/** The oracle: a fresh build from the facts, on a copy of the tables. */
async function oracle() {
  const saved = { variant: (db.tables.variant ?? []).map((r) => ({ ...r })), vld: (db.tables.variantLocationDays ?? []).map((r) => ({ ...r })), shop: (db.tables.shop ?? []).map((r) => ({ ...r })) };
  await buildFactDays(S);
  const want = stored();
  db.tables.variant = saved.variant;
  db.tables.variantLocationDays = saved.vld;
  db.tables.shop = saved.shop;
  return want;
}

function writeStock(rand: () => number, r: DayRange): StockFact[] {
  db.tables.stockDaily = (db.tables.stockDaily ?? []).filter((x) => !(iso(x.day)! >= r.since && iso(x.day)! <= r.until));
  const facts: StockFact[] = [];
  for (const day of days(r))
    for (const v of VARIANTS)
      for (const loc of LOCS) if (rand() < 0.55) facts.push({ day, variantId: v, locationId: loc, endUnits: Math.floor(rand() * 9) - 1, outOfStock: rand() < 0.2 });
  for (const f of facts) db.tables.stockDaily.push({ shop: S, ...f, day: d(f.day) });
  return facts;
}

function writeSales(rand: () => number, r: DayRange): SalesFact[] {
  db.tables.salesDaily = (db.tables.salesDaily ?? []).filter((x) => !(iso(x.day)! >= r.since && iso(x.day)! <= r.until));
  const facts: SalesFact[] = [];
  for (const day of days(r))
    for (const v of VARIANTS) {
      if (rand() < 0.4) facts.push({ day, variantId: v, locationKey: "all", channel: "Online Store", sold: Math.floor(rand() * 3), returned: 0, gross: 1 });
      const key = rand() < 0.5 ? "online" : rand() < 0.5 ? LOCS[1] : "pos:Old shop";
      if (rand() < 0.35) facts.push({ day, variantId: v, locationKey: key, channel: "all", sold: Math.floor(rand() * 3) - (rand() < 0.1 ? 1 : 0), returned: 0, gross: 0 });
    }
  for (const f of facts) db.tables.salesDaily.push({ shop: S, ...f, day: d(f.day) });
  return facts;
}

beforeEach(() => {
  db.reset();
  vi.spyOn(console, "error").mockImplementation(() => {});
  db.tables.shop = [{ domain: S, factDaysAt: null }];
  db.tables.variant = VARIANTS.map((id) => ({ id, shop: S, firstStockDay: null, firstSaleDay: null, lastSaleDay: null }));
});

describe("merge rules (pure)", () => {
  const P = (since: string, until: string) => ({ since, until });
  it("first / last: outside the rewritten days min / max; inside, the chunk's (or recompute)", () => {
    expect(mergeFirst("2026-05-10", "2026-04-02", [P("2026-04-01", "2026-04-30")])).toBe("2026-04-02");
    expect(mergeFirst("2026-03-10", "2026-04-02", [P("2026-04-01", "2026-04-30")])).toBe("2026-03-10");
    expect(mergeFirst("2026-04-05", "2026-04-09", [P("2026-04-01", "2026-04-30")])).toBe("2026-04-09"); // rewritten later
    expect(mergeFirst("2026-04-05", undefined, [P("2026-04-01", "2026-04-30")])).toBe(RECOMPUTE); // gone, next row unknown
    expect(mergeFirst("2026-04-05", "2026-04-20", [P("2026-04-01", "2026-04-10"), P("2026-04-20", "2026-04-30")])).toBe(RECOMPUTE); // a kept day between
    expect(mergeFirst(null, "2026-04-02", [P("2026-04-01", "2026-04-30")])).toBe("2026-04-02");
    expect(mergeLast("2026-04-20", undefined, [P("2026-04-01", "2026-04-30")])).toBe(RECOMPUTE);
    expect(mergeLast("2026-03-20", "2026-04-02", [P("2026-04-01", "2026-04-30")])).toBe("2026-04-02");
    expect(partsContiguous([P("2026-04-11", "2026-04-30"), P("2026-04-01", "2026-04-10")])).toBe(true);
    expect(lastSaleBefore("2026-07-01", "2026-07-18")).toBe("2026-07-01");
    expect(lastSaleBefore("2026-08-01", "2026-07-18")).toBeUndefined(); // inside the window: ask the facts
    expect(lastSaleBefore(null, "2026-07-18")).toBeNull();
  });
});

describe("the sync keeps the stored days equal to a fresh scan", () => {
  it("random walk: backfill months newest first, nightly days, rewrites, split parts, retention", async () => {
    const rand = rng(7);
    await buildFactDays(S); // empty shop: built at once, kept current from here
    const check = async (label: string) => {
      const got = stored();
      const want = await oracle();
      expect(got.locations, label).toEqual(want.locations);
      for (const v of VARIANTS)
        for (const col of ["firstStockDay", "firstSaleDay", "lastSaleDay"] as const) {
          const g = got.variants[v][col];
          // Known values are exact; null only while not filled (lazy).
          if (g !== null) expect(g, `${label} ${v} ${col}`).toBe(want.variants[v][col]);
        }
    };
    const step = async (dataset: "stock" | "sales", parts: DayRange[], label: string) => {
      const c = newCollector();
      for (const p of parts) {
        if (dataset === "stock") collectStock(c, p, writeStock(rand, p));
        else collectSales(c, p, writeSales(rand, p));
      }
      await applyDays(S, c);
      await check(label);
    };
    // Backfill: Sept, Aug, July — newest first; Sept split in two parts (stream / row-cap split).
    await step("stock", [{ since: "2026-09-01", until: "2026-09-12" }, { since: "2026-09-13", until: "2026-09-30" }], "stock sept");
    await step("sales", [{ since: "2026-09-16", until: "2026-09-30" }, { since: "2026-09-01", until: "2026-09-15" }], "sales sept");
    for (const m of ["2026-08", "2026-07"]) {
      const r = { since: `${m}-01`, until: addDays(`${m === "2026-08" ? "2026-09" : "2026-08"}-01`, -1) };
      await step("stock", [r], `stock ${m}`);
      await step("sales", [r], `sales ${m}`);
    }
    // Columns filled once (as after the one-time build / compute's lazy fill).
    await buildFactDays(S);
    // Nightly: one day at a time.
    for (const day of ["2026-10-01", "2026-10-02", "2026-10-03"]) {
      await step("stock", [{ since: day, until: day }], `nightly stock ${day}`);
      await step("sales", [{ since: day, until: day }], `nightly sales ${day}`);
    }
    // A retry rewrites the oldest month with different rows (the stored first may be gone).
    await step("stock", [{ since: "2026-07-01", until: "2026-07-31" }], "rewrite stock july");
    await step("sales", [{ since: "2026-07-01", until: "2026-07-31" }], "rewrite sales july");
    // Parts with a kept gap between them (a failed middle part).
    await step("stock", [{ since: "2026-07-01", until: "2026-07-05" }, { since: "2026-07-20", until: "2026-07-31" }], "gap stock");
    await step("sales", [{ since: "2026-10-03", until: "2026-10-03" }, { since: "2026-09-25", until: "2026-09-28" }], "gap sales");
    // Retention: facts before 2026-07-10 go; stored firsts move to the first remaining row.
    db.tables.stockDaily = db.tables.stockDaily!.filter((x) => iso(x.day)! >= "2026-07-10");
    db.tables.salesDaily = db.tables.salesDaily!.filter((x) => iso(x.day)! >= "2026-07-10");
    await fixDaysAfterRetention(S, "2026-07-10");
    await check("retention");
    // Everything gone for one variant's sales: lastSale and firstSale become null.
    db.tables.salesDaily = db.tables.salesDaily!.filter((x) => !(x.variantId === VARIANTS[0] && iso(x.day)! < "2026-10-04"));
    const c = newCollector();
    collectSales(c, { since: "2026-07-10", until: "2026-10-03" }, []);
    await applyDays(S, c);
    await check("variant 1 sales removed");
  }, 60_000);

  it("a null Variant column (variant created after its facts) is left alone by the sync and filled lazily", async () => {
    await buildFactDays(S);
    const rand = rng(3);
    const c = newCollector();
    collectStock(c, { since: "2026-09-01", until: "2026-09-30" }, writeStock(rand, { since: "2026-09-01", until: "2026-09-30" }));
    await applyDays(S, c);
    expect(stored().variants[VARIANTS[0]].firstStockDay).toBeNull(); // never invented from a part
    const filled = await fillVariantDays(S, { firstStockDay: VARIANTS, firstSaleDay: [], lastSaleDay: [] });
    const want = await oracle();
    for (const v of VARIANTS) {
      expect(filled.get(v)?.firstStockDay).toBe(want.variants[v].firstStockDay);
      expect(stored().variants[v].firstStockDay).toBe(want.variants[v].firstStockDay);
    }
  });

  it("storeHistory keeps them current (stock and sales); visits / totals do not touch them", async () => {
    await buildFactDays(S);
    db.tables.location = LOCS.map((id, i) => ({ id, shop: S, name: `L${i}`, active: true }));
    const r: DayRange = { since: "2026-09-01", until: "2026-09-02" };
    const ql = {
      stockDaily: async () => ({
        rows: [
          { day: "2026-09-01", variantId: VARIANTS[0], locationName: "L0", endUnits: 3, outOfStock: false },
          { day: "2026-09-02", variantId: VARIANTS[0], locationName: "L1", endUnits: 0, outOfStock: true },
        ],
        skipped: 0,
        missingColumns: [],
      }),
    } as unknown as ShopifyqlClient;
    await storeHistory("stock", S, ql, r, "2026-10-16", db.tables.location as never);
    expect(stored().locations).toEqual({
      [`${VARIANTS[0]}|${LOCS[0]}`]: { firstStockDay: "2026-09-01", lastSaleDay: null },
      [`${VARIANTS[0]}|${LOCS[1]}`]: { firstStockDay: "2026-09-02", lastSaleDay: null },
    });
    expect(await oracle()).toMatchObject({ locations: stored().locations });
  });

  it("before the build nothing is kept (collectorFor) and readers use the facts; the build sets factDaysAt", async () => {
    const rand = rng(5);
    writeSales(rand, { since: "2026-09-01", until: "2026-09-10" });
    const rows = await firstSaleRows(S, VARIANTS);
    const facts = new Map<string, string>();
    for (const r of db.tables.salesDaily as Row[]) if (r.locationKey === "all") {
      const day = iso(r.day)!;
      const cur = facts.get(r.variantId as string);
      if (!cur || day < cur) facts.set(r.variantId as string, day);
    }
    expect(new Map(rows.map((r) => [r.variantId, iso(r._min.day)]))).toEqual(facts);
    const b = await buildFactDays(S);
    expect(b.variants).toBe(4);
    expect(db.tables.shop![0].factDaysAt).toBeInstanceOf(Date);
    expect(new Map((await firstSaleRows(S, VARIANTS)).map((r) => [r.variantId, iso(r._min.day)]))).toEqual(facts);
  });
});
