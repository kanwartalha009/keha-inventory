/**
 * Backtest harness, pure core (spec §16, Phase 0.3): app/lib/engine/backtest-shared.
 * Hand-built stores with pinned dates. Month M = 2026-07, so the replay is as of 2026-08-01
 * and the forecast month is August 2026 (31 days).
 */
import { describe, expect, it } from "vitest";
import {
  backtestMonth,
  coverageAsOf,
  meanOf,
  monthFirstDay,
  monthsEndingWith,
  summarize,
  topByRevenue,
  type BacktestData,
  type BacktestVariant,
} from "../../app/lib/engine/backtest-shared";
import { addDays, daysBetween } from "../../app/lib/engine/dates-shared";
import type { PooledStockDay, SalesDay } from "../../app/lib/compute-shared";

const M = "2026-07";

type Spec = {
  id: string;
  price?: number;
  /** Units sold that day (only on days with data). */
  sold: (day: string) => number;
  oos?: (day: string) => boolean;
  /** No stock row and no sale that day. */
  missing?: (day: string) => boolean;
};

function variant(id: string, price = 10, extra: Partial<BacktestVariant> = {}): BacktestVariant {
  return {
    id,
    productId: `p-${id}`,
    title: `Product ${id}`,
    handle: `h-${id}`,
    vendor: null,
    collections: [],
    tracked: true,
    isBundle: false,
    status: "ACTIVE",
    price,
    cost: null,
    productCreatedAt: "2024-01-01",
    caseQty: null,
    supplierId: null,
    ...extra,
  };
}

function store(specs: Spec[], from: string, to: string, coverageTo: string = to): BacktestData {
  const poolSales: SalesDay[] = [];
  const channelSales: SalesDay[] = [];
  const stock: PooledStockDay[] = [];
  const n = daysBetween(from, to);
  for (const s of specs) {
    const price = s.price ?? 10;
    for (let i = 0; i <= n; i++) {
      const day = addDays(from, i);
      if (s.missing?.(day)) continue;
      const out = s.oos?.(day) ?? false;
      const sold = out ? 0 : s.sold(day);
      stock.push({ variantId: s.id, day, endUnits: out ? 0 : 50, reported: 1, outReported: out ? 1 : 0 });
      if (sold !== 0) {
        poolSales.push({ variantId: s.id, day, sold, gross: 0 });
        channelSales.push({ variantId: s.id, day, sold, gross: sold * price });
      }
    }
  }
  return {
    currency: "EUR",
    coverage: { from, to: coverageTo },
    variants: specs.map((s) => variant(s.id, s.price ?? 10)),
    poolSales,
    channelSales,
    stock,
  };
}

const july = (day: string) => day >= "2026-07-01" && day <= "2026-07-31";
const august = (day: string) => day >= "2026-08-01";

describe("backtest: forecast inputs are handled like compute", () => {
  it("a stock-out window does not lower the forecast", () => {
    const data = store(
      [
        { id: "a", sold: (d) => (august(d) ? 5 : 4) },
        { id: "b", sold: (d) => (august(d) ? 5 : 4), oos: (d) => d >= "2026-07-05" && d <= "2026-07-24" },
      ],
      "2026-04-01",
      "2026-08-31",
    );
    const r = backtestMonth(data, M);
    expect(r.status).toBe("ok");
    const p = new Map(r.top20.rows.map((x) => [x.variantId, x.predicted]));
    expect(p.get("a")).toBeCloseTo(4 * 31, 9);
    expect(p.get("b")).toBeCloseTo(4 * 31, 9);
  });

  it("missing days are not zeros", () => {
    const data = store(
      [{ id: "a", sold: (d) => (august(d) ? 4 : 4), missing: (d) => !august(d) && Number(d.slice(8, 10)) % 2 === 0 }],
      "2026-04-01",
      "2026-08-31",
    );
    const r = backtestMonth(data, M);
    // Half the days have no data at all: the rate is still 4/day, not 2/day.
    expect(r.top20.rows[0].predicted).toBeCloseTo(4 * 31, 9);
  });

  it("uses nothing from the forecast month (no look-ahead)", () => {
    const base = [{ id: "a", sold: () => 3 }];
    const withAug = store(base, "2026-04-01", "2026-08-31");
    const noAug = store(base, "2026-04-01", "2026-07-31");
    const wild = store([{ id: "a", sold: (d: string) => (august(d) ? 900 : 3) }], "2026-04-01", "2026-08-31");
    const p = (d: BacktestData) => backtestMonth(d, M).store?.predicted;
    expect(p(withAug)).toBeCloseTo(3 * 31, 9);
    expect(p(noAug)).toBeCloseTo(3 * 31, 9);
    expect(p(wild)).toBeCloseTo(3 * 31, 9);
  });
});

