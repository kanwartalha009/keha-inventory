/**
 * One dataset × date range: ShopifyQL → daily fact tables (task 1.4b). Shared by the
 * backfill and the nightly job.
 *
 * Idempotent: each range is written as "delete the shop's rows in [since, until], insert
 * the fresh rows" in one transaction, so re-running a month yields identical rows and a
 * correction from Shopify replaces the old figure.
 *
 * Complete or nothing (audit 2026-10-17 C1 / M10): every client read pages through ALL rows
 * (unique ORDER BY key + LIMIT / OFFSET, de-duplicated); RESPONSE_TOO_LARGE first shrinks the
 * page, then halves the date range (runChunked); the row cap splits the range too (DB scale #1).
 * Stock is streamed and written a few days at a time (storeStock): each part is complete or
 * nothing, and the month is never held in memory. Sales are reconciled per day against the
 * store's daily units total before anything is written; a truncated read
 * (ShopifyqlTruncatedError) or a mismatch (ShopifyqlReconcileError) throws, the transaction
 * never runs, and the caller records a retryable failure. Throttling surfaces as
 * ShopifyqlThrottledError (or ThrottleBudgetError) for the caller to stop on.
 * Only whole past days are written (builders refuse `until >= today`, and every row outside
 * the range is dropped — invariant I-12).
 */
import prisma from "../../db.server";
import type { ShopifyqlClient } from "./shopifyql.server";
import {
  ShopifyqlParseError,
  ShopifyqlReconcileError,
  addDays,
  assertReconciled,
  forEachChunk,
  isRowCapError,
  isTooLargeError,
  runChunked,
  unitsByDay,
  type BuildOptions,
  type ChunkOptions,
  type DayRange,
  type ParseResult,
  type SalesRow,
  type StockRow,
} from "../../lib/sync/shopifyql-shared";
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
/**
 * Stock rows held before the complete days are written (DB scale #1). A large store's month of
 * stock (millions of rows: variants × locations × days) is written a few days at a time; memory
 * stays near this many rows plus one day, whatever the month holds.
 */
