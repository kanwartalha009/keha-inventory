/**
 * ShopifyQL data layer — pure part (spec §6.1/§6.2, KEHA-INVENTORY-INTELLIGENCE-SPEC-v1-2026-10-16).
 *
 * What lives here (no server imports, no I/O):
 *  - query builders for the four verified ShopifyQL queries (§6.1), with absolute
 *    `SINCE YYYY-MM-DD UNTIL YYYY-MM-DD` clauses that must end before today (§6.2 "today is
 *    partial", invariant I-12);
 *  - response parsers that turn `tableData` into typed rows, locating fields through the
 *    `columns` metadata (never by position);
 *  - date-range helpers: day arithmetic, monthly chunks newest first (§6.2 backfill strategy),
 *    and `runChunked`, which halves a range on RESPONSE_TOO_LARGE;
 *  - `fetchAllPages`: EVERY dataset query is paged with a unique, total ORDER BY and
 *    LIMIT / OFFSET (audit 2026-10-17 C1: without LIMIT ShopifyQL silently returns only the
 *    first 1,000 rows), rows are de-duplicated by their key (M10: never summed twice), and a
 *    page loop that cannot prove it reached the end fails (retryable) instead of storing a
 *    partial result;
 *  - `reconcileDailyUnits`: per-day units of a grouped sales result vs the store-level daily
 *    total, so a truncated or overlapping read fails the chunk instead of being stored;
 *  - error classes and classification of both HTTP responses and the errors the Shopify
 *    library throws.
 *
 * Dates are plain calendar days (`YYYY-MM-DD`) in the store's time zone, computed by the
 * caller. This module never converts time zones: all day arithmetic is done on UTC midnights
 * purely as a calendar counter.
 */

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type ShopifyqlErrorCode =
  | "PARSE_ERROR"
  | "RESPONSE_TOO_LARGE"
  | "THROTTLED"
  | "REQUEST_FAILED"
  | "TRUNCATED"
  | "RECONCILE_MISMATCH";

/** Base class for every error this layer raises. `retryable` tells the caller whether the same query can succeed later. */
export class ShopifyqlError extends Error {
  readonly code: ShopifyqlErrorCode;
  readonly retryable: boolean;
  constructor(code: ShopifyqlErrorCode, message: string, retryable: boolean) {
    super(message);
    this.name = "ShopifyqlError";
    this.code = code;
    this.retryable = retryable;
  }
}

/** The query itself is wrong (`parseErrors` non-empty). Never retried. */
export class ShopifyqlParseError extends ShopifyqlError {
  readonly messages: string[];
  readonly query: string;
  constructor(messages: string[], query: string) {
    super("PARSE_ERROR", `ShopifyQL parse error: ${messages.join("; ")}`, false);
    this.name = "ShopifyqlParseError";
    this.messages = messages;
    this.query = query;
  }
}

/**
 * RESPONSE_TOO_LARGE: not a rate limit; the same query will fail again. The caller must ask for
 * less (shorter date range, fewer dimensions, smaller LIMIT) — see `runChunked`.
 */
export class ShopifyqlTooLargeError extends ShopifyqlError {
  readonly query: string;
  constructor(message: string, query: string) {
    super("RESPONSE_TOO_LARGE", `ShopifyQL response too large: ${message}`, false);
    this.name = "ShopifyqlTooLargeError";
    this.query = query;
  }
}

/** Still throttled after the maximum number of attempts. Retryable later (next job run). */
export class ShopifyqlThrottledError extends ShopifyqlError {
  readonly attempts: number;
  constructor(attempts: number) {
    super("THROTTLED", `ShopifyQL still throttled after ${attempts} attempts`, true);
    this.name = "ShopifyqlThrottledError";
    this.attempts = attempts;
  }
}

/** Any other failure (unexpected HTTP status, GraphQL error, malformed body). Not retried here. */
export class ShopifyqlRequestError extends ShopifyqlError {
  readonly status: number | null;
  constructor(message: string, status: number | null) {
    super("REQUEST_FAILED", message, false);
    this.name = "ShopifyqlRequestError";
    this.status = status;
  }
}

/**
 * A paged read could not prove it holds every row (row cap hit, OFFSET ignored, columns changed
 * between pages, key columns missing). Retryable: the chunk is NOT stored and is tried again on
 * the next run (the backfill skips the month, marked degraded, after MAX_STEP_ATTEMPTS).
 */
export class ShopifyqlTruncatedError extends ShopifyqlError {
  readonly rows: number;
  constructor(message: string, rows: number) {
    super("TRUNCATED", `ShopifyQL result incomplete: ${message}`, true);
    this.name = "ShopifyqlTruncatedError";
    this.rows = rows;
  }
}

export type DayMismatch = { day: string; expected: number; got: number };

/**
 * The per-day units of a grouped read do not add up to the store-level daily total (audit C1:
 * truncation; M10: overlapping pages). Retryable; the chunk is NOT stored.
 */
export class ShopifyqlReconcileError extends ShopifyqlError {
  readonly label: string;
  readonly mismatches: DayMismatch[];
  constructor(label: string, mismatches: DayMismatch[]) {
    const shown = mismatches
      .slice(0, 5)
      .map((m) => `${m.day} expected ${m.expected} got ${m.got}`)
      .join("; ");
    super("RECONCILE_MISMATCH", `${label}: daily units do not match the store total on ${mismatches.length} day(s): ${shown}`, true);
    this.name = "ShopifyqlReconcileError";
    this.label = label;
    this.mismatches = mismatches;
  }
}

