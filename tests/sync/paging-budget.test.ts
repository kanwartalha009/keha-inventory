/**
 * Review H3/H4 helpers: the per-tick throttle-wait budget and error codes. (Paging moved to
 * tests/sync/shopifyql-paging.test.ts — audit 2026-10-17 C1 / M10.)
 */
import { describe, expect, it } from "vitest";
import {
  ShopifyqlParseError,
  ShopifyqlReconcileError,
  ShopifyqlThrottledError,
  ShopifyqlTooLargeError,
  ShopifyqlTruncatedError,
} from "../../app/lib/sync/shopifyql-shared";
import { ThrottleBudgetError, createSleepBudget } from "../../app/lib/sync/budget-shared";
import { isThrottle, knownCode, syncErrorCode } from "../../app/lib/sync/errors-shared";

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
    expect(syncErrorCode(new ShopifyqlTruncatedError("cap", 1))).toBe("truncated");
    expect(syncErrorCode(new ShopifyqlReconcileError("sales", [{ day: "2026-09-01", expected: 2, got: 1 }]))).toBe("reconcile_mismatch");
    expect(isThrottle(new ShopifyqlTruncatedError("cap", 1))).toBe(false); // counts towards the retry cap
    expect(knownCode("reconcile_mismatch")).toBe("reconcile_mismatch");
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