describe("backtest: error maths", () => {
  it("per-variant and store-total absolute % error", () => {
    const data = store(
      [
        { id: "a", price: 20, sold: (d) => (august(d) ? 5 : 4) }, // 124 vs 155 → 20 %
        { id: "b", price: 10, sold: (d) => (august(d) ? 1 : 2) }, // 62 vs 31 → 100 %
      ],
      "2026-04-01",
      "2026-08-31",
    );
    const r = backtestMonth(data, M);
    expect(r.status).toBe("ok");
    const a = r.top20.rows.find((x) => x.variantId === "a")!;
    const b = r.top20.rows.find((x) => x.variantId === "b")!;
    expect(a.actual).toBe(155);
    expect(a.absPctError).toBeCloseTo(20, 9);
    expect(b.actual).toBe(31);
    expect(b.absPctError).toBeCloseTo(100, 9);
    expect(r.top20.meanAbsPctError).toBeCloseTo(60, 9);
    expect(r.top20.graded).toBe(2);
    // Store: (124 + 62) vs (155 + 31) → 0 %.
    expect(r.store?.predicted).toBeCloseTo(186, 9);
    expect(r.store?.actual).toBe(186);
    expect(r.store?.absPctError).toBeCloseTo(0, 9);
    expect(meanOf(r.top20.rows.map((x) => x.absPctError))).toBeCloseTo(r.top20.meanAbsPctError!, 9);
  });

  it("an actual of 0 has no % error (—), and is left out of the mean", () => {
    const data = store(
      [
        { id: "a", sold: (d) => (august(d) ? 5 : 4) },
        { id: "z", sold: (d) => (august(d) ? 0 : 1) },
      ],
      "2026-04-01",
      "2026-08-31",
    );
    const r = backtestMonth(data, M);
    expect(r.top20.rows.find((x) => x.variantId === "z")?.absPctError).toBeNull();
    expect(r.top20.graded).toBe(1);
    expect(r.top20.meanAbsPctError).toBeCloseTo(20, 9);
  });

  it("is not gradable until the forecast month's sales are in", () => {
    const r = backtestMonth(store([{ id: "a", sold: () => 2 }], "2026-04-01", "2026-08-20"), M);
    expect(r.status).toBe("not_gradable");
    expect(r.reason).toBe("actuals_incomplete");
    expect(r.top20.meanAbsPctError).toBeNull();
    expect(r.store?.absPctError).toBeNull();
    // The money cards as of the end of M don't need the forecast month.
    expect(r.money.lost90).not.toBeNull();
  });

  it("summarize averages graded months only", () => {
    const ok = backtestMonth(store([{ id: "a", sold: (d) => (august(d) ? 5 : 4) }], "2026-04-01", "2026-08-31"), M);
    const late = backtestMonth(store([{ id: "a", sold: () => 2 }], "2026-04-01", "2026-08-20"), M);
    const s = summarize([ok, late]);
    expect(s).toMatchObject({ months: 2, gradedMonths: 1 });
    expect(s.top20MeanAbsPctError).toBeCloseTo(20, 9);
    expect(s.storeMeanAbsPctError).toBeCloseTo(20, 9);
    expect(summarize([late]).top20MeanAbsPctError).toBeNull();
  });
});