export function isTooLargeError(err: unknown): err is ShopifyqlTooLargeError {
  return (
    err instanceof ShopifyqlTooLargeError ||
    (err instanceof Error && (err as { code?: unknown }).code === "RESPONSE_TOO_LARGE")
  );
}

// ---------------------------------------------------------------------------
// Days and ranges
// ---------------------------------------------------------------------------

/** An inclusive range of calendar days, both `YYYY-MM-DD`. */
export type DayRange = { since: string; until: string };

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;

/** True for a real calendar day written `YYYY-MM-DD` (rejects 2026-02-30). */
export function isDay(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const m = DAY_RE.exec(value);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

function assertDay(value: unknown, label: string): asserts value is string {
  if (!isDay(value)) {
    throw new RangeError(`${label} must be a calendar day YYYY-MM-DD, got ${JSON.stringify(value)}`);
  }
}

/** Day → integer day number (days since 1970-01-01). Calendar counter only, no time zone. */
export function dayNumber(day: string): number {
  assertDay(day, "day");
  const [y, m, d] = day.split("-").map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / MS_PER_DAY);
}

/** Integer day number → `YYYY-MM-DD`. */
export function dayFromNumber(n: number): string {
  return new Date(n * MS_PER_DAY).toISOString().slice(0, 10);
}

export function addDays(day: string, delta: number): string {
  return dayFromNumber(dayNumber(day) + delta);
}

/** Number of days in an inclusive range (1 for since === until). */
export function dayCount(range: DayRange): number {
  return dayNumber(range.until) - dayNumber(range.since) + 1;
}

/**
 * Validates a range for a stored-daily-facts query: both ends are calendar days,
 * `since <= until`, and `until < today` (today is partial — §6.2, invariant I-12).
 */
export function assertPastRange(range: DayRange, today: string): void {
  assertDay(range.since, "since");
  assertDay(range.until, "until");
  assertDay(today, "today");
  if (range.since > range.until) {
    throw new RangeError(`since (${range.since}) is after until (${range.until})`);
  }
  if (range.until >= today) {
    throw new RangeError(
      `until (${range.until}) must be before today (${today}): today is partial, store whole past days only`,
    );
  }
}

/**
 * Calendar-month chunks covering [fromDay, toDay], NEWEST FIRST, clipped to the range
 * (spec §6.2: backfill in monthly chunks, newest first). Empty when fromDay > toDay.
 */
export function monthChunks(fromDay: string, toDay: string): DayRange[] {
  assertDay(fromDay, "fromDay");
  assertDay(toDay, "toDay");
  if (fromDay > toDay) return [];
  const out: DayRange[] = [];
  let until = toDay;
  while (until >= fromDay) {
    const monthStart = `${until.slice(0, 7)}-01`;
    const since = monthStart > fromDay ? monthStart : fromDay;
    out.push({ since, until });
    until = addDays(monthStart, -1);
  }
  return out;
}

/** Splits a range of 2+ days into [older, newer] halves; the newer half gets the extra day. */
export function halveRange(range: DayRange): [DayRange, DayRange] {
  const n = dayCount(range);
  if (n < 2) throw new RangeError("cannot halve a single-day range");
  const olderDays = Math.floor(n / 2);
  const olderUntil = addDays(range.since, olderDays - 1);
  return [
    { since: range.since, until: olderUntil },
    { since: addDays(olderUntil, 1), until: range.until },
  ];
}

/**
 * Runs `run` over `range`. On RESPONSE_TOO_LARGE it halves the range and recurses (newer half
 * first), down to a single day; a single day that is still too large is rethrown so the caller
 * can reduce dimensions or page with LIMIT. Any other error is rethrown unchanged.
 * Results come back newest first, each with the sub-range it covers.
 */
export async function runChunked<T>(
  range: DayRange,
  run: (range: DayRange) => Promise<T>,
): Promise<Array<{ range: DayRange; result: T }>> {
  try {
    return [{ range, result: await run(range) }];
  } catch (err) {
    if (!isTooLargeError(err) || dayCount(range) <= 1) throw err;
    const [older, newer] = halveRange(range);
    const newerResults = await runChunked(newer, run);
    const olderResults = await runChunked(older, run);
    return [...newerResults, ...olderResults];
  }
}

// ---------------------------------------------------------------------------
// Query builders (§6.1 — dataset and column names exactly as verified live)
// ---------------------------------------------------------------------------

/** GraphQL wrapper for every ShopifyQL query (Admin API 2026-10). */
export const SHOPIFYQL_GRAPHQL = `#graphql
  query KehaInvShopifyql($q: String!) {
    shopifyqlQuery(query: $q) {
      tableData { columns { name dataType displayName } rows }
      parseErrors
    }
  }`;

export type Paging = {
  /**
   * `ORDER BY c1 ASC, c2 ASC …` before LIMIT / OFFSET. Must be the full row key of the query
   * (time dimension + every GROUP BY dimension, see the *_KEY constants) so the order is total
   * and pages never overlap or skip rows. With TIMESERIES the time dimension stays the primary
   * order and the listed columns break ties (shopify.dev ShopifyQL 2026-10 ORDER BY).
   * Verified live 2026-10-17: ORDER BY … LIMIT n OFFSET k works together with TIMESERIES day.
   */
  orderBy?: readonly string[];
  /** `LIMIT n` (verified live: LIMIT 5000 is accepted). */
  limit?: number;
  /** `OFFSET n` (verified live with LIMIT). */
  offset?: number;
};

