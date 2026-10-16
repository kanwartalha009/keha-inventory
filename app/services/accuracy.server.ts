/**
 * Forecast accuracy, data side (spec §6.6 "accuracy", §7.8). Runs from the hourly scheduler;
 * every step is idempotent, so a second run in the same hour (or a restart) changes nothing.
 *
 * Per installed shop, on the store's clock:
 *  - Snapshot (on the 1st only): when ForecastSnapshot has no row for this month yet and the
 *    latest VariantMetric run is fresh (≤ 36 h old), write predicted units for the month per
 *    variant with a rate (rate × seasonal-for-this-month × trend × days in month) plus the
 *    "__store__" total. createMany skipDuplicates: the first snapshot of a month is kept.
 *  - Grade last month (any day, once): when last month has snapshot rows, no AccuracyMonth row
 *    yet, and the sales history reaches last month's final day. Fills ForecastSnapshot.actual
 *    from SalesDaily — the online pool LOCATION view only (channel "all", locationKey in the
 *    pool keys), never added to the channel view — and writes AccuracyMonth. Revenue for the
 *    top-20 ranking comes from the channel view (locationKey "all") on its own.
 */
import prisma from "../db.server";
import {
  daysInMonth,
  gradeMonth,
  monthEnd,
  monthStart,
  previousMonthStart,
  snapshotRows,
} from "../lib/engine/accuracy-shared";
import { spanStats } from "../lib/engine/season-shared";
import { POOL_LOCATION_SELECT, poolLocationIds, poolSalesKeys, salesCoverage } from "../lib/compute-shared";
import { readBackfillState } from "../lib/sync/backfill-shared";
import { ALL, dayDate } from "../lib/sync/facts-shared";
import { localDate, safeTimeZone } from "../lib/sync/store-time-shared";
import { loadSeasonContext } from "./season.server";

const FRESH_MS = 36 * 60 * 60 * 1000;
const WRITE_BATCH = 200;

export type AccuracyResult = {
  status: "ok" | "skipped";
  snapshot?: "written" | "exists" | "not_due" | "stale_metrics" | "no_data";
  grade?: "written" | "exists" | "waiting" | "no_snapshot";
};

const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));

export async function runAccuracy(shop: string, now: Date = new Date()): Promise<AccuracyResult> {
  const row = await prisma.shop.findUnique({
    where: { domain: shop },
    select: { timezone: true, backfillState: true, uninstalledAt: true },
  });
  if (!row || row.uninstalledAt) return { status: "skipped" };
  const today = localDate(now, safeTimeZone(row.timezone));
  const coverage = salesCoverage(readBackfillState(row.backfillState));
  const locations = await prisma.location.findMany({ where: { shop }, select: POOL_LOCATION_SELECT });
  const poolKeys = poolSalesKeys(poolLocationIds(locations));
  return {
    status: "ok",
    snapshot: await snapshotMonth(shop, today, now, poolKeys, coverage),
    grade: await gradeLastMonth(shop, today, poolKeys, coverage),
  };
}

async function snapshotMonth(
  shop: string,
  today: string,
  now: Date,
  poolKeys: string[],
  coverage: ReturnType<typeof salesCoverage>,
): Promise<AccuracyResult["snapshot"]> {
  if (today.slice(8, 10) !== "01") return "not_due";
  const month = monthStart(today);
  const existing = await prisma.forecastSnapshot.count({ where: { shop, month: dayDate(month) } });
  if (existing > 0) return "exists";
  const metrics = await prisma.variantMetric.findMany({
    where: { shop, scope: "online" },
    select: { variantId: true, rate: true, computedAt: true },
  });
  if (!metrics.length) return "no_data";
  const latest = metrics.reduce((m, x) => Math.max(m, x.computedAt.getTime()), 0);
  if (now.getTime() - latest > FRESH_MS) return "stale_metrics";
  const variants = await prisma.variant.findMany({ where: { shop }, select: { id: true, collections: true } });
  const collectionsOf = new Map(variants.map((v) => [v.id, v.collections ?? []]));
  const days = daysInMonth(month);
  const season = await loadSeasonContext(shop, {
    today,
    poolKeys,
    variants: variants.map((v) => ({ id: v.id, collections: v.collections ?? [] })),
    coverage,
    maxHorizonDays: days,
  });
  const rows = snapshotRows(
    metrics.map((m) => {
      const s = season.forVariant(collectionsOf.get(m.variantId) ?? [], days);
      return { variantId: m.variantId, rate: m.rate, seasonal: s.seasonal, trend: s.trend };
    }),
    month,
  );
  if (!rows.length) return "no_data";
  for (let i = 0; i < rows.length; i += 5000) {
    await prisma.forecastSnapshot.createMany({
      data: rows.slice(i, i + 5000).map((r) => ({ shop, month: dayDate(month), variantId: r.variantId, predicted: r.predicted })),
      skipDuplicates: true,
    });
  }
  return "written";
}