describe("backtest: top-20 selection", () => {
  it("ranks by revenue in month M (not M+1), highest first, ties by id, revenue > 0 only", () => {
    const specs: Spec[] = [];
    for (let i = 1; i <= 24; i++) {
      const id = `v${String(i).padStart(2, "0")}`;
      specs.push({ id, price: 1, sold: () => i });
    }
    // Tie with v24 in July; "v24" < "vtie" so v24 ranks first.
    specs.push({ id: "vtie", price: 1, sold: () => 24 });
    // Sells only in August: huge M+1 revenue, none in M → never in the top 20.
    specs.push({ id: "vaug", price: 1000, sold: (d) => (august(d) ? 50 : 0) });
    // In stock but never sold in July: no revenue in M.
    specs.push({ id: "vzero", price: 5, sold: (d) => (july(d) ? 0 : 1) });
    const r = backtestMonth(store(specs, "2026-04-01", "2026-08-31"), M);
    const ids = r.top20.rows.map((x) => x.variantId);
    expect(ids).toHaveLength(20);
    expect(ids.slice(0, 3)).toEqual(["v24", "vtie", "v23"]);
    expect(ids).not.toContain("vaug");
    expect(ids).not.toContain("vzero");
    expect(ids).not.toContain("v01");
    for (let i = 1; i < r.top20.rows.length; i++) expect(r.top20.rows[i - 1].revenueM).toBeGreaterThanOrEqual(r.top20.rows[i].revenueM);
  });

  it("topByRevenue matches gradeMonth's order", () => {
    const rev = new Map([
      ["b", 10],
      ["a", 10],
      ["c", 30],
      ["d", 0],
    ]);
    expect(topByRevenue([{ variantId: "a" }, { variantId: "b" }, { variantId: "c" }, { variantId: "d" }], rev, 2).map((x) => x.variantId)).toEqual(["c", "a"]);
  });

  it("counts top sellers that had no forecast instead of hiding them", () => {
    // Out of stock for all of the last 90 days except 3: no rate window keeps ≥ 7 in-stock days.
    const data = store(
      [
        { id: "a", sold: (d) => (august(d) ? 5 : 4) },
        { id: "gone", price: 100, sold: () => 9, oos: (d) => d >= "2026-05-03" && d <= "2026-07-28" },
      ],
      "2026-04-01",
      "2026-08-31",
    );
    const r = backtestMonth(data, M);
    expect(r.top20.rows.map((x) => x.variantId)).toEqual(["a"]);
    expect(r.top20.topSellersWithoutForecast).toBe(1);
    expect(r.notes.some((n) => n.includes("no sales rate"))).toBe(true);
  });
});

describe("backtest: seasonality", () => {
  it("a store with < 13 months of history gets seasonal 1.0", () => {
    const r = backtestMonth(store([{ id: "a", sold: () => 3 }], "2025-09-01", "2026-08-31"), M);
    expect(r.season).toMatchObject({ seasonal: 1, seasonalApplied: false, seasonalReason: "short_history" });
    expect(r.store?.predicted).toBeCloseTo(3 * 31, 9);
  });

  it("a store with ≥ 13 months applies last year's August ÷ July shape", () => {
    // Last year: 2/day in July, 4/day in August → raw ≈ 1.83 (3-week smoothing at the edges,
    // the rate-window base blend); one year of history → soft threshold exp(ln 1.83 − 0.2) ≈ 1.50.
    const sold = (d: string) => (d < "2025-08-01" ? 2 : d <= "2025-08-31" ? 4 : 3);
    const r = backtestMonth(store([{ id: "a", sold }], "2025-06-01", "2026-08-31"), M);
    expect(r.season.seasonalApplied).toBe(true);
    expect(r.season.seasonal).toBeCloseTo(1.49596, 4);
    expect(r.store?.predicted).toBeCloseTo(3 * r.season.seasonal * r.season.trend * 31, 9);
  });

  it("coverage is clamped to the as-of day", () => {
    expect(coverageAsOf({ from: "2025-01-01", to: "2026-09-30" }, "2026-08-01")).toEqual({ from: "2025-01-01", to: "2026-07-31", skippedMonths: undefined });
    expect(coverageAsOf({ from: "2026-08-05", to: "2026-09-30" }, "2026-08-01")).toEqual({ from: null, to: null });
  });
});

describe("backtest: money as of the end of M", () => {
  it("reuses the money cards; unknown inputs stay null, never 0", () => {
    // 4/day at 10 EUR; out of stock for the last 10 days of July (on hand 0 at the end of M).
    const data = store([{ id: "a", sold: () => 4, oos: (d) => d >= "2026-07-22" && d <= "2026-07-31" }], "2026-04-01", "2026-08-31");
    const r = backtestMonth(data, M);
    expect(r.money.variantsValued).toBe(1);
    expect(r.money.lost90).toBeCloseTo(10 * 4 * 10, 9); // 10 out days × 4/day × 10
    expect(r.money.atRisk).toBeCloseTo(4 * 28 * 10, 9); // out: demand(28) − 0 incoming
    expect(r.money.cashStuck).toBe(0); // inputs present, nothing too much / dead
    expect(r.money.soldOutTraffic).toBeNull(); // no sessions → unknown conversion
  });

  it("leaves out variants with no stock day in the last 7 days of M", () => {
    const data = store(
      [
        { id: "a", sold: () => 4 },
        { id: "b", sold: () => 4, missing: (d) => d >= "2026-07-20" && d <= "2026-07-31" },
      ],
      "2026-04-01",
      "2026-08-31",
    );
    const r = backtestMonth(data, M);
    expect(r.money.variantsValued).toBe(1);
    expect(r.money.variantsWithoutStock).toBe(1);
    expect(r.notes.some((n) => n.includes("left out of the money cards"))).toBe(true);
  });

  it("only tracked, active, non-bundle variants are considered", () => {
    const data = store([{ id: "a", sold: () => 4 }], "2026-04-01", "2026-08-31");
    data.variants = [
      ...data.variants,
      variant("bundle", 10, { isBundle: true }),
      variant("draft", 10, { status: "DRAFT" }),
      variant("untracked", 10, { tracked: false }),
    ];
    expect(backtestMonth(data, M).variantsConsidered).toBe(1);
  });
});