export type BuildOptions = {
  paging?: Paging;
  /**
   * Channel sales query only: also SHOW quantity_returned. Verified live 2026-10-17 with
   * GROUP BY product_variant_id, sales_channel TIMESERIES day (audit L6). storeSales still falls
   * back to the query without it on a parse error, as a safety net.
   */
  returns?: boolean;
};

const IDENT_RE = /^[a-z_][a-z0-9_]*$/;

function pagingClause(paging: Paging | undefined): string {
  if (!paging) return "";
  const parts: string[] = [];
  if (paging.orderBy !== undefined) {
    if (!paging.orderBy.length) throw new RangeError("ORDER BY needs at least one column");
    for (const c of paging.orderBy) if (!IDENT_RE.test(c)) throw new RangeError(`bad ORDER BY column ${c}`);
    parts.push(`ORDER BY ${paging.orderBy.map((c) => `${c} ASC`).join(", ")}`);
  }
  if (paging.limit !== undefined) {
    if (!Number.isSafeInteger(paging.limit) || paging.limit < 1) {
      throw new RangeError(`limit must be a positive integer, got ${paging.limit}`);
    }
    parts.push(`LIMIT ${paging.limit}`);
  }
  if (paging.offset !== undefined) {
    if (!Number.isSafeInteger(paging.offset) || paging.offset < 0) {
      throw new RangeError(`offset must be a non-negative integer, got ${paging.offset}`);
    }
    if (paging.limit === undefined) throw new RangeError("OFFSET needs LIMIT");
    parts.push(`OFFSET ${paging.offset}`);
  }
  return parts.length ? ` ${parts.join(" ")}` : "";
}

function dateClause(range: DayRange, today: string): string {
  assertPastRange(range, today);
  return `SINCE ${range.since} UNTIL ${range.until}`;
}

/*
 * Row keys: the time dimension plus every GROUP BY dimension, i.e. exactly what makes a result
 * row unique. Used as the ORDER BY of every page (total order → stable, non-overlapping pages)
 * and as the de-duplication key when pages are merged (M10: a row seen twice replaces, never
 * adds). tests/sync/shopifyql-paging.test.ts checks each key covers its query's dimensions.
 */
export const SALES_KEY = ["day", "product_variant_id", "pos_location_name", "sales_channel"] as const;
export const SALES_BY_LOCATION_KEY = ["day", "product_variant_id", "pos_location_name"] as const;
export const SALES_BY_CHANNEL_KEY = ["day", "product_variant_id", "sales_channel"] as const;
export const STOCK_KEY = ["day", "product_variant_id", "inventory_location_name"] as const;
export const SESSIONS_KEY = ["day", "landing_page_path", "referrer_source"] as const;
export const SHOP_TOTALS_KEY = ["day"] as const;
export const SALES_TOTALS_KEY = ["day"] as const;

/**
 * Query 1 — daily sales per variant, split by POS location AND channel, with returns.
 * Verified live 2026-10-17 (audit L6). Not used by the sync yet: SalesDaily still stores the
 * two 2-dimension views (facts-shared), which compute reads; switching is a data-model change.
 */
export function buildDailySalesQuery(range: DayRange, today: string, opts: BuildOptions = {}): string {
  return (
    "FROM sales SHOW net_items_sold, gross_sales, quantity_returned " +
    "GROUP BY product_variant_id, pos_location_name, sales_channel TIMESERIES day " +
    dateClause(range, today) +
    pagingClause(opts.paging)
  );
}

/**
 * Verified: units sold per variant per POS location (columns day, product_variant_id,
 * pos_location_name, net_items_sold). Online sales come back with an EMPTY pos_location_name
 * (verified live) → locationKey "online".
 */
export function buildDailySalesByLocationQuery(
  range: DayRange,
  today: string,
  opts: BuildOptions = {},
): string {
  return (
    "FROM sales SHOW net_items_sold " +
    "GROUP BY product_variant_id, pos_location_name TIMESERIES day " +
    dateClause(range, today) +
    pagingClause(opts.paging)
  );
}

/** Verified: units sold and gross sales (+ units returned with `returns`, verified live) per variant per sales channel. */
export function buildDailySalesByChannelQuery(
  range: DayRange,
  today: string,
  opts: BuildOptions = {},
): string {
  return (
    (opts.returns ? "FROM sales SHOW net_items_sold, gross_sales, quantity_returned " : "FROM sales SHOW net_items_sold, gross_sales ") +
    "GROUP BY product_variant_id, sales_channel TIMESERIES day " +
    dateClause(range, today) +
    pagingClause(opts.paging)
  );
}

/**
 * Reconciliation: store-level units sold per day (one row per day, no grouping). The grouped
 * sales reads must add up to this per day, else the chunk failed (truncated / overlapping).
 */
export function buildDailySalesTotalsQuery(range: DayRange, today: string, opts: BuildOptions = {}): string {
  return "FROM sales SHOW net_items_sold TIMESERIES day " + dateClause(range, today) + pagingClause(opts.paging);
}

/**
 * Query 2 — daily ending stock and out-of-stock days per variant per inventory location.
 * Verified live: a row EVERY day for EVERY location the variant is stocked at, including zero
 * and negative ending stock — this is the largest dataset by far (variants × locations × days).
 */
