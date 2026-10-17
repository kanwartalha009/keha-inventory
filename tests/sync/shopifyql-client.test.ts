/**
 * ShopifyQL client (spec §6.2): throttle waits on windowResetAt with an injected sleep,
 * 5-attempt cap, parse errors never retried, RESPONSE_TOO_LARGE typed for range splitting,
 * and the /health budget snapshot.
 */
import { describe, it, expect, beforeEach } from "vitest";

import {
  createShopifyqlClient,
  resetShopifyqlBudget,
  runChunked,
  shopifyqlBudget,
} from "../../app/services/sync/shopifyql.server";
import {
  ShopifyqlParseError,
  ShopifyqlRequestError,
  ShopifyqlThrottledError,
  ShopifyqlTooLargeError,
  dayCount,
  type DayRange,
} from "../../app/lib/sync/shopifyql-shared";
import type { AdminGraphqlClient } from "../../app/models/shop.server";

import salesFixture from "./fixtures/sales-daily.json";
import stockFixture from "./fixtures/stock-daily.json";
import sessionsFixture from "./fixtures/sessions-daily.json";
import shopFixture from "./fixtures/shop-daily.json";
import parseErrorsFixture from "./fixtures/parse-errors.json";
import tooLargeFixture from "./fixtures/too-large.json";
import throttled429Fixture from "./fixtures/throttled-429.json";
import throttledGraphqlFixture from "./fixtures/throttled-graphql.json";

const NOW = Date.parse("2026-10-16T10:00:00Z");
const TODAY = "2026-10-16";
const SEPT: DayRange = { since: "2026-09-01", until: "2026-09-30" };

type Step = { status?: number; body: unknown } | { throws: unknown };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** Fake admin client that plays a script of responses and records every call. */
function fakeAdmin(steps: Step[]) {
  const calls: Array<{ query: string; variables?: Record<string, unknown> }> = [];
  let i = 0;
  const admin: AdminGraphqlClient = {
    graphql: async (query, options) => {
      calls.push({ query, variables: options?.variables });
      const step = steps[Math.min(i++, steps.length - 1)];
      if ("throws" in step) throw step.throws;
      return json(step.body, step.status ?? 200);
    },
  };
  return { admin, calls };
}

/** Fake clock + sleep: sleeping advances the clock and records the wait. */
function fakeTime(start = NOW) {
  let t = start;
  const waits: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      waits.push(ms);
      t += ms;
    },
    waits,
  };
}

beforeEach(() => resetShopifyqlBudget());

describe("happy path", () => {
  it("sends the ShopifyQL wrapper with the built query and parses rows", async () => {
    const { admin, calls } = fakeAdmin([{ body: salesFixture }]);
    const time = fakeTime();
    const client = createShopifyqlClient(admin, time);
    const res = await client.salesDaily(SEPT, TODAY);
    expect(calls).toHaveLength(1);
    expect(calls[0].query).toContain("shopifyqlQuery(query: $q)");
    expect(calls[0].query).toContain("parseErrors");
    expect(calls[0].variables).toEqual({
      // Always paged with the full row key (audit 2026-10-17 C1): no LIMIT = only 1,000 rows.
      q: "FROM sales SHOW net_items_sold, gross_sales, quantity_returned GROUP BY product_variant_id, pos_location_name, sales_channel TIMESERIES day SINCE 2026-09-01 UNTIL 2026-09-30 ORDER BY day ASC, product_variant_id ASC, pos_location_name ASC, sales_channel ASC LIMIT 5000 OFFSET 0",
    });
    expect(res.rows).toHaveLength(3);
    expect(res.skipped).toBe(3);
    expect(time.waits).toEqual([]);
  });

  it("each typed method parses its dataset", async () => {
    const time = fakeTime();
    expect((await createShopifyqlClient(fakeAdmin([{ body: stockFixture }]).admin, time).stockDaily(SEPT, TODAY)).rows).toHaveLength(3);
    expect((await createShopifyqlClient(fakeAdmin([{ body: sessionsFixture }]).admin, time).sessionsDaily(SEPT, TODAY)).rows).toHaveLength(3);
    expect((await createShopifyqlClient(fakeAdmin([{ body: shopFixture }]).admin, time).shopDaily(SEPT, TODAY)).rows).toHaveLength(2);
  });

  it("refuses a range that includes today before calling Shopify", async () => {
    const { admin, calls } = fakeAdmin([{ body: salesFixture }]);
    const client = createShopifyqlClient(admin, fakeTime());
    await expect(client.salesDaily({ since: "2026-10-01", until: TODAY }, TODAY)).rejects.toThrow(RangeError);
    expect(calls).toHaveLength(0);
  });

  it("updates the budget snapshot from extensions.shopifyqlCost", async () => {
    expect(shopifyqlBudget()).toEqual({ lastCost: null, lastRemaining: null, lastAt: null });
    const { admin } = fakeAdmin([{ body: salesFixture }]);
    await createShopifyqlClient(admin, fakeTime()).run("FROM sales SHOW orders");
    expect(shopifyqlBudget()).toEqual({ lastCost: 12, lastRemaining: 988, lastAt: "2026-10-16T10:00:00.000Z" });
  });
});

