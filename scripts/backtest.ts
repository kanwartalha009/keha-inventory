/**
 * Backtest harness (spec §16, Phase 0 task 0.3): replay a store's own history up to the end of
 * month M, forecast M+1 with the real engine, compare with what really sold, and print the
 * money-at-stake numbers as of the end of M.
 *
 *   npx tsx scripts/backtest.ts --shop <domain> --month YYYY-MM [--months 3]
 *   npm run backtest -- --shop <domain> --month YYYY-MM [--months 3]
 *
 * --month is the newest history month M; --months N runs M−N+1 … M. A month whose forecast
 * month has not fully synced yet is reported as "not gradable" (its money numbers still show).
 *
 * Reads the app's own database (DATABASE_URL) for that shop: the store must have installed the
 * app, with consent, so its facts exist. READ-ONLY: this script never writes to the database.
 * Writes `backtest-<shop>-<YYYY-MM-DD>.json` in the current directory.
 *
 * The maths lives in app/lib/engine/backtest-shared.ts (pure, tested). This file only loads
 * facts the same way compute.server / season.server / accuracy.server do.
 */
import { writeFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import {
  backtestMonth,
  monthFirstDay,
  monthsEndingWith,
  summarize,
  type BacktestData,
  type BacktestMonthResult,
} from "../app/lib/engine/backtest-shared";
import { addDays } from "../app/lib/engine/dates-shared";
import { monthEnd, nextMonthStart } from "../app/lib/engine/accuracy-shared";
import { POOL_LOCATION_SELECT, engineSettingsFrom, poolLocationIds, poolSalesKeys, salesCoverage } from "../app/lib/compute-shared";
import { readSettings } from "../app/lib/settings-shared";
import { readBackfillState } from "../app/lib/sync/backfill-shared";
import { ALL, dayDate } from "../app/lib/sync/facts-shared";

/** History each replay reads: last year's base and trend windows (≈ 400 days) plus margin. */
const LOOKBACK_DAYS = 430;

type Args = { shop: string; month: string; months: number };

export function parseArgs(argv: readonly string[]): Args {
  const get = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const shop = (get("shop") ?? "").trim().toLowerCase();
  const month = (get("month") ?? "").trim();
  const months = get("months") === undefined ? 3 : Number(get("months"));
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)) throw new Error("--shop <store>.myshopify.com is required");
  monthFirstDay(month); // throws on a bad month
  if (!Number.isInteger(months) || months < 1 || months > 24) throw new Error("--months must be a whole number from 1 to 24");
  return { shop, month, months };
}

const dayKey = (d: Date) => d.toISOString().slice(0, 10);
const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
const numOrNull = (v: unknown) => (v === null || v === undefined ? null : Number(v));

export async function load(prisma: PrismaClient, shop: string, from: string, to: string): Promise<BacktestData> {
  const shopRow = await prisma.shop.findUnique({
    where: { domain: shop },
    select: { currency: true, settings: true, backfillState: true },
  });
  if (!shopRow) throw new Error(`no data for ${shop}: the store has not installed the app on this database`);
  const [locations, variants, suppliers] = await Promise.all([
    prisma.location.findMany({ where: { shop }, select: POOL_LOCATION_SELECT }),
    prisma.variant.findMany({
      where: { shop },
      select: {
        id: true,
        productId: true,
        productTitle: true,
        variantTitle: true,
        handle: true,
        vendor: true,
        collections: true,
        tracked: true,
        isBundle: true,
        status: true,
        price: true,
        cost: true,
        productCreatedAt: true,
        caseQty: true,
        supplierId: true,
      },
    }),
    prisma.supplier.findMany({
      where: { shop },
      select: { id: true, name: true, leadTimeDays: true, minOrder: true, minOrderTotal: true, casePack: true, vendorMatch: true },
    }),
  ]);
  const pool = poolLocationIds(locations);
  const poolKeys = poolSalesKeys(pool);
  const range = { gte: dayDate(from), lte: dayDate(to) };

  const [poolG, channelG, stockG, outG, lastSaleG, firstStockG, sessionsG, shopDays] = await Promise.all([
    prisma.salesDaily.groupBy({
      by: ["variantId", "day"],
      where: { shop, channel: ALL, locationKey: { in: poolKeys }, day: range },
      _sum: { sold: true },
    }),
    prisma.salesDaily.groupBy({
      by: ["variantId", "day"],
      where: { shop, locationKey: ALL, day: range },
      _sum: { sold: true, gross: true },
    }),
    pool.length
      ? prisma.stockDaily.groupBy({
          by: ["variantId", "day"],
          where: { shop, locationId: { in: pool }, day: range },
          _sum: { endUnits: true },
          _count: { _all: true },
        })
      : Promise.resolve([]),
    pool.length
      ? prisma.stockDaily.groupBy({
          by: ["variantId", "day"],
          where: { shop, locationId: { in: pool }, day: range, outOfStock: true },
          _count: { _all: true },
        })
      : Promise.resolve([]),
    prisma.salesDaily.groupBy({
      by: ["variantId"],
      where: { shop, channel: ALL, locationKey: { in: poolKeys }, sold: { gt: 0 }, day: { lt: dayDate(from) } },
      _max: { day: true },
    }),
    pool.length
      ? prisma.stockDaily.groupBy({ by: ["variantId"], where: { shop, locationId: { in: pool } }, _min: { day: true } })
      : Promise.resolve([]),
    prisma.sessionsDaily.groupBy({ by: ["landingPath", "day"], where: { shop, day: range }, _sum: { sessions: true, checkouts: true } }),
    prisma.shopDaily.findMany({ where: { shop, day: range }, select: { day: true, orders: true, gross: true } }),
  ]);
  const outCount = new Map(outG.map((g) => [`${g.variantId}|${dayKey(g.day)}`, g._count._all]));
  return {
    currency: shopRow.currency,
    settings: engineSettingsFrom(readSettings(shopRow.settings)),
    trendMode: readSettings(shopRow.settings).trendMode,
    coverage: salesCoverage(readBackfillState(shopRow.backfillState)),
    variants: variants.map((v) => ({
      id: v.id,
      productId: v.productId,
      title: v.variantTitle && v.variantTitle !== "Default Title" ? `${v.productTitle} — ${v.variantTitle}` : v.productTitle,
      handle: v.handle,
      vendor: v.vendor,
      collections: v.collections ?? [],
      tracked: v.tracked,
      isBundle: v.isBundle,
      status: v.status,
      price: numOrNull(v.price),
      cost: numOrNull(v.cost),
      productCreatedAt: v.productCreatedAt ? v.productCreatedAt.toISOString() : null,
      caseQty: v.caseQty,
      supplierId: v.supplierId,
    })),
    suppliers,
    poolSales: poolG.map((g) => ({ variantId: g.variantId, day: dayKey(g.day), sold: num(g._sum.sold), gross: 0 })),
    channelSales: channelG.map((g) => ({ variantId: g.variantId, day: dayKey(g.day), sold: num(g._sum.sold), gross: num(g._sum.gross) })),
    stock: stockG.map((g) => ({
      variantId: g.variantId,
      day: dayKey(g.day),
      endUnits: num(g._sum.endUnits),
      reported: g._count._all,
      outReported: outCount.get(`${g.variantId}|${dayKey(g.day)}`) ?? 0,
    })),
    sessions: sessionsG.map((g) => ({ landingPath: g.landingPath, day: dayKey(g.day), sessions: num(g._sum.sessions), checkouts: num(g._sum.checkouts) })),
    shopDays: shopDays.map((d) => ({ day: dayKey(d.day), orders: d.orders, gross: num(d.gross) })),
    lastSaleBefore: new Map(lastSaleG.filter((g) => g._max.day).map((g) => [g.variantId, dayKey(g._max.day!)])),
    firstStockDay: new Map(firstStockG.filter((g) => g._min.day).map((g) => [g.variantId, dayKey(g._min.day!)])),
  };
}