export function buildDailyStockQuery(range: DayRange, today: string, opts: BuildOptions = {}): string {
  return (
    "FROM inventory_by_location SHOW ending_inventory_units_at_location, days_out_of_stock_at_location " +
    "GROUP BY product_variant_id, inventory_location_name TIMESERIES day " +
    dateClause(range, today) +
    pagingClause(opts.paging)
  );
}

/**
 * Query 3 — store visits by landing page. `referrer_source` is the verified dimension; the spec's
 * `trafficType` (Paid / Organic / Direct) lives in `campaign_sessions.traffic_type`, which is
 * documented but not yet run. For now the referrer_source value is stored as `trafficType`.
 */
export function buildDailySessionsQuery(range: DayRange, today: string, opts: BuildOptions = {}): string {
  return (
    "FROM sessions SHOW sessions, sessions_that_completed_checkout " +
    "GROUP BY landing_page_path, referrer_source TIMESERIES day " +
    dateClause(range, today) +
    pagingClause(opts.paging)
  );
}

/** Query 4 — store totals for AOV / conversion. `orders` verified with TIMESERIES month; `TIMESERIES day` to verify. */
export function buildDailyShopTotalsQuery(range: DayRange, today: string, opts: BuildOptions = {}): string {
  return (
    "FROM sales SHOW orders, gross_sales TIMESERIES day " +
    dateClause(range, today) +
    pagingClause(opts.paging)
  );
}

// ---------------------------------------------------------------------------
// Paging (audit 2026-10-17 C1 / M10)
// ---------------------------------------------------------------------------

/**
 * Rows asked for per page. 5000 is the largest LIMIT verified live; a page that is
 * RESPONSE_TOO_LARGE is retried at the same OFFSET with half the size, down to MIN_PAGE_SIZE.
 */
export const PAGE_SIZE = 5000;
export const MIN_PAGE_SIZE = 1000;
/** What ShopifyQL silently returns without LIMIT (verified live). A page of exactly this many rows is never trusted as the last one. */
export const IMPLICIT_ROW_CAP = 1000;
/**
 * Hard cap per query (one dataset × date range): beyond it the read fails (retryable) rather
 * than holding millions of rows in memory. 1,000,000 stock rows ≈ 32,000 variant-locations for
 * a 31-day month.
 */
export const MAX_ROWS_PER_QUERY = 1_000_000;
/** Safety stop for the page loop (MAX_ROWS_PER_QUERY / MIN_PAGE_SIZE). */
export const MAX_PAGES = 1000;

export type PageOptions = {
  pageSize?: number;
  minPageSize?: number;
  maxRows?: number;
  maxPages?: number;
};

export type PagedTable = {
  /** Every page merged; rows are objects keyed by column name, one per distinct key, in first-seen order. */
  table: ShopifyqlTableData;
  pages: number;
  /** Rows received over all pages (duplicates included). */
  rawRows: number;
  /** Rows whose key was already seen on an earlier page (replaced, never added — M10). */
  duplicates: number;
  /** The page size the read ended with (smaller than PAGE_SIZE after RESPONSE_TOO_LARGE). */
  pageSize: number;
};

/** A table's rows as objects keyed by column name (positional rows are mapped through `columns`). */
export function rowObjects(table: ShopifyqlTableData): Record<string, unknown>[] {
  const { rows } = makeReader(table);
  const names = (table.columns ?? []).map((c) => (c && typeof c.name === "string" ? c.name : ""));
  const out: Record<string, unknown>[] = [];
  for (const r of rows) {
    if (Array.isArray(r)) {
      const o: Record<string, unknown> = {};
      names.forEach((n, i) => {
        if (n) o[n] = r[i];
      });
      out.push(o);
    } else if (r && typeof r === "object") out.push(r as Record<string, unknown>);
    else out.push({});
  }
  return out;
}

function keyOf(row: Record<string, unknown>, key: readonly string[]): string {
  return JSON.stringify(key.map((k) => (row[k] === undefined ? null : row[k])));
}

/**
 * Reads EVERY row of one query, page by page:
 * `ORDER BY <key> LIMIT <size> OFFSET <k>`, k = rows received so far.
 *
 *  - The loop ends only on a short page (fewer rows than asked) that is not exactly
 *    IMPLICIT_ROW_CAP rows, or on an empty page. A full page — or a page of exactly 1,000 rows
 *    when more were asked (a silent cap) — always fetches the next page (truncation guard).
 *  - Rows are de-duplicated by `key` (replace, never add): overlapping pages cannot double
 *    count (M10). A page that brings no new key (OFFSET ignored) fails the read.
 *  - RESPONSE_TOO_LARGE halves the page size (same OFFSET) down to `minPageSize`, then is
 *    rethrown so the caller can split the date range.
 *  - More than `maxRows` rows or `maxPages` pages, columns that change between pages, or key
 *    columns missing from a non-empty page → ShopifyqlTruncatedError (retryable): the caller
 *    must not store anything for that range.
 */
