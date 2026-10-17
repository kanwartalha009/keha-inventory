/**
 * ShopifyQL client — budget-aware wrapper around an injected Admin GraphQL client
 * (spec §6.1/§6.2, KEHA-INVENTORY-INTELLIGENCE-SPEC-v1-2026-10-16).
 *
 * Behaviour:
 *  - Throttled (HTTP 429, or a GraphQL error with extensions.code "THROTTLED"): wait until the
 *    ShopifyQL `windowResetAt` (fallback 60 s), then retry; at most 5 attempts in total, then
 *    `ShopifyqlThrottledError`.
 *  - `parseErrors` non-empty → `ShopifyqlParseError` (never retried).
 *  - RESPONSE_TOO_LARGE → `ShopifyqlTooLargeError` (never retried as is); a paged read first
 *    halves its page size, then the caller splits the date range with `runChunked`.
 *  - Every typed dataset method reads ALL rows (`fetchAllPages`: unique ORDER BY key + LIMIT /
 *    OFFSET until a short page, de-duplicated by key). Without LIMIT ShopifyQL silently returns
 *    only the first 1,000 rows (audit 2026-10-17 C1). Passing `opts.paging` reads that one
 *    page only (tests / diagnostics).
 *  - Every response's `extensions.shopifyqlCost` is recorded for `shopifyqlBudget()` (/health).
 *
 * Works with both a client that RETURNS error responses (tests, raw fetch) and the real
 * `admin.graphql`, which THROWS on HTTP and GraphQL errors (see `classifyThrown`).
 * `sleep` and `now` are injectable so tests run on fake time.
 */
import type { AdminGraphqlClient } from "../../models/shop.server";
import {
  SHOPIFYQL_GRAPHQL,
  ShopifyqlParseError,
  ShopifyqlRequestError,
  ShopifyqlThrottledError,
  ShopifyqlTooLargeError,
  buildDailySalesByChannelQuery,
  buildDailySalesByLocationQuery,
  buildDailySalesQuery,
  buildDailySalesTotalsQuery,
  buildDailySessionsQuery,
  buildDailyShopTotalsQuery,
  buildDailyStockQuery,
  classifyResponse,
  classifyThrown,
  fetchAllPages,
  parseSalesRows,
  parseSalesTotalsRows,
  parseSessionsRows,
  parseShopDayRows,
  parseStockRows,
  throttleWaitMs,
  SALES_BY_CHANNEL_KEY,
  SALES_BY_LOCATION_KEY,
  SALES_KEY,
  SALES_TOTALS_KEY,
  SESSIONS_KEY,
  SHOP_TOTALS_KEY,
  STOCK_KEY,
  type BuildOptions,
  type PageOptions,
  type Paging,
  type Classified,
  type DayRange,
  type ParseResult,
  type SalesRow,
  type SalesTotalRow,
  type SessionsRow,
  type ShopDayRow,
  type ShopifyqlCost,
  type ShopifyqlTableData,
  type StockRow,
} from "../../lib/sync/shopifyql-shared";

export { runChunked, monthChunks } from "../../lib/sync/shopifyql-shared";

export const SHOPIFYQL_MAX_ATTEMPTS = 5;

// ---------------------------------------------------------------------------
// Budget snapshot for /health (process-wide, last response seen from any shop)
// ---------------------------------------------------------------------------

export type ShopifyqlBudgetSnapshot = {
  /** `requestedQueryCost` of the last response that carried `extensions.shopifyqlCost`. */
  lastCost: number | null;
  /** `currentlyAvailable` from the same response. */
  lastRemaining: number | null;
  /** ISO time (from the injected clock) when it was recorded. */
  lastAt: string | null;
};

let budget: ShopifyqlBudgetSnapshot = { lastCost: null, lastRemaining: null, lastAt: null };

export function shopifyqlBudget(): ShopifyqlBudgetSnapshot {
  return { ...budget };
}

/** Test helper: clears the process-wide snapshot. */
export function resetShopifyqlBudget(): void {
  budget = { lastCost: null, lastRemaining: null, lastAt: null };
}

