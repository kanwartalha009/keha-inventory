/**
 * DB scale #1 (audit 2026-10-17): a large store's stock backfill never finished — past
 * 1,000,000 rows the read failed (ShopifyqlTruncatedError) and runChunked only split on
 * RESPONSE_TOO_LARGE, so the month was retried, then skipped, forever. Now:
 *  - the row cap splits the date range like RESPONSE_TOO_LARGE (right after the last complete
 *    day, else halves), down to a single day; a single day over the cap fails clearly;
 *  - stock is streamed: complete days are handed over every STOCK_CHUNK_ROWS rows and written
 *    at once, so a month is never held in memory;
 *  - a 3.7 M-row month (40,000 variants × 3 locations × 31 days) is stored in full.
 */
import v8 from "node:v8";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";
import {
  MAX_ROWS_PER_QUERY,
  ShopifyqlDayTooLargeError,
  ShopifyqlRowCapError,
  ShopifyqlTooLargeError,
  ShopifyqlTruncatedError,
  STOCK_KEY,
  addDays,
  dayCount,
  fetchAllPages,
  forEachChunk,
  runChunked,
  type DayRange,
  type Paging,
  type ShopifyqlTableData,
} from "../../app/lib/sync/shopifyql-shared";
import { syncErrorCode } from "../../app/lib/sync/errors-shared";
import type { AdminGraphqlClient } from "../../app/models/shop.server";

// A counting stand-in for Prisma: keeps no rows (3.7 M rows would not fit the in-memory fake).
const w = vi.hoisted(() => ({
  writes: [] as { since: string; until: string; rows: number }[],
  pendingDelete: null as null | { since: string; until: string },
}));
vi.mock("../../app/db.server", () => {
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const client = {
    stockDaily: {
      deleteMany: async ({ where }: { where: { day: { gte: Date; lte: Date } } }) => {
        w.pendingDelete = { since: iso(where.day.gte), until: iso(where.day.lte) };
        return { count: 0 };
      },
      createMany: async ({ data }: { data: unknown[] }) => ({ count: data.length, rows: data.length }),
    },
    $transaction: async (ops: Promise<{ count: number; rows?: number }>[]) => {
      const done = await Promise.all(ops);
      const rows = done.reduce((a, r) => a + (r.rows ?? 0), 0);
      w.writes.push({ ...w.pendingDelete!, rows });
      return done;
    },
  };
  return { default: client };
});

import { STOCK_CHUNK_ROWS, storeStock } from "../../app/services/sync/facts.server";
import { setFactsStore, type FactsStore } from "../../app/services/facts-store.server";

// The facts store counts each part written (no rows kept), as the Prisma stand-in above did.
const counting: Pick<FactsStore, "replaceStock"> = {
  replaceStock: async (_shop, range, rows) => void w.writes.push({ since: range.since, until: range.until, rows: rows.length }),
};
setFactsStore(counting as FactsStore);
import { createShopifyqlClient } from "../../app/services/sync/shopifyql.server";

const TODAY = "2026-10-16";
const AUG: DayRange = { since: "2026-08-01", until: "2026-08-31" };
const LOCATIONS = ["Main warehouse", "Second warehouse", "Madrid store"];
const COLUMNS = ["day", "product_variant_id", "inventory_location_name", "ending_inventory_units_at_location", "days_out_of_stock_at_location"].map((name) => ({ name }));

/**
 * A virtual ShopifyQL stock dataset: row i of the range, in key order (day, variant, location),
 * generated on demand — nothing is held. Answers LIMIT / OFFSET pages like Shopify.
 */
// Live heap (after a full GC), sampled every 25 pages: what the read really holds.
v8.setFlagsFromString("--expose-gc");
const gc = vm.runInNewContext("gc") as () => void;
function liveHeap(): number {
  gc();
  return process.memoryUsage().heapUsed;
}

function virtualStock(variants: number, opts: { heap?: number[] } = {}) {
  const perDay = variants * LOCATIONS.length;
  const queries: string[] = [];
  const admin: AdminGraphqlClient = {
    graphql: async (_doc, options) => {
      const q = String(options?.variables?.q);
      queries.push(q);
      const m = /SINCE (\S+) UNTIL (\S+) ORDER BY .+ LIMIT (\d+) OFFSET (\d+)$/.exec(q)!;
      const since = m[1];
      const total = dayCount({ since, until: m[2] }) * perDay;
      const offset = Number(m[4]);
      const end = Math.min(total, offset + Number(m[3]));
      const rows: unknown[][] = [];
      let dayNo = -1;
      let day = "";
      for (let i = offset; i < end; i++) {
        if (Math.floor(i / perDay) !== dayNo) day = addDays(since, (dayNo = Math.floor(i / perDay)));
        const rem = i % perDay;
        rows.push([day, String(Math.floor(rem / LOCATIONS.length) + 1), LOCATIONS[rem % LOCATIONS.length], (i % 17) - 2, i % 17 === 0 ? 1 : 0]);
      }
      if (opts.heap && queries.length % 25 === 1) opts.heap.push(liveHeap());
      const body = { data: { shopifyqlQuery: { tableData: { columns: COLUMNS, rows }, parseErrors: [] } } };
      // Duck-typed Response: skips JSON text for 3.7 M rows (the client only reads status + json()).
      const res = { status: 200, ok: true, json: async () => body, clone: () => res };
      return res as unknown as Response;
    },
  };
  return { admin, queries, perDay };
}