export async function fetchAllPages(
  runPage: (paging: Paging) => Promise<ShopifyqlTableData>,
  key: readonly string[],
  opts: PageOptions = {},
): Promise<PagedTable> {
  if (!key.length) throw new RangeError("fetchAllPages needs a row key");
  let size = opts.pageSize ?? PAGE_SIZE;
  const minSize = Math.min(size, opts.minPageSize ?? MIN_PAGE_SIZE);
  const maxRows = opts.maxRows ?? MAX_ROWS_PER_QUERY;
  const maxPages = opts.maxPages ?? MAX_PAGES;
  const merged = new Map<string, Record<string, unknown>>();
  let columns: ShopifyqlColumn[] | null = null;
  let columnSig = "";
  let offset = 0;
  let pages = 0;
  let duplicates = 0;

  for (;;) {
    if (pages >= maxPages) throw new ShopifyqlTruncatedError(`paging did not end after ${maxPages} pages`, offset);
    let table: ShopifyqlTableData;
    try {
      table = await runPage({ orderBy: key, limit: size, offset });
    } catch (err) {
      if (isTooLargeError(err) && size > minSize) {
        size = Math.max(minSize, Math.floor(size / 2));
        continue;
      }
      throw err;
    }
    pages++;
    const rows = rowObjects(table);
    const n = rows.length;
    if (n > 0) {
      const sig = (table.columns ?? []).map((c) => c?.name).join("|");
      if (columns === null) {
        columns = table.columns;
        columnSig = sig;
        const absent = key.filter((k) => !(table.columns ?? []).some((c) => c?.name === k));
        if (absent.length) throw new ShopifyqlTruncatedError(`key column(s) ${absent.join(", ")} missing, rows cannot be de-duplicated`, offset);
      } else if (sig !== columnSig) {
        throw new ShopifyqlTruncatedError("columns changed between pages", offset);
      }
    } else if (columns === null && Array.isArray(table.columns)) {
      columns = table.columns;
    }
    let fresh = 0;
    for (const r of rows) {
      const k = keyOf(r, key);
      if (merged.has(k)) duplicates++;
      else fresh++;
      merged.set(k, r);
    }
    offset += n;
    if (merged.size > maxRows) throw new ShopifyqlTruncatedError(`more than ${maxRows} rows`, offset);
    if (n === 0) break;
    if (fresh === 0) throw new ShopifyqlTruncatedError(`page at OFFSET ${offset - n} brought no new rows (OFFSET ignored?)`, offset);
    if (n < size && n !== IMPLICIT_ROW_CAP) break;
  }
  return {
    table: { columns: columns ?? [], rows: [...merged.values()] },
    pages,
    rawRows: offset,
    duplicates,
    pageSize: size,
  };
}

// ---------------------------------------------------------------------------
// Reconciliation (audit 2026-10-17 C1)
// ---------------------------------------------------------------------------

/** Units sold per day: the parsed rows plus the units on rows dropped for a missing variant (custom items, gap rows). */
export function unitsByDay(result: { rows: readonly SalesRow[]; unattributed?: Record<string, number> }): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of result.rows) out.set(r.day, (out.get(r.day) ?? 0) + r.sold);
  for (const [day, units] of Object.entries(result.unattributed ?? {})) out.set(day, (out.get(day) ?? 0) + units);
  return out;
}

/** Rounding slack per day: net_items_sold is a whole number, so anything ≥ 0.5 apart is a real difference. */
export const RECONCILE_TOLERANCE = 0.5;

/**
 * Days in `range` where `got` and `expected` differ by RECONCILE_TOLERANCE or more (a day absent
 * from one side counts as 0 there). Days outside the range are ignored.
 */
export function reconcileDailyUnits(
  got: ReadonlyMap<string, number>,
  expected: ReadonlyMap<string, number>,
  range: DayRange,
): DayMismatch[] {
  const days = new Set<string>();
  for (const d of got.keys()) days.add(d);
  for (const d of expected.keys()) days.add(d);
  const out: DayMismatch[] = [];
  for (const day of [...days].sort()) {
    if (day < range.since || day > range.until) continue;
    const g = got.get(day) ?? 0;
    const e = expected.get(day) ?? 0;
    if (Math.abs(g - e) >= RECONCILE_TOLERANCE) out.push({ day, expected: e, got: g });
  }
  return out;
}

/** Throws ShopifyqlReconcileError when `reconcileDailyUnits` finds any mismatching day. */
export function assertReconciled(
  label: string,
  got: ReadonlyMap<string, number>,
  expected: ReadonlyMap<string, number>,
  range: DayRange,
): void {
  const mismatches = reconcileDailyUnits(got, expected, range);
  if (mismatches.length) throw new ShopifyqlReconcileError(label, mismatches);
}

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

/** `ShopifyqlTableDataColumn` (dataType is the `ColumnDataType` enum, e.g. DAY_TIMESTAMP, MONEY). */
export type ShopifyqlColumn = { name: string; dataType?: string | null; displayName?: string | null };

export type ShopifyqlTableData = {
  columns: ShopifyqlColumn[];
  /** JSON scalar: normally an array of objects keyed by column name. */
  rows: unknown;
};

/** `extensions.shopifyqlCost` — the ShopifyQL budget (separate from the Admin GraphQL cost). */
export type ShopifyqlCost = {
  requestedQueryCost: number | null;
  maximumAvailable: number | null;
  currentlyAvailable: number | null;
  windowResetAt: string | null;
};

type GraphqlErrorLike = { message?: unknown; extensions?: { code?: unknown } | null };

/** Shopify-shaped GraphQL body: `{ data, errors, extensions }`. */
export type GraphqlBody = {
  data?: { shopifyqlQuery?: { tableData?: ShopifyqlTableData | null; parseErrors?: unknown } | null } | null;
  errors?: unknown;
  extensions?: { shopifyqlCost?: unknown; cost?: unknown } | null;
};

