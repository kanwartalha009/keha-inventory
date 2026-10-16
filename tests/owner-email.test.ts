/**
 * Store-owner email period keys: each email goes out at most once per period.
 */
import { describe, expect, it } from "vitest";
import { canRetryOwnerEmail, dayKey, emailAttempts, failedAttemptError, monthKey, weekKey } from "../app/lib/owner-email-shared";

describe("owner email period keys", () => {
  it("uses ISO-8601 weeks, including the year boundary", () => {
    expect(weekKey(new Date("2026-10-12T08:00:00Z"))).toBe("2026-W42");
    expect(weekKey(new Date("2026-10-18T23:00:00Z"))).toBe("2026-W42");
    expect(weekKey(new Date("2026-10-19T00:00:00Z"))).toBe("2026-W43");
    // 1 Jan 2027 is a Friday: it belongs to the last ISO week of 2026.
    expect(weekKey(new Date("2027-01-01T12:00:00Z"))).toBe("2026-W53");
  });
  it("formats day and month keys in UTC", () => {
    expect(dayKey(new Date("2026-10-16T23:59:00Z"))).toBe("2026-10-16");
    expect(monthKey(new Date("2026-10-16T23:59:00Z"))).toBe("2026-10");
  });
});

describe("owner email retry rule", () => {
  const t0 = new Date("2026-10-19T07:00:00Z");
  const h = (n: number) => new Date(t0.getTime() + n * 3600000);
  it("counts attempts from the error prefix (unprefixed failure = 1)", () => {
    expect(emailAttempts(failedAttemptError(1, "x"))).toBe(1);
    expect(emailAttempts(failedAttemptError(2, "x"))).toBe(2);
    expect(emailAttempts("provider_500")).toBe(1);
    expect(failedAttemptError(1, "y".repeat(400))).toHaveLength(300);
  });
  it("allows one retry of a FAILED row after an hour, never of a SENT row", () => {
    const failed = { status: "FAILED", sentAt: t0, error: "attempt 1: down" };
    expect(canRetryOwnerEmail(failed, h(0.5))).toBe(false);
    expect(canRetryOwnerEmail(failed, h(1))).toBe(true);
    expect(canRetryOwnerEmail({ ...failed, error: "attempt 2: down" }, h(5))).toBe(false);
    expect(canRetryOwnerEmail({ status: "SENT", sentAt: t0, error: null }, h(5))).toBe(false);
  });
});