export const STOCK_CHUNK_ROWS = 250_000;

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
  opts: ChunkOptions = {},
) {
  const parts = await runChunked(range, (r) => run(r), opts);
  const rows: T[] = [];
  const unattributed: Record<string, number> = {};
  let skipped = 0;
  let duplicates = 0;
  for (const p of parts) {
    assertColumns(label, p.result, required);
    rows.push(...p.result.rows);
    skipped += p.result.skipped;
    duplicates += p.result.duplicates ?? 0;
    for (const [day, u] of Object.entries(p.result.unattributed ?? {})) unattributed[day] = (unattributed[day] ?? 0) + u;
  }
  if (duplicates) console.warn(`[sync/facts] ${label} ${range.since}..${range.until}: ${duplicates} duplicate row(s) across pages replaced, not added`);
  return { rows, skipped, unattributed };
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

/**
 * Stock history: ending units and out-of-stock flag per variant × location × day.
 *
 * Streamed (DB scale #1): the read hands complete days over every STOCK_CHUNK_ROWS rows and each
 * part is written at once — its own transaction, "delete the shop's rows in that part's days,
 * insert the fresh rows" — so the month is never held in memory and a month of 3.7 M rows
 * finishes. A part is complete in itself (every page of those days read, de-duplicated); a
 * failure later in the month leaves the earlier parts written, and the retry rewrites them
 * (idempotent). RESPONSE_TOO_LARGE or the row cap split the date range (forEachChunk); a single
 * day over the cap fails clearly (ShopifyqlDayTooLargeError).
 */
export async function storeStock(
  shop: string,
  ql: ShopifyqlClient,
  range: DayRange,
  today: string,
  locations: LocationRef[],
): Promise<StoreResult> {
  const index = locationNameIndex(locations);
  const unmapped = new Set<string>();
  let rows = 0;
  let skipped = 0;
  let duplicates = 0;
  const write = async (part: DayRange, r: ParseResult<StockRow>) => {
    assertColumns("stock", r, ["ending_inventory_units_at_location", "days_out_of_stock_at_location"]);
    const { facts, unmapped: u } = stockFacts(r.rows, part, index);
    for (const name of u) unmapped.add(name);
    await prisma.$transaction([
      prisma.stockDaily.deleteMany({ where: dayWhere(shop, part) }),
      ...batches(facts).map((b) =>
        prisma.stockDaily.createMany({ data: b.map((f) => ({ shop, ...f, day: dayDate(f.day) })) }),
      ),
    ]);
    rows += facts.length;
    skipped += r.skipped;
  };
  await forEachChunk(
    range,
    async (sub) => {
      // Parts of `sub` already written by this read (the last one comes back as the result).
      let cursor = sub.since;
      const last = await ql.stockDaily(sub, today, undefined, {
        rows: STOCK_CHUNK_ROWS,
        onChunk: async (part, through) => {
          await write({ since: cursor, until: through }, part);
          cursor = addDays(through, 1);
        },
      });
      duplicates += last.duplicates ?? 0;
      return { since: cursor, until: sub.until, last };
    },
    (_sub, { since, until, last }) => write({ since, until }, last),
  );
  if (duplicates) console.warn(`[sync/facts] stock ${range.since}..${range.until}: ${duplicates} duplicate row(s) across pages replaced, not added`);
  return { rows, skipped, unmapped: [...unmapped] };
}

/**
 * Sales history: the location view and the channel view (see facts-shared). Both are
 * reconciled per day against the store's units total (one cheap query per range) before the
 * write; a mismatch throws ShopifyqlReconcileError and nothing is stored for the range.
 * Past the row cap (DB scale #1) the whole step is split by date (forEachChunk, right after the
 * capped view's last complete day, else halves): each part is read, reconciled and written on
 * its own, so memory stays bounded and a part never waits for the rest of the month.
 * TODO: one 3-dimension query (buildDailySalesQuery, verified live 2026-10-17) once
 * SalesDaily drops the two views.
 */
export async function storeSales(
  shop: string,
  ql: ShopifyqlClient,
  range: DayRange,
  today: string,
  locations: LocationRef[],
): Promise<StoreResult> {
  const out: StoreResult = { rows: 0, skipped: 0, unmapped: [] };
  await forEachChunk(
    range,
    (part) => storeSalesRange(shop, ql, part, today, locations),
    (_part, r) => {
      out.rows += r.rows;
      out.skipped += r.skipped;
      for (const u of r.unmapped) if (!out.unmapped.includes(u)) out.unmapped.push(u);
    },
    { splitOn: isRowCapError },
  );
  return out;
}

/** One sales range: read both views and the totals, reconcile, write in one transaction. */
async function storeSalesRange(
  shop: string,
  ql: ShopifyqlClient,
  range: DayRange,
  today: string,
  locations: LocationRef[],
): Promise<StoreResult> {
  // The row cap is left to storeSales (it splits the whole step); RESPONSE_TOO_LARGE still
  // splits each view here, as before.
  const tooLargeOnly: ChunkOptions = { splitOn: isTooLargeError };
  const byLocation = await chunked(
    range,
    (r, o) => ql.salesDailyByLocation(r, today, o),
    "sales by location",
    ["pos_location_name", "net_items_sold"],
    tooLargeOnly,
  );
  // Returns (task 2.4, fix_returns): ask for quantity_returned too — verified live 2026-10-17 with
  // this grouping (audit L6). The parse-error fallback (returned = 0, no returns actions) stays as
  // a safety net should Shopify ever reject the column.
  const channelQuery = (returns: boolean) =>
    chunked(
      range,
      (r, o) => ql.salesDailyByChannel(r, today, returns ? { ...o, returns: true } : o),
      "sales by channel",
      ["sales_channel", "net_items_sold", "gross_sales"],
      tooLargeOnly,
    );
  let byChannel: Awaited<ReturnType<typeof channelQuery>>;
  try {
    byChannel = await channelQuery(true);
  } catch (e) {
    if (!(e instanceof ShopifyqlParseError)) throw e;
    console.warn(`[sync/sales] ${shop}: quantity_returned rejected (${e.messages.join("; ")}); storing sales without returns`);
    byChannel = await channelQuery(false);
  }
  const totals = await chunked(range, (r) => ql.salesTotalsDaily(r, today), "sales totals", ["net_items_sold"], tooLargeOnly);
  const expected = new Map<string, number>();
  for (const t of totals.rows) expected.set(t.day, (expected.get(t.day) ?? 0) + t.sold);
  reconcileSales(shop, "sales by location", byLocation, expected, range);
  reconcileSales(shop, "sales by channel", byChannel, expected, range);
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

/** Throws (and logs) when a sales view's units per day differ from the store total. */
function reconcileSales(
  shop: string,
  label: string,
  view: { rows: SalesRow[]; unattributed: Record<string, number> },
  expected: ReadonlyMap<string, number>,
  range: DayRange,
): void {
  try {
    assertReconciled(label, unitsByDay(view), expected, range);
  } catch (e) {
    if (e instanceof ShopifyqlReconcileError) {
      console.error(`[sync/sales] ${shop} ${range.since}..${range.until}: ${e.message} — nothing stored for this range`);
    }
    throw e;
  }
}

/** Store totals (orders, gross) per day, for AOV. Its own dataset: never blocks sales. */
export async function storeTotals(shop: string, ql: ShopifyqlClient, range: DayRange, today: string): Promise<StoreResult> {
  const totals = await chunked(range, (r, o) => ql.shopDaily(r, today, o), "shop totals", ["orders", "gross_sales"]);
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
