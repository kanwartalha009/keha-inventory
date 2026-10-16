/**
 * Review H3/H4 helpers: single-day RESPONSE_TOO_LARGE paging (ORDER BY / LIMIT / OFFSET with
 * a fake runner), the per-tick throttle-wait budget, and error codes.
 */
import { describe, expect, it } from "vitest";
import {
  ShopifyqlParseError,
  ShopifyqlThrottledError,
  ShopifyqlTooLargeError,
  buildDailyStockQuery,
  runChunkedPaged,
  runPaged,
  type DayRange,
  type Paging,
  type ParseResult,
} from "../../app/lib/sync/shopifyql-shared";
import { ThrottleBudgetError, createSleepBudget } from "../../app/lib/sync/budget-shared";
import { isThrottle, knownCode, syncErrorCode } from "../../app/lib/sync/errors-shared";

const page = (n: number, from = 0): ParseResult<number> => ({ rows: Array.from({ length: n }, (_x, i) => from + i), skipped: 0, missingColumns: [] });

describe("runPaged", () => {
  it("pages with ORDER BY / LIMIT / OFFSET until a short page", async () => {
    const calls: Paging[] = [];
    const total = 12_345;
    const r = await runPaged(async (p) => {
      calls.push(p);
      return page(Math.max(0, Math.min(p.limit!, total - p.offset!)), p.offset);
    }, "product_variant_id");
    expect(calls).toEqual([
      { orderBy: "product_variant_id", limit: 5000, offset: 0 },
      { orderBy: "product_variant_id", limit: 5000, offset: 5000 },
      { orderBy: "product_variant_id", limit: 5000, offset: 10000 },
    ]);
    expect(r.rows).toHaveLength(total);
    expect(r.rows[total - 1]).toBe(total - 1);
  });

  it("an exact multiple needs one extra (empty) page; skipped rows count towards a full page", async () => {
    const sizes = [5000, 5000, 0];
    let i = 0;
    const r = await runPaged(async () => page(sizes[i++]), "x");
    expect(i).toBe(3);
    expect(r.rows).toHaveLength(10_000);
    let j = 0;
    const r2 = await runPaged(async () => (j++ === 0 ? { rows: [1], skipped: 4999, missingColumns: [] } : page(3)), "x");
    expect(j).toBe(2);
    expect(r2).toMatchObject({ skipped: 4999 });
  });

  it("stops a loop that never ends (OFFSET ignored)", async () => {
    await expect(runPaged(async () => page(10), "x", 10, 5)).rejects.toThrow("did not end after 5 pages");
  });

  it("the builder renders ORDER BY before LIMIT / OFFSET (syntax TO VERIFY on a dev store)", () => {
    expect(buildDailyStockQuery({ since: "2026-09-01", until: "2026-09-01" }, "2026-10-16", { paging: { orderBy: "product_variant_id", limit: 5000, offset: 5000 } })).toMatch(
      /SINCE 2026-09-01 UNTIL 2026-09-01 ORDER BY product_variant_id LIMIT 5000 OFFSET 5000$/,
    );
    expect(() => buildDailyStockQuery({ since: "2026-09-01", until: "2026-09-01" }, "2026-10-16", { paging: { orderBy: "x; DROP" } })).toThrow();
  });
});

describe("runChunkedPaged", () => {
  const tooLarge = () => new ShopifyqlTooLargeError("too large", "q");

  it("halves ranges first, and pages only a single day that is still too large", async () => {
    const calls: string[] = [];
    const parts = await runChunkedPaged(
      { since: "2026-09-01", until: "2026-09-02" },
      async (r: DayRange, o) => {
        calls.push(`${r.since}..${r.until}${o?.paging ? `@${o.paging.offset}` : ""}`);
        if (r.since !== r.until) throw tooLarge();
        if (r.since === "2026-09-02" && !o?.paging) throw tooLarge();
        if (o?.paging) return page(o.paging.offset === 0 ? 3 : 1);
        return page(2);
      },
      "product_variant_id",
      3,
    );
    expect(calls).toEqual(["2026-09-01..2026-09-02", "2026-09-02..2026-09-02", "2026-09-02..2026-09-02@0", "2026-09-02..2026-09-02@3", "2026-09-01..2026-09-01"]);
    expect(parts.map((p) => [p.range.since, p.result.rows.length])).toEqual([
      ["2026-09-02", 4],
      ["2026-09-01", 2],
    ]);
  });

  it("other errors are not paged", async () => {
    await expect(
      runChunkedPaged({ since: "2026-09-01", until: "2026-09-01" }, async () => {
        throw new ShopifyqlParseError(["bad"], "q");
      }, "x"),
    ).rejects.toBeInstanceOf(ShopifyqlParseError);
  });
});

describe("throttle-wait budget", () => {
  it("sleeps until the budget is used, then throws instead of sleeping", async () => {
    const slept: number[] = [];
    const b = createSleepBudget(async (ms) => void slept.push(ms), 30_000);
    await b.sleep(20_000);
    await b.sleep(10_000);
    await expect(b.sleep(1)).rejects.toBeInstanceOf(ThrottleBudgetError);
    expect(slept).toEqual([20_000, 10_000]);
    expect(b.spent()).toBe(30_000);
    await expect(createSleepBudget(async () => {}, 30_000).sleep(60_000)).rejects.toThrow("exceeds the tick budget");
  });
});

describe("error codes", () => {
  it("map errors to short public codes", () => {
    expect(syncErrorCode(new ShopifyqlThrottledError(5))).toBe("throttled");
    expect(syncErrorCode(new ThrottleBudgetError(1, 0, 0))).toBe("throttled");
    expect(syncErrorCode(new ShopifyqlTooLargeError("x", "q"))).toBe("too_large");
    expect(syncErrorCode(new ShopifyqlParseError(["x"], "q"))).toBe("shopifyql_parse");
    const admin = new Error("Access denied");
    admin.name = "AdminQueryError";
    expect(syncErrorCode(admin)).toBe("admin_error");
    const session = new Error("Could not find a session for shop x");
    session.name = "SessionNotFoundError";
    expect(syncErrorCode(session)).toBe("session_missing");
    expect(syncErrorCode(new Error("boom"))).toBe("unknown");
    expect(syncErrorCode("boom")).toBe("unknown");
    expect(isThrottle(new ShopifyqlThrottledError(5))).toBe(true);
    expect(knownCode("too_large")).toBe("too_large");
    expect(knownCode("raw text leaked")).toBe("unknown");
    expect(knownCode(null)).toBeNull();
  });
});