function recordBudget(cost: ShopifyqlCost | null, nowMs: number): void {
  if (!cost) return;
  budget = {
    lastCost: cost.requestedQueryCost,
    lastRemaining: cost.currentlyAvailable,
    lastAt: new Date(nowMs).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export type ShopifyqlClientOptions = {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  maxAttempts?: number;
  /** Page sizes / caps for the paged reads (tests use small pages). */
  paging?: PageOptions;
};

export type ShopifyqlRunResult = {
  table: ShopifyqlTableData;
  cost: ShopifyqlCost | null;
  attempts: number;
};

export type ShopifyqlClient = {
  /** Runs one raw ShopifyQL query. */
  run: (query: string) => Promise<ShopifyqlRunResult>;
  salesDaily: (range: DayRange, today: string, opts?: BuildOptions) => Promise<ParseResult<SalesRow>>;
  salesDailyByLocation: (range: DayRange, today: string, opts?: BuildOptions) => Promise<ParseResult<SalesRow>>;
  salesDailyByChannel: (range: DayRange, today: string, opts?: BuildOptions) => Promise<ParseResult<SalesRow>>;
  stockDaily: (range: DayRange, today: string, opts?: BuildOptions) => Promise<ParseResult<StockRow>>;
  sessionsDaily: (range: DayRange, today: string, opts?: BuildOptions) => Promise<ParseResult<SessionsRow>>;
  shopDaily: (range: DayRange, today: string, opts?: BuildOptions) => Promise<ParseResult<ShopDayRow>>;
  /** Store-level units sold per day: the reconciliation total for the sales reads. */
  salesTotalsDaily: (range: DayRange, today: string) => Promise<ParseResult<SalesTotalRow>>;
};

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/** One attempt → classified outcome, or rethrows a thrown value we do not recognise. */
async function attempt(admin: AdminGraphqlClient, query: string): Promise<Classified> {
  let res: Response;
  try {
    res = await admin.graphql(SHOPIFYQL_GRAPHQL, { variables: { q: query } });
  } catch (err) {
    const body = err instanceof Response ? await readJson(err.clone()) : undefined;
    const classified = classifyThrown(err, body);
    if (classified) return classified;
    throw err;
  }
  return classifyResponse(res.status, await readJson(res));
}

/** Create one client per shop (the throttle fallback remembers that shop's last window reset). */
export function createShopifyqlClient(
  admin: AdminGraphqlClient,
  options: ShopifyqlClientOptions = {},
): ShopifyqlClient {
  const sleep = options.sleep ?? realSleep;
  const now = options.now ?? Date.now;
  const maxAttempts = Math.max(1, options.maxAttempts ?? SHOPIFYQL_MAX_ATTEMPTS);
  // The real admin.graphql drops the 429 body, so remember the last window reset this shop reported.
  let lastWindowResetAt: string | null = null;

  async function run(query: string): Promise<ShopifyqlRunResult> {
    for (let n = 1; n <= maxAttempts; n++) {
      const c = await attempt(admin, query);
      recordBudget(c.cost, now());
      if (c.cost?.windowResetAt) lastWindowResetAt = c.cost.windowResetAt;

      switch (c.kind) {
        case "ok":
          return { table: c.table, cost: c.cost, attempts: n };
        case "parse":
          throw new ShopifyqlParseError(c.messages, query);
        case "tooLarge":
          throw new ShopifyqlTooLargeError(c.message, query);
        case "error":
          throw new ShopifyqlRequestError(c.message, c.status);
        case "throttled": {
          if (n === maxAttempts) break;
          const nowMs = now();
          const knownReset =
            c.cost?.windowResetAt ??
            (lastWindowResetAt && Date.parse(lastWindowResetAt) > nowMs ? lastWindowResetAt : null);
          const wait = knownReset ? throttleWaitMs(knownReset, nowMs) : (c.retryAfterMs ?? throttleWaitMs(null, nowMs));
          await sleep(wait);
          break;
        }
      }
    }
    throw new ShopifyqlThrottledError(maxAttempts);
  }

  /**
   * Builds inside the async function so a bad range is a rejected promise, never a synchronous
   * throw. Without `opts.paging`, every page is read (fetchAllPages) and parsed once, merged.
   */
  async function runParsed<T>(
    build: (paging?: Paging) => string,
    parse: (t: ShopifyqlTableData) => ParseResult<T>,
    key: readonly string[],
    paging?: Paging,
  ): Promise<ParseResult<T>> {
    if (paging) {
      const { table } = await run(build(paging));
      return parse(table);
    }
    build(); // validates the range before the first request
    const paged = await fetchAllPages(async (p) => (await run(build(p))).table, key, options.paging);
    return { ...parse(paged.table), pages: paged.pages, duplicates: paged.duplicates };
  }

  return {
    run,
    salesDaily: (range, today, opts) =>
      runParsed((p) => buildDailySalesQuery(range, today, { ...opts, paging: p }), parseSalesRows, SALES_KEY, opts?.paging),
    salesDailyByLocation: (range, today, opts) =>
      runParsed((p) => buildDailySalesByLocationQuery(range, today, { ...opts, paging: p }), parseSalesRows, SALES_BY_LOCATION_KEY, opts?.paging),
    salesDailyByChannel: (range, today, opts) =>
      runParsed((p) => buildDailySalesByChannelQuery(range, today, { ...opts, paging: p }), parseSalesRows, SALES_BY_CHANNEL_KEY, opts?.paging),
    stockDaily: (range, today, opts) =>
      runParsed((p) => buildDailyStockQuery(range, today, { ...opts, paging: p }), parseStockRows, STOCK_KEY, opts?.paging),
    sessionsDaily: (range, today, opts) =>
      runParsed((p) => buildDailySessionsQuery(range, today, { ...opts, paging: p }), parseSessionsRows, SESSIONS_KEY, opts?.paging),
    shopDaily: (range, today, opts) =>
      runParsed((p) => buildDailyShopTotalsQuery(range, today, { ...opts, paging: p }), parseShopDayRows, SHOP_TOTALS_KEY, opts?.paging),
    salesTotalsDaily: (range, today) =>
      runParsed((p) => buildDailySalesTotalsQuery(range, today, { paging: p }), parseSalesTotalsRows, SALES_TOTALS_KEY),
  };
}