describe("errors", () => {
  it("parseErrors → ShopifyqlParseError, not retried", async () => {
    const { admin, calls } = fakeAdmin([{ body: parseErrorsFixture }, { body: salesFixture }]);
    const time = fakeTime();
    const err = await createShopifyqlClient(admin, time).run("FROM sales SHOW net_itemz_sold").catch((e) => e);
    expect(err).toBeInstanceOf(ShopifyqlParseError);
    expect(err.retryable).toBe(false);
    expect(err.messages).toEqual(["Column 'net_itemz_sold' does not exist in dataset 'sales'"]);
    expect(calls).toHaveLength(1);
    expect(time.waits).toEqual([]);
  });

  it("RESPONSE_TOO_LARGE → the page shrinks (5000 → 2500 → 1250 → 1000), then ShopifyqlTooLargeError", async () => {
    const { admin, calls } = fakeAdmin([{ body: tooLargeFixture }]);
    const err = await createShopifyqlClient(admin, fakeTime()).salesDaily(SEPT, TODAY).catch((e) => e);
    expect(err).toBeInstanceOf(ShopifyqlTooLargeError);
    expect(calls.map((c) => /LIMIT (\d+) OFFSET 0$/.exec(String(c.variables?.q))?.[1])).toEqual(["5000", "2500", "1250", "1000"]);
  });

  it("a smaller page that fits is used for the rest of the read", async () => {
    const { admin, calls } = fakeAdmin([{ body: tooLargeFixture }, { body: salesFixture }]);
    const res = await createShopifyqlClient(admin, fakeTime()).salesDaily(SEPT, TODAY);
    expect(res.rows).toHaveLength(3);
    expect(calls).toHaveLength(2);
    expect(String(calls[1].variables?.q)).toMatch(/LIMIT 2500 OFFSET 0$/);
  });

  it("RESPONSE_TOO_LARGE thrown by the real library (GraphqlQueryError shape) is recognised", async () => {
    const thrown = Object.assign(new Error("GraphQL Client: An error occurred while fetching from the API."), {
      body: { errors: { graphQLErrors: tooLargeFixture.errors }, extensions: tooLargeFixture.extensions },
    });
    const { admin } = fakeAdmin([{ throws: thrown }]);
    await expect(createShopifyqlClient(admin, fakeTime()).run("q")).rejects.toBeInstanceOf(ShopifyqlTooLargeError);
  });

  it("other HTTP errors → ShopifyqlRequestError; unknown thrown values pass through", async () => {
    const a = fakeAdmin([{ status: 500, body: { errors: [{ message: "Internal error" }] } }]);
    await expect(createShopifyqlClient(a.admin, fakeTime()).run("q")).rejects.toBeInstanceOf(ShopifyqlRequestError);
    const boom = new Error("socket hang up");
    const b = fakeAdmin([{ throws: boom }]);
    await expect(createShopifyqlClient(b.admin, fakeTime()).run("q")).rejects.toBe(boom);
    const redirect = new Response(null, { status: 401 });
    const c = fakeAdmin([{ throws: redirect }]);
    await expect(createShopifyqlClient(c.admin, fakeTime()).run("q")).rejects.toBe(redirect);
  });
});