const locs = LOCATIONS.map((name, i) => ({ id: `gid://shopify/Location/${i + 1}`, name, active: true }));

describe("the row cap splits the date range (forEachChunk / runChunked)", () => {
  const capAt = (maxDays: number, completeThrough: (r: DayRange) => string | null) => async (r: DayRange) => {
    if (dayCount(r) > maxDays) throw new ShopifyqlRowCapError(1000, 1001, completeThrough(r));
    return dayCount(r);
  };

  it("splits right after the last complete day, older part first, covering the range once", async () => {
    const parts: DayRange[] = [];
    // The cap is reached on day 11 of any range: days up to the 10th are complete.
    await forEachChunk(AUG, capAt(10, (r) => addDays(r.since, 9)), (r) => void parts.push(r));
    expect(parts).toEqual([
      { since: "2026-08-01", until: "2026-08-10" },
      { since: "2026-08-11", until: "2026-08-20" },
      { since: "2026-08-21", until: "2026-08-30" },
      { since: "2026-08-31", until: "2026-08-31" },
    ]);
  });

  it("halves when the order is not proven (no complete day), like RESPONSE_TOO_LARGE", async () => {
    const out = await runChunked(AUG, capAt(8, () => null));
    expect(out.every((p) => dayCount(p.range) <= 8)).toBe(true);
    expect(out.reduce((a, p) => a + p.result, 0)).toBe(31);
    for (let i = 1; i < out.length; i++) expect(addDays(out[i].range.until, 1)).toBe(out[i - 1].range.since); // newest first, contiguous
  });

  it("a single day over the cap fails clearly (never loops), code truncated", async () => {
    const err = await forEachChunk(AUG, capAt(0, () => null), () => {}).catch((e) => e);
    expect(err).toBeInstanceOf(ShopifyqlDayTooLargeError);
    expect(err.message).toMatch(/one day \(2026-08-\d\d\) has more than 1000 rows/);
    expect(syncErrorCode(err)).toBe("truncated");
    // The first day alone over the cap (nothing complete before it): no halving at all.
    let calls = 0;
    const first = await forEachChunk(AUG, async () => {
      calls++;
      throw new ShopifyqlRowCapError(1000, 1001, "2026-07-31");
    }, () => {}).catch((e) => e);
    expect(first).toBeInstanceOf(ShopifyqlDayTooLargeError);
    expect(first.day).toBe("2026-08-01");
    expect(calls).toBe(1);
  });

  it("splitOn narrows what splits (other errors pass through)", async () => {
    const run = async () => {
      throw new ShopifyqlRowCapError(10, 11, null);
    };
    await expect(forEachChunk(AUG, run, () => {}, { splitOn: (e) => e instanceof ShopifyqlTooLargeError })).rejects.toBeInstanceOf(ShopifyqlRowCapError);
  });
});

