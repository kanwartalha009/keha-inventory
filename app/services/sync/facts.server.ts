/**
 * One dataset × date range: ShopifyQL → daily fact tables (task 1.4b). Shared by the
 * backfill and the nightly job.
 *
 * Idempotent: each range is written as "delete the shop's rows in [since, until], insert
 * the fresh rows" in one transaction, so re-running a month yields identical rows and a
 * correction from Shopify replaces the old figure. RESPONSE_TOO_LARGE halves the range
 * (runChunked); throttling surfaces as ShopifyqlThrottledError for the caller to stop on.
 * Only whole past days are written (builders refuse `until >= today`, and every row outside
 * the range is dropped — invariant I-12).
 */
import prisma from "../../db.server";
import { runChunked, type ShopifyqlClient } from "./shopifyql.server";
import type { DayRange, ParseResult } from "../../lib/sync/shopifyql-shared";
import {
  dayDate,
  locationNameIndex,
  salesByChannelFacts,
  salesByLocationFacts,
  sessionsFacts,
  shopDayFacts,
  stockFacts,
  type LocationRef,
} from "../../lib/sync/facts-shared";
import type { HistoryDataset } from "../../lib/sync/backfill-shared";
import { retentionCutoff } from "../../lib/sync/store-time-shared";

const INSERT_BATCH = 5000;

export class ShopifyqlShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShopifyqlShapeError";
  }
}

/** Fails when an expected column is absent from a non-empty result (the query changed shape). */
function assertColumns<T>(label: string, r: ParseResult<T>, required: string[]): void {
  if (r.rows.length + r.skipped === 0) return;
  const missing = required.filter((c) => r.missingColumns.includes(c));
  if (missing.length) throw new ShopifyqlShapeError(`${label}: ShopifyQL result has no ${missing.join(", ")} column`);
}

async function chunked<T>(range: DayRange, run: (r: DayRange) => Promise<ParseResult<T>>, label: string, required: string[]) {
  const parts = await runChunked(range, run);
  const rows: T[] = [];
  let skipped = 0;
  for (const p of parts) {
    assertColumns(label, p.result, required);
    rows.push(...p.result.rows);
    skipped += p.result.skipped;
  }
  return { rows, skipped };
}

function batches<T>(rows: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += INSERT_BATCH) out.push(rows.slice(i, i + INSERT_BATCH));
  return out;
}

const dayWhere = (shop: string, range: DayRange) => ({
  shop,
  day: { gte: dayDate(range.since), lte: dayDate(range.until) },
});

export type StoreResult = { rows: number; skipped: number; unmapped: string[] };

export async function loadLocations(shop: string): Promise<LocationRef[]> {
  return prisma.location.findMany({ where: { shop }, select: { id: true, name: true, active: true } });
}

/** Stock history: ending units and out-of-stock flag per variant × location × day. */
export async function storeStock(
  shop: string,
  ql: ShopifyqlClient,
  range: DayRange,
  today: string,
  locations: LocationRef[],
): Promise<StoreResult> {
  const { rows, skipped } = await chunked(
    range,
    (r) => ql.stockDaily(r, today),
    "stock",
    ["ending_inventory_units_at_location", "days_out_of_stock_at_location"],
  );
  const { facts, unmapped } = stockFacts(rows, range, locationNameIndex(locations));
  await prisma.$transaction([
    prisma.stockDaily.deleteMany({ where: dayWhere(shop, range) }),
    ...batches(facts).map((b) =>
      prisma.stockDaily.createMany({ data: b.map((f) => ({ shop, ...f, day: dayDate(f.day) })) }),
    ),
  ]);
  return { rows: facts.length, skipped, unmapped };
}

/**
 * Sales history: the location view and the channel view (see facts-shared), plus store
 * totals (orders, gross) for AOV.
 * TODO(task 1.4 verification): one 3-dimension query (buildDailySalesQuery) once verified.
 */
export async function storeSales(
  shop: string,
  ql: ShopifyqlClient,
  range: DayRange,
  today: string,
  locations: LocationRef[],
): Promise<StoreResult> {
  const byLocation = await chunked(range, (r) => ql.salesDailyByLocation(r, today), "sales by location", [
    "pos_location_name",
    "net_items_sold",
  ]);
  const byChannel = await chunked(range, (r) => ql.salesDailyByChannel(r, today), "sales by channel", [
    "sales_channel",
    "net_items_sold",
    "gross_sales",
  ]);
  const totals = await chunked(range, (r) => ql.shopDaily(r, today), "shop totals", ["orders", "gross_sales"]);

  const loc = salesByLocationFacts(byLocation.rows, range, locationNameIndex(locations));
  const ch = salesByChannelFacts(byChannel.rows, range);
  const facts = [...loc.facts, ...ch];
  const shopDays = shopDayFacts(totals.rows, range);
  await prisma.$transaction([
    prisma.salesDaily.deleteMany({ where: dayWhere(shop, range) }),
    ...batches(facts).map((b) =>
      prisma.salesDaily.createMany({ data: b.map((f) => ({ shop, ...f, day: dayDate(f.day) })) }),
    ),
    prisma.shopDaily.deleteMany({ where: dayWhere(shop, range) }),
    prisma.shopDaily.createMany({ data: shopDays.map((f) => ({ shop, ...f, day: dayDate(f.day) })) }),
  ]);
  return { rows: facts.length + shopDays.length, skipped: byLocation.skipped + byChannel.skipped + totals.skipped, unmapped: loc.unmapped };
}

/** Store visits by landing page. */
export async function storeVisits(shop: string, ql: ShopifyqlClient, range: DayRange, today: string): Promise<StoreResult> {
  const { rows, skipped } = await chunked(range, (r) => ql.sessionsDaily(r, today), "sessions", [
    "landing_page_path",
    "sessions",
    "sessions_that_completed_checkout",
  ]);
  const facts = sessionsFacts(rows, range);
  await prisma.$transaction([
    prisma.sessionsDaily.deleteMany({ where: dayWhere(shop, range) }),
    ...batches(facts).map((b) =>
      prisma.sessionsDaily.createMany({ data: b.map((f) => ({ shop, ...f, day: dayDate(f.day) })) }),
    ),
  ]);
  return { rows: facts.length, skipped, unmapped: [] };
}

export async function storeHistory(
  dataset: HistoryDataset,
  shop: string,
  ql: ShopifyqlClient,
  range: DayRange,
  today: string,
  locations: LocationRef[],
): Promise<StoreResult> {
  if (dataset === "stock") return storeStock(shop, ql, range, today, locations);
  if (dataset === "sales") return storeSales(shop, ql, range, today, locations);
  return storeVisits(shop, ql, range, today);
}

/**
 * Retention (spec §8): daily facts older than 25 months are deleted.
 * TODO(phase 2): roll them up monthly before deleting.
 */
export async function applyRetention(shop: string, today: string): Promise<number> {
  const where = { shop, day: { lt: dayDate(retentionCutoff(today)) } };
  const r = await prisma.$transaction([
    prisma.salesDaily.deleteMany({ where }),
    prisma.stockDaily.deleteMany({ where }),
    prisma.sessionsDaily.deleteMany({ where }),
    prisma.shopDaily.deleteMany({ where }),
  ]);
  return r.reduce((a, x) => a + x.count, 0);
}