async function gradeLastMonth(
  shop: string,
  today: string,
  poolKeys: string[],
  coverage: ReturnType<typeof salesCoverage>,
): Promise<AccuracyResult["grade"]> {
  const month = previousMonthStart(today);
  const end = monthEnd(month);
  const done = await prisma.accuracyMonth.findUnique({ where: { shop_month: { shop, month: dayDate(month) } }, select: { shop: true } });
  if (done) return "exists";
  const snapshot = await prisma.forecastSnapshot.findMany({
    where: { shop, month: dayDate(month) },
    select: { variantId: true, predicted: true },
  });
  if (!snapshot.length) return "no_snapshot";
  if (!coverage.to || coverage.to < end) return "waiting";
  const covered = spanStats({ units: new Map(), coverage }, month, end).coverage;
  const days = { gte: dayDate(month), lte: dayDate(end) };
  const [unitsG, revenueG] = await Promise.all([
    prisma.salesDaily.groupBy({
      by: ["variantId"],
      where: { shop, channel: ALL, locationKey: { in: poolKeys }, day: days },
      _sum: { sold: true },
    }),
    prisma.salesDaily.groupBy({
      by: ["variantId"],
      where: { shop, locationKey: ALL, day: days },
      _sum: { gross: true },
    }),
  ]);
  const g = gradeMonth({
    snapshot,
    actualUnits: new Map(unitsG.map((x) => [x.variantId, num(x._sum.sold)])),
    revenue: new Map(revenueG.map((x) => [x.variantId, num(x._sum.gross)])),
    coverage: covered,
  });
  const updates = [...g.actual];
  for (let i = 0; i < updates.length; i += WRITE_BATCH) {
    await prisma.$transaction(
      updates.slice(i, i + WRITE_BATCH).map(([variantId, actual]) =>
        prisma.forecastSnapshot.update({
          where: { shop_month_variantId: { shop, month: dayDate(month), variantId } },
          data: { actual },
        }),
      ),
    );
  }
  const data = { storeErrorPct: g.storeErrorPct, top20ErrorPct: g.top20ErrorPct, graded: g.graded, computedAt: new Date() };
  await prisma.accuracyMonth.upsert({
    where: { shop_month: { shop, month: dayDate(month) } },
    create: { shop, month: dayDate(month), ...data },
    update: data,
  });
  return "written";
}

let running = false;

/** Hourly from the scheduler: every installed shop. Never throws; overlap-guarded. */
export async function runAccuracyAllShops(now: Date = new Date()): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  if (running) return { overlap: 1 };
  running = true;
  try {
    const shops = await prisma.shop.findMany({ where: { uninstalledAt: null }, select: { domain: true } });
    for (const { domain } of shops) {
      try {
        const r = await runAccuracy(domain, now);
        const k = `${r.snapshot ?? r.status}/${r.grade ?? "-"}`;
        counts[k] = (counts[k] ?? 0) + 1;
      } catch (e) {
        counts.error = (counts.error ?? 0) + 1;
        console.error(`[accuracy] ${domain}`, e);
      }
    }
    if (Object.keys(counts).some((k) => k.includes("written") || k === "error")) console.log(`[accuracy] ${JSON.stringify(counts)}`);
  } catch (e) {
    console.error("[accuracy]", e);
  } finally {
    running = false;
  }
  return counts;
}
