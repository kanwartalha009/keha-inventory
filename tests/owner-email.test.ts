/**
 * Store-owner email period keys: each email goes out at most once per period.
 */
import { describe, expect, it } from "vitest";
import { dayKey, monthKey, weekKey } from "../app/lib/owner-email-shared";

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