describe("backtest: months", () => {
  it("lists the months ending with --month, oldest first, across a year end", () => {
    expect(monthsEndingWith("2026-02", 3)).toEqual(["2025-12", "2026-01", "2026-02"]);
    expect(monthsEndingWith("2026-07", 1)).toEqual(["2026-07"]);
  });

  it("refuses a malformed month or count", () => {
    expect(() => monthFirstDay("2026-13")).toThrow();
    expect(() => monthFirstDay("2026-7")).toThrow();
    expect(() => monthsEndingWith("2026-07", 0)).toThrow();
  });
});

describe("backtest script arguments", async () => {
  const { parseArgs } = await import("../../scripts/backtest");
  it("needs a myshopify domain and a YYYY-MM month; --months defaults to 3", () => {
    expect(parseArgs(["--shop", "Brand.myshopify.com", "--month", "2026-07"])).toEqual({ shop: "brand.myshopify.com", month: "2026-07", months: 3 });
    expect(parseArgs(["--shop", "brand.myshopify.com", "--month", "2026-07", "--months", "6"]).months).toBe(6);
    expect(() => parseArgs(["--month", "2026-07"])).toThrow(/--shop/);
    expect(() => parseArgs(["--shop", "brand.com", "--month", "2026-07"])).toThrow(/--shop/);
    expect(() => parseArgs(["--shop", "brand.myshopify.com", "--month", "July"])).toThrow(/bad month/);
    expect(() => parseArgs(["--shop", "brand.myshopify.com", "--month", "2026-07", "--months", "0"])).toThrow(/--months/);
  });

  it("review fix: load() honours the 'counts for online sales' override (POS store added to the pool)", async () => {
    const { load } = await import("../../scripts/backtest");
    const { createFakePrisma } = await import("../helpers/fake-prisma");
    const db = createFakePrisma();
    const S = "brand.myshopify.com";
    const day = new Date("2026-07-10T00:00:00.000Z");
    db.tables.shop = [{ domain: S, currency: "EUR", settings: {}, backfillState: {} }];
    db.tables.location = [
      { id: "L1", shop: S, active: true, online: true, onlinePool: null },
      { id: "L2", shop: S, active: true, online: false, onlinePool: true }, // the merchant counts it
      { id: "L3", shop: S, active: true, online: true, onlinePool: false }, // the merchant leaves it out
    ];
    db.tables.variant = [];
    db.tables.supplier = [];
    db.tables.stockDaily = [
      { shop: S, day, variantId: "v", locationId: "L1", endUnits: 1, outOfStock: false },
      { shop: S, day, variantId: "v", locationId: "L2", endUnits: 10, outOfStock: false },
      { shop: S, day, variantId: "v", locationId: "L3", endUnits: 100, outOfStock: false },
    ];
    db.tables.salesDaily = [
      { shop: S, day, variantId: "v", locationKey: "L2", channel: "all", sold: 3, gross: 0 },
      { shop: S, day, variantId: "v", locationKey: "L3", channel: "all", sold: 30, gross: 0 },
    ];
    const { delegateFactsStore } = await import("../helpers/fake-facts");
    const data = await load(db.client as never, S, "2026-07-01", "2026-07-31", delegateFactsStore(db.client));
    expect(data.stock).toEqual([{ variantId: "v", day: "2026-07-10", endUnits: 11, reported: 2, outReported: 0 }]);
    expect(data.poolSales).toEqual([{ variantId: "v", day: "2026-07-10", sold: 3, gross: 0 }]);
  });

  it("review fix: every reader of the online pool selects the override (POOL_LOCATION_SELECT)", async () => {
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const root = new URL("../../", import.meta.url).pathname;
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx?$/.test(f)) files.push(p);
      }
    };
    walk(join(root, "app"));
    walk(join(root, "scripts"));
    const offenders = files.filter((f) => {
      const src = readFileSync(f, "utf8");
      return /poolLocationIds\(/.test(src) && /location\.findMany\(\{[^}]*select: \{ id: true, active: true, online: true \}/.test(src);
    });
    expect(offenders).toEqual([]);
  });

  it("never writes to the database", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../../scripts/backtest.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(|\$executeRaw|\$queryRaw|\$transaction/);
  });
});