const pct = (x: number | null | undefined) => (typeof x === "number" ? `${x.toFixed(1)}%` : "—");
const units = (x: number | null | undefined) => (typeof x === "number" ? x.toFixed(1) : "—");
const money = (x: number | null, currency: string) =>
  x === null ? "—" : new Intl.NumberFormat("en", { style: "currency", currency, maximumFractionDigits: 0 }).format(x);
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n));

function print(r: BacktestMonthResult): void {
  console.log(`\n=== ${r.month} → forecast ${r.forecastMonth} (as of ${r.asOf}) — ${r.status}${r.reason ? ` (${r.reason})` : ""}`);
  console.log(
    `Variants: ${r.variantsConsidered} considered, ${r.variantsForecast} with a forecast. ` +
      `Seasonal ${r.season.seasonal.toFixed(2)} (${r.season.seasonalApplied ? "applied" : r.season.seasonalReason}), trend ${r.season.trend.toFixed(2)}.`,
  );
  console.log(`Store total: predicted ${units(r.store?.predicted)}, actual ${units(r.store?.actual)}, error ${pct(r.store?.absPctError)}`);
  console.log(`Top 20 by revenue in ${r.month}: mean error ${pct(r.top20.meanAbsPctError)} over ${r.top20.graded} graded`);
  if (r.top20.rows.length) {
    console.log(`  ${"Variant".padEnd(44)} ${"Predicted".padStart(10)} ${"Actual".padStart(8)} ${"Error".padStart(8)}`);
    for (const row of r.top20.rows)
      console.log(`  ${cut(row.title, 44)} ${units(row.predicted).padStart(10)} ${String(row.actual).padStart(8)} ${pct(row.absPctError).padStart(8)}`);
  }
  const m = r.money;
  console.log(
    `Money at the end of ${r.month}: sales at risk ${money(m.atRisk, m.currency)} · lost to sell-outs ${money(m.lost90, m.currency)} · ` +
      `cash stuck ${money(m.cashStuck, m.currency)} · sold-out page visits ${money(m.soldOutTraffic, m.currency)}`,
  );
  for (const n of r.notes) console.log(`  note: ${n}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const months = monthsEndingWith(args.month, args.months);
  // From the oldest replay's look-back to the end of the newest forecast month.
  const from = addDays(nextMonthStart(monthFirstDay(months[0])), -LOOKBACK_DAYS);
  const to = monthEnd(nextMonthStart(monthFirstDay(months[months.length - 1])));
  const prisma = new PrismaClient();
  try {
    const data = await load(prisma, args.shop, from, to);
    const results = months.map((m) => backtestMonth(data, m));
    results.forEach(print);
    const summary = summarize(results);
    console.log(
      `\nSummary: ${summary.gradedMonths}/${summary.months} month(s) graded · top-20 mean error ${pct(summary.top20MeanAbsPctError)} · store mean error ${pct(summary.storeMeanAbsPctError)}`,
    );
    const runDay = new Date().toISOString().slice(0, 10);
    const file = `backtest-${args.shop}-${runDay}.json`;
    writeFileSync(file, JSON.stringify({ shop: args.shop, ranAt: new Date().toISOString(), months, summary, results }, null, 2));
    console.log(`Wrote ${file}`);
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && /backtest\.ts$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error(`[backtest] ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