function finiteOrNull(v: unknown): number | null {
  const n = toNumber(v);
  return n === undefined ? null : n;
}

/** Reads `extensions.shopifyqlCost`; null when absent or not an object. */
export function readShopifyqlCost(body: unknown): ShopifyqlCost | null {
  const ext = (body as GraphqlBody | null | undefined)?.extensions;
  const raw = ext && typeof ext === "object" ? (ext as { shopifyqlCost?: unknown }).shopifyqlCost : undefined;
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  return {
    requestedQueryCost: finiteOrNull(c.requestedQueryCost),
    maximumAvailable: finiteOrNull(c.maximumAvailable),
    currentlyAvailable: finiteOrNull(c.currentlyAvailable),
    windowResetAt: typeof c.windowResetAt === "string" && c.windowResetAt ? c.windowResetAt : null,
  };
}

export const DEFAULT_THROTTLE_WAIT_MS = 60_000;
/** Lower bound when the reset time is already in the past (clock skew): avoid a hot retry loop. */
export const MIN_THROTTLE_WAIT_MS = 1_000;
/** Upper bound so a bad `windowResetAt` cannot park a job for hours. */
export const MAX_THROTTLE_WAIT_MS = 10 * 60_000;

/** Milliseconds to wait before retrying a throttled query. */
export function throttleWaitMs(windowResetAt: string | null | undefined, nowMs: number): number {
  const reset = windowResetAt ? Date.parse(windowResetAt) : NaN;
  if (Number.isNaN(reset)) return DEFAULT_THROTTLE_WAIT_MS;
  const wait = reset - nowMs;
  return Math.min(MAX_THROTTLE_WAIT_MS, Math.max(MIN_THROTTLE_WAIT_MS, wait));
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export type Classified =
  | { kind: "ok"; table: ShopifyqlTableData; cost: ShopifyqlCost | null }
  | { kind: "parse"; messages: string[]; cost: ShopifyqlCost | null }
  | { kind: "tooLarge"; message: string; cost: ShopifyqlCost | null }
  | { kind: "throttled"; cost: ShopifyqlCost | null; retryAfterMs: number | null }
  | { kind: "error"; message: string; status: number | null; cost: ShopifyqlCost | null };

function errorList(errors: unknown): GraphqlErrorLike[] {
  if (Array.isArray(errors)) return errors as GraphqlErrorLike[];
  // The Shopify library wraps them: { message, graphQLErrors: [...] }.
  if (errors && typeof errors === "object") {
    const inner = (errors as { graphQLErrors?: unknown }).graphQLErrors;
    if (Array.isArray(inner)) return inner as GraphqlErrorLike[];
  }
  return [];
}

function errorCode(e: GraphqlErrorLike): string {
  const code = e?.extensions?.code;
  return typeof code === "string" ? code : "";
}

function errorMessage(e: GraphqlErrorLike): string {
  return typeof e?.message === "string" ? e.message : "unknown error";
}

/** `parseErrors` is `string[]` in 2026-10; older versions used objects with `message`. Accept both. */
function parseErrorMessages(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((p) => (typeof p === "string" ? p : typeof p?.message === "string" ? p.message : JSON.stringify(p)))
    .filter((m) => m.length > 0);
}

/** Classifies one HTTP response (status + parsed JSON body; body may be null when unreadable). */
export function classifyResponse(status: number, body: unknown): Classified {
  const b = (body && typeof body === "object" ? body : {}) as GraphqlBody;
  const cost = readShopifyqlCost(b);
  const errors = errorList(b.errors);

  if (status === 429 || errors.some((e) => errorCode(e) === "THROTTLED")) {
    return { kind: "throttled", cost, retryAfterMs: null };
  }
  const tooLarge = errors.find((e) => errorCode(e) === "RESPONSE_TOO_LARGE");
  if (tooLarge) return { kind: "tooLarge", message: errorMessage(tooLarge), cost };

  if (status < 200 || status >= 300) {
    const detail = errors.length ? `: ${errors.map(errorMessage).join("; ")}` : "";
    return { kind: "error", message: `ShopifyQL HTTP ${status}${detail}`, status, cost };
  }

  const q = b.data?.shopifyqlQuery;
  const parse = parseErrorMessages(q?.parseErrors);
  if (parse.length) return { kind: "parse", messages: parse, cost };

  if (errors.length) {
    return { kind: "error", message: `ShopifyQL GraphQL error: ${errors.map(errorMessage).join("; ")}`, status, cost };
  }
  const table = q?.tableData;
  if (!table || !Array.isArray(table.columns)) {
    return { kind: "error", message: "ShopifyQL response has no tableData", status, cost };
  }
  return { kind: "ok", table, cost };
}

/**
 * Classifies something the Admin client THREW. The real `admin.graphql` from
 * @shopify/shopify-app-react-router does not return error responses; it throws:
 *  - a `Response` (status copied from Shopify) for HTTP errors such as 429 — its body is the
 *    library's error wrapper, so `windowResetAt` is usually not available;
 *  - an `HttpThrottlingError`-like object with `response.code === 429` (offline clients);
 *  - a `GraphqlQueryError`-like object with `body.errors.graphQLErrors` for GraphQL errors
 *    returned with HTTP 200 (RESPONSE_TOO_LARGE, THROTTLED).
 * Returns null when the thrown value is not recognised (the caller rethrows it unchanged).
 */
export function classifyThrown(err: unknown, thrownResponseBody?: unknown): Classified | null {
  if (!err || typeof err !== "object") return null;

  if (typeof Response !== "undefined" && err instanceof Response) {
    const c = classifyResponse(err.status, thrownResponseBody ?? null);
    return c.kind === "throttled" || c.kind === "tooLarge" ? c : null;
  }

  const e = err as {
    body?: unknown;
    response?: { code?: unknown; retryAfter?: unknown; body?: unknown };
  };
  if (e.response && e.response.code === 429) {
    const secs = toNumber(e.response.retryAfter);
    return {
      kind: "throttled",
      cost: readShopifyqlCost(e.response.body),
      retryAfterMs: secs !== undefined && secs > 0 ? secs * 1000 : null,
    };
  }
  if (e.body && typeof e.body === "object") {
    const c = classifyResponse(200, e.body);
    if (c.kind === "throttled" || c.kind === "tooLarge") return c;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

/** Defensive number parse: numbers and numeric strings; null / "" / NaN / Infinity → undefined. */
export function toNumber(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string") {
    const s = v.trim();
    if (s === "") return undefined;
    const n = Number(s);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/**
 * Keeps the date part of a ShopifyQL day value exactly as given ("2026-09-01",
 * "2026-09-01T00:00:00Z", "2026-09-01T00:00:00+02:00" → "2026-09-01"). No time-zone shift:
 * ShopifyQL already buckets days in the store's time zone.
 */
export function normaliseDay(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const m = /^(\d{4}-\d{2}-\d{2})(?:$|[T ])/.exec(v.trim());
  if (!m || !isDay(m[1])) return undefined;
  return m[1];
}

const VARIANT_GID_RE = /^gid:\/\/shopify\/ProductVariant\/(\d+)$/;

/** Numeric id (number or string) or ProductVariant gid → "gid://shopify/ProductVariant/<n>". */
export function normaliseVariantId(v: unknown): string | undefined {
  let digits: string | undefined;
  if (typeof v === "number") {
    if (Number.isSafeInteger(v) && v > 0) digits = String(v);
  } else if (typeof v === "string") {
    const s = v.trim();
    const gid = VARIANT_GID_RE.exec(s);
    if (gid) digits = gid[1];
    else if (/^\d+$/.test(s)) digits = s;
  }
  if (!digits || /^0+$/.test(digits)) return undefined;
  return `gid://shopify/ProductVariant/${digits.replace(/^0+/, "")}`;
}

function nonEmptyString(v: unknown): string | undefined {
  if (typeof v === "string") {
    const s = v.trim();
    return s === "" ? undefined : s;
  }
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return undefined;
}

export type ParseResult<T> = {
  rows: T[];
  /** Rows dropped because an identity field (day, variant id, location) was missing or invalid. */
  skipped: number;
  /**
   * Expected columns that were absent from `columns`; their metric fields were defaulted
   * (0 / "unknown"). The caller should treat those metrics as NOT measured (invariant I-5).
   */
  missingColumns: string[];
  /**
   * Sales parsers only: units (net_items_sold) per day on rows dropped because the variant id is
   * empty (custom items, TIMESERIES gap rows). Not stored, but counted when reconciling a chunk
   * against the store's daily total.
   */
  unattributed?: Record<string, number>;
  /** Set by the paged client methods: pages read and rows de-duplicated across pages. */
  pages?: number;
  duplicates?: number;
};

type Reader = {
  has: (name: string) => boolean;
  get: (row: unknown, name: string) => unknown;
};

/** Locates fields through the `columns` metadata; supports object rows (normal) and positional array rows. */
function makeReader(table: ShopifyqlTableData): { reader: Reader; rows: unknown[] } {
  const index = new Map<string, number>();
  (table.columns ?? []).forEach((c, i) => {
    if (c && typeof c.name === "string") index.set(c.name, i);
  });
  let rows: unknown = table.rows;
  if (typeof rows === "string") {
    try {
      rows = JSON.parse(rows);
    } catch {
      rows = [];
    }
  }
  const list = Array.isArray(rows) ? rows : [];
  const reader: Reader = {
    has: (name) => index.has(name),
    get: (row, name) => {
      const i = index.get(name);
      if (i === undefined || row === null || typeof row !== "object") return undefined;
      if (Array.isArray(row)) return row[i];
      return (row as Record<string, unknown>)[name];
    },
  };
  return { reader, rows: list };
}

function missing(reader: Reader, names: string[]): string[] {
  return names.filter((n) => !reader.has(n));
}

export type SalesRow = {
  day: string;
  variantId: string;
  /**
   * "online" when pos_location_name is null/empty (verified live: online sales come back with an
   * empty location name); the POS location NAME otherwise (caller maps to ids); "unknown" when the
   * column is absent.
   */
  locationKey: string;
  /** sales_channel; "unknown" when absent. */
  channel: string;
  sold: number;
  gross: number;
  returned: number;
};

/**
 * Parses query 1 or either 2-dimension query (missing dimension/metric columns are defaulted and
 * reported). Rows with an empty product_variant_id (verified live: they appear) are skipped;
 * their units are kept per day in `unattributed` for reconciliation.
 */
export function parseSalesRows(table: ShopifyqlTableData): ParseResult<SalesRow> {
  const { reader, rows } = makeReader(table);
  const hasLocation = reader.has("pos_location_name");
  const hasChannel = reader.has("sales_channel");
  const out: SalesRow[] = [];
  const unattributed: Record<string, number> = {};
  let skipped = 0;
  for (const r of rows) {
    const day = normaliseDay(reader.get(r, "day"));
    const variantId = normaliseVariantId(reader.get(r, "product_variant_id"));
    if (!day || !variantId) {
      skipped++;
      const units = toNumber(reader.get(r, "net_items_sold"));
      if (day && units) unattributed[day] = (unattributed[day] ?? 0) + units;
      continue;
    }
    out.push({
      day,
      variantId,
      locationKey: hasLocation ? (nonEmptyString(reader.get(r, "pos_location_name")) ?? "online") : "unknown",
      channel: hasChannel ? (nonEmptyString(reader.get(r, "sales_channel")) ?? "unknown") : "unknown",
      sold: toNumber(reader.get(r, "net_items_sold")) ?? 0,
      gross: toNumber(reader.get(r, "gross_sales")) ?? 0,
      returned: toNumber(reader.get(r, "quantity_returned")) ?? 0,
    });
  }
  return {
    rows: out,
    skipped,
    missingColumns: missing(reader, [
      "pos_location_name",
      "sales_channel",
      "net_items_sold",
      "gross_sales",
      "quantity_returned",
    ]),
    unattributed,
  };
}

export type SalesTotalRow = { day: string; sold: number };

/** Parses the reconciliation query (store-level units per day). */
export function parseSalesTotalsRows(table: ShopifyqlTableData): ParseResult<SalesTotalRow> {
  const { reader, rows } = makeReader(table);
  const out: SalesTotalRow[] = [];
  let skipped = 0;
  for (const r of rows) {
    const day = normaliseDay(reader.get(r, "day"));
    if (!day) {
      skipped++;
      continue;
    }
    out.push({ day, sold: toNumber(reader.get(r, "net_items_sold")) ?? 0 });
  }
  return { rows: out, skipped, missingColumns: missing(reader, ["net_items_sold"]) };
}

export type StockRow = {
  day: string;
  variantId: string;
  locationName: string;
  /** ending_inventory_units_at_location: may be 0 or NEGATIVE (verified live); never clamped. */
  endUnits: number;
  /** days_out_of_stock_at_location > 0 for that single day. */
  outOfStock: boolean;
};

/** Parses query 2. Rows without a location name are skipped (location is part of the identity). */
export function parseStockRows(table: ShopifyqlTableData): ParseResult<StockRow> {
  const { reader, rows } = makeReader(table);
  const out: StockRow[] = [];
  let skipped = 0;
  for (const r of rows) {
    const day = normaliseDay(reader.get(r, "day"));
    const variantId = normaliseVariantId(reader.get(r, "product_variant_id"));
    const locationName = nonEmptyString(reader.get(r, "inventory_location_name"));
    if (!day || !variantId || !locationName) {
      skipped++;
      continue;
    }
    out.push({
      day,
      variantId,
      locationName,
      endUnits: toNumber(reader.get(r, "ending_inventory_units_at_location")) ?? 0,
      outOfStock: (toNumber(reader.get(r, "days_out_of_stock_at_location")) ?? 0) > 0,
    });
  }
  return {
    rows: out,
    skipped,
    missingColumns: missing(reader, ["ending_inventory_units_at_location", "days_out_of_stock_at_location"]),
  };
}

export type SessionsRow = {
  day: string;
  /** landing_page_path; "unknown" when null/empty so store-level session totals still add up. */
  landingPath: string;
  /** Currently the `referrer_source` value (verified); the spec's Paid/Organic/Direct needs campaign_sessions. */
  trafficType: string;
  sessions: number;
  checkouts: number;
};

/** Parses query 3. */
export function parseSessionsRows(table: ShopifyqlTableData): ParseResult<SessionsRow> {
  const { reader, rows } = makeReader(table);
  const out: SessionsRow[] = [];
  let skipped = 0;
  for (const r of rows) {
    const day = normaliseDay(reader.get(r, "day"));
    if (!day) {
      skipped++;
      continue;
    }
    out.push({
      day,
      landingPath: nonEmptyString(reader.get(r, "landing_page_path")) ?? "unknown",
      trafficType: nonEmptyString(reader.get(r, "referrer_source")) ?? "unknown",
      sessions: toNumber(reader.get(r, "sessions")) ?? 0,
      checkouts: toNumber(reader.get(r, "sessions_that_completed_checkout")) ?? 0,
    });
  }
  return {
    rows: out,
    skipped,
    missingColumns: missing(reader, [
      "landing_page_path",
      "referrer_source",
      "sessions",
      "sessions_that_completed_checkout",
    ]),
  };
}

export type ShopDayRow = { day: string; orders: number; gross: number };

/** Parses query 4. */
export function parseShopDayRows(table: ShopifyqlTableData): ParseResult<ShopDayRow> {
  const { reader, rows } = makeReader(table);
  const out: ShopDayRow[] = [];
  let skipped = 0;
  for (const r of rows) {
    const day = normaliseDay(reader.get(r, "day"));
    if (!day) {
      skipped++;
      continue;
    }
    out.push({
      day,
      orders: toNumber(reader.get(r, "orders")) ?? 0,
      gross: toNumber(reader.get(r, "gross_sales")) ?? 0,
    });
  }
  return { rows: out, skipped, missingColumns: missing(reader, ["orders", "gross_sales"]) };
}