describe("throttling", () => {
  it("HTTP 429 → waits until windowResetAt, then succeeds", async () => {
    const { admin, calls } = fakeAdmin([{ status: 429, body: throttled429Fixture }, { body: salesFixture }]);
    const time = fakeTime();
    const res = await createShopifyqlClient(admin, time).run("q");
    expect(time.waits).toEqual([30_000]); // 10:00:00 → 10:00:30
    expect(calls).toHaveLength(2);
    expect(res.attempts).toBe(2);
  });

  it("GraphQL error code THROTTLED → same behaviour", async () => {
    const { admin } = fakeAdmin([{ body: throttledGraphqlFixture }, { body: shopFixture }]);
    const time = fakeTime();
    const res = await createShopifyqlClient(admin, time).run("q");
    expect(time.waits).toEqual([45_000]);
    expect(res.attempts).toBe(2);
    // budget snapshot shows the throttled response first, then the success
    expect(shopifyqlBudget().lastRemaining).toBe(952);
  });

  it("429 without a reset time falls back to 60 s", async () => {
    const { admin } = fakeAdmin([{ status: 429, body: {} }, { body: shopFixture }]);
    const time = fakeTime();
    await createShopifyqlClient(admin, time).run("q");
    expect(time.waits).toEqual([60_000]);
  });

  it("429 thrown as a Response by the real library uses the shop's last known window reset", async () => {
    // First call succeeds and reports windowResetAt 10:00:20; second is a thrown 429 with no budget info.
    const first = {
      ...shopFixture,
      extensions: { shopifyqlCost: { ...shopFixture.extensions.shopifyqlCost, windowResetAt: "2026-10-16T10:00:20Z" } },
    };
    const { admin } = fakeAdmin([
      { body: first },
      { throws: new Response(JSON.stringify({ errors: { networkStatusCode: 429 } }), { status: 429 }) },
      { body: shopFixture },
    ]);
    const time = fakeTime();
    const client = createShopifyqlClient(admin, time);
    await client.run("q1");
    await client.run("q2");
    expect(time.waits).toEqual([20_000]); // 10:00:00 → 10:00:20 (last known reset), not the 60 s fallback
  });

  it("caps at 5 attempts and then throws ShopifyqlThrottledError", async () => {
    const { admin, calls } = fakeAdmin([{ status: 429, body: throttled429Fixture }]);
    const time = fakeTime();
    const err = await createShopifyqlClient(admin, time).run("q").catch((e) => e);
    expect(err).toBeInstanceOf(ShopifyqlThrottledError);
    expect(err.retryable).toBe(true);
    expect(err.attempts).toBe(5);
    expect(calls).toHaveLength(5);
    expect(time.waits).toHaveLength(4);
    // first wait reaches the reset; later ones hit the 1 s floor because the reset is in the past
    expect(time.waits).toEqual([30_000, 1_000, 1_000, 1_000]);
  });
});

describe("runChunked with the client", () => {
  it("splits a 30-day stock backfill until Shopify stops answering RESPONSE_TOO_LARGE", async () => {
    const MAX_DAYS = 10;
    const ranges: DayRange[] = [];
    const admin: AdminGraphqlClient = {
      graphql: async (_q, options) => {
        const q = String(options?.variables?.q);
        const m = /SINCE (\S+) UNTIL (\S+)/.exec(q)!;
        const r = { since: m[1], until: m[2] };
        ranges.push(r);
        return json(dayCount(r) > MAX_DAYS ? tooLargeFixture : stockFixture);
      },
    };
    const client = createShopifyqlClient(admin, fakeTime());
    const out = await runChunked(SEPT, (r) => client.stockDaily(r, TODAY));
    expect(out.map((c) => c.range)).toEqual([
      { since: "2026-09-23", until: "2026-09-30" },
      { since: "2026-09-16", until: "2026-09-22" },
      { since: "2026-09-08", until: "2026-09-15" },
      { since: "2026-09-01", until: "2026-09-07" },
    ]);
    expect(out.every((c) => c.result.rows.length === 3)).toBe(true);
    // 7 date ranges tried; the 3 too-large ones each tried at 4 page sizes first.
    expect(new Set(ranges.map((r) => `${r.since}..${r.until}`)).size).toBe(7);
    expect(ranges).toHaveLength(3 * 4 + 4);
  });
});