describe("fetchAllPages streams complete days (PageFlush)", () => {
  /** In-memory pages of a small virtual dataset (rows ordered by day). */
  const pages = (perDay: number, days: number, mutate?: (p: Paging, rows: unknown[][]) => unknown[][]) => async (p: Paging): Promise<ShopifyqlTableData> => {
    const total = perDay * days;
    const rows: unknown[][] = [];
    for (let i = p.offset ?? 0; i < Math.min(total, (p.offset ?? 0) + (p.limit ?? total)); i++) {
      rows.push([addDays(AUG.since, Math.floor(i / perDay)), String(i % perDay), "L", 1, 0]);
    }
    return { columns: COLUMNS, rows: mutate ? mutate(p, rows) : rows };
  };

  it("hands over only complete days, every `rows` rows; the result is the rest", async () => {
    const chunks: { through: string; rows: number; days: Set<string> }[] = [];
    const r = await fetchAllPages(pages(700, 10), STOCK_KEY, { pageSize: 1000, minPageSize: 1000 }, {
      rows: 2000,
      onDays: async (t, through) => {
        const rows = t.rows as Record<string, unknown>[];
        chunks.push({ through, rows: rows.length, days: new Set(rows.map((x) => String(x.day))) });
      },
    });
    const handed = chunks.reduce((a, c) => a + c.rows, 0);
    const rest = r.table.rows as Record<string, unknown>[];
    expect(handed + rest.length).toBe(7000);
    for (const c of chunks) {
      expect(c.rows % 700).toBe(0); // whole days only
      expect([...c.days].every((d) => d <= c.through)).toBe(true);
    }
    expect(chunks.map((c) => c.through)).toEqual([...chunks.map((c) => c.through)].sort());
    expect(new Set(rest.map((x) => x.day)).size).toBeGreaterThanOrEqual(1);
  });

  it("a row of a day already handed over fails the read (pages overlapped)", async () => {
    let n = 0;
    const read = fetchAllPages(
      pages(700, 10, (p, rows) => (n++ === 4 ? [[AUG.since, "x", "L", 1, 0], ...rows] : rows)),
      STOCK_KEY,
      { pageSize: 1000, minPageSize: 1000 },
      { rows: 2000, onDays: async () => {} },
    );
    await expect(read).rejects.toBeInstanceOf(ShopifyqlTruncatedError);
  });

  it("streaming: one day over the hard cap → ShopifyqlDayTooLargeError", async () => {
    const read = fetchAllPages(pages(5000, 3), STOCK_KEY, { pageSize: 1000, minPageSize: 1000, maxRows: 3000 }, { rows: 1000, onDays: async () => {} });
    await expect(read).rejects.toBeInstanceOf(ShopifyqlDayTooLargeError);
  });

  it("without streaming, the cap names the last complete day so the range splits after it", async () => {
    const err = await fetchAllPages(pages(700, 10), STOCK_KEY, { pageSize: 1000, minPageSize: 1000, maxRows: 2500 }).catch((e) => e);
    expect(err).toBeInstanceOf(ShopifyqlRowCapError);
    expect(err.completeThrough).toBe("2026-08-04"); // 3,000 rows read: days 1–4 whole (2,800), day 5 begun
  });
});

describe("a 3.7 M-row stock month (40,000 variants × 3 locations × 31 days)", () => {
  it(
    "is stored in full, a few days per write, never more than STOCK_CHUNK_ROWS + one day held",
    async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const heap: number[] = [];
      const s = virtualStock(40_000, { heap });
      w.writes.length = 0;
      const ql = createShopifyqlClient(s.admin, { sleep: async () => {}, now: () => 0 });
      const t0 = Date.now();
      const r = await storeStock("big.myshopify.com", ql, AUG, TODAY, locs);
      const ms = Date.now() - t0;
      expect(s.perDay * 31).toBe(3_720_000);
      expect(r.rows).toBe(3_720_000);
      expect(r.unmapped).toEqual([]);
      // Every day of August written exactly once, in contiguous parts.
      expect(w.writes[0].since).toBe(AUG.since);
      expect(w.writes.at(-1)!.until).toBe(AUG.until);
      for (let i = 1; i < w.writes.length; i++) expect(w.writes[i].since).toBe(addDays(w.writes[i - 1].until, 1));
      expect(w.writes.reduce((a, x) => a + x.rows, 0)).toBe(3_720_000);
      expect(Math.max(...w.writes.map((x) => x.rows))).toBeLessThanOrEqual(STOCK_CHUNK_ROWS + s.perDay);
      // One read of the month (no failed attempt, no re-read): 3.72 M / 5,000 rows a page.
      expect(s.queries.length).toBe(Math.ceil(3_720_000 / 5000) + 1);
      const peakMb = (Math.max(...heap) - heap[0]) / 1e6;
      console.log(`[scale] after: 3.72 M stock rows stored in ${w.writes.length} writes, largest ${Math.max(...w.writes.map((x) => x.rows))} rows, ${ms} ms, live heap peak +${peakMb.toFixed(0)} MB`);
      expect(peakMb).toBeLessThan(150); // bounded by STOCK_CHUNK_ROWS, not by the month (before: +192 MB at the 1 M cap)
    },
    300_000,
  );

  it("before: the same month read in one go fails past MAX_ROWS_PER_QUERY (what the old code did)", async () => {
    const heap: number[] = [];
    const s = virtualStock(40_000, { heap });
    const ql = createShopifyqlClient(s.admin, { sleep: async () => {}, now: () => 0, paging: { maxRows: MAX_ROWS_PER_QUERY } });
    const t0 = Date.now();
    const err = await ql.stockDaily(AUG, TODAY).catch((e) => e);
    console.log(`[scale] before: one read of the month failed after ${s.queries.length} pages (${err.rows} rows), ${Date.now() - t0} ms, live heap peak +${((Math.max(...heap) - heap[0]) / 1e6).toFixed(0)} MB, nothing stored`);
    expect(err).toBeInstanceOf(ShopifyqlRowCapError);
    expect(err).toBeInstanceOf(ShopifyqlTruncatedError); // old callers still see a retryable truncated read
    expect(err.completeThrough).toBe("2026-08-08"); // 1,005,000 rows read = 8.4 days of 120,000
  }, 300_000);
});
