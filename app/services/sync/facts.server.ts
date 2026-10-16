/**
 * One dataset × date range: ShopifyQL → daily fact tables (task 1.4b). Shared by the
 * backfill and the nightly job.
 *
 * Idempotent: each range is written as "delete the shop's rows in [since, until], insert
 * the fresh rows" in one transaction, so re-running a month yields identical rows and a
 * correction from Shopify replaces the old figure. RESPONSE_TOO_LARGE halves the range
 * (runChunked); a single day that is still too large is paged with ORDER BY / LIMIT /
 * OFFSET (runChunkedPaged, syntax TO VERIFY on a dev store). Throttling surfaces as
 * ShopifyqlThrottledError (or ThrottleBudgetError) for the caller to stop on.
 * Only whole past days are written (builders refuse `until >= today`, and every row outside
 * the range is dropped — invariant I-12).
 */
import prisma from "../../db.server";
import type { ShopifyqlClient } from "./shopifyql.server";
import { ShopifyqlParseError, runChunkedPaged, type BuildOptions, type DayRange, type ParseResult } from "../../lib/sync/shopifyql-shared";
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

async function chunked<T>(
  range: DayRange,
  run: (r: DayRange, opts?: BuildOptions) => Promise<ParseResult<T>>,
  label: string,
  required: string[],
  orderBy: string,
) {
  const parts = await runChunkedPaged(range, run, orderBy);
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
    (r, o) => ql.stockDaily(r, today, o),
    "stock",
    ["ending_inventory_units_at_location", "days_out_of_stock_at_location"],
    "product_variant_id",
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
 * Sales history: the location view and the channel view (see facts-shared).
 * TODO(task 1.4 verification): one 3-dimension query (buildDailySalesQuery) once verified.
 */
export async function storeSales(
  shop: string,
  ql: ShopifyqlClient,
  range: DayRange,
  today: string,
  locations: LocationRef[],
): Promise<StoreResult> {
  const byLocation = await chunked(
    range,
    (r, o) => ql.salesDailyByLocation(r, today, o),
    "sales by location",
    ["pos_location_name", "net_items_sold"],
    "product_variant_id",
  );
  // Returns (task 2.4, fix_returns): ask for quantity_returned too. TO VERIFY on a dev store; if
  // ShopifyQL rejects the column with this grouping, fall back to the verified query (returned = 0,
  // and the engine then produces no returns actions).
  const channelQuery = (returns: boolean) =>
    chunked(
      range,
      (r, o) => ql.salesDailyByChannel(r, today, returns ? { ...o, returns: true } : o),
      "sales by channel",
      ["sales_channel", "net_items_sold", "gross_sales"],
      "product_variant_id",
    );
  let byChannel: Awaited<ReturnType<typeof channelQuery>>;
  try {
    byChannel = await channelQuery(true);
  } catch (e) {
    if (!(e instanceof ShopifyqlParseError)) throw e;
    console.warn(`[sync/sales] ${shop}: quantity_returned rejected (${e.messages.join("; ")}); storing sales without returns`);
    byChannel = await channelQuery(false);
  }
  const loc = salesByLocationFacts(byLocation.rows, range, locationNameIndex(locations));
  const facts = [...loc.facts, ...salesByChannelFacts(byChannel.rows, range)];
  await prisma.$transaction([
    prisma.salesDaily.deleteMany({ where: dayWhere(shop, range) }),
    ...batches(facts).map((b) =>
      prisma.salesDaily.createMany({ data: b.map((f) => ({ shop, ...f, day: dayDate(f.day) })) }),
    ),
  ]);
  return { rows: facts.length, skipped: byLocation.skipped + byChannel.skipped, unmapped: loc.unmapped };
}

/** Store totals (orders, gross) per day, for AOV. Its own dataset: never blocks sales. */
export async function storeTotals(shop: string, ql: ShopifyqlClient, range: DayRange, today: string): Promise<StoreResult> {
  const totals = await chunked(range, (r, o) => ql.shopDaily(r, today, o), "shop totals", ["orders", "gross_sales"], "day");
  const shopDays = shopDayFacts(totals.rows, range);
  await prisma.$transaction([
    prisma.shopDaily.deleteMany({ where: dayWhere(shop, range) }),
    prisma.shopDaily.createMany({ data: shopDays.map((f) => ({ shop, ...f, day: dayDate(f.day) })) }),
  ]);
  return { rows: shopDays.length, skipped: totals.skipped, unmapped: [] };
}

/** Store visits by landing page. */
export async function storeVisits(shop: string, ql: ShopifyqlClient, range: DayRange, today: string): Promise<StoreResult> {
  const { rows, skipped } = await chunked(
    range,
    (r, o) => ql.sessionsDaily(r, today, o),
    "sessions",
    ["landing_page_path", "sessions", "sessions_that_completed_checkout"],
    "landing_page_path",
  );
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
  if (dataset === "totals") return storeTotals(shop, ql, range, today);
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
